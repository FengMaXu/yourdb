import { randomUUID } from "node:crypto";
import {
  DataAgentEventEnvelopeSchema,
  DataAgentResponseEnvelopeSchema,
  ProtocolVersion,
  RequestContextSchema,
  type DataAgentCommandEnvelope,
  type DataAgentEventEnvelope,
  type DataAgentResponseEnvelope,
  type RequestContext,
} from "@data-agent/contracts";
import { Value } from "typebox/value";
import { MetadataStore } from "./metadata.js";
import path from "node:path";
import { WorkspaceStore } from "./workspace.js";
import { formatPromptWithAttachments, type PromptAttachment } from "./attachments.js";
import { runPythonJob } from "./python-job.js";
import { KnowledgeIndex } from "./knowledge.js";
import { ClarificationManager } from "./clarification.js";
import { AgentControllerError } from "./facets/agent-controller.js";
import { loadSkillsFromRoots, resolveSkillRoots } from "./skills.js";
import { LocalAuthService } from "./auth.js";
import type { ApplicationAgentEvent } from "./application/host.js";
import type { ApplicationCommandHost, ApplicationEventFilter, EventReplay } from "./application/protocol-host.js";
import type { TranscriptMessage } from "./facets/transcript.js";
import { readBoundedFile } from "./bounded-read.js";
import { ensureSampleDatabase } from "./sample-database.js";
import type { McpPluginPort } from "./tools/mcp-plugins.js";
import { asRecord } from "./primitives.js";

export class DataAgentRuntimeError extends Error {
  readonly code: "INVALID_COMMAND" | "UNSUPPORTED_PROTOCOL_VERSION" | "INVALID_CONTEXT" | "SESSION_ACCESS_DENIED" | "SESSION_BUSY" | "CLARIFICATION_SETTLED";
  readonly details?: unknown;

