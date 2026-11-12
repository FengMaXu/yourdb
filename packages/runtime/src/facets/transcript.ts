import { isToolProgress, type DataAgentEventEnvelope, type DataAgentEvent, type PublicationDelivered, type DashboardDelivered } from "@data-agent/contracts";
import type { AgentHarness, HarnessEvent } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { isWidgetLifecycleDetails, validateWidgetSpec, type WidgetPayload } from "../widget.js";
import { splitPromptAttachments } from "../attachments.js";
import { isRuntimeInjected } from "../runtime-injected.js";
import { infrastructureFailureOf } from "../agent/infrastructure-failure.js";
import { asRecord } from "../primitives.js";

export interface ProjectedOperation {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionId?: string;
}

export type AgentRuntimeEvent = Record<string, any> & { type: string };

/**
 * Read-only facts emitted by Pi before the presentation projector can remove
 * lifecycle and usage information. Consumers must treat the payload as
 * observational evidence, not as an execution control surface.
 */
export interface RuntimeObservation {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly observedAt: number;
  readonly event: HarnessEvent;
}

export interface RuntimeExecutionSnapshot {
  readonly sessionId: string;
  readonly lane: string;
  readonly tipId: string | null;
  readonly current: TranscriptSnapshot["operation"];
  readonly lastOperationId: string | null;
  readonly lastResult?: {
    readonly operationId: string;
    readonly status: string;
    readonly startedAt: number;
    readonly endedAt: number;
    readonly error?: unknown;
  };
  readonly faulted: boolean;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly timestamp: number;
  /** Workspace paths attached to a user message. */
  readonly attachments?: string[];
  readonly reasoningContent?: string;
  readonly messageId?: string;
  readonly toolCallsById?: Record<string, unknown>;
  readonly widgetsById?: Record<string, unknown>;
  readonly skillActivations?: unknown[];
  readonly currentStage?: string;
  readonly visitedStages?: string[];
  readonly terminalReason?: string | null;
}

interface TranscriptProjectorOptions {
  resolve(event: AgentRuntimeEvent): { operationId: string; operation: ProjectedOperation } | undefined;
  nextSequence(): number;
  emit(envelope: DataAgentEventEnvelope): void;
  onTerminal(operationId: string): void;
}

interface WidgetCall {
  widgetId: string;
  messageId: string;
}

interface OperationProjectionState {
  activeMessageId?: string;
  assistantMessageSequence: number;
  widgetCalls: Map<string, WidgetCall>;
  toolArgs: Map<string, unknown>;
  /** A lost database seen in a tool result; the Runtime then stops the run (harness-factory). */
  infrastructureFailure?: string | undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.reduce((text, part) => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string" ? text + record.text : text;
  }, "");
}

