import { createHash, randomBytes } from "node:crypto";

/**
 * The iLink bot protocol behind WeChat ClawBot: JSON over HTTPS, long polling
 * for inbound messages. It follows the protocol of Tencent's own client,
 * @tencent-weixin/openclaw-weixin (MIT), and identifies itself as yourdb.
 */
export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
/** The protocol revision this client follows, sent the way the reference client sends its own. */
const PROTOCOL_VERSION = "2.4.10";
const APP_ID = "bot";
const BOT_AGENT = "yourdb/0.1.0";
/** The server holds an empty poll this long, and may ask for another value. */
export const LONG_POLL_MS = 35_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** The server's answer when the bot token is no longer valid; scanning again is the only way back. */
export const STALE_TOKEN = -14;

export const MessageType = { USER: 1, BOT: 2 } as const;
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageState = { FINISH: 2 } as const;

export interface WeixinItem {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
  readonly voice_item?: { readonly text?: string };
}

export interface WeixinMessage {
  readonly seq?: number;
  readonly message_id?: string;
  readonly from_user_id?: string;
  readonly to_user_id?: string;
  readonly create_time_ms?: number;
  readonly message_type?: number;
  readonly item_list?: readonly WeixinItem[];
  /** Replies to this sender carry it; it changes as the conversation goes. */
  readonly context_token?: string;
}

export interface Updates {
  readonly ret?: number;
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly WeixinMessage[];
  readonly get_updates_buf?: string;
  readonly longpolling_timeout_ms?: number;
}

export interface QrCode {
  readonly qrcode: string;
  /** What the QR code encodes; opened in WeChat it starts the connection. */
  readonly qrcode_img_content: string;
}

export interface QrStatus {
  readonly status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect" | string;
  readonly bot_token?: string;
  readonly ilink_bot_id?: string;
  /** The WeChat user who scanned. */
  readonly ilink_user_id?: string;
  readonly baseurl?: string;
  readonly redirect_host?: string;
}

/** A logged-in bot: its token, its id, and the host that serves it. */
export interface WeixinCredentials {
  readonly token: string;
  readonly botId: string;
  readonly baseUrl: string;
}

/** The calls the channel makes; replaced in tests. */
export interface WeixinApi {
  getUpdates(cursor: string, timeoutMs: number, signal: AbortSignal): Promise<Updates>;
  sendText(toUserId: string, text: string, clientId: string, contextToken: string | undefined): Promise<void>;
}

/** The calls scan-to-connect makes; replaced in tests. */
export interface WeixinLoginApi {
  qrCode(): Promise<QrCode>;
  /** Long-polls; returns `wait` when the server has nothing new. */
  qrStatus(baseUrl: string, qrcode: string, signal: AbortSignal): Promise<QrStatus>;
}

/** uint32 encoded as 0x00MMNNPP, as the reference client does. */
function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const baseInfo = () => ({ channel_version: PROTOCOL_VERSION, bot_agent: BOT_AGENT });

function headers(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": String(clientVersion(PROTOCOL_VERSION)),
    AuthorizationType: "ilink_bot_token",
    // A random uint32, as decimal text, in base64.
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Message ids are uint64; quoted before parsing so they survive as strings. */
export function parseJson<T>(text: string): T {
  return JSON.parse(text.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, "\"$1\":\"$2\"")) as T;
}

async function call<T>(url: string, init: { method: "GET" | "POST"; token?: string; body?: unknown; timeoutMs: number; signal?: AbortSignal }): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(url, {
    method: init.method,
    headers: init.method === "GET" ? { "iLink-App-Id": APP_ID, "iLink-App-ClientVersion": String(clientVersion(PROTOCOL_VERSION)) } : headers(init.token),
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`WEIXIN_HTTP_${response.status}: ${text.slice(0, 200)}`);
  return parseJson<T>(text);
}

const endpoint = (baseUrl: string, path: string) => new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

/** True when the request ended because its own time ran out, not because of an error. */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

export function createWeixinApi(credentials: WeixinCredentials): WeixinApi {
  return {
    async getUpdates(cursor, timeoutMs, signal) {
      try {
        return await call<Updates>(endpoint(credentials.baseUrl, "ilink/bot/getupdates"), { method: "POST", token: credentials.token, body: { get_updates_buf: cursor, base_info: baseInfo() }, timeoutMs, signal });
      } catch (error) {
        // An empty long poll ends on our side; that is the normal "nothing new".
        if (isTimeout(error) && !signal.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
        throw error;
      }
    },
    async sendText(toUserId, text, clientId, contextToken) {
      const result = await call<{ ret?: number; errmsg?: string }>(endpoint(credentials.baseUrl, "ilink/bot/sendmessage"), {
        method: "POST",
        token: credentials.token,
        timeoutMs: REQUEST_TIMEOUT_MS,
        body: {
          msg: {
            from_user_id: "",
            to_user_id: toUserId,
            client_id: clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [{ type: ItemType.TEXT, text_item: { text } }],
            ...(contextToken ? { context_token: contextToken } : {}),
          },
          base_info: baseInfo(),
        },
      });
      if (result.ret !== undefined && result.ret !== 0) throw new Error(`WEIXIN_SEND_FAILED: ${result.ret} ${result.errmsg ?? ""}`.trim());
    },
  };
}

export function createWeixinLoginApi(): WeixinLoginApi {
  return {
    qrCode: () => call<QrCode>(endpoint(ILINK_BASE_URL, "ilink/bot/get_bot_qrcode?bot_type=3"), { method: "POST", body: { local_token_list: [] }, timeoutMs: REQUEST_TIMEOUT_MS }),
    async qrStatus(baseUrl, qrcode, signal) {
      try {
        return await call<QrStatus>(endpoint(baseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`), { method: "GET", timeoutMs: LONG_POLL_MS, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        // A poll that timed out, or a gateway hiccup, means nothing happened yet.
        return { status: "wait" };
      }
    },
  };
}

/** The same key always gives the same client id, so a resent piece is recognisable. */
export function clientId(key: string): string {
  return `yourdb-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}
