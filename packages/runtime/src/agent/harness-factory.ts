import { AgentHarness, operationMeta, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import type {
  AgentHarness as NativeAgentHarness,
  AgentHarnessTool,
  AgentLane,
  Skill,
} from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Answering, AnsweringStore, QueryExecutionScope, ResultStore } from "../answering/public.js";
import type { FanoutDialect, FanoutSchema } from "../answering/fanout-check.js";
import type { DataAgentToolContext } from "../tools/answering.js";
import { PiTranscriptFacet, type PresentationAgentEvent, type RuntimeExecutionSnapshot, type RuntimeObservation, type TranscriptSnapshot } from "../facets/transcript.js";
import type { ArtifactDirectory } from "../facets/artifact-directory.js";
import type { ClarificationDialogs } from "../facets/clarification-dialogs.js";
import type { DashboardRefresher } from "../facets/dashboard-refresh.js";
import type { QueryTaskProjection } from "../facets/query-task-projection.js";
import { createPiAgentController } from "../facets/agent-controller.js";
import { unwrapApplicationSession, type SessionInput } from "../session-store.js";
import { ToolPromptCatalog } from "./tool-prompt-catalog.js";
import { withToolPromptCatalog } from "./tool-prompt-models.js";
import { withCoalescedDeltas } from "./coalesced-stream-models.js";
import { isSkillAvailable, renderSkillCatalog, type SkillCatalogEntry } from "./skill-prompt-catalog.js";
import { LENGTH_CONTINUATION_PROMPT, LengthContinuationGuard } from "./length-continuation.js";
import { RUNTIME_INJECTED_LABEL } from "../runtime-injected.js";
import { infrastructureFailureOf } from "./infrastructure-failure.js";
import type { DataAgentToolDefinition } from "../tools/tool-definition.js";

/** The only Pi/provider configuration owned by the Session Runtime. */
export interface DataAgentResources {
  readonly skills?: readonly { readonly name: string; readonly description: string; readonly content: string; readonly filePath?: string; readonly disableModelInvocation?: boolean; readonly whenToUse?: string; readonly requiredTools?: readonly string[] }[];
  readonly promptTemplates?: readonly { readonly name: string; readonly description?: string; readonly content: string }[];
}

export interface QueryExecutionOptions {
  readonly kind?: "exploration" | "result";
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly maxPreviewBytes?: number;
  readonly scope?: QueryExecutionScope;
}

export interface ScopedExplorationExecutor {
  /** The executor must enforce this scope at the database boundary. */
  readonly scope: QueryExecutionScope;
  run(sql: string, rowLimit: number, options: QueryExecutionOptions): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean; columnTypes?: string[]; dataSnapshot?: string }>;
}

export interface SessionQueryExecutor {
  readonly dialect?: FanoutDialect;
  readonly getSchema?: (signal?: AbortSignal) => Promise<FanoutSchema>;
  run(sql: string, rowLimit: number, options?: QueryExecutionOptions): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean; columnTypes?: string[]; dataSnapshot?: string }>;
  /** Omitted means delegated SQL exploration is unavailable, by design. */
  readonly scopedExploration?: ScopedExplorationExecutor;
}

export interface DataAgentModelProfile {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly apiFormat?: "responses" | "chat";
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Model<any>["thinkingLevelMap"];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly thinkingLevel?: import("@earendil-works/pi-agent-core").ThinkingLevel;
}

/** Shared Pi model runtime for one Data Agent Session Host and its child Harnesses. */
export interface DataAgentPiRuntime {
  readonly models: Models;
  readonly model: Model<any>;
}

/**
 * Already-composed business dependencies supplied by Session Runtime. The Pi
 * factory only installs them into a native Harness; it does not construct or
 * own Answering state, ResultStore implementations, or capability services.
 */

export interface DataAgentSessionHostOptions {
  readonly session: SessionInput;
  readonly sessionId: string;
  readonly toolContext: DataAgentToolContext;
  /** Executable definitions and their trusted prompt metadata. */
  readonly toolDefinitions: readonly DataAgentToolDefinition<DataAgentToolContext>[];
  readonly answering: Answering;
  readonly answeringStore: AnsweringStore;
  readonly resultStore: ResultStore;
  readonly skills?: readonly Skill[];
  readonly skillToolAllowlist?: Readonly<Record<string, readonly string[]>>;
  readonly systemPrompt: string;
  readonly profile: DataAgentModelProfile;
  readonly queryTaskProjection: QueryTaskProjection;
  readonly artifactDirectory: ArtifactDirectory;
  readonly clarificationDialogs: ClarificationDialogs;
  readonly dashboardRefresher: DashboardRefresher;
  readonly piRuntime?: DataAgentPiRuntime;
}

