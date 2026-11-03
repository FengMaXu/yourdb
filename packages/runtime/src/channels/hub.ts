import { randomInt, randomUUID } from "node:crypto";
import {
  ProtocolVersion,
  parseSubmission,
  type Channel,
  type ChannelAccess,
  type ChannelActor,
  type ConversationAddress,
  type DataAgentCommand,
  type DataAgentEventEnvelope,
  type DataAgentResponseEnvelope,
  type DeliveryContent,
  type DeliveryTarget,
  type ProgressView,
  type RequestContext,
  type Submission,
  type SubmissionBody,
} from "@data-agent/contracts";
import type { ApplicationCommandHost } from "../application/protocol-host.js";
import type { BoundSession, ChannelSessionBinding, ChannelStore, OutboxItem } from "./store.js";

/** Who scanned a channel's bot: their id as that bot sees them, and the account they scanned from. */
export interface ChannelOwner {
  readonly externalUserId: string;
  readonly userId: string;
}

export type SubmitOutcome = "dispatched" | "duplicate" | "rejected" | "denied";

export interface ChannelHubOptions {
  /** The same versioned protocol seam Web and Electron use; the hub reaches nothing else. */
  readonly host: Pick<ApplicationCommandHost, "dispatch" | "subscribe">;
  readonly store: ChannelStore;
  /** Groups whose members may all see published results. Others get them privately (ADR-0011 decision 5). */
  readonly allowGroupDelivery?: (address: ConversationAddress) => boolean;
  /** Reads a published result as CSV with the asking user's authority. */
  readonly publications?: { read(receiptId: string, context: { readonly userId: string; readonly sessionId: string }): Promise<{ readonly content: string }> };
  /** Reads a dashboard page from the asking user's Session workspace. */
  readonly dashboards?: { read(path: string, context: { readonly userId: string; readonly sessionId: string }): Promise<Uint8Array> };
  /** Renders a self-contained page to PNG. Optional: without it dashboards go out as files only. */
  readonly snapshot?: (html: Uint8Array) => Promise<Uint8Array>;
  readonly retry?: { readonly baseMs?: number; readonly maxMs?: number; readonly maxAttempts?: number; readonly pollMs?: number };
  readonly progressIntervalMs?: number;
  /** A speaker's next input after this much quiet starts a new Session, so one chat does not grow one context forever. */
  readonly idleSessionMs?: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly onError?: (error: unknown) => void;
}

type ProgressState = { target: DeliveryTarget; runId?: string; text: string; activeTool?: string; timer?: ReturnType<typeof setTimeout> };

const PROGRESS_TEXT_LIMIT = 4000;
const OUTBOX_BATCH = 50;

const NOTICE_TEXT = {
  SUBMISSION_REJECTED: "这条消息没有被处理，请稍后重试。",
  SUBMISSION_INTERRUPTED: "服务重启前收到的一条消息没有被处理，请重新发送。",
  GROUP_DELIVERY_REDIRECTED: "查询结果已私聊发送给提问人。",
  CONVERSATION_STARTED: "已开始新对话，之前的上下文不会带入。",
  ACCESS_DENIED: "你还没有使用权限。请在数据智能体网页端「设置 → 消息渠道」获取绑定码，然后在与我的私聊中发送 /bind 绑定码。",
  ACCOUNT_LINKED: "已绑定。之后你在这里的对话会出现在数据智能体网页端你的账号下。",
  LINK_NOT_PRIVATE: "绑定码只能在与我的私聊中发送。这个绑定码已作废，请在网页端重新获取。",
  LINK_INVALID: "绑定码无效、已过期或已被使用，请在网页端重新获取。",
  LINK_USAGE: "请发送 /bind 加上网页端给出的 6 位绑定码，例如 /bind 123456。",
  LINK_LOCKED: "尝试次数过多，请一小时后再试。",
  ACCESS_REQUESTED: "已向管理员申请使用权限，批准后会通知你。",
  ACCESS_PENDING: "你的使用申请正在等待管理员处理。",
  ACCESS_REFUSED: "管理员没有同意你的使用申请。",
  ACCESS_GRANTED: "管理员已同意你使用数据助手，请重新发送你的问题。",
  DECIDER_NOT_MEMBER: "只有已绑定账号的成员可以处理使用申请。",
  DECISION_ALLOWED: "已允许，对方会收到通知。",
  DECISION_DENIED: "已拒绝，对方会收到通知。",
  DECISION_SETTLED: "这条申请已经处理过了。",
  DECISION_UNKNOWN: "找不到这条申请。",
} as const;

