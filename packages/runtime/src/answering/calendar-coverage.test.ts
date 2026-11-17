import { describe, expect, it } from "vitest";
import { calendarQuery, calendarTarget, dateRange, evaluateCalendarCoverage, periodsIn } from "./calendar-coverage.js";
import { InMemoryAnswering } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import type { SpecFields } from "./model.js";

const specified = (value: unknown) => ({ state: "specified", value, basis: { kind: "assumed" } }) as const;
const fieldsOf = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([path, value]) => [path, specified(value)])) as unknown as SpecFields;

describe("calendar coverage rules", () => {
  it("reads ISO dates and years, and refuses quarter wording", () => {
    expect(dateRange("2020-01-01 through 2020-12-31")).toEqual({ start: "2020-01-01", end: "2020-12-31" });
    expect(dateRange("calendar years 2019 and 2020")).toEqual({ start: "2019-01-01", end: "2020-12-31" });
    expect(dateRange("2020-02")).toEqual({ start: "2020-02-01", end: "2020-02-29" });
    expect(dateRange("Q4 2019 and Q4 2020")).toMatchObject({ reason: expect.stringContaining("quarters") });
    expect(dateRange("from 2020-02-01 back to 2020-01-31")).toMatchObject({ reason: expect.stringContaining("range") });
    expect(periodsIn("quarter", "2019-11-15", "2020-02-01")).toEqual(["2019-Q4", "2020-Q1"]);
  });

  it("targets the time field at the grouping grain", () => {
    const values = {
      "population.time": { expression: "2020-01-01 through 2020-12-31", boundary: "inclusive" },
      "population.timeField": "txn_date",
      "population.source": { tables: ["customer_transactions"] },
      grouping: [{ key: "month", grain: "calendar month" }],
    };
    const fields = fieldsOf(values);
    const { target } = calendarTarget(fields);
    expect(target).toEqual({ table: "customer_transactions", column: "txn_date", grain: "month", start: "2020-01-01", end: "2020-12-31" });
    expect(calendarQuery(target!, "mysql")).toBe("SELECT DISTINCT SUBSTR(CAST(txn_date AS CHAR), 1, 7) AS p FROM customer_transactions WHERE txn_date >= '2020-01-01' AND txn_date < '2021-01-01'");
    expect(calendarQuery(target!, "bigquery")).toBeUndefined();
    expect(calendarTarget(fieldsOf({ ...values, "population.timeField": "the date the order shipped" }))).toEqual({ limitation: expect.any(String) });
  });

  it("finds months without data (local064) and refuses non-ISO storage", () => {
    const target = { table: "customer_transactions", column: "txn_date", grain: "month" as const, start: "2020-01-01", end: "2020-12-31" };
    const report = evaluateCalendarCoverage(target, ["2020-01", "2020-02", "2020-03", "2020-04"]);
    expect(report).toMatchObject({ status: "finding", expected: 12, observed: 4 });
    expect(report.missing).toHaveLength(8);
    expect(evaluateCalendarCoverage(target, ["01-2020"]).status).toBe("unknown");
  });
});

describe("calendar coverage in Answering", () => {
  const business = (invocationId: string) => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
  const spec = {
    "population.entity": "customer",
    "population.eligibility": "n/a",
    "population.conditions": "n/a",
    "population.source": { tables: ["customer_transactions"] },
    "population.time": { expression: "2020-01-01 through 2020-12-31", boundary: "inclusive" },
    "population.timeField": "txn_date",
    "measure.formula": { op: "sum", of: "balance" },
    grouping: [{ key: "month", grain: "month" }],
    selection: "n/a",
    output: { rowMode: "grouped" },
  };

  it("makes population.missing required while months lack data, and discloses the gap", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        run: async (sql) => sql.startsWith("SELECT DISTINCT SUBSTR")
          ? { columns: ["p"], rows: [["2020-01"], ["2020-02"], ["2020-03"], ["2020-04"]], truncated: false }
          : { columns: ["n"], rows: [[1]], truncated: false },
      },
    });
    const view = await answering.set({ requestMessageId: "message", requestId: "begin", fields: spec }, business("begin"));
    expect(view.calendarCoverage).toMatchObject({ status: "finding", observed: 4 });
    expect(view.undeclared).toContain("population.missing");
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT 1" }, business("blocked")))
      .rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { undeclared: ["population.missing"] } });

    const declared = await answering.set({ taskId: view.taskId, requestId: "missing", fields: { "population.missing": "every month of 2020 appears; a month without data is zero" } }, business("missing"));
    expect(declared.undeclared).toEqual([]);
    const execution = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: declared.revisionId, sql: "SELECT 1" }, business("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, business("publish"));
    expect(receipt.disclosure?.summary).toContain("时间范围内有期间没有数据");
    const item = receipt.disclosure?.items.find((entry) => entry.kind === "calendar_coverage");
    expect(item).toMatchObject({ kind: "calendar_coverage", paths: ["population.time"] });
    expect(item?.periods?.length).toBe(8);
  });

  it("reads the coverage before sealing when the result query reaches the Revision first", async () => {
    const store = new InMemoryAnsweringStore();
    const answering = new InMemoryAnswering({
      store,
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        run: async (sql) => sql.startsWith("SELECT DISTINCT SUBSTR")
          ? { columns: ["p"], rows: [["2020-01"], ["2020-02"]], truncated: false }
          : { columns: ["n"], rows: [[1]], truncated: false },
      },
    });
    const view = await answering.set({ requestMessageId: "message", requestId: "begin", fields: spec }, business("begin"));
    // As if a parallel result query ran between the Revision commit and the set call's data checks.
    await store.transact((tx) => {
      const { entityIdentity: _identity, calendarCoverage: _calendar, ...revision } = tx.getRevision(view.revisionId as never)!;
      tx.putRevision(revision);
    }, business("strip"));

    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT 1" }, business("result")))
      .rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { undeclared: ["population.missing"] } });
  });
});
