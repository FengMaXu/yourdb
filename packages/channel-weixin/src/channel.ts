import type { Channel, Deliverable, DeliveryContent, DeliveryTarget, ProgressView, Submission } from "@data-agent/contracts";
import { clientId, LONG_POLL_MS, STALE_TOKEN, type WeixinApi, type Updates } from "./api.js";
import { messageSubmission, WEIXIN_CHANNEL_ID } from "./inbound.js";
import { accessRequestText, answerText, dashboardText, pieces, plainText, publicationText, questionText } from "./text.js";

export interface WeixinChannelOptions {
  readonly api: WeixinApi;
  /** The bot's id; every conversation with it is a private chat under it. */
  readonly botId: string;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  /** Waits between failed polls; replaced in tests. */
  readonly retryMs?: { readonly short: number; readonly long: number; readonly staleToken: number };
}

/** Messages older than this when the channel starts were meant for an earlier run, which answered or reported them. */
const BACKLOG_MS = 2 * 60_000;
/** Keys of delivered pieces kept to make a repeated delivery a no-op. */
const DELIVERED_LIMIT = 2_000;
const RETRY = { short: 2_000, long: 30_000, staleToken: 60 * 60_000 };
const FAILURES_BEFORE_LONG_WAIT = 3;

const NON_TEXT_REPLY = "暂时只能处理文字消息，请用文字提问。";

/**
 * Personal WeChat through ClawBot as a Channel (ADR-0011). Conversations are
 * private chats with the bot. It long-polls for messages, and answers in
 * plain text: no cards, buttons or edits, and no files yet, so a result is
 * previewed in the chat and the rest stays on the computer.
 *
 * Memory here is presentation state only: the newest context token per
 * person, the open question per person, and what was already sent.
 */
export class WeixinChannel implements Channel {
  readonly id = WEIXIN_CHANNEL_ID;
  readonly capabilities = { editableMessages: false, actions: false, files: false };
  private sink: ((submission: Submission) => Promise<void>) | undefined;
  private polling: { readonly abort: AbortController; readonly done: Promise<void> } | undefined;
  private readonly contextTokens = new Map<string, string>();
  private readonly pendingQuestions = new Map<string, { readonly clarificationId: string; readonly options: readonly string[] }>();
  private readonly delivered = new Set<string>();

  constructor(private readonly options: WeixinChannelOptions) {}

  async start(sink: (submission: Submission) => Promise<void>): Promise<void> {
    this.sink = sink;
    const abort = new AbortController();
    this.polling = { abort, done: this.poll(abort.signal, this.now() - BACKLOG_MS) };
  }

  async stop(): Promise<void> {
    const polling = this.polling;
    this.polling = undefined;
    this.sink = undefined;
    polling?.abort.abort();
    await polling?.done;
  }

  async deliver(target: DeliveryTarget, deliverable: Deliverable, idempotencyKey: string, content?: DeliveryContent): Promise<void> {
    const to = target.kind === "actor" ? target.actor.externalUserId : target.address.chatId;
    if (deliverable.kind === "question") {
      await this.sendText(to, questionText(deliverable.question, deliverable.options), idempotencyKey);
      this.pendingQuestions.set(to, { clarificationId: deliverable.clarificationId, options: deliverable.options });
      return;
    }
    if (deliverable.kind === "notice") return this.sendText(to, deliverable.text, idempotencyKey);
    if (deliverable.kind === "access_request") return this.sendText(to, accessRequestText(deliverable.requester.externalUserId, deliverable.text), idempotencyKey);
    if (deliverable.kind === "dashboard") return this.sendText(to, dashboardText(deliverable.dashboard.path), idempotencyKey);
    const { publication } = deliverable;
    const csv = publication.format === "csv" && content?.readPublication ? await content.readPublication() : publication.inlineContent;
    await this.sendText(to, publicationText(publication, csv), idempotencyKey);
  }

  /** A message cannot be edited, so only the finished answer is sent. */
  async progress(target: DeliveryTarget, view: ProgressView): Promise<void> {
    if (view.state !== "completed") return;
    const answer = plainText(view.text);
    // At full detail the steps taken follow the answer.
    const text = view.steps?.length ? `${answer}\n\n做过的步骤：${view.steps.join(" → ")}`.trim() : answer;
    if (!text) return;
    const to = target.kind === "actor" ? target.actor.externalUserId : target.address.chatId;
    await this.sendText(to, text, `answer:${to}:${view.runId ?? this.now()}`);
  }

