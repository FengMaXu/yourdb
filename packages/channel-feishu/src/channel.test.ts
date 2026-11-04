import { describe, expect, it } from "vitest";
import type { ConversationAddress, Deliverable, DeliveryTarget, Submission } from "@data-agent/contracts";
import type { FeishuApi, FeishuEventHandler, FeishuEvents } from "./api.js";
import { FeishuChannel } from "./channel.js";
import { parseCsv, progressCard, tableElements, withoutLocalLinks } from "./cards.js";
import { cardActionSubmission, messageSubmission } from "./inbound.js";

const BOT = "ou_bot";

function textMessage(overrides: { eventId?: string; chatType?: "p2p" | "group"; text?: string; mentions?: unknown[]; threadId?: string; senderType?: string; messageType?: string; messageId?: string } = {}) {
  return {
    event_id: overrides.eventId ?? "evt-1",
    tenant_key: "tenant-1",
    event_type: "im.message.receive_v1",
    sender: { sender_id: { open_id: "ou_alice" }, sender_type: overrides.senderType ?? "user", tenant_key: "tenant-1" },
    message: {
      message_id: overrides.messageId ?? "om_1",
      chat_id: "oc_1",
      chat_type: overrides.chatType ?? "p2p",
      message_type: overrides.messageType ?? "text",
      content: JSON.stringify({ text: overrides.text ?? "上月销售额是多少？" }),
      ...(overrides.mentions ? { mentions: overrides.mentions } : {}),
      ...(overrides.threadId ? { thread_id: overrides.threadId } : {}),
    },
  };
}

const botMention = { key: "@_user_1", id: { open_id: BOT }, name: "数据助手" };
const bobMention = { key: "@_user_2", id: { open_id: "ou_bob" }, name: "Bob" };

describe("Feishu inbound events", () => {
  it("turns a direct text message into an input Submission keyed by the event id", () => {
    expect(messageSubmission(textMessage(), { botOpenId: BOT })).toEqual({
      messageId: "om_1",
      submission: {
        requestId: "evt-1",
        address: { channel: "feishu", tenant: "tenant-1", chatId: "oc_1", audience: "direct" },
        actor: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_alice" },
        body: { kind: "input", text: "上月销售额是多少？", whenBusy: "follow_up" },
      },
    });
  });

  it("takes a group message only when it mentions the bot, and cleans the mentions", () => {
    expect(messageSubmission(textMessage({ chatType: "group", text: "@_user_2 上月销售额" , mentions: [bobMention] }), { botOpenId: BOT })).toBeUndefined();
    const inbound = messageSubmission(textMessage({ chatType: "group", text: "@_user_1 @_user_2 负责的区域销售额", mentions: [botMention, bobMention], threadId: "omt_1" }), { botOpenId: BOT });
    expect(inbound?.submission.address).toEqual({ channel: "feishu", tenant: "tenant-1", chatId: "oc_1", threadId: "omt_1", audience: "group" });
    expect(inbound?.submission.body).toEqual({ kind: "input", text: "@Bob 负责的区域销售额", whenBusy: "follow_up" });
  });

  it("ignores bots, non-text messages and a bare mention", () => {
    expect(messageSubmission(textMessage({ senderType: "app" }), { botOpenId: BOT })).toBeUndefined();
    expect(messageSubmission(textMessage({ messageType: "image" }), { botOpenId: BOT })).toBeUndefined();
    expect(messageSubmission(textMessage({ chatType: "group", text: "@_user_1", mentions: [botMention] }), { botOpenId: BOT })).toBeUndefined();
  });

  it("turns a question-card click into an answer from whoever clicked", () => {
    const click = { event_id: "evt-9", tenant_key: "tenant-1", operator: { open_id: "ou_bob" }, context: { open_chat_id: "oc_1", open_message_id: "om_q" }, action: { tag: "button", value: { kind: "answer", clarificationId: "clar-1", text: "已支付订单", audience: "group", threadId: "omt_1" } } };
    expect(cardActionSubmission(click)).toEqual({
      requestId: "evt-9",
      address: { channel: "feishu", tenant: "tenant-1", chatId: "oc_1", threadId: "omt_1", audience: "group" },
      actor: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_bob" },
      body: { kind: "answer", clarificationId: "clar-1", text: "已支付订单" },
    });
    expect(cardActionSubmission({ ...click, action: { value: { kind: "other" } } })).toBeUndefined();
  });
});

