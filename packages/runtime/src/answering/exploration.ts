import {
  contentHash,
  type BusinessContext,
  type FieldProbeRecord,
  type Evidence,
  type ExecuteQuery,
  type QueryExecutionView,
  type RevisionId,
  type TaskId,
} from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { obstacle, obstacleDetails, reserveAttempt, settleAttempt, taskBudget, throwExecutionFailure } from "./budget.js";
import { boundedResult } from "./sql-execution.js";
import { asRecord, now } from "./support.js";
import type { AnsweringDeps } from "./deps.js";
import { PROBE_ROW_LIMIT, probeContext } from "./probes.js";
import type { SpecPath } from "./fields.js";
import { resultFingerprint } from "./result-fingerprint.js";
import { ensureAdvice } from "./advice-execution.js";
import { adviceView } from "./advice.js";

type ExplorationInput = Extract<ExecuteQuery, { readonly kind: "exploration" }>;

/**
 * Bounded exploration. It never becomes a Result Candidate; a successful run
 * registers one Runtime-owned query_observation Evidence. Replays of the same
 * invocation return that Evidence; an unknown external outcome is not retried.
 */
export async function executeExploration(
  deps: AnsweringDeps,
  input: ExplorationInput,
  target: RevisionId,
  /** Delegated work binds to one Revision; an ordinary exploration explores whatever Revision is current. */
  pinned: boolean,
  limit: number,
  context: BusinessContext,
): Promise<QueryExecutionView> {
  let revisionId = target;
  const taskId = input.taskId as TaskId;
  const probe = input.probe ? { path: input.probe.path.trim() as SpecPath, alternativeId: input.probe.alternativeId.trim() } : undefined;
  if (probe && !deps.fieldProbes) throw new AnsweringError("INVALID_REQUEST", "Probes are not enabled for this Answering instance");
  const queryHash = contentHash({ sql: input.sql.trim(), limit, maxPreviewBytes: input.maxPreviewBytes, ...(probe ? { probe } : {}) });
  const prior = await deps.store.transact((tx) => tx.findObservationByInvocation(taskId, context.invocationId), context);
  if (prior?.kind === "query_observation") {
    if (prior.queryHash !== queryHash) throw new AnsweringError("INVALID_REQUEST", "EXPLORATION_INVOCATION_IDEMPOTENCY_CONFLICT");
    return { kind: "exploration", artifact: { kind: "exploration", evidenceId: prior.id, preview: prior.preview }, preview: prior.preview, findings: [] };
  }
  const memoValue = asRecord(await context.memo?.get("answering.exploration-execution"));
  if (memoValue && (memoValue.taskId !== input.taskId || memoValue.queryHash !== queryHash)) {
    throw new AnsweringError("INVALID_REQUEST", "EXPLORATION_INVOCATION_IDEMPOTENCY_CONFLICT");
  }
  if (memoValue?.state === "started") {
    const details = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      const attempt = tx.findAttemptByInvocation(taskId, context.invocationId, "exploration");
      if (attempt?.state === "started") settleAttempt(tx, attempt, { state: "unknown", outcome: "unknown", sqlExecuted: true, obstacleKind: "execution_outcome_unknown" });
      return obstacle(tx, current, revisionId, "execution_outcome_unknown", "The exploration execution outcome is unknown; SQL was not retried", {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: true,
        executionOutcome: "unknown",
        queryHash,
      });
    }, context);
    throw new AnsweringError("RESULT_EXECUTION_OUTCOME_UNKNOWN", details.message, obstacleDetails(undefined, details));
  }
  const reservation = await deps.store.transact((tx) => {
    const current = tx.getTask(taskId);
    assertTaskAccess(current, context);
    // A field write in the same model turn may land first; the exploration then runs against the new Revision.
    if (!pinned) revisionId = current.currentRevisionId;
    if (current.currentRevisionId !== revisionId) throw new AnsweringError("REVISION_STALE", "Exploration target Revision is stale", { currentRevisionId: current.currentRevisionId });
    if (probe) {
      const field = tx.getRevision(revisionId)?.fields[probe.path];
      if (!field || (field.state !== "open" && field.state !== "decided")) throw new AnsweringError("INVALID_REQUEST", `Probe path ${probe.path} has no alternatives in the current Revision; open it with {open: [...]} first`);
      if (!field.alternatives.some((alternative) => alternative.id === probe.alternativeId)) throw new AnsweringError("INVALID_REQUEST", `Probe alternative ${probe.alternativeId} is not an alternative of ${probe.path}`);
    }
    const unknownAttempt = tx.findAttemptByQuery(taskId, revisionId, queryHash, "exploration");
    if (unknownAttempt?.outcome === "unknown") {
      return { task: current, obstacle: obstacle(tx, current, revisionId, "execution_outcome_unknown", "A matching exploration has an unknown execution outcome; SQL was not retried", {
        requiresOuterDecision: true,
        retryable: false,
        sqlExecuted: true,
        executionOutcome: "unknown",
        queryHash,
      }) };
    }
    return reserveAttempt(tx, current, deps.budgetPolicy, "exploration", revisionId, context.invocationId, queryHash, probe ? "field_probe" : undefined);
  }, context);
  if (reservation.obstacle) {
    const code = reservation.obstacle.kind === "execution_outcome_unknown" ? "RESULT_EXECUTION_OUTCOME_UNKNOWN" : "IMPLEMENTATION_BUDGET_EXHAUSTED";
    throw new AnsweringError(code, reservation.obstacle.message, obstacleDetails(undefined, reservation.obstacle));
  }
  const attempt = reservation.attempt!;
  let sqlStarted = false;
  try {
    await context.memo?.set("answering.exploration-execution", { state: "started", taskId: input.taskId, queryHash });
    sqlStarted = true;
    // A probe reads the whole output (up to the exploration cap) so its fingerprint is complete; the model still sees a bounded preview.
    const raw = await deps.sqlExecutor.run(input.sql, probe ? Math.max(limit, PROBE_ROW_LIMIT) : limit, {
      kind: "exploration",
      idempotencyKey: context.invocationId,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
      ...(input.maxPreviewBytes ? { maxPreviewBytes: input.maxPreviewBytes } : {}),
      ...(context.queryScope ? { scope: context.queryScope } : {}),
    });
    const shown = probe && raw.rows.length > limit ? { ...raw, rows: raw.rows.slice(0, limit), truncated: true } : raw;
    const result = boundedResult(shown, input.maxPreviewBytes);
    const evidenceId = makeInternalId("evidence") as unknown as Evidence["id"];
    const observation: Evidence = { id: evidenceId, kind: "query_observation", authority: "observation", sourceRef: context.invocationId, preview: result, queryHash, contentHash: contentHash(result), observedAt: now() };
    const postExecution = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      const budget = taskBudget(current, deps.budgetPolicy);
      const observedRows = probe ? result.rows.length : raw.rows.length;
      if (budget.observedRows + observedRows > budget.policy.maxObservedRows) {
        const chargedTask = { ...current, budget: { ...budget, observedRows: budget.observedRows + observedRows }, updatedAt: now() };
        tx.putTask(chargedTask);
        settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "budget_exhausted" });
        return obstacle(tx, chargedTask, revisionId, "budget_exhausted", "Observed-row budget exhausted after exploration", {
          requiresOuterDecision: true,
          retryable: false,
          sqlExecuted: true,
          executionOutcome: "succeeded",
          queryHash,
        });
      }
      const probeRecord: FieldProbeRecord | undefined = probe ? {
        path: probe.path,
        alternativeId: probe.alternativeId as FieldProbeRecord["alternativeId"],
        revisionId,
        evidenceId,
        context: probeContext(tx.getRevision(revisionId)?.fields ?? {}, probe.path),
        rowCount: raw.rows.length,
        outcome: raw.truncated
          ? { state: "unavailable", reason: `output exceeds ${PROBE_ROW_LIMIT} rows` }
          : { state: "available", fingerprint: resultFingerprint(raw.columns, raw.rows) },
        probedAt: now(),
      } : undefined;
      const fieldProbes = probeRecord
        ? [...(current.fieldProbes ?? []).filter((item) => item.path !== probeRecord.path || item.alternativeId !== probeRecord.alternativeId), probeRecord]
        : current.fieldProbes;
      tx.putTask({ ...current, budget: { ...budget, observedRows: budget.observedRows + observedRows }, ...(fieldProbes ? { fieldProbes } : {}), updatedAt: now() });
      settleAttempt(tx, attempt, { state: "succeeded", outcome: "succeeded", sqlExecuted: true });
      tx.appendEvidence(taskId, observation);
      return undefined;
    }, context);
    if (postExecution) {
      throw new AnsweringError("IMPLEMENTATION_BUDGET_EXHAUSTED", postExecution.message, obstacleDetails(undefined, postExecution));
    }
    await context.memo?.set("answering.exploration-execution", { state: "settled", taskId: input.taskId, queryHash, evidenceId });
    const probeView = probe ? {
      path: probe.path,
      alternativeId: probe.alternativeId as FieldProbeRecord["alternativeId"],
      rowCount: raw.rows.length,
      ...(raw.truncated
        ? { state: "unavailable" as const, reason: `output exceeds ${PROBE_ROW_LIMIT} rows` }
        : { state: "available" as const, output: resultFingerprint(raw.columns, raw.rows).slice(0, 12) }),
    } : undefined;
    // The probe that completes an open field's outputs brings the advice with it, before the model decides (ADR-0005).
    const advice = probe ? (await ensureAdvice(deps, taskId, context, [probe.path])).find((item) => item.path === probe.path) : undefined;
    const probed = probeView ? { ...probeView, ...(advice ? { advice: adviceView(advice) } : {}) } : undefined;
    return { kind: "exploration", artifact: { kind: "exploration", evidenceId, preview: result }, preview: result, findings: [], attemptId: attempt.attemptId, ...(probed ? { probe: probed } : {}) };
  } catch (error) {
    return throwExecutionFailure(deps.store, taskId, revisionId, attempt, error, sqlStarted, queryHash, context);
  }
}
