import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Channel, ConversationAddress, DataAgentEvent, Deliverable, DeliveryContent, DeliveryTarget, ProgressView, Submission } from "@data-agent/contracts";
import { DataAgentRuntime } from "../protocol.js";
import { MetadataStore } from "../metadata.js";
import { ClarificationManager } from "../clarification.js";
import { AgentControllerError } from "../facets/agent-controller.js";
import type { ApplicationAgentEvent } from "../application/host.js";
import { ChannelHub, type ChannelOwner } from "./hub.js";
import { MetadataChannelStore } from "./store.js";

class MemoryChannel implements Channel {
  readonly capabilities = { editableMessages: true, actions: true, files: false };
  readonly delivered: { target: DeliveryTarget; deliverable: Deliverable; key: string }[] = [];
  readonly progressViews: ProgressView[] = [];
  readonly progressTargets: DeliveryTarget[] = [];
  readonly contents: (DeliveryContent | undefined)[] = [];
  failures = 0;
  sink: ((submission: Submission) => Promise<void>) | undefined;

  constructor(readonly id = "im") {}
  async start(sink: (submission: Submission) => Promise<void>): Promise<void> { this.sink = sink; }
  async deliver(target: DeliveryTarget, deliverable: Deliverable, key: string, content?: DeliveryContent): Promise<void> {
    this.contents.push(content);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("platform unavailable");
    }
    this.delivered.push({ target, deliverable, key });
  }
  async progress(target: DeliveryTarget, view: ProgressView): Promise<void> { this.progressTargets.push(target); this.progressViews.push(view); }
  async stop(): Promise<void> {}
}

type AgentCall = { kind: "prompt" | "steer" | "followUp"; text: string; sessionId?: string; userId?: string };

function fakeAgent() {
  const calls: AgentCall[] = [];
  let listener: ((event: ApplicationAgentEvent) => void) | undefined;
  let busy = false;
  let sequence = 1;
  return {
    calls,
    setBusy(value: boolean) { busy = value; },
    emit(sessionId: string, event: DataAgentEvent, runId = "run-1") {
      listener?.({ type: "presentation.event", sessionId, envelope: { protocolVersion: 1, sequence: sequence++, requestId: "request", sessionId, runId, timestamp: 1, event } });
    },
    agent: {
      async prompt(text: string, context?: { sessionId?: string; userId?: string }) {
        if (busy) throw new AgentControllerError("ADMISSION_REJECTED", "Lane \"main\" already has an active operation", { busy: true });
        calls.push({ kind: "prompt", text, ...context });
        return { operationId: `op-${calls.length}` };
      },
      async steer(text: string, context?: { sessionId?: string; userId?: string }) { calls.push({ kind: "steer", text, ...context }); },
      async followUp(text: string, context?: { sessionId?: string; userId?: string }) { calls.push({ kind: "followUp", text, ...context }); },
      subscribe(next: (event: ApplicationAgentEvent) => void) { listener = next; return () => { listener = undefined; }; },
    },
  };
}

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(options: { allowGroupDelivery?: (address: ConversationAddress) => boolean; dbPath?: string; clarificationTimeoutMs?: number; publications?: { read(receiptId: string, context: { userId: string; sessionId: string }): Promise<{ content: string }> }; dashboards?: { read(path: string, context: { userId: string; sessionId: string }): Promise<Uint8Array> }; snapshot?: (html: Uint8Array) => Promise<Uint8Array>; idleSessionMs?: number; linked?: boolean; owner?: ChannelOwner } = {}) {
  let dbPath = options.dbPath;
  if (!dbPath) {
    const root = await mkdtemp(join(process.cwd(), ".tmp-channel-hub-"));
    roots.push(root);
    dbPath = join(root, "metadata.db");
  }
  const metadata = new MetadataStore(dbPath);
  const store = new MetadataChannelStore(metadata);
  // Most tests speak as people who already linked their IM identity to an account.
  if (options.linked !== false) {
    await store.link({ channel: "im", tenant: "t1", externalUserId: "alice" }, "user-alice", 0);
    await store.link({ channel: "im", tenant: "t1", externalUserId: "bob" }, "user-bob", 0);
  }
  const fake = fakeAgent();
  const clarifications = new ClarificationManager(options.clarificationTimeoutMs ?? 60_000);
  const runtime = new DataAgentRuntime({ metadata, clarifications, agent: fake.agent });
  const clock = { now: 1_000 };
  const errors: unknown[] = [];
  const hub = new ChannelHub({
    host: runtime,
    store,
    now: () => clock.now,
    onError: (error) => errors.push(error),
    retry: { baseMs: 100, maxMs: 1_000, maxAttempts: 3, pollMs: 3_600_000 },
    progressIntervalMs: 5,
    ...(options.allowGroupDelivery ? { allowGroupDelivery: options.allowGroupDelivery } : {}),
    ...(options.publications ? { publications: options.publications } : {}),
    ...(options.dashboards ? { dashboards: options.dashboards } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    ...(options.idleSessionMs !== undefined ? { idleSessionMs: options.idleSessionMs } : {}),
  });
  const channel = new MemoryChannel();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await hub.close();
    await metadata.close();
  };
  closers.push(close);
  await hub.register(channel, options.owner);
  return { hub, channel, fake, runtime, clarifications, clock, errors, dbPath, close, store };
}