/** A refused request can be made again after this long. */
const REFUSAL_MS = 7 * 24 * 60 * 60_000;
/** What a request shows of the message that made it. */
const REQUEST_TEXT_LIMIT = 200;

export type AccessDecisionOutcome = "allowed" | "denied" | "already_decided" | "unknown";

/** A link code is good for this long, once. */
const LINK_CODE_TTL_MS = 10 * 60_000;
/** Failed link attempts per IM identity per hour, so six digits cannot be walked. */
const LINK_ATTEMPTS = 5;
const LINK_WINDOW_MS = 60 * 60_000;

/** `/bind 123456` (or `/绑定`); a bare or malformed one gets usage help. */
const LINK_COMMAND = /^\/(?:bind|绑定)(?:\s+(\S+))?$/i;

function idleNotice(idleMs: number): string {
  const minutes = Math.round(idleMs / 60_000);
  const span = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
  return `距上次对话已超过 ${span}，已开始新对话，之前的上下文不会带入。`;
}

/** What reaches a Session: a question or an answer. */
type ConversationBody = Extract<SubmissionBody, { kind: "input" | "answer" }>;

/** Typed alone in any channel, these start over instead of being asked as a question. */
const NEW_CONVERSATION_COMMANDS = new Set(["/new", "/新对话", "新对话"]);

type Interpreted = SubmissionBody | { kind: "link"; code?: string };

