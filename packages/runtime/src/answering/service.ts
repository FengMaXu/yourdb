import {
  contentHash,
  normalizeLimit,
  isReadOnlySql,
  type AnswerRevisionView,
  type AnswerTaskView,
  type BusinessContext,
  type ExecuteQuery,
  type InspectAnswer,
  type PublicationReceipt,
  type PublishCandidate,
  type RefreshPublication,
  type QueryExecutionView,
  type SetAnswerFields,
  type RevisionId,
  type TaskId,
  type QueryBudgetPolicy,
} from "./model.js";
import { assertTaskAccess, type AnsweringStore } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { InMemoryResultStore, type ResultStore } from "./result-store.js";
import type { EvidenceSource } from "./evidence-admission.js";
import { DEFAULT_QUERY_BUDGET_POLICY, obstacle, obstacleDetails, validateBudgetPolicy } from "./budget.js";
import { setAnswerFields } from "./revision.js";
import { executeExploration } from "./exploration.js";
import { executeResult } from "./result-execution.js";
import { createFanoutSchemaLoader } from "./fanout-execution.js";
import { publishCandidate } from "./publication.js";
import { refreshPublication } from "./refresh.js";
import type { AnsweringDeps, FanoutAnsweringOptions, SemanticQualificationMode } from "./deps.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import type { FieldAdviceOptions } from "./advice-execution.js";

export { AnsweringError };
export { DEFAULT_QUERY_BUDGET_POLICY };
export { SqlExecutionError, type AnsweringSqlExecutor, type SqlQueryResult } from "./sql-execution.js";
export type { FanoutAnsweringOptions, SemanticQualificationMode } from "./deps.js";

/** The five public Answering use cases; the architecture gate pins this list. */
export interface Answering {
  /** Write Answer Spec fields by path; without taskId it starts the Query Task (ADR-0007). */
  set(input: SetAnswerFields, context: BusinessContext): Promise<AnswerRevisionView>;
  execute(input: ExecuteQuery, context: BusinessContext): Promise<QueryExecutionView>;
  publish(input: PublishCandidate, context: BusinessContext): Promise<PublicationReceipt>;
  /** Re-run a published result's query and publish the rows as a new Receipt (ADR-0010). */
  refresh(input: RefreshPublication, context: BusinessContext): Promise<PublicationReceipt>;
  inspect(input: InspectAnswer, context: BusinessContext): Promise<AnswerTaskView>;
}

const MAX_RESULT_ROWS = 100_000;

export interface InMemoryAnsweringOptions {
  readonly store: AnsweringStore;
  readonly sqlExecutor: AnsweringSqlExecutor;
  readonly resultStore?: ResultStore;
  readonly maxResultRows?: number;
  /** Versioned task budget; revision/delegation work must not reset it. */
  readonly budgetPolicy?: QueryBudgetPolicy;
  /** Optional bounded JOIN fanout diagnostics; enabled by default when applicable. */
  readonly fanout?: FanoutAnsweringOptions;
  /** Evaluation-only: preserve task/candidate/receipt identity without semantic qualification. */
  readonly semanticQualificationMode?: SemanticQualificationMode;
  /**
   * Trusted text sources for Evidence Admission (ADR-0004). Without it, quoted
   * text evidence cannot be verified and is rejected.
   */
  readonly evidenceSource?: EvidenceSource;
  /**
   * Probes (ADR-0005): an open field is decided only after every alternative
   * has a probe or a waiver, and the view shows whether outputs differ.
   */
  readonly fieldProbes?: boolean;
  /**
   * The comparison advisor (ADR-0005). With probes, the Runtime asks it about
   * an open field once every alternative's output is known and they differ,
   * and a decision on such a field needs that advice.
   */
  readonly fieldAdvice?: FieldAdviceOptions;
  /**
   * ADR-0006: "require_evidence" (default) when the session can ask the user;
   * "allow_disclosed" when it cannot, so an unverified population decision is disclosed instead.
   */
  readonly populationDecisions?: "require_evidence" | "allow_disclosed";
}

function assertContext(context: BusinessContext): void {
  if (!context?.principal?.id || !context.sessionId || !context.operationId || !context.invocationId) {
    throw new AnsweringError("ANSWERING_CONTEXT_INVALID", "Answering requires principal, session, operation and invocation identities");
  }
  if (context.signal?.aborted) throw new AnsweringError("ANSWERING_CONTEXT_INVALID", "Answering operation was cancelled");
}

function resolveDeps(options: InMemoryAnsweringOptions): AnsweringDeps {
  const fanout = { ...(options.fanout ?? {}) };
  return {
    store: options.store,
    resultStore: options.resultStore ?? new InMemoryResultStore(),
    sqlExecutor: options.sqlExecutor,
    budgetPolicy: validateBudgetPolicy(options.budgetPolicy ?? DEFAULT_QUERY_BUDGET_POLICY),
    maxResultRows: Math.max(1, Math.trunc(options.maxResultRows ?? MAX_RESULT_ROWS)),
    semanticQualificationMode: options.semanticQualificationMode ?? "required",
    fieldProbes: options.fieldProbes === true,
    ...(options.fieldAdvice ? { fieldAdvice: options.fieldAdvice } : {}),
    adviceRequired: options.fieldProbes === true && Boolean(options.fieldAdvice),
    populationDecisions: options.populationDecisions ?? "require_evidence",
    ...(options.evidenceSource ? { evidenceSource: options.evidenceSource } : {}),
    fanout,
    loadFanoutSchema: createFanoutSchemaLoader(fanout, options.sqlExecutor),
  };
}