function modelFor(profile: DataAgentModelProfile): Model<any> {
  const providerId = profile.provider || "openai";
  const anthropic = providerId === "anthropic";
  const openrouter = providerId === "openrouter";
  const deepseek = providerId === "deepseek";
  const baseUrl = (profile.baseUrl
    ?? (anthropic ? "https://api.anthropic.com" : openrouter ? "https://openrouter.ai/api/v1" : deepseek ? "https://api.deepseek.com" : "https://api.openai.com/v1")).replace(/\/$/, "");
  const headers = profile.apiKey
    ? anthropic
      ? { "x-api-key": profile.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${profile.apiKey}` }
    : undefined;
  return {
    id: profile.model,
    name: profile.model,
    api: anthropic ? "anthropic-messages" : profile.apiFormat === "chat" || deepseek ? "openai-completions" : "openai-responses",
    provider: providerId,
    baseUrl,
    reasoning: profile.reasoning ?? (deepseek ? true : false),
    ...(deepseek ? {
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
      },
      thinkingLevelMap: {
        minimal: null,
        low: "low",
        medium: null,
        high: "high",
        max: "max",
      },
    } : {}),
    ...(profile.thinkingLevelMap ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow ?? (deepseek ? 1_000_000 : 128_000),
    maxTokens: profile.maxTokens ?? (deepseek ? 102_400 : 8192),
    ...(headers ? { headers } : {}),
  } as Model<any>;
}

export async function createDataAgentPiRuntime(profile: DataAgentModelProfile): Promise<DataAgentPiRuntime> {
  const credentials = new InMemoryCredentialStore();
  const providerId = profile.provider || "openai";
  if (profile.apiKey) await credentials.modify(providerId, async () => ({ type: "api_key", key: profile.apiKey! }));
  const models: Models = builtinModels({ credentials });
  const model = modelFor(profile);
  const provider = models.getProvider(providerId);
  if (provider) {
    const originalGetModels = provider.getModels.bind(provider);
    provider.getModels = () => {
      const list = [...originalGetModels()];
      if (!list.some((item) => item.id === model.id)) list.push(model);
      return list;
    };
  }
  return { models, model };
}

interface AgentController {
  prompt(text: string, context?: { readonly operationId?: string; readonly requestId?: string }): Promise<{ readonly operationId: string }>;
  requestAbort(operationId: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  nextRun(text: string): Promise<void>;
  cancelQueued(entryId: string): Promise<"cancelled" | "already_consumed" | "not_found">;
  resume(): Promise<void>;
  inspectExecution(): ReturnType<AgentLane["inspectExecution"]>;
  getOpenOperations(): Promise<readonly OpenOperation[]>;
  watch(): ReturnType<AgentLane["watch"]>;
}

export interface OpenOperation {
  readonly lane: string;
  readonly operationId: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly kind: "run" | "compaction" | "navigation";
  readonly startedAt: number;
  readonly aborting?: true;
}

export interface DataAgentSessionHost {
  readonly harness: NativeAgentHarness<DataAgentToolContext>;
  readonly lane: AgentLane;
  readonly controller: AgentController;
  readonly answering: Answering;
  readonly answeringStore: AnsweringStore;
  readonly resultStore: ResultStore;
  readonly tools: readonly AgentHarnessTool<DataAgentToolContext>[];
  readonly facets: {
    readonly transcript: PiTranscriptFacet;
    readonly queryTasks: QueryTaskProjection;
    readonly artifacts: ArtifactDirectory;
    readonly clarifications: ClarificationDialogs;
    readonly dashboards: DashboardRefresher;
  };
  readonly openOperations: readonly OpenOperation[];
  subscribe(listener: (event: PresentationAgentEvent) => void): () => void;
  subscribeObservations(listener: (observation: RuntimeObservation) => void): () => void;
  getActiveTools(): Promise<readonly string[]>;
  getExecutionSnapshot(): Promise<RuntimeExecutionSnapshot>;
  snapshotTranscript(): Promise<TranscriptSnapshot>;
  getResources(): DataAgentResources;
  setResources(resources: DataAgentResources): Promise<void>;
  resumeOpenOperations(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Native Pi assembly seam. It has one Session, one main AgentLane and no
 * parallel runner/status/checkpoint implementation of its own.
 */
export async function createPiSessionHost(options: DataAgentSessionHostOptions): Promise<DataAgentSessionHost> {
  const piRuntime = options.piRuntime ?? await createDataAgentPiRuntime(options.profile);
  let requestMessageId = options.toolContext.requestMessageId;
  const nativeSession = unwrapApplicationSession(options.session);
  const skills = [...(options.skills ?? [])];
  const definitions = [...options.toolDefinitions];
  const sourceTools = definitions.map((definition) => definition.tool);
  const grantedToolNames = new Set(sourceTools.map((tool) => tool.name));
  // Tools a Runtime protocol may require at any step; a Skill's allowlist narrows only the rest.
  const pinnedToolNames = definitions.filter((definition) => definition.pinned).map((definition) => definition.tool.name);
  let activeLane: AgentLane | undefined;
  // Current resources; setResources replaces the Skill list without rebuilding the Models seam.
  let resources: DataAgentResources = { skills };
  const currentSkills = (): readonly SkillCatalogEntry[] => (resources.skills ?? []) as readonly SkillCatalogEntry[];
  const tools = sourceTools.map((tool): AgentHarnessTool<DataAgentToolContext> => {
    const parameters = tool.parameters && typeof tool.parameters === "object" && !("type" in tool.parameters)
      ? { type: "object", ...tool.parameters }
      : tool.parameters;
    if (tool.name !== "load_skill") return parameters === tool.parameters ? tool : { ...tool, parameters };
    return {
      ...tool,
      parameters,
      async execute(toolCallId, input, onUpdate, toolContext, invocation, context) {
        const skillName = input && typeof input === "object" && "name" in input ? String(input.name) : "";
        // A Skill whose required tools are not granted is neither listed nor loadable.
        const requested = currentSkills().find((skill) => skill.name === skillName);
        if (requested && !isSkillAvailable(requested, grantedToolNames)) throw new Error(`SKILL_NOT_FOUND: ${skillName}`);
        const result = await tool.execute(toolCallId, input, onUpdate, toolContext, invocation, context);
        const allowed = options.skillToolAllowlist?.[skillName];
        if (allowed) {
          const selected = new Set([...pinnedToolNames, ...allowed.filter((name) => grantedToolNames.has(name))]);
          await activeLane?.setActiveTools([...selected], context);
        }
        return result;
      },
    };
  });
  const effectiveDefinitions = definitions.map((definition, index) => ({
    ...definition,
    tool: tools[index]!,
  }));
  // Gathered deltas keep the session file from storing one durable frame per streamed token.
  const models = withCoalescedDeltas(withToolPromptCatalog(piRuntime.models, new ToolPromptCatalog(effectiveDefinitions), {
    renderPreamble: (activeToolNames) => renderSkillCatalog(currentSkills(), activeToolNames, grantedToolNames),
  }));
  const created = await AgentHarness.create({
    session: nativeSession,
    models,
    model: piRuntime.model,
    thinkingLevel: options.profile.thinkingLevel ?? "off",
    tools,
    activeToolNames: [...grantedToolNames],
    resources: { skills },
    toolContext: () => ({ ...options.toolContext, ...(requestMessageId ? { requestMessageId } : {}) }),
    systemPrompt: options.systemPrompt,
  }, TODO_CONTEXT);
  const harness = created.harness;
  // A reply that fills the output limit while still thinking would otherwise end the run silently.
  const lengthContinuation = new LengthContinuationGuard();
  const pendingContinuations = new Set<string>();
  harness.hooks.on("before_run_end", (event) => {
    const followUp = lengthContinuation.followUp(event.runId, event.messages);
    if (followUp) pendingContinuations.add(event.runId);
    else pendingContinuations.delete(event.runId);
    return followUp ? { followUp } : undefined;
  }, { id: "data-agent-length-continuation" });
  // Pi commits the follow-up verbatim as a user-role entry of the same run.
  // Label that entry so it is never shown or admitted as the user's words.
  harness.events.on("message_end", (event) => {
    if (!event.runId || !event.entryId || !pendingContinuations.has(event.runId)) return;
    if (event.message.role !== "user" || event.message.content !== LENGTH_CONTINUATION_PROMPT) return;
    pendingContinuations.delete(event.runId);
    void harness.setLabel(event.entryId, RUNTIME_INJECTED_LABEL, TODO_CONTEXT)
      .catch((error) => console.error("[data-agent] failed to label runtime-injected message", error));
  });
  const lane = await harness.lane("main", TODO_CONTEXT);
  activeLane = lane;
  // A lost database is terminal for the operation; the Agent must not work around it.
  harness.hooks.on("after_tool", (event) => {
    const failure = infrastructureFailureOf(event.content);
    if (!failure) return undefined;
    void lane.abort(TODO_CONTEXT).catch(() => undefined);
    return { terminate: true };
  }, { id: "data-agent-infrastructure-failure" });
  const transcript = new PiTranscriptFacet(harness, options.sessionId, created.open);
  const nativeController = await createPiAgentController(harness, { pi: TODO_CONTEXT }, "main", [...grantedToolNames], undefined, async (admission, controllerContext) => {
    const stored = await nativeSession.getValue(operationMeta(admission.operationId), controllerContext.pi);
    const promptEntryIds = stored?.value.intent.kind === "run" ? stored.value.intent.promptEntryIds : [];
    if (promptEntryIds.length !== 1) throw new Error("REQUEST_MESSAGE_ID_UNAVAILABLE");
    requestMessageId = promptEntryIds[0];
  });
  const controller: AgentController = {
    async prompt(text, requestContext) {
      const accepted = await nativeController.prompt({ prompt: text, ...(requestContext?.operationId ? { operationId: requestContext.operationId } : {}) }, { pi: TODO_CONTEXT });
      transcript.bindOperation(accepted.operationId, requestContext?.requestId);
      return { operationId: accepted.operationId };
    },
    async requestAbort(operationId) {
      await nativeController.requestAbort(operationId, { pi: TODO_CONTEXT });
    },
    async steer(text) {
      await nativeController.steer({ message: text }, { pi: TODO_CONTEXT });
    },
    async followUp(text) {
      await nativeController.followUp({ message: text }, { pi: TODO_CONTEXT });
    },
    async nextRun(text) {
      await nativeController.nextRun({ message: text }, { pi: TODO_CONTEXT });
    },
    async cancelQueued(entryId) {
      return nativeController.cancelQueued(entryId, { pi: TODO_CONTEXT });
    },
    async resume() {
      await nativeController.resume({ pi: TODO_CONTEXT });
    },
    inspectExecution: () => nativeController.inspect({ pi: TODO_CONTEXT }),
    getOpenOperations: async () => {
      const execution = await lane.inspectExecution(TODO_CONTEXT);
      if (!execution.current) return [];
      return [{ lane: "main", operationId: execution.current.id, kind: execution.current.kind, startedAt: execution.current.startedAt }];
    },
    watch: () => nativeController.watch({ pi: TODO_CONTEXT }),
  };
  // AgentHarness.create restores accepted operations without starting effects.
  // The Application Host publishes these IDs before asking Pi to resume them.
  const resumeOpenOperations = async (): Promise<void> => {
    for (const open of created.open) {
      if (open.lane !== "main") continue;
      // Pi owns recovery semantics for run, compaction and navigation. The
      // Session Host must not silently strand a native accepted operation.
      const driven = await lane.drive({ operationId: open.operationId }, TODO_CONTEXT);
      if (!driven.ok) throw driven.error;
    }
  };
  return {
    harness,
    lane,
    controller,
    answering: options.answering,
    answeringStore: options.answeringStore,
    resultStore: options.resultStore,
    tools,
    facets: { transcript, queryTasks: options.queryTaskProjection, artifacts: options.artifactDirectory, clarifications: options.clarificationDialogs, dashboards: options.dashboardRefresher },
    openOperations: created.open as readonly OpenOperation[],
    subscribe: transcript.subscribe.bind(transcript),
    subscribeObservations: transcript.subscribeObservations.bind(transcript),
    getActiveTools: () => activeLane?.getActiveTools(TODO_CONTEXT) ?? Promise.resolve([]),
    getExecutionSnapshot: async () => {
      const snapshot = await transcript.snapshot();
      const watch = await controller.watch();
      const laneSnapshot = watch.snapshot;
      watch.unsubscribe();
      return {
        sessionId: options.sessionId,
        lane: snapshot.lane,
        tipId: snapshot.tipId,
        current: snapshot.operation,
        lastOperationId: laneSnapshot.lastResult?.operationId ?? laneSnapshot.operation?.id ?? null,
        ...(laneSnapshot.lastResult ? {
          lastResult: {
            operationId: laneSnapshot.lastResult.operationId,
            status: laneSnapshot.lastResult.status,
            startedAt: laneSnapshot.lastResult.startedAt,
            endedAt: laneSnapshot.lastResult.endedAt,
            ...(laneSnapshot.lastResult.error ? { error: laneSnapshot.lastResult.error } : {}),
          },
        } : {}),
        faulted: snapshot.faulted,
      };
    },
    snapshotTranscript: () => transcript.snapshot(),
    getResources: () => resources,
    setResources: async (nextResources) => {
      resources = { ...nextResources, ...(nextResources.skills ? { skills: [...nextResources.skills] } : {}), ...(nextResources.promptTemplates ? { promptTemplates: [...nextResources.promptTemplates] } : {}) };
      await harness.setResources({
        ...(nextResources.skills ? { skills: [...nextResources.skills].map((skill) => ({ ...skill, filePath: skill.filePath ?? "<application>" })) } : {}),
        ...(nextResources.promptTemplates ? { promptTemplates: [...nextResources.promptTemplates] } : {}),
      }, TODO_CONTEXT);
    },
    resumeOpenOperations,
    close: async () => { transcript.close(); await harness.close(TODO_CONTEXT); },
  };
}

export type { SessionInput };
