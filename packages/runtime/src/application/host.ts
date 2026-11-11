import type { AnsweringEvidenceDocuments, DataAgentModelProfile, DataAgentSessionHost, DataAgentSessionRuntimeOptions, OpenOperation, SessionQueryExecutor, PresentationAgentEvent } from "./session-runtime.js";
import { createDataAgentSessionHost } from "./session-runtime.js";
import { PiJsonlSessionStore, type SessionInput } from "../session-store.js";
import type { KnowledgeIndex } from "../knowledge.js";
import type { ClarificationManager } from "../clarification.js";
import type { WorkspaceStore } from "../workspace.js";
import type { RuntimeExecutionSnapshot, RuntimeObservation, TranscriptMessage } from "../facets/transcript.js";
import type { AuthorizedArtifact, AuthorizedPublicationSql } from "../facets/artifact-directory.js";
import type { DashboardRefreshRequest, DashboardRefreshResult } from "../facets/dashboard-refresh.js";
import type { HypothesisChoiceAdvisor } from "../judgment/hypothesis-choice.js";
import type { FanoutAnsweringOptions, QueryBudgetPolicy } from "../answering/public.js";
import type { SemanticSpecMode } from "../tools/answering.js";
import type { McpPluginTool } from "../tools/mcp-plugins.js";

export interface HostRequestContext {
  readonly userId: string;
  readonly sessionId: string;
  readonly host: "electron" | "web";
}

export interface ApplicationSessionHandle {
  readonly id: string;
}

export interface ApplicationSessionStore {
  create(metadata?: Record<string, unknown>): Promise<ApplicationSessionHandle>;
  list(): Promise<readonly unknown[]>;
  open(metadata: unknown): Promise<{ getEntries(): Promise<readonly unknown[]> }>;
  openByAppSessionId(sessionId: string): Promise<{ getEntries(): Promise<readonly unknown[]> }>;
  close?(): Promise<void>;
}

export interface DataAgentSessionApplicationOptions {
  readonly sessionStore?: ApplicationSessionStore;
  readonly sessionRoot?: string;
  readonly workspace: WorkspaceStore;
  readonly knowledge?: KnowledgeIndex;
  readonly knowledgeRoot?: string;
  readonly pythonExecutable?: string | (() => string | undefined);
  readonly queryExecutor?: SessionQueryExecutor | (() => SessionQueryExecutor | Promise<SessionQueryExecutor>);
  readonly resultRoot?: string;
  readonly hypothesisChoiceAdvisor?: HypothesisChoiceAdvisor;
  /** Tools of the enabled MCP plugins; read for each session it opens. */
  readonly mcpPluginTools?: () => Promise<readonly McpPluginTool[]>;
  /** Evaluation-only; ordinary product sessions use the required semantic Spec. */
  readonly semanticSpecMode?: SemanticSpecMode;
  readonly answeringBudgetPolicy?: QueryBudgetPolicy;
  readonly answeringFanout?: FanoutAnsweringOptions;
  /** Knowledge ids admitted as business evidence and their authority (ADR-0004). */
  readonly answeringEvidenceDocuments?: AnsweringEvidenceDocuments;
  readonly profile?: DataAgentModelProfile;
  readonly resolveProfile?: (context: HostRequestContext) => DataAgentModelProfile | Promise<DataAgentModelProfile>;
  readonly systemPrompt?: string;
  readonly systemPromptRoots?: readonly string[];
  readonly projectRoot?: string;
  readonly packagedRoot?: string;
  readonly skillRoots?: readonly string[];
  readonly enableDashboards?: boolean;
  readonly enableWidgets?: boolean;
  readonly clarifications?: ClarificationManager;
  /** Evaluation-only headless switch; omitted means the normal product tool remains available. */
  readonly enableClarificationTool?: boolean;
  readonly enableSubagents?: boolean | ((context: HostRequestContext) => boolean | Promise<boolean>);
  readonly delegationRoot?: string;
  /** Exact relative Markdown paths delegated children may inspect. */
  readonly delegationKnowledgePaths?: readonly string[];
  /** Permit creation when the metadata SessionDirectory has no row yet. */
  readonly createMissingSessions?: boolean;
  /** The authoritative metadata directory check for a Session request. */
  readonly authorizeSession?: (context: HostRequestContext) => boolean | Promise<boolean>;
}

