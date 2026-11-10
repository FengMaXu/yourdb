import { randomUUID } from "node:crypto";
import {
  contentHash,
  type AnswerRevisionRecord,
  type BoundedResult,
  type BusinessContext,
  type CheckCoverage,
  type ExecuteQuery,
  type ImplementationObstacle,
  type QueryAttemptRecord,
  type QueryExecutionView,
  type ReadyRevision,
  type ResultCandidateRecord,
  type RevisionId,
  type TaskId,
} from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { blockedAttempt, obstacle, obstacleDetails, reserveAttempt, settleAttempt, taskBudget, throwExecutionFailure } from "./budget.js";
import { sealForResult } from "./qualification.js";
import { assertDeliverable } from "./report.js";
import { equivalentPaths, realizationConflicts } from "./probes.js";
import { candidateCheckFailure, evaluateCandidateCheckReport } from "./candidate-checks.js";
import { evaluateFanout, fanoutCoverage, fanoutFindings } from "./fanout-execution.js";
import type { PrivateResultObject } from "./result-store.js";
import { boundedResult } from "./sql-execution.js";
import { resultFingerprint } from "./result-fingerprint.js";
import { evaluateSpecRealization } from "./realization-check.js";
import { entityIdentityCoverage, entityIdentityFindings } from "./entity-identity.js";
import { calendarCoverageCoverage, calendarCoverageFindings } from "./calendar-coverage.js";
import { recordDataChecks } from "./data-checks-execution.js";
import { asRecord, now } from "./support.js";
import type { AnsweringDeps } from "./deps.js";

type ResultInput = Extract<ExecuteQuery, { readonly kind: "result" }>;

type ResultExecutionMemo =
  | {
      readonly state: "started";
      readonly taskId: string;
      readonly revisionId: string;
      readonly queryHash: string;
    }
  | {
      readonly state: "settled";
      readonly taskId: string;
      readonly revisionId: string;
      readonly queryHash: string;
      /** Settled memos point at ResultStore; result rows never enter Pi Session state. */
      readonly resultRef: string;
      readonly contentHash: string;
    };

type ReadyCandidate = ResultCandidateRecord & { readonly status: "ready"; readonly publishable: true };
type CorruptCandidate = ResultCandidateRecord & { readonly status: "corrupt"; readonly publishable: false };
type CandidateLifecycle =
  | { readonly state: "ready"; readonly candidate: ReadyCandidate }
  | { readonly state: "corrupt"; readonly candidate: CorruptCandidate }
  | { readonly state: "invalid"; readonly candidate: ResultCandidateRecord };

export function candidateLifecycle(candidate: ResultCandidateRecord): CandidateLifecycle {
  if (candidate.status === "ready" && candidate.publishable === true) return { state: "ready", candidate: candidate as ReadyCandidate };
  if (candidate.status === "corrupt" && candidate.publishable === false) return { state: "corrupt", candidate: candidate as CorruptCandidate };
  return { state: "invalid", candidate };
}

function resultExecutionMemo(value: unknown): ResultExecutionMemo | undefined {
  const record = asRecord(value);
  if (!record || (record.state !== "started" && record.state !== "settled") || typeof record.taskId !== "string" || typeof record.revisionId !== "string" || typeof record.queryHash !== "string") return undefined;
  if (record.state === "settled") {
    if (typeof record.resultRef !== "string" || typeof record.contentHash !== "string") return undefined;
    return { state: "settled", taskId: record.taskId, revisionId: record.revisionId, queryHash: record.queryHash, resultRef: record.resultRef, contentHash: record.contentHash };
  }
  return { state: "started", taskId: record.taskId, revisionId: record.revisionId, queryHash: record.queryHash };
}

export async function markCandidateCorrupt(deps: AnsweringDeps, candidate: ResultCandidateRecord, context: BusinessContext): Promise<void> {
  await deps.store.transact((tx) => {
    const current = tx.getCandidate(candidate.candidateId);
    if (!current || current.status === "corrupt") return;
    tx.putCandidate({ ...current, status: "corrupt", publishable: false, findings: [...current.findings, { id: `integrity-${current.candidateId}`, kind: "integrity_conflict", message: "ResultStore object is missing or does not match the Candidate content hash.", blocking: true }] });
  }, context).catch(() => undefined);
}

