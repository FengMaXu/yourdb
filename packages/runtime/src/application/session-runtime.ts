import { MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Session, Skill } from "@earendil-works/pi-agent-core";
import { InMemoryAnswering, isScopedReadOnlySql, type Answering, type AnsweringSqlExecutor, type AnsweringStore, type EvidenceSource, type FanoutAnsweringOptions, type QueryBudgetPolicy, type ResultStore } from "../answering/public.js";
import { PiSessionAnsweringStore } from "../adapters/pi-session-answering-store.js";
import { PiSessionClarificationLedger } from "../adapters/pi-session-clarification-ledger.js";
import { FileResultStore, InMemoryResultStore } from "../answering/result-store.js";
import { assertTaskAccess } from "../answering/answering-store.js";
import type { PublicationId } from "../answering/model.js";
import { loadSkillsFromRoots, resolveSkillRoots } from "../skills.js";
import { renderKnowledgeCatalog, type KnowledgeIndex } from "../knowledge.js";
import { ClarificationManager } from "../clarification.js";
import type { WorkspaceStore } from "../workspace.js";
import { createChartToolDefinitions } from "../tools/charts.js";
import { createDashboardToolDefinitions } from "../tools/dashboard.js";
import { DerivedDatasets, FileDerivedDatasetStore, InMemoryDerivedDatasetStore } from "../facets/derived-datasets.js";
import { DashboardRefresher } from "../facets/dashboard-refresh.js";
import { createAnsweringAgentToolDefinitions, type DataAgentToolContext, type SemanticSpecMode } from "../tools/answering.js";
import { createCoreAgentToolDefinitions } from "../tools/core.js";
import { createDataAgentPiRuntime, createPiSessionHost, type DataAgentModelProfile, type DataAgentSessionHost, type DataAgentSessionHostOptions, type OpenOperation, type SessionInput, type SessionQueryExecutor } from "../agent/harness-factory.js";
import type { PresentationAgentEvent } from "../facets/transcript.js";
import { ArtifactDirectory } from "../facets/artifact-directory.js";
import { ClarificationDialogs, type ClarificationLedger } from "../facets/clarification-dialogs.js";
import { QueryTaskProjection, queryTaskReadModel } from "../facets/query-task-projection.js";
import { unwrapApplicationSession } from "../session-store.js";
import { HarnessChildExecutor, JsonlChildSessionRepository, MemoryChildSessionRepository, NativeDelegation, PiSessionDelegationLedger } from "../delegation/index.js";
import { createQueryTaskDelegationResolver, type DelegationSqlExplorer } from "./delegation.js";
import { createSubagentToolDefinition } from "../tools/subagent.js";
import type { DataAgentToolDefinition } from "../tools/tool-definition.js";
import { createMcpPluginToolDefinitions, type McpPluginTool } from "../tools/mcp-plugins.js";
import type { HypothesisChoiceAdvisor } from "../judgment/hypothesis-choice.js";
import { isRuntimeInjected } from "../runtime-injected.js";

export interface DataAgentSessionRuntimeOptions {
  readonly session?: SessionInput;
  readonly sessionId: string;
  readonly principalId?: string;
  readonly workspace: WorkspaceStore;
  readonly knowledge?: KnowledgeIndex;
  readonly knowledgeRoot?: string;
  readonly pythonExecutable?: string | (() => string | undefined);
  readonly queryExecutor?: SessionQueryExecutor;
  readonly resultRoot?: string;
  readonly systemPrompt?: string;
  readonly systemPromptRoots?: readonly string[];
  readonly projectRoot?: string;
  readonly packagedRoot?: string;
  readonly skillRoots?: readonly string[];
  readonly enableDashboards?: boolean;
  readonly enableWidgets?: boolean;
  readonly clarifications?: ClarificationManager;
  /** Evaluation-only headless switch. Product sessions keep the clarification tool. */
  readonly enableClarificationTool?: boolean;
  readonly profile: DataAgentModelProfile;
  readonly answeringStore?: AnsweringStore;
  readonly resultStore?: ResultStore;
  /** Optional external advisor for unresolved competing hypotheses. */
  readonly hypothesisChoiceAdvisor?: HypothesisChoiceAdvisor;
  /** Evaluation-only semantic-spec ablation. Product composition leaves this required. */
  readonly semanticSpecMode?: SemanticSpecMode;
  /** Tools of the MCP plugins the user enabled, resolved when the session opens. */
  readonly mcpPluginTools?: readonly McpPluginTool[];
  /** Explicit Answering budget; omitted uses the production default policy. */
  readonly answeringBudgetPolicy?: QueryBudgetPolicy;
  /** Explicit fanout capability setting; omitted uses the production default. */
  readonly answeringFanout?: FanoutAnsweringOptions;
  /**
   * Knowledge documents admitted as business evidence, keyed by knowledgeId.
   * Authority comes only from this composition setting (ADR-0004); omitted
   * means no knowledge document can support a business Resolution.
   */
  readonly answeringEvidenceDocuments?: AnsweringEvidenceDocuments;
  /** Disabled by default until the product explicitly enables bounded child execution. */
  readonly enableSubagents?: boolean;
  /** Private child Session root; omitted uses in-memory child Sessions. */
  readonly delegationRoot?: string;
  /** Explicitly authorized knowledge paths for child tools; omitted disables child knowledge access. */
  readonly delegationKnowledgePaths?: readonly string[];
}