export type ApplicationAgentEvent = PresentationAgentEvent & { readonly userId?: string };

export interface ApplicationResources {
  readonly skills?: readonly { readonly name: string; readonly description: string; readonly content: string; readonly filePath?: string; readonly disableModelInvocation?: boolean }[];
  readonly promptTemplates?: readonly { readonly name: string; readonly description?: string; readonly content: string }[];
}

export interface ApplicationAgentAdapter {
  prompt(text: string, context?: { readonly sessionId?: string; readonly operationId?: string; readonly requestId?: string; readonly userId?: string }): Promise<{ readonly operationId: string }>;
  requestAbort(operationId: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<void>;
  steer(text: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<void>;
  followUp(text: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<void>;
  abort(context?: { readonly sessionId?: string; readonly userId?: string }): Promise<void>;
  getOpenOperations(context?: { readonly sessionId?: string; readonly userId?: string }): Promise<readonly OpenOperation[]>;
  getExecutionSnapshot(context?: { readonly sessionId?: string; readonly userId?: string }): Promise<RuntimeExecutionSnapshot>;
  getActiveTools(context?: { readonly sessionId?: string; readonly userId?: string }): Promise<readonly string[]>;
  getTranscript(context?: { readonly sessionId?: string; readonly userId?: string }): Promise<readonly TranscriptMessage[]>;
  answerClarification(clarificationId: string, answer: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<boolean>;
  readPublication(publicationId: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<AuthorizedArtifact>;
  readPublicationSql(publicationId: string, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<AuthorizedPublicationSql>;
  refreshDashboard(request: DashboardRefreshRequest, context?: { readonly sessionId?: string; readonly userId?: string }): Promise<DashboardRefreshResult>;
  getResources(): ApplicationResources;
  setResources(resources: ApplicationResources): Promise<void>;
  subscribe(listener: (event: ApplicationAgentEvent) => void, context?: { readonly sessionId?: string; readonly userId?: string }): () => void;
  subscribeObservations(listener: (observation: RuntimeObservation) => void, context?: { readonly sessionId?: string; readonly userId?: string }): () => void;
}

type HostKey = string;

type SessionHostFactory = (context: HostRequestContext) => Promise<DataAgentSessionHost>;

function keyFor(context: HostRequestContext): HostKey {
  return `${context.userId}\u0000${context.sessionId}`;
}


class SessionDirectory {
  private readonly hosts = new Map<HostKey, Promise<DataAgentSessionHost>>();
  private readonly listeners = new Set<(event: ApplicationAgentEvent) => void>();
  private readonly subscriptions = new Map<DataAgentSessionHost, () => void>();

  constructor(private readonly create: SessionHostFactory) {}

  async resolve(context: HostRequestContext): Promise<DataAgentSessionHost> {
    if (!context.userId.trim() || !context.sessionId.trim()) throw new Error("SESSION_CONTEXT_REQUIRED");
    const key = keyFor(context);
    const existing = this.hosts.get(key);
    if (existing) return existing;
    const pending = this.create(context).then(async (host) => {
      this.attachEvents(host, context.userId);
      for (const operation of host.openOperations) {
        this.emit({ type: "operation_open", operationId: operation.operationId, sessionId: context.sessionId, userId: context.userId, requestId: operation.requestId ?? operation.operationId });
      }
      await host.resumeOpenOperations();
      return host;
    });
    this.hosts.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.hosts.get(key) === pending) this.hosts.delete(key);
      throw error;
    }
  }

  private attachEvents(host: DataAgentSessionHost, userId: string): void {
    // Session Host owns Pi event interpretation. Application Host only routes
    // the already-projected Presentation event to its consumers.
    this.subscriptions.set(host, host.subscribe((event) => this.emit({ ...event, userId })));
  }

  private emit(event: ApplicationAgentEvent | undefined): void {
    if (!event) return;
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: ApplicationAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  values(): readonly Promise<DataAgentSessionHost>[] { return [...this.hosts.values()]; }

  hostEntries(): readonly [HostKey, Promise<DataAgentSessionHost>][] { return [...this.hosts.entries()]; }

  async close(): Promise<void> {
    const hosts = await Promise.allSettled(this.values().map((item) => item));
    for (const item of hosts) {
      if (item.status === "fulfilled") {
        this.subscriptions.get(item.value)?.();
        this.subscriptions.delete(item.value);
        await item.value.close().catch(() => undefined);
      }
    }
    this.hosts.clear();
  }
}

/**
 * Application Host owns identity, Session attachment and lifecycle routing.
 * It does not own Agent operation state or query-business state; those remain
 * in Pi AgentLane and Answering respectively.
 */
export class DataAgentSessionApplication {
  private readonly directory: SessionDirectory;
  private readonly ownedSessionStore: ApplicationSessionStore | undefined;
  private readonly sessionOwners = new Map<string, string>();
  private resources: ApplicationResources = {};

  constructor(private readonly options: DataAgentSessionApplicationOptions) {
    this.ownedSessionStore = options.sessionStore ?? (options.sessionRoot ? new PiJsonlSessionStore(options.sessionRoot) : undefined);
    this.directory = new SessionDirectory((context) => this.createSessionHost(context));
  }

  get sessionStore(): ApplicationSessionStore | undefined { return this.options.sessionStore ?? this.ownedSessionStore; }

  private async createSessionHost(context: HostRequestContext): Promise<DataAgentSessionHost> {
    const knownOwner = this.sessionOwners.get(context.sessionId);
    if (knownOwner && knownOwner !== context.userId) throw new Error("SESSION_ACCESS_DENIED");
    if (this.options.authorizeSession && !(await this.options.authorizeSession(context))) throw new Error("SESSION_ACCESS_DENIED");
    this.sessionOwners.set(context.sessionId, context.userId);
    const profile = this.options.resolveProfile
      ? await this.options.resolveProfile(context)
      : this.options.profile;
    if (!profile) throw new Error("LLM_NOT_CONFIGURED");
    let session: SessionInput | undefined;
    const sessionStore = this.sessionStore;
    if (sessionStore) {
      try {
        session = await sessionStore.openByAppSessionId(context.sessionId) as SessionInput;
      } catch (error) {
        const missing = error instanceof Error && error.message.startsWith("SESSION_NOT_FOUND");
        if (!missing || !this.options.createMissingSessions) throw error;
        session = await sessionStore.create({ sessionId: context.sessionId, userId: context.userId }) as SessionInput;
      }
    }
    const workspace = await this.options.workspace.scoped(context.sessionId);
    const queryExecutor = typeof this.options.queryExecutor === "function"
      ? await this.options.queryExecutor()
      : this.options.queryExecutor;
    // A plugin that cannot connect leaves the session without its tools, not without a session.
    const mcpPluginTools = this.options.mcpPluginTools
      ? await this.options.mcpPluginTools().catch((error: unknown) => {
        console.warn("[data-agent] MCP plugins unavailable:", error instanceof Error ? error.message : String(error));
        return [];
      })
      : [];
    const enableSubagents = typeof this.options.enableSubagents === "function"
      ? await this.options.enableSubagents(context)
      : this.options.enableSubagents;
    const runtimeOptions: DataAgentSessionRuntimeOptions = {
      sessionId: context.sessionId,
      principalId: context.userId,
      workspace,
      profile,
      ...(session ? { session } : {}),
      ...(this.options.knowledge ? { knowledge: this.options.knowledge } : {}),
      ...(this.options.knowledgeRoot ? { knowledgeRoot: this.options.knowledgeRoot } : {}),
      ...(this.options.pythonExecutable ? { pythonExecutable: this.options.pythonExecutable } : {}),
      ...(queryExecutor ? { queryExecutor } : {}),
      ...(mcpPluginTools.length > 0 ? { mcpPluginTools } : {}),
      ...(this.options.resultRoot ? { resultRoot: (await import("node:path")).join(this.options.resultRoot, context.sessionId) } : {}),
      ...(this.options.hypothesisChoiceAdvisor ? { hypothesisChoiceAdvisor: this.options.hypothesisChoiceAdvisor } : {}),
      ...(this.options.semanticSpecMode ? { semanticSpecMode: this.options.semanticSpecMode } : {}),
      ...(this.options.answeringBudgetPolicy ? { answeringBudgetPolicy: this.options.answeringBudgetPolicy } : {}),
      ...(this.options.answeringFanout ? { answeringFanout: this.options.answeringFanout } : {}),
      ...(this.options.answeringEvidenceDocuments ? { answeringEvidenceDocuments: this.options.answeringEvidenceDocuments } : {}),
      ...(this.options.systemPrompt ? { systemPrompt: this.options.systemPrompt } : {}),
      ...(this.options.systemPromptRoots ? { systemPromptRoots: this.options.systemPromptRoots } : {}),
      ...(this.options.projectRoot ? { projectRoot: this.options.projectRoot } : {}),
      ...(this.options.packagedRoot ? { packagedRoot: this.options.packagedRoot } : {}),
      ...(this.options.skillRoots ? { skillRoots: this.options.skillRoots } : {}),
      ...(this.options.enableDashboards !== undefined ? { enableDashboards: this.options.enableDashboards } : {}),
      ...(this.options.enableWidgets !== undefined ? { enableWidgets: this.options.enableWidgets } : {}),
      ...(this.options.clarifications ? { clarifications: this.options.clarifications } : {}),
      ...(this.options.enableClarificationTool !== undefined ? { enableClarificationTool: this.options.enableClarificationTool } : {}),
      ...(enableSubagents !== undefined ? { enableSubagents } : {}),
      ...(this.options.delegationRoot ? { delegationRoot: (await import("node:path")).join(this.options.delegationRoot, context.sessionId) } : {}),
      ...(this.options.delegationKnowledgePaths ? { delegationKnowledgePaths: this.options.delegationKnowledgePaths } : {}),
    };
    return createDataAgentSessionHost(runtimeOptions);
  }

  private async session(context: HostRequestContext): Promise<DataAgentSessionHost> {
    try {
      return await this.directory.resolve(context);
    } catch (error) {
      if (!this.directory.hostEntries().some(([key]) => key === keyFor(context)) && this.sessionOwners.get(context.sessionId) === context.userId) this.sessionOwners.delete(context.sessionId);
      throw error;
    }
  }

  createAgentAdapter(defaultContext?: Partial<HostRequestContext>): ApplicationAgentAdapter {
    const contextFor = (context?: { readonly sessionId?: string; readonly userId?: string }): HostRequestContext => {
      const sessionId = context?.sessionId ?? defaultContext?.sessionId;
      const userId = context?.userId ?? defaultContext?.userId ?? "local";
      const host = defaultContext?.host ?? "web";
      if (!sessionId) throw new Error("SESSION_CONTEXT_REQUIRED");
      return { sessionId, userId, host };
    };
    const getHost = (context?: { readonly sessionId?: string; readonly userId?: string }) => this.session(contextFor(context));
    return {
      prompt: async (text, context) => (await this.session(contextFor(context))).controller.prompt(text, context?.operationId || context?.requestId ? { ...(context.operationId ? { operationId: context.operationId } : {}), ...(context.requestId ? { requestId: context.requestId } : {}) } : undefined),
      requestAbort: async (operationId, context) => (await getHost(context)).controller.requestAbort(operationId),
      steer: async (text, context) => (await getHost(context)).controller.steer(text),
      followUp: async (text, context) => (await getHost(context)).controller.followUp(text),
      abort: async (context) => {
        const host = await getHost(context);
        const execution = await host.controller.inspectExecution();
        if (execution.current) await host.controller.requestAbort(execution.current.id);
      },
      getOpenOperations: async (context) => {
        const requestedUser = context?.userId ?? defaultContext?.userId;
        const requestedSession = context?.sessionId ?? defaultContext?.sessionId;
        const entries = [...this.directory.hostEntries()].filter(([key]) => {
          const [userId, sessionId] = key.split("\u0000");
          return (!requestedUser || userId === requestedUser) && (!requestedSession || sessionId === requestedSession);
        });
        return (await Promise.all(entries.map(async ([key, pending]) => {
          const sessionId = key.split("\u0000")[1] ?? "";
          return (await pending).controller.getOpenOperations().then((operations) => operations.map((operation) => ({ ...operation, sessionId })));
        }))).flat();
      },
      getExecutionSnapshot: async (context) => (await getHost(context)).getExecutionSnapshot(),
      getActiveTools: async (context) => (await getHost(context)).getActiveTools(),
      getTranscript: async (context) => (await getHost(context)).facets.transcript.messages(),
      answerClarification: async (clarificationId, answer, context) => (await getHost(context)).facets.clarifications.answer(clarificationId, answer),
      readPublication: async (publicationId, context) => {
        const resolved = contextFor(context);
        const host = await this.session(resolved);
        return host.facets.artifacts.resolve(publicationId, {
          principal: { id: resolved.userId },
          sessionId: resolved.sessionId,
          lane: "presentation",
          operationId: `publication-read:${publicationId}`,
          invocationId: `publication-read:${publicationId}`,
        });
      },
      readPublicationSql: async (publicationId, context) => {
        const resolved = contextFor(context);
        const host = await this.session(resolved);
        return host.facets.artifacts.resolveSql(publicationId, {
          principal: { id: resolved.userId },
          sessionId: resolved.sessionId,
          lane: "presentation",
          operationId: `publication-sql-read:${publicationId}`,
          invocationId: `publication-sql-read:${publicationId}`,
        });
      },
      refreshDashboard: async (request, context) => {
        const resolved = contextFor(context);
        const host = await this.session(resolved);
        return host.facets.dashboards.refresh(request, {
          principal: { id: resolved.userId },
          sessionId: resolved.sessionId,
          lane: "presentation",
          operationId: `dashboard-refresh:${request.requestId}`,
          invocationId: `dashboard-refresh:${request.requestId}`,
        });
      },
      getResources: () => this.resources,
      setResources: async (resources) => {
        this.resources = resources;
        const hosts = await Promise.all([...this.directory.values()]);
        await Promise.all(hosts.map((host) => host.setResources(resources)));
      },
      subscribe: (listener, context) => {
        const requestedUser = context?.userId ?? defaultContext?.userId;
        const requestedSession = context?.sessionId ?? defaultContext?.sessionId;
        return this.directory.subscribe((event) => {
          if (requestedUser && event.userId !== requestedUser) return;
          if (requestedSession && event.sessionId !== requestedSession) return;
          listener(event);
        });
      },
      subscribeObservations: (listener, context) => {
        const requestedSession = context?.sessionId ?? defaultContext?.sessionId;
        let stopped = false;
        let unsubscribe: (() => void) | undefined;
        void this.session(contextFor(context)).then((host) => {
          if (stopped) return;
          unsubscribe = host.subscribeObservations((observation) => {
            if (requestedSession && observation.sessionId !== requestedSession) return;
            listener(observation);
          });
        }).catch(() => undefined);
        return () => {
          stopped = true;
          unsubscribe?.();
        };
      },
    };
  }

  async close(): Promise<void> {
    await this.directory.close();
    this.sessionOwners.clear();
    await this.ownedSessionStore?.close?.();
  }
}

export type { DataAgentSessionHost, DataAgentSessionRuntimeOptions, DataAgentModelProfile, SessionQueryExecutor };