const group: ConversationAddress = { channel: "im", tenant: "t1", chatId: "chat-1", audience: "group" };
const direct: ConversationAddress = { channel: "im", tenant: "t1", chatId: "dm-alice", audience: "direct" };
const alice = { channel: "im", tenant: "t1", externalUserId: "alice" };
const bob = { channel: "im", tenant: "t1", externalUserId: "bob" };

function input(requestId: string, address: ConversationAddress, actor = alice, text = "上月销售额是多少？"): Submission {
  return { requestId, address, actor, body: { kind: "input", text, whenBusy: "follow_up" } };
}

const publication = (receiptId: string): DataAgentEvent => ({ type: "publication.delivered", receiptId, taskId: "task-1", format: "inline", publicRef: `/api/runtime/publications/${receiptId}?session_id=s`, disclosure: "口径按字面解释。", inlineContent: "| 销售额 |\n| 100 |" });

describe("ChannelHub inbound", () => {
  it("dispatches a platform event once even when the platform delivers it twice", async () => {
    const { hub, fake } = await setup();
    expect(await hub.submit("im", input("evt-1", direct))).toBe("dispatched");
    expect(await hub.submit("im", input("evt-1", direct))).toBe("duplicate");
    expect(fake.calls).toHaveLength(1);
  });

  it("keeps one Session per speaker of an address and reuses it", async () => {
    const { hub, fake } = await setup();
    await hub.submit("im", input("evt-1", group, alice));
    await hub.submit("im", input("evt-2", group, bob));
    await hub.submit("im", input("evt-3", group, alice, "按区域拆分"));
    const [first, second, third] = fake.calls;
    expect(first!.sessionId).toBeTruthy();
    expect(second!.sessionId).not.toBe(first!.sessionId);
    expect(second!.userId).not.toBe(first!.userId);
    expect(third).toMatchObject({ sessionId: first!.sessionId, userId: first!.userId });
  });

  it("queues input by its whenBusy choice when the Session is already running", async () => {
    const { hub, fake } = await setup();
    await hub.submit("im", input("evt-1", direct));
    fake.setBusy(true);
    await hub.submit("im", { ...input("evt-2", direct, alice, "只看华东"), body: { kind: "input", text: "只看华东", whenBusy: "steer" } });
    await hub.submit("im", input("evt-3", direct, alice, "再按月拆分"));
    expect(fake.calls.map((call) => call.kind)).toEqual(["prompt", "steer", "followUp"]);
  });

  it("refuses a Submission that names another channel", async () => {
    const { hub } = await setup();
    await expect(hub.submit("im", input("evt-1", { ...direct, channel: "other" }))).rejects.toThrow(TypeError);
    await expect(hub.submit("im", input("evt-2", direct, { ...alice, tenant: "t2" }))).rejects.toThrow(TypeError);
  });

  it("tells the conversation when the Runtime refuses a Submission", async () => {
    const { hub, fake, channel } = await setup();
    fake.agent.prompt = async () => { throw new Error("model unavailable"); };
    expect(await hub.submit("im", input("evt-1", direct))).toBe("rejected");
    await hub.flush();
    expect(channel.delivered).toEqual([{ target: { kind: "address", address: direct }, deliverable: expect.objectContaining({ kind: "notice", code: "SUBMISSION_REJECTED" }), key: "notice:rejected:evt-1" }]);
  });

  it("reports a Submission the previous process accepted but never dispatched", async () => {
    const first = await setup();
    await new MetadataChannelStore(first.runtime.metadataStore!).acceptInbound("im", input("evt-lost", direct), 500);
    await first.close();
    const second = await setup({ dbPath: first.dbPath });
    await second.hub.flush();
    expect(second.channel.delivered.map((item) => item.key)).toEqual(["notice:interrupted:evt-lost"]);
    expect(second.fake.calls).toHaveLength(0);
  });
});