function timestampFromEntry(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

/**
 * Compile a Pi lane snapshot into the stable wire transcript projection.
 * `hiddenEntryIds` names Runtime-injected user-role entries: they stay in the
 * model context but are not something the user said.
 */
export function transcriptMessagesFromSnapshot(snapshot: TranscriptSnapshot, hiddenEntryIds: ReadonlySet<string> = new Set()): readonly TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const toolOwners = new Map<string, { snapshot: TranscriptMessage; tool: Record<string, unknown> }>();
  const entries = [...snapshot.transcript].sort((left, right) => {
    const a = asRecord(left)?.seq;
    const b = asRecord(right)?.seq;
    return (typeof a === "number" ? a : 0) - (typeof b === "number" ? b : 0);
  });
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (entry?.type !== "message") continue;
    const message = asRecord(entry.message);
    if (!message) continue;
    const entryId = typeof entry.id === "string" ? entry.id : "entry";
    const timestamp = timestampFromEntry(entry.timestamp);
    if (message.role === "user") {
      if (hiddenEntryIds.has(entryId)) continue;
      const { prompt: content, attachments } = splitPromptAttachments(textFromContent(message.content));
      if (content) messages.push({ id: entryId, role: "user", content, timestamp, ...(attachments.length > 0 ? { attachments } : {}) });
      continue;
    }
    if (message.role === "assistant") {
      const content = textFromContent(message.content);
      const reasoningContent = Array.isArray(message.content)
        ? message.content.reduce((text, part) => {
          const record = asRecord(part);
          return record?.type === "thinking" && typeof record.thinking === "string" ? text + record.thinking : text;
        }, "")
        : "";
      const toolCallsById: Record<string, Record<string, unknown>> = {};
      if (Array.isArray(message.content)) {
        for (const partValue of message.content) {
          const part = asRecord(partValue);
          if (part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
            toolCallsById[part.id] = { toolCallId: part.id, name: part.name, arguments: asRecord(part.arguments) ?? {}, status: "calling" };
          }
        }
      }
      if (!content && !reasoningContent && Object.keys(toolCallsById).length === 0) continue;
      const snapshotMessage: TranscriptMessage = {
        id: entryId,
        role: "agent",
        content,
        reasoningContent,
        messageId: entryId,
        toolCallsById,
        widgetsById: {},
        skillActivations: [],
        currentStage: Object.keys(toolCallsById).length ? "executing_query" : "generating_answer",
        visitedStages: Object.keys(toolCallsById).length ? ["sent", "selecting_tool", "executing_query"] : ["sent", "generating_answer"],
        terminalReason: message.stopReason === "error" ? "error" : "completed",
        timestamp,
      };
      messages.push(snapshotMessage);
      for (const [toolCallId, tool] of Object.entries(toolCallsById)) toolOwners.set(toolCallId, { snapshot: snapshotMessage, tool });
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const owner = toolOwners.get(message.toolCallId);
      if (!owner) continue;
      owner.tool.result = textFromContent(message.content);
      owner.tool.details = message.details;
      owner.tool.isError = message.isError === true;
      owner.tool.status = message.isError === true ? "error" : "done";
      const details = asRecord(message.details);
      const widgetId = typeof details?.widgetId === "string" ? details.widgetId : undefined;
      const widget = asRecord(details?.widget);
      if (widgetId) owner.tool.widgetId = widgetId;
      if (widgetId && widget && owner.snapshot.widgetsById) owner.snapshot.widgetsById[widgetId] = widget;
    }
  }
  return messages;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readableToolResult(result: unknown, fallback: string): string {
  if (typeof result === "string" && result.trim()) return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text");
      if (text && typeof (text as { text?: unknown }).text === "string") return (text as { text: string }).text;
    }
  }
  return fallback;
}

function emptyProjection(): OperationProjectionState {
  return { assistantMessageSequence: 0, widgetCalls: new Map(), toolArgs: new Map() };
}

const PUBLISH_TOOLS = new Set(["publish_query_result", "export_query"]);

/**
 * A publish tool's details are its Receipt view. Only a well-formed Receipt
 * becomes `publication.delivered`; anything else stays a plain tool result.
 */
function publicationDelivered(toolName: string, result: unknown): PublicationDelivered | undefined {
  if (!PUBLISH_TOOLS.has(toolName)) return undefined;
  const details = asRecord(asRecord(result)?.details);
  if (!details) return undefined;
  const { receiptId, taskId, format, publicRef, inlineContent } = details;
  if (!isNonEmptyString(receiptId) || !isNonEmptyString(taskId) || !isNonEmptyString(publicRef) || (format !== "inline" && format !== "csv")) return undefined;
  const disclosure = asRecord(details.disclosure)?.summary;
  return {
    type: "publication.delivered",
    receiptId,
    taskId,
    format,
    publicRef,
    ...(isNonEmptyString(disclosure) ? { disclosure } : {}),
    ...(isNonEmptyString(inlineContent) ? { inlineContent } : {}),
  };
}

/** A created or edited dashboard; validate returns no details and stays silent. */
function dashboardDelivered(toolName: string, result: unknown): DashboardDelivered | undefined {
  if (toolName !== "generate_dashboard") return undefined;
  const details = asRecord(asRecord(result)?.details);
  if (!details) return undefined;
  const { relativePath, contentHash, receiptIds } = details;
  if (!isNonEmptyString(relativePath) || !/^dashboards\/[^/\\]+\.html$/.test(relativePath) || !isNonEmptyString(contentHash)) return undefined;
  return { type: "dashboard.delivered", path: relativePath, contentHash, receiptIds: Array.isArray(receiptIds) ? receiptIds.filter(isNonEmptyString) : [] };
}

/**
 * Presentation-only projection of Pi events. It owns no operation or business
 * state and can be discarded/rebuilt from a Pi lane snapshot after reconnect.
 */
export class TranscriptProjector {
  private readonly state = new Map<string, OperationProjectionState>();

