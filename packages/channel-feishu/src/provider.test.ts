import { describe, expect, it } from "vitest";
import type { FeishuSetupApi } from "./provider.js";
import { feishuProvider } from "./provider.js";

type RegisterOptions = Parameters<FeishuSetupApi["registerApp"]>[0];

function fakeSetup(options: { brand?: "feishu" | "lark"; refuseLongConnection?: boolean; refuseLongConnectionTimes?: number; failBeforeLink?: boolean } = {}) {
  const calls: { registered?: RegisterOptions; longConnection?: unknown; longConnectionAttempts: number } = { longConnectionAttempts: 0 };
  const setup: FeishuSetupApi = {
    async registerApp(registerOptions) {
      calls.registered = registerOptions;
      if (options.failBeforeLink) throw Object.assign(new Error("denied"), { code: "access_denied", description: "用户拒绝" });
      registerOptions.onQRCodeReady({ url: "https://accounts.feishu.cn/oauth/device?code=abc", expireIn: 600 });
      return { client_id: "cli_new", client_secret: "secret", user_info: { open_id: "ou_admin", tenant_brand: options.brand ?? "feishu" } };
    },
    async useLongConnection(app) {
      calls.longConnection = app;
      calls.longConnectionAttempts += 1;
      if (options.refuseLongConnection || calls.longConnectionAttempts <= (options.refuseLongConnectionTimes ?? 0)) throw new Error("FEISHU_CONFIG_FAILED: 99991672 no permission");
    },
  };
  return { setup, calls };
}

describe("Feishu scan-to-connect", () => {
  it("creates a new bot with what it needs, then switches it to the long connection", async () => {
    const { setup, calls } = fakeSetup();
    const flow = feishuProvider({ setup }).provision!(new AbortController().signal);
    const link = await flow.ready;
    expect(link.url).toContain("accounts.feishu.cn");
    expect(link.expiresAt).toBeGreaterThan(Date.now());
    // The scanner owns the bot, in the ids the new bot will see.
    await expect(flow.done).resolves.toEqual({ config: { appId: "cli_new", appSecret: "secret" }, warnings: [], owner: { externalUserId: "ou_admin" } });
    expect(calls.registered).toMatchObject({
      createOnly: true,
      addons: { events: { items: { tenant: ["im.message.receive_v1"] } }, callbacks: { items: ["card.action.trigger"] } },
    });
    expect(calls.registered!.addons!.scopes!.tenant).toEqual(expect.arrayContaining(["im:message:send_as_bot", "im:resource", "application:application:patch"]));
    expect(calls.longConnection).toEqual({ appId: "cli_new", appSecret: "secret" });
  });

  it("tries the long connection again while the new app's permissions apply", async () => {
    const errors: unknown[] = [];
    const { setup, calls } = fakeSetup({ refuseLongConnectionTimes: 2 });
    const { done } = feishuProvider({ setup, retryDelaysMs: [0, 0, 0], onError: (error) => errors.push(error) }).provision!(new AbortController().signal);
    await expect(done).resolves.toMatchObject({ config: { appId: "cli_new", appSecret: "secret" }, warnings: [] });
    expect(calls.longConnectionAttempts).toBe(3);
    expect(errors).toHaveLength(2);
  });

  it("keeps the bot and names the one step left, with Feishu's reason, when Feishu keeps refusing", async () => {
    const errors: unknown[] = [];
    const { setup, calls } = fakeSetup({ refuseLongConnection: true });
    const { done } = feishuProvider({ setup, retryDelaysMs: [0, 0], onError: (error) => errors.push(error) }).provision!(new AbortController().signal);
    const { config, warnings } = await done;
    expect(config).toEqual({ appId: "cli_new", appSecret: "secret" });
    expect(calls.longConnectionAttempts).toBe(3);
    expect(warnings).toEqual([expect.stringContaining("https://open.feishu.cn/app/cli_new/event")]);
    expect(warnings[0]).toContain("飞书返回：设置订阅方式时99991672 no permission");
    expect(String(errors[0])).toContain("99991672");
  });

  it("stops retrying when the flow is cancelled", async () => {
    const abort = new AbortController();
    const { setup, calls } = fakeSetup({ refuseLongConnection: true });
    const { done } = feishuProvider({ setup, retryDelaysMs: [60_000], onError: () => abort.abort(new Error("cancelled")) }).provision!(abort.signal);
    await done;
    expect(calls.longConnectionAttempts).toBe(1);
  });

  it("uses Lark's endpoints for a Lark tenant", async () => {
    const { setup } = fakeSetup({ brand: "lark" });
    const { done } = feishuProvider({ setup }).provision!(new AbortController().signal);
    await expect(done).resolves.toMatchObject({ config: { domain: "https://open.larksuite.com" } });
  });

  it("fails the link when the flow ends before showing one", async () => {
    const { setup } = fakeSetup({ failBeforeLink: true });
    const { ready, done } = feishuProvider({ setup }).provision!(new AbortController().signal);
    await expect(ready).rejects.toMatchObject({ code: "access_denied" });
    await expect(done).rejects.toMatchObject({ code: "access_denied" });
  });

  it("refuses to build a channel from incomplete configuration", () => {
    expect(() => feishuProvider().create({ appId: "cli_x" })).toThrow("FEISHU_CONFIG_INVALID");
  });
});