describe("ChannelHub clarification answers", () => {
  it("answers a pending clarification of the asking Session", async () => {
    const { hub, fake, runtime, channel } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const sessionId = fake.calls[0]!.sessionId!;
    const asked = runtime.askClarification(sessionId, "订单量指什么？", ["全部订单", "已支付订单"]);
    await hub.idle();
    await hub.flush();
    expect(channel.delivered.at(-1)).toMatchObject({ key: `question:${asked.clarificationId}`, deliverable: { kind: "question", question: "订单量指什么？", options: ["全部订单", "已支付订单"] } });

    await hub.submit("im", { requestId: "evt-2", address: direct, actor: alice, body: { kind: "answer", clarificationId: asked.clarificationId, text: "已支付订单" } });
    await expect(asked.promise).resolves.toBe("已支付订单");
    expect(fake.calls).toHaveLength(1);
  });

  it("turns an answer that arrives after the wait ended into the user's next input", async () => {
    const { hub, fake, runtime } = await setup({ clarificationTimeoutMs: 10 });
    await hub.submit("im", input("evt-1", direct));
    const asked = runtime.askClarification(fake.calls[0]!.sessionId!, "订单量指什么？", []);
    await expect(asked.promise).resolves.toBe("");
    await hub.submit("im", { requestId: "evt-2", address: direct, actor: alice, body: { kind: "answer", clarificationId: asked.clarificationId, text: "已支付订单" } });
    expect(fake.calls.at(-1)).toMatchObject({ kind: "prompt", text: "已支付订单" });
  });

  it("does not let one Session answer another Session's clarification", async () => {
    const { hub, fake, runtime } = await setup();
    await hub.submit("im", input("evt-1", group, alice));
    await hub.submit("im", input("evt-2", group, bob));
    const asked = runtime.askClarification(fake.calls[0]!.sessionId!, "订单量指什么？", []);
    await hub.submit("im", { requestId: "evt-3", address: group, actor: bob, body: { kind: "answer", clarificationId: asked.clarificationId, text: "全部订单" } });
    // Bob's words went to Bob's own Session as input; Alice's question is still waiting.
    expect(fake.calls.at(-1)).toMatchObject({ kind: "prompt", text: "全部订单", sessionId: fake.calls[1]!.sessionId });
    expect(runtime.clarificationManager.pendingFor(fake.calls[0]!.sessionId!)?.clarificationId).toBe(asked.clarificationId);
  });
});