  constructor(private readonly options: TranscriptProjectorOptions) {}

  project(event: AgentRuntimeEvent): void {
    if (!event?.type) return;
    const resolved = this.options.resolve(event);
    if (!resolved) return;
    const { operationId, operation } = resolved;
    const projection = this.state.get(operationId) ?? emptyProjection();
    this.state.set(operationId, projection);
    const base = () => ({
      protocolVersion: 1 as const,
      sequence: this.options.nextSequence(),
      requestId: operation.requestId,
      runId: operation.runId,
      ...(operation.sessionId ? { sessionId: operation.sessionId } : {}),
      timestamp: Date.now(),
    });
    if (event.type === "agent_end") {
      if (projection.infrastructureFailure) {
        this.emit(base(), { type: "agent.text_delta", delta: `\n\n> ⚠️ **数据库不可用，任务已停止**: ${projection.infrastructureFailure}` });
        this.emit(base(), { type: "agent.completed", outcome: "failed" });
      } else {
        this.emit(base(), { type: "agent.completed", outcome: event.aborted ? "stopped" : "completed" });
      }
      this.state.delete(operationId);
      this.options.onTerminal(operationId);
      return;
    }
    if (event.type === "agent_error") {
      this.emit(base(), { type: "agent.text_delta", delta: `\n\n> ⚠️ **执行失败**: ${String(event.error ?? "Pi operation failed")}` });
      this.emit(base(), { type: "agent.completed", outcome: "failed" });
      this.state.delete(operationId);
      this.options.onTerminal(operationId);
      return;
    }
    if (event.type === "message_start") {
      const message = asRecord(event.message);
      if (message?.role !== "assistant") return;
      const messageId = isNonEmptyString(message.id)
        ? message.id
        : `${operation.runId}:assistant:${++projection.assistantMessageSequence}`;
      projection.activeMessageId = messageId;
      this.emit(base(), { type: "agent.message_started", messageId });
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type !== "text_delta" && update?.type !== "thinking_delta") return;
      if (!isNonEmptyString(update.delta)) return;
      this.emit(base(), { type: update.type === "text_delta" ? "agent.text_delta" : "agent.thinking_delta", delta: update.delta });
      return;
    }
    if (event.type === "tool_execution_start") {
      if (!isNonEmptyString(event.toolCallId) || !isNonEmptyString(event.toolName)) {
        console.error("[data-agent] ignoring malformed tool start event");
        return;
      }
      const toolCallId = event.toolCallId;
      const toolName = event.toolName;
      projection.toolArgs.set(toolCallId, event.args ?? null);
      if (toolName === "show_widget") {
        projection.widgetCalls.set(toolCallId, {
          widgetId: `widget-${toolCallId}`,
          messageId: projection.activeMessageId || `message-${toolCallId}`,
        });
      }
      this.emit(base(), { type: "agent.tool_started", toolCallId, toolName, args: event.args ?? null });
      return;
    }
    if (event.type === "tool_execution_update") {
      if (projection.widgetCalls.has(event.toolCallId)) return;
      const partialResult = event.partialResult && typeof event.partialResult === "object" ? event.partialResult as { details?: unknown } : undefined;
      const progress = asRecord(partialResult?.details)?.toolProgress;
      if (isNonEmptyString(event.toolCallId) && isNonEmptyString(event.toolName) && isToolProgress(progress)) {
        this.emit(base(), { type: "agent.tool_progress", toolCallId: event.toolCallId, toolName: event.toolName, progress });
      }
      return;
    }
    if (event.type === "tool_execution_end") {
      if (!isNonEmptyString(event.toolCallId) || !isNonEmptyString(event.toolName)) {
        console.error("[data-agent] ignoring malformed tool completion event");
        return;
      }
      const toolCallId = event.toolCallId;
      projection.infrastructureFailure ??= infrastructureFailureOf(asRecord(event.result)?.content);
      const call = projection.widgetCalls.get(toolCallId);
      const completionArgs = event.args;
      let widgetFailed = false;
      if (call) {
        const common = { messageId: call.messageId, toolCallId, widgetId: call.widgetId, toolName: "show_widget" as const };
        const details = asRecord(event.result)?.details;
        if (event.isError) {
          widgetFailed = true;
          this.emit(base(), { type: "widget_error", ...common, error: readableToolResult(event.result, "Widget execution failed") });
        } else if (!isWidgetLifecycleDetails(details)) {
          widgetFailed = true;
          this.emit(base(), { type: "widget_error", ...common, error: "Invalid Widget result" });
        } else {
          widgetFailed = !this.emitWidget(base, call, toolCallId, details.widget);
          if (!widgetFailed) this.emit(base(), { type: "widget_done", ...common });
        }
      }
      this.emit(base(), { type: "agent.tool_finished", toolCallId, toolName: event.toolName, ...(completionArgs !== undefined ? { args: completionArgs } : {}), result: event.result ?? null, isError: Boolean(event.isError || widgetFailed) });
      const delivered = event.isError ? undefined : publicationDelivered(event.toolName, event.result) ?? dashboardDelivered(event.toolName, event.result);
      if (delivered) this.emit(base(), delivered);
      projection.widgetCalls.delete(toolCallId);
      projection.toolArgs.delete(toolCallId);
    }
  }

  clear(operationId?: string): void {
    if (operationId) this.state.delete(operationId);
    else this.state.clear();
  }

  /** Emits the widget, or a widget_error when its spec is invalid; returns whether it was delivered. */
  private emitWidget(base: () => Omit<DataAgentEventEnvelope, "event">, call: WidgetCall, toolCallId: string, payload: WidgetPayload): boolean {
    const common = { messageId: call.messageId, toolCallId, widgetId: call.widgetId, toolName: "show_widget" as const };
    const validation = validateWidgetSpec(payload.kind, payload);
    if (!validation.ok) {
      this.emit(base(), { type: "widget_error", ...common, error: validation.error });
      return false;
    }
    this.emit(base(), { type: "widget", ...common, widget: { ...payload, widget_id: call.widgetId, tool_call_id: toolCallId } });
    return true;
  }

  private emit(base: Omit<DataAgentEventEnvelope, "event">, event: DataAgentEvent): void {
    this.options.emit({ ...base, event });
  }
}