async function resultView(deps: AnsweringDeps, candidate: ResultCandidateRecord, context: BusinessContext): Promise<QueryExecutionView> {
  if (candidateLifecycle(candidate).state !== "ready") throw new AnsweringError("RESULT_INTEGRITY_MISMATCH", "Result Candidate is corrupt and cannot be used");
  try {
    const result = await deps.resultStore.openPrivate(candidate.resultRef, context);
    if (!result || result.contentHash !== candidate.contentHash) throw new Error("RESULT_INTEGRITY_MISMATCH");
    const preview: BoundedResult = { columns: result.columns, rows: result.rows.slice(0, 50), columnTypes: result.columnTypes, rowCount: result.rowCount, truncated: result.rowCount > 50 };
    return {
      kind: "result",
      artifact: { kind: "candidate", candidateId: candidate.candidateId, revisionId: candidate.revisionId, resultRef: candidate.resultRef },
      preview,
      findings: candidate.findings,
      ...(candidate.coverage ? { coverage: candidate.coverage } : {}),
      ...(candidate.fanout ? { fanout: candidate.fanout } : {}),
      ...(candidate.attemptId ? { attemptId: candidate.attemptId } : {}),
    };
  } catch {
    await markCandidateCorrupt(deps, candidate, context);
    throw new AnsweringError("RESULT_INTEGRITY_MISMATCH", "Result Candidate references a missing or changed private result");
  }
}

/** Seal the current Revision, or record a blocked result attempt while anything is unresolved. */
async function sealRevision(deps: AnsweringDeps, input: ResultInput, taskId: TaskId, revisionId: RevisionId, queryHash: string, context: BusinessContext): Promise<AnswerRevisionRecord> {
  const sealedOutcome = await deps.store.transact((tx) => {
    const currentTask = tx.getTask(taskId);
    assertTaskAccess(currentTask, context);
    if (currentTask.currentRevisionId !== revisionId) throw new AnsweringError("REVISION_STALE", "Result query must use the current revision", { currentRevisionId: currentTask.currentRevisionId });
    // ADR-0009: a Report Task never delivers; a chart query needs a current, handled Report Task.
    assertDeliverable(tx, currentTask);
    const revision = tx.getRevision(revisionId);
    if (!revision) throw new AnsweringError("REVISION_NOT_FOUND", `Revision ${input.revisionId} was not found`);
    const result = deps.semanticQualificationMode === "required"
      ? sealForResult(revision, equivalentPaths(revision.fields, currentTask.fieldProbes ?? []))
      : {
          ok: true as const,
          revision: {
            state: "ready" as const,
            revisionId: revision.revisionId,
            ready: `ready_${randomUUID()}` as ReadyRevision["ready"],
          },
        };
    if (!result.ok) {
      const blocked = blockedAttempt({ taskId, kind: "result", revisionId, invocationId: context.invocationId, queryHash }, "business_judgment_required");
      tx.putAttempt(blocked);
      const parts = [
        ...(result.undeclared.length > 0 ? [`declare ${result.undeclared.join(", ")}`] : []),
        ...(result.open.length > 0 ? [`decide or probe the open fields ${result.open.join(", ")}`] : []),
      ];
      const details = obstacle(tx, currentTask, revisionId, "business_judgment_required", `Final query is blocked until every required field has a state and no field is left open: ${parts.join("; ")}`, {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: false,
        executionOutcome: "not_started",
        queryHash,
      });
      return { obstacle: details, undeclared: result.undeclared, open: result.open } as const;
    }
    const readyRevision: AnswerRevisionRecord = { ...revision, state: result.revision };
    tx.putRevision(readyRevision);
    return { revision: readyRevision } as const;
  }, context);
  if ("obstacle" in sealedOutcome) {
    throw new AnsweringError("UNRESOLVED_ASSUMPTIONS", sealedOutcome.obstacle.message, obstacleDetails({ undeclared: sealedOutcome.undeclared, open: sealedOutcome.open }, sealedOutcome.obstacle));
  }
  return sealedOutcome.revision;
}

