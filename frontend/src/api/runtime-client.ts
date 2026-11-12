/**
 * Shared-transport client for the Renderer.
 * Wraps @data-agent/transport so every feature call goes through the versioned
 * command contract — Electron IPC or HTTP, selected once at startup.
 */
import {
  createHttpTransport,
  createIpcTransport,
  type DataAgentTransport,
  type ElectronCommandBridge,
  type FetchLike,
} from "@data-agent/transport";
import type {
  DataAgentCommand,
  DataAgentCommandEnvelope,
  DataAgentResponseEnvelope,
} from "@data-agent/contracts";
import { apiFetch, type SessionSnapshotMessage } from "./client";

let sequence = 0;

function envelope(command: DataAgentCommand, sessionId?: string): DataAgentCommandEnvelope {
  sequence += 1;
  return {
    protocolVersion: 1,
    requestId: `renderer-${Date.now()}-${sequence}`,
    ...(sessionId ? { sessionId } : {}),
    command,
  } as DataAgentCommandEnvelope;
}

export interface RuntimeClient {
  dispatch(command: DataAgentCommand, sessionId?: string): Promise<DataAgentResponseEnvelope>;
  /** Subscribe to runtime events via the Host bridge (Electron) or SSE (Web). */
  onEvent?(listener: (event: unknown) => void, sessionId?: string): () => void;
}

export function createElectronRuntimeClient(bridge: ElectronCommandBridge): RuntimeClient {
  const transport: DataAgentTransport = createIpcTransport(bridge);
  const client: RuntimeClient = {
    dispatch: (command, sessionId) => transport.dispatch(envelope(command, sessionId)) as unknown as Promise<DataAgentResponseEnvelope>,
  };
  if (bridge.subscribe) client.onEvent = (listener, sessionId) => bridge.subscribe!(listener, sessionId);
  return client;
}

export function createHttpRuntimeClient(baseUrl: string, fetchLike: typeof fetch = apiFetch): RuntimeClient {
  const transport: DataAgentTransport = createHttpTransport(baseUrl, fetchLike as unknown as FetchLike);
  return {
    dispatch: (command, sessionId) => transport.dispatch(envelope(command, sessionId)) as unknown as Promise<DataAgentResponseEnvelope>,
  };
}

/** Picks the transport once: Electron bridge when present, otherwise HTTP. */
export function selectRuntimeClient(options: { electronBridge?: ElectronCommandBridge; httpBaseUrl?: string; fetchLike?: typeof fetch }): RuntimeClient {
  if (options.electronBridge) return createElectronRuntimeClient(options.electronBridge);
  return createHttpRuntimeClient(options.httpBaseUrl ?? "", options.fetchLike);
}

let selected: RuntimeClient | undefined;

/** Process-lifetime client: Electron bridge when window.dataAgentRuntime exists, else HTTP. */
export function getRuntimeClient(): RuntimeClient {
  if (selected) return selected;
  const bridge = window.dataAgentRuntime;
  const electronBridge: ElectronCommandBridge | undefined = bridge && typeof bridge.invokeRuntimeCommand === "function"
    ? { invoke: (_channel, payload) => bridge.invokeRuntimeCommand(payload), subscribe: bridge.subscribeRuntimeEvents }
    : undefined;
  const configuredBase = import.meta.env.VITE_API_BASE_URL;
  const httpBaseUrl = typeof configuredBase === "string" ? configuredBase.trim().replace(/\/$/, "") : "";
  selected = selectRuntimeClient({ ...(electronBridge ? { electronBridge } : {}), httpBaseUrl });
  return selected;
}

// ── Feature-level helpers over versioned commands ──────────────────────────