describe("Feishu cards", () => {
  it("parses quoted CSV with a BOM and CRLF", () => {
    expect(parseCsv("﻿区域,备注\r\n华东,\"含\"\"税\"\",合计\"\r\n华北,\n")).toEqual([["区域", "备注"], ["华东", "含\"税\",合计"], ["华北", ""]]);
  });

  it("turns workspace links into plain text and keeps web links", () => {
    expect(withoutLocalLinks("看板：**[sales.html](dashboards/sales.html)**，口径见[文档](https://example.com/a)。![图](charts/a.png)")).toBe("看板：**sales.html**，口径见[文档](https://example.com/a)。");
    expect(JSON.parse(progressCard({ state: "completed", text: "见 [看板](dashboards/a.html)" })).body.elements[0].content).toBe("见 看板");
    expect(JSON.stringify(JSON.parse(progressCard({ state: "completed", text: "好", steps: ["查询数据库", "生成图表"] })).body.elements[1])).toContain("做过的步骤：查询数据库 → 生成图表");
  });

  it("renders a result as a table and says when columns were dropped", () => {
    const header = Array.from({ length: 52 }, (_value, index) => `col${index}`).join(",");
    const elements = tableElements(`${header}\n${Array.from({ length: 52 }, () => "1").join(",")}`) as { tag: string; columns?: unknown[]; content?: string }[];
    expect(elements[0]).toMatchObject({ tag: "table", page_size: 1 });
    expect(elements[0]!.columns).toHaveLength(50);
    expect(elements[1]!.content).toContain("共 52 列");
  });
});

type ApiCall = { op: string; args: unknown[] };

function fakeApi(): FeishuApi & { calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  let next = 1;
  return {
    calls,
    async botOpenId() { return BOT; },
    async send(...args) { calls.push({ op: "send", args }); return `om_sent_${next++}`; },
    async reply(...args) { calls.push({ op: "reply", args }); return `om_sent_${next++}`; },
    async patchCard(...args) { calls.push({ op: "patch", args }); },
    async uploadFile(...args) { calls.push({ op: "upload", args }); return "file_key_1"; },
    async uploadImage(...args) { calls.push({ op: "uploadImage", args }); return "img_key_1"; },
  };
}

function fakeEvents(): FeishuEvents & { message: FeishuEventHandler; cardAction: FeishuEventHandler } {
  const events = {
    message: (async () => undefined) as FeishuEventHandler,
    cardAction: (async () => undefined) as FeishuEventHandler,
    async connect(handlers: { message: FeishuEventHandler; cardAction: FeishuEventHandler }) { events.message = handlers.message; events.cardAction = handlers.cardAction; },
    async disconnect() {},
  };
  return events;
}

async function started(onError: (error: unknown) => void = (error) => { throw error; }) {
  const api = fakeApi();
  const events = fakeEvents();
  const channel = new FeishuChannel({ api, events, onError });
  const received: Submission[] = [];
  await channel.start(async (submission) => { received.push(submission); });
  return { api, events, channel, received };
}