type ResultPreflight =
  | { readonly state: "existing"; readonly candidate: ResultCandidateRecord }
  | { readonly state: "unknown"; readonly obstacle: ImplementationObstacle }
  | { readonly state: "blocked"; readonly obstacle: ImplementationObstacle }
  | { readonly state: "reserved"; readonly attempt: QueryAttemptRecord };

async function prepareResultExecution(
  deps: AnsweringDeps,
  taskId: TaskId,
  revisionId: RevisionId,
  queryHash: string,
  context: BusinessContext,
): Promise<ResultPreflight> {
  return deps.store.transact((tx) => {
    const existing = tx.findCandidateByInvocation(taskId, context.invocationId) ?? tx.findCandidateByQuery(taskId, revisionId, queryHash);
    if (existing) return { state: "existing", candidate: existing };
    const current = tx.getTask(taskId);
    assertTaskAccess(current, context);
    const unknownAttempt = tx.findAttemptByQuery(taskId, revisionId, queryHash, "result");
    if (unknownAttempt?.outcome === "unknown") {
      return {
        state: "unknown",
        obstacle: obstacle(tx, current, revisionId, "execution_outcome_unknown", "A matching result query has an unknown execution outcome; SQL was not retried", {
          requiresOuterDecision: true,
          retryable: false,
          sqlExecuted: true,
          executionOutcome: "unknown",
          queryHash,
        }),
      };
    }
    const reservation = reserveAttempt(tx, current, deps.budgetPolicy, "result", revisionId, context.invocationId, queryHash);
    if (reservation.obstacle) return { state: "blocked", obstacle: reservation.obstacle };
    if (!reservation.attempt) throw new Error("RESULT_ATTEMPT_RESERVATION_INVALID");
    return { state: "reserved", attempt: reservation.attempt };
  }, context);
}

type CandidateCommitOutcome =
  | { readonly state: "created"; readonly candidate: ResultCandidateRecord }
  | { readonly state: "existing"; readonly candidate: ResultCandidateRecord }
  | { readonly state: "recovered"; readonly candidate: ResultCandidateRecord };

async function commitCandidate(
  deps: AnsweringDeps,
  candidate: ResultCandidateRecord,
  taskId: TaskId,
  revisionId: RevisionId,
  queryHash: string,
  context: BusinessContext,
): Promise<CandidateCommitOutcome> {
  try {
    return await deps.store.transact((tx) => {
      const currentTask = tx.getTask(taskId);
      assertTaskAccess(currentTask, context);
      if (currentTask.currentRevisionId !== revisionId) throw new AnsweringError("REVISION_STALE", "Revision changed while the result was executing");
      const prior = tx.findCandidateByInvocation(taskId, context.invocationId) ?? tx.findCandidateByQuery(taskId, revisionId, queryHash);
      if (prior) return { state: "existing", candidate: prior } as const;
      tx.putCandidate(candidate);
      tx.putTask({ ...currentTask, latestCandidateId: candidate.candidateId, updatedAt: candidate.createdAt });
      return { state: "created", candidate } as const;
    }, context);
  } catch (error) {
    // A commit response may be lost after the Candidate became durable. Look
    // it up by stable query identity before reporting failure. Otherwise keep
    // the private object for Pi invocation replay; a later GC pass removes
    // objects that remain unreferenced after the invocation is settled.
    const recovered = await deps.store.transact((tx) => tx.findCandidateByQuery(taskId, revisionId, queryHash), context).catch(() => undefined);
    if (recovered) return { state: "recovered", candidate: recovered };
    throw error;
  }
}

/**
 * The one final query of a sealed Revision. It executes at most once per
 * invocation (Pi memo + stable query identity), freezes an immutable Result
 * Candidate, and never retries an unknown external outcome.
 */