export async function listTasksViaRuntime(): Promise<Array<{ id: string; name: string; createdAt?: number; updatedAt?: number }>> {
  const envelope = await getRuntimeClient().dispatch({ type: "task.list" });
  const result = envelope.response;
  if (result.type !== "list.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.items as Array<{ id: string; name: string; createdAt?: number; updatedAt?: number }>;
}


export async function listSessionsViaRuntime(taskId?: string): Promise<Array<{ id: string; taskId?: string; name: string }>> {
  const envelope = await getRuntimeClient().dispatch({ type: "session.list", ...(taskId ? { taskId } : {}) });
  const result = envelope.response;
  if (result.type !== "list.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.items as Array<{ id: string; taskId?: string; name: string }>;
}

export async function createSessionViaRuntime(taskId: string, name?: string): Promise<{ id: string; taskId?: string; name?: string; createdAt?: number }> {
  const envelope = await getRuntimeClient().dispatch({ type: "session.create", taskId, ...(name ? { name } : {}) });
  const result = envelope.response;
  if (result.type !== "mutation.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.item as { id: string; taskId?: string; name?: string; createdAt?: number };
}



export async function readKnowledgeViaRuntime(path: string): Promise<string> {
  const envelope = await getRuntimeClient().dispatch({ type: "knowledge.read", path });
  const result = envelope.response;
  if (result.type !== "knowledge.read.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.content;
}

export async function stopAgentViaRuntime(sessionId?: string, operationId?: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "agent.stop", ...(operationId ? { operationId } : {}) }, sessionId);
}

export async function steerAgentViaRuntime(prompt: string, sessionId?: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "agent.steer", prompt }, sessionId);
}

export async function renameSessionViaRuntime(sessionId: string, name: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "session.rename", sessionId, name });
}

export async function deleteSessionViaRuntime(sessionId: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "session.delete", sessionId });
}

export async function renameTaskViaRuntime(taskId: string, name: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "task.rename", taskId, name });
}

export async function deleteTaskViaRuntime(taskId: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "task.delete", taskId });
}
export async function createTaskWithIdViaRuntime(name: string): Promise<{ id: string; name: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: 'task.create', name });
  const result = envelope.response;
  if (result.type !== 'mutation.result') throw new Error('UNEXPECTED_RESPONSE');
  return result.item as { id: string; name: string };
}



export async function listKnowledgeViaRuntime(): Promise<Array<{ path: string; size: number; modifiedAt: number; knowledgeId?: string; name?: string; description?: string; usage?: "method" | "fact"; readOnly?: boolean; hasContent?: boolean }>> {
  const envelope = await getRuntimeClient().dispatch({ type: "knowledge.list" });
  const result = envelope.response;
  if (result.type !== "knowledge.list.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.files;
}

export async function saveKnowledgeViaRuntime(path: string, content: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "knowledge.save", path, content });
}

export interface RuntimeSkillInfo { name: string; description: string; tools?: string[] }

export async function listSkillsViaRuntime(): Promise<RuntimeSkillInfo[]> {
  const envelope = await getRuntimeClient().dispatch({ type: "skills.list" });
  const result = envelope.response;
  if (result.type !== "skills.list.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.skills;
}

export async function getMcpConfigViaRuntime(): Promise<{ servers: Array<Record<string, unknown>> }> {
  const envelope = await getRuntimeClient().dispatch({ type: "mcp.config.get" });
  const result = envelope.response;
  if (result.type !== "mcp.config.result") throw new Error("UNEXPECTED_RESPONSE");
  const cfg = (result.config ?? {}) as { servers?: Array<Record<string, unknown>> };
  return { servers: cfg.servers ?? [] };
}

export async function saveMcpConfigViaRuntime(config: { servers: Array<Record<string, unknown>> }): Promise<void> {
  await getRuntimeClient().dispatch({ type: "mcp.config.save", config });
}

export async function answerClarificationViaRuntime(clarificationId: string, answer: string, sessionId?: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "clarification.answer", clarificationId, answer }, sessionId);
}

export interface RuntimeEventStreamOptions {
  /** The server subscription exists; events emitted from now on will arrive. */
  readonly onConnected?: () => void;
  /**
   * The subscriber must reload a snapshot: events after the cursor were
   * evicted, or the cursor came from a server process that has since restarted.
   */
  readonly onResync?: (reason: RuntimeResyncReason) => void;
  /**
   * The stream (re)connected, dropped and is about to reconnect, or has been
   * down long enough that the server is likely gone ("disconnected"; it keeps
   * retrying and reports "connected" when the server is back).
   */
  readonly onConnectionChange?: (state: RuntimeConnectionState) => void;
  /** Resume after this event sequence, e.g. the cursor of a session snapshot. */
  readonly afterSequence?: number;
  /** The server instance that issued afterSequence, so a restart since is recognized. */
  readonly afterInstance?: string;
}

/**
 * "rejected": the server refused the subscription (signed out, or no access to
 * the session, 401/403); retrying cannot help, so the stream stops.
 */
export type RuntimeConnectionState = "connected" | "reconnecting" | "disconnected" | "rejected";
export type RuntimeResyncReason = "evicted" | "restarted";