describe("ChannelHub deliverables", () => {
  it("delivers a publication once per Receipt even when the event repeats", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const sessionId = fake.calls[0]!.sessionId!;
    fake.emit(sessionId, publication("pub-1"));
    fake.emit(sessionId, publication("pub-1"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered).toEqual([{ target: { kind: "address", address: direct }, deliverable: { kind: "publication", publication: publication("pub-1") }, key: "publication:pub-1" }]);
  });

  it("retries a failed delivery with backoff and gives up after the last attempt", async () => {
    const { hub, fake, channel, clock } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const sessionId = fake.calls[0]!.sessionId!;
    channel.failures = 1;
    fake.emit(sessionId, publication("pub-1"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered).toHaveLength(0);
    await hub.flush();
    expect(channel.delivered).toHaveLength(0);
    clock.now += 100;
    await hub.flush();
    expect(channel.delivered.map((item) => item.key)).toEqual(["publication:pub-1"]);

    channel.failures = 10;
    fake.emit(sessionId, publication("pub-2"));
    await hub.idle();
    for (let step = 0; step < 5; step += 1) {
      await hub.flush();
      clock.now += 1_000;
    }
    expect(channel.failures).toBe(7);
    expect(channel.delivered.map((item) => item.key)).toEqual(["publication:pub-1"]);
  });

  it("sends a group's result to the asker privately unless the group is allowed", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", group, alice));
    fake.emit(fake.calls[0]!.sessionId!, publication("pub-1"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered).toEqual([
      { target: { kind: "actor", actor: alice }, deliverable: { kind: "publication", publication: publication("pub-1") }, key: "publication:pub-1" },
      { target: { kind: "address", address: group }, deliverable: expect.objectContaining({ kind: "notice", code: "GROUP_DELIVERY_REDIRECTED" }), key: "notice:redirected:pub-1" },
    ]);

    const allowed = await setup({ allowGroupDelivery: (address) => address.chatId === "chat-1" });
    await allowed.hub.submit("im", input("evt-1", group, alice));
    allowed.fake.emit(allowed.fake.calls[0]!.sessionId!, publication("pub-1"));
    await allowed.hub.idle();
    await allowed.hub.flush();
    expect(allowed.channel.delivered).toEqual([{ target: { kind: "address", address: group }, deliverable: { kind: "publication", publication: publication("pub-1") }, key: "publication:pub-1" }]);
  });

  it("ignores events of Sessions that no channel owns", async () => {
    const { hub, fake, channel } = await setup();
    fake.emit("web-session", publication("pub-1"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered).toHaveLength(0);
  });

  it("coalesces progress and sends the final view when the run completes", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const sessionId = fake.calls[0]!.sessionId!;
    fake.emit(sessionId, { type: "agent.text_delta", delta: "正在" });
    fake.emit(sessionId, { type: "agent.tool_started", toolCallId: "c1", toolName: "query_database", args: {} });
    fake.emit(sessionId, { type: "agent.text_delta", delta: "查询" });
    await hub.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(channel.progressViews).toEqual([{ state: "running", runId: "run-1", text: "正在查询", activeTool: "查询数据库" }]);
    fake.emit(sessionId, { type: "agent.tool_finished", toolCallId: "c1", toolName: "query_database", result: null, isError: false });
    fake.emit(sessionId, { type: "agent.completed" });
    await hub.idle();
    expect(channel.progressViews.at(-1)).toEqual({ state: "completed", runId: "run-1", text: "正在查询" });
    expect(channel.progressTargets.at(-1)).toEqual({ kind: "address", address: direct });
  });

  it("sends a group run's narrative to the asker privately, because it quotes the results", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", group, alice));
    const sessionId = fake.calls[0]!.sessionId!;
    fake.emit(sessionId, { type: "agent.text_delta", delta: "上月销售额为 100 万" });
    fake.emit(sessionId, { type: "agent.completed" });
    await hub.idle();
    expect(channel.progressTargets).toEqual([{ kind: "actor", actor: alice }]);
  });

  it("lets a channel read a published CSV as the asker, only when it asks", async () => {
    const reads: { receiptId: string; userId: string; sessionId: string }[] = [];
    const { hub, fake, channel } = await setup({ publications: { read: async (receiptId, context) => { reads.push({ receiptId, ...context }); return { content: "销售额,100" }; } } });
    await hub.submit("im", input("evt-1", direct));
    const { sessionId, userId } = fake.calls[0]!;
    fake.emit(sessionId!, publication("pub-1"));
    await hub.idle();
    await hub.flush();
    expect(reads).toHaveLength(0);
    await expect(channel.contents[0]!.readPublication!()).resolves.toBe("销售额,100");
    expect(reads).toEqual([{ receiptId: "pub-1", userId, sessionId }]);
  });

  it("delivers each version of a dashboard once, where results may go, with its page and picture on demand", async () => {
    const reads: string[] = [];
    const page = new Uint8Array([60, 104]);
    const { hub, fake, channel } = await setup({
      dashboards: { read: async (path, context) => { reads.push(`${path}@${context.sessionId}`); return page; } },
      snapshot: async (html) => new Uint8Array([html.length]),
    });
    await hub.submit("im", input("evt-1", group, alice));
    const sessionId = fake.calls[0]!.sessionId!;
    const dashboard = (contentHash: string): DataAgentEvent => ({ type: "dashboard.delivered", path: "dashboards/sales.html", contentHash, receiptIds: ["pub-1"] });
    fake.emit(sessionId, dashboard("v1"));
    fake.emit(sessionId, dashboard("v1"));
    fake.emit(sessionId, dashboard("v2"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered.map((item) => [item.key, item.target.kind])).toEqual([["dashboard:v1", "actor"], ["dashboard:v2", "actor"]]);
    expect(reads).toHaveLength(0);
    await expect(channel.contents[0]!.snapshotDashboard!()).resolves.toEqual(new Uint8Array([2]));
    await expect(channel.contents[0]!.readDashboard!()).resolves.toBe(page);
    expect(reads).toEqual([`dashboards/sales.html@${sessionId}`, `dashboards/sales.html@${sessionId}`]);
  });

  it("starts a new Session on request, while the old one still delivers what it was doing", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const first = fake.calls[0]!.sessionId!;
    expect(await hub.submit("im", { requestId: "evt-2", address: direct, actor: alice, body: { kind: "new_conversation" } })).toBe("dispatched");
    await hub.submit("im", input("evt-3", direct, alice, "新的问题"));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.sessionId).not.toBe(first);
    expect(fake.calls[1]!.userId).toBe(fake.calls[0]!.userId);

    fake.emit(first, publication("pub-late"));
    await hub.idle();
    await hub.flush();
    expect(channel.delivered.map((item) => item.key)).toEqual(["notice:started:evt-2", "publication:pub-late"]);
  });

  it("reads /new and 新对话 typed alone in any channel as starting over, and an old question's answer as plain input", async () => {
    const { hub, fake, runtime } = await setup();
    await hub.submit("im", input("evt-1", direct));
    const first = fake.calls[0]!.sessionId!;
    const asked = runtime.askClarification(first, "含税吗？", []);
    expect(await hub.submit("im", input("evt-2", direct, alice, " /NEW "))).toBe("dispatched");
    await hub.submit("im", { requestId: "evt-3", address: direct, actor: alice, body: { kind: "answer", clarificationId: asked.clarificationId, text: "含税" } });
    await hub.submit("im", input("evt-4", direct, alice, "新对话"));
    await hub.submit("im", input("evt-5", direct, alice, "/new 上月销售额"));
    expect(fake.calls.map((call) => call.text)).toEqual(["上月销售额是多少？", "含税", "/new 上月销售额"]);
    expect(fake.calls[1]!.sessionId).not.toBe(first);
    expect(fake.calls[2]!.sessionId).not.toBe(fake.calls[1]!.sessionId);
    expect(runtime.clarificationManager.pendingFor(first)?.clarificationId).toBe(asked.clarificationId);
  });

  it("starts a new Session for input after a long quiet, but never for an answer", async () => {
    const { hub, fake, channel, clock, runtime } = await setup({ idleSessionMs: 60 * 60_000 });
    await hub.submit("im", input("evt-1", direct));
    clock.now += 30 * 60_000;
    await hub.submit("im", input("evt-2", direct, alice, "接着问"));
    const [first, second] = fake.calls;
    expect(second!.sessionId).toBe(first!.sessionId);

    clock.now += 61 * 60_000;
    await hub.submit("im", input("evt-3", direct, alice, "换个问题"));
    const rotated = fake.calls[2]!.sessionId!;
    expect(rotated).not.toBe(first!.sessionId);
    await hub.flush();
    expect(channel.delivered.at(-1)).toMatchObject({ key: "notice:started:evt-3", deliverable: { kind: "notice", code: "CONVERSATION_STARTED", text: expect.stringContaining("1 小时") } });

    const asked = runtime.askClarification(rotated, "含税吗？", []);
    clock.now += 3 * 60 * 60_000;
    await hub.submit("im", { requestId: "evt-4", address: direct, actor: alice, body: { kind: "answer", clarificationId: asked.clarificationId, text: "含税" } });
    await expect(asked.promise).resolves.toBe("含税");
    expect(fake.calls).toHaveLength(3);
  });
});

