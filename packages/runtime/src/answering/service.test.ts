import { describe, expect, it } from "vitest";
import {
  AnsweringError,
  DEFAULT_QUERY_BUDGET_POLICY,
  InMemoryAnswering,
  InMemoryAnsweringStore,
  InMemoryResultStore,
  type AnsweringStore,
  type BusinessContext,
  isScopedReadOnlySql,
  SqlExecutionError,
} from "./public.js";

const context = (invocationId = "invocation-1"): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId,
});

/** Loses the first transaction that commits a Result Candidate, as a Session commit failure would. */
class FailOnceAtCandidateCommit implements AnsweringStore {
  private failed = false;
  constructor(private delegate: InMemoryAnsweringStore) {}

  async transact<T>(command: Parameters<AnsweringStore["transact"]>[0], context: BusinessContext): Promise<T> {
    if (this.failed) return this.delegate.transact(command, context) as Promise<T>;
    const before = this.delegate.snapshot();
    const value = await this.delegate.transact(command, context) as T;
    if (this.delegate.snapshot().candidates.length === before.candidates.length) return value;
    this.delegate = new InMemoryAnsweringStore(before);
    this.failed = true;
    throw new Error("SESSION_COMMIT_FAILED");
  }

  inspect(taskId: Parameters<AnsweringStore["inspect"]>[0], context: BusinessContext) { return this.delegate.inspect(taskId, context); }
  list(context: BusinessContext) { return this.delegate.list(context); }
  listReferencedResultRefs(context: BusinessContext) { return this.delegate.listReferencedResultRefs(context); }
}

function answering(run: (sql: string, limit: number, options: { kind: "exploration" | "result"; idempotencyKey: string }) => Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>) {
  return new InMemoryAnswering({
    store: new InMemoryAnsweringStore(),
    resultStore: new InMemoryResultStore(),
    sqlExecutor: { run },
  });
}

const simpleSpec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };

