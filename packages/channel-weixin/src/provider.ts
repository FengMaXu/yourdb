import type { ChannelConfig, ChannelProvider, ChannelProvisioning } from "@data-agent/contracts";
import { createWeixinApi, createWeixinLoginApi, ILINK_BASE_URL, type WeixinCredentials, type WeixinLoginApi } from "./api.js";
import { WeixinChannel } from "./channel.js";
import { WEIXIN_CHANNEL_ID } from "./inbound.js";

/** How long a QR code is shown before WeChat stops accepting it. */
const QR_TTL_MS = 5 * 60_000;
const POLL_PAUSE_MS = 1_000;

/** A failure the settings page can say plainly. */
function refused(description: string, code?: string): Error {
  return Object.assign(new Error(description), { description, ...(code ? { code } : {}) });
}

function credentials(config: ChannelConfig): WeixinCredentials {
  const { token, botId, baseUrl } = config;
  if (typeof token !== "string" || !token || typeof botId !== "string" || !botId) throw new Error("WEIXIN_CONFIG_INVALID");
  return { token, botId, baseUrl: typeof baseUrl === "string" && baseUrl ? baseUrl : ILINK_BASE_URL };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error("aborted"), { code: "abort" }));
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { code: "abort" })); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Personal WeChat (ClawBot) for the channel registry. Scanning logs a bot in
 * on the scanner's WeChat; the scanner is who the bot talks to, and owns it.
 */
export function weixinProvider(options: { readonly onError?: (error: unknown) => void; readonly login?: WeixinLoginApi; readonly pauseMs?: number } = {}): ChannelProvider {
  const login = options.login ?? createWeixinLoginApi();
  const pauseMs = options.pauseMs ?? POLL_PAUSE_MS;
  return {
    id: WEIXIN_CHANNEL_ID,
    label: "微信",
    create(config) {
      const app = credentials(config);
      return new WeixinChannel({ api: createWeixinApi(app), botId: app.botId, ...(options.onError ? { onError: options.onError } : {}) });
    },
    provision(signal): ChannelProvisioning {
      let announce!: (link: { url: string; expiresAt: number }) => void;
      const ready = new Promise<{ url: string; expiresAt: number }>((resolve) => { announce = resolve; });
      const done = (async () => {
        const code = await login.qrCode();
        if (!code.qrcode || !code.qrcode_img_content) throw refused("微信没有返回二维码，请稍后重试。");
        const expiresAt = Date.now() + QR_TTL_MS;
        announce({ url: code.qrcode_img_content, expiresAt });
        let baseUrl = ILINK_BASE_URL;
        while (Date.now() < expiresAt) {
          if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "abort" });
          const status = await login.qrStatus(baseUrl, code.qrcode, signal);
          if (status.status === "confirmed") {
            if (!status.bot_token || !status.ilink_bot_id) throw refused("微信确认了登录，但没有返回机器人凭证，请重新扫码。");
            const config: ChannelConfig = { token: status.bot_token, botId: status.ilink_bot_id, baseUrl: status.baseurl || ILINK_BASE_URL };
            return { config, warnings: [], ...(status.ilink_user_id ? { owner: { externalUserId: status.ilink_user_id } } : {}) };
          }
          if (status.status === "expired") throw refused("二维码已过期，请重新扫码。", "expired_token");
          if (status.status === "scaned_but_redirect" && status.redirect_host) baseUrl = `https://${status.redirect_host}`;
          if (status.status === "binded_redirect") throw refused("这个微信已经连接过一个机器人。请先在微信里断开原来的连接，再重新扫码。");
          if (status.status === "need_verifycode" || status.status === "verify_code_blocked") throw refused("微信要求输入手机上显示的数字，目前还不支持这一步。请稍后重新扫码。");
          await pause(pauseMs, signal);
        }
        throw refused("二维码已过期，请重新扫码。", "expired_token");
      })();
      // A flow that fails before the link exists must not leave `ready` waiting forever.
      return { ready: Promise.race([ready, done.then(() => { throw new Error("WEIXIN_PROVISION_NO_LINK"); })]), done };
    },
  };
}