describe("ChannelHub access", () => {
  const command = (requestId: string, text: string, address: ConversationAddress = direct, actor = alice): Submission => ({ requestId, address, actor, body: { kind: "input", text, whenBusy: "follow_up" } });
  const notices = (channel: MemoryChannel) => channel.delivered.map((item) => item.deliverable.kind === "notice" ? item.deliverable.code : item.deliverable.kind);

  it("runs nothing for a sender who has not linked an account, whatever they send", async () => {
    const { hub, fake, channel, runtime } = await setup({ linked: false });
    expect(await hub.submit("im", input("evt-1", group))).toBe("denied");
    expect(await hub.submit("im", command("evt-2", "/new"))).toBe("denied");
    const asked = runtime.askClarification("some-session", "含税吗？", []);
    expect(await hub.submit("im", { requestId: "evt-3", address: direct, actor: alice, body: { kind: "answer", clarificationId: asked.clarificationId, text: "含税" } })).toBe("denied");
    await hub.flush();
    expect(fake.calls).toHaveLength(0);
    expect(runtime.clarificationManager.pendingFor("some-session")).toBeDefined();
    expect(notices(channel)).toEqual(["ACCESS_DENIED", "ACCESS_DENIED", "ACCESS_DENIED"]);
    expect(channel.delivered[0]!.target).toEqual({ kind: "address", address: group });
  });

  it("links a sender with a one-time code in a private chat, then runs as that account", async () => {
    const { hub, fake, channel } = await setup({ linked: false });
    const { code, expiresAt } = await hub.createLinkCode("user-web");
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(expiresAt).toBe(1_000 + 10 * 60_000);
    expect(await hub.submit("im", command("evt-1", `/bind ${code}`))).toBe("dispatched");
    await hub.submit("im", input("evt-2", direct));
    expect(fake.calls).toEqual([expect.objectContaining({ kind: "prompt", userId: "user-web" })]);

    // The code is spent: nobody else can link with it.
    await hub.submit("im", command("evt-3", `/绑定 ${code}`, direct, bob));
    await hub.flush();
    expect(notices(channel)).toEqual(["ACCOUNT_LINKED", "LINK_FAILED"]);
  });

  it("spends a code that was shown in a group without linking anyone", async () => {
    const { hub, fake, channel } = await setup({ linked: false });
    const { code } = await hub.createLinkCode("user-web");
    await hub.submit("im", command("evt-1", `/bind ${code}`, group));
    await hub.submit("im", command("evt-2", `/bind ${code}`));
    await hub.submit("im", input("evt-3", direct));
    await hub.flush();
    expect(fake.calls).toHaveLength(0);
    expect(channel.delivered.map((item) => [item.deliverable.kind === "notice" ? item.deliverable.text.slice(0, 6) : "", item.target.kind])).toEqual([
      ["绑定码只能在", "address"],
      ["绑定码无效、", "address"],
      ["你还没有使用", "address"],
    ]);
  });

  it("refuses expired codes and locks a sender out for an hour after five wrong tries", async () => {
    const { hub, fake, channel, clock } = await setup({ linked: false });
    const stale = await hub.createLinkCode("user-web");
    clock.now += 11 * 60_000;
    await hub.submit("im", command("evt-0", `/bind ${stale.code}`));
    for (let attempt = 1; attempt <= 4; attempt += 1) await hub.submit("im", command(`evt-${attempt}`, "/bind 000000"));
    const fresh = await hub.createLinkCode("user-web");
    await hub.submit("im", command("evt-5", `/bind ${fresh.code}`));
    await hub.submit("im", command("evt-6", "/bind"));
    await hub.flush();
    expect(channel.delivered.slice(-2).map((item) => item.deliverable.kind === "notice" ? item.deliverable.text : "")).toEqual(["尝试次数过多，请一小时后再试。", "尝试次数过多，请一小时后再试。"]);

    clock.now += 61 * 60_000;
    const later = await hub.createLinkCode("user-web");
    await hub.submit("im", command("evt-7", "/bind"));
    await hub.submit("im", command("evt-8", `/bind ${later.code}`));
    await hub.submit("im", input("evt-9", direct));
    await hub.flush();
    expect(channel.delivered.slice(-2).map((item) => item.deliverable.kind === "notice" ? item.deliverable.code : "")).toEqual(["LINK_FAILED", "ACCOUNT_LINKED"]);
    expect(channel.delivered.at(-2)!.deliverable).toMatchObject({ text: expect.stringContaining("/bind 123456") });
    expect(fake.calls).toEqual([expect.objectContaining({ userId: "user-web" })]);
  });
});

