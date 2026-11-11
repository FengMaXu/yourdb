import { randomUUID } from "node:crypto";
import {
  contentHash,
  type BusinessContext,
  type CheckCoverage,
  type FanoutReport,
  type Finding,
  type RevisionId,
  type TaskId,
} from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { reserveAttempt, settleAttempt, taskBudget } from "./budget.js";
import { checkFanout, hasPotentialFanout, type FanoutProbeRequest, type FanoutProbeResult, type FanoutSchema } from "./fanout-check.js";
import { SqlExecutionError, type AnsweringSqlExecutor } from "./sql-execution.js";
import { asRecord, now } from "./support.js";
import type { AnsweringDeps, FanoutAnsweringOptions } from "./deps.js";

/**
 * Bounded JOIN fanout diagnostics for one result query. Probes are charged to
 * the task exploration budget; the report is observational and never blocks
 * a Candidate by itself.
 */
interface FanoutExecutionMemo {
  readonly state: "started" | "settled";
  readonly taskId: string;
  readonly revisionId: string;
  readonly queryHash: string;
  readonly report?: FanoutReport;
}

function fanoutExecutionMemo(value: unknown): FanoutExecutionMemo | undefined {
  const record = asRecord(value);
  if (!record || (record.state !== "started" && record.state !== "settled") || typeof record.taskId !== "string" || typeof record.revisionId !== "string" || typeof record.queryHash !== "string") return undefined;
  const report = record.report as FanoutReport | undefined;
  if (record.state === "settled" && (!report || typeof report !== "object")) return undefined;
  return { state: record.state, taskId: record.taskId, revisionId: record.revisionId, queryHash: record.queryHash, ...(report ? { report } : {}) };
}

function unknownFanoutReport(reason: string): FanoutReport {
  return { ruleVersion: "answering-fanout-v1", status: "unknown", snapshotScope: "unbound", targets: [], unsupportedReasons: [reason] };
}

export function fanoutCoverage(report: FanoutReport): CheckCoverage {
  const reason = report.status === "finding"
    ? "A bounded probe observed a source key repeated after a JOIN. This is an observational metric-copy risk, not a business semantic verdict."
    : report.unsupportedReasons?.join(", ")
      ?? (report.status === "clear" ? "Supported JOIN aggregate targets were checked without observed source-key duplication." : undefined);
  return { checkId: "join_fanout", outcome: report.status === "not_applicable" ? "not_applicable" : report.status === "clear" ? "clear" : report.status === "finding" ? "finding" : "unknown", ...(reason ? { reason } : {}) };
}

export function fanoutFindings(report: FanoutReport): readonly Finding[] {
  return report.targets.filter((target) => target.status === "finding").map((target) => ({
    id: `finding_join_fanout_${randomUUID()}`,
    kind: "join_fanout" as const,
    blocking: false,
    checkId: "join_fanout",
    message: `JOIN fanout observed for ${target.aggregateFunctions.join("/")}(${target.aggregateExpressions.join(", ")}) from ${target.sourceRelation}.${target.sourceKey}; source distinct keys=${target.observation?.sourceDistinctKeys ?? "unknown"}, joined rows=${target.observation?.joinedRows ?? "unknown"}, joined distinct keys=${target.observation?.joinedDistinctKeys ?? "unknown"}. This is a bounded observation, not a business-semantic decision.`,
  }));
}

export function fanoutDisclosureSummary(report: FanoutReport): string {
  if (report.status === "finding") return "JOIN fanout 检查观察到来源键在连接后重复；这表示度量复制风险，不等于已裁决业务口径。";
  if (report.status === "unknown") return `JOIN fanout 检查未能完整完成：${report.unsupportedReasons?.join(", ") ?? "coverage unavailable"}。`;
  return "";
}

/** One lazily loaded schema per Answering instance; a failed load is not retried. */
export function createFanoutSchemaLoader(options: FanoutAnsweringOptions, executor: AnsweringSqlExecutor): (context: BusinessContext) => Promise<FanoutSchema | undefined> {
  let loaded = Boolean(options.schema);
  let schema = options.schema;
  return async (context) => {
    if (options.schema) return options.schema;
    if (loaded) return schema;
    loaded = true;
    if (!executor.getSchema) return undefined;
    try {
      schema = await executor.getSchema(context.signal);
      return schema;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return undefined;
    }
  };
}

