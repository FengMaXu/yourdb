import { describe, expect, it } from "vitest";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import { InMemoryAnswering } from "./service.js";
import { isReadOnlySql, isScopedReadOnlySql, type BusinessContext, type InvocationMemo } from "./model.js";
import { maskSql } from "./sql-lex.js";
import { resultFingerprint } from "./result-fingerprint.js";

const context = (invocationId: string, overrides: Partial<BusinessContext> = {}): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId, ...overrides });

describe("T1.1 read-only preflight on lexically masked SQL", () => {
  it("accepts keywords inside literals and comments, and REPLACE() as a function", () => {
    expect(isReadOnlySql("SELECT REPLACE(a, 'x', 'y') FROM t WHERE s = 'delete' -- update")).toBe(true);
    expect(isReadOnlySql("SELECT \"update\", `drop` FROM t /* insert into t */ WHERE note = 'it''s; fine';")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x;  ")).toBe(true);
    expect(isScopedReadOnlySql("SELECT REPLACE(name, 'sleep', '') FROM t WHERE c = 'copy'")).toBe(true);
  });

  it("still refuses writes and a second statement", () => {
    expect(isReadOnlySql("REPLACE INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlySql("SELECT 1 FROM t; DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("; DROP TABLE t")).toBe(false);
    expect(isReadOnlySql("WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x")).toBe(false);
    expect(isReadOnlySql("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d")).toBe(false);
    // A backslash cannot hide a second statement under either string convention.
    expect(isReadOnlySql("SELECT 'a\\'; DROP TABLE t; --'")).toBe(false);
    expect(isScopedReadOnlySql("SELECT pg_sleep(10)")).toBe(false);
    expect(isScopedReadOnlySql("PRAGMA table_info(t)")).toBe(false);
  });

  it("masks without moving offsets", () => {
    const sql = "SELECT 'a' AS \"b\" -- c\nFROM t";
    const masked = maskSql(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.indexOf("FROM")).toBe(sql.indexOf("FROM"));
    expect(masked).not.toContain("'a'");
    expect(maskSql(sql, { identifiers: false })).toContain("\"b\"");
  });
});

describe("T1.3 resultFingerprint on the largest result", () => {
  it("fingerprints 100,000 rows without a RangeError, deterministically", () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => [index, `name-${index % 97}`, index / 7]);
    const first = resultFingerprint(["id", "name", "value"], rows);
    const second = resultFingerprint(["value", "id", "name"], [...rows].reverse().map((row) => [row[2], row[0], row[1]]));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

describe("T1.2 refresh keeps the publish disclosures and its own invariants", () => {
  const spec = {
    "population.entity": { name: "customer", keyColumns: ["customer_id"] },
    "population.eligibility": "n/a",
    "population.conditions": "n/a",
    // customer_nodes is declared but never read: a likely realization conflict.
    "population.source": { tables: ["customer_transactions", "customer_nodes"] },
    "population.time": { expression: "2020-01-01 through 2020-12-31", boundary: "inclusive" },
    "population.timeField": "customer_transactions.txn_date",
    "population.joinMultiplicity": "each transaction is one row; customer_nodes is not joined",
    "population.missing": "every month of 2020 appears; a month without data is zero",
    "measure.formula": { op: "count", of: "customer_id" },
    "measure.countGrain": { grain: "row", note: "one row per customer" },
    grouping: [{ key: "month", grain: "month" }],
    selection: "n/a",
    output: { rowMode: "grouped" },
  };
  const sql = "SELECT strftime('%m', txn_date) AS month, COUNT(customer_id) AS n FROM customer_transactions GROUP BY 1";

  async function published() {
    const resultStore = new InMemoryResultStore();
    const store = new InMemoryAnsweringStore();
    const executed: string[] = [];
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const options = {
      sqlExecutor: {
        run: async (text: string) => {
          if (text.startsWith("SELECT DISTINCT SUBSTR")) return { columns: ["p"], rows: [["2020-01"], ["2020-02"]], truncated: false };
          if (text.includes("SELECT DISTINCT customer_id")) return { columns: ["n"], rows: [[30]], truncated: false };
          if (text.startsWith("SELECT COUNT(*)")) return { columns: ["n"], rows: [[320]], truncated: false };
          executed.push(text);
          if (gate) await gate;
          return { columns: ["month", "n"], rows: [["01", 10], ["02", 12]], truncated: false };
        },
      },
    };
    const answering = new InMemoryAnswering({ ...options, store, resultStore });
    const begun = await answering.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql }, context("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, context("publish"));
    const hold = () => { gate = new Promise<void>((resolve) => { release = resolve; }); };
    return { answering, receipt, executed, resultStore, store, options, hold, release: () => release?.() };
  }

  it("keeps entity identity, calendar coverage and likely realization disclosures", async () => {
    const { answering, receipt } = await published();
    const kinds = (items: readonly { kind: string }[] | undefined) => new Set((items ?? []).map((item) => item.kind));
    expect([...kinds(receipt.disclosure?.items)]).toEqual(expect.arrayContaining(["entity_identity", "calendar_coverage", "realization_conflict"]));
    const refreshed = await answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh"));
    expect(kinds(refreshed.disclosure?.items)).toEqual(kinds(receipt.disclosure?.items));
    expect(refreshed.disclosure?.summary).toBe(receipt.disclosure?.summary);
    const checkIds = (coverage: readonly { checkId: string }[] | undefined) => (coverage ?? []).map((item) => item.checkId).sort();
    expect(checkIds(refreshed.coverage)).toEqual(checkIds(receipt.coverage));
    expect(refreshed.policyVersion).toBe(receipt.policyVersion);
  });

  it("runs concurrent equal refreshes once and leaves no unreferenced private result", async () => {
    const { answering, receipt, executed, resultStore, hold, release } = await published();
    const before = executed.length;
    hold();
    const first = answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh-a"));
    const second = answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh-b"));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.receiptId).toBe(b.receiptId);
    expect(executed.length - before).toBe(1);
    // Nothing beyond the two Receipts' objects remains to reclaim.
    expect(await resultStore.reconcile([receipt.resultRef, a.resultRef], context("reconcile"))).toEqual([]);
  });

  it("discards the losing private result when two hosts refresh the same request", async () => {
    const { answering, receipt, resultStore, hold, release, store, options } = await published();
    const other = new InMemoryAnswering({ ...options, store, resultStore });
    hold();
    const first = answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh-a"));
    const second = other.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh-b"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.receiptId).toBe(b.receiptId);
    expect(await resultStore.reconcile([receipt.resultRef, a.resultRef], context("reconcile"))).toEqual([]);
  });
});

describe("T1.4 a chart query deciding an inherited open field records a deviation", () => {
  it("records the deviation on the Revision and in the Receipt disclosure", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[42]], truncated: false }) },
      fieldProbes: true,
      populationDecisions: "allow_disclosed",
    });
    const parent = await answering.set({
      requestMessageId: "m",
      requestId: "report",
      report: true,
      fields: {
        "population.entity": "orders",
        "population.eligibility": "n/a",
        "population.conditions": { open: [["order_status <> 'cancelled'"], ["order_status = 'delivered'"]] },
        "population.time": { expression: "2018", boundary: "inclusive" },
      },
    }, context("report"));
    const child = await answering.set({
      requestMessageId: "m",
      requestId: "chart",
      parent: { taskId: parent.taskId },
      fields: { "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } },
    }, context("chart"));
    const alternatives = parent.fields.find((item) => item.path === "population.conditions")!.alternatives!;
    // Probed on the Report Task so it does not block the chart, and on the chart query under its own fields.
    for (const task of [parent.taskId, child.taskId]) {
      for (const alternative of alternatives) {
        await answering.execute({ kind: "exploration", taskId: task, sql: "SELECT 42", probe: { path: "population.conditions", alternativeId: alternative.id } }, context(`probe-${task}-${alternative.id}`));
      }
    }
    const decided = await answering.set({
      taskId: child.taskId,
      requestId: "decide",
      fields: { "population.conditions": { value: ["order_status = 'delivered'"], rationale: "The chart is about delivered orders; cancelled-but-not-delivered orders are excluded by the request", reason: "这张图只看已送达订单" } },
    }, context("decide"));
    expect(decided.outcomes?.find((item) => item.path === "population.conditions")?.message).toBeUndefined();
    expect(decided.deviations).toEqual([{ path: "population.conditions", reason: "这张图只看已送达订单" }]);
    const execution = await answering.execute({ kind: "result", taskId: child.taskId, revisionId: decided.revisionId, sql: "SELECT 42" }, context("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish" }, context("publish"));
    expect(receipt.disclosure?.deviations).toEqual([{ path: "population.conditions", reason: "这张图只看已送达订单" }]);
    expect(receipt.disclosure?.items).toContainEqual({ kind: "deviation", paths: ["population.conditions"], detail: "这张图只看已送达订单" });
  });
});

