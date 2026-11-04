import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ChannelActorSchema, ChannelAccessSchema, ChannelStatusSchema, DashboardDeliveredSchema, PublicationDeliveredSchema } from "./channel.js";

export const ProtocolVersion = 1 as const;
export const RequestContextSchema = Type.Object({ userId: Type.String({ minLength: 1 }), host: Type.Union([Type.Literal("electron"), Type.Literal("web"), Type.Literal("channel")]), sessionId: Type.Optional(Type.String({ minLength: 1 })) });
export type RequestContext = Static<typeof RequestContextSchema>;

const RuntimeProbeCommandSchema = Type.Object({ type: Type.Literal("runtime.probe") });
/** Files already uploaded to the Session workspace, referenced by workspace-relative path. */
const PromptAttachmentSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 512 }) });
const AgentPromptCommandSchema = Type.Object({ type: Type.Literal("agent.prompt"), prompt: Type.String({ minLength: 1 }), attachments: Type.Optional(Type.Array(PromptAttachmentSchema, { maxItems: 20 })) });
const AgentSteerCommandSchema = Type.Object({ type: Type.Literal("agent.steer"), prompt: Type.String({ minLength: 1 }) });
const AgentFollowUpCommandSchema = Type.Object({ type: Type.Literal("agent.follow_up"), prompt: Type.String({ minLength: 1 }) });
const AgentStopCommandSchema = Type.Object({ type: Type.Literal("agent.stop"), operationId: Type.Optional(Type.String({ minLength: 1 })) });
const WorkspaceListCommandSchema = Type.Object({ type: Type.Literal("workspace.list") });
const WorkspaceReadCommandSchema = Type.Object({ type: Type.Literal("workspace.read"), path: Type.String({ minLength: 1 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) });
const WorkspaceWriteCommandSchema = Type.Object({ type: Type.Literal("workspace.write"), path: Type.String({ minLength: 1 }), content: Type.String() });
const WorkspaceDeleteCommandSchema = Type.Object({ type: Type.Literal("workspace.delete"), path: Type.String({ minLength: 1 }) });
const RunPythonCommandSchema = Type.Object({ type: Type.Literal("python.run"), code: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()) });
const KnowledgeSearchCommandSchema = Type.Object({ type: Type.Literal("knowledge.search"), query: Type.String({ minLength: 1 }) });
const KnowledgeReadCommandSchema = Type.Object({ type: Type.Literal("knowledge.read"), path: Type.String({ minLength: 1 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })), endLine: Type.Optional(Type.Integer({ minimum: 1 })) });
const ClarificationAnswerCommandSchema = Type.Object({ type: Type.Literal("clarification.answer"), clarificationId: Type.String({ minLength: 1 }), answer: Type.String() });
const KnowledgeListCommandSchema = Type.Object({ type: Type.Literal("knowledge.list") });
const KnowledgeSaveCommandSchema = Type.Object({ type: Type.Literal("knowledge.save"), path: Type.String({ minLength: 1 }), content: Type.String() });
const ConfigGetCommandSchema = Type.Object({ type: Type.Literal("config.get") });
const ConfigSaveCommandSchema = Type.Object({ type: Type.Literal("config.save"), patch: Type.Record(Type.String(), Type.Unknown()) });
const PythonRuntimeTestCommandSchema = Type.Object({ type: Type.Literal("python.runtime.test"), mode: Type.Union([Type.Literal("bundled"), Type.Literal("external")]), executable: Type.Optional(Type.String()) });
const DbTestCommandSchema = Type.Object({ type: Type.Literal("db.test"), connection: Type.Record(Type.String(), Type.Unknown()) });
/** Creates the bundled demo SQLite database and makes it the saved connection. */
const DbSampleCommandSchema = Type.Object({ type: Type.Literal("db.sample") });
const LlmTestCommandSchema = Type.Object({ type: Type.Literal("llm.test"), profile: Type.Record(Type.String(), Type.Unknown()) });
const McpServersStatusCommandSchema = Type.Object({ type: Type.Literal("mcp.servers.status") });
const McpServerTestCommandSchema = Type.Object({ type: Type.Literal("mcp.server.test"), name: Type.String({ minLength: 1 }) });
const McpServerRestartCommandSchema = Type.Object({ type: Type.Literal("mcp.server.restart"), name: Type.String({ minLength: 1 }) });
const SessionTranscriptCommandSchema = Type.Object({ type: Type.Literal("session.transcript"), sessionId: Type.String({ minLength: 1 }) });
const SessionPrepareCommandSchema = Type.Object({ type: Type.Literal("session.prepare"), sessionId: Type.String({ minLength: 1 }) });
const McpConfigGetCommandSchema = Type.Object({ type: Type.Literal("mcp.config.get") });
const McpConfigSaveCommandSchema = Type.Object({ type: Type.Literal("mcp.config.save"), config: Type.Unknown() });
const SkillsListCommandSchema = Type.Object({ type: Type.Literal("skills.list") });
const DashboardRefreshCommandSchema = Type.Object({ type: Type.Literal("dashboard.refresh"), path: Type.String({ minLength: 1 }), viewIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 40 }) });
const TaskCreateCommandSchema = Type.Object({ type: Type.Literal("task.create"), name: Type.String({ minLength: 1 }) });
const TaskListCommandSchema = Type.Object({ type: Type.Literal("task.list") });
const TaskRenameCommandSchema = Type.Object({ type: Type.Literal("task.rename"), taskId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) });
const TaskDeleteCommandSchema = Type.Object({ type: Type.Literal("task.delete"), taskId: Type.String({ minLength: 1 }) });
const SessionCreateCommandSchema = Type.Object({ type: Type.Literal("session.create"), taskId: Type.String({ minLength: 1 }), name: Type.Optional(Type.String({ minLength: 1 })) });
const SessionListCommandSchema = Type.Object({ type: Type.Literal("session.list"), taskId: Type.Optional(Type.String({ minLength: 1 })) });
const SessionRenameCommandSchema = Type.Object({ type: Type.Literal("session.rename"), sessionId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) });
const SessionDeleteCommandSchema = Type.Object({ type: Type.Literal("session.delete"), sessionId: Type.String({ minLength: 1 }) });
const ChannelListCommandSchema = Type.Object({ type: Type.Literal("channel.list") });
const ChannelProvisionCommandSchema = Type.Object({ type: Type.Literal("channel.provision"), channelId: Type.String({ minLength: 1 }) });
const ChannelDisconnectCommandSchema = Type.Object({ type: Type.Literal("channel.disconnect"), channelId: Type.String({ minLength: 1 }) });
/** A one-time code the signed-in user sends to a channel bot as `/bind <code>` to link that IM identity to their account. */
const ChannelBindCodeCommandSchema = Type.Object({ type: Type.Literal("channel.bind_code") });
const ChannelAccessListCommandSchema = Type.Object({ type: Type.Literal("channel.access.list") });
const ChannelAccessDecideCommandSchema = Type.Object({ type: Type.Literal("channel.access.decide"), requestId: Type.String({ minLength: 1 }), decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]) });
const ChannelAccessRevokeCommandSchema = Type.Object({ type: Type.Literal("channel.access.revoke"), actor: ChannelActorSchema });
export const DataAgentCommandSchema = Type.Union([ChannelListCommandSchema, ChannelProvisionCommandSchema, ChannelDisconnectCommandSchema, ChannelBindCodeCommandSchema, ChannelAccessListCommandSchema, ChannelAccessDecideCommandSchema, ChannelAccessRevokeCommandSchema, RuntimeProbeCommandSchema, AgentPromptCommandSchema, AgentSteerCommandSchema, AgentFollowUpCommandSchema, AgentStopCommandSchema, WorkspaceListCommandSchema, WorkspaceReadCommandSchema, WorkspaceWriteCommandSchema, WorkspaceDeleteCommandSchema, RunPythonCommandSchema, KnowledgeSearchCommandSchema, KnowledgeReadCommandSchema, ClarificationAnswerCommandSchema, KnowledgeListCommandSchema, KnowledgeSaveCommandSchema, ConfigGetCommandSchema, ConfigSaveCommandSchema, PythonRuntimeTestCommandSchema, DbTestCommandSchema, DbSampleCommandSchema, LlmTestCommandSchema, McpServersStatusCommandSchema, McpServerTestCommandSchema, McpServerRestartCommandSchema, SessionPrepareCommandSchema, SessionTranscriptCommandSchema, McpConfigGetCommandSchema, McpConfigSaveCommandSchema, SkillsListCommandSchema, DashboardRefreshCommandSchema, TaskCreateCommandSchema, TaskListCommandSchema, TaskRenameCommandSchema, TaskDeleteCommandSchema, SessionCreateCommandSchema, SessionListCommandSchema, SessionRenameCommandSchema, SessionDeleteCommandSchema]);
export type DataAgentCommand = Static<typeof DataAgentCommandSchema>;
export const DataAgentCommandEnvelopeSchema = Type.Object({ protocolVersion: Type.Literal(ProtocolVersion), requestId: Type.String({ minLength: 1 }), sessionId: Type.Optional(Type.String({ minLength: 1 })), command: DataAgentCommandSchema });
export type DataAgentCommandEnvelope = Static<typeof DataAgentCommandEnvelopeSchema>;