describe("Answering vertical slice", () => {
  it("keeps the delegated SQL preflight conservative without treating it as a security boundary", () => {
    expect(isScopedReadOnlySql("SELECT * FROM orders")).toBe(true);
    expect(isScopedReadOnlySql("PRAGMA user_version")).toBe(false);
    expect(isScopedReadOnlySql("SELECT pg_read_file('secret')")).toBe(false);
    expect(isScopedReadOnlySql("WITH changed AS (DELETE FROM orders RETURNING id) SELECT * FROM changed")).toBe(false);
  });

  it("creates one task and revises it against its current Revision", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await service.set({ requestMessageId: "message-1", requestId: "begin-1", fields: simpleSpec }, context());
    expect(first.taskId).toEqual(expect.stringContaining("task_"));
    const revised = await service.set({ taskId: first.taskId, requestId: "revise-1", fields: { grouping: { value: ["region"], reason: "per region" } } }, context("revise"));
    expect(revised.revisionId).not.toBe(first.revisionId);
    expect(revised.parentRevisionId).toBe(first.revisionId);
    const replay = await service.set({ requestMessageId: "message-1", requestId: "begin-1", fields: simpleSpec }, context("replay"));
    expect(replay.taskId).toBe(first.taskId);
  });

  it("blocks a final query while a field is still open", async () => {
    let calls = 0;
    const service = answering(async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; });
    const first = await service.set({ requestMessageId: "message-1", requestId: "begin-2", fields: { ...simpleSpec, "measure.countGrain": { open: ["one row per order", "one row per order item"], reason: "orders repeat" } } }, context("begin-2"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-blocked"))).rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { open: ["measure.countGrain"] } });
    expect(calls).toBe(0);
  });

  it("executes final SQL once and publishes the same immutable candidate", async () => {
    let calls = 0;
    const executionKinds: string[] = [];
    const service = answering(async (_sql, _limit, options) => { calls += 1; executionKinds.push(options.kind); return { columns: ["value"], rows: [[1]], truncated: false }; });
    const first = await service.set({ requestMessageId: "message-1", requestId: "begin-4", fields: simpleSpec }, context("begin-4"));
    const execution = await service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-1"));
    expect(calls).toBe(1);
    expect(executionKinds).toEqual(["result"]);
    expect(execution.artifact.kind).toBe("candidate");
    if (execution.artifact.kind !== "candidate") throw new Error("expected candidate");
    const replayedByNewInvocation = await service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-new-invocation"));
    expect(replayedByNewInvocation.artifact).toEqual(execution.artifact);
    expect(calls).toBe(1);
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-result-attempt"))).resolves.toMatchObject({
      attempts: expect.arrayContaining([expect.objectContaining({ kind: "result", state: "succeeded", outcome: "succeeded", sqlExecuted: true })]),
      candidate: { status: "ready", publishable: true },
    });
    const receipt = await service.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish-1" }, context("publish-1"));
    const repeated = await service.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish-1" }, context("publish-retry"));
    expect(repeated).toEqual(receipt);
    expect(calls).toBe(1);
    expect(receipt.format).toBe("inline");
    expect(receipt.resultRef).toBe(execution.artifact.resultRef);
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-published"))).resolves.toMatchObject({
      task: { lifecycle: "published", publicationId: receipt.receiptId },
      publication: { receiptId: receipt.receiptId, candidateId: execution.artifact.candidateId },
    });
  });

  it("coalesces concurrent final retries with different invocation ids", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = answering(async () => {
      calls += 1;
      await blocked;
      return { columns: ["value"], rows: [[1]], truncated: false };
    });
    const first = await service.set({ requestMessageId: "message-concurrent", requestId: "begin-concurrent", fields: simpleSpec }, context("begin-concurrent"));
    const input = { kind: "result" as const, taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" };
    const left = service.execute(input, context("result-concurrent-left"));
    const right = service.execute(input, context("result-concurrent-right"));
    await Promise.resolve();
    release?.();
    const [leftResult, rightResult] = await Promise.all([left, right]);
    expect(rightResult.artifact).toEqual(leftResult.artifact);
    expect(calls).toBe(1);
  });

  it("does not rerun SQL after a Session commit failure when Pi memo has a settled result", async () => {
    const delegate = new InMemoryAnsweringStore();
    const store = new FailOnceAtCandidateCommit(delegate);
    const resultStore = new InMemoryResultStore();
    let calls = 0;
    const memoValues = new Map<string, unknown>();
    const memo = {
      get: async (name: string) => memoValues.get(name),
      set: async (name: string, value: unknown) => { memoValues.set(name, value); },
    };
    const firstService = new InMemoryAnswering({
      store,
      resultStore,
      sqlExecutor: { run: async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; } },
    });
    const first = await firstService.set({ requestMessageId: "message-crash", requestId: "begin-crash", fields: simpleSpec }, context("begin-crash"));
    const executionInput = { kind: "result" as const, taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" };
    await expect(firstService.execute(executionInput, { ...context("crash-invocation"), memo })).rejects.toThrow("SESSION_COMMIT_FAILED");
    expect(calls).toBe(1);
    const settledMemo = memoValues.get("answering.result-execution") as Record<string, unknown>;
    expect(settledMemo).toMatchObject({ state: "settled" });
    expect(settledMemo.resultRef).toMatch(/^result_/);
    expect(settledMemo).not.toHaveProperty("result");
    expect(JSON.stringify(settledMemo)).not.toContain("rows");

    const recovered = new InMemoryAnswering({
      store,
      resultStore,
      sqlExecutor: { run: async () => { calls += 1; throw new Error("SQL_MUST_NOT_RUN"); } },
    });
    const replay = await recovered.execute(executionInput, { ...context("crash-invocation"), operationId: "operation-after-restart", memo });
    expect(replay.artifact.kind).toBe("candidate");
    expect(calls).toBe(1);
  });

  it("records a detected CandidateCheck as a finding rather than unknown coverage", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [[1], [2]], truncated: false }));
    const first = await service.set({ requestMessageId: "message-shape", requestId: "begin-shape", fields: simpleSpec }, context("begin-shape"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1 union all select 2" }, context("result-shape"))).rejects.toMatchObject({
      code: "CANDIDATE_CHECK_FAILED",
      details: { coverage: expect.arrayContaining([expect.objectContaining({ checkId: "result_shape", outcome: "finding" })]) },
    });
  });

  it("leads the obstacle with the declared and actual columns when they differ", async () => {
    const service = answering(async () => ({ columns: ["industry", "cumulative_sales_yi"], rows: [["批发业", 1]], truncated: false }));
    const spec = { ...simpleSpec, output: { rowMode: "grouped", columns: ["行业", "累计销售额(亿元)"] } };
    const first = await service.set({ requestMessageId: "message-columns", requestId: "begin-columns", fields: spec }, context("begin-columns"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-columns"))).rejects.toMatchObject({
      code: "CANDIDATE_CHECK_FAILED",
      details: { obstacle: { message: 'The result failed an online CandidateCheck: Result columns do not match the declared output shape: declared ["行业","累计销售额(亿元)"], result ["industry","cumulative_sales_yi"]. Alias the SQL columns to the declared names in the same order, or revise output.columns if the declaration is wrong' } },
    });
  });

  it("checks a declared grouped row count and leaves an undeclared one alone", async () => {
    const rows = [["批发业", 1], ["零售业", 2]];
    const service = answering(async () => ({ columns: ["industry", "sales"], rows, truncated: false }));
    const declared = await service.set({ requestMessageId: "message-grouped", requestId: "begin-grouped", fields: { ...simpleSpec, output: { rowMode: "grouped", rowCount: 3 } } }, context("begin-grouped"));
    await expect(service.execute({ kind: "result", taskId: declared.taskId, revisionId: declared.revisionId, sql: "select 1" }, context("result-grouped"))).rejects.toMatchObject({
      code: "CANDIDATE_CHECK_FAILED",
      details: { obstacle: { message: expect.stringContaining("Expected 3 grouped rows but received 2") } },
    });
    const open = await service.set({ requestMessageId: "message-grouped-open", requestId: "begin-grouped-open", fields: { ...simpleSpec, output: { rowMode: "grouped" } } }, context("begin-grouped-open"));
    await expect(service.execute({ kind: "result", taskId: open.taskId, revisionId: open.revisionId, sql: "select 1" }, context("result-grouped-open"))).resolves.toMatchObject({ artifact: { kind: "candidate" } });
  });

  it("never promotes a truncated result into a Candidate", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [[1]], truncated: true }));
    const first = await service.set({ requestMessageId: "message-truncated", requestId: "begin-truncated", fields: simpleSpec }, context("begin-truncated"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-truncated"))).rejects.toMatchObject({ code: "RESULT_INCOMPLETE" });
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-truncated"))).resolves.not.toHaveProperty("candidate");
  });

  it("bounds an exploration preview by serialized bytes before evidence is persisted", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [["x".repeat(100_000)], ["small"]], truncated: false }));
    const first = await service.set({ requestMessageId: "message-preview-bytes", requestId: "begin-preview-bytes", fields: simpleSpec }, context("begin-preview-bytes"));
    const explored = await service.execute({ kind: "exploration", taskId: first.taskId, sql: "select value from orders", limit: 50, maxPreviewBytes: 16 * 1024 }, context("exploration-preview-bytes"));
    expect(Buffer.byteLength(JSON.stringify(explored.preview), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(explored.preview).toMatchObject({ rows: [], rowCount: 2, truncated: true });
  });

  it("does not rerun an exploration whose external outcome is unknown under a new invocation", async () => {
    let calls = 0;
    const service = answering(async () => {
      calls += 1;
      throw new SqlExecutionError("connection lost", "unknown");
    });
    const first = await service.set({ requestMessageId: "message-unknown-exploration", requestId: "begin-unknown-exploration", fields: simpleSpec }, context("begin-unknown-exploration"));
    const input = { kind: "exploration" as const, taskId: first.taskId, sql: "select 1", limit: 1 };
    await expect(service.execute(input, context("unknown-exploration-one"))).rejects.toMatchObject({ code: "RESULT_EXECUTION_OUTCOME_UNKNOWN" });
    await expect(service.execute(input, context("unknown-exploration-two"))).rejects.toMatchObject({ code: "RESULT_EXECUTION_OUTCOME_UNKNOWN", obstacle: { sqlExecuted: true, retryable: false } });
    expect(calls).toBe(1);
  });

  it("rejects exploration replay when the same invocation changes SQL or limit", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await service.set({ requestMessageId: "message-exploration", requestId: "begin-exploration", fields: simpleSpec }, context("begin-exploration"));
    await service.execute({ kind: "exploration", taskId: first.taskId, sql: "select 1", limit: 1 }, context("exploration-invocation"));
    await expect(service.execute({ kind: "exploration", taskId: first.taskId, sql: "select 2", limit: 1 }, context("exploration-invocation"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects exploration artifacts as publication candidates", async () => {
    const service = answering(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await service.set({ requestMessageId: "message-1", requestId: "begin-5", fields: { ...simpleSpec, output: null } }, context("begin-5"));
    const exploration = await service.execute({ kind: "exploration", taskId: first.taskId, sql: "select 1", limit: 1 }, context("explore-5"));
    expect(exploration.artifact.kind).toBe("exploration");
    await expect(service.publish({ candidateId: "evidence_not_candidate", format: "auto", requestId: "publish-5" }, context("publish-5"))).rejects.toBeInstanceOf(AnsweringError);
  });

  it("returns a structured obstacle for undeclared fields without executing SQL", async () => {
    let calls = 0;
    const service = answering(async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; });
    const { "population.time": _time, ...withoutTime } = simpleSpec;
    const first = await service.set({ requestMessageId: "message-unknown-field", requestId: "begin-unknown-field", fields: withoutTime }, context("begin-unknown-field"));
    expect(first.undeclared).toEqual(["population.time"]);
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("result-unknown-field"))).rejects.toMatchObject({
      code: "UNRESOLVED_ASSUMPTIONS",
      details: { undeclared: ["population.time"] },
      obstacle: { kind: "business_judgment_required", sqlExecuted: false, executionOutcome: "not_started", requiresOuterDecision: true },
    });
    expect(calls).toBe(0);
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-unknown-field"))).resolves.toMatchObject({ undeclared: ["population.time"], attempts: [{ kind: "result", state: "blocked", outcome: "not_started", sqlExecuted: false, obstacleKind: "business_judgment_required" }] });
  });

  it("keeps a technical SQL failure inside the inner loop and records the attempt", async () => {
    let calls = 0;
    const service = answering(async () => {
      calls += 1;
      throw new SqlExecutionError("dialect syntax error");
    });
    const first = await service.set({ requestMessageId: "message-technical-failure", requestId: "begin-technical-failure", fields: simpleSpec }, context("begin-technical-failure"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select bad" }, context("result-technical-failure"))).rejects.toMatchObject({
      code: "QUERY_EXECUTION_FAILED",
      obstacle: { kind: "technical_failure", retryable: true, requiresOuterDecision: false, sqlExecuted: true, executionOutcome: "failed" },
    });
    expect(calls).toBe(1);
    const inspected = await service.inspect({ taskId: first.taskId }, context("inspect-technical-failure"));
    expect(inspected.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ state: "failed", outcome: "failed", obstacleKind: "technical_failure", sqlExecuted: true })]));
    expect(inspected.currentRevision.fields["measure.formula"]).toMatchObject({ state: "specified" });
  });

  it("ends the operation instead of returning an obstacle when the database is unavailable", async () => {
    const unavailable = Object.assign(new Error("DATABASE_UNAVAILABLE: database process unavailable after 3 reconnects (Connection closed)"), { code: "DATABASE_UNAVAILABLE" });
    const service = answering(async () => { throw unavailable; });
    const first = await service.set({ requestMessageId: "message-db-down", requestId: "begin-db-down", fields: simpleSpec }, context("begin-db-down"));
    for (const request of [
      { kind: "exploration" as const, taskId: first.taskId, sql: "select 1" },
      { kind: "result" as const, taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" },
    ]) {
      const failure = await service.execute(request, context(`db-down-${request.kind}`)).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "DATABASE_UNAVAILABLE", message: expect.stringMatching(/^DATABASE_UNAVAILABLE: /) });
      expect((failure as { obstacle?: unknown }).obstacle).toBeUndefined();
    }
    const inspected = await service.inspect({ taskId: first.taskId }, context("inspect-db-down"));
    expect(inspected.attempts.filter((attempt) => attempt.state === "failed")).toHaveLength(2);
  });

  it("does not retry a result whose external execution outcome is unknown", async () => {
    let calls = 0;
    const memoValues = new Map<string, unknown>();
    const memo = {
      get: async (name: string) => memoValues.get(name),
      set: async (name: string, value: unknown) => { memoValues.set(name, value); },
    };
    const service = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => { calls += 1; throw new SqlExecutionError("connection lost", "unknown"); } },
    });
    const first = await service.set({ requestMessageId: "message-unknown-execution", requestId: "begin-unknown-execution", fields: simpleSpec }, context("begin-unknown-execution"));
    const input = { kind: "result" as const, taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" };
    await expect(service.execute(input, { ...context("unknown-invocation"), memo })).rejects.toMatchObject({ code: "RESULT_EXECUTION_OUTCOME_UNKNOWN", obstacle: { kind: "execution_outcome_unknown" } });
    await expect(service.execute(input, { ...context("unknown-invocation"), memo })).rejects.toMatchObject({ code: "RESULT_EXECUTION_OUTCOME_UNKNOWN", obstacle: { kind: "execution_outcome_unknown", sqlExecuted: true } });
    await expect(service.execute(input, context("unknown-new-invocation"))).rejects.toMatchObject({ code: "RESULT_EXECUTION_OUTCOME_UNKNOWN", obstacle: { kind: "execution_outcome_unknown", sqlExecuted: true } });
    expect(calls).toBe(1);
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-unknown-result"))).resolves.toMatchObject({
      attempts: expect.arrayContaining([expect.objectContaining({ kind: "result", state: "unknown", outcome: "unknown", sqlExecuted: true, obstacleKind: "execution_outcome_unknown" })]),
    });
  });

  it("charges exploration budget for observed rows removed from a byte-bounded preview", async () => {
    const service = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      budgetPolicy: { ...DEFAULT_QUERY_BUDGET_POLICY, maxObservedRows: 1 },
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [["x".repeat(100_000)], ["small"]], truncated: false }) },
    });
    const first = await service.set({ requestMessageId: "message-row-budget", requestId: "begin-row-budget", fields: simpleSpec }, context("begin-row-budget"));
    await expect(service.execute({ kind: "exploration", taskId: first.taskId, sql: "select value from orders", maxPreviewBytes: 16 * 1024 }, context("row-budget-exploration"))).rejects.toMatchObject({
      code: "IMPLEMENTATION_BUDGET_EXHAUSTED",
      obstacle: { kind: "budget_exhausted", sqlExecuted: true, executionOutcome: "succeeded" },
    });
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-row-budget"))).resolves.toMatchObject({ task: { budget: { observedRows: 2 } } });
  });

  it("does not reset the task budget when the outer loop revises the Spec", async () => {
    let calls = 0;
    const service = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      budgetPolicy: { ...DEFAULT_QUERY_BUDGET_POLICY, maxResultAttempts: 1, maxRevisions: 4 },
      sqlExecutor: { run: async () => { calls += 1; throw new SqlExecutionError("temporary SQL failure"); } },
    });
    const first = await service.set({ requestMessageId: "message-budget", requestId: "begin-budget", fields: simpleSpec }, context("begin-budget"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: first.revisionId, sql: "select 1" }, context("budget-result-1"))).rejects.toMatchObject({ code: "QUERY_EXECUTION_FAILED" });
    const revised = await service.set({ taskId: first.taskId, requestId: "revise-budget", fields: { grouping: { value: ["region"], reason: "per region" } } }, context("budget-revise"));
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: revised.revisionId, sql: "select 2" }, context("budget-result-2"))).rejects.toMatchObject({
      code: "IMPLEMENTATION_BUDGET_EXHAUSTED",
      obstacle: { kind: "budget_exhausted", sqlExecuted: false, executionOutcome: "not_started" },
    });
    expect(calls).toBe(1);
    await expect(service.inspect({ taskId: first.taskId }, context("inspect-budget"))).resolves.toMatchObject({ task: { budget: { resultAttempts: 1, revisionCount: 1 } } });
  });
});