async function runFanoutProbe(
  deps: AnsweringDeps,
  taskId: TaskId,
  revisionId: RevisionId,
  request: FanoutProbeRequest,
  context: BusinessContext,
): Promise<FanoutProbeResult> {
  const queryHash = contentHash({ taskId, revisionId, targetId: request.targetId, sql: request.sql });
  let reservation: ReturnType<typeof reserveAttempt>;
  try {
    reservation = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      if (current.currentRevisionId !== revisionId) throw new AnsweringError("REVISION_STALE", "Fanout probe target Revision is stale", { currentRevisionId: current.currentRevisionId });
      return reserveAttempt(tx, current, deps.budgetPolicy, "exploration", revisionId, context.invocationId, queryHash, "fanout_probe");
    }, context);
  } catch (error) {
    if (error instanceof AnsweringError) Object.assign(error, { fanoutFatal: true });
    throw error;
  }
  if (reservation.obstacle) throw new Error("probe_budget_exhausted");
  const attempt = reservation.attempt!;
  let sqlStarted = false;
  try {
    sqlStarted = true;
    const raw = await deps.sqlExecutor.run(request.sql, 1, {
      kind: "exploration",
      idempotencyKey: `fanout:${queryHash}`,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.deadlineAt ? { deadlineAt: request.deadlineAt } : {}),
      ...(context.queryScope ? { scope: context.queryScope } : {}),
    });
    const post = await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      const budget = taskBudget(current, deps.budgetPolicy);
      const observedRows = raw.rows.length;
      if (budget.observedRows + observedRows > budget.policy.maxObservedRows) {
        const charged = { ...current, budget: { ...budget, observedRows: budget.observedRows + observedRows }, updatedAt: now() };
        tx.putTask(charged);
        settleAttempt(tx, attempt, { state: "failed", outcome: "succeeded", sqlExecuted: true, obstacleKind: "budget_exhausted" });
        return true;
      }
      tx.putTask({ ...current, budget: { ...budget, observedRows: budget.observedRows + observedRows }, updatedAt: now() });
      settleAttempt(tx, attempt, { state: "succeeded", outcome: "succeeded", sqlExecuted: true });
      return false;
    }, context);
    if (post) throw new Error("probe_budget_exhausted");
    return { columns: raw.columns, rows: raw.rows, truncated: raw.truncated };
  } catch (error) {
    if (error instanceof AnsweringError) Object.assign(error, { fanoutFatal: true });
    if (context.signal?.aborted || request.signal?.aborted) throw error;
    const unknown = error instanceof SqlExecutionError && error.outcome === "unknown";
    await deps.store.transact((tx) => {
      const current = tx.getTask(taskId);
      assertTaskAccess(current, context);
      settleAttempt(tx, attempt, unknown
        ? { state: "unknown", outcome: "unknown", sqlExecuted: true, obstacleKind: "execution_outcome_unknown" }
        : { state: "failed", outcome: "failed", sqlExecuted: sqlStarted, obstacleKind: /budget/i.test(error instanceof Error ? error.message : String(error)) ? "budget_exhausted" : "technical_failure" });
    }, context).catch(() => undefined);
    throw error;
  }
}

export async function evaluateFanout(
  deps: AnsweringDeps,
  taskId: TaskId,
  revisionId: RevisionId,
  queryHash: string,
  sql: string,
  context: BusinessContext,
): Promise<FanoutReport> {
  const potential = hasPotentialFanout(sql);
  if (!potential) {
    return { ruleVersion: "answering-fanout-v1", status: "not_applicable", snapshotScope: "unbound", targets: [] };
  }
  if (deps.fanout.enabled === false) return unknownFanoutReport("check_disabled");
  const memo = fanoutExecutionMemo(await context.memo?.get("answering.fanout-check"));
  if (memo && (memo.taskId !== taskId || memo.revisionId !== revisionId || memo.queryHash !== queryHash)) {
    throw new AnsweringError("INVALID_REQUEST", "FANOUT_INVOCATION_IDEMPOTENCY_CONFLICT");
  }
  if (memo?.state === "settled" && memo.report) return memo.report;
  if (memo?.state === "started") return unknownFanoutReport("probe_outcome_unknown");
  await context.memo?.set("answering.fanout-check", { state: "started", taskId, revisionId, queryHash });
  const schema = await deps.loadFanoutSchema(context);
  const resolvedDialect = deps.fanout.dialect ?? deps.sqlExecutor.dialect ?? schema?.dialect;
  const report = await checkFanout({
    sql,
    ...(schema ? { schema } : {}),
    ...(resolvedDialect ? { dialect: resolvedDialect } : {}),
    runProbe: (request) => runFanoutProbe(deps, taskId, revisionId, request, context),
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
    ...(deps.fanout.maxTargets !== undefined ? { maxTargets: deps.fanout.maxTargets } : {}),
    ...(deps.fanout.maxInputRows !== undefined ? { maxInputRows: deps.fanout.maxInputRows } : {}),
  });
  await context.memo?.set("answering.fanout-check", { state: "settled", taskId, revisionId, queryHash, report });
  return report;
}