export interface TranscriptSnapshot {
  readonly sessionId: string;
  readonly lane: string;
  readonly tipId: string | null;
  readonly transcript: readonly unknown[];
  readonly operation: { readonly id: string; readonly kind: string; readonly startedAt: number; readonly status: string } | null;
  readonly queued: readonly unknown[];
  readonly faulted: boolean;
}

export interface PresentationAgentEvent {
  readonly type: "operation_open" | "presentation.event";
  readonly operationId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly envelope?: DataAgentEventEnvelope;
}

type PresentationListener = (event: PresentationAgentEvent) => void;
type ObservationListener = (observation: RuntimeObservation) => void;

type OperationBinding = ProjectedOperation & { readonly operationId: string };

/**
 * Session-owned Presentation facet. Pi event decoding lives here, beside the
 * Transcript projector, rather than in Application Host or the public Runtime.
 * It emits a semantic envelope only; no Pi event type crosses the host seam.
 */
export class PiTranscriptFacet {
  private readonly bindings = new Map<string, OperationBinding>();
  private readonly listeners = new Set<PresentationListener>();
  private readonly observationListeners = new Set<ObservationListener>();
  private readonly projector: TranscriptProjector;
  private readonly unsubscribe: Array<() => void> = [];
  private sequence = 1;

  constructor(
    private readonly harness: AgentHarness<any>,
    private readonly sessionId: string,
    openOperations: readonly { readonly operationId: string; readonly requestId?: string }[] = [],
  ) {
    for (const operation of openOperations) {
      this.bindings.set(operation.operationId, {
        operationId: operation.operationId,
        runId: operation.operationId,
        requestId: operation.requestId ?? operation.operationId,
        sessionId,
      });
    }
    this.projector = new TranscriptProjector({
      resolve: (event) => {
        const operationId = typeof event.operationId === "string"
          ? event.operationId
          : typeof event.runId === "string" ? event.runId : undefined;
        if (!operationId) return undefined;
        const binding = this.bindings.get(operationId);
        if (!binding) {
          this.bindings.set(operationId, { operationId, runId: operationId, requestId: operationId, sessionId });
        }
        return { operationId, operation: this.bindings.get(operationId)! };
      },
      nextSequence: () => this.sequence++,
      emit: (envelope) => this.emit({ type: "presentation.event", sessionId, requestId: envelope.requestId, ...(envelope.runId ? { operationId: envelope.runId } : {}), envelope }),
      onTerminal: (operationId) => this.bindings.delete(operationId),
    });
    this.attachNativeEvents();
  }

