import { describe, expect, it } from "vitest";
import { InMemoryAnswering } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import { ANSWERING_SNAPSHOT_VERSION, type AnsweringStoreSnapshot } from "./answering-store.js";
import { parseFieldValue, FieldValueError } from "./fields.js";
import { SchemaProfile, evaluatePhysicalCandidates } from "./schema-profile.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import type { BusinessContext, SpecFields } from "./model.js";
import type { FanoutSchema } from "./fanout-check.js";

const context = (invocationId = "invocation"): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const spec = {
  "population.entity": { name: "user", keyColumns: ["user_id"] },
  "population.eligibility": { zeroActivity: "exclude", nullKey: "n/a" },
  "population.conditions": "n/a",
  "population.source": { tables: ["mst_users"] },
  "population.time": "n/a",
  "measure.formula": { op: "count", of: "user_id" },
  "measure.countGrain": { grain: "entity", keyColumns: ["user_id"] },
  grouping: "n/a",
  selection: "n/a",
  output: { rowMode: "scalar", rowCount: 1 },
};

function counting(counts: Record<string, number> = {}): AnsweringSqlExecutor & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    run: async (sql) => {
      queries.push(sql);
      return { columns: ["n"], rows: [[counts[sql] ?? 320]], truncated: false };
    },
  };
}

describe("T5.3 Schema Profile", () => {
  it("reads each table's facts once per session, across tasks, and never for unrelated revisions", async () => {
    const executor = counting({ "SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id FROM mst_users) AS d": 30 });
    const answering = new InMemoryAnswering({ store: new InMemoryAnsweringStore(), resultStore: new InMemoryResultStore(), sqlExecutor: executor });
    const first = await answering.set({ requestMessageId: "m1", requestId: "task-1", fields: spec }, context("task-1"));
    expect(first.entityIdentity).toMatchObject({ status: "finding" });
    const afterFirst = executor.queries.length;
    expect(afterFirst).toBe(3);
    // A second Query Task on the same table reads nothing again.
    const second = await answering.set({ requestMessageId: "m2", requestId: "task-2", fields: spec }, context("task-2"));
    expect(second.entityIdentity).toMatchObject({ status: "finding" });
    expect(executor.queries.length).toBe(afterFirst);
    // Changing a field the checks do not read reads nothing either.
    await answering.set({ taskId: second.taskId, requestId: "revise", fields: { output: { value: { rowMode: "scalar", rowCount: 1, columns: ["users"] }, reason: "name the column" } } }, context("revise"));
    expect(executor.queries.length).toBe(afterFirst);
  });

  it("does not charge a task's budget for its reads", async () => {
    const answering = new InMemoryAnswering({ store: new InMemoryAnsweringStore(), resultStore: new InMemoryResultStore(), sqlExecutor: counting() });
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.task.budget?.observedRows ?? 0).toBe(0);
    expect(inspected.attempts.filter((attempt) => attempt.kind === "exploration")).toEqual([]);
  });

  it("profiles a table once, and only its row count above the threshold", async () => {
    const schema: FanoutSchema = { dialect: "sqlite", tables: [{ name: "events", columns: ["id", "created_at", "status", "amount"], columnTypes: { id: "INTEGER", created_at: "TEXT", status: "TEXT", amount: "REAL" }, primaryKey: ["id"] }] };
    const queries: string[] = [];
    let rows = 1_000;
    const executor: AnsweringSqlExecutor = {
      dialect: "sqlite",
      getSchema: async () => schema,
      run: async (sql) => {
        queries.push(sql);
        if (sql.startsWith("SELECT COUNT(*) AS n FROM events")) return { columns: ["n"], rows: [[rows]], truncated: false };
        if (sql.startsWith("SELECT MIN")) return { columns: ["lo", "hi"], rows: [["2018-01-01 10:00:00", "2018-12-31 23:00:00"]], truncated: false };
        if (sql.startsWith("SELECT DISTINCT status")) return { columns: ["status"], rows: [["open"], ["closed"]], truncated: false };
        if (sql.startsWith("SELECT DISTINCT created_at")) return { columns: ["c"], rows: Array.from({ length: 21 }, (_, index) => [`d${index}`]), truncated: false };
        return { columns: ["n"], rows: [[rows]], truncated: false };
      },
    };
    const profile = new SchemaProfile(executor, async () => schema);
    const table = await profile.profile("events", context());
    expect(table).toMatchObject({ rows: 1_000, keys: [{ columns: ["id"], distinct: 1_000 }], timeColumns: [{ column: "created_at", format: "iso_timestamp", min: "2018-01-01 10:00:00" }], enumColumns: [{ column: "status", values: ["open", "closed"] }] });
    const reads = queries.length;
    await profile.profile("events", context());
    expect(queries.length).toBe(reads);

    rows = 5_000_000;
    queries.length = 0;
    const large = await new SchemaProfile(executor, async () => schema).profile("events", context());
    expect(large).toMatchObject({ rows: 5_000_000, keys: [], timeColumns: [], limitations: ["more than 200000 rows; only the row count is read"] });
    expect(queries).toEqual(["SELECT COUNT(*) AS n FROM events"]);
  });

  it("reminds of several candidate columns behind an assumed field, from the schema alone", async () => {
    const schema: FanoutSchema = { dialect: "sqlite", tables: [{ name: "orders", columns: ["id", "purchase_date", "delivered_date", "price", "freight_value"], columnTypes: { purchase_date: "TEXT", delivered_date: "TEXT", price: "REAL", freight_value: "REAL" } }] };
    const executor: AnsweringSqlExecutor = { run: async () => { throw new Error("no SQL"); } };
    const profile = new SchemaProfile(executor, async () => schema);
    const assumed = (path: string, value: unknown) => ({ state: "specified", value: parseFieldValue(path as never, value), basis: { kind: "assumed" } });
    const fields = {
      "population.source": assumed("population.source", { tables: ["orders"] }),
      "population.timeField": assumed("population.timeField", "orders.purchase_date"),
      "measure.formula": assumed("measure.formula", { op: "sum", of: "price" }),
    } as unknown as SpecFields;
    const report = await evaluatePhysicalCandidates(fields, profile, context());
    expect(report.status).toBe("finding");
    expect(report.findings.map((item) => [item.path, item.columns])).toEqual([["population.timeField", ["purchase_date", "delivered_date"]], ["measure.formula", ["price", "freight_value"]]]);
    // Opened or evidenced choices are not reminded of.
    const opened = { ...fields, "population.timeField": { state: "open", alternatives: [] }, "measure.formula": { ...fields["measure.formula"], basis: { kind: "evidence", evidenceIds: ["e"] } } } as unknown as SpecFields;
    expect((await evaluatePhysicalCandidates(opened, profile, context())).status).toBe("not_applicable");
  });
});