describe("ChannelHub access requests", () => {
  const carol = { channel: "im", tenant: "t1", externalUserId: "carol" };
  const aliceChat: ConversationAddress = { channel: "im", tenant: "t1", chatId: "dm-alice-admin", audience: "direct" };
  const carolChat: ConversationAddress = { channel: "im", tenant: "t1", chatId: "dm-carol", audience: "direct" };
  const decide = (requestId: string, decision: "allow" | "deny", eventId: string, actor = alice): Submission => ({ requestId: eventId, address: aliceChat, actor, body: { kind: "access_decision", requestId, decision } });
  const notice = (item: { deliverable: Deliverable }) => item.deliverable.kind === "notice" ? item.deliverable.text : item.deliverable.kind;

  it("lets whoever scanned the bot use it straight away, as an account member who can let others in", async () => {
    const { hub, fake, channel } = await setup({ linked: false, owner: { externalUserId: "alice", userId: "user-owner" } });
    expect(await hub.submit("im", input("evt-1", direct))).toBe("dispatched");
    await hub.flush();
    expect(fake.calls).toHaveLength(1);
    // Nothing to approve; the owner's first message only brings a welcome with the commands.
    expect(channel.delivered.filter((item) => item.deliverable.kind === "access_request" || item.deliverable.kind === "notice").map((item) => item.deliverable)).toEqual([
      { kind: "notice", code: "HELP", text: expect.stringContaining("/detail") },
    ]);
    expect((await hub.access()).members).toEqual([expect.objectContaining({ actor: alice, role: "account" })]);

    // Someone else in a group still asks, and the request reaches the owner.
    expect(await hub.submit("im", input("evt-2", group, carol, "上月销售额"))).toBe("denied");
    await hub.flush();
    expect(channel.delivered.find((item) => item.deliverable.kind === "access_request")).toBeDefined();
  });

  it("forgets a channel's members and waiting requests when its bot is replaced or removed", async () => {
    const { hub, channel } = await setup();
    await hub.submit("im", input("evt-1", group, carol, "上月销售额"));
    await hub.flush();
    expect((await hub.access()).requests).toHaveLength(1);
    await hub.forgetAccess("im");
    expect(await hub.access()).toEqual({ members: [], requests: [] });
    // Without an owner or members, a message is simply refused.
    expect(await hub.submit("im", input("evt-2", direct))).toBe("denied");
    expect(channel.delivered.length).toBeGreaterThan(0);
  });

  it("turns a stranger's first message into one private request to every linked account, and runs nothing", async () => {
    const { hub, fake, channel } = await setup();
    expect(await hub.submit("im", input("evt-1", group, carol, "上月销售额"))).toBe("denied");
    expect(await hub.submit("im", input("evt-2", group, carol, "还在吗"))).toBe("denied");
    await hub.flush();
    expect(fake.calls).toHaveLength(0);
    const requests = channel.delivered.filter((item) => item.deliverable.kind === "access_request");
    expect(requests.map((item) => item.target)).toEqual([{ kind: "actor", actor: alice }, { kind: "actor", actor: bob }]);
    expect(requests[0]!.deliverable).toMatchObject({ requester: carol, audience: "group", text: "上月销售额" });
    expect(channel.delivered.filter((item) => item.target.kind === "address").map(notice)).toEqual(["已向管理员申请使用权限，批准后会通知你。", "你的使用申请正在等待管理员处理。"]);
  });

  it("lets the first member's decision count, makes the requester a guest of their own, and tells everyone", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", direct, carol));
    await hub.flush();
    const request = channel.delivered.find((item) => item.deliverable.kind === "access_request")!.deliverable as Extract<Deliverable, { kind: "access_request" }>;

    await hub.submit("im", decide(request.requestId, "allow", "evt-2"));
    await hub.submit("im", decide(request.requestId, "deny", "evt-3", bob));
    await hub.flush();
    expect(channel.delivered.filter((item) => item.deliverable.kind === "notice").slice(-3).map((item) => [item.target.kind === "actor" ? item.target.actor.externalUserId : item.target.address.chatId, notice(item)])).toEqual([
      ["carol", "管理员已同意你使用数据助手，请重新发送你的问题。发送 /help 查看可用命令。"],
      ["dm-alice-admin", "已允许，对方会收到通知。"],
      ["dm-alice-admin", "这条申请已经处理过了。"],
    ]);

    await hub.submit("im", input("evt-4", direct, carol, "上月销售额"));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.userId).not.toMatch(/^user-/);

    // A guest uses the bot but cannot let others in.
    await hub.submit("im", input("evt-5", direct, { channel: "im", tenant: "t1", externalUserId: "dave" }));
    await hub.flush();
    const daves = channel.delivered.filter((item) => item.deliverable.kind === "access_request").at(-1)!.deliverable as Extract<Deliverable, { kind: "access_request" }>;
    await hub.submit("im", { ...decide(daves.requestId, "allow", "evt-6", carol), address: direct });
    await hub.flush();
    expect(notice(channel.delivered.at(-1)!)).toBe("只有已绑定账号的成员可以处理使用申请。");
  });

  it("keeps a refusal for a week, then lets the person ask again", async () => {
    const { hub, channel, clock } = await setup();
    await hub.submit("im", input("evt-1", carolChat, carol));
    await hub.flush();
    const request = channel.delivered.find((item) => item.deliverable.kind === "access_request")!.deliverable as Extract<Deliverable, { kind: "access_request" }>;
    await hub.submit("im", decide(request.requestId, "deny", "evt-2"));
    clock.now += 6 * 24 * 60 * 60_000;
    await hub.submit("im", input("evt-3", carolChat, carol));
    clock.now += 2 * 24 * 60 * 60_000;
    await hub.submit("im", input("evt-4", carolChat, carol));
    await hub.flush();
    const toCarol = channel.delivered.filter((item) => item.target.kind === "actor" ? item.target.actor === carol || item.target.actor.externalUserId === "carol" : item.target.address.chatId === carolChat.chatId).map(notice);
    expect(toCarol).toEqual(["已向管理员申请使用权限，批准后会通知你。", "管理员没有同意你的使用申请。", "管理员没有同意你的使用申请。", "已向管理员申请使用权限，批准后会通知你。"]);
    expect(channel.delivered.filter((item) => item.deliverable.kind === "access_request")).toHaveLength(4);
  });

  it("serves the settings page: members and waiting requests, a decision as the signed-in user, and revoking", async () => {
    const { hub, fake } = await setup();
    await hub.submit("im", input("evt-1", direct, carol, "请让我用一下"));
    const before = await hub.access();
    expect(before.members.map((member) => [member.actor.externalUserId, member.role])).toEqual([["alice", "account"], ["bob", "account"]]);
    expect(before.requests).toEqual([expect.objectContaining({ requester: carol, audience: "direct", text: "请让我用一下" })]);

    expect(await hub.decideAccess(before.requests[0]!.id, "allow", "user-web")).toBe("allowed");
    const after = await hub.access();
    expect(after.requests).toEqual([]);
    expect(after.members.find((member) => member.actor.externalUserId === "carol")).toMatchObject({ role: "guest" });

    await hub.revokeAccess(carol);
    expect(await hub.submit("im", input("evt-2", direct, carol))).toBe("denied");
    expect(fake.calls).toHaveLength(0);
    expect((await hub.access()).requests).toHaveLength(1);
    expect(await hub.decideAccess("no-such-request", "allow", "user-web")).toBe("unknown");
  });
});