/** Text commands are the core's, so every channel gets them; a channel with a menu can send the body kind directly. */
function interpreted(body: SubmissionBody): Interpreted {
  if (body.kind !== "input") return body;
  const text = body.text.trim();
  if (NEW_CONVERSATION_COMMANDS.has(text.toLowerCase())) return { kind: "new_conversation" };
  const link = LINK_COMMAND.exec(text);
  return link ? { kind: "link", ...(link[1] ? { code: link[1] } : {}) } : body;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

function addressTarget(address: ConversationAddress): DeliveryTarget {
  return { kind: "address", address };
}

/**
 * The core side of the channel boundary (ADR-0011). It turns Submissions into
 * protocol commands for a channel-bound Session, and turns that Session's
 * events into durable Deliverables and droppable progress. It owns no agent,
 * query or publication state.
 */
export class ChannelHub {
  private readonly channels = new Map<string, Channel>();
  /** Who scanned each channel's bot; they may use it without asking. */
  private readonly owners = new Map<string, ChannelOwner>();
  private readonly boundSessions = new Map<string, Promise<BoundSession | undefined>>();
  private readonly sessionChoices = new Map<string, Promise<unknown>>();
  private readonly linkFailures = new Map<string, { count: number; since: number }>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  private readonly progress = new Map<string, ProgressState>();
  private readonly unsubscribe: () => void;
  private readonly startedAt: number;
  private poller: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private flushAgain = false;

  constructor(private readonly options: ChannelHubOptions) {
    this.startedAt = this.now();
    this.unsubscribe = options.host.subscribe((envelope) => this.receive(envelope));
  }

  async register(channel: Channel, owner?: ChannelOwner): Promise<void> {
    if (this.channels.has(channel.id)) throw new Error(`CHANNEL_ALREADY_REGISTERED: ${channel.id}`);
    this.channels.set(channel.id, channel);
    if (owner) this.owners.set(channel.id, owner);
    else this.owners.delete(channel.id);
    // Accepted by an earlier process but never dispatched: say so instead of replaying a non-idempotent run.
    for (const interrupted of await this.options.store.interruptedInbound(channel.id, this.startedAt)) {
      await this.options.store.enqueue(channel.id, `notice:interrupted:${interrupted.requestId}`, addressTarget(interrupted.address), { kind: "notice", code: "SUBMISSION_INTERRUPTED", text: NOTICE_TEXT.SUBMISSION_INTERRUPTED }, this.now());
      await this.options.store.settleInbound(channel.id, interrupted.requestId, "interrupted");
    }
    await channel.start(async (submission) => { await this.submit(channel.id, submission); });
    this.poller ??= setInterval(() => { void this.flush(); }, this.options.retry?.pollMs ?? 5_000);
    this.poller.unref?.();
    await this.flush();
  }

  /** Stops and removes a channel; its undelivered Deliverables wait for it to come back. */
  async unregister(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    await channel.stop().catch((error: unknown) => this.report(error));
  }

  /** Accepts one inbound platform event. Throws only for a malformed or foreign Submission. */
  async submit(channelId: string, value: unknown): Promise<SubmitOutcome> {
    const submission = parseSubmission(value);
    const { address, actor } = submission;
    if (address.channel !== channelId || actor.channel !== channelId || actor.tenant !== address.tenant) {
      throw new TypeError("Submission does not belong to this channel");
    }
    if (!(await this.options.store.acceptInbound(channelId, submission, this.now()))) return "duplicate";
    try {
      const body = interpreted(submission.body);
      if (body.kind === "link") {
        await this.link(submission, body.code);
        await this.options.store.settleInbound(channelId, submission.requestId, "dispatched");
        return "dispatched";
      }
      if (body.kind === "access_decision") {
        await this.decideFromChannel(submission, body.requestId, body.decision);
        await this.options.store.settleInbound(channelId, submission.requestId, "dispatched");
        return "dispatched";
      }
      // Default deny: only the owner, a linked account or an approved guest may run anything (ADR-0011).
      const userId = (await this.options.store.linkedUser(actor))?.userId ?? await this.claimOwner(actor);
      if (!userId) {
        await this.requestAccess(submission);
        await this.options.store.settleInbound(channelId, submission.requestId, "denied");
        return "denied";
      }
      if (body.kind === "new_conversation") await this.startOver(submission, userId);
      else {
        const session = await this.ensureSession(submission, body, userId);
        await this.dispatchBody(submission.requestId, body, { userId, host: "channel", sessionId: session.sessionId });
        await this.options.store.touchSession(session.sessionId, this.now());
      }
      await this.options.store.settleInbound(channelId, submission.requestId, "dispatched");
      return "dispatched";
    } catch (error) {
      this.report(error);
      await this.options.store.settleInbound(channelId, submission.requestId, "rejected");
      await this.options.store.enqueue(channelId, `notice:rejected:${submission.requestId}`, addressTarget(address), { kind: "notice", code: "SUBMISSION_REJECTED", text: NOTICE_TEXT.SUBMISSION_REJECTED }, this.now());
      void this.flush();
      return "rejected";
    }
  }

  /**
   * Decides a request to use the bot, from a member's card or the settings
   * page. Allowing makes the requester a guest with an account of their own;
   * either way they are told. Only the first decision counts.
   */
  async decideAccess(requestId: string, decision: "allow" | "deny", decidedBy: string): Promise<AccessDecisionOutcome> {
    const request = await this.options.store.request(requestId);
    if (!request) return "unknown";
    if (!(await this.options.store.decideRequest(requestId, decision === "allow" ? "approved" : "denied", decidedBy, this.now()))) return "already_decided";
    const requester: DeliveryTarget = { kind: "actor", actor: request.requester };
    if (decision === "deny") {
      await this.notify(requester, `notice:refused:${requestId}`, "ACCESS_DENIED", NOTICE_TEXT.ACCESS_REFUSED);
      return "denied";
    }
    // Someone who linked their own account meanwhile keeps it.
    if (!(await this.options.store.linkedUser(request.requester))) await this.options.store.link(request.requester, this.createId(), this.now(), "guest");
    await this.notify(requester, `notice:granted:${requestId}`, "ACCESS_GRANTED", NOTICE_TEXT.ACCESS_GRANTED);
    return "allowed";
  }

  /** Who may use the channels, and who is waiting. */
  async access(): Promise<ChannelAccess> {
    const [members, requests] = await Promise.all([this.options.store.members(), this.options.store.pendingRequests()]);
    return { members: members.map((member) => ({ ...member })), requests: requests.map(({ id, requester, audience, text, at }) => ({ id, requester, audience, text, at })) };
  }

  /**
   * Forgets who may use a channel and who is waiting: a new or removed bot
   * makes the old ids meaningless. The owner of the next bot comes with it.
   */
  async forgetAccess(channelId: string): Promise<void> {
    this.owners.delete(channelId);
    const [members, requests] = await Promise.all([this.options.store.members(), this.options.store.pendingRequests()]);
    for (const member of members) if (member.actor.channel === channelId) await this.options.store.unlink(member.actor);
    for (const request of requests) if (request.requester.channel === channelId) await this.options.store.decideRequest(request.id, "denied", "system", this.now());
  }

  /** Takes away an identity's access; its next message asks again. */
  async revokeAccess(actor: ChannelActor): Promise<void> {
    await this.options.store.unlink(actor);
  }

  /** A one-time code the signed-in user sends to a bot as `/bind <code>`; good for ten minutes. */
  async createLinkCode(userId: string): Promise<{ code: string; expiresAt: number }> {
    const expiresAt = this.now() + LINK_CODE_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (await this.options.store.createLinkCode(code, userId, expiresAt)) return { code, expiresAt };
    }
    throw new Error("CHANNEL_LINK_CODE_UNAVAILABLE");
  }

  /** Delivers every due Deliverable once; failures are retried with backoff. */
  async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        await this.deliverDue();
      } while (this.flushAgain);
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  /** Resolves once every event received so far has been turned into Deliverables. */
  async idle(): Promise<void> {
    while (this.eventQueues.size > 0) await Promise.all([...this.eventQueues.values()]);
  }

  async close(): Promise<void> {
    this.unsubscribe();
    if (this.poller) clearInterval(this.poller);
    for (const state of this.progress.values()) if (state.timer) clearTimeout(state.timer);
    this.progress.clear();
    await this.idle();
    await this.flushing;
    for (const channel of this.channels.values()) await channel.stop().catch((error: unknown) => this.report(error));
    this.channels.clear();
  }

  private async dispatchBody(requestId: string, body: ConversationBody, context: RequestContext): Promise<void> {
    if (body.kind === "answer") {
      try {
        await this.command({ type: "clarification.answer", clarificationId: body.clarificationId, answer: body.text }, context, requestId);
        return;
      } catch (error) {
        if (errorCode(error) !== "CLARIFICATION_SETTLED") throw error;
        // The wait is over; the answer still reaches the model as the user's own words.
      }
    }
    try {
      await this.command({ type: "agent.prompt", prompt: body.text }, context, requestId);
    } catch (error) {
      if (errorCode(error) !== "SESSION_BUSY") throw error;
      const whenBusy = body.kind === "input" ? body.whenBusy : "follow_up";
      await this.command({ type: whenBusy === "steer" ? "agent.steer" : "agent.follow_up", prompt: body.text }, context, requestId);
    }
  }

  /** The speaker's current Session; a new one when there is none, or when input arrives after a long quiet. */
  private ensureSession(submission: Submission, body: ConversationBody, userId: string): Promise<ChannelSessionBinding> {
    const { address, actor } = submission;
    return this.serialized(address, userId, async () => {
      const found = await this.options.store.findSession(address, userId);
      const idleMs = this.options.idleSessionMs;
      // An answer belongs to the Session that asked, however long it took.
      const idle = found !== undefined && idleMs !== undefined && body.kind === "input" && this.now() - found.lastActiveAt > idleMs;
      if (found && !idle) return found;
      if (found && idleMs !== undefined) {
        await this.options.store.supersedeSession(found.sessionId, this.now());
        await this.options.store.enqueue(address.channel, `notice:started:${submission.requestId}`, addressTarget(address), { kind: "notice", code: "CONVERSATION_STARTED", text: idleNotice(idleMs) }, this.now());
        void this.flush();
      }
      const name = `${address.channel}:${address.chatId}`;
      const taskId = await this.options.store.findTask(address, userId) ?? await this.createEntity({ type: "task.create", name }, userId);
      const started = new Date(this.now()).toLocaleString("sv-SE").slice(5, 16);
      const sessionId = await this.createEntity({ type: "session.create", taskId, name: `${address.threadId ? `${name}:${address.threadId}` : name} ${started}` }, userId);
      const bound = await this.options.store.bindSession(address, actor, userId, { sessionId, taskId }, this.now());
      this.boundSessions.set(bound.sessionId, this.options.store.boundSession(bound.sessionId));
      return bound;
    });
  }

  /** Ends the current Session on request. The next input opens a new one; a run still going keeps delivering. */
  private startOver(submission: Submission, userId: string): Promise<void> {
    const { address } = submission;
    return this.serialized(address, userId, async () => {
      const found = await this.options.store.findSession(address, userId);
      if (found) await this.options.store.supersedeSession(found.sessionId, this.now());
      await this.options.store.enqueue(address.channel, `notice:started:${submission.requestId}`, addressTarget(address), { kind: "notice", code: "CONVERSATION_STARTED", text: NOTICE_TEXT.CONVERSATION_STARTED }, this.now());
      void this.flush();
    });
  }

  /**
   * Links the sender to the account a code was issued to. Only in a private
   * chat: a code seen in a group is spent unused. Repeated failures lock the
   * sender out for an hour.
   */
  private async link(submission: Submission, code: string | undefined): Promise<void> {
    const { address, actor, requestId } = submission;
    const key = `notice:link:${requestId}`;
    const failures = `${actor.channel}|${actor.tenant}|${actor.externalUserId}`;
    const now = this.now();
    const record = this.linkFailures.get(failures);
    const recent = record && now - record.since < LINK_WINDOW_MS ? record : undefined;
    const here = addressTarget(address);
    if (recent && recent.count >= LINK_ATTEMPTS) return this.notify(here, key, "LINK_FAILED", NOTICE_TEXT.LINK_LOCKED);
    if (!code) return this.notify(here, key, "LINK_FAILED", NOTICE_TEXT.LINK_USAGE);
    if (address.audience !== "direct") {
      await this.options.store.consumeLinkCode(code, now);
      return this.notify(here, key, "LINK_FAILED", NOTICE_TEXT.LINK_NOT_PRIVATE);
    }
    const userId = await this.options.store.consumeLinkCode(code, now);
    if (!userId) {
      this.linkFailures.set(failures, { count: (recent?.count ?? 0) + 1, since: recent?.since ?? now });
      return this.notify(here, key, "LINK_FAILED", NOTICE_TEXT.LINK_INVALID);
    }
    this.linkFailures.delete(failures);
    await this.options.store.link(actor, userId, now, "account");
    await this.notify(here, key, "ACCOUNT_LINKED", NOTICE_TEXT.ACCOUNT_LINKED);
  }

  /**
   * Someone without access asked for something: nothing runs. Their first
   * message becomes a request to every linked account on that platform and
   * tenant, privately; while it waits, or within a week of a refusal, they
   * are only told where things stand. With nobody to ask, they get the link
   * instructions.
   */
  /** The owner's first message links them to the account that scanned; the tenant is only known from a message. */
  private async claimOwner(actor: ChannelActor): Promise<string | undefined> {
    const owner = this.owners.get(actor.channel);
    if (!owner || owner.externalUserId !== actor.externalUserId) return undefined;
    await this.options.store.link(actor, owner.userId, this.now(), "account");
    return owner.userId;
  }

  private async requestAccess(submission: Submission): Promise<void> {
    const { address, actor, body } = submission;
    const here = addressTarget(address);
    const key = `notice:access:${submission.requestId}`;
    const latest = await this.options.store.latestRequest(actor);
    if (latest?.status === "pending") return this.notify(here, key, "ACCESS_REQUESTED", NOTICE_TEXT.ACCESS_PENDING);
    if (latest?.status === "denied" && latest.decidedAt !== null && this.now() - latest.decidedAt < REFUSAL_MS) return this.notify(here, key, "ACCESS_DENIED", NOTICE_TEXT.ACCESS_REFUSED);
    const approvers = (await this.options.store.members()).filter((member) => member.role === "account" && member.actor.channel === actor.channel && member.actor.tenant === actor.tenant);
    if (approvers.length === 0) return this.notify(here, key, "ACCESS_DENIED", NOTICE_TEXT.ACCESS_DENIED);
    const text = (body.kind === "input" || body.kind === "answer" ? body.text : "").slice(0, REQUEST_TEXT_LIMIT);
    const request = { id: this.createId(), requester: actor, audience: address.audience, text, at: this.now() };
    await this.options.store.createRequest(request);
    for (const approver of approvers) {
      await this.options.store.enqueue(actor.channel, `access:${request.id}:${approver.actor.externalUserId}`, { kind: "actor", actor: approver.actor }, { kind: "access_request", requestId: request.id, requester: actor, audience: address.audience, text }, this.now());
    }
    await this.notify(here, key, "ACCESS_REQUESTED", NOTICE_TEXT.ACCESS_REQUESTED);
  }

  /** A decision from an approval card counts only from a linked account, not from a guest. */
  private async decideFromChannel(submission: Submission, requestId: string, decision: "allow" | "deny"): Promise<void> {
    const here = addressTarget(submission.address);
    const key = `notice:decision:${submission.requestId}`;
    const decider = await this.options.store.linkedUser(submission.actor);
    if (decider?.role !== "account") return this.notify(here, key, "ACCESS_DECIDED", NOTICE_TEXT.DECIDER_NOT_MEMBER);
    const outcome = await this.decideAccess(requestId, decision, decider.userId);
    const text = { allowed: NOTICE_TEXT.DECISION_ALLOWED, denied: NOTICE_TEXT.DECISION_DENIED, already_decided: NOTICE_TEXT.DECISION_SETTLED, unknown: NOTICE_TEXT.DECISION_UNKNOWN }[outcome];
    await this.notify(here, key, "ACCESS_DECIDED", text);
  }

  private async notify(target: DeliveryTarget, key: string, code: "ACCESS_DENIED" | "ACCOUNT_LINKED" | "LINK_FAILED" | "ACCESS_REQUESTED" | "ACCESS_GRANTED" | "ACCESS_DECIDED", text: string): Promise<void> {
    const channel = target.kind === "address" ? target.address.channel : target.actor.channel;
    await this.options.store.enqueue(channel, key, target, { kind: "notice", code, text }, this.now());
    void this.flush();
  }

  /** Session choices of one address and speaker happen one at a time. */
  private async serialized<T>(address: ConversationAddress, userId: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([address.channel, address.tenant, address.chatId, address.threadId ?? "", userId]);
    const previous = this.sessionChoices.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.sessionChoices.set(key, next);
    try {
      return await next;
    } finally {
      if (this.sessionChoices.get(key) === next) this.sessionChoices.delete(key);
    }
  }

  private async createEntity(command: Extract<DataAgentCommand, { type: "task.create" | "session.create" }>, userId: string): Promise<string> {
    const response = await this.command(command, { userId, host: "channel" }, `${command.type}:${this.createId()}`);
    if (response.response.type !== "mutation.result") throw new Error(`CHANNEL_${command.type.toUpperCase()}_FAILED`);
    return response.response.item.id;
  }

  private command(command: DataAgentCommand, context: RequestContext, requestId: string): Promise<DataAgentResponseEnvelope> {
    return this.options.host.dispatch({ protocolVersion: ProtocolVersion, requestId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), command }, context);
  }

  /** Events of one Session are handled in order; a failure never reaches the event emitter. */
  private receive(envelope: DataAgentEventEnvelope): void {
    const sessionId = envelope.sessionId;
    if (!sessionId) return;
    const previous = this.eventQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.handle(sessionId, envelope)).catch((error: unknown) => this.report(error));
    this.eventQueues.set(sessionId, next);
    void next.then(() => { if (this.eventQueues.get(sessionId) === next) this.eventQueues.delete(sessionId); });
  }

  private async handle(sessionId: string, envelope: DataAgentEventEnvelope): Promise<void> {
    let lookup = this.boundSessions.get(sessionId);
    if (!lookup) {
      lookup = this.options.store.boundSession(sessionId);
      this.boundSessions.set(sessionId, lookup);
    }
    const bound = await lookup;
    if (!bound) return;
    const channelId = bound.address.channel;
    const event = envelope.event;
    if (event.type === "clarification.request") {
      await this.options.store.enqueue(channelId, `question:${event.clarificationId}`, addressTarget(bound.address), { kind: "question", clarificationId: event.clarificationId, question: event.question, options: event.options }, this.now());
      void this.flush();
      return;
    }
    if (event.type === "publication.delivered") {
      const target = this.resultTarget(bound);
      await this.options.store.enqueue(channelId, `publication:${event.receiptId}`, target, { kind: "publication", publication: event }, this.now(), sessionId);
      if (target.kind === "actor") {
        await this.options.store.enqueue(channelId, `notice:redirected:${event.receiptId}`, addressTarget(bound.address), { kind: "notice", code: "GROUP_DELIVERY_REDIRECTED", text: NOTICE_TEXT.GROUP_DELIVERY_REDIRECTED }, this.now());
      }
      void this.flush();
      return;
    }
    if (event.type === "dashboard.delivered") {
      // A dashboard shows published numbers, so it goes where results may go.
      await this.options.store.enqueue(channelId, `dashboard:${event.contentHash}`, this.resultTarget(bound), { kind: "dashboard", dashboard: event }, this.now(), sessionId);
      void this.flush();
      return;
    }
    this.track(sessionId, bound, envelope);
  }

  /**
   * Where anything carrying result data goes: published rows, and the run's
   * narrative, which quotes them. A group not allowed group delivery gets
   * neither; the asker gets both privately (ADR-0011 decision 5).
   */
  private resultTarget(bound: BoundSession): DeliveryTarget {
    if (bound.address.audience === "group" && !(this.options.allowGroupDelivery?.(bound.address) ?? false)) return { kind: "actor", actor: bound.actor };
    return addressTarget(bound.address);
  }

  /** Progress is the latest view only: coalesced on a timer, sent at once when the run completes. */
  private track(sessionId: string, bound: BoundSession, envelope: DataAgentEventEnvelope): void {
    const channel = this.channels.get(bound.address.channel);
    if (!channel?.progress) return;
    const event = envelope.event;
    if (event.type !== "agent.text_delta" && event.type !== "agent.tool_started" && event.type !== "agent.tool_finished" && event.type !== "agent.completed") return;
    const state = this.progress.get(sessionId) ?? { target: this.resultTarget(bound), text: "" };
    this.progress.set(sessionId, state);
    if (envelope.runId) state.runId = envelope.runId;
    if (event.type === "agent.text_delta") state.text = (state.text + event.delta).slice(-PROGRESS_TEXT_LIMIT);
    else if (event.type === "agent.tool_started") state.activeTool = event.toolName;
    else if (event.type === "agent.tool_finished") delete state.activeTool;
    if (event.type === "agent.completed") {
      this.progress.delete(sessionId);
      this.sendProgress(channel, state, "completed");
      return;
    }
    state.timer ??= setTimeout(() => this.sendProgress(channel, state, "running"), this.options.progressIntervalMs ?? 1_000);
  }

  private sendProgress(channel: Channel, state: ProgressState, phase: ProgressView["state"]): void {
    if (state.timer) clearTimeout(state.timer);
    delete state.timer;
    const view: ProgressView = { state: phase, text: state.text, ...(state.runId ? { runId: state.runId } : {}), ...(state.activeTool ? { activeTool: state.activeTool } : {}) };
    channel.progress?.(state.target, view).catch((error: unknown) => this.report(error));
  }

  private async deliverDue(): Promise<void> {
    const retry = this.options.retry ?? {};
    for (const item of await this.options.store.due(this.now(), undefined, OUTBOX_BATCH)) {
      const channel = this.channels.get(item.channel);
      // An unregistered channel's items wait for it.
      if (!channel) continue;
      const attempts = item.attempts + 1;
      try {
        await channel.deliver(item.target, item.deliverable, item.idempotencyKey, this.content(item));
        await this.options.store.settle(item.id, { status: "delivered", attempts }, this.now());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempts >= (retry.maxAttempts ?? 8)) {
          this.report(error);
          await this.options.store.settle(item.id, { status: "failed", attempts, error: message }, this.now());
        } else {
          const delay = Math.min(retry.maxMs ?? 300_000, (retry.baseMs ?? 2_000) * 2 ** (attempts - 1));
          await this.options.store.settle(item.id, { status: "pending", attempts, nextAttemptAt: this.now() + delay, error: message }, this.now());
        }
      }
    }
  }

  /** Published rows are read only when a Channel asks, as the asker, and never stored in the outbox. */
  private content(item: OutboxItem): DeliveryContent | undefined {
    const { deliverable, sessionId } = item;
    if (!sessionId) return undefined;
    const asker = async () => {
      const bound = await this.options.store.boundSession(sessionId);
      if (!bound) throw new Error("CHANNEL_SESSION_UNBOUND");
      return { userId: bound.userId, sessionId };
    };
    const { publications, dashboards, snapshot } = this.options;
    if (deliverable.kind === "publication" && publications) {
      return { readPublication: async () => (await publications.read(deliverable.publication.receiptId, await asker())).content };
    }
    if (deliverable.kind === "dashboard" && dashboards) {
      const readDashboard = async () => dashboards.read(deliverable.dashboard.path, await asker());
      return { readDashboard, ...(snapshot ? { snapshotDashboard: async () => snapshot(await readDashboard()) } : {}) };
    }
    return undefined;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private createId(): string { return this.options.createId?.() ?? randomUUID(); }
  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("[data-agent] channel hub:", error);
  }
}