const direct: ConversationAddress = { channel: "feishu", tenant: "tenant-1", chatId: "oc_1", audience: "direct" };
const group: ConversationAddress = { channel: "feishu", tenant: "tenant-1", chatId: "oc_1", threadId: "omt_1", audience: "group" };
const toChat = (address: ConversationAddress): DeliveryTarget => ({ kind: "address", address });
const publication = (format: "inline" | "csv"): Deliverable => ({ kind: "publication", publication: { type: "publication.delivered", receiptId: "pub-1", taskId: "task-1", format, publicRef: "/x", disclosure: "口径按字面解释。", ...(format === "inline" ? { inlineContent: "区域,销售额\n华东,100" } : {}) } });
const dashboard: Deliverable = { kind: "dashboard", dashboard: { type: "dashboard.delivered", path: "dashboards/sales.html", contentHash: "h1", receiptIds: ["pub-1"] } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FeishuChannel", () => {
  it("answers the platform at once and forwards the Submission", async () => {
    const { events, received } = await started();
    await expect(events.message(textMessage())).resolves.toBeUndefined();
    await tick();
    expect(received.map((submission) => submission.requestId)).toEqual(["evt-1"]);
  });

  it("sends a question card and treats the next typed reply in that chat as its answer", async () => {
    const { api, events, channel, received } = await started();
    await channel.deliver(toChat(direct), { kind: "question", clarificationId: "clar-1", question: "订单量指什么？", options: ["全部订单", "已支付订单"] }, "question:clar-1");
    const [receiveType, receiveId, msgType, content] = api.calls[0]!.args as string[];
    expect([api.calls[0]!.op, receiveType, receiveId, msgType]).toEqual(["send", "chat_id", "oc_1", "interactive"]);
    expect(JSON.parse(content!).body.elements[1]).toMatchObject({ tag: "button", behaviors: [{ type: "callback", value: { kind: "answer", clarificationId: "clar-1", text: "全部订单", audience: "direct" } }] });

    await events.message(textMessage({ eventId: "evt-2", text: "已支付的" }));
    await events.message(textMessage({ eventId: "evt-3", text: "再按月拆分" }));
    await tick();
    expect(received.map((submission) => submission.body)).toEqual([
      { kind: "answer", clarificationId: "clar-1", text: "已支付的" },
      { kind: "input", text: "再按月拆分", whenBusy: "follow_up" },
    ]);
  });

  it("acknowledges a card click with a toast and a closed card", async () => {
    const { events, received } = await started();
    const response = await events.cardAction({ event_id: "evt-9", tenant_key: "tenant-1", operator: { open_id: "ou_alice" }, context: { open_chat_id: "oc_1" }, action: { value: { kind: "answer", clarificationId: "clar-1", text: "已支付订单", audience: "direct" } } });
    expect(response).toMatchObject({ toast: { type: "success" }, card: { type: "raw", data: { schema: "2.0" } } });
    await tick();
    expect(received[0]!.body).toEqual({ kind: "answer", clarificationId: "clar-1", text: "已支付订单" });
  });

  it("uses one stable uuid per Deliverable so a retry does not post twice", async () => {
    const { api, channel } = await started();
    await channel.deliver(toChat(direct), { kind: "notice", code: "SUBMISSION_REJECTED", text: "请重试" }, "notice:rejected:evt-1");
    await channel.deliver(toChat(direct), { kind: "notice", code: "SUBMISSION_REJECTED", text: "请重试" }, "notice:rejected:evt-1");
    const [first, second] = api.calls.map((call) => call.args[4]);
    expect(first).toBe(second);
    expect(String(first).length).toBeLessThanOrEqual(50);
  });

  it("replies in the asker's thread in a group, and to a person by open_id", async () => {
    const { api, events, channel } = await started();
    await events.message(textMessage({ chatType: "group", text: "@_user_1 销售额", mentions: [botMention], threadId: "omt_1", messageId: "om_ask" }));
    await channel.deliver(toChat(group), { kind: "notice", code: "GROUP_DELIVERY_REDIRECTED", text: "已私聊" }, "n1");
    await channel.deliver({ kind: "actor", actor: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_alice" } }, publication("inline"), "publication:pub-1");
    expect(api.calls[0]).toMatchObject({ op: "reply", args: ["om_ask", "text", JSON.stringify({ text: "已私聊" }), expect.any(String), true] });
    expect(api.calls[1]).toMatchObject({ op: "send", args: ["open_id", "ou_alice", "interactive", expect.any(String), expect.any(String)] });
  });

  it("shows an inline result as a table with its disclosure", async () => {
    const { api, channel } = await started();
    await channel.deliver(toChat(direct), publication("inline"), "publication:pub-1");
    const card = JSON.parse(api.calls[0]!.args[3] as string);
    expect(card.body.elements[0]).toMatchObject({ tag: "table", rows: [{ c0: "华东", c1: "100" }] });
    expect(JSON.stringify(card)).toContain("口径按字面解释。");
  });

  it("previews a CSV result and attaches the whole file, read only through the core", async () => {
    const { api, channel } = await started();
    const csv = ["区域,销售额", ...Array.from({ length: 30 }, (_value, index) => `r${index},${index}`)].join("\n");
    await channel.deliver(toChat(direct), publication("csv"), "publication:pub-1", { readPublication: async () => csv });
    expect(api.calls.map((call) => call.op)).toEqual(["send", "upload", "send"]);
    expect(JSON.parse(api.calls[0]!.args[3] as string).body.elements[0].rows).toHaveLength(10);
    const [fileName, data] = api.calls[1]!.args as [string, Buffer];
    expect(fileName).toBe("pub-1.csv");
    expect(data.toString("utf8")).toBe(`﻿${csv}`);
    expect(api.calls[2]!.args.slice(2, 4)).toEqual(["file", JSON.stringify({ file_key: "file_key_1" })]);
    expect(api.calls[2]!.args[4]).not.toBe(api.calls[0]!.args[4]);
  });

  it("sends a dashboard as a picture to look at and the page to open", async () => {
    const { api, channel } = await started();
    const page = new TextEncoder().encode("<!doctype html><title>看板</title>");
    const png = new Uint8Array([137, 80, 78, 71]);
    await channel.deliver(toChat(direct), dashboard, "dashboard:h1", { readDashboard: async () => page, snapshotDashboard: async () => png });
    expect(api.calls.map((call) => call.op)).toEqual(["uploadImage", "send", "upload", "send"]);
    expect(Array.from(api.calls[0]!.args[0] as Buffer)).toEqual(Array.from(png));
    expect(api.calls[1]!.args.slice(2, 4)).toEqual(["image", JSON.stringify({ image_key: "img_key_1" })]);
    expect(api.calls[2]!.args[0]).toBe("sales.html");
    expect(api.calls[3]!.args.slice(2, 4)).toEqual(["file", JSON.stringify({ file_key: "file_key_1" })]);
    expect(api.calls[1]!.args[4]).not.toBe(api.calls[3]!.args[4]);
  });

  it("still sends the page when the host cannot render a picture", async () => {
    const errors: unknown[] = [];
    const { api, channel } = await started((error) => errors.push(error));
    await channel.deliver(toChat(direct), dashboard, "dashboard:h1", { readDashboard: async () => new Uint8Array([60]), snapshotDashboard: async () => { throw new Error("DASHBOARD_SNAPSHOT_NO_BROWSER"); } });
    expect(api.calls.map((call) => call.op)).toEqual(["upload", "send"]);
    expect(String(errors[0])).toContain("DASHBOARD_SNAPSHOT_NO_BROWSER");
  });

  it("posts one progress card per run and patches it until the run completes", async () => {
    const { api, channel } = await started();
    const target = toChat(direct);
    await channel.progress(target, { state: "running", runId: "run-1", text: "正在", activeTool: "query_database" });
    await channel.progress(target, { state: "running", runId: "run-1", text: "正在查询" });
    await channel.progress(target, { state: "completed", runId: "run-1", text: "上月销售额 100 万。" });
    await channel.progress(target, { state: "running", runId: "run-2", text: "" });
    expect(api.calls.map((call) => call.op)).toEqual(["send", "patch", "patch", "send"]);
    expect(api.calls[1]!.args[0]).toBe("om_sent_1");
    expect(JSON.parse(api.calls[2]!.args[1] as string).body.elements).toEqual([{ tag: "markdown", content: "上月销售额 100 万。" }]);
  });
});

describe("Feishu access requests", () => {
  it("asks a member with the requester's name, what they sent, and allow/deny buttons", async () => {
    const { api, channel } = await started();
    const member: DeliveryTarget = { kind: "actor", actor: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_admin" } };
    await channel.deliver(member, { kind: "access_request", requestId: "req-1", requester: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_carol" }, audience: "group", text: "上月\n销售额" }, "access:req-1:ou_admin");
    const [receiveType, receiveId, msgType, content] = api.calls[0]!.args as string[];
    expect([receiveType, receiveId, msgType]).toEqual(["open_id", "ou_admin", "interactive"]);
    const elements = JSON.parse(content!).body.elements;
    expect(elements[0].content).toBe("<at id=ou_carol></at> 在群聊中请求使用数据助手。\n\n他发送的内容：上月 销售额");
    expect(elements.filter((element: { tag: string }) => element.tag === "button").map((button: { behaviors: { value: unknown }[] }) => button.behaviors[0]!.value)).toEqual([
      { kind: "access", requestId: "req-1", decision: "allow" },
      { kind: "access", requestId: "req-1", decision: "deny" },
    ]);
  });

  it("turns a click into the member's decision and closes the card", async () => {
    const { events, received } = await started();
    const response = await events.cardAction({ event_id: "evt-7", tenant_key: "tenant-1", operator: { open_id: "ou_admin" }, context: { open_chat_id: "oc_admin" }, action: { value: { kind: "access", requestId: "req-1", decision: "deny" } } });
    expect(response).toMatchObject({ toast: { type: "success" }, card: { type: "raw", data: { body: { elements: [{ content: "已提交：**拒绝**" }] } } } });
    await tick();
    expect(received).toEqual([{ requestId: "evt-7", address: { channel: "feishu", tenant: "tenant-1", chatId: "oc_admin", audience: "direct" }, actor: { channel: "feishu", tenant: "tenant-1", externalUserId: "ou_admin" }, body: { kind: "access_decision", requestId: "req-1", decision: "deny" } }]);
    expect(cardActionSubmission({ event_id: "e", tenant_key: "t", operator: { open_id: "o" }, context: { open_chat_id: "c" }, action: { value: { kind: "access", requestId: "r", decision: "maybe" } } })).toBeUndefined();
  });
});

