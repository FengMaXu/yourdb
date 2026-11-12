import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

/**
 * Channel boundary (ADR-0011): an external platform enters only as a
 * Submission and leaves only as a Deliverable. Platform adapters depend on
 * these schemas, never on Runtime internals.
 */

const Id = Type.String({ minLength: 1, maxLength: 256 });

/** Where a conversation lives on a Channel, and who can see it there. */
export const ConversationAddressSchema = Type.Object({
  channel: Id,
  tenant: Id,
  chatId: Id,
  threadId: Type.Optional(Id),
  audience: Type.Union([Type.Literal("direct"), Type.Literal("group")]),
}, { additionalProperties: false });
export type ConversationAddress = Static<typeof ConversationAddressSchema>;

/** A sender the Channel has verified; identity never comes from message content. */
export const ChannelActorSchema = Type.Object({
  channel: Id,
  tenant: Id,
  externalUserId: Id,
  displayName: Type.Optional(Type.String({ maxLength: 256 })),
}, { additionalProperties: false });
export type ChannelActor = Static<typeof ChannelActorSchema>;

export const SubmissionBodySchema = Type.Union([
  Type.Object({ kind: Type.Literal("input"), text: Type.String({ minLength: 1 }), whenBusy: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("answer"), clarificationId: Id, text: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** The speaker asks to start over; earlier context is not carried into the next Session. */
  Type.Object({ kind: Type.Literal("new_conversation") }, { additionalProperties: false }),
  /** A member's decision on someone's request to use the bot, from an approval card. */
  Type.Object({ kind: Type.Literal("access_decision"), requestId: Id, decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]) }, { additionalProperties: false }),
]);
export type SubmissionBody = Static<typeof SubmissionBodySchema>;

/** The only inbound shape. `requestId` is the platform event id, deduplicated per Channel. */
export const SubmissionSchema = Type.Object({
  requestId: Id,
  address: ConversationAddressSchema,
  actor: ChannelActorSchema,
  body: SubmissionBodySchema,
}, { additionalProperties: false });
export type Submission = Static<typeof SubmissionSchema>;

/** A Receipt as delivered: enough to render without reading tool output. */
export const PublicationDeliveredSchema = Type.Object({
  type: Type.Literal("publication.delivered"),
  receiptId: Id,
  taskId: Id,
  format: Type.Union([Type.Literal("inline"), Type.Literal("csv")]),
  publicRef: Type.String({ minLength: 1 }),
  disclosure: Type.Optional(Type.String()),
  inlineContent: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type PublicationDelivered = Static<typeof PublicationDeliveredSchema>;

/** A dashboard written to the Session workspace; every number in it comes from a Receipt (ADR-0008). */
export const DashboardDeliveredSchema = Type.Object({
  type: Type.Literal("dashboard.delivered"),
  /** Workspace-relative, under `dashboards/`. */
  path: Type.String({ minLength: 1, pattern: "^dashboards/[^/\\\\]+\\.html$" }),
  /** Identity of this version of the page; an edit that changes it is a new Deliverable. */
  contentHash: Type.String({ minLength: 1 }),
  receiptIds: Type.Array(Id),
}, { additionalProperties: false });
export type DashboardDelivered = Static<typeof DashboardDeliveredSchema>;

export const NoticeCodeSchema = Type.Union([
  /** A Publication for a group that is not allowed group delivery went to the asker privately. */
  Type.Literal("GROUP_DELIVERY_REDIRECTED"),
  /** A Submission was accepted but the process stopped before it was dispatched. */
  Type.Literal("SUBMISSION_INTERRUPTED"),
  /** The Runtime refused a Submission. */
  Type.Literal("SUBMISSION_REJECTED"),
  /** A new Session began, on request or after the conversation sat idle. */
  Type.Literal("CONVERSATION_STARTED"),
  /** The sender is not linked to an account, so nothing was run. */
  Type.Literal("ACCESS_DENIED"),
  /** The sender is now linked to an account. */
  Type.Literal("ACCOUNT_LINKED"),
  /** A link attempt was refused: wrong, expired or used code, too many tries, or not in a private chat. */
  Type.Literal("LINK_FAILED"),
  /** The sender's request to use the bot went to the members who can decide it. */
  Type.Literal("ACCESS_REQUESTED"),
  /** The sender may now use the bot. */
  Type.Literal("ACCESS_GRANTED"),
  /** What became of a decision a member made. */
  Type.Literal("ACCESS_DECIDED"),
  /** The commands, sent on /help and when the owner first writes. */
  Type.Literal("HELP"),
  /** Where the bot and the speaker stand, sent on /status. */
  Type.Literal("STATUS"),
  /** A bot setting changed from the chat, such as the reply detail. */
  Type.Literal("SETTING_CHANGED"),
]);

/** What may leave the system through a Channel. Persisted before delivery. */
export const DeliverableSchema = Type.Union([
  Type.Object({ kind: Type.Literal("question"), clarificationId: Id, question: Type.String(), options: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("publication"), publication: PublicationDeliveredSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("dashboard"), dashboard: DashboardDeliveredSchema }, { additionalProperties: false }),
  /** Asks a member to let someone use the bot; it goes to members privately. */
  Type.Object({
    kind: Type.Literal("access_request"),
    requestId: Id,
    requester: ChannelActorSchema,
    audience: Type.Union([Type.Literal("direct"), Type.Literal("group")]),
    /** What they sent when asking, so the member knows who and why. */
    text: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("notice"), code: NoticeCodeSchema, text: Type.String() }, { additionalProperties: false }),
]);
export type Deliverable = Static<typeof DeliverableSchema>;

/** A Deliverable goes to a conversation, or privately to one actor. */
export const DeliveryTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal("address"), address: ConversationAddressSchema }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("actor"), actor: ChannelActorSchema }, { additionalProperties: false }),
]);
export type DeliveryTarget = Static<typeof DeliveryTargetSchema>;

