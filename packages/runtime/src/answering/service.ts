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
  type InvocationMemo,
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
import type { AnsweringDeps, EntityIdentityOptions, FanoutAnsweringOptions, SemanticQualificationMode } from "./deps.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import type { FieldAdviceOptions } from "./advice-execution.js";
import type { DataFalsificationOptions } from "./data-falsification.js";
import { SchemaProfile, type SchemaProfileOptions } from "./schema-profile.js";
import { assertContext } from "./support.js";
import { taskViewFromBundle } from "./views.js";

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
  /** Bounds of the entity identity counts (rows above which DISTINCT is skipped, per-query timeout). */
  readonly entityIdentity?: EntityIdentityOptions;
  /** Bounds of the data falsification probes after a result query (probe count, per-probe timeout). */
  readonly dataFalsification?: DataFalsificationOptions;
  /** Bounds of the session's Schema Profile reads (rows above which a table is not scanned, per-read timeout). */
  readonly schemaProfile?: SchemaProfileOptions;
  /** How a Receipt names its published artifact; the HTTP composition root injects its route. Default: an opaque handle. */
  readonly formatPublicRef?: (receiptId: string, sessionId: string) => string;
}


function resolveDeps(options: InMemoryAnsweringOptions): AnsweringDeps {
  const fanout = { ...(options.fanout ?? {}) };
  const loadFanoutSchema = createFanoutSchemaLoader(fanout, options.sqlExecutor);
  const timeoutMs = options.schemaProfile?.timeoutMs ?? options.entityIdentity?.timeoutMs;
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
    ...(options.entityIdentity ? { entityIdentity: options.entityIdentity } : {}),
    ...(options.dataFalsification ? { dataFalsification: options.dataFalsification } : {}),
    ...(options.formatPublicRef ? { formatPublicRef: options.formatPublicRef } : {}),
    loadFanoutSchema,
    schemaProfile: new SchemaProfile(options.sqlExecutor, loadFanoutSchema, { ...(options.schemaProfile?.maxRows !== undefined ? { maxRows: options.schemaProfile.maxRows } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }),
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
  private readonly resultExecutions = new Map<string, SharedExecution<QueryExecutionView>>();
  /** Coalesce concurrent refreshes of one Receipt under one request id: the query runs once. */
  private readonly refreshes = new Map<string, Promise<PublicationReceipt>>();

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
    let joined: Promise<QueryExecutionView>;
    if (resultKey) {
      let shared = this.resultExecutions.get(resultKey);
      if (!shared) {
        const created = new SharedExecution<QueryExecutionView>((sharedContext) => this.executeOnce(input, { ...context, ...sharedContext }), context.memo);
        shared = created;
        this.resultExecutions.set(resultKey, created);
        void created.promise.finally(() => {
          if (this.resultExecutions.get(resultKey) === created) this.resultExecutions.delete(resultKey);
        }).catch(() => undefined);
      }
      joined = shared.join(context);
    } else {
      joined = this.executeOnce(input, context);
    }
    const promise = joined.finally(() => {
      if (this.invocationExecutions.get(key)?.promise === promise) this.invocationExecutions.delete(key);
    });
    this.invocationExecutions.set(key, { signature, promise });
    return promise;
  }

  private async executeOnce(input: ExecuteQuery, context: BusinessContext): Promise<QueryExecutionView> {
    assertContext(context);
    const taskId = input.taskId as TaskId;
    const revisionOf = (task: { readonly currentRevisionId: RevisionId }) => (input.kind === "result" ? input.revisionId : context.expectedRevisionId ?? task.currentRevisionId) as RevisionId;
    // The preflight is pure, so a read-only result query reads its task inside its own first transaction.
    if (!isReadOnlySql(input.sql)) {
      const details = await this.deps.store.transact((tx) => {
        const task = tx.getTask(taskId);
        assertTaskAccess(task, context);
        return obstacle(tx, task, revisionOf(task), "technical_failure", "Only one read-only SQL statement is allowed", {
          requiresOuterDecision: false,
          retryable: false,
          sqlExecuted: false,
          executionOutcome: "not_started",
        });
      }, context);
      throw new AnsweringError("INVALID_QUERY", details.message, obstacleDetails(undefined, details));
    }
    if (input.kind === "result") return executeResult(this.deps, input, input.revisionId as RevisionId, this.deps.maxResultRows, context);
    const task = await this.deps.store.transact((tx) => tx.getTask(taskId), context);
    assertTaskAccess(task, context);
    return executeExploration(this.deps, input, revisionOf(task), context.expectedRevisionId !== undefined, normalizeLimit(input.limit, 50, 10_000), context);
  }

  async publish(input: PublishCandidate, context: BusinessContext): Promise<PublicationReceipt> {
    assertContext(context);
    return publishCandidate(this.deps, input, context);
  }

  async refresh(input: RefreshPublication, context: BusinessContext): Promise<PublicationReceipt> {
    assertContext(context);
    const key = `${context.sessionId}:${input.receiptId}:${input.requestId}`;
    const existing = this.refreshes.get(key);
    if (existing) return existing;
    const promise = refreshPublication(this.deps, input, context).finally(() => {
      if (this.refreshes.get(key) === promise) this.refreshes.delete(key);
    });
    this.refreshes.set(key, promise);
    return promise;
  }

  async inspect(input: InspectAnswer, context: BusinessContext): Promise<AnswerTaskView> {
    assertContext(context);
    const bundle = await this.deps.store.readTaskBundle(input.taskId as unknown as TaskId, context);
    if (!bundle) throw new AnsweringError("TASK_NOT_FOUND", `Task ${input.taskId} was not found`);
    return taskViewFromBundle(bundle);
  }
}

/**
 * One execution shared by concurrent equivalent callers. It runs under its own
 * AbortController, cancelled only once every caller has aborted, so one
 * caller's cancellation never fails another's request. Memo writes go to
 * every caller's own memo, including callers that join later.
 */
class SharedExecution<T> {
  readonly promise: Promise<T>;
  private readonly controller = new AbortController();
  private readonly memos = new Set<InvocationMemo>();
  private readonly written = new Map<string, unknown>();
  private active = 0;

  constructor(run: (context: { readonly signal: AbortSignal; readonly memo: InvocationMemo }) => Promise<T>, private readonly leaderMemo: InvocationMemo | undefined) {
    const memo: InvocationMemo = {
      get: async (name) => this.written.has(name) ? this.written.get(name) : this.leaderMemo?.get(name),
      set: async (name, value) => {
        this.written.set(name, value);
        await Promise.all([...this.memos].map((item) => item.set(name, value)));
      },
    };
    // Start after the constructor returns, so the first caller is registered before the run begins.
    this.promise = Promise.resolve().then(() => run({ signal: this.controller.signal, memo }));
    this.promise.catch(() => undefined);
  }

  async join(context: BusinessContext): Promise<T> {
    const signal = context.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (context.memo && !this.memos.has(context.memo)) {
      this.memos.add(context.memo);
      // A late caller's memo catches up with what the shared run already recorded.
      for (const [name, value] of this.written) await context.memo.set(name, value);
    }
    this.active += 1;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      this.active -= 1;
      if (this.active === 0) this.controller.abort(signal?.reason);
    };
    if (!signal) return this.promise.finally(() => { detached = true; });
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const last = this.active === 1;
        detach();
        // The last caller cancels the run and sees its own outcome; an earlier one leaves the others running.
        if (!last) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.promise.then(resolve, reject).finally(() => {
        detached = true;
        signal.removeEventListener("abort", onAbort);
      });
    });
  }
}
