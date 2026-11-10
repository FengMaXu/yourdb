import type {
  BusinessContext,
  CheckCoverage,
  EvidenceId,
  ExecutionOutcome,
  ImplementationObstacle,
  ImplementationObstacleKind,
  QueryAttemptKind,
  QueryAttemptPurpose,
  QueryAttemptRecord,
  QueryBudgetPolicy,
  QueryBudgetState,
  QueryTaskRecord,
  RevisionId,
  TaskId,
} from "./model.js";
import { assertTaskAccess, type AnsweringStore, type AnsweringTransaction } from "./answering-store.js";
import { AnsweringError, DATABASE_UNAVAILABLE, isDatabaseUnavailable } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { SqlExecutionError } from "./sql-execution.js";
import { now } from "./support.js";
import { MAX_FIELD_PROBES } from "./probes.js";

/**
 * Query Task budget, attempt records and Implementation Obstacles. Every
 * revision, exploration, probe and result attempt is charged here so outer
 * revisions and delegation never reset the task budget.
 */
export const DEFAULT_QUERY_BUDGET_POLICY: QueryBudgetPolicy = {
  version: "answering-dual-loop-v1",
  maxRevisions: 8,
  maxExplorationAttempts: 16,
  maxResultAttempts: 8,
  maxElapsedMs: 15 * 60 * 1_000,
  maxObservedRows: 200_000,
};

export function validateBudgetPolicy(policy: QueryBudgetPolicy): QueryBudgetPolicy {
  const values = [policy.maxRevisions, policy.maxExplorationAttempts, policy.maxResultAttempts, policy.maxElapsedMs, policy.maxObservedRows];
  if (policy.version !== "answering-dual-loop-v1" || values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new AnsweringError("INVALID_REQUEST", "Invalid Answering dual-loop budget policy");
  }
  return { ...policy };
}

export function newBudget(policy: QueryBudgetPolicy, startedAt: string): QueryBudgetState {
  return {
    policy,
    startedAt,
    revisionCount: 0,
    explorationAttempts: 0,
    resultAttempts: 0,
    observedRows: 0,
  };
}

export function taskBudget(task: QueryTaskRecord, policy: QueryBudgetPolicy): QueryBudgetState {
  return task.budget ? { ...task.budget, policy: { ...task.budget.policy } } : newBudget(policy, task.createdAt);
}

export function budgetFailure(budget: QueryBudgetState, kind: QueryAttemptKind, at: number): string | undefined {
  if (Date.parse(budget.startedAt) + budget.policy.maxElapsedMs <= at) return "task time budget exhausted";
  if (kind === "revision" && budget.revisionCount >= budget.policy.maxRevisions) return "revision budget exhausted";
  if (kind === "exploration" && budget.explorationAttempts >= budget.policy.maxExplorationAttempts) return "exploration budget exhausted";
  if (kind === "result" && budget.resultAttempts >= budget.policy.maxResultAttempts) return "result implementation budget exhausted";
  if (budget.observedRows >= budget.policy.maxObservedRows) return "observed-row budget exhausted";
  return undefined;
}

interface AttemptIdentity {
  readonly taskId: TaskId;
  readonly kind: QueryAttemptKind;
  readonly revisionId: RevisionId;
  readonly invocationId: string;
  readonly queryHash?: string;
  readonly purpose?: QueryAttemptPurpose;
}

type InitialAttemptLifecycle =
  | { readonly state: "blocked"; readonly outcome: "not_started"; readonly sqlExecuted: false; readonly obstacleKind: ImplementationObstacleKind }
  | { readonly state: "started"; readonly outcome: "not_started"; readonly sqlExecuted: false };

export type AttemptSettlement =
  | { readonly state: "succeeded"; readonly outcome: "succeeded"; readonly sqlExecuted: true }
  | { readonly state: "failed"; readonly outcome: "failed" | "succeeded"; readonly sqlExecuted: boolean; readonly obstacleKind: ImplementationObstacleKind }
  | { readonly state: "unknown"; readonly outcome: "unknown"; readonly sqlExecuted: true; readonly obstacleKind: "execution_outcome_unknown" };

