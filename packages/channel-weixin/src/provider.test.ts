import { describe, expect, it } from "vitest";
import type { QrStatus, WeixinLoginApi } from "./api.js";
import { parseJson } from "./api.js";
import { weixinProvider } from "./provider.js";

function fakeLogin(statuses: QrStatus[]) {
  const polled: string[] = [];
  const login: WeixinLoginApi = {
    async qrCode() { return { qrcode: "qr-1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc" }; },
    async qrStatus(baseUrl) {
      polled.push(baseUrl);
      return statuses.shift() ?? { status: "wait" };
    },
  };
  return { login, polled };
}

describe("WeChat scan-to-connect", () => {
  it("shows the link, follows WeChat's redirect, and yields the bot with whoever scanned as its owner", async () => {
    const { login, polled } = fakeLogin([
      { status: "wait" },
      { status: "scaned_but_redirect", redirect_host: "sh.ilinkai.weixin.qq.com" },
      { status: "confirmed", bot_token: "token-1", ilink_bot_id: "bot-1", ilink_user_id: "wx-me", baseurl: "https://ilinkai.weixin.qq.com" },
    ]);
    const flow = weixinProvider({ login, pauseMs: 0 }).provision!(new AbortController().signal);
    const link = await flow.ready;
    expect(link.url).toBe("https://liteapp.weixin.qq.com/q/abc");
    expect(link.expiresAt).toBeGreaterThan(Date.now());
    await expect(flow.done).resolves.toEqual({ config: { token: "token-1", botId: "bot-1", baseUrl: "https://ilinkai.weixin.qq.com" }, warnings: [], owner: { externalUserId: "wx-me" } });
    expect(polled).toEqual(["https://ilinkai.weixin.qq.com", "https://ilinkai.weixin.qq.com", "https://sh.ilinkai.weixin.qq.com"]);
  });

  it("says plainly why a scan did not connect", async () => {
    const expired = weixinProvider({ login: fakeLogin([{ status: "expired" }]).login, pauseMs: 0 }).provision!(new AbortController().signal);
    await expect(expired.done).rejects.toMatchObject({ code: "expired_token" });
    const verify = weixinProvider({ login: fakeLogin([{ status: "need_verifycode" }]).login, pauseMs: 0 }).provision!(new AbortController().signal);
    await expect(verify.done).rejects.toMatchObject({ description: expect.stringContaining("还不支持") });
  });

  it("stops when the scan is cancelled", async () => {
    const abort = new AbortController();
    const flow = weixinProvider({ login: fakeLogin([]).login, pauseMs: 5 }).provision!(abort.signal);
    await flow.ready;
    abort.abort();
    await expect(flow.done).rejects.toMatchObject({ code: "abort" });
  });

  it("refuses to build a channel from incomplete configuration", () => {
    expect(() => weixinProvider().create({ token: "t" })).toThrow("WEIXIN_CONFIG_INVALID");
  });

  it("keeps uint64 message ids exact", () => {
    expect(parseJson<{ msgs: { message_id: string }[] }>("{\"msgs\":[{\"message_id\": 7351234567890123456}]}").msgs[0]!.message_id).toBe("7351234567890123456");
  });
});