describe("Answering revision ownership (ADR-0004)", () => {
  const requestText = "统计每年各销售员订单金额与年度配额";
  const evidenceSource = {
    readUserMessage: async (_sessionId: string, messageId: string) => messageId === "message-141" ? requestText : undefined,
  };
  const serviceWithSource = (run: () => Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>) => {
    let calls = 0;
    const store = new InMemoryAnsweringStore();
    const service = new InMemoryAnswering({
      store,
      resultStore: new InMemoryResultStore(),
      evidenceSource,
      sqlExecutor: { run: async () => { calls += 1; return run(); } },
    });
    const evidenceCount = (taskId: string) => store.transact((tx) => tx.listEvidence(taskId as never).length, context("evidence-count"));
    return { service, calls: () => calls, evidenceCount };
  };
  const salesSpec = {
    ...simpleSpec,
    "measure.formula": { op: "sum", of: "subtotal" },
    "measure.countGrain": "n/a",
    "measure.window": { open: ["SUM annual quota", "MAX annual quota"] },
    output: { rowMode: "grouped" },
  };
  const beginLocal141 = (service: InMemoryAnswering) => service.set({ requestMessageId: "message-141", requestId: "begin-141", fields: salesSpec }, context("begin-141"));

  it("keeps an omitted open field open so the final query stays blocked (local141 replay)", async () => {
    const { service, calls } = serviceWithSource(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await beginLocal141(service);
    expect(first.open).toEqual(["measure.window"]);
    await service.execute({ kind: "exploration", taskId: first.taskId, sql: "select max(quota) from q", limit: 5 }, context("explore-141"));
    const revised = await service.set({ taskId: first.taskId, requestId: "revise-141", fields: { grouping: { value: ["year", "salesperson"], reason: "per year and salesperson" } } }, context("revise-141"));
    expect(revised.open).toEqual(["measure.window"]);
    const before = first.fields.find((item) => item.path === "measure.window")!.alternatives!.map((item) => item.id);
    expect(revised.fields.find((item) => item.path === "measure.window")!.alternatives!.map((item) => item.id)).toEqual(before);
    await expect(service.execute({ kind: "result", taskId: first.taskId, revisionId: revised.revisionId, sql: "select 1" }, context("result-141"))).rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS" });
    expect(calls()).toBe(1);
  });

  it("does not charge budget or register evidence when every write is rejected", async () => {
    const { service, evidenceCount } = serviceWithSource(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await beginLocal141(service);
    const before = await service.inspect({ taskId: first.taskId }, context("inspect-before"));
    const evidenceBefore = await evidenceCount(first.taskId);
    const rejected = await service.set({
      taskId: first.taskId,
      requestId: "revise-bad",
      fields: { "measure.formula": { value: { op: "sum", of: "subtotal" }, basis: "request", quote: "年度配额" } },
    }, context("revise-bad"));
    expect(rejected.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("already set") });
    const after = await service.inspect({ taskId: first.taskId }, context("inspect-after"));
    expect(after.task.currentRevisionId).toBe(first.revisionId);
    expect(after.task.budget?.revisionCount).toBe(before.task.budget?.revisionCount);
    expect(await evidenceCount(first.taskId)).toBe(evidenceBefore);
  });

  it("publishes after a verified value and an unverified decision, and discloses what is unverified", async () => {
    const { service } = serviceWithSource(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const first = await beginLocal141(service);
    const revised = await service.set({
      taskId: first.taskId,
      requestId: "revise-good",
      fields: {
        "measure.formula": { value: { op: "sum", of: "subtotal" }, basis: "request", quote: "订单金额", reason: "the request names the order amount" },
        "measure.window": { value: "MAX annual quota", rationale: "A quota is stated once per year, so repeated rows are copies" },
      },
    }, context("revise-good"));
    expect(revised.open).toEqual([]);
    expect(revised.fields.find((item) => item.path === "measure.formula")).toMatchObject({ status: "request" });
    expect(revised.unverified).toEqual(expect.arrayContaining(["population.entity", "output", "measure.window"]));
    const execution = await service.execute({ kind: "result", taskId: first.taskId, revisionId: revised.revisionId, sql: "select 1" }, context("result-good"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected candidate");
    const receipt = await service.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-good" }, context("publish-good"));
    expect(receipt.disclosure?.unverifiedFields).toEqual(expect.arrayContaining([{ path: "measure.window", kind: "decided" }, { path: "population.entity", kind: "assumed" }]));
    expect(receipt.disclosure?.unverifiedFields).not.toContainEqual(expect.objectContaining({ path: "measure.formula" }));
    expect(receipt.disclosure?.summary).toContain("按字面选择");
  });

  it("rejects a request quote that is not in the original request", async () => {
    const { service } = serviceWithSource(async () => ({ columns: ["value"], rows: [[1]], truncated: false }));
    const view = await service.set({
      requestMessageId: "message-141",
      requestId: "begin-forged-quote",
      fields: { ...simpleSpec, "measure.formula": { value: { op: "max", of: "quota" }, basis: "request", quote: "按最大值计算配额" } },
    }, context("begin-forged-quote"));
    expect(view.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
    expect(view.undeclared).toContain("measure.formula");
  });
});