  constructor(
    code: DataAgentRuntimeError["code"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "DataAgentRuntimeError";
    this.code = code;
    this.details = details;
  }
}

export type DataAgentEventListener = (event: DataAgentEventEnvelope) => void;
type EventSubscription = { readonly listener: DataAgentEventListener; readonly filter?: ApplicationEventFilter };

export interface RuntimeSessionStore {
  create?(metadata?: Record<string, unknown>): Promise<unknown>;
  list(): Promise<readonly unknown[]>;
  open(metadata: unknown): Promise<{ getEntries(): Promise<readonly unknown[]> }>;
}

type RuntimeAgentContext = { sessionId?: string; operationId?: string; requestId?: string; userId?: string };

type RuntimeAgent = {
  prompt(text: string, context?: RuntimeAgentContext): Promise<unknown>;
  steer?(text: string, context?: RuntimeAgentContext): void | Promise<unknown>;
  followUp?(text: string, context?: RuntimeAgentContext): void | Promise<unknown>;
  abort?(context?: RuntimeAgentContext): void | Promise<unknown>;
  requestAbort?(operationId: string, context?: RuntimeAgentContext): void | Promise<unknown>;
  subscribe?(listener: (event: ApplicationAgentEvent) => void): () => void;
  getTranscript?(context?: RuntimeAgentContext): Promise<readonly TranscriptMessage[]>;
  getExecutionSnapshot?(context?: RuntimeAgentContext): Promise<{ readonly current: { readonly id: string; readonly startedAt: number } | null }>;
  answerClarification?(clarificationId: string, answer: string, context?: RuntimeAgentContext): Promise<boolean>;
  getResources?(): { skills?: readonly unknown[]; promptTemplates?: readonly unknown[] };
  setResources?(resources: { skills?: readonly unknown[]; promptTemplates?: readonly unknown[] }): Promise<void>;
  refreshDashboard?(request: { path: string; viewIds: readonly string[]; requestId: string }, context?: RuntimeAgentContext): Promise<{ datasets: unknown; sources: unknown; checks: unknown; notices: unknown }>;
};

const DESKTOP_SECRET_CONFIG_FIELDS = ["api_key", "openai_api_key", "anthropic_api_key"] as const;

function sanitizeConfigForHost(value: unknown, host: RequestContext["host"]): Record<string, unknown> {
  const config = typeof value === "object" && value !== null ? { ...(value as Record<string, unknown>) } : {};
  if (host === "electron") {
    for (const field of DESKTOP_SECRET_CONFIG_FIELDS) delete config[field];
  }
  return config;
}

export class DataAgentRuntime implements ApplicationCommandHost {
  private readonly listeners = new Set<EventSubscription>();
  private readonly eventBuffer: DataAgentEventEnvelope[] = [];
  private readonly eventOwners = new Map<number, string | undefined>();
  private readonly sessionOwners = new Map<string, string>();
  private readonly metadata: MetadataStore | undefined;
  /** Auth is owned by the command host and injected into transports through a narrow seam. */
  readonly authService: LocalAuthService;
  private sessions: RuntimeSessionStore | undefined;
  private readonly workspace: WorkspaceStore | undefined;
  private pythonExecutable: string | undefined;
  private readonly bundledPythonExecutable: string | undefined;
  private readonly knowledge: KnowledgeIndex | undefined;
  private readonly knowledgeRoot: string | undefined;
  private readonly skillRoots: string[];
  queryExecutor?: { run(sql: string, rowLimit: number, options?: { readonly idempotencyKey?: string }): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> };
  dbTester?: { test(connection: Record<string, unknown>): Promise<{ success: boolean; message: string; details?: unknown }> };
  llmTester?: { test(profile: Record<string, unknown>): Promise<{ success: boolean; message: string; details?: unknown }> };
  /** The model profile a chat would use now; lets `llm.test` with an empty profile check the saved settings, keys included. */
  savedModelProfile?: (context: RequestContext) => Promise<Record<string, unknown>>;
  /** Where the demo database is created; without it `db.sample` is unavailable. */
  sampleDatabaseRoot?: string;
  /** Host callback for capability controllers after config changes. */
  onConfigSaved?: (config: Record<string, unknown>, context: RequestContext) => void | Promise<void>;
  /** The host's MCP plugin supervisor; without one, plugin settings are only stored. */
  mcpSupervisor?: Pick<McpPluginPort, "view" | "save" | "status" | "test" | "restart">;
  /** Host-composed channel management (ADR-0011); absent where no channels are enabled. */
  channelControl?: { list(): import("@data-agent/contracts").ChannelStatus[]; provision(channelId: string, userId: string): Promise<import("@data-agent/contracts").ChannelStatus[]>; disconnect(channelId: string): Promise<import("@data-agent/contracts").ChannelStatus[]>; configure(channelId: string, settings: { enabled?: boolean; replyDetail?: import("@data-agent/contracts").ReplyDetail }): Promise<import("@data-agent/contracts").ChannelStatus[]>; createLinkCode(userId: string): Promise<{ code: string; expiresAt: number }>; access(): Promise<import("@data-agent/contracts").ChannelAccess>; decideAccess(requestId: string, decision: "allow" | "deny", decidedBy: string): Promise<unknown>; revokeAccess(actor: import("@data-agent/contracts").ChannelActor): Promise<void> };
  private readonly clarifications: ClarificationManager;
  /** Host composition seam for wiring native AgentHarness tools. */
  get clarificationManager(): ClarificationManager { return this.clarifications; }
  /** Correlation only: Pi owns the operation lifecycle and durable state. */
  private nextSequence = 1;
  /** Event sequences restart with the process; this tells one process's cursors from another's. */
  private readonly instanceId = randomUUID();
  private agent: RuntimeAgent | undefined;

  constructor(options: { metadata?: MetadataStore; sessions?: RuntimeSessionStore; workspace?: WorkspaceStore; pythonExecutable?: string; bundledPythonExecutable?: string; knowledge?: KnowledgeIndex; knowledgeRoot?: string; skillRoots?: string[]; projectRoot?: string; packagedRoot?: string; clarifications?: ClarificationManager; agent?: RuntimeAgent } = {}) {
    this.metadata = options.metadata;
    this.authService = new LocalAuthService(this.metadata);
    this.sessions = options.sessions;
    this.workspace = options.workspace;
    this.pythonExecutable = options.pythonExecutable;
    this.bundledPythonExecutable = options.bundledPythonExecutable ?? options.pythonExecutable;
    this.knowledge = options.knowledge;
    this.knowledgeRoot = options.knowledgeRoot;
    this.skillRoots = options.skillRoots ?? resolveSkillRoots({
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.packagedRoot ? { packagedRoot: options.packagedRoot } : {}),
    });
    this.clarifications = options.clarifications ?? new ClarificationManager();
    this.clarifications.subscribe({
      asked: (request) => {
        this.emit({ protocolVersion: ProtocolVersion, sequence: this.nextSequence++, requestId: "clarification", timestamp: Date.now(), sessionId: request.sessionId, event: { type: "clarification.request", clarificationId: request.clarificationId, question: request.question, options: request.options } }, this.sessionOwners.get(request.sessionId));
      },
      settled: (clarificationId, outcome, settledContext) => {
        this.emit({ protocolVersion: ProtocolVersion, sequence: this.nextSequence++, requestId: "clarification", timestamp: Date.now(), ...(settledContext?.sessionId ? { sessionId: settledContext.sessionId } : {}), event: { type: "clarification.settled", clarificationId, outcome } }, settledContext?.sessionId ? this.sessionOwners.get(settledContext.sessionId) : undefined);
      },
    });
    this.agent = options.agent;
    this.agent?.subscribe?.((event) => this.receiveApplicationEvent(event));
  }

