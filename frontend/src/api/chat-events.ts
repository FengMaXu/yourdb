import { isDataAgentEventEnvelope, type DataAgentEvent } from "@data-agent/contracts";
import { subscribeRuntimeEvents, getRuntimeClient, type RuntimeEventStreamOptions } from "./runtime-client";
import type { SSEEvent, WidgetSpec } from "./client";

export interface RuntimeChatHandle {
  /** Stop the run and the stream. */
  cancel: () => void;
  /** Stop following the stream only; the run continues on the server. */
  detach: () => void;
  /** The run being followed, once the server has accepted it. */
  runId: () => string | undefined;
  finished: Promise<void>;
}

const STREAM_CONNECT_WAIT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWidgetKind(value: unknown): value is WidgetSpec["kind"] {
  return value === "kpi"
    || value === "metric_cards"
    || value === "table"
    || value === "chart"
    || value === "steps"
    || value === "rich_text"
    || value === "echarts"
    || value === "file_link";
}

function isWidgetSpec(value: unknown): value is WidgetSpec {
  return isRecord(value)
    && typeof value.widget_id === "string"
    && typeof value.title === "string"
    && isWidgetKind(value.kind);
}

/** The text content of a tool result, shown as the tool call's output. */
function readableToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text");
      if (text && typeof (text as { text?: unknown }).text === "string") return (text as { text: string }).text;
    }
  }
  return JSON.stringify(result ?? null) ?? String(result);
}

/**
 * Maps one versioned Runtime event to the chat event model the renderer
 * consumes.
 */
export function mapRuntimeEvent(event: DataAgentEvent, activeMessageId: string): { event: SSEEvent; messageId?: string } | null {
  switch (event.type) {
    case "agent.message_started": {
      const messageId = event.messageId || `msg-${Date.now()}`;
      return { event: { type: "message_start", message_id: messageId }, messageId };
    }
    case "agent.text_delta":
      return { event: { type: "text_delta", message_id: activeMessageId, content: event.delta } };
    case "agent.thinking_delta":
      return { event: { type: "reasoning_delta", message_id: activeMessageId, content: event.delta } };
    case "agent.tool_started":
      return {
        event: {
          type: "tool_call",
          message_id: activeMessageId,
          tool_call_id: event.toolCallId,
          name: event.toolName,
          arguments: event.args,
        },
      };
    case "agent.tool_progress":
      if (event.progress.kind !== "subagent") return null;
      return {
        event: {
          type: "subagent_progress",
          message_id: activeMessageId,
          tool_call_id: event.toolCallId,
          name: event.toolName,
          children: event.progress.children,
        },
      };
    case "widget":
      if (!isWidgetSpec(event.widget)) return null;
      return {
        event: {
          type: "widget",
          message_id: event.messageId,
          tool_call_id: event.toolCallId,
          widget_id: event.widgetId,
          tool_name: event.toolName,
          widget: event.widget,
        },
      };
    case "widget_done":
      return {
        event: {
          type: "widget_done",
          message_id: event.messageId,
          tool_call_id: event.toolCallId,
          widget_id: event.widgetId,
        },
      };
    case "widget_error":
      return {
        event: {
          type: "widget_error",
          message_id: event.messageId,
          tool_call_id: event.toolCallId,
          widget_id: event.widgetId,
          error: event.error,
        },
      };
    case "agent.tool_finished": {
      const details = isRecord(event.result) ? event.result.details : undefined;
      const widgetId = isRecord(details) && details.widgetId !== undefined
        ? String(details.widgetId)
        : undefined;
      return {
        event: {
          type: "tool_result",
          message_id: activeMessageId,
          tool_call_id: event.toolCallId,
          name: event.toolName,
          ...(event.args !== undefined ? { arguments: event.args } : {}),
          content: readableToolResult(event.result),
          details,
          widget_id: widgetId,
          is_error: event.isError,
        },
      };
    }
    case "clarification.request":
      return {
        event: {
          type: "clarification_request",
          clarification_id: event.clarificationId,
          question: event.question,
          options: event.options,
        },
      };
    case "clarification.settled":
      return {
        event: {
          type: "clarification_settled",
          clarification_id: event.clarificationId,
          outcome: event.outcome,
        },
      };
    case "workspace.artifact.created":
      return { event: { type: "workspace_updated", tool: "" } };
    case "agent.completed":
      return { event: { type: "done", reason: event.outcome === "failed" ? "error" : event.outcome ?? "completed" } };
    default:
      return null;
  }
}

function readRuntimeEnvelope(raw: unknown): { event: DataAgentEvent; sessionId?: string } | null {
  if (!isDataAgentEventEnvelope(raw)) return null;
  return {
    event: raw.event,
    sessionId: raw.sessionId,
  };
}

export type ChatStreamOptions = Pick<RuntimeEventStreamOptions, "onResync" | "onConnectionChange">;