export type AnsweringEvidenceDocuments = Readonly<Record<string, "task_document" | "reviewed_definition">>;

export function composeKnowledgeCatalogPrompt(base: string, knowledge?: KnowledgeIndex, options: { readonly delegation?: boolean } = {}): string {
  // An unfilled placeholder would send the Agent to read a document with no content.
  const entries = (knowledge?.catalog() ?? []).filter((entry) => entry.hasContent);
  if (entries.length === 0) return base;
  const header = "Knowledge Catalog (choose sources by need; do not treat catalog metadata as business evidence):";
  if (!options.delegation) return `${base}\n\n${header}\n${renderKnowledgeCatalog(entries)}`;
  // With subagents, method guides stay with the main Agent; facts are gathered by explorers.
  const methods = entries.filter((entry) => entry.usage === "method");
  const facts = entries.filter((entry) => entry.usage !== "method");
  return [
    base,
    "",
    header,
    ...(methods.length > 0 ? ["你可直接读取（方法类指引：用 read_knowledge 按章节读取）：", renderKnowledgeCatalog(methods)] : []),
    ...(facts.length > 0 ? ["通过子 Agent 获取（业务定义、表结构、数据说明等事实：委派 subagent explorer；其中的计算公式或计算方法说明请自己用 read_knowledge 读原文）：", renderKnowledgeCatalog(facts)] : []),
  ].join("\n");
}

async function canonicalPrompt(options: DataAgentSessionRuntimeOptions): Promise<string> {
  let base: string | undefined = options.systemPrompt?.trim() || undefined;
  if (!base) {
    const roots = options.systemPromptRoots?.filter(Boolean) ?? [];
    for (const root of roots) {
      try {
        base = (await (await import("node:fs/promises")).readFile(`${root}/.pi/SYSTEM.md`, "utf8")).trim();
        break;
      } catch {
        // Continue to the next explicitly configured resource root.
      }
    }
    if (!base) throw new Error(`SYSTEM_PROMPT_NOT_FOUND: expected .pi/SYSTEM.md under ${roots.join(", ") || "the configured system prompt roots"}`);
  }
  return composeKnowledgeCatalogPrompt(base, options.knowledge, { delegation: Boolean(options.enableSubagents) });
}

export function composeSubagentSystemPrompt(baseSystemPrompt: string): string {
  return `${baseSystemPrompt}

## 子 Agent 分工

- 信息收集优先交给 \`subagent\` 的 explorer：业务定义（business-definitions）、数据库结构（database-schema）、数据取值（枚举、范围、样例、基数）、已验证查询模版（query-patterns），主上下文只保留报告。
- 按 MECE 原则派发：子任务互不重叠、合起来覆盖所需信息；每个子 Agent 只执行一个子任务，每个子任务只回答一个问题。
- 子 Agent 只提供信息，报告是 Markdown 文档；口径、Answer Spec、最终查询和发布由你决定。
- 需要计算某个指标时，可让 explorer 在已验证查询模版（query-patterns）中查找匹配的模版，报告会逐字给出模版 SQL 与适用前提；模版只有在当前口径与前提一致时才能复用，是否复用由你判断。
- 方法类知识（如数据分析语义理解指引（semantic-guide）、SQL 生成规范（sql-rules））用于指导你的推理，由你自己按需加载；业务文档中的计算公式或计算方法说明同样自己读原文，不依赖子 Agent 的转述。`;
}