  private async poll(signal: AbortSignal, notBefore: number): Promise<void> {
    let cursor = "";
    let timeoutMs = LONG_POLL_MS;
    let failures = 0;
    const retry = this.options.retryMs ?? RETRY;
    while (!signal.aborted) {
      let updates: Updates;
      try {
        updates = await this.options.api.getUpdates(cursor, timeoutMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.report(error);
        failures += 1;
        await this.wait(failures >= FAILURES_BEFORE_LONG_WAIT ? retry.long : retry.short, signal);
        if (failures >= FAILURES_BEFORE_LONG_WAIT) failures = 0;
        continue;
      }
      const code = updates.errcode || updates.ret || 0;
      if (code !== 0) {
        if (code === STALE_TOKEN) {
          // The login ended (logged out, or replaced by a newer scan); WeChat asks for a pause before trying again.
          this.report(new Error(`WEIXIN_TOKEN_STALE: 微信登录已失效，请在「设置 → 消息渠道」重新扫码。`));
          await this.wait(retry.staleToken, signal);
        } else {
          this.report(new Error(`WEIXIN_POLL_FAILED: ${code} ${updates.errmsg ?? ""}`.trim()));
          failures += 1;
          await this.wait(failures >= FAILURES_BEFORE_LONG_WAIT ? retry.long : retry.short, signal);
          if (failures >= FAILURES_BEFORE_LONG_WAIT) failures = 0;
        }
        continue;
      }
      failures = 0;
      if (updates.longpolling_timeout_ms && updates.longpolling_timeout_ms > 0) timeoutMs = updates.longpolling_timeout_ms;
      if (updates.get_updates_buf) cursor = updates.get_updates_buf;
      for (const message of updates.msgs ?? []) {
        if (message.create_time_ms !== undefined && message.create_time_ms < notBefore) continue;
        this.onMessage(message);
      }
    }
  }

  private onMessage(message: Parameters<typeof messageSubmission>[0]): void {
    const from = message.from_user_id?.trim();
    if (from && message.context_token) this.contextTokens.set(from, message.context_token);
    const inbound = messageSubmission(message, this.options.botId);
    if (!inbound) {
      // A picture or a file: say what works instead of staying silent.
      if (from && message.message_type !== 2 && message.item_list?.length) {
        void this.sendText(from, NON_TEXT_REPLY, `non-text:${message.message_id ?? `${from}:${message.create_time_ms ?? ""}`}`).catch((error: unknown) => this.report(error));
      }
      return;
    }
    let submission = inbound.submission;
    // A reply to an open question is its answer; the core turns it back into input if the wait is over.
    const pending = this.pendingQuestions.get(submission.address.chatId);
    if (pending && submission.body.kind === "input") {
      this.pendingQuestions.delete(submission.address.chatId);
      submission = { ...submission, body: { kind: "answer", clarificationId: pending.clarificationId, text: answerText(submission.body.text, pending.options) } };
    }
    const sink = this.sink;
    if (sink) void sink(submission).catch((error: unknown) => this.report(error));
  }

  /** Sends each piece once per key; the newest context token of the person goes with it. */
  private async sendText(to: string, text: string, key: string): Promise<void> {
    const parts = pieces(text);
    for (const [index, part] of parts.entries()) {
      const pieceKey = parts.length > 1 ? `${key}#${index}` : key;
      if (this.delivered.has(pieceKey)) continue;
      await this.options.api.sendText(to, part, clientId(pieceKey), this.contextTokens.get(to));
      this.remember(pieceKey);
    }
  }

  private remember(key: string): void {
    this.delivered.add(key);
    if (this.delivered.size > DELIVERED_LIMIT) this.delivered.delete(this.delivered.values().next().value!);
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
      const stop = () => { clearTimeout(timer); resolve(); };
      signal.addEventListener("abort", stop, { once: true });
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("[data-agent] weixin channel:", error);
  }
}
