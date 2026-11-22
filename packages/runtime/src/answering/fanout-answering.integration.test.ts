import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAnswering, SqlExecutionError, type AnsweringStore } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import type { BusinessContext } from "./model.js";
import type { FanoutSchema } from "./fanout-check.js";
import { createAnsweringAgentToolDefinitions } from "../tools/answering.js";

const context = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "fanout-session",
  lane: "main",
  operationId: "fanout-operation",
  invocationId,
});

const spec = {
  "population.entity": "customer",
  "population.eligibility": "n/a",
  "population.conditions": "n/a",
  "population.time": "n/a",
  "measure.formula": { op: "sum", of: "payment.amount" },
  grouping: "n/a",
  selection: "n/a",
  output: { rowMode: "scalar", rowCount: 1, columns: ["total_amount"] },
};

const schema: FanoutSchema = {
  dialect: "sqlite",
  connectionId: "fanout-test",
  tables: [
    { name: "customers", columns: ["customer_id"], primaryKey: ["customer_id"] },
    { name: "payment", columns: ["payment_id", "customer_id", "amount"], primaryKey: ["payment_id"] },
    { name: "rental", columns: ["rental_id", "customer_id"], primaryKey: ["rental_id"] },
  ],
};

const databases: DatabaseSync[] = [];

class RollbackFirstCandidateCommit implements AnsweringStore {
  private failed = false;
  constructor(private delegate: InMemoryAnsweringStore) {}