/**
 * Transitional bridge: consumes versioned runtime event envelopes over the
 * shared transport and adapts them to the renderer's chat event model. The
 * adapter dissolves when ChatArea renders versioned events natively.
 */
export function sendChatViaRuntime(
  prompt: string,
  onEvent: (event: SSEEvent) => void,
  onError: (err: unknown) => void,
  onFinish: () => void,
  sessionId?: string,
  stream: ChatStreamOptions = {},
  attachments: readonly string[] = [],
): RuntimeChatHandle {
  return streamRuntimeChat({ onEvent, onError, onFinish, sessionId, stream }, async () => {
    const accepted = await getRuntimeClient().dispatch({
      type: "agent.prompt",
      prompt,
      ...(attachments.length > 0 ? { attachments: attachments.map((path) => ({ path })) } : {}),
    }, sessionId);
    return accepted.response.type === "agent.prompt.accepted" ? accepted.response.runId : undefined;
  });
}

/**
 * Follows a run that was already running when the session was opened: events
 * resume after the snapshot's cursor and the run is stoppable by its id.
 */
export function attachRunViaRuntime(
  runId: string,
  cursor: { readonly sequence: number; readonly instance?: string },
  onEvent: (event: SSEEvent) => void,
  onError: (err: unknown) => void,
  onFinish: () => void,
  sessionId?: string,
  stream: ChatStreamOptions = {},
): RuntimeChatHandle {
  return streamRuntimeChat({ onEvent, onError, onFinish, sessionId, stream, afterSequence: cursor.sequence, ...(cursor.instance ? { afterInstance: cursor.instance } : {}) }, async () => runId);
}

function streamRuntimeChat(
  handlers: {
    readonly onEvent: (event: SSEEvent) => void;
    readonly onError: (err: unknown) => void;
    readonly onFinish: () => void;
    readonly sessionId?: string;
    readonly stream: ChatStreamOptions;
    readonly afterSequence?: number;
    readonly afterInstance?: string;
  },
  start: () => Promise<string | undefined>,
): RuntimeChatHandle {
  const { onEvent, onError, onFinish, sessionId, stream } = handlers;
  let activeMessageId = "";
  let operationId: string | undefined;
  let isDone = false;
  const toolArgumentsById = new Map<string, unknown>();

  const handleFinish = () => {
    if (isDone) return;
    isDone = true;
    unsubscribe();
    onFinish();
  };

  // The run starts only once the stream is subscribed, so its first events cannot be missed.
  let markConnected!: () => void;
  const connected = new Promise<void>((resolve) => { markConnected = resolve; });
  const unsubscribe = subscribeRuntimeEvents((raw) => {
    const envelope = readRuntimeEnvelope(raw);
    if (!envelope) return;
    const { event, sessionId } = envelope;

    // Runtime replay envelopes carry the session identity needed to discard
    // events from another session in ChatArea. Keep the widget-aware mapping
    // centralized so native widget lifecycle events remain intact.
    const toolCallId = event.type === "agent.tool_finished"
      ? event.toolCallId
      : "";
    let eventForMapping: DataAgentEvent = event;
    if (event.type === "agent.tool_finished" && event.args === undefined) {
      eventForMapping = { ...event, args: toolArgumentsById.get(toolCallId) ?? {} };
    }
    if (event.type === "agent.tool_started") {
      toolArgumentsById.set(event.toolCallId, event.args);
    }

    const mapped = mapRuntimeEvent(eventForMapping, activeMessageId);
    if (!mapped) return;
    if (mapped.messageId !== undefined) activeMessageId = mapped.messageId;
    const adapted = sessionId
      ? { ...mapped.event, session_id: sessionId } as SSEEvent
      : mapped.event;
    onEvent(adapted);
    if (event.type === "agent.tool_finished") toolArgumentsById.delete(toolCallId);
    if (event.type === "agent.completed") handleFinish();
  }, sessionId, {
    ...stream,
    ...(handlers.afterSequence !== undefined ? { afterSequence: handlers.afterSequence } : {}),
    ...(handlers.afterInstance !== undefined ? { afterInstance: handlers.afterInstance } : {}),
    onConnected: () => markConnected(),
  });
  const finished = (async () => {
    try {
      // A stream that cannot connect must not block the prompt; its failure surfaces on dispatch.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, STREAM_CONNECT_WAIT_MS);
        void connected.then(() => { clearTimeout(timer); resolve(); });
      });
      if (isDone) return;
      operationId = await start();
    } catch (err) {
      onError(err);
      handleFinish();
    }
  })();
  return {
    cancel: () => {
      if (operationId) void getRuntimeClient().dispatch({ type: "agent.stop", operationId }, sessionId).catch(() => undefined);
      unsubscribe();
      handleFinish();
    },
    detach: () => {
      if (isDone) return;
      isDone = true;
      unsubscribe();
    },
    runId: () => operationId,
    finished,
  };
}
