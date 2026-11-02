import path from "node:path";
import type { ChannelConfig, ChannelProvider, DataAgentCommandEnvelope, DataAgentEventEnvelope, DataAgentResponseEnvelope, RequestContext } from "@data-agent/contracts";
import { ClarificationManager } from "../clarification.js";
import { KnowledgeIndex } from "../knowledge.js";
import { ensureKnowledgePlaceholders } from "../knowledge-seed.js";
import { MetadataStore } from "../metadata.js";
import { ChannelHub, type ChannelHubOptions } from "../channels/hub.js";
import { ChannelRegistry, type ChannelConfigStore, type ChannelRegistryOptions } from "../channels/registry.js";
import { MetadataChannelStore } from "../channels/store.js";
import { DataAgentRuntime } from "../protocol.js";
import { WorkspaceStore } from "../workspace.js";
import type { DataAgentModelProfile, SessionQueryExecutor } from "./session-runtime.js";
import {
  DataAgentSessionApplication,
  type ApplicationAgentAdapter,
  type ApplicationAgentEvent,
  type ApplicationResources,
  type HostRequestContext,
} from "./host.js";
import type { ApplicationAuthService, ApplicationCommandHost, ApplicationEventFilter, EventReplay } from "./protocol-host.js";
import { JevHypothesisChoiceAdvisor } from "../adapters/jev-hypothesis-choice-advisor.js";
import type { McpPluginPort } from "../tools/mcp-plugins.js";

export interface DataAgentApplicationOptions {
  readonly dataRoot: string;
  readonly host: "electron" | "web";
  readonly defaultUserId?: string;
  readonly knowledgeRoot?: string;
  /** Read-only roots holding built-in knowledge that ships with the application; earlier roots win on duplicate paths. */
  readonly builtinKnowledgeRoots?: readonly string[];
  readonly pythonExecutable?: string | (() => string | undefined);
  readonly bundledPythonExecutable?: string;
  readonly queryExecutor?: SessionQueryExecutor | (() => SessionQueryExecutor | Promise<SessionQueryExecutor>);
  readonly resolveProfile: (context: HostRequestContext, application: DataAgentApplication) => DataAgentModelProfile | Promise<DataAgentModelProfile>;
  readonly systemPrompt?: string;
  readonly systemPromptRoots?: readonly string[];
  readonly projectRoot?: string;
  readonly packagedRoot?: string;
  readonly skillRoots?: readonly string[];
  readonly enableDashboards?: boolean;
  readonly enableWidgets?: boolean;
  /** Opt in to bounded AgentHarness-native explorer/reviewer delegation. */
  readonly enableSubagents?: boolean | ((context: HostRequestContext, application: DataAgentApplication) => boolean | Promise<boolean>);
  /** Exact relative Markdown paths delegated children may inspect. */
  readonly delegationKnowledgePaths?: readonly string[];
  /** Opt-in Jev advisor; the key stays in the trusted host composition path. */
  readonly jevHypothesisComparison?: {
    readonly apiKey: string;
    readonly model?: string;
    readonly endpoint?: string;
    readonly timeoutMs?: number;
  };
}

export interface HostTestPorts {
  readonly dbTester?: { test(connection: Record<string, unknown>): Promise<{ success: boolean; message: string; details?: unknown }> };
  readonly llmTester?: { test(profile: Record<string, unknown>): Promise<{ success: boolean; message: string; details?: unknown }> };
}

/**
 * The product-level Application surface used by Electron and Web Hosts.
 * It routes transport commands to Session applications while keeping Pi and
 * concrete Answering stores behind this boundary.
 */
/** Saved channel configuration; it holds credentials, so no config.get response includes it. */
const CHANNEL_CONFIG_KEY = "channels";

export class DataAgentApplication implements ApplicationCommandHost {
  private queryExecutorPort: DataAgentApplicationOptions["queryExecutor"];
  private mcpPlugins: McpPluginPort | undefined;
  private closed = false;
  private channels: { readonly hub: ChannelHub; readonly registry: ChannelRegistry } | undefined;