function newAttempt(identity: AttemptIdentity, lifecycle: InitialAttemptLifecycle, createdAt: string): QueryAttemptRecord {
  return {
    attemptId: makeInternalId("attempt"),
    taskId: identity.taskId,
    kind: identity.kind,
    ...(identity.purpose ? { purpose: identity.purpose } : {}),
    revisionId: identity.revisionId,
    invocationId: identity.invocationId,
    ...(identity.queryHash ? { queryHash: identity.queryHash } : {}),
    ...lifecycle,
    createdAt,
    updatedAt: createdAt,
  };
}

export function blockedAttempt(identity: AttemptIdentity, obstacleKind: ImplementationObstacleKind, createdAt = now()): QueryAttemptRecord {
  return newAttempt(identity, { state: "blocked", outcome: "not_started", sqlExecuted: false, obstacleKind }, createdAt);
}

export function startedAttempt(identity: AttemptIdentity, createdAt = now()): QueryAttemptRecord {
  return newAttempt(identity, { state: "started", outcome: "not_started", sqlExecuted: false }, createdAt);
}

export function obstacle(
  tx: AnsweringTransaction,
  task: QueryTaskRecord,
  revisionId: RevisionId,
  kind: ImplementationObstacleKind,
  message: string,
  options: {
    readonly requiresOuterDecision: boolean;
    readonly retryable: boolean;
    readonly sqlExecuted: boolean;
    readonly executionOutcome: ExecutionOutcome;
    readonly queryHash?: string;
    readonly coverage?: readonly CheckCoverage[];
    readonly evidenceIds?: readonly EvidenceId[];
  },
): ImplementationObstacle {
  return {
    kind,
    taskId: task.taskId,
    revisionId,
    message,
    evidenceIds: [...(options.evidenceIds ?? [])],
    attempts: tx.listAttempts(task.taskId),
    coverage: [...(options.coverage ?? [])],
    requiresOuterDecision: options.requiresOuterDecision,
    retryable: options.retryable,
    sqlExecuted: options.sqlExecuted,
    executionOutcome: options.executionOutcome,
    ...(options.queryHash ? { queryHash: options.queryHash } : {}),
  };
}

export function obstacleDetails(details: unknown, value: ImplementationObstacle): Record<string, unknown> {
  const existing = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
  return { ...existing, obstacle: value };
}

export function reserveAttempt(
  tx: AnsweringTransaction,
  task: QueryTaskRecord,
  policy: QueryBudgetPolicy,
  kind: QueryAttemptKind,
  revisionId: RevisionId,
  invocationId: string,
  queryHash?: string,
  purpose?: QueryAttemptPurpose,
): { readonly task: QueryTaskRecord; readonly attempt?: QueryAttemptRecord; readonly obstacle?: ImplementationObstacle } {
  const at = Date.now();
  const budget = taskBudget(task, policy);
  // Probes have their own per-task cap and do not consume exploration attempts (ADR-0005).
  const fieldProbe = purpose === "field_probe";
  const probeCount = fieldProbe ? tx.listAttempts(task.taskId).filter((item) => item.purpose === "field_probe" && item.state !== "blocked").length : 0;
  const reason = fieldProbe
    ? Date.parse(budget.startedAt) + budget.policy.maxElapsedMs <= at ? "task time budget exhausted"
      : budget.observedRows >= budget.policy.maxObservedRows ? "observed-row budget exhausted"
        : probeCount >= MAX_FIELD_PROBES ? "probe budget exhausted" : undefined
    : budgetFailure(budget, kind, at);
  if (reason) {
    const blocked = blockedAttempt({ taskId: task.taskId, kind, revisionId, invocationId, ...(queryHash ? { queryHash } : {}), ...(purpose ? { purpose } : {}) }, "budget_exhausted");
    tx.putAttempt(blocked);
    const current = { ...task, budget, updatedAt: blocked.updatedAt };
    tx.putTask(current);
    return {
      task: current,
      obstacle: obstacle(tx, current, revisionId, "budget_exhausted", reason, {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: false,
        executionOutcome: "not_started",
        ...(queryHash ? { queryHash } : {}),
      }),
    };
  }
  const nextBudget: QueryBudgetState = fieldProbe
    ? budget
    : kind === "revision"
    ? { ...budget, revisionCount: budget.revisionCount + 1 }
    : kind === "exploration"
      ? { ...budget, explorationAttempts: budget.explorationAttempts + 1 }
      : { ...budget, resultAttempts: budget.resultAttempts + 1 };
  const started = startedAttempt({ taskId: task.taskId, kind, revisionId, invocationId, ...(queryHash ? { queryHash } : {}), ...(purpose ? { purpose } : {}) });
  const current = { ...task, budget: nextBudget, updatedAt: started.updatedAt };
  tx.putTask(current);
  tx.putAttempt(started);
  return { task: current, attempt: started };
}