const RuntimeProbeResponseSchema = Type.Object({ type: Type.Literal("runtime.probe.result"), service: Type.Literal("data-agent-runtime"), runtimeVersion: Type.Literal("0.1.0") });
const AgentPromptResponseSchema = Type.Object({ type: Type.Literal("agent.prompt.accepted"), runId: Type.String({ minLength: 1 }) });
const KnowledgeSearchResponseSchema = Type.Object({ type: Type.Literal("knowledge.search.result"), hits: Type.Array(Type.Object({ path: Type.String(), title: Type.String(), category: Type.String(), chunkId: Type.String(), startLine: Type.Integer(), endLine: Type.Integer(), score: Type.Number(), revision: Type.Integer(), snippet: Type.Optional(Type.String()) })) });
const KnowledgeReadResponseSchema = Type.Object({ type: Type.Literal("knowledge.read.result"), path: Type.String(), content: Type.String() });
const KnowledgeListResponseSchema = Type.Object({ type: Type.Literal("knowledge.list.result"), files: Type.Array(Type.Object({
  path: Type.String(),
  size: Type.Number(),
  modifiedAt: Type.Number(),
  /** Catalog metadata from the document's frontmatter, when it has any. */
  knowledgeId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  usage: Type.Optional(Type.Union([Type.Literal("method"), Type.Literal("fact")])),
  /** Built-in documents ship with the application and cannot be saved over. */
  readOnly: Type.Optional(Type.Boolean()),
  /** False for a placeholder that has frontmatter but no content yet. */
  hasContent: Type.Optional(Type.Boolean()),
})) });
const KnowledgeSaveResponseSchema = Type.Object({ type: Type.Literal("knowledge.save.result"), path: Type.String() });
const McpConfigResponseSchema = Type.Object({ type: Type.Literal("mcp.config.result"), config: Type.Unknown() });
const SkillsListResponseSchema = Type.Object({ type: Type.Literal("skills.list.result"), skills: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), tools: Type.Array(Type.String()) })), diagnostics: Type.Optional(Type.Array(Type.Object({ path: Type.String(), message: Type.String() }))) });
const SessionTranscriptResponseSchema = Type.Object({ type: Type.Literal("session.transcript.result"), messages: Type.Array(Type.Object({
  id: Type.String(),
  role: Type.String(),
  content: Type.String(),
  timestamp: Type.Number(),
  /** Workspace paths of the files attached to a user message. */
  attachments: Type.Optional(Type.Array(Type.String())),
  reasoningContent: Type.Optional(Type.String()),
  messageId: Type.Optional(Type.String()),
  toolCallsById: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  widgetsById: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  skillActivations: Type.Optional(Type.Array(Type.Unknown())),
  currentStage: Type.Optional(Type.String()),
  visitedStages: Type.Optional(Type.Array(Type.String())),
  terminalReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})),
  /** The Session's run still in progress when the snapshot was taken; its runId matches event envelopes. */
  inProgressRun: Type.Optional(Type.Union([Type.Object({ runId: Type.String(), startedAt: Type.Number() }), Type.Null()])),
  /** The clarification the Session is waiting on, if any. */
  pendingClarification: Type.Optional(Type.Union([Type.Object({ clarificationId: Type.String(), question: Type.String(), options: Type.Array(Type.String()) }), Type.Null()])),
  /** Last event sequence emitted before the snapshot; a client resumes the event stream after it. */
  eventSequence: Type.Optional(Type.Integer({ minimum: 0 })),
  /** The server instance that issued eventSequence: sequences restart with the process. */
  eventInstance: Type.Optional(Type.String()),
});
const ConfigGetResponseSchema = Type.Object({ type: Type.Literal("config.get.result"), config: Type.Unknown() });
const ConfigSaveResponseSchema = Type.Object({ type: Type.Literal("config.save.result"), saved: Type.Boolean() });
const SimpleTestResponseSchema = Type.Object({ type: Type.Literal("test.result"), success: Type.Boolean(), message: Type.String(), details: Type.Optional(Type.Unknown()) });
const McpServersStatusResponseSchema = Type.Object({ type: Type.Literal("mcp.servers.status.result"), servers: Type.Array(Type.Object({ name: Type.String(), enabled: Type.Boolean(), connected: Type.Boolean(), toolCount: Type.Number(), hostManaged: Type.Boolean() })) });
const McpServerTestResponseSchema = Type.Object({ type: Type.Literal("mcp.server.test.result"), ok: Type.Boolean(), message: Type.String() });
const McpServerRestartResponseSchema = Type.Object({ type: Type.Literal("mcp.server.restart.result"), ok: Type.Boolean() });
const DashboardRefreshResponseSchema = Type.Object({ type: Type.Literal("dashboard.refresh.result"), datasets: Type.Unknown(), sources: Type.Unknown(), checks: Type.Unknown(), notices: Type.Unknown() });
const PythonResponseSchema = Type.Object({ type: Type.Literal("python.result"), jobId: Type.String(), status: Type.Union([Type.Literal("success"), Type.Literal("error"), Type.Literal("timeout"), Type.Literal("aborted")]), exitCode: Type.Union([Type.Number(), Type.Null()]), stdout: Type.String(), stderr: Type.String(), scriptPath: Type.String(), durationMs: Type.Number() });
const WorkspaceResponseSchema = Type.Object({ type: Type.Literal("workspace.result"), operation: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("write")]), path: Type.Optional(Type.String()), content: Type.Optional(Type.String()), files: Type.Optional(Type.Array(Type.String())) });
const TaskSchema = Type.Object({ id: Type.String(), name: Type.String(), createdAt: Type.Number(), updatedAt: Type.Number() });
const SessionSchema = Type.Object({ id: Type.String(), taskId: Type.String(), name: Type.String(), createdAt: Type.Number(), updatedAt: Type.Number() });
const MutationResponseSchema = Type.Object({ type: Type.Literal("mutation.result"), entity: Type.Union([Type.Literal("task"), Type.Literal("session")]), item: Type.Union([TaskSchema, SessionSchema]) });
const ListResponseSchema = Type.Object({ type: Type.Literal("list.result"), entity: Type.Union([Type.Literal("task"), Type.Literal("session")]), items: Type.Array(Type.Union([TaskSchema, SessionSchema])) });
const ChannelListResponseSchema = Type.Object({ type: Type.Literal("channel.list.result"), channels: Type.Array(ChannelStatusSchema) });
const ChannelBindCodeResponseSchema = Type.Object({ type: Type.Literal("channel.bind_code.result"), code: Type.String({ pattern: "^[0-9]{6}$" }), expiresAt: Type.Integer() });
const ChannelAccessResponseSchema = Type.Object({ type: Type.Literal("channel.access.result"), access: ChannelAccessSchema });
export const DataAgentResponseSchema = Type.Union([ChannelListResponseSchema, ChannelBindCodeResponseSchema, ChannelAccessResponseSchema, RuntimeProbeResponseSchema, AgentPromptResponseSchema, KnowledgeSearchResponseSchema, KnowledgeReadResponseSchema, KnowledgeListResponseSchema, KnowledgeSaveResponseSchema, McpConfigResponseSchema, SkillsListResponseSchema, SessionTranscriptResponseSchema, ConfigGetResponseSchema, ConfigSaveResponseSchema, SimpleTestResponseSchema, McpServersStatusResponseSchema, McpServerTestResponseSchema, McpServerRestartResponseSchema, DashboardRefreshResponseSchema, PythonResponseSchema, WorkspaceResponseSchema, MutationResponseSchema, ListResponseSchema]);
export type DataAgentResponse = Static<typeof DataAgentResponseSchema>;
export const DataAgentResponseEnvelopeSchema = Type.Object({ protocolVersion: Type.Literal(ProtocolVersion), requestId: Type.String({ minLength: 1 }), response: DataAgentResponseSchema });
export type DataAgentResponseEnvelope = Static<typeof DataAgentResponseEnvelopeSchema>;