describe("ChannelHub commands and reply detail", () => {
  const notices = (channel: { delivered: { deliverable: Deliverable }[] }) => channel.delivered.flatMap((item) => item.deliverable.kind === "notice" ? [item.deliverable] : []);

  it("answers /help and /status without asking the agent", async () => {
    const { hub, fake, channel } = await setup();
    await hub.submit("im", input("evt-1", direct, alice, "/help"));
    await hub.submit("im", input("evt-2", direct, alice, "/状态"));
    await hub.flush();
    expect(fake.calls).toHaveLength(0);
    expect(notices(channel).map((item) => item.code)).toEqual(["HELP", "STATUS"]);
    expect(notices(channel)[0]!.text).toContain("/new");
    expect(notices(channel)[1]!.text).toContain("回复详细度：标准");
    expect(notices(channel)[1]!.text).toContain("下一条消息会开始新对话");
  });

  it("lets an account member change the reply detail from the chat, saved for everyone, and refuses a guest", async () => {
    const { hub, channel, store } = await setup();
    const saved: string[] = [];
    hub.onReplyDetailChange = async (channelId, detail) => { saved.push(`${channelId}:${detail}`); };
    await store.link(bob, "user-guest", 0, "guest");
    await hub.submit("im", input("evt-1", direct, alice, "/detail 摘要"));
    await hub.submit("im", input("evt-2", direct, bob, "/detail full"));
    await hub.submit("im", input("evt-3", direct, alice, "/detail 很多"));
    await hub.submit("im", input("evt-4", direct, alice, "/详细度"));
    await hub.flush();
    expect(saved).toEqual(["im:summary"]);
    expect(hub.replyDetail("im")).toBe("summary");
    expect(notices(channel).map((item) => item.text)).toEqual([
      expect.stringContaining("已改为“摘要”"),
      "只有已绑定账号的成员可以调整回复详细度。",
      expect.stringContaining("请发送 /detail"),
      expect.stringContaining("当前回复详细度：摘要"),
    ]);
  });

  const run = async (detail: "summary" | "standard" | "full") => {
    const { hub, fake, channel } = await setup();
    hub.setReplyDetail("im", detail);
    await hub.submit("im", input("evt-1", direct));
    const sessionId = fake.calls[0]!.sessionId!;
    fake.emit(sessionId, { type: "agent.text_delta", delta: "我先查一下。" });
    fake.emit(sessionId, { type: "agent.tool_started", toolCallId: "c1", toolName: "query_database", args: {} });
    await hub.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.emit(sessionId, { type: "agent.tool_finished", toolCallId: "c1", toolName: "query_database", result: null, isError: false });
    fake.emit(sessionId, { type: "agent.tool_started", toolCallId: "c2", toolName: "query_database", args: {} });
    fake.emit(sessionId, { type: "agent.tool_finished", toolCallId: "c2", toolName: "query_database", result: null, isError: false });
    fake.emit(sessionId, { type: "agent.tool_started", toolCallId: "c3", toolName: "render_chart", args: {} });
    fake.emit(sessionId, { type: "agent.tool_finished", toolCallId: "c3", toolName: "render_chart", result: null, isError: false });
    fake.emit(sessionId, { type: "agent.text_delta", delta: "上月销售额 120 万。" });
    fake.emit(sessionId, { type: "agent.completed" });
    await hub.idle();
    return channel.progressViews;
  };

  it("sends only the final answer at summary detail, nothing while the run works", async () => {
    expect(await run("summary")).toEqual([{ state: "completed", runId: "run-1", text: "上月销售额 120 万。" }]);
  });

  it("streams at standard detail and lists the steps taken at full detail", async () => {
    const standard = await run("standard");
    expect(standard[0]).toMatchObject({ state: "running", activeTool: "查询数据库" });
    expect(standard.at(-1)).toEqual({ state: "completed", runId: "run-1", text: "我先查一下。上月销售额 120 万。" });
    expect((await run("full")).at(-1)).toEqual({ state: "completed", runId: "run-1", text: "我先查一下。上月销售额 120 万。", steps: ["查询数据库 ×2", "生成图表"] });
  });
});