export function settleAttempt(tx: AnsweringTransaction, attempt: QueryAttemptRecord, settlement: AttemptSettlement): QueryAttemptRecord {
  // Callers may hold a copy from before an earlier settlement in this run; the stored record decides.
  const stored = tx.listAttempts(attempt.taskId).find((record) => record.attemptId === attempt.attemptId) ?? attempt;
  if (stored.state !== "started") return stored;
  const { obstacleKind: _previousObstacle, ...base } = stored;
  const updated: QueryAttemptRecord = { ...base, ...settlement, updatedAt: now() };
  tx.putAttempt(updated);
  return updated;
}

/**
 * Shared exploration/result handling of an executor failure: record the
 * attempt outcome, then raise the classified Implementation Obstacle. An
 * unknown external outcome is never retried.
 */
export async function throwExecutionFailure(
  store: AnsweringStore,
  taskId: TaskId,
  revisionId: RevisionId,
  attempt: QueryAttemptRecord | undefined,
  error: unknown,
  sqlStarted: boolean,
  queryHash: string,
  context: BusinessContext,
): Promise<never> {
  if (error instanceof AnsweringError) throw error;
  if (context.signal?.aborted) throw error;
  if (isDatabaseUnavailable(error)) {
    // Infrastructure loss ends the operation; it is not an obstacle for the Agent to work around.
    await store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      if (attempt) settleAttempt(tx, attempt, { state: "failed", outcome: "failed", sqlExecuted: sqlStarted, obstacleKind: "technical_failure" });
    }, context);
    throw new AnsweringError(DATABASE_UNAVAILABLE, error instanceof Error ? error.message : String(error));
  }
  const unknown = error instanceof SqlExecutionError && error.outcome === "unknown";
  const kind: ImplementationObstacleKind = unknown ? "execution_outcome_unknown" : error instanceof SqlExecutionError ? error.obstacleKind : "technical_failure";
  const details = await store.transact((tx) => {
    const current = tx.getTask(taskId);
    assertTaskAccess(current, context);
    if (attempt) settleAttempt(tx, attempt, unknown
      ? { state: "unknown", outcome: "unknown", sqlExecuted: true, obstacleKind: "execution_outcome_unknown" }
      : { state: "failed", outcome: "failed", sqlExecuted: sqlStarted, obstacleKind: kind });
    return obstacle(tx, current, revisionId, kind, error instanceof Error ? error.message : String(error), {
      requiresOuterDecision: unknown || kind !== "technical_failure",
      retryable: !unknown && kind === "technical_failure",
      sqlExecuted: sqlStarted,
      executionOutcome: unknown ? "unknown" : sqlStarted ? "failed" : "not_started",
      queryHash,
    });
  }, context);
  throw new AnsweringError(unknown ? "RESULT_EXECUTION_OUTCOME_UNKNOWN" : "QUERY_EXECUTION_FAILED", details.message, obstacleDetails(undefined, details));
}