const WidgetRecordSchema = Type.Record(Type.String(), Type.Unknown());
const WidgetEventFields = {
  messageId: Type.String({ minLength: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  widgetId: Type.String({ minLength: 1 }),
};

/** One delegated child as shown while a `subagent` call runs; never carries SQL, reports or tool arguments. */
export const SubagentChildProgressSchema = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 128 }),
  role: Type.Union([Type.Literal("explorer"), Type.Literal("reviewer")]),
  task: Type.String({ maxLength: 512 }),
  currentTool: Type.Union([Type.String({ maxLength: 128 }), Type.Null()]),
  toolCalls: Type.Integer({ minimum: 0 }),
  startedAt: Type.Integer({ minimum: 0 }),
  endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  status: Type.Union([
    Type.Literal("running"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("interrupted"),
    Type.Literal("timed_out"),
    Type.Literal("budget_exhausted"),
    Type.Literal("invalid_output"),
    Type.Literal("abort_unconfirmed"),
  ]),
  output: Type.Union([Type.Literal("pending"), Type.Literal("produced"), Type.Literal("none")]),
}, { additionalProperties: false });
export type SubagentChildProgress = Static<typeof SubagentChildProgressSchema>;
export const ToolProgressSchema = Type.Union([
  Type.Object({ kind: Type.Literal("subagent"), children: Type.Array(SubagentChildProgressSchema, { maxItems: 4 }) }, { additionalProperties: false }),
]);
export type ToolProgress = Static<typeof ToolProgressSchema>;
export function isToolProgress(value: unknown): value is ToolProgress { return Value.Check(ToolProgressSchema, value); }