describe("T5.4 structured countGrain and eligibility", () => {
  it("refuses the free-text forms and names the exact structure", () => {
    expect(() => parseFieldValue("measure.countGrain", "one row per order")).toThrow(FieldValueError);
    expect(() => parseFieldValue("measure.countGrain", "one row per order")).toThrow(/"grain": "row" \| "entity" \| "event"/);
    expect(() => parseFieldValue("population.eligibility", "customers without orders are excluded")).toThrow(/"zeroActivity": "include" \| "exclude" \| "n\/a"/);
    expect(() => parseFieldValue("measure.countGrain", { grain: "orders" })).toThrow(/grain must be/);
    expect(() => parseFieldValue("population.eligibility", { zeroActivity: "exclude" })).toThrow(/nullKey must be/);
    expect(() => parseFieldValue("measures.late" as never, { formula: { op: "count", of: "x" }, countGrain: "per order" })).toThrow(/measures\.late\.countGrain is structured/);
  });

  it("accepts the structured forms", () => {
    expect(parseFieldValue("measure.countGrain", { grain: "entity", keyColumns: ["orders.order_id"], note: "one order" })).toEqual({ grain: "entity", keyColumns: ["orders.order_id"], note: "one order" });
    expect(parseFieldValue("population.eligibility", { zeroActivity: "include", nullKey: "exclude" })).toEqual({ zeroActivity: "include", nullKey: "exclude" });
  });

  it("rejects a free-text write through set with the structure, and the field stays undeclared", async () => {
    const answering = new InMemoryAnswering({ store: new InMemoryAnsweringStore(), resultStore: new InMemoryResultStore(), sqlExecutor: counting() });
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: { ...spec, "population.source": "n/a", "measure.countGrain": "one row per user" } }, context("begin"));
    expect(view.outcomes?.find((item) => item.path === "measure.countGrain")).toMatchObject({ status: "rejected", message: expect.stringContaining("measure.countGrain is structured") });
    expect(view.undeclared).toContain("measure.countGrain");
  });

  it("bumps the snapshot version and never reads an older snapshot", () => {
    expect(ANSWERING_SNAPSHOT_VERSION).toBe(3);
    const old = { version: 2, tasks: [], revisions: [], evidence: [], candidates: [], receipts: [] } as unknown as AnsweringStoreSnapshot;
    expect(() => new InMemoryAnsweringStore(old)).toThrow("ANSWERING_SNAPSHOT_VERSION_UNSUPPORTED");
  });
});
