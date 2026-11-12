import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DataAgentEvent } from "@data-agent/contracts";
import { ChannelHub } from "@data-agent/runtime";
import { AgentControllerError, ClarificationManager, DataAgentRuntime, MetadataChannelStore, MetadataStore } from "@data-agent/runtime/testing";
import type { FeishuApi, FeishuEventHandler, FeishuEvents } from "./api.js";
import { FeishuChannel } from "./channel.js";

/** The Feishu channel behind the real hub, protocol and metadata; only Feishu and the model are fakes. */

const BOT = "ou_bot";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function system(options: { groupChats?: readonly string[] } = {}) {
  const root = await mkdtemp(join(process.cwd(), ".tmp-feishu-hub-"));
  const metadata = new MetadataStore(join(root, "metadata.db"));
  const prompts: { kind: string; text: string; sessionId?: string }[] = [];
  let listener: ((event: unknown) => void) | undefined;
  let busy = false;
  let sequence = 1;
  const agent = {
    async prompt(text: string, context?: { sessionId?: string }) {
      if (busy) throw new AgentControllerError("ADMISSION_REJECTED", "busy", { busy: true });
      prompts.push({ kind: "prompt", text, ...context });
      return { operationId: `op-${prompts.length}` };
    },
    async followUp(text: string, context?: { sessionId?: string }) { prompts.push({ kind: "followUp", text, ...context }); },
    subscribe(next: (event: unknown) => void) { listener = next; return () => undefined; },
  };
  const clarifications = new ClarificationManager(60_000);
  const runtime = new DataAgentRuntime({ metadata, clarifications, agent: agent as never });
  const emit = (sessionId: string, event: DataAgentEvent) => listener?.({ type: "presentation.event", sessionId, envelope: { protocolVersion: 1, sequence: sequence++, requestId: "r", sessionId, runId: "run-1", timestamp: 1, event } });

  const calls: { op: string; args: unknown[] }[] = [];
  let sent = 1;
  const api: FeishuApi = {
    async botOpenId() { return BOT; },
    async send(...args) { calls.push({ op: "send", args }); return `om_${sent++}`; },
    async reply(...args) { calls.push({ op: "reply", args }); return `om_${sent++}`; },
    async patchCard(...args) { calls.push({ op: "patch", args }); },
    async uploadFile(...args) { calls.push({ op: "upload", args }); return "file_1"; },
    async uploadImage(...args) { calls.push({ op: "uploadImage", args }); return "img_1"; },
  };
  const handlers: { message?: FeishuEventHandler; cardAction?: FeishuEventHandler } = {};
  const events: FeishuEvents = { async connect(next) { Object.assign(handlers, next); }, async disconnect() {} };

  const store = new MetadataChannelStore(metadata);
  for (const openId of ["ou_alice", "ou_bob"]) await store.link({ channel: "feishu", tenant: "tenant-1", externalUserId: openId }, `user-${openId}`, 0);
  const hub = new ChannelHub({
    host: runtime,
    store,
    allowGroupDelivery: (address) => (options.groupChats ?? []).includes(address.chatId),
    publications: { read: async () => ({ content: "区域,销售额\n华东,100\n华北,80" }) },
    dashboards: { read: async () => new TextEncoder().encode("<!doctype html>") },
    snapshot: async () => new Uint8Array([137, 80, 78, 71]),
    progressIntervalMs: 5,
    retry: { pollMs: 3_600_000 },
  });
  await hub.register(new FeishuChannel({ api, events }));
  cleanups.push(async () => { await hub.close(); await metadata.close(); await rm(root, { recursive: true, force: true }); });

  /** Lets fire-and-forget submissions and event handling finish, then delivers. */
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await hub.idle();
    await hub.flush();
  };
  return { runtime, clarifications, prompts, emit, calls, handlers, settle, setBusy: (value: boolean) => { busy = value; } };
}