  private constructor(
    private readonly runtime: DataAgentRuntime,
    private readonly sessions: DataAgentSessionApplication,
    private readonly metadata: MetadataStore,
    readonly workspace: WorkspaceStore,
    readonly knowledge: KnowledgeIndex,
    private readonly agent: ApplicationAgentAdapter,
    queryExecutor: DataAgentApplicationOptions["queryExecutor"],
  ) {
    this.queryExecutorPort = queryExecutor;
  }

  static async create(options: DataAgentApplicationOptions): Promise<DataAgentApplication> {
    const dataRoot = path.resolve(options.dataRoot);
    const workspaceUserId = options.defaultUserId ?? (options.host === "electron" ? "local" : undefined);
    const workspace = new WorkspaceStore(path.join(dataRoot, "workspace"), workspaceUserId ? { userId: workspaceUserId } : {});
    const knowledgeRoot = path.resolve(options.knowledgeRoot ?? path.join(dataRoot, "knowledge"));
    const seeded = await ensureKnowledgePlaceholders(knowledgeRoot);
    if (seeded.length > 0) console.info(`[data-agent] Created knowledge placeholders in ${knowledgeRoot}: ${seeded.join(", ")}`);
    const knowledge = new KnowledgeIndex({ requireMetadata: true });
    for (const builtinRoot of options.builtinKnowledgeRoots ?? []) await knowledge.loadDirectory(builtinRoot, { readOnly: true });
    await knowledge.loadDirectory(knowledgeRoot);
    for (const diagnostic of knowledge.diagnostics()) {
      console.warn(`[data-agent] Knowledge diagnostic (${diagnostic.code}) ${diagnostic.path}: ${diagnostic.message}`);
    }
    const metadata = new MetadataStore(path.join(dataRoot, "metadata", "app.db"));
    const clarifications = new ClarificationManager();
    const savedSettings = await metadata.getConfig("ui.settings");
    const pythonSettings = savedSettings && typeof savedSettings === "object" && !Array.isArray(savedSettings)
      ? (savedSettings as Record<string, unknown>).python_runtime
      : undefined;
    const configuredPython = pythonSettings && typeof pythonSettings === "object" && !Array.isArray(pythonSettings)
      && (pythonSettings as Record<string, unknown>).mode === "external"
      && typeof (pythonSettings as Record<string, unknown>).executable === "string"
      ? String((pythonSettings as Record<string, unknown>).executable).trim()
      : undefined;
    const initialPythonExecutable = configuredPython || (typeof options.pythonExecutable === "function" ? options.pythonExecutable() : options.pythonExecutable);
    let application!: DataAgentApplication;
    const subagentPolicy = options.enableSubagents;
    const hypothesisChoiceAdvisor = options.jevHypothesisComparison
      ? new JevHypothesisChoiceAdvisor(options.jevHypothesisComparison)
      : undefined;
    const sessions = new DataAgentSessionApplication({
      sessionRoot: path.join(dataRoot, "sessions"),
      workspace,
      knowledge,
      knowledgeRoot,
      pythonExecutable: () => application.pythonExecutablePath,
      queryExecutor: async () => {
        const port = application.queryExecutorPort;
        if (!port) throw new Error("QUERY_EXECUTOR_NOT_CONFIGURED");
        return typeof port === "function" ? port() : port;
      },
      mcpPluginTools: async () => application.mcpPlugins ? application.mcpPlugins.tools() : [],
      resultRoot: path.join(dataRoot, "results"),
      // doc/business.md is a canonical, model-unwritable document; its id cannot be reused by drafts.
      answeringEvidenceDocuments: { "business-definitions": "reviewed_definition" },
      ...(hypothesisChoiceAdvisor ? { hypothesisChoiceAdvisor } : {}),
      resolveProfile: (context) => options.resolveProfile(context, application),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.systemPromptRoots ? { systemPromptRoots: options.systemPromptRoots } : {}),
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.packagedRoot ? { packagedRoot: options.packagedRoot } : {}),
      ...(options.skillRoots ? { skillRoots: options.skillRoots } : {}),
      ...(options.enableDashboards !== undefined ? { enableDashboards: options.enableDashboards } : {}),
      ...(options.enableWidgets !== undefined ? { enableWidgets: options.enableWidgets } : {}),
      ...(subagentPolicy !== undefined ? {
        enableSubagents: typeof subagentPolicy === "function"
          ? (context: HostRequestContext) => subagentPolicy(context, application)
          : subagentPolicy,
      } : {}),
      delegationRoot: path.join(dataRoot, "subagents"),
      ...(options.delegationKnowledgePaths ? { delegationKnowledgePaths: options.delegationKnowledgePaths } : {}),
      clarifications,
      createMissingSessions: false,
      authorizeSession: async (request) => (await metadata.authorizeSession(request.userId, request.sessionId)) === "owned",
    });
    const runtime = new DataAgentRuntime({
      metadata,
      workspace,
      knowledge,
      knowledgeRoot,
      ...(initialPythonExecutable ? { pythonExecutable: initialPythonExecutable } : {}),
      ...(options.bundledPythonExecutable ? { bundledPythonExecutable: options.bundledPythonExecutable } : {}),
      ...(options.skillRoots ? { skillRoots: [...options.skillRoots] } : {}),
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.packagedRoot ? { packagedRoot: options.packagedRoot } : {}),
      clarifications,
    });
    const agent = sessions.createAgentAdapter({ ...(options.defaultUserId ? { userId: options.defaultUserId } : {}), host: options.host });
    application = new DataAgentApplication(runtime, sessions, metadata, workspace, knowledge, agent, options.queryExecutor);
    if (sessions.sessionStore) runtime.attachSessionStore(sessions.sessionStore);
    runtime.attachAgent(agent);
    if (options.queryExecutor) application.setQueryExecutor(options.queryExecutor);
    return application;
  }

  get authService(): ApplicationAuthService { return this.runtime.authService; }
  get pythonExecutablePath(): string | undefined { return this.runtime.pythonExecutablePath; }
  get clarificationManager(): ClarificationManager { return this.runtime.clarificationManager; }

  async dispatch(command: DataAgentCommandEnvelope, context: RequestContext): Promise<DataAgentResponseEnvelope> {
    const commandRecord = command.command as unknown as Record<string, unknown>;
    const sessionIds = [...new Set([
      command.sessionId,
      context.sessionId,
      typeof commandRecord.sessionId === "string" ? commandRecord.sessionId : undefined,
    ].filter((value): value is string => Boolean(value)))];
    for (const sessionId of sessionIds) {
      if (await this.metadata.authorizeSession(context.userId, sessionId) !== "owned") throw new Error("SESSION_ACCESS_DENIED");
    }
    return this.runtime.dispatch(command, context);
  }
  subscribe(listener: (event: DataAgentEventEnvelope) => void, filter?: ApplicationEventFilter): () => void { return this.runtime.subscribe(listener, filter); }
  replayAfter(sequence: number, filter?: ApplicationEventFilter): EventReplay { return this.runtime.replayAfter(sequence, filter); }
  eventStreamPosition(): { readonly instanceId: string; readonly latestSequence: number } { return this.runtime.eventStreamPosition(); }

  getConfig(key: string): Promise<unknown> { return this.metadata.getConfig(key); }
  setConfig(key: string, value: unknown): Promise<void> { return this.metadata.setConfig(key, value); }
  authorizeSession(userId: string, sessionId: string): Promise<"owned" | "missing" | "forbidden"> { return this.metadata.authorizeSession(userId, sessionId); }
  /** The channel boundary over this Application's protocol seam and metadata (ADR-0011). */
  /**
   * Enables channels on this host (ADR-0011): a hub over this Application's
   * protocol seam, and a registry that connects saved or fallback
   * configuration and serves the channel.* commands for the settings page.
   */
  async enableChannels(providers: readonly ChannelProvider[], options: Omit<ChannelHubOptions, "host" | "store" | "publications" | "dashboards"> & { readonly fallback?: ChannelRegistryOptions["fallback"] } = {}): Promise<ChannelRegistry> {
    if (this.channels) throw new Error("CHANNELS_ALREADY_ENABLED");
    const { fallback, ...hubOptions } = options;
    const hub = new ChannelHub({
      ...hubOptions,
      host: this,
      store: new MetadataChannelStore(this.metadata),
      publications: { read: (receiptId, context) => this.readPublication(receiptId, context) },
      dashboards: { read: (dashboardPath, context) => this.readDashboard(dashboardPath, context) },
    });
    const store: ChannelConfigStore = {
      load: async () => ((await this.metadata.getConfig(CHANNEL_CONFIG_KEY)) ?? {}) as Record<string, ChannelConfig>,
      save: (configs) => this.metadata.setConfig(CHANNEL_CONFIG_KEY, configs),
    };
    const registry = new ChannelRegistry(hub, store, providers, { ...(fallback ? { fallback } : {}), ...(hubOptions.onError ? { onError: hubOptions.onError } : {}) });
    this.channels = { hub, registry };
    this.runtime.channelControl = {
      list: () => registry.list(),
      provision: (channelId) => registry.provision(channelId),
      disconnect: (channelId) => registry.disconnect(channelId),
      createLinkCode: (userId) => hub.createLinkCode(userId),
      access: () => hub.access(),
      decideAccess: (requestId, decision, decidedBy) => hub.decideAccess(requestId, decision, decidedBy),
      revokeAccess: (actor) => hub.revokeAccess(actor),
    };
    await registry.start();
    return registry;
  }

  /** A dashboard page of a Session the user owns; nothing outside `dashboards/` is readable this way. */
  private async readDashboard(dashboardPath: string, context: { readonly userId: string; readonly sessionId: string }): Promise<Uint8Array> {
    if (!/^dashboards\/[^/\\]+\.html$/.test(dashboardPath)) throw new Error("DASHBOARD_PATH_INVALID");
    if (await this.metadata.authorizeSession(context.userId, context.sessionId) !== "owned") throw new Error("SESSION_ACCESS_DENIED");
    return (await this.workspace.scoped(context.sessionId)).readBytes(dashboardPath);
  }
  readPublication(publicationId: string, context: { readonly sessionId: string; readonly userId: string }) { return this.agent.readPublication(publicationId, context); }

  setQueryExecutor(executor: NonNullable<DataAgentApplicationOptions["queryExecutor"]>): void {
    this.queryExecutorPort = executor;
    this.runtime.queryExecutor = {
      run: async (sql, rowLimit, runOptions) => {
        const port = this.queryExecutorPort;
        if (!port) throw new Error("QUERY_EXECUTOR_NOT_CONFIGURED");
        const resolved = typeof port === "function" ? await port() : port;
        return resolved.run(sql, rowLimit, runOptions);
      },
    };
  }
  /** The host's MCP plugin supervisor: it serves the plugin settings and the tools new sessions get. */
  setMcpPlugins(plugins: McpPluginPort): void {
    this.mcpPlugins = plugins;
    this.runtime.mcpSupervisor = plugins;
  }
  setHostTesters(ports: HostTestPorts): void {
    if (ports.dbTester) this.runtime.dbTester = ports.dbTester;
    if (ports.llmTester) this.runtime.llmTester = ports.llmTester;
  }
  getResources(): ApplicationResources { return this.agent.getResources(); }
  setResources(resources: ApplicationResources): Promise<void> { return this.agent.setResources(resources); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.channels) {
      this.channels.registry.close();
      await this.channels.hub.close();
    }
    await this.sessions.close();
    await this.metadata.close();
  }
}

export async function createDataAgentApplication(options: DataAgentApplicationOptions): Promise<DataAgentApplication> {
  return DataAgentApplication.create(options);
}

export type { ApplicationAgentAdapter, ApplicationAgentEvent, ApplicationResources, HostRequestContext };
