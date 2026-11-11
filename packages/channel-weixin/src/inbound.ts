import type { Submission } from "@data-agent/contracts";
import { ItemType, MessageType, type WeixinMessage } from "./api.js";

export const WEIXIN_CHANNEL_ID = "weixin";

export interface InboundMessage {
  readonly submission: Submission;
  /** For replies to this sender. */
  readonly contextToken?: string;
}

/** What the person wrote: text, or what WeChat heard in a voice message. */
export function messageText(message: WeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === ItemType.TEXT && item.text_item?.text) return item.text_item.text.trim();
    if (item.type === ItemType.VOICE && item.voice_item?.text) return item.voice_item.text.trim();
  }
  return "";
}

/**
 * A ClawBot conversation is always private: the bot belongs to one WeChat
 * login (`botId`), and every sender is a direct chat with it. The sender's
 * id is the one the bot sees, and it is what replies are addressed to.
 */
export function messageSubmission(message: WeixinMessage, botId: string): InboundMessage | undefined {
  if (message.message_type === MessageType.BOT) return undefined;
  const from = message.from_user_id?.trim();
  const text = messageText(message);
  if (!from || !text) return undefined;
  const requestId = message.message_id?.trim() || `${from}:${message.create_time_ms ?? ""}:${message.seq ?? ""}`;
  return {
    submission: {
      requestId,
      address: { channel: WEIXIN_CHANNEL_ID, tenant: botId, chatId: from, audience: "direct" },
      actor: { channel: WEIXIN_CHANNEL_ID, tenant: botId, externalUserId: from },
      body: { kind: "input", text, whenBusy: "follow_up" },
    },
    ...(message.context_token ? { contextToken: message.context_token } : {}),
  };
}