/**
 * Explorer SQL runs read-only against the host executor, through the scoped
 * exploration capability when the host provides one. It is information for
 * the main Agent and is not registered as Query Task Evidence.
 */
function delegationSqlExplorer(executor: SessionQueryExecutor): DelegationSqlExplorer {
  const scoped = executor.scopedExploration;
  return {
    run: (sql, rowLimit, runOptions) => scoped
      ? scoped.run(sql, rowLimit, { kind: "exploration", ...runOptions, scope: scoped.scope })
      : executor.run(sql, rowLimit, { kind: "exploration", ...runOptions }),
    ...(executor.getSchema ? { getSchema: (signal?: AbortSignal) => executor.getSchema!(signal) } : {}),
  };
}

function asSqlExecutor(executor: SessionQueryExecutor | undefined): AnsweringSqlExecutor {
  if (!executor) return { async run() { throw new Error("QUERY_EXECUTOR_NOT_CONFIGURED"); } };
  return {
    ...(executor.dialect ? { dialect: executor.dialect } : {}),
    ...(executor.getSchema ? { getSchema: (signal?: AbortSignal) => executor.getSchema!(signal) } : {}),
    run: (sql, rowLimit, options) => {
      if (options?.scope) {
        const scoped = executor.scopedExploration;
        if (!scoped || scoped.scope.scopeId !== options.scope.scopeId || scoped.scope.connectionId !== options.scope.connectionId) {
          throw new Error("SCOPED_EXPLORATION_NOT_SUPPORTED");
        }
        if (!isScopedReadOnlySql(sql)) throw new Error("SCOPED_EXPLORATION_SQL_REJECTED");
        return scoped.run(sql, rowLimit, options);
      }
      return executor.run(sql, rowLimit, options);
    },
  };
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
  return text.trim() ? text : undefined;
}

async function readUserMessageText(session: Session<any>, messageId: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) throw new Error("ORIGINAL_QUESTION_READ_CANCELLED");
  const entry = await session.getEntry(messageId, TODO_CONTEXT);
  if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
  // A Runtime-injected follow-up is user-role in Pi but was never said by the user.
  if (isRuntimeInjected(await session.getLabel(messageId, TODO_CONTEXT))) return undefined;
  return messageText(entry.message.content);
}

async function readOriginalQuestion(session: Session<any>, requestMessageId: string, signal?: AbortSignal): Promise<string> {
  const text = await readUserMessageText(session, requestMessageId, signal);
  if (!text) throw new Error("ORIGINAL_QUESTION_UNAVAILABLE");
  return text;
}

/**
 * Trusted Evidence Admission sources. User text comes only from what the user
 * said in this Session: user-role entries, and answers to its clarifications
 * as the Host recorded them. Documents resolve only when the composition root
 * authorized their knowledgeId, with the configured authority.
 */
