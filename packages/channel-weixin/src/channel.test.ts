import { afterEach, describe, expect, it } from "vitest";
import type { Submission } from "@data-agent/contracts";
import type { Updates, WeixinApi, WeixinMessage } from "./api.js";
import { WeixinChannel } from "./channel.js";

const NOW = 1_000_000_000;

function text(id: string, from: string, body: string, extra: Partial<WeixinMessage> = {}): WeixinMessage {
  return { message_id: id, from_user_id: from, create_time_ms: NOW, message_type: 1, item_list: [{ type: 1, text_item: { text: body } }], context_token: `ctx-${id}`, ...extra };
}

/** Hands out queued poll results, then holds the poll open until stopped, as the server does. */
function fakeApi(batches: (Updates | Error)[]) {
  const sent: { to: string; text: string; clientId: string; contextToken?: string }[] = [];
  const cursors: string[] = [];
  const api: WeixinApi = {
    async getUpdates(cursor, _timeoutMs, signal) {
      cursors.push(cursor);
      const next = batches.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ ret: 0, msgs: [] }), { once: true }));
    },
    async sendText(to, body, clientId, contextToken) {
      sent.push({ to, text: body, clientId, ...(contextToken ? { contextToken } : {}) });
    },
  };
  return { api, sent, cursors };
}

/** Waits for the poll loop to get somewhere, without guessing how long it takes. */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

const channels: WeixinChannel[] = [];
afterEach(async () => { await Promise.all(channels.splice(0).map((channel) => channel.stop())); });

async function started(batches: (Updates | Error)[], errors: unknown[] = []) {
  const queued = batches.length;
  const fake = fakeApi(batches);
  const received: Submission[] = [];
  const channel = new WeixinChannel({ api: fake.api, botId: "bot-1", now: () => NOW, onError: (error) => errors.push(error), retryMs: { short: 0, long: 0, staleToken: 0 } });
  channels.push(channel);
  await channel.start(async (submission) => { received.push(submission); });
  // The loop asks again only after it has handled the previous answer.
  await until(() => fake.cursors.length > queued);
  return { channel, received, ...fake };
}

describe("WeChat channel", () => {
  it("turns a private message into a Submission from that person, and follows the server's cursor", async () => {
    const { received, cursors } = await started([{ ret: 0, msgs: [text("m-1", "wx-alice", "上月销售额")], get_updates_buf: "c-1" }]);
    expect(received).toEqual([{
      requestId: "m-1",
      address: { channel: "weixin", tenant: "bot-1", chatId: "wx-alice", audience: "direct" },
      actor: { channel: "weixin", tenant: "bot-1", externalUserId: "wx-alice" },
      body: { kind: "input", text: "上月销售额", whenBusy: "follow_up" },
    }]);
    expect(cursors.slice(0, 2)).toEqual(["", "c-1"]);
  });

  it("ignores its own messages and ones sent before it started, and says it reads only text", async () => {
    const { received, sent } = await started([{ ret: 0, msgs: [
      text("m-1", "wx-alice", "旧消息", { create_time_ms: NOW - 10 * 60_000 }),
      text("m-2", "wx-alice", "机器人自己", { message_type: 2 }),
      { message_id: "m-3", from_user_id: "wx-alice", create_time_ms: NOW, message_type: 1, item_list: [{ type: 2 }] },
    ] }]);
    expect(received).toEqual([]);
    expect(sent.map((item) => item.text)).toEqual(["暂时只能处理文字消息，请用文字提问。"]);
  });

  it("replies with the person's newest context token, and sends a delivery only once", async () => {
    const { channel, sent } = await started([{ ret: 0, msgs: [text("m-1", "wx-alice", "你好"), text("m-2", "wx-alice", "在吗")] }]);
    const target = { kind: "address" as const, address: { channel: "weixin", tenant: "bot-1", chatId: "wx-alice", audience: "direct" as const } };
    const notice = { kind: "notice" as const, code: "ACCESS_GRANTED" as const, text: "可以用了" };
    await channel.deliver(target, notice, "k-1");
    await channel.deliver(target, notice, "k-1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "wx-alice", text: "可以用了", contextToken: "ctx-m-2" });
  });

  it("takes the reply to an open question as its answer, a number picking an option", async () => {
    const fake = fakeApi([]);
    const received: Submission[] = [];
    let push!: (updates: Updates) => void;
    fake.api.getUpdates = (_cursor, _timeout, signal) => new Promise((resolve) => {
      push = resolve;
      signal.addEventListener("abort", () => resolve({ ret: 0 }), { once: true });
    });
    const channel = new WeixinChannel({ api: fake.api, botId: "bot-1", now: () => NOW });
    channels.push(channel);
    await channel.start(async (submission) => { received.push(submission); });
    const target = { kind: "address" as const, address: { channel: "weixin", tenant: "bot-1", chatId: "wx-alice", audience: "direct" as const } };
    await channel.deliver(target, { kind: "question", clarificationId: "q-1", question: "统计哪种订单？", options: ["已支付", "全部"] }, "question:q-1");
    expect(fake.sent[0]!.text).toContain("1. 已支付");
    push({ ret: 0, msgs: [text("m-1", "wx-alice", "2")] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received[0]!.body).toEqual({ kind: "answer", clarificationId: "q-1", text: "全部" });
    push({ ret: 0, msgs: [text("m-2", "wx-alice", "再按月拆分")] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received[1]!.body).toMatchObject({ kind: "input", text: "再按月拆分" });
  });

  it("sends only the finished answer, as plain text", async () => {
    const { channel, sent } = await started([]);
    const target = { kind: "actor" as const, actor: { channel: "weixin", tenant: "bot-1", externalUserId: "wx-alice" } };
    await channel.progress(target, { state: "running", text: "正在查", runId: "run-1" });
    await channel.progress(target, { state: "completed", text: "**华东**最高。", runId: "run-1" });
    expect(sent.map((item) => item.text)).toEqual(["华东最高。"]);
  });

  it("writes a CSV result from the published file and a dashboard as a pointer to the computer", async () => {
    const { channel, sent } = await started([]);
    const target = { kind: "actor" as const, actor: { channel: "weixin", tenant: "bot-1", externalUserId: "wx-alice" } };
    await channel.deliver(target, { kind: "publication", publication: { type: "publication.delivered", receiptId: "r-1", taskId: "t-1", format: "csv", publicRef: "/x" } }, "publication:r-1", { readPublication: async () => "区域,销售额\n华东,100" });
    await channel.deliver(target, { kind: "dashboard", dashboard: { path: "dashboards/overview.html", contentHash: "h", receiptIds: [] } }, "dashboard:h");
    expect(sent[0]!.text).toContain("华东 | 100");
    expect(sent[1]!.text).toContain("overview.html");
  });

  it("keeps polling after failures, and reports a login that WeChat ended", async () => {
    const errors: unknown[] = [];
    const { received } = await started([new Error("network"), { ret: -14, errmsg: "session timeout" }, { ret: 0, msgs: [text("m-1", "wx-alice", "还在吗")] }], errors);
    expect(received).toHaveLength(1);
    expect(errors.map(String)).toEqual([expect.stringContaining("network"), expect.stringContaining("WEIXIN_TOKEN_STALE")]);
  });
});