  get pythonExecutablePath(): string | undefined { return this.pythonExecutable; }

  /**
   * Replays buffered events after a cursor. The buffer is bounded, so a cursor
   * older than its first retained event means events were lost; `complete`
   * then tells the transport to have the client resynchronize from a snapshot.
   * A cursor from another process is the transport's to detect, by instance.
   */
  replayAfter(sequence: number, filter?: ApplicationEventFilter): EventReplay {
    const first = this.eventBuffer[0]?.sequence ?? this.nextSequence;
    return {
      events: this.eventBuffer.filter((event) => event.sequence > sequence && this.eventVisible(event, filter)),
      complete: sequence >= first - 1,
    };
  }

  eventStreamPosition(): { readonly instanceId: string; readonly latestSequence: number } {
    return { instanceId: this.instanceId, latestSequence: this.nextSequence - 1 };
  }

  subscribe(listener: DataAgentEventListener, filter?: ApplicationEventFilter): () => void {
    const subscription: EventSubscription = { listener, ...(filter ? { filter } : {}) };
    this.listeners.add(subscription);
    return () => this.listeners.delete(subscription);
  }

  async dispatch(
    command: DataAgentCommandEnvelope,
    context: RequestContext,
  ): Promise<DataAgentResponseEnvelope> {
    this.assertContext(context);
    if (context.sessionId) {
      const owner = this.sessionOwners.get(context.sessionId);
      if (owner && owner !== context.userId) throw new DataAgentRuntimeError("SESSION_ACCESS_DENIED", "Session belongs to another user");
      this.sessionOwners.set(context.sessionId, context.userId);
    }

    if (command.protocolVersion !== ProtocolVersion) {
      throw new DataAgentRuntimeError(
        "UNSUPPORTED_PROTOCOL_VERSION",
        `Unsupported protocol version: ${command.protocolVersion}`,
        { supported: ProtocolVersion },
      );
    }

    if (command.command.type === "workspace.list" || command.command.type === "workspace.read" || command.command.type === "workspace.write" || command.command.type === "workspace.delete") {
      if (!this.workspace) throw new DataAgentRuntimeError("INVALID_COMMAND", "Workspace is not configured");
      this.workspace.assertAccess(context);
      if (command.command.type === "workspace.list") return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "workspace.result", operation: "list", files: await this.workspace.list() } };
      if (command.command.type === "workspace.read") {
        try {
          const result = await this.workspace.readRange(command.command.path, {
            ...(command.command.startLine !== undefined ? { startLine: command.command.startLine } : {}),
            ...(command.command.endLine !== undefined ? { endLine: command.command.endLine } : {}),
          });
          return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "workspace.result", operation: "read", path: command.command.path, content: result.content } };
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("INVALID_LINE_RANGE:")) throw new DataAgentRuntimeError("INVALID_COMMAND", error.message);
          throw error;
        }
      }
      if (command.command.type === "workspace.delete") { await this.workspace.delete(command.command.path); return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "workspace.result", operation: "write", path: command.command.path } }; }
      await this.workspace.write(command.command.path, command.command.content);
      this.emit({ protocolVersion: ProtocolVersion, sequence: this.nextSequence++, requestId: command.requestId, ...(context.sessionId ? { sessionId: context.sessionId } : {}), timestamp: Date.now(), event: { type: "workspace.artifact.created", path: command.command.path, kind: "file" } }, context.userId);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "workspace.result", operation: "write", path: command.command.path } };
    }

    if (command.command.type === "clarification.answer") {
      // An answer counts only from the Session that asked; ids of other Sessions' questions are not a capability.
      if (context.sessionId && this.clarifications.pendingFor(context.sessionId)?.clarificationId !== command.command.clarificationId) {
        throw new DataAgentRuntimeError("CLARIFICATION_SETTLED", "No such clarification is pending in this session");
      }
      const answered = this.agent?.answerClarification
        ? await this.agent.answerClarification(command.command.clarificationId, command.command.answer, { ...(context.sessionId ? { sessionId: context.sessionId } : {}), userId: context.userId })
        : this.clarifications.answer(command.command.clarificationId, command.command.answer);
      if (!answered) throw new DataAgentRuntimeError("CLARIFICATION_SETTLED", "Unknown or already settled clarification");
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "runtime.probe.result", service: "data-agent-runtime", runtimeVersion: "0.1.0" } };
    }

    if (command.command.type === "mcp.config.get" || command.command.type === "mcp.config.save") {
      const saved = command.command.type === "mcp.config.save" ? (command.command as { config: unknown }).config : undefined;
      if (this.mcpSupervisor) {
        // The supervisor validates the save and never returns secrets.
        const config = command.command.type === "mcp.config.save"
          ? await this.mcpSupervisor.save(saved).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            throw message.startsWith("MCP_CONFIG_INVALID") ? new DataAgentRuntimeError("INVALID_COMMAND", message) : error;
          })
          : await this.mcpSupervisor.view();
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "mcp.config.result", config } };
      }
      if (command.command.type === "mcp.config.save") await this.metadata!.setConfig("mcp.config", saved);
      const config = (await this.metadata!.getConfig("mcp.config")) ?? null;
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "mcp.config.result", config } };
    }
    if (command.command.type === "skills.list") {
      const roots = this.skillRoots;
      const loaded = await loadSkillsFromRoots(roots);
      for (const item of loaded.diagnostics) console.warn(`[data-agent] Skill diagnostic (${item.code ?? "warning"}) ${item.path}: ${item.message}`);
      if (this.agent?.setResources) {
        const previous = this.agent.getResources?.() ?? {};
        await this.agent.setResources({ ...previous, skills: loaded.skills });
      }
      const skills: Array<{ name: string; description: string; tools: string[] }> = loaded.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        tools: skill.allowedTools ?? [],
      }));
      const diagnostics = loaded.diagnostics.map((item) => ({ path: item.path, message: item.message }));
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "skills.list.result", skills, diagnostics } };
    }
    if (command.command.type === "dashboard.refresh") {
      // ADR-0010: the page names views only; the session reads the file and refreshes through Answering.
      if (!this.agent?.refreshDashboard) throw new DataAgentRuntimeError("INVALID_COMMAND", "DASHBOARD_REFRESH_NOT_CONFIGURED");
      if (!context.sessionId) throw new DataAgentRuntimeError("INVALID_COMMAND", "DASHBOARD_REFRESH_SESSION_REQUIRED");
      const result = await this.agent.refreshDashboard({ path: command.command.path, viewIds: command.command.viewIds, requestId: command.requestId }, { sessionId: context.sessionId, userId: context.userId });
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "dashboard.refresh.result", ...result } };
    }
    if (command.command.type === "config.get" || command.command.type === "config.save") {
      if (command.command.type === "config.save") await this.saveSettings({ ...((command.command as { patch: Record<string, unknown> }).patch) }, context);
      const config = sanitizeConfigForHost(await this.metadata!.getConfig("ui.settings"), context.host);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "config.get.result", config } };
    }
    if (command.command.type === "db.sample") {
      if (!this.sampleDatabaseRoot) throw new DataAgentRuntimeError("INVALID_COMMAND", "SAMPLE_DATABASE_NOT_CONFIGURED");
      try {
        const database = ensureSampleDatabase(this.sampleDatabaseRoot);
        await this.saveSettings({ driver: "sqlite", database }, context);
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: true, message: "已连接示例销售库", details: { database } } };
      } catch (error) {
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: false, message: `示例库创建失败: ${error instanceof Error ? error.message : String(error)}` } };
      }
    }
    if (command.command.type === "python.runtime.test") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const executable = (command.command as { executable?: string }).executable || this.pythonExecutable || "python";
      try {
        const { stdout } = await execFileAsync(executable, ["--version"], { timeout: 15000 });
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: true, message: stdout.trim() } };
      } catch (error) {
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: false, message: error instanceof Error ? error.message : String(error) } };
      }
    }
    if (command.command.type === "db.test") {
      if (!this.dbTester) throw new DataAgentRuntimeError("INVALID_COMMAND", "DB_TESTER_NOT_CONFIGURED");
      const result = await this.dbTester.test((command.command as { connection: Record<string, unknown> }).connection);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: result.success, message: result.message } };
    }
    if (command.command.type === "llm.test") {
      if (!this.llmTester) throw new DataAgentRuntimeError("INVALID_COMMAND", "LLM_TESTER_NOT_CONFIGURED");
      const given = (command.command as { profile: Record<string, unknown> }).profile;
      // An empty profile means "the model chats use now", which on the desktop includes a key the renderer never sees.
      let profile = given;
      if (Object.keys(given).length === 0 && this.savedModelProfile) {
        try {
          profile = await this.savedModelProfile(context);
        } catch (error) {
          return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: false, message: error instanceof Error ? error.message : String(error) } };
        }
      }
      const result = await this.llmTester.test(profile);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "test.result", success: result.success, message: result.message, details: result.details } };
    }
    if (command.command.type === "channel.access.list" || command.command.type === "channel.access.decide" || command.command.type === "channel.access.revoke") {
      if (!this.channelControl) throw new DataAgentRuntimeError("INVALID_COMMAND", "CHANNELS_NOT_CONFIGURED");
      const c = command.command;
      // A signed-in user decides as themselves; the transport has authenticated them.
      if (c.type === "channel.access.decide") await this.channelControl.decideAccess(c.requestId, c.decision, context.userId);
      if (c.type === "channel.access.revoke") await this.channelControl.revokeAccess(c.actor);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "channel.access.result", access: await this.channelControl.access() } };
    }
    if (command.command.type === "channel.bind_code") {
      if (!this.channelControl) throw new DataAgentRuntimeError("INVALID_COMMAND", "CHANNELS_NOT_CONFIGURED");
      // The code links to whoever asked for it; the transport has already authenticated them.
      const { code, expiresAt } = await this.channelControl.createLinkCode(context.userId);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "channel.bind_code.result", code, expiresAt } };
    }
    if (command.command.type === "channel.configure") {
      if (!this.channelControl) throw new DataAgentRuntimeError("INVALID_COMMAND", "CHANNELS_NOT_CONFIGURED");
      const { channelId, enabled, replyDetail } = command.command;
      const channels = await this.channelControl.configure(channelId, { ...(enabled !== undefined ? { enabled } : {}), ...(replyDetail ? { replyDetail } : {}) });
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "channel.list.result", channels } };
    }
    if (command.command.type === "channel.list" || command.command.type === "channel.provision" || command.command.type === "channel.disconnect") {
      if (!this.channelControl) throw new DataAgentRuntimeError("INVALID_COMMAND", "CHANNELS_NOT_CONFIGURED");
      const c = command.command;
      const channels = c.type === "channel.list" ? this.channelControl.list() : c.type === "channel.provision" ? await this.channelControl.provision(c.channelId, context.userId) : await this.channelControl.disconnect(c.channelId);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "channel.list.result", channels } };
    }

    if (command.command.type === "mcp.servers.status") {
      if (!this.mcpSupervisor) throw new DataAgentRuntimeError("INVALID_COMMAND", "MCP_SUPERVISOR_NOT_CONFIGURED");
      const servers = await this.mcpSupervisor.status();
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "mcp.servers.status.result", servers } };
    }
    if (command.command.type === "mcp.server.test" || command.command.type === "mcp.server.restart") {
      if (!this.mcpSupervisor) throw new DataAgentRuntimeError("INVALID_COMMAND", "MCP_SUPERVISOR_NOT_CONFIGURED");
      if (command.command.type === "mcp.server.test") {
        const result = await this.mcpSupervisor.test((command.command as { name: string }).name);
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "mcp.server.test.result", ok: result.ok, message: result.message } };
      }
      const result = await this.mcpSupervisor.restart((command.command as { name: string }).name);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "mcp.server.restart.result", ok: result.ok } };
    }
    if (command.command.type === "session.transcript") {
      if (!this.agent?.getTranscript) throw new DataAgentRuntimeError("INVALID_COMMAND", "SESSION_TRANSCRIPT_NOT_CONFIGURED");
      const agentContext = { sessionId: command.command.sessionId, userId: context.userId };
      // Read the cursor first: events after it are delivered to a resuming client, so nothing between is lost.
      const eventSequence = this.nextSequence - 1;
      const [transcript, execution] = await Promise.all([
        this.agent.getTranscript(agentContext),
        this.agent.getExecutionSnapshot?.(agentContext),
      ]);
      const current = execution?.current;
      const pending = this.clarifications.pendingFor(command.command.sessionId);
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: {
        type: "session.transcript.result",
        messages: [...transcript],
        inProgressRun: current ? { runId: current.id, startedAt: current.startedAt } : null,
        pendingClarification: pending ? { clarificationId: pending.clarificationId, question: pending.question, options: [...pending.options] } : null,
        eventSequence,
        eventInstance: this.instanceId,
      } };
    }
    if (command.command.type === "session.prepare") {
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "runtime.probe.result", service: "data-agent-runtime", runtimeVersion: "0.1.0" } };
    }
    if (command.command.type === "python.run") {
      if (!this.pythonExecutable) throw new DataAgentRuntimeError("INVALID_COMMAND", "Python runtime is not configured");
      if (!context.sessionId) throw new DataAgentRuntimeError("INVALID_CONTEXT", "Python jobs require a session workspace");
      const result = await runPythonJob(command.command.code, { workspace: context.sessionId, executable: this.pythonExecutable });
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "python.result", jobId: result.jobId, status: result.status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, scriptPath: result.scriptPath, durationMs: result.durationMs } };
    }

    if (command.command.type === "knowledge.search" || command.command.type === "knowledge.read" || command.command.type === "knowledge.list" || command.command.type === "knowledge.save") {
      if (command.command.type === "knowledge.save" && !this.knowledgeRoot) throw new DataAgentRuntimeError("INVALID_COMMAND", "Knowledge root is not configured");
      if (!this.knowledgeRoot && command.command.type !== "knowledge.save") throw new DataAgentRuntimeError("INVALID_COMMAND", "Knowledge index is not configured");
      const { resolve: resolvePath, join: joinPath } = await import("node:path");
      if (this.knowledge) await this.knowledge.reload(this.knowledgeRoot as string);
      if (command.command.type === "knowledge.search") return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "knowledge.search.result", hits: this.knowledge!.search(command.command.query) } };
      if (command.command.type === "knowledge.list") {
        const { readdir, stat } = await import("node:fs/promises");
        const files: Array<{ path: string; size: number; modifiedAt: number; knowledgeId?: string; name?: string; description?: string; usage?: "method" | "fact"; readOnly?: boolean; hasContent?: boolean }> = [];
        const catalog = new Map((this.knowledge?.catalog() ?? []).map((entry) => [entry.path.split(path.sep).join("/"), entry]));
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = dir + "/" + entry.name;
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith(".md")) {
              const info = await stat(full);
              const relativePath = full.slice((this.knowledgeRoot as string).length + 1).split(path.sep).join("/");
              const entry = catalog.get(relativePath);
              files.push({
                path: relativePath,
                size: info.size,
                modifiedAt: info.mtimeMs,
                ...(entry ? { knowledgeId: entry.knowledgeId, name: entry.name, description: entry.description, usage: entry.usage ?? "fact", hasContent: entry.hasContent } : {}),
              });
            }
          }
        };
        await walk(this.knowledgeRoot as string);
        // Built-in documents live outside the user root and are listed read-only.
        for (const entry of catalog.values()) {
          if (!entry.readOnly) continue;
          const location = this.knowledge!.locate(entry.path);
          if (!location) continue;
          const info = await stat(path.join(location.root, entry.path));
          files.push({ path: entry.path, size: info.size, modifiedAt: info.mtimeMs, knowledgeId: entry.knowledgeId, name: entry.name, description: entry.description, usage: entry.usage ?? "fact", readOnly: true, hasContent: entry.hasContent });
        }
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "knowledge.list.result", files } };
      }
      if (command.command.type === "knowledge.save") {
        const requestedPath = command.command.path.replaceAll("\\", "/");
        if (requestedPath === ".pi" || requestedPath.startsWith(".pi/")) {
          throw new DataAgentRuntimeError("INVALID_COMMAND", "SYSTEM_PROMPT_IMMUTABLE");
        }
        if (this.knowledge?.isBuiltinPath(requestedPath)) throw new DataAgentRuntimeError("INVALID_COMMAND", "KNOWLEDGE_BUILTIN_READ_ONLY");
        const { writeFile, mkdir } = await import("node:fs/promises");
        const root = resolvePath(this.knowledgeRoot as string);
        const target = resolvePath(joinPath(root, command.command.path));
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
          throw new DataAgentRuntimeError("INVALID_COMMAND", "Knowledge path escapes root");
        }
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, command.command.content, "utf8");
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "knowledge.save.result", path: command.command.path } };
      }
      const root = resolvePath(this.knowledge?.locate(command.command.path)?.root ?? (this.knowledgeRoot as string));
      const target = resolvePath(joinPath(root, command.command.path));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new DataAgentRuntimeError("INVALID_COMMAND", "Knowledge path escapes root");
      try {
        const result = await readBoundedFile(root, command.command.path, {
          ...(command.command.startLine !== undefined ? { startLine: command.command.startLine } : {}),
          ...(command.command.endLine !== undefined ? { endLine: command.command.endLine } : {}),
        });
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "knowledge.read.result", path: command.command.path, content: result.content } };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("INVALID_LINE_RANGE:")) throw new DataAgentRuntimeError("INVALID_COMMAND", error.message);
        throw error;
      }
    }

    if (command.command.type === "agent.steer" || command.command.type === "agent.follow_up") {
      if (!this.agent) throw new DataAgentRuntimeError("INVALID_COMMAND", "Pi Agent is not configured");
      const method = command.command.type === "agent.steer" ? this.agent.steer : this.agent.followUp;
      if (!method) throw new DataAgentRuntimeError("INVALID_COMMAND", "Agent queue operation is not configured");
      await method.call(this.agent, command.command.prompt, { ...(context.sessionId ? { sessionId: context.sessionId } : {}), userId: context.userId });
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "agent.prompt.accepted", runId: "queued" } };
    }
    if (command.command.type === "agent.stop") {
      if (!this.agent) throw new DataAgentRuntimeError("INVALID_COMMAND", "Pi Agent is not configured");
      if (command.command.operationId && this.agent.requestAbort) {
        await this.agent.requestAbort(command.command.operationId, { ...(context.sessionId ? { sessionId: context.sessionId } : {}), operationId: command.command.operationId, userId: context.userId });
        return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "agent.prompt.accepted", runId: command.command.operationId } };
      }
      if (!this.agent.abort) throw new DataAgentRuntimeError("INVALID_COMMAND", "Agent abort operation is not configured");
      await this.agent.abort({ ...(context.sessionId ? { sessionId: context.sessionId } : {}), userId: context.userId });
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "agent.prompt.accepted", runId: "stopped" } };
    }

    if (command.command.type === "agent.prompt") {
      if (!this.agent) throw new DataAgentRuntimeError("INVALID_COMMAND", "Pi Agent is not configured");
      const attachments = await this.resolveAttachments(command.command.attachments ?? [], context);
      let result: unknown;
      try {
        result = await this.agent.prompt(formatPromptWithAttachments(command.command.prompt, attachments), { ...(context.sessionId ? { sessionId: context.sessionId } : {}), requestId: command.requestId, userId: context.userId });
      } catch (error) {
        // A queued steer or follow-up is the caller's choice, so a busy Session is reported, not queued here.
        if (error instanceof AgentControllerError && error.busy) throw new DataAgentRuntimeError("SESSION_BUSY", "Session is already running an operation");
        throw error;
      }
      const operationId = asRecord(result)?.operationId;
      if (typeof operationId !== "string" || !operationId) throw new DataAgentRuntimeError("INVALID_COMMAND", "Agent did not return an operation identity");
      return { protocolVersion: ProtocolVersion, requestId: command.requestId, response: { type: "agent.prompt.accepted", runId: operationId } };
    }

    if (command.command.type !== "runtime.probe") {
      if (!this.metadata) throw new DataAgentRuntimeError("INVALID_COMMAND", "Metadata store is not configured");
      const c = command.command;
      const userId = context.userId;
      if (c.type === "task.create") return this.mutation(command.requestId, "task", await this.metadata.call(c.type, userId, { idValue: MetadataStore.createId(), name: c.name }));
      if (c.type === "task.list") return this.list(command.requestId, "task", await this.metadata.call(c.type, userId));
      if (c.type === "task.rename" || c.type === "task.delete") return this.mutation(command.requestId, "task", await this.metadata.call(c.type, userId, c));
      if (c.type === "session.create") {
        const item = await this.metadata.call(c.type, userId, { ...c, idValue: MetadataStore.createId() });
        if (this.sessions?.create) await this.sessions.create({ userId, taskId: c.taskId, sessionId: item.id });
        return this.mutation(command.requestId, "session", item);
      }
      if (c.type === "session.list") return this.list(command.requestId, "session", await this.metadata.call(c.type, userId, c));
      if (c.type === "session.rename" || c.type === "session.delete") return this.mutation(command.requestId, "session", await this.metadata.call(c.type, userId, c));
      throw new DataAgentRuntimeError("INVALID_COMMAND", "Unsupported DataAgent command");
    }

    const response: DataAgentResponseEnvelope = {
      protocolVersion: ProtocolVersion,
      requestId: command.requestId,
      response: {
        type: "runtime.probe.result",
        service: "data-agent-runtime",
        runtimeVersion: "0.1.0",
      },
    };

    if (!Value.Check(DataAgentResponseEnvelopeSchema, response)) {
      throw new DataAgentRuntimeError("INVALID_COMMAND", "Runtime produced an invalid response");
    }

    this.emit({
      protocolVersion: ProtocolVersion,
      sequence: this.nextSequence++,
      requestId: command.requestId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      timestamp: Date.now(),
      event: {
        type: "runtime.probe.completed",
        service: "data-agent-runtime",
      },
    }, context.userId);

    return response;
  }

  /** Checks each attached file exists in the Session workspace; a missing one rejects the prompt rather than reaching the model. */
  /** Merges a settings patch, keeping desktop keys out of the store, then lets the host react. */
  private async saveSettings(patch: Record<string, unknown>, context: RequestContext): Promise<void> {
    const current = sanitizeConfigForHost(await this.metadata!.getConfig("ui.settings"), context.host);
    for (const field of DESKTOP_SECRET_CONFIG_FIELDS) {
      if (typeof patch[field] === "string" && patch[field].trim() === "" && typeof current[field] === "string" && current[field] !== "") {
        delete patch[field];
      }
    }
    const next: Record<string, unknown> = { ...current, ...patch };
    if (context.host === "electron") {
      for (const field of DESKTOP_SECRET_CONFIG_FIELDS) delete next[field];
    }
    await this.metadata!.setConfig("ui.settings", next);
    const pythonConfig = asRecord(patch.python_runtime);
    if (pythonConfig) {
      this.pythonExecutable = pythonConfig.mode === "external" && typeof pythonConfig.executable === "string" && pythonConfig.executable.trim()
        ? pythonConfig.executable
        : this.bundledPythonExecutable;
    }
    await this.onConfigSaved?.(next, context);
  }

  private async resolveAttachments(requested: readonly { path: string }[], context: RequestContext): Promise<PromptAttachment[]> {
    if (requested.length === 0) return [];
    if (!this.workspace) throw new DataAgentRuntimeError("INVALID_COMMAND", "Workspace is not configured");
    if (!context.sessionId) throw new DataAgentRuntimeError("INVALID_CONTEXT", "Attachments require a session workspace");
    this.workspace.assertAccess(context);
    const workspace = await this.workspace.scoped(context.sessionId);
    const paths = [...new Set(requested.map((item) => item.path))];
    return Promise.all(paths.map(async (path) => {
      try {
        return { path, size: (await workspace.artifact(path)).size };
      } catch {
        throw new DataAgentRuntimeError("INVALID_COMMAND", `ATTACHMENT_NOT_FOUND: ${path}`);
      }
    }));
  }

  /**
   * The protocol adapter only republishes already-projected Presentation
   * events. Pi events, operation ownership and transcript interpretation stay
   * inside the Session Host; this class has no operation-state mirror.
   */
  private receiveApplicationEvent(event: ApplicationAgentEvent): void {
    if (event.type !== "presentation.event" || !event.envelope) return;
    this.emit({ ...event.envelope, sequence: this.nextSequence++, ...(event.sessionId ? { sessionId: event.sessionId } : {}) }, event.userId);
  }

  /** Attach an agent adapter after construction; lifecycle remains Pi-owned. */
  attachSessionStore(store: RuntimeSessionStore): void { this.sessions = store; }

  attachAgent(agent: RuntimeAgent): void {
    this.agent = agent;
    agent.subscribe?.((event) => this.receiveApplicationEvent(event));
  }

  private mutation(requestId: string, entity: "task" | "session", item: unknown): DataAgentResponseEnvelope { return { protocolVersion: ProtocolVersion, requestId, response: { type: "mutation.result", entity, item: item as never } }; }
  private list(requestId: string, entity: "task" | "session", items: unknown): DataAgentResponseEnvelope { return { protocolVersion: ProtocolVersion, requestId, response: { type: "list.result", entity, items: items as never[] } }; }

  private assertContext(context: RequestContext): void {
    if (!Value.Check(RequestContextSchema, context)) {
      throw new DataAgentRuntimeError("INVALID_CONTEXT", "Invalid request context");
    }
  }

  private eventVisible(event: DataAgentEventEnvelope, filter?: ApplicationEventFilter): boolean {
    if (!filter) return true;
    const owner = this.eventOwners.get(event.sequence);
    if (filter.userId && owner !== filter.userId) return false;
    return !filter.sessionId || event.sessionId === filter.sessionId;
  }

  private emit(event: DataAgentEventEnvelope, ownerId?: string): void {
    if (!Value.Check(DataAgentEventEnvelopeSchema, event)) {
      throw new DataAgentRuntimeError("INVALID_COMMAND", "Runtime produced an invalid event");
    }
    this.eventBuffer.push(event);
    this.eventOwners.set(event.sequence, ownerId);
    if (this.eventBuffer.length > 256) {
      const removed = this.eventBuffer.shift();
      if (removed) this.eventOwners.delete(removed.sequence);
    }
    for (const subscription of this.listeners) {
      if (this.eventVisible(event, subscription.filter)) subscription.listener(event);
    }
  }
}

/** Test-only entrypoint for the protocol adapter and its storage fixtures. */
export { WorkspaceStore } from "./workspace.js";
export { MetadataStore } from "./metadata.js";
export { MetadataChannelStore } from "./channels/store.js";
export { ClarificationManager } from "./clarification.js";
export { AgentControllerError } from "./facets/agent-controller.js";
export { KnowledgeIndex } from "./knowledge.js";
export { DataAgentSessionApplication } from "./application/host.js";
export { JevHypothesisChoiceAdvisor } from "./adapters/jev-hypothesis-choice-advisor.js";
