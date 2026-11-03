import * as Lark from "@larksuiteoapi/node-sdk";
import type { ChannelConfig, ChannelProvider, ChannelProvisioning } from "@data-agent/contracts";
import { createLarkApi, createLarkEvents, type FeishuCredentials } from "./api.js";
import { FeishuChannel } from "./channel.js";
import { FEISHU_CHANNEL_ID } from "./inbound.js";

const LARK_OPEN_DOMAIN = "https://open.larksuite.com";

/** What the bot needs: read what people send it, answer as itself, send pictures and files, and set itself up. */
const SCOPES = [
  "im:message",
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:resource",
  "application:application:patch",
];
const EVENTS = ["im.message.receive_v1"];
const CALLBACKS = ["card.action.trigger"];

/** The platform calls behind scan-to-connect; replaced in tests. */
export interface FeishuSetupApi {
  registerApp: typeof Lark.registerApp;
  /** Switches events and callbacks to the long connection and publishes the change. */
  useLongConnection(credentials: FeishuCredentials): Promise<void>;
}

function credentials(config: ChannelConfig): FeishuCredentials {
  const { appId, appSecret, domain } = config;
  if (typeof appId !== "string" || !appId || typeof appSecret !== "string" || !appSecret) throw new Error("FEISHU_CONFIG_INVALID");
  return { appId, appSecret, ...(typeof domain === "string" && domain ? { domain } : {}) };
}

function checked(response: { code?: number; msg?: string } | null | undefined, operation: string): void {
  if (response?.code !== undefined && response.code !== 0) throw new Error(`FEISHU_${operation}_FAILED: ${response.code} ${response.msg ?? ""}`.trim());
}

/** The SDK throws the HTTP error for a non-2xx answer; Feishu's own code and message are in its body. */
async function step<T extends { code?: number; msg?: string } | null | undefined>(operation: string, call: () => Promise<T>): Promise<void> {
  let response: T;
  try {
    response = await call();
  } catch (error) {
    const body = (error as { response?: { status?: number; data?: { code?: number; msg?: string } } }).response;
    if (body?.data?.code !== undefined) checked(body.data, operation);
    throw new Error(`FEISHU_${operation}_FAILED: ${body?.status ?? ""} ${error instanceof Error ? error.message : String(error)}`.replace(/\s+/g, " ").trim(), { cause: error });
  }
  checked(response, operation);
}

const STEP_LABEL: Record<string, string> = { CONFIG: "设置订阅方式时", PUBLISH: "发布版本时" };

/** Which step Feishu refused and what it said, short enough for the settings page. */
function detail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^FEISHU_([A-Z]+)_FAILED:\s*/.exec(message);
  const label = match ? STEP_LABEL[match[1]!] : undefined;
  return `${label ?? ""}${match ? message.slice(match[0].length) : message}`.slice(0, 200);
}

/** Waits, unless the flow is cancelled first. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** A new app's permissions take a moment to apply, so the switch is tried again before asking the user. */
const LONG_CONNECTION_RETRY_MS = [1_000, 2_000, 4_000];

const larkSetup: FeishuSetupApi = {
  registerApp: Lark.registerApp,
  async useLongConnection(app) {
    const client = new Lark.Client({ appId: app.appId, appSecret: app.appSecret, ...(app.domain ? { domain: app.domain } : {}) });
    await step("CONFIG", () => client.application.v7.applicationConfig.patch({
      path: { app_id: app.appId },
      data: {
        event: { subscription_type: "websocket", add_events: EVENTS },
        callback: { callback_type: "websocket", add_callbacks: CALLBACKS },
      },
    }));
    await step("PUBLISH", () => client.application.v7.applicationPublish.create({
      path: { app_id: app.appId },
      // An app with the bot ability must name a default ability for each end, or Feishu answers 210304.
      data: { mobile_default_ability: "bot", pc_default_ability: "bot", remark: "数据智能体接入", changelog: "使用长连接接收消息与卡片回调" },
    }));
  },
};

/**
 * Feishu for the channel registry. Scan-to-connect creates the bot through
 * Feishu's device flow with the permissions, events and callback it needs.
 * Feishu does not let that flow choose the long connection, so it is set
 * afterwards, a few times since a new app's permissions take a moment; when
 * Feishu still refuses, the user gets the one step left and Feishu's reason.
 */
export function feishuProvider(options: { readonly onError?: (error: unknown) => void; readonly setup?: FeishuSetupApi; readonly retryDelaysMs?: readonly number[] } = {}): ChannelProvider {
  const setup = options.setup ?? larkSetup;
  const retryDelaysMs = options.retryDelaysMs ?? LONG_CONNECTION_RETRY_MS;
  return {
    id: FEISHU_CHANNEL_ID,
    label: "飞书",
    create(config) {
      const app = credentials(config);
      return new FeishuChannel({ api: createLarkApi(app), events: createLarkEvents(app), ...(options.onError ? { onError: options.onError } : {}) });
    },
    provision(signal): ChannelProvisioning {
      let announce!: (link: { url: string; expiresAt: number }) => void;
      const ready = new Promise<{ url: string; expiresAt: number }>((resolve) => { announce = resolve; });
      const done = (async () => {
        const result = await setup.registerApp({
          signal,
          source: "data-agent",
          createOnly: true,
          appPreset: { name: "{user}的数据助手", desc: "在飞书里查询数据、生成看板" },
          addons: { scopes: { tenant: SCOPES }, events: { items: { tenant: EVENTS } }, callbacks: { items: CALLBACKS } },
          onQRCodeReady: (info) => announce({ url: info.url, expiresAt: Date.now() + info.expireIn * 1000 }),
        });
        const app: FeishuCredentials = { appId: result.client_id, appSecret: result.client_secret, ...(result.user_info?.tenant_brand === "lark" ? { domain: LARK_OPEN_DOMAIN } : {}) };
        const warnings: string[] = [];
        for (let attempt = 0; ; attempt += 1) {
          try {
            await setup.useLongConnection(app);
            break;
          } catch (error) {
            options.onError?.(error);
            const delay = retryDelaysMs[attempt];
            if (delay !== undefined && !signal.aborted) {
              await pause(delay, signal);
              continue;
            }
            const console = app.domain === LARK_OPEN_DOMAIN ? "https://open.larksuite.com/app" : "https://open.feishu.cn/app";
            warnings.push(`飞书没有允许自动设置长连接（飞书返回：${detail(error)}）。请打开 ${console}/${app.appId}/event ，把“事件配置”和“回调配置”的订阅方式都改为“使用长连接接收”，然后发布新版本。`);
            break;
          }
        }
        return { config: { ...app } as ChannelConfig, warnings };
      })();
      // A flow that fails before the link exists must not leave `ready` waiting forever.
      return { ready: Promise.race([ready, done.then(() => { throw new Error("FEISHU_PROVISION_NO_LINK"); })]), done };
    },
  };
}