  async transact<T>(command: Parameters<AnsweringStore["transact"]>[0], context: BusinessContext): Promise<T> {
    let wroteCandidate = false;
    const before = this.delegate.snapshot();
    const result = await this.delegate.transact((tx) => command(new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "putCandidate") return (...args: Parameters<typeof target.putCandidate>) => { wroteCandidate = true; return target.putCandidate(...args); };
        return Reflect.get(target, property, receiver);
      },
    }) as typeof tx), context);
    if (wroteCandidate && !this.failed) {
      this.delegate = new InMemoryAnsweringStore(before);
      this.failed = true;
      throw new Error("SESSION_COMMIT_FAILED");
    }
    return result;
  }

  readTaskBundle(taskId: Parameters<AnsweringStore["readTaskBundle"]>[0], context: BusinessContext) { return this.delegate.readTaskBundle(taskId, context); }
  list(context: BusinessContext) { return this.delegate.list(context); }
  listReferencedResultRefs(context: BusinessContext) { return this.delegate.listReferencedResultRefs(context); }
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setupDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE customers (customer_id INTEGER PRIMARY KEY);
    CREATE TABLE payment (payment_id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL);
    CREATE TABLE rental (rental_id INTEGER PRIMARY KEY, customer_id INTEGER);
    INSERT INTO customers VALUES (1);
    INSERT INTO payment VALUES (10, 1, 10.0), (11, 1, 20.0);
    INSERT INTO rental VALUES (100, 1), (101, 1);
  `);
  return db;
}

function executor(db: DatabaseSync, calls: { kind: string }[]) {
  return {
    dialect: "sqlite" as const,
    run: async (sql: string, _limit: number, options: { kind: "exploration" | "result" }) => {
      calls.push({ kind: options.kind });
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = statement.all() as Record<string, unknown>[];
      return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
    },
  };
}

describe("Answering main-path fanout integration", () => {
  it("runs one bounded probe, keeps the finding non-blocking, and discloses it from the immutable Receipt", async () => {
    const db = setupDatabase();
    const calls: { kind: string }[] = [];
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: executor(db, calls),
      fanout: { schema },
    });
    const begun = await answering.set({ requestMessageId: "message-fanout", requestId: "begin-fanout", fields: spec }, context("begin-fanout"));
    const sql = `SELECT SUM(p.amount) AS total_amount
      FROM customers c
      JOIN payment p ON p.customer_id = c.customer_id
      JOIN rental r ON r.customer_id = c.customer_id`;
    const result = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, context("result-fanout"));
    expect(calls.map((call) => call.kind)).toEqual(["result", "exploration"]);
    expect(result.artifact.kind).toBe("candidate");
    expect(result.fanout).toMatchObject({ status: "finding", snapshotScope: "probe_statement" });
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "join_fanout", blocking: false })]));
    expect(result.coverage).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "join_fanout", outcome: "finding" })]));
    if (result.artifact.kind !== "candidate") throw new Error("candidate expected");

    const queryTool = createAnsweringAgentToolDefinitions(answering).map((definition) => definition.tool).find((tool) => tool.name === "query_database");
    if (!queryTool) throw new Error("query tool expected");
    const toolView = await queryTool.execute("tool-call", { kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql } as never, undefined, { sessionId: "fanout-session", principalId: "user-1" }, { operationId: "tool-operation", invocationId: "tool-invocation", getMemo: async () => undefined, setMemo: async () => undefined } as never, {} as never);
    expect((toolView.content[0] as { text: string }).text).toContain("[FANOUT_CHECK] status=finding");

    const receipt = await answering.publish({ candidateId: result.artifact.candidateId, format: "inline", requestId: "publish-fanout" }, context("publish-fanout"));
    expect(receipt.fanout).toMatchObject({ status: "finding" });
    expect(receipt.disclosure).toMatchObject({ required: true, fanoutStatus: "finding" });
    expect(calls.map((call) => call.kind)).toEqual(["result", "exploration"]);
  });

  it("turns a probe timeout into disclosed unknown coverage without rerunning the final SQL", async () => {
    const db = setupDatabase();
    let resultCalls = 0;
    let probeCalls = 0;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql, _limit, options) => {
          if (options.kind === "result") {
            resultCalls += 1;
            const statement = db.prepare(sql);
            const columns = statement.columns().map((column) => column.name);
            const rows = statement.all() as Record<string, unknown>[];
            return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
          }
          probeCalls += 1;
          throw new SqlExecutionError("probe timed out", "failed");
        },
      },
      fanout: { schema },
    });
    const begun = await answering.set({ requestMessageId: "message-timeout", requestId: "begin-timeout", fields: spec }, context("begin-timeout"));
    const sql = "SELECT SUM(p.amount) AS total_amount FROM customers c JOIN payment p ON p.customer_id = c.customer_id JOIN rental r ON r.customer_id = c.customer_id";
    const result = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, context("result-timeout"));
    expect(resultCalls).toBe(1);
    expect(probeCalls).toBe(1);
    expect(result.fanout).toMatchObject({ status: "unknown" });
    expect(result.fanout?.targets).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unknown", reason: "probe_timeout" })]));
    expect(result.coverage).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "join_fanout", outcome: "unknown" })]));
  });

  it("preserves partial coverage when the shared exploration budget is exhausted", async () => {
    const db = setupDatabase();
    const calls: string[] = [];
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      budgetPolicy: { version: "answering-dual-loop-v1", maxRevisions: 4, maxExplorationAttempts: 1, maxResultAttempts: 2, maxElapsedMs: 60_000, maxObservedRows: 100 },
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql, _limit, options) => {
          calls.push(options.kind);
          const statement = db.prepare(sql);
          const columns = statement.columns().map((column) => column.name);
          const rows = statement.all() as Record<string, unknown>[];
          return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
        },
      },
      fanout: { schema, maxTargets: 2 },
    });
    const multiSpec = { ...spec, output: { rowMode: "scalar", rowCount: 1, columns: ["customer_count", "payment_count"] } };
    const begun = await answering.set({ requestMessageId: "message-budget-fanout", requestId: "begin-budget-fanout", fields: multiSpec }, context("begin-budget-fanout"));
    const sql = "SELECT COUNT(c.customer_id) AS customer_count, COUNT(p.payment_id) AS payment_count FROM customers c JOIN payment p ON p.customer_id = c.customer_id JOIN rental r ON r.customer_id = c.customer_id";
    const result = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, context("result-budget-fanout"));
    expect(calls).toEqual(["result", "exploration"]);
    expect(result.fanout?.status).toBe("finding");
    expect(result.fanout?.targets).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unknown", reason: "probe_budget_exhausted" })]));
  });

  it("does not rerun settled final SQL or fanout probes after a candidate commit response is lost", async () => {
    const db = setupDatabase();
    const store = new RollbackFirstCandidateCommit(new InMemoryAnsweringStore());
    const resultStore = new InMemoryResultStore();
    const memoValues = new Map<string, unknown>();
    const memo = {
      get: async (name: string) => memoValues.get(name),
      set: async (name: string, value: unknown) => { memoValues.set(name, value); },
    };
    let calls = 0;
    const first = new InMemoryAnswering({
      store,
      resultStore,
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql, _limit, options) => {
          calls += 1;
          const statement = db.prepare(sql);
          const columns = statement.columns().map((column) => column.name);
          const rows = statement.all() as Record<string, unknown>[];
          return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
        },
      },
      fanout: { schema },
    });
    const begun = await first.set({ requestMessageId: "message-recovery-fanout", requestId: "begin-recovery-fanout", fields: spec }, context("begin-recovery-fanout"));
    const sql = "SELECT SUM(p.amount) AS total_amount FROM customers c JOIN payment p ON p.customer_id = c.customer_id JOIN rental r ON r.customer_id = c.customer_id";
    await expect(first.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, { ...context("result-recovery-fanout"), memo })).rejects.toThrow("SESSION_COMMIT_FAILED");
    expect(calls).toBe(2);
    expect(memoValues.get("answering.fanout-check")).toMatchObject({ state: "settled" });

    const recovered = new InMemoryAnswering({
      store,
      resultStore,
      sqlExecutor: { run: async () => { throw new Error("SQL_MUST_NOT_RUN"); } },
      fanout: { schema },
    });
    const replay = await recovered.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, { ...context("result-recovery-fanout"), operationId: "recovery-operation", memo });
    expect(replay.fanout).toMatchObject({ status: "finding" });
    expect(calls).toBe(2);
  });

  it("propagates cancellation from a fanout probe instead of sealing or publishing a Candidate", async () => {
    const db = setupDatabase();
    const controller = new AbortController();
    const calls: string[] = [];
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql, _limit, options) => {
          calls.push(options.kind);
          const statement = db.prepare(sql);
          const columns = statement.columns().map((column) => column.name);
          const rows = statement.all() as Record<string, unknown>[];
          if (options.kind === "exploration") {
            controller.abort();
            throw new Error("QUERY_CANCELLED");
          }
          return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
        },
      },
      fanout: { schema },
    });
    const begun = await answering.set({ requestMessageId: "message-cancel-fanout", requestId: "begin-cancel-fanout", fields: spec }, context("begin-cancel-fanout"));
    const sql = "SELECT SUM(p.amount) AS total_amount FROM customers c JOIN payment p ON p.customer_id = c.customer_id JOIN rental r ON r.customer_id = c.customer_id";
    await expect(answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, { ...context("result-cancel-fanout"), signal: controller.signal })).rejects.toThrow("QUERY_CANCELLED");
    expect(calls).toEqual(["result", "exploration"]);
    await expect(answering.inspect({ taskId: begun.taskId }, context("inspect-cancel-fanout"))).resolves.not.toHaveProperty("candidate");
  });

  it("propagates revision changes during a probe instead of sealing a stale Candidate", async () => {
    const db = setupDatabase();
    let probeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    let releaseProbe: (() => void) | undefined;
    const release = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql, _limit, options) => {
          const statement = db.prepare(sql);
          const columns = statement.columns().map((column) => column.name);
          const rows = statement.all() as Record<string, unknown>[];
          if (options.kind === "exploration") {
            probeStarted?.();
            await release;
          }
          return { columns, rows: rows.map((row) => columns.map((column) => row[column])), truncated: false };
        },
      },
      fanout: { schema },
    });
    const begun = await answering.set({ requestMessageId: "message-stale-fanout", requestId: "begin-stale-fanout", fields: spec }, context("begin-stale-fanout"));
    const sql = "SELECT SUM(p.amount) AS total_amount FROM customers c JOIN payment p ON p.customer_id = c.customer_id JOIN rental r ON r.customer_id = c.customer_id";
    const pending = answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, context("result-stale-fanout"));
    await started;
    const revised = await answering.set({ taskId: begun.taskId, requestId: "revise-stale-fanout", fields: { grouping: { value: ["customer"], reason: "per customer" } } }, context("revise-stale-fanout"));
    releaseProbe?.();
    await expect(pending).rejects.toMatchObject({ code: "REVISION_STALE" });
    expect(revised.revisionId).not.toBe(begun.revisionId);
  });
});