describe("T1.5 coalesced result executions keep each caller's signal and memo", () => {
  function memo(): InvocationMemo & { readonly values: Map<string, unknown> } {
    const values = new Map<string, unknown>();
    return { values, get: async (name) => values.get(name), set: async (name, value) => { values.set(name, value); } };
  }

  it("lets the second caller finish when the first aborts, and writes the second caller's memo", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    let sharedSignal: AbortSignal | undefined;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        run: async (_sql, _limit, options) => {
          runs += 1;
          sharedSignal = options.signal;
          await gate;
          if (options.signal?.aborted) throw new Error("QUERY_CANCELLED");
          return { columns: ["n"], rows: [[42]], truncated: false };
        },
      },
    });
    const begun = await answering.set({ requestMessageId: "m", requestId: "begin", fields: { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } } }, context("begin"));
    const input = { kind: "result" as const, taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" };
    const firstController = new AbortController();
    const firstMemo = memo();
    const secondMemo = memo();
    const first = answering.execute(input, context("result-1", { signal: firstController.signal, memo: firstMemo }));
    const second = answering.execute(input, context("result-2", { signal: new AbortController().signal, memo: secondMemo }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstController.abort(new Error("first caller cancelled"));
    await expect(first).rejects.toThrow("first caller cancelled");
    expect(sharedSignal?.aborted).toBe(false);
    release!();
    const view = await second;
    expect(view.artifact.kind).toBe("candidate");
    expect(runs).toBe(1);
    expect(secondMemo.values.get("answering.result-execution")).toMatchObject({ state: "settled", taskId: begun.taskId });
  });

  it("cancels the shared SQL only when every caller aborted", async () => {
    let sharedSignal: AbortSignal | undefined;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        run: async (_sql, _limit, options) => {
          sharedSignal = options.signal;
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
          throw new Error("QUERY_CANCELLED");
        },
      },
    });
    const begun = await answering.set({ requestMessageId: "m", requestId: "begin", fields: { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } } }, context("begin"));
    const input = { kind: "result" as const, taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" };
    const a = new AbortController();
    const b = new AbortController();
    const first = answering.execute(input, context("result-1", { signal: a.signal }));
    const second = answering.execute(input, context("result-2", { signal: b.signal }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    a.abort();
    await expect(first).rejects.toBeDefined();
    expect(sharedSignal?.aborted).toBe(false);
    b.abort();
    await expect(second).rejects.toThrow("QUERY_CANCELLED");
    expect(sharedSignal?.aborted).toBe(true);
  });
});