export const DataAgentEventSchema = Type.Union([
  Type.Object({ type: Type.Literal("runtime.probe.completed"), service: Type.Literal("data-agent-runtime") }),
  Type.Object({ type: Type.Literal("agent.text_delta"), delta: Type.String() }),
  Type.Object({ type: Type.Literal("agent.thinking_delta"), delta: Type.String() }),
  Type.Object({ type: Type.Literal("agent.message_started"), messageId: Type.String() }),
  Type.Object({ type: Type.Literal("agent.tool_started"), toolCallId: Type.String(), toolName: Type.String(), args: Type.Unknown() }),
  Type.Object({ type: Type.Literal("agent.tool_progress"), toolCallId: Type.String(), toolName: Type.String(), progress: ToolProgressSchema }),
  Type.Object({ type: Type.Literal("agent.tool_finished"), toolCallId: Type.String(), toolName: Type.String(), args: Type.Optional(Type.Unknown()), result: Type.Unknown(), isError: Type.Boolean() }),
  Type.Object({ type: Type.Literal("widget"), ...WidgetEventFields, toolName: Type.Literal("show_widget"), widget: WidgetRecordSchema }),
  Type.Object({ type: Type.Literal("widget_patch"), ...WidgetEventFields, toolName: Type.Literal("show_widget"), patch: WidgetRecordSchema }),
  Type.Object({ type: Type.Literal("widget_done"), ...WidgetEventFields, toolName: Type.Literal("show_widget") }),
  Type.Object({ type: Type.Literal("widget_remove"), ...WidgetEventFields, toolName: Type.Literal("show_widget") }),
  Type.Object({ type: Type.Literal("widget_error"), ...WidgetEventFields, toolName: Type.Literal("show_widget"), error: Type.String() }),
  /** `outcome` says how the run ended; absent means completed (older producers). */
  Type.Object({ type: Type.Literal("agent.completed"), outcome: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("stopped"), Type.Literal("failed")])) }),
  Type.Object({ type: Type.Literal("workspace.artifact.created"), path: Type.String(), kind: Type.Literal("file") }),
  Type.Object({ type: Type.Literal("clarification.request"), clarificationId: Type.String(), question: Type.String(), options: Type.Array(Type.String()) }),
  PublicationDeliveredSchema,
  DashboardDeliveredSchema,
  Type.Object({ type: Type.Literal("clarification.settled"), clarificationId: Type.String(), outcome: Type.Union([Type.Literal("answered"), Type.Literal("expired"), Type.Literal("cancelled")]) }),
]);
export type DataAgentEvent = Static<typeof DataAgentEventSchema>;
export const DataAgentEventEnvelopeSchema = Type.Object({ protocolVersion: Type.Literal(ProtocolVersion), sequence: Type.Integer({ minimum: 1 }), requestId: Type.String({ minLength: 1 }), sessionId: Type.Optional(Type.String()), runId: Type.Optional(Type.String()), timestamp: Type.Integer({ minimum: 0 }), event: DataAgentEventSchema });
export type DataAgentEventEnvelope = Static<typeof DataAgentEventEnvelopeSchema>;
export function isDataAgentCommandEnvelope(value: unknown): value is DataAgentCommandEnvelope { return Value.Check(DataAgentCommandEnvelopeSchema, value); }
export function isDataAgentEvent(value: unknown): value is DataAgentEvent { return Value.Check(DataAgentEventSchema, value); }
export function isDataAgentEventEnvelope(value: unknown): value is DataAgentEventEnvelope { return Value.Check(DataAgentEventEnvelopeSchema, value); }
export function parseDataAgentCommandEnvelope(value: unknown): DataAgentCommandEnvelope { if (!isDataAgentCommandEnvelope(value)) throw new TypeError("Invalid DataAgent command envelope"); return value; }
export function parseDataAgentResponseEnvelope(value: unknown): DataAgentResponseEnvelope { if (!Value.Check(DataAgentResponseEnvelopeSchema, value)) throw new TypeError("Invalid DataAgent response envelope"); return value; }

export * from "./channel.js";
export * from "./chart-spec.js";
export * from "./chart-marks.js";
export * from "./dashboard-spec.js";