  publish(event: DataAgentEvent, requestId = "presentation"): void {
    this.emit({ type: "presentation.event", sessionId: this.sessionId, requestId, envelope: {
      protocolVersion: 1,
      sequence: this.sequence++,
      requestId,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      event,
    } });
  }

  bindOperation(operationId: string, requestId?: string): void {
    if (!operationId) return;
    this.bindings.set(operationId, { operationId, runId: operationId, requestId: requestId ?? operationId, sessionId: this.sessionId });
  }

  subscribe(listener: PresentationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeObservations(listener: ObservationListener): () => void {
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
  }

  async snapshot(): Promise<TranscriptSnapshot> {
    const lane = await this.harness.lane("main", TODO_CONTEXT);
    const watch = await lane.watch(TODO_CONTEXT);
    const snapshot = watch.snapshot;
    watch.unsubscribe();
    return {
      sessionId: this.sessionId,
      lane: snapshot.lane,
      tipId: snapshot.tipId,
      transcript: snapshot.transcript,
      operation: snapshot.operation ? { id: snapshot.operation.id, kind: snapshot.operation.kind, startedAt: snapshot.operation.startedAt, status: snapshot.operation.status } : null,
      queued: snapshot.queues,
      faulted: snapshot.faulted,
    };
  }

  async messages(): Promise<readonly TranscriptMessage[]> {
    const snapshot = await this.snapshot();
    const userEntryIds = snapshot.transcript.flatMap((value) => {
      const entry = asRecord(value);
      return entry?.type === "message" && asRecord(entry.message)?.role === "user" && typeof entry.id === "string" ? [entry.id] : [];
    });
    const labels = await Promise.all(userEntryIds.map((id) => this.harness.getLabel(id, TODO_CONTEXT)));
    const hidden = new Set(userEntryIds.filter((_, index) => isRuntimeInjected(labels[index])));
    return transcriptMessagesFromSnapshot(snapshot, hidden);
  }

  close(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.listeners.clear();
    this.observationListeners.clear();
    this.projector.clear();
    this.bindings.clear();
  }

  private attachNativeEvents(): void {
    this.unsubscribe.push(this.harness.events.on("run_start", (event) => {
      this.observe(event);
      if (!this.bindings.has(event.runId)) this.bindOperation(event.runId);
    }));
    this.unsubscribe.push(this.harness.events.on("run_resume", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("run_suspend", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("operation_abort", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("turn_start", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("turn_end", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("message_start", (event) => {
      this.observe(event);
      this.project({ type: "message_start", runId: event.runId, message: event.message });
    }));
    this.unsubscribe.push(this.harness.events.on("message_update", (event) => {
      this.observe(event);
      this.project({ type: "message_update", runId: event.runId, message: event.message, assistantMessageEvent: event.event });
    }));
    this.unsubscribe.push(this.harness.events.on("message_end", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("tool_start", (event) => {
      this.observe(event);
      this.project({ type: "tool_execution_start", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    }));
    this.unsubscribe.push(this.harness.events.on("tool_update", (event) => {
      this.observe(event);
      this.project({ type: "tool_execution_update", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult });
    }));
    this.unsubscribe.push(this.harness.events.on("tool_end", (event) => {
      this.observe(event);
      this.project({ type: "tool_execution_end", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, args: undefined });
    }));
    this.unsubscribe.push(this.harness.events.on("usage", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("entry_added", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("queue_update", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("retry_scheduled", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("retry_start", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("retry_end", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("fault", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("handler_error", (event) => this.observe(event)));
    this.unsubscribe.push(this.harness.events.on("run_end", (event) => {
      this.observe(event);
      this.project(event.status === "failed"
        ? { type: "agent_error", runId: event.runId, error: event.error.message }
        : { type: "agent_end", runId: event.runId, aborted: event.status === "aborted" });
    }));
  }

  private observe(event: HarnessEvent): void {
    const observation: RuntimeObservation = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      observedAt: Date.now(),
      event,
    };
    for (const listener of this.observationListeners) listener(observation);
  }

  private project(event: AgentRuntimeEvent): void {
    const operationId = typeof event.runId === "string" ? event.runId : undefined;
    if (operationId && !this.bindings.has(operationId)) this.bindOperation(operationId);
    this.projector.project(event);
  }

  private emit(event: PresentationAgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