export async function executeResult(
  deps: AnsweringDeps,
  input: ResultInput,
  revisionId: RevisionId,
  limit: number,
  context: BusinessContext,
): Promise<QueryExecutionView> {
  const taskId = input.taskId as TaskId;
  const queryHash = contentHash(input.sql.trim());
  // The set call reads the data checks after its Revision commits; a result query that
  // reaches the Revision first reads them here, so calendar coverage cannot miss the seal.
  if (deps.semanticQualificationMode === "required") await recordDataChecks(deps, taskId, revisionId, context);
  const sealed = await sealRevision(deps, input, taskId, revisionId, queryHash, context);
  const realization = evaluateSpecRealization(sealed.fields, input.sql);
  const unrealized = realization.findings.filter((item) => item.blocking);
  if (unrealized.length > 0) {
    // The SQL cannot implement the sealed fields, so it is not run: fix the SQL, or rewrite the field with a reason.
    const details = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      tx.putAttempt(blockedAttempt({ taskId, kind: "result", revisionId, invocationId: context.invocationId, queryHash }, "technical_failure"));
      return obstacle(tx, current, revisionId, "technical_failure", `The final SQL does not implement the sealed Answer Spec: ${unrealized.map((item) => item.message).join("; ")}`, {
        requiresOuterDecision: false,
        retryable: true,
        sqlExecuted: false,
        executionOutcome: "not_started",
        queryHash,
        coverage: [realization.coverage],
      });
    }, context);
    throw new AnsweringError("SPEC_NOT_REALIZED", details.message, obstacleDetails({ findings: realization.findings, verdicts: realization.verdicts }, details));
  }

  const memo = resultExecutionMemo(await context.memo?.get("answering.result-execution"));
  if (memo && (memo.taskId !== input.taskId || memo.revisionId !== input.revisionId || memo.queryHash !== queryHash)) {
    throw new AnsweringError("INVALID_REQUEST", "RESULT_INVOCATION_IDEMPOTENCY_CONFLICT");
  }
  let attempt: QueryAttemptRecord | undefined;
  if (memo?.state === "started") {
    const details = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      const priorAttempt = tx.findAttemptByInvocation(taskId, context.invocationId, "result");
      if (priorAttempt?.state === "started") settleAttempt(tx, priorAttempt, { state: "unknown", outcome: "unknown", sqlExecuted: true, obstacleKind: "execution_outcome_unknown" });
      return obstacle(tx, current, revisionId, "execution_outcome_unknown", "The previous result execution has no safe replay outcome; SQL was not retried", {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: true,
        executionOutcome: "unknown",
        queryHash,
      });
    }, context);
    throw new AnsweringError("RESULT_EXECUTION_OUTCOME_UNKNOWN", details.message, obstacleDetails(undefined, details));
  }
  if (!memo) {
    const preflight = await prepareResultExecution(deps, taskId, revisionId, queryHash, context);
    if (preflight.state === "existing") {
      if (preflight.candidate.queryHash !== queryHash) throw new AnsweringError("INVALID_REQUEST", "RESULT_INVOCATION_IDEMPOTENCY_CONFLICT");
      return resultView(deps, preflight.candidate, context);
    }
    if (preflight.state === "unknown") throw new AnsweringError("RESULT_EXECUTION_OUTCOME_UNKNOWN", preflight.obstacle.message, obstacleDetails(undefined, preflight.obstacle));
    if (preflight.state === "blocked") throw new AnsweringError("IMPLEMENTATION_BUDGET_EXHAUSTED", preflight.obstacle.message, obstacleDetails(undefined, preflight.obstacle));
    attempt = preflight.attempt;
  } else {
    const existing = await deps.store.transact((tx) => tx.findCandidateByInvocation(taskId, context.invocationId) ?? tx.findCandidateByQuery(taskId, revisionId, queryHash), context);
    if (existing) {
      if (existing.queryHash !== queryHash) throw new AnsweringError("INVALID_REQUEST", "RESULT_INVOCATION_IDEMPOTENCY_CONFLICT");
      return resultView(deps, existing, context);
    }
    attempt = await deps.store.transact((tx) => tx.findAttemptByInvocation(taskId, context.invocationId, "result"), context);
  }

  let privateResult: PrivateResultObject;
  let sqlStarted = memo?.state === "settled";
  try {
    if (memo?.state === "settled") {
      const reopened = await deps.resultStore.openPrivate(memo.resultRef as PrivateResultObject["resultRef"], context);
      if (!reopened || reopened.contentHash !== memo.contentHash) {
        const details = await deps.store.transact((tx) => {
          const current = tx.getTask(taskId);
          assertTaskAccess(current, context);
          return obstacle(tx, current, revisionId, "execution_outcome_unknown", "The settled execution no longer has its immutable ResultStore object; SQL was not retried", {
            requiresOuterDecision: true,
            retryable: false,
            sqlExecuted: true,
            executionOutcome: "unknown",
            queryHash,
          });
        }, context);
        throw new AnsweringError("RESULT_EXECUTION_OUTCOME_UNKNOWN", details.message, obstacleDetails(undefined, details));
      }
      privateResult = reopened;
    } else {
      await context.memo?.set("answering.result-execution", { state: "started", taskId: input.taskId, revisionId: input.revisionId, queryHash });
      sqlStarted = true;
      const executionKey = `result:${contentHash({ taskId, revisionId, queryHash })}`;
      const result = boundedResult(await deps.sqlExecutor.run(input.sql, limit, {
        kind: "result",
        idempotencyKey: executionKey,
        ...(context.signal ? { signal: context.signal } : {}),
        ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
      }));
      if (result.truncated) {
        const details = await deps.store.transact((tx) => {
          const current = tx.getTask(taskId);
          assertTaskAccess(current, context);
          if (attempt) settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "technical_failure" });
          return obstacle(tx, current, revisionId, "technical_failure", "A truncated result cannot become a Result Candidate", {
            requiresOuterDecision: false,
            retryable: true,
            sqlExecuted: true,
            executionOutcome: "succeeded",
            queryHash,
          });
        }, context);
        throw new AnsweringError("RESULT_INCOMPLETE", details.message, obstacleDetails(undefined, details));
      }
      privateResult = await deps.resultStore.createPrivate(result, context);
      await context.memo?.set("answering.result-execution", { state: "settled", taskId: input.taskId, revisionId: input.revisionId, queryHash, resultRef: privateResult.resultRef, contentHash: privateResult.contentHash });
    }
  } catch (error) {
    return throwExecutionFailure(deps.store, taskId, revisionId, attempt, error, sqlStarted, queryHash, context);
  }

  const checkReport = evaluateCandidateCheckReport({ fields: sealed.fields, result: privateResult, queryHash });
  const failure = candidateCheckFailure(checkReport.findings);
  if (failure) {
    await deps.resultStore.discard(privateResult.resultRef, context);
    const details = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      if (attempt) settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "technical_failure" });
      // The finding leads the message so the fix is on the first line, not after the attempt history.
      return obstacle(tx, current, revisionId, "technical_failure", `The result failed an online CandidateCheck: ${failure.message}`, {
        requiresOuterDecision: false,
        retryable: true,
        sqlExecuted: true,
        executionOutcome: "succeeded",
        queryHash,
        coverage: checkReport.coverage,
      });
    }, context);
    throw new AnsweringError("CANDIDATE_CHECK_FAILED", details.message, obstacleDetails({ findings: checkReport.findings, coverage: checkReport.coverage }, details));
  }

  if (deps.fieldProbes) {
    // ADR-0005: the delivered result must not be the output of an alternative the Revision did not adopt.
    const fingerprint = resultFingerprint(privateResult.columns, privateResult.rows);
    const probes = await deps.store.transact((tx) => tx.getTask(taskId)?.fieldProbes ?? [], context);
    const conflicts = realizationConflicts(sealed.fields, probes, fingerprint);
    if (conflicts.length > 0) {
      await deps.resultStore.discard(privateResult.resultRef, context);
      const explanation = conflicts.map((conflict) => `${conflict.path} adopted ${conflict.adoptedAlternativeId}, but the result equals the probe output of ${conflict.realizedAlternativeId}`).join("; ");
      const details = await deps.store.transact((tx) => {
        const current = tx.getTask(taskId);
        assertTaskAccess(current, context);
        if (attempt) settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "business_judgment_required" });
        return obstacle(tx, current, revisionId, "business_judgment_required", `${explanation}. Make the SQL implement the adopted alternative, or revise the decision with its rationale before querying again.`, {
          requiresOuterDecision: true,
          retryable: true,
          sqlExecuted: true,
          executionOutcome: "succeeded",
          queryHash,
        });
      }, context);
      throw new AnsweringError("DECISION_NOT_REALIZED", details.message, obstacleDetails({ conflicts }, details));
    }
  }

  const fanout = await evaluateFanout(deps, taskId, revisionId, queryHash, input.sql.trim(), context);
  // Entity identity and calendar coverage were read when the Revision committed; the sealed fields decide whether its findings still apply.
  const combinedCoverage: readonly CheckCoverage[] = [...checkReport.coverage, realization.coverage, fanoutCoverage(fanout), entityIdentityCoverage(sealed.entityIdentity), calendarCoverageCoverage(sealed.calendarCoverage)];
  const combinedFindings = [...checkReport.findings, ...realization.findings, ...fanoutFindings(fanout), ...entityIdentityFindings(sealed.entityIdentity), ...calendarCoverageFindings(sealed.calendarCoverage)];

  const budgetAfterResult = await deps.store.transact((tx) => {
    const current = tx.getTask(taskId);
    assertTaskAccess(current, context);
    const budget = taskBudget(current, deps.budgetPolicy);
    if (budget.observedRows + privateResult.rowCount > budget.policy.maxObservedRows) {
      const chargedTask = { ...current, budget: { ...budget, observedRows: budget.observedRows + privateResult.rowCount }, updatedAt: now() };
      tx.putTask(chargedTask);
      if (attempt) settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "budget_exhausted" });
      return obstacle(tx, chargedTask, revisionId, "budget_exhausted", "Observed-row budget exhausted after result execution", {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: true,
        executionOutcome: "succeeded",
        queryHash,
        coverage: combinedCoverage,
      });
    }
    tx.putTask({ ...current, budget: { ...budget, observedRows: budget.observedRows + privateResult.rowCount }, updatedAt: now() });
    if (attempt) settleAttempt(tx, attempt, { state: "succeeded", outcome: "succeeded", sqlExecuted: true });
    return undefined;
  }, context);
  if (budgetAfterResult) {
    await deps.resultStore.discard(privateResult.resultRef, context);
    throw new AnsweringError("IMPLEMENTATION_BUDGET_EXHAUSTED", budgetAfterResult.message, obstacleDetails(undefined, budgetAfterResult));
  }

  const baseCandidate: ResultCandidateRecord = {
    candidateId: makeInternalId("candidate") as unknown as ResultCandidateRecord["candidateId"],
    taskId,
    revisionId,
    resultRef: privateResult.resultRef,
    resultSchema: [...privateResult.columns],
    rowCount: privateResult.rowCount,
    contentHash: privateResult.contentHash,
    sql: input.sql.trim(),
    queryHash,
    findings: combinedFindings,
    coverage: combinedCoverage,
    fanout,
    ...(attempt ? { attemptId: attempt.attemptId } : {}),
    createdByInvocationId: context.invocationId,
    createdAt: now(),
    status: "ready",
    publishable: true,
  };
  const commit = await commitCandidate(deps, baseCandidate, taskId, revisionId, queryHash, context);
  if (commit.candidate.candidateId !== baseCandidate.candidateId) await deps.resultStore.discard(privateResult.resultRef, context);
  return resultView(deps, commit.candidate, context);
}