/** Latest state of a run. Progress may be dropped; a Channel redraws from the newest view. */
export const ProgressViewSchema = Type.Object({
  runId: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("running"), Type.Literal("completed")]),
  text: Type.String(),
  activeTool: Type.Optional(Type.String()),
  /** On a completed run at full detail: what the agent did, in order, in words people read. */
  steps: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
export type ProgressView = Static<typeof ProgressViewSchema>;

/**
 * How much of a run a bot sends. `summary`: the final answer only, once done.
 * `standard`: the answer as it is written, with the step in progress. `full`:
 * standard, plus the steps taken listed under the answer.
 */
export const ReplyDetailSchema = Type.Union([Type.Literal("summary"), Type.Literal("standard"), Type.Literal("full")]);
export type ReplyDetail = Static<typeof ReplyDetailSchema>;

export interface ChannelCapabilities {
  /** A sent message can be edited in place, so progress can stream into it. */
  readonly editableMessages: boolean;
  /** Messages can carry buttons whose clicks come back as Submissions. */
  readonly actions: boolean;
  /** Files can be sent. */
  readonly files: boolean;
}

/** Content the core reads on the Channel's behalf, with the asker's authority, only when asked. */
export interface DeliveryContent {
  /** The published result as CSV; present for publication Deliverables. */
  readonly readPublication?: () => Promise<string>;
  /** The self-contained dashboard page; present for dashboard Deliverables. */
  readonly readDashboard?: () => Promise<Uint8Array>;
  /** A PNG of the rendered page, when the host can render one; it may throw. */
  readonly snapshotDashboard?: () => Promise<Uint8Array>;
}

/**
 * One platform adapter. `start` hands the Channel a sink for verified inbound
 * events; `deliver` must be idempotent on `idempotencyKey`, because the core
 * delivers at least once. Progress follows the same audience rule as
 * publications, so it is addressed by target too.
 */
export interface Channel {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  start(sink: (submission: Submission) => Promise<void>): Promise<void>;
  deliver(target: DeliveryTarget, deliverable: Deliverable, idempotencyKey: string, content?: DeliveryContent): Promise<void>;
  progress?(target: DeliveryTarget, view: ProgressView): Promise<void>;
  stop(): Promise<void>;
}

/** Who may use the channels: linked accounts and approved guests, and requests waiting for a decision. */
export const ChannelAccessSchema = Type.Object({
  members: Type.Array(Type.Object({
    actor: ChannelActorSchema,
    /** `account`: linked to a signed-in account with /bind, may approve others. `guest`: approved to use the bot only. */
    role: Type.Union([Type.Literal("account"), Type.Literal("guest")]),
    since: Type.Integer(),
  }, { additionalProperties: false })),
  requests: Type.Array(Type.Object({
    id: Id,
    requester: ChannelActorSchema,
    audience: Type.Union([Type.Literal("direct"), Type.Literal("group")]),
    text: Type.String(),
    at: Type.Integer(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export type ChannelAccess = Static<typeof ChannelAccessSchema>;

/** Where a Channel stands, as the settings page shows it. Credentials never appear here. */
export const ChannelStatusSchema = Type.Object({
  id: Id,
  label: Type.String(),
  /** `paused`: set up, but switched off by the user; it keeps its credentials and its members. */
  state: Type.Union([Type.Literal("unconfigured"), Type.Literal("provisioning"), Type.Literal("connected"), Type.Literal("failed"), Type.Literal("paused")]),
  /** The platform supports scan-to-connect. */
  provisionable: Type.Boolean(),
  /** While provisioning: the link to scan or open in the platform's app. */
  provisioning: Type.Optional(Type.Object({ url: Type.String(), expiresAt: Type.Integer() }, { additionalProperties: false })),
  message: Type.Optional(Type.String()),
  /** Steps left for the user after connecting, such as settings the platform refused to change for us. */
  warnings: Type.Optional(Type.Array(Type.String())),
  /** The bot's own settings; absent until it is set up. */
  settings: Type.Optional(Type.Object({ enabled: Type.Boolean(), replyDetail: ReplyDetailSchema }, { additionalProperties: false })),
}, { additionalProperties: false });
export type ChannelStatus = Static<typeof ChannelStatusSchema>;

/** Saved per Channel by the core and handed back to `create`; it holds credentials and stays out of every response. */
export type ChannelConfig = Readonly<Record<string, unknown>>;

export interface ChannelProvisioning {
  /** Opened in the platform's app (shown as a QR code), it creates and authorizes the bot. */
  readonly ready: Promise<{ readonly url: string; readonly expiresAt: number }>;
  /**
   * The configuration to save, anything the user still has to do by hand, and
   * who scanned, as the new bot sees them: that person owns the bot.
   */
  readonly done: Promise<{ readonly config: ChannelConfig; readonly warnings: readonly string[]; readonly owner?: { readonly externalUserId: string } }>;
}

/** One platform, as the core manages it: build a Channel from saved configuration, and optionally obtain that configuration by scanning. */
export interface ChannelProvider {
  readonly id: string;
  readonly label: string;
  create(config: ChannelConfig): Channel;
  provision?(signal: AbortSignal): ChannelProvisioning;
}

export function parseSubmission(value: unknown): Submission {
  if (!Value.Check(SubmissionSchema, value)) throw new TypeError("Invalid channel submission");
  return value;
}