/**
 * The deep Answering module. It owns semantic state and publication policy;
 * Pi, Hosts and Tools only supply invocation context and call these methods.
 * Each use case lives in its own module (revision, exploration,
 * result-execution, publication) and keeps its own transaction boundaries.
 */
export class InMemoryAnswering implements Answering {
  private readonly deps: AnsweringDeps;
  /** Ephemeral coalescing only; Pi Invocation remains the durable replay authority. */
  private readonly invocationExecutions = new Map<string, { signature: string; promise: Promise<QueryExecutionView> }>();
  /** Coalesce equivalent final executions even when a transport retry receives a new invocation id. */
  private readonly resultExecutions = new Map<string, Promise<QueryExecutionView>>();

  constructor(options: InMemoryAnsweringOptions) {
    this.deps = resolveDeps(options);
  }

  async set(input: SetAnswerFields, context: BusinessContext): Promise<AnswerRevisionView> {
    assertContext(context);
    return setAnswerFields(this.deps, input, context);
  }

  async execute(input: ExecuteQuery, context: BusinessContext): Promise<QueryExecutionView> {
    assertContext(context);
    const key = `${context.sessionId}:${context.invocationId}`;
    const signature = contentHash({ kind: input.kind, taskId: input.taskId, revisionId: "revisionId" in input ? input.revisionId : undefined, sql: input.sql.trim(), maxPreviewBytes: input.kind === "exploration" ? input.maxPreviewBytes : undefined, probe: input.kind === "exploration" ? input.probe : undefined });
    const existingExecution = this.invocationExecutions.get(key);
    if (existingExecution) {
      if (existingExecution.signature !== signature) throw new AnsweringError("INVALID_REQUEST", "RESULT_INVOCATION_IDEMPOTENCY_CONFLICT");
      return existingExecution.promise;
    }
    const resultKey = input.kind === "result"
      ? contentHash({ sessionId: context.sessionId, taskId: input.taskId, revisionId: input.revisionId, sql: input.sql.trim() })
      : undefined;
    let shared = resultKey ? this.resultExecutions.get(resultKey) : undefined;
    if (!shared) {
      shared = this.executeOnce(input, context);
      if (resultKey) {
        this.resultExecutions.set(resultKey, shared);
        void shared.finally(() => {
          if (this.resultExecutions.get(resultKey) === shared) this.resultExecutions.delete(resultKey);
        }).catch(() => undefined);
      }
    }
    const promise = shared.finally(() => {
      if (this.invocationExecutions.get(key)?.promise === promise) this.invocationExecutions.delete(key);
    });
    this.invocationExecutions.set(key, { signature, promise });
    return promise;
  }

  private async executeOnce(input: ExecuteQuery, context: BusinessContext): Promise<QueryExecutionView> {
    assertContext(context);
    const taskId = input.taskId as TaskId;
    const task = await this.deps.store.transact((tx) => tx.getTask(taskId), context);
    assertTaskAccess(task, context);
    const revisionId = (input.kind === "result" ? input.revisionId : context.expectedRevisionId ?? task.currentRevisionId) as RevisionId;
    if (!isReadOnlySql(input.sql)) {
      const details = await this.deps.store.transact((tx) => obstacle(tx, task, revisionId, "technical_failure", "Only one read-only SQL statement is allowed", {
        requiresOuterDecision: false,
        retryable: false,
        sqlExecuted: false,
        executionOutcome: "not_started",
      }), context);
      throw new AnsweringError("INVALID_QUERY", details.message, obstacleDetails(undefined, details));
    }
    if (input.kind === "exploration") {
      return executeExploration(this.deps, input, revisionId, context.expectedRevisionId !== undefined, normalizeLimit(input.limit, 50, 10_000), context);
    }
    return executeResult(this.deps, input, revisionId, this.deps.maxResultRows, context);
  }

  async publish(input: PublishCandidate, context: BusinessContext): Promise<PublicationReceipt> {
    assertContext(context);
    return publishCandidate(this.deps, input, context);
  }

  async refresh(input: RefreshPublication, context: BusinessContext): Promise<PublicationReceipt> {
    assertContext(context);
    return refreshPublication(this.deps, input, context);
  }

  async inspect(input: InspectAnswer, context: BusinessContext): Promise<AnswerTaskView> {
    assertContext(context);
    const view = await this.deps.store.inspect(input.taskId as unknown as TaskId, context);
    if (!view) throw new AnsweringError("TASK_NOT_FOUND", `Task ${input.taskId} was not found`);
    return view;
  }
}