/** Waits for a fire-and-forget outcome, failing after a few seconds. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const message = (eventId: string, text: string, chat: { chatType?: "p2p" | "group"; sender?: string; mentions?: unknown[] } = {}) => ({
  event_id: eventId,
  tenant_key: "tenant-1",
  sender: { sender_id: { open_id: chat.sender ?? "ou_alice" }, sender_type: "user" },
  message: { message_id: `om_in_${eventId}`, chat_id: "oc_1", chat_type: chat.chatType ?? "p2p", message_type: "text", content: JSON.stringify({ text }), ...(chat.mentions ? { mentions: chat.mentions } : {}) },
});
const mention = { key: "@_user_1", id: { open_id: BOT }, name: "数据助手" };

describe("Feishu channel through the hub", () => {
  it("runs a question, a typed clarification answer and a CSV result end to end", async () => {
    const { runtime, prompts, emit, calls, handlers, settle } = await system();
    await handlers.message!(message("evt-1", "上月各区域销售额"));
    await handlers.message!(message("evt-1", "上月各区域销售额"));
    await settle();
    expect(prompts).toMatchObject([{ kind: "prompt", text: "上月各区域销售额", sessionId: expect.any(String) }]);
    expect(prompts).toHaveLength(1);
    const sessionId = prompts[0]!.sessionId!;

    const asked = runtime.clarificationManager.ask(sessionId, "销售额是否含税？", ["含税", "不含税"]);
    await settle();
    expect(calls.at(-1)).toMatchObject({ op: "send", args: ["chat_id", "oc_1", "interactive", expect.stringContaining("销售额是否含税？"), expect.any(String)] });

    await handlers.message!(message("evt-2", "不含税"));
    await expect(asked.promise).resolves.toBe("不含税");

    emit(sessionId, { type: "publication.delivered", receiptId: "pub-1", taskId: "task-1", format: "csv", publicRef: "/x" });
    await settle();
    expect(calls.slice(-3).map((call) => call.op)).toEqual(["send", "upload", "send"]);
    expect(calls.at(-1)!.args.slice(2, 4)).toEqual(["file", JSON.stringify({ file_key: "file_1" })]);
  });

  it("keeps a group's results and narrative with the asker unless the group is allowed", async () => {
    const { prompts, emit, calls, handlers, settle } = await system();
    await handlers.message!(message("evt-1", "@_user_1 上月销售额", { chatType: "group", mentions: [mention] }));
    await settle();
    const sessionId = prompts[0]!.sessionId!;
    emit(sessionId, { type: "agent.text_delta", delta: "上月销售额为 180。" });
    emit(sessionId, { type: "agent.completed" });
    emit(sessionId, { type: "publication.delivered", receiptId: "pub-1", taskId: "task-1", format: "inline", publicRef: "/x", inlineContent: "销售额\n180" });
    await settle();
    const privately = calls.filter((call) => call.args[0] === "open_id").map((call) => call.args[1]);
    const inGroup = calls.filter((call) => call.op === "reply").map((call) => [call.args[1], call.args[1] === "text" ? JSON.parse(call.args[2] as string).text : undefined]);
    expect(privately).toEqual(["ou_alice", "ou_alice"]);
    // The group sees only the redirect notice: no narrative card, no result card.
    expect(inGroup).toEqual([["text", "查询结果已私聊发送给提问人。"]]);

    const allowed = await system({ groupChats: ["oc_1"] });
    await allowed.handlers.message!(message("evt-1", "@_user_1 上月销售额", { chatType: "group", mentions: [mention] }));
    await allowed.settle();
    allowed.emit(allowed.prompts[0]!.sessionId!, { type: "publication.delivered", receiptId: "pub-1", taskId: "task-1", format: "inline", publicRef: "/x", inlineContent: "销售额\n180" });
    await allowed.settle();
    expect(allowed.calls.map((call) => [call.op, call.args[0]])).toEqual([["reply", "om_in_evt-1"]]);
  });

  it("gives each group member a session and routes a click on someone else's question to the clicker's own session", async () => {
    const { runtime, prompts, handlers, settle } = await system();
    await handlers.message!(message("evt-1", "@_user_1 销售额", { chatType: "group", mentions: [mention] }));
    await handlers.message!(message("evt-2", "@_user_1 订单量", { chatType: "group", mentions: [mention], sender: "ou_bob" }));
    await settle();
    // Submissions are fire-and-forget; each makes several metadata round trips before its prompt.
    await until(() => prompts.length === 2);
    const [alice, bob] = prompts;
    expect(alice!.sessionId).not.toBe(bob!.sessionId);
    const asked = runtime.clarificationManager.ask(alice!.sessionId!, "含税吗？", ["含税"]);
    await settle();
    const response = await handlers.cardAction!({ event_id: "evt-3", tenant_key: "tenant-1", operator: { open_id: "ou_bob" }, context: { open_chat_id: "oc_1" }, action: { value: { kind: "answer", clarificationId: asked.clarificationId, text: "含税", audience: "group" } } });
    expect(response).toMatchObject({ toast: { type: "success" } });
    await settle();
    expect(prompts.at(-1)).toMatchObject({ kind: "prompt", text: "含税", sessionId: bob!.sessionId });
    expect(runtime.clarificationManager.pendingFor(alice!.sessionId!)?.clarificationId).toBe(asked.clarificationId);
  });

  it("sends a generated dashboard to the phone as a picture and the page", async () => {
    const { prompts, emit, calls, handlers, settle } = await system();
    await handlers.message!(message("evt-1", "做一个三大行业销售看板"));
    await settle();
    emit(prompts[0]!.sessionId!, { type: "dashboard.delivered", path: "dashboards/sales.html", contentHash: "v1", receiptIds: ["pub-1"] });
    await settle();
    expect(calls.map((call) => [call.op, call.args[0], call.args[2]])).toEqual([
      ["uploadImage", expect.anything(), undefined],
      ["send", "chat_id", "image"],
      ["upload", "sales.html", undefined],
      ["send", "chat_id", "file"],
    ]);
  });
});