export function createEvidenceSource(options: {
  readonly session: Session<any>;
  readonly sessionId: string;
  readonly knowledge?: KnowledgeIndex;
  readonly documents?: AnsweringEvidenceDocuments;
  readonly clarifications?: Pick<ClarificationLedger, "read">;
}): EvidenceSource {
  const documents = options.documents ?? {};
  const clarifications = options.clarifications;
  return {
    ...(clarifications ? {
      async readClarificationAnswer(sessionId: string, clarificationId: string) {
        if (sessionId !== options.sessionId) return undefined;
        return (await clarifications.read(clarificationId))?.answer;
      },
    } : {}),
    async readUserMessage(sessionId, messageId, signal) {
      if (sessionId !== options.sessionId) return undefined;
      try {
        return await readUserMessageText(options.session, messageId, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        return undefined;
      }
    },
    async readDocument(sourceRef) {
      const kind = Object.prototype.hasOwnProperty.call(documents, sourceRef) ? documents[sourceRef] : undefined;
      if (!kind || !options.knowledge) return undefined;
      try {
        return { kind, content: options.knowledge.getDocument(sourceRef).content };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * Session Runtime is the composition root. It creates one Answering domain,
 * one Pi-session adapter and one immutable ResultStore, then hands all of them
 * to the Pi-only Harness factory. No host or model tool coordinates internals.
 */
export async function createDataAgentSessionHost(options: DataAgentSessionRuntimeOptions): Promise<DataAgentSessionHost> {
  const session = options.session ? unwrapApplicationSession(options.session) : await new MemorySessionRepo().create({}, TODO_CONTEXT);
  const answeringStore = options.answeringStore ?? new PiSessionAnsweringStore(session, TODO_CONTEXT);
  // The user's clarification answers live in this Session, where Evidence Admission reads them.
  const clarificationLedger = new PiSessionClarificationLedger(session, TODO_CONTEXT);
  const resultStore = options.resultStore ?? (options.resultRoot ? new FileResultStore(options.resultRoot) : new InMemoryResultStore());
  const piRuntime = await createDataAgentPiRuntime(options.profile);
  const answering: Answering = new InMemoryAnswering({
    store: answeringStore,
    resultStore,
    sqlExecutor: asSqlExecutor(options.queryExecutor),
    ...(options.answeringBudgetPolicy ? { budgetPolicy: options.answeringBudgetPolicy } : {}),
    ...(options.answeringFanout ? { fanout: options.answeringFanout } : {}),
    semanticQualificationMode: options.semanticSpecMode === "disabled" ? "bypassed" : "required",
    // An open field is decided after its alternatives' outputs are known (ADR-0005).
    fieldProbes: options.semanticSpecMode !== "disabled",
    // Answering asks the advisor once an open field's probe outputs differ; without a semantic Spec there is nothing to compare (ADR-0005).
    ...(options.hypothesisChoiceAdvisor && options.semanticSpecMode !== "disabled" ? {
      fieldAdvice: {
        advisor: options.hypothesisChoiceAdvisor,
        getOriginalQuestion: (requestMessageId: string, adviceOptions?: { readonly signal?: AbortSignal }) => readOriginalQuestion(session, requestMessageId, adviceOptions?.signal),
      },
    } : {}),
    // ADR-0006: without a clarification tool an unverified population decision is disclosed, not blocked.
    populationDecisions: options.enableClarificationTool === false ? "allow_disclosed" : "require_evidence",
    evidenceSource: createEvidenceSource({
      session,
      sessionId: options.sessionId,
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.answeringEvidenceDocuments ? { documents: options.answeringEvidenceDocuments } : {}),
      clarifications: clarificationLedger,
    }),
  });
  const clarificationDialogs = new ClarificationDialogs(options.clarifications ?? new ClarificationManager(), clarificationLedger);
  const queryTasks = new QueryTaskProjection(queryTaskReadModel(answering, (context) => answeringStore.list(context)));
  // Derived datasets sit beside the session's results, outside its workspace, so no workspace write can alter them.
  const derivedDatasets = new DerivedDatasets(options.resultRoot ? new FileDerivedDatasetStore(`${options.resultRoot}/derived`) : new InMemoryDerivedDatasetStore());
  const artifacts = new ArtifactDirectory({
    findPublication: (publicationId, context) => answeringStore.transact((tx) => {
      const receipt = tx.getReceipt(publicationId as PublicationId);
      if (!receipt) return undefined;
      assertTaskAccess(tx.getTask(receipt.taskId), context);
      return receipt;
    }, context),
    readAuthorized: async (receipt, context) => {
      await resultStore.openAuthorized(receipt.resultRef, receipt, context);
      return resultStore.encodeCsv(receipt.resultRef, context);
    },
    readRowsAuthorized: async (receipt, context) => {
      const result = await resultStore.openAuthorized(receipt.resultRef, receipt, context);
      return { columns: result.columns, rows: result.rows, contentHash: result.contentHash };
    },
    readSqlAuthorized: (receipt, context) => answeringStore.transact((tx) => {
      const candidate = tx.getCandidate(receipt.candidateId);
      if (!candidate || candidate.taskId !== receipt.taskId || candidate.revisionId !== receipt.revisionId) throw new Error("PUBLICATION_SQL_NOT_FOUND");
      assertTaskAccess(tx.getTask(receipt.taskId), context);
      return { sql: candidate.sql, queryHash: candidate.queryHash };
    }, context),
  });
  const skillRoots = options.skillRoots ? [...options.skillRoots] : resolveSkillRoots({
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.packagedRoot ? { packagedRoot: options.packagedRoot } : {}),
  });
  const loadedSkills = await loadSkillsFromRoots(skillRoots);
  for (const item of loadedSkills.diagnostics) console.warn(`[data-agent] Skill diagnostic (${item.code ?? "warning"}) ${item.path}: ${item.message}`);
  const skills: Skill[] = loadedSkills.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.filePath,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    ...(skill.requiredTools ? { requiredTools: [...skill.requiredTools] } : {}),
    ...(skill.disableModelInvocation ? { disableModelInvocation: true } : {}),
  }));
  const toolContext: DataAgentToolContext = { sessionId: options.sessionId, principalId: options.principalId ?? "local" };
  const toolDefinitions: DataAgentToolDefinition<DataAgentToolContext>[] = [
    ...createCoreAgentToolDefinitions({
      workspace: options.workspace,
      skills,
      publishedRows: artifacts,
      derivedDatasets,
      ...(options.enableClarificationTool !== false ? { clarifications: clarificationDialogs } : {}),
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.knowledgeRoot ? { knowledgeRoot: options.knowledgeRoot } : {}),
      ...(options.pythonExecutable ? { pythonExecutable: options.pythonExecutable } : {}),
      ...(options.enableWidgets !== undefined ? { enableWidgets: options.enableWidgets } : {}),
    }),
    ...createAnsweringAgentToolDefinitions(
      answering,
      artifacts,
      { semanticSpecMode: options.semanticSpecMode ?? "required" },
    ),
    ...createChartToolDefinitions({ workspace: options.workspace, artifacts, derived: derivedDatasets }),
    ...(options.enableDashboards !== false ? createDashboardToolDefinitions({ workspace: options.workspace, artifacts, derived: derivedDatasets }) : []),
    ...createMcpPluginToolDefinitions(options.mcpPluginTools ?? []),
  ];
  const delegation = options.enableSubagents ? new NativeDelegation({
    executor: new HarnessChildExecutor({
      sessions: options.delegationRoot ? new JsonlChildSessionRepository(options.delegationRoot) : new MemoryChildSessionRepository(),
      models: piRuntime.models,
      model: piRuntime.model,
    }),
    resolver: createQueryTaskDelegationResolver({
      answering,
      ownerSession: session,
      principalId: toolContext.principalId,
      ownerSessionId: options.sessionId,
      ...(options.knowledge ? { knowledge: options.knowledge } : {}),
      ...(options.knowledgeRoot ? { knowledgeRoot: options.knowledgeRoot } : {}),
      ...(options.queryExecutor ? { sqlExplorer: delegationSqlExplorer(options.queryExecutor) } : {}),
      ...(options.delegationKnowledgePaths ? { knowledgePaths: options.delegationKnowledgePaths } : {}),
    }),
    ledger: new PiSessionDelegationLedger(session),
  }) : undefined;
  if (delegation) toolDefinitions.push(createSubagentToolDefinition(delegation));
  const skillToolAllowlist = Object.fromEntries(loadedSkills.skills.flatMap((skill) => skill.allowedTools ? [[skill.name, [...skill.allowedTools]]] : []));
  const baseSystemPrompt = await canonicalPrompt(options);
  const systemPrompt = delegation ? composeSubagentSystemPrompt(baseSystemPrompt) : baseSystemPrompt;
  const hostOptions: DataAgentSessionHostOptions = {
    session,
    sessionId: options.sessionId,
    toolContext,
    toolDefinitions,
    answering,
    answeringStore,
    resultStore,
    skills,
    skillToolAllowlist,
    systemPrompt,
    profile: options.profile,
    queryTaskProjection: queryTasks,
    artifactDirectory: artifacts,
    clarificationDialogs,
    dashboardRefresher: new DashboardRefresher({ workspace: options.workspace, answering, artifacts }),
    piRuntime,
  };
  const host = await createPiSessionHost(hostOptions);
  if (!delegation) return host;
  return {
    ...host,
    close: async () => {
      await delegation.close();
      await host.close();
    },
  };
}

export type { DataAgentModelProfile, DataAgentSessionHost, OpenOperation, PresentationAgentEvent, SessionQueryExecutor };
