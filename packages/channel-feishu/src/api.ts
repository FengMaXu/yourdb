import * as Lark from "@larksuiteoapi/node-sdk";

/** The Feishu operations the channel uses. Everything platform-specific stays behind this port. */
export interface FeishuApi {
  botOpenId(): Promise<string | undefined>;
  /** Sends a new message; `uuid` makes a repeat within an hour a no-op on Feishu's side. */
  send(receiveIdType: "chat_id" | "open_id", receiveId: string, msgType: string, content: string, uuid: string): Promise<string>;
  reply(messageId: string, msgType: string, content: string, uuid: string, inThread: boolean): Promise<string>;
  patchCard(messageId: string, card: string): Promise<void>;
  uploadFile(fileName: string, data: Buffer): Promise<string>;
  uploadImage(data: Buffer): Promise<string>;
}

/** Inbound events as the SDK hands them over: header and event fields merged into one object. */
export type FeishuEventHandler = (data: Record<string, unknown>) => Promise<unknown>;

export interface FeishuEvents {
  connect(handlers: { readonly message: FeishuEventHandler; readonly cardAction: FeishuEventHandler }): Promise<void>;
  disconnect(): Promise<void>;
}

export interface FeishuCredentials {
  readonly appId: string;
  readonly appSecret: string;
  /** `Lark.Domain.Feishu` (default) or `Lark.Domain.Lark`. */
  readonly domain?: Lark.Domain | string;
}

/** Throws on a Feishu answer whose code is set and not 0; otherwise returns it. */
export function checked<T extends { code?: number; msg?: string } | null | undefined>(response: T, operation: string): T {
  if (response?.code !== undefined && response.code !== 0) throw new Error(`FEISHU_${operation}_FAILED: ${response.code} ${response.msg ?? ""}`.trim());
  return response;
}

export function createLarkApi(credentials: FeishuCredentials): FeishuApi {
  const client = new Lark.Client({ appId: credentials.appId, appSecret: credentials.appSecret, ...(credentials.domain ? { domain: credentials.domain } : {}) });
  return {
    async botOpenId() {
      const response = await client.request<{ bot?: { open_id?: string } }>({ url: "/open-apis/bot/v3/info", method: "GET" });
      return response.bot?.open_id;
    },
    async send(receiveIdType, receiveId, msgType, content, uuid) {
      const response = checked(await client.im.v1.message.create({ params: { receive_id_type: receiveIdType }, data: { receive_id: receiveId, msg_type: msgType, content, uuid } }), "SEND");
      const messageId = response.data?.message_id;
      if (!messageId) throw new Error("FEISHU_SEND_FAILED: no message_id");
      return messageId;
    },
    async reply(messageId, msgType, content, uuid, inThread) {
      const response = checked(await client.im.v1.message.reply({ path: { message_id: messageId }, data: { msg_type: msgType, content, uuid, reply_in_thread: inThread } }), "REPLY");
      const replied = response.data?.message_id;
      if (!replied) throw new Error("FEISHU_REPLY_FAILED: no message_id");
      return replied;
    },
    async patchCard(messageId, card) {
      checked(await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: card } }), "PATCH");
    },
    async uploadFile(fileName, data) {
      const response = await client.im.v1.file.create({ data: { file_type: "stream", file_name: fileName, file: data } });
      if (!response?.file_key) throw new Error("FEISHU_UPLOAD_FAILED: no file_key");
      return response.file_key;
    },
    async uploadImage(data) {
      const response = await client.im.v1.image.create({ data: { image_type: "message", image: data } });
      if (!response?.image_key) throw new Error("FEISHU_UPLOAD_FAILED: no image_key");
      return response.image_key;
    },
  };
}

/**
 * Long connection: no public address needed. Feishu pushes each event to one
 * connected client of the app, and redelivers when no answer comes within 3 s.
 */
export function createLarkEvents(credentials: FeishuCredentials): FeishuEvents {
  let client: Lark.WSClient | undefined;
  return {
    async connect(handlers) {
      client = new Lark.WSClient({ appId: credentials.appId, appSecret: credentials.appSecret, ...(credentials.domain ? { domain: credentials.domain } : {}), loggerLevel: Lark.LoggerLevel.warn });
      const dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data: unknown) => handlers.message(data as Record<string, unknown>),
        "card.action.trigger": (data: unknown) => handlers.cardAction(data as Record<string, unknown>),
      } as never);
      await client.start({ eventDispatcher: dispatcher });
    },
    async disconnect() {
      client?.close();
      client = undefined;
    },
  };
}