/** Statuses retrying cannot change. A 404 is left to retry: a proxy may answer it while the server restarts. */
const REJECTED_STATUSES = new Set([401, 403]);

/** The data of a hello or resync event, its fields checked. */
interface StreamControl {
  readonly instanceId?: string;
  readonly latestSequence?: number;
  readonly reason?: RuntimeResyncReason;
}

function readStreamControl(data: string): StreamControl {
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    value = parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  const latest = value.latestSequence;
  return {
    ...(typeof value.instanceId === "string" ? { instanceId: value.instanceId } : {}),
    ...(typeof latest === "number" && Number.isSafeInteger(latest) && latest >= 0 ? { latestSequence: latest } : {}),
    ...(value.reason === "restarted" || value.reason === "evicted" ? { reason: value.reason } : {}),
  };
}

/** Reconnect delays back off from half a second to five. */
const RECONNECT_FIRST_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;
/** Down this long, the stream reports "disconnected" instead of "reconnecting". */
export const DISCONNECTED_AFTER_MS = 30_000;

export function subscribeRuntimeEvents(
  listener: (envelope: unknown) => void,
  sessionId?: string,
  options: RuntimeEventStreamOptions = {},
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const runtimeClient = getRuntimeClient();
  if (runtimeClient.onEvent) {
    // The Electron bridge subscribes synchronously and never drops events.
    const unsubscribe = runtimeClient.onEvent(listener, sessionId);
    options.onConnected?.();
    return unsubscribe;
  }

  const configuredBase = import.meta.env.VITE_API_BASE_URL;
  const base = typeof configuredBase === "string" ? configuredBase.trim().replace(/\/$/, "") : "";
  let disposed = false;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  // The cursor is a sequence of one server instance: sequences restart with the process.
  let lastSequence = options.afterSequence ?? 0;
  let hasCursor = options.afterSequence !== undefined;
  let instanceId = options.afterInstance;
  let reconnectDelay = RECONNECT_FIRST_DELAY_MS;
  let lostSince: number | undefined;
  /** The instance this connection's hello named, adopted once the cursor belongs to it. */
  let connectionInstance: string | undefined;
  /** Data arrived: the stream is up, so the backoff starts over. */
  const markUp = (): void => {
    if (lostSince === undefined && reconnectDelay === RECONNECT_FIRST_DELAY_MS) return;
    reconnectDelay = RECONNECT_FIRST_DELAY_MS;
    lostSince = undefined;
    options.onConnectionChange?.("connected");
  };
  /**
   * The server's first event: which instance it is and where its events stand.
   * A restart since the cursor is the server's to report, with a resync; until
   * that resync arrives the cursor still belongs to the old instance, so the
   * new one is not adopted (a connection lost in between asks again).
   */
  const greet = (control: StreamControl): void => {
    if (control.instanceId === undefined || control.latestSequence === undefined) return;
    connectionInstance = control.instanceId;
    if (!hasCursor) {
      // A fresh subscription follows from now on.
      lastSequence = control.latestSequence;
      hasCursor = true;
    }
    instanceId ??= control.instanceId;
    options.onConnectionChange?.("connected");
    reconnectDelay = RECONNECT_FIRST_DELAY_MS;
    lostSince = undefined;
  };
  const connect = async (): Promise<void> => {
    if (disposed) return;
    const endpoint = new URL(`${base}/api/runtime/events`, window.location.href);
    if (sessionId) endpoint.searchParams.set("session_id", sessionId);
    if (hasCursor) endpoint.searchParams.set("after_sequence", String(lastSequence));
    if (instanceId) endpoint.searchParams.set("instance", instanceId);
    controller = new AbortController();
    connectionInstance = undefined;
    try {
      const response = await apiFetch(endpoint, { headers: { Accept: "text/event-stream" }, signal: controller.signal });
      if (REJECTED_STATUSES.has(response.status)) {
        options.onConnectionChange?.("rejected");
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Runtime event stream failed: ${response.status}`);
      options.onConnected?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n");
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (eventName === "hello") {
            greet(readStreamControl(data));
          } else if (eventName === "resync") {
            // The snapshot the subscriber reloads covers everything up to the server's
            // latest event, so the stream resumes after it, on this connection's instance.
            const control = readStreamControl(data);
            if (control.latestSequence !== undefined) { lastSequence = control.latestSequence; hasCursor = true; }
            if (connectionInstance !== undefined) instanceId = connectionInstance;
            options.onResync?.(control.reason ?? "evicted");
          } else if (data) {
            markUp();
            deliver(data);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) scheduleReconnect();
      return;
    }
    if (!disposed) scheduleReconnect();
  };
  const scheduleReconnect = (): void => {
    lostSince ??= Date.now();
    options.onConnectionChange?.(Date.now() - lostSince >= DISCONNECTED_AFTER_MS ? "disconnected" : "reconnecting");
    reconnectTimer = setTimeout(() => { void connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
  };
  /** The cursor advances only past events the listener accepted, so a failed one is replayed on reconnect. */
  const deliver = (data: string): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      return; // Malformed payload; the chat adapter validates envelopes anyway.
    }
    try {
      listener(payload);
    } catch (error) {
      console.error("[runtime-events] event listener failed", error);
      return;
    }
    if (payload && typeof payload === "object" && typeof (payload as { sequence?: unknown }).sequence === "number") {
      lastSequence = Math.max(lastSequence, (payload as { sequence: number }).sequence);
      hasCursor = true;
    }
  };
  void connect();
  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    controller?.abort();
    controller = undefined;
  };
}

export { sendChatViaRuntime, type RuntimeChatHandle } from "./chat-events";

export async function prepareSessionViaRuntime(sessionId: string): Promise<void> {
  await getRuntimeClient().dispatch({ type: "session.prepare", sessionId });
}

export interface RuntimeMcpServerStatus { name: string; enabled: boolean; connected: boolean; toolCount: number; hostManaged: boolean }

export async function getMcpServersViaRuntime(): Promise<RuntimeMcpServerStatus[]> {
  const envelope = await getRuntimeClient().dispatch({ type: "mcp.servers.status" });
  const result = envelope.response;
  if (result.type !== "mcp.servers.status.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.servers;
}

export async function testMcpServerViaRuntime(name: string): Promise<{ ok: boolean; message: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: "mcp.server.test", name });
  const result = envelope.response;
  if (result.type !== "mcp.server.test.result") throw new Error("UNEXPECTED_RESPONSE");
  return { ok: result.ok, message: result.message };
}

export async function restartMcpServerViaRuntime(name: string): Promise<void> {
  const envelope = await getRuntimeClient().dispatch({ type: "mcp.server.restart", name });
  if (envelope.response.type !== "mcp.server.restart.result") throw new Error("UNEXPECTED_RESPONSE");
}

export async function getConfigViaRuntime(): Promise<Record<string, unknown>> {
  const envelope = await getRuntimeClient().dispatch({ type: "config.get" });
  if (envelope.response.type !== "config.get.result") throw new Error("UNEXPECTED_RESPONSE");
  return (envelope.response as unknown as { config: Record<string, unknown> }).config;
}

export async function saveConfigViaRuntime(patch: Record<string, unknown>): Promise<void> {
  await getRuntimeClient().dispatch({ type: "config.save", patch });
}

export async function testPythonRuntimeViaRuntime(mode: 'bundled' | 'external', executable?: string): Promise<{ success: boolean; message: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: "python.runtime.test", mode, ...(executable ? { executable } : {}) });
  return envelope.response as unknown as { success: boolean; message: string };
}

export async function testDbViaRuntime(connection: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: "db.test", connection });
  return envelope.response as unknown as { success: boolean; message: string };
}

/** Creates the demo sales database on the runtime's machine and makes it the saved connection. */
export async function createSampleDatabaseViaRuntime(): Promise<{ success: boolean; message: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: "db.sample" });
  return envelope.response as unknown as { success: boolean; message: string };
}

export async function testLlmViaRuntime(profile: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
  const envelope = await getRuntimeClient().dispatch({ type: "llm.test", profile });
  return envelope.response as unknown as { success: boolean; message: string };
}


export type RuntimeTranscriptMessage = SessionSnapshotMessage & { timestamp?: number };

export async function getTranscriptViaRuntime(sessionId: string): Promise<RuntimeTranscriptMessage[]> {
  const envelope = await getRuntimeClient().dispatch({ type: "session.transcript", sessionId });
  if (envelope.response.type !== "session.transcript.result") throw new Error("UNEXPECTED_RESPONSE");
  return (envelope.response as unknown as { messages: RuntimeTranscriptMessage[] }).messages;
}

export interface RuntimeSessionState {
  readonly messages: RuntimeTranscriptMessage[];
  readonly inProgressRun: { readonly runId: string; readonly startedAt: number } | null;
  readonly pendingClarification: { readonly clarificationId: string; readonly question: string; readonly options: string[] } | null;
  readonly eventSequence: number;
  /** The server instance that issued eventSequence. */
  readonly eventInstance?: string;
}

/** The transcript plus what is still in progress: a running run and the clarification it waits on. */
export async function getSessionStateViaRuntime(sessionId: string): Promise<RuntimeSessionState> {
  const envelope = await getRuntimeClient().dispatch({ type: "session.transcript", sessionId });
  if (envelope.response.type !== "session.transcript.result") throw new Error("UNEXPECTED_RESPONSE");
  const response = envelope.response as unknown as Partial<RuntimeSessionState> & { messages: RuntimeTranscriptMessage[] };
  return {
    messages: response.messages,
    inProgressRun: response.inProgressRun ?? null,
    pendingClarification: response.pendingClarification ?? null,
    eventSequence: response.eventSequence ?? 0,
    ...(response.eventInstance ? { eventInstance: response.eventInstance } : {}),
  };
}

/** Refresh live views of a dashboard in the session's workspace (ADR-0010); the Runtime reads the file itself. */
export async function refreshDashboardViaRuntime(path: string, viewIds: string[], sessionId: string): Promise<{ datasets: unknown; sources: unknown; checks: unknown }> {
  const envelope = await getRuntimeClient().dispatch({ type: "dashboard.refresh", path, viewIds }, sessionId);
  if (envelope.response.type !== "dashboard.refresh.result") throw new Error("UNEXPECTED_RESPONSE");
  const response = envelope.response as unknown as { datasets: unknown; sources: unknown; checks: unknown };
  return { datasets: response.datasets, sources: response.sources, checks: response.checks };
}


// ── Channels (ADR-0011) ───────────────────────────────────────────────────────

export type ChannelStatusView = Extract<DataAgentResponseEnvelope["response"], { type: "channel.list.result" }>["channels"][number];

async function channelCommand(command: Extract<DataAgentCommand, { type: "channel.list" | "channel.provision" | "channel.disconnect" | "channel.configure" }>): Promise<ChannelStatusView[]> {
  const result = (await getRuntimeClient().dispatch(command)).response;
  if (result.type !== "channel.list.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.channels;
}

export const listChannelsViaRuntime = () => channelCommand({ type: "channel.list" });
/** Starts scan-to-connect; the returned status carries the link to show as a QR code. */
export const provisionChannelViaRuntime = (channelId: string) => channelCommand({ type: "channel.provision", channelId });
export const disconnectChannelViaRuntime = (channelId: string) => channelCommand({ type: "channel.disconnect", channelId });
export type ReplyDetailView = NonNullable<ChannelStatusView["settings"]>["replyDetail"];
/** Switches a bot on or off, or changes how much of a run it sends. */
export const configureChannelViaRuntime = (channelId: string, settings: { enabled?: boolean; replyDetail?: ReplyDetailView }) => channelCommand({ type: "channel.configure", channelId, ...settings });

/** A one-time code to send to the bot as `/bind <code>`, linking that IM identity to the signed-in account. */
export async function createChannelBindCodeViaRuntime(): Promise<{ code: string; expiresAt: number }> {
  const result = (await getRuntimeClient().dispatch({ type: "channel.bind_code" })).response;
  if (result.type !== "channel.bind_code.result") throw new Error("UNEXPECTED_RESPONSE");
  return { code: result.code, expiresAt: result.expiresAt };
}

export type ChannelAccessView = Extract<DataAgentResponseEnvelope["response"], { type: "channel.access.result" }>["access"];
type ChannelActorView = ChannelAccessView["members"][number]["actor"];

async function accessCommand(command: Extract<DataAgentCommand, { type: "channel.access.list" | "channel.access.decide" | "channel.access.revoke" }>): Promise<ChannelAccessView> {
  const result = (await getRuntimeClient().dispatch(command)).response;
  if (result.type !== "channel.access.result") throw new Error("UNEXPECTED_RESPONSE");
  return result.access;
}

export const listChannelAccessViaRuntime = () => accessCommand({ type: "channel.access.list" });
export const decideChannelAccessViaRuntime = (requestId: string, decision: "allow" | "deny") => accessCommand({ type: "channel.access.decide", requestId, decision });
export const revokeChannelAccessViaRuntime = (actor: ChannelActorView) => accessCommand({ type: "channel.access.revoke", actor });

