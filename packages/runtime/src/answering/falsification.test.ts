import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { diffProbeSamples, sampleProbeOutput, witnessText, PROBE_SAMPLE_MAX_ROWS, WITNESS_CELL_CHARS } from "./probe-diff.js";
import { evaluateResultDomain } from "./result-domain.js";
import { evaluateDataFalsification, dataFalsificationCoverage } from "./data-falsification.js";
import { evaluateCandidateCheckReport } from "./candidate-checks.js";
import { InMemoryAnswering } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import type { BusinessContext, SpecFields } from "./model.js";
import type { CompareHypothesesInput, HypothesisChoiceAssessment } from "../judgment/hypothesis-choice.js";

const context = (invocationId = "invocation"): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const specified = (value: unknown) => ({ state: "specified", value, basis: { kind: "assumed" } }) as const;
const fieldsOf = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([path, value]) => [path, specified(value)])) as unknown as SpecFields;

describe("T4.1 probe witness rows", () => {
  const a = { alternativeId: "a", sample: sampleProbeOutput(["region", "n"], [["east", 10], ["west", 5], ["north", 2]]) };

  it("has no witnesses for equal outputs, whatever the row and column order", () => {
    const shuffled = { alternativeId: "b", sample: sampleProbeOutput(["n", "region"], [[2, "north"], [10, "east"], [5, "west"]]) };
    expect(diffProbeSamples(a, shuffled)).toEqual([]);
    const reordered = { alternativeId: "b", sample: sampleProbeOutput(["region", "n"], [["west", 5.0], ["north", "2"], ["east", 10]]) };
    expect(diffProbeSamples(a, reordered)).toEqual([]);
  });

  it("reports a key with a different value before rows only one side returns", () => {
    const b = { alternativeId: "b", sample: sampleProbeOutput(["region", "n"], [["east", 12], ["west", 5], ["south", 1]]) };
    const witnesses = diffProbeSamples(a, b);
    expect(witnesses[0]).toMatchObject({ kind: "changed", alternativeId: "a", row: ["east", "10.00"], otherRow: ["east", "12.00"] });
    expect(witnesses.slice(1)).toEqual([
      expect.objectContaining({ kind: "only_in", alternativeId: "a", row: ["north", "2.00"] }),
      expect.objectContaining({ kind: "only_in", alternativeId: "b", row: ["south", "1.00"] }),
    ]);
    expect(witnessText(witnesses[0]!, (id) => `alternative ${id}`)).toBe("same key, different values: alternative a (region=east, n=10.00) vs alternative b (region=east, n=12.00)");
  });

  it("reports added and missing rows, and a shape difference", () => {
    const missing = { alternativeId: "b", sample: sampleProbeOutput(["region", "n"], [["east", 10], ["west", 5]]) };
    expect(diffProbeSamples(a, missing)).toEqual([expect.objectContaining({ kind: "only_in", alternativeId: "a", row: ["north", "2.00"] })]);
    const scalar = { alternativeId: "b", sample: sampleProbeOutput(["total"], [[17]]) };
    expect(diffProbeSamples(a, scalar)).toEqual([expect.objectContaining({ kind: "shape", row: ["region", "n"], otherRow: ["total"] })]);
  });

  it("reports a numeric difference in a single-column output", () => {
    const one = { alternativeId: "a", sample: sampleProbeOutput(["n"], [[265]]) };
    const two = { alternativeId: "b", sample: sampleProbeOutput(["n"], [[205]]) };
    expect(diffProbeSamples(one, two).map((item) => [item.kind, item.alternativeId, item.row])).toEqual([["only_in", "a", ["265.00"]], ["only_in", "b", ["205.00"]]]);
  });

  it("bounds a large output's sample and cell length, and marks witnesses from it partial", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => [`k${String(index).padStart(5, "0")}`, "x".repeat(500)]);
    const sample = sampleProbeOutput(["key", "text"], rows);
    expect(sample.rows.length).toBeLessThanOrEqual(PROBE_SAMPLE_MAX_ROWS);
    expect(sample.complete).toBe(false);
    expect(sample.totalRows).toBe(5_000);
    expect(sample.rows[0]![1]!.length).toBe(WITNESS_CELL_CHARS);
    expect(JSON.stringify(sample).length).toBeLessThanOrEqual(16_384 + 200);
    const other = { alternativeId: "b", sample: sampleProbeOutput(["key", "text"], [["zzz", "y"]]) };
    const witnesses = diffProbeSamples({ alternativeId: "a", sample }, other);
    expect(witnesses.length).toBeLessThanOrEqual(3);
    expect(witnesses.every((item) => item.kind !== "only_in" || item.partial)).toBe(true);
  });

  it("gives the comparison advisor the witness rows, not only row counts", async () => {
    const outputs: Record<string, { columns: string[]; rows: unknown[][]; truncated: boolean }> = {
      "SELECT purchase": { columns: ["month", "n"], rows: [["2018-01", 120], ["2018-02", 145]], truncated: false },
      "SELECT delivered": { columns: ["month", "n"], rows: [["2018-01", 98], ["2018-02", 145], ["2018-03", 7]], truncated: false },
    };
    const advisor = vi.fn(async (input: CompareHypothesesInput): Promise<HypothesisChoiceAssessment> => ({
      model: "jev-test",
      recommendation: { kind: "insufficient_evidence" },
      probabilities: input.hypotheses.map((item) => ({ hypothesisId: item.id, probability: 0.5 })),
      abstentionProbabilities: { insufficientEvidence: 0, multiplePlausible: 0, noneSupported: 0 },
      confidence: 0.5,
    }));
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async (sql) => outputs[sql]! },
      fieldProbes: true,
      fieldAdvice: { advisor: { compare: advisor }, getOriginalQuestion: async () => "每月已送达订单数" },
    });
    const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: ["month"], selection: "n/a", output: { rowMode: "grouped" }, "population.timeField": { open: ["按下单时间", "按送达时间"] } };
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    const [purchase, delivered] = view.fields.find((item) => item.path === "population.timeField")!.alternatives!.map((item) => item.id as string);
    await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase", probe: { path: "population.timeField", alternativeId: purchase! } }, context("p1"));
    const last = await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT delivered", probe: { path: "population.timeField", alternativeId: delivered! } }, context("p2"));
    const evidence = advisor.mock.calls[0]![0].evidence.find((item) => item.id === "probe_outputs")!;
    expect(evidence.content).toContain("difference: same key, different values: alternative 1 (month=2018-01, n=120.00) vs alternative 2 (month=2018-01, n=98.00)");
    expect(evidence.content).toContain("difference: only alternative 2 returns (month=2018-03, n=7.00)");
    expect(last.probe?.witnesses?.length).toBe(2);
  });
});

describe("T4.2 result_domain", () => {
  const result = (columns: string[], rows: unknown[][]) => ({ columns, rows });

  it("is not_applicable without a settled measure or without rows", () => {
    expect(evaluateResultDomain(fieldsOf({}), result(["n"], [[1]]))).toMatchObject({ kind: "not_applicable" });
    expect(evaluateResultDomain(fieldsOf({ "measure.formula": { op: "count", of: "x" } }), result(["n"], []))).toMatchObject({ kind: "not_applicable" });
  });

  it("finds negative and fractional counts, fractions for percentages, percentages for ratios and an all-NULL measure", () => {
    const count = fieldsOf({ "measure.formula": { op: "count", of: "orders" } });
    expect(evaluateResultDomain(count, result(["region", "n"], [["east", -1]]))).toMatchObject({ kind: "finding", rule: "count_negative", column: "n" });
    expect(evaluateResultDomain(count, result(["region", "n"], [["east", "2.5"]]))).toMatchObject({ kind: "finding", rule: "count_fractional" });
    expect(evaluateResultDomain(count, result(["year", "n"], [[2018, 4], [2019, 7]]))).toEqual({ kind: "clear" });
    const percentage = fieldsOf({ "measure.formula": { op: "percentage", numerator: "a", denominator: "b" } });
    expect(evaluateResultDomain(percentage, result(["share"], [[0.42]]))).toMatchObject({ kind: "finding", rule: "percentage_as_fraction" });
    expect(evaluateResultDomain(percentage, result(["share"], [[42.1]]))).toEqual({ kind: "clear" });
    const ratio = fieldsOf({ "measure.formula": { op: "ratio", numerator: "a", denominator: "b" } });
    expect(evaluateResultDomain(ratio, result(["r"], [[42.5], [12.25]]))).toMatchObject({ kind: "finding", rule: "ratio_as_percentage" });
    expect(evaluateResultDomain(ratio, result(["r"], [[0.42]]))).toEqual({ kind: "clear" });
    expect(evaluateResultDomain(count, result(["region", "n"], [["east", null], ["west", null]]))).toMatchObject({ kind: "finding", rule: "measure_all_null", column: "n" });
  });

  it("is unknown when no column holds only numbers", () => {
    expect(evaluateResultDomain(fieldsOf({ "measure.formula": { op: "count", of: "x" } }), result(["a"], [["text"]]))).toMatchObject({ kind: "unknown" });
  });

  it("enters the candidate checks as a non-blocking finding with its rule version and all four coverage states", () => {
    const base = { resultRef: "result_1", columnTypes: ["number"], truncated: false, contentHash: "h" } as const;
    const report = (fields: SpecFields, rows: unknown[][]) => evaluateCandidateCheckReport({ fields, queryHash: "q", result: { ...base, columns: ["n"], rows, rowCount: rows.length } as never });
    const outcome = (fields: SpecFields, rows: unknown[][]) => report(fields, rows).coverage.find((item) => item.checkId === "result_domain");
    const count = fieldsOf({ "measure.formula": { op: "count", of: "orders" } });
    expect(outcome(count, [[-3]])).toMatchObject({ outcome: "finding", ruleVersion: "result-domain-v1" });
    expect(report(count, [[-3]]).findings).toEqual([expect.objectContaining({ kind: "result_domain", blocking: false })]);
    expect(outcome(count, [[3]])).toMatchObject({ outcome: "clear" });
    expect(outcome(fieldsOf({}), [[3]])).toMatchObject({ outcome: "not_applicable" });
    expect(outcome(count, [["text"]])).toMatchObject({ outcome: "unknown" });
  });
});

function sqlite(setup: string): AnsweringSqlExecutor & { readonly queries: string[] } {
  const db = new DatabaseSync(":memory:");
  db.exec(setup);
  const queries: string[] = [];
  return {
    dialect: "sqlite",
    queries,
    run: async (sql) => {
      queries.push(sql);
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      return { columns, rows: (statement.all() as Record<string, unknown>[]).map((row) => columns.map((column) => row[column])), truncated: false };
    },
  };
}

describe("T4.3 data falsification", () => {
  const db = () => sqlite([
    "CREATE TABLE customers (id INTEGER, name TEXT, status TEXT);",
    "CREATE TABLE orders (id INTEGER, customer_id INTEGER, created_at TEXT, amount INTEGER);",
    "INSERT INTO customers VALUES (1, 'a', 'Active'), (2, 'b', 'inactive');",
    "INSERT INTO orders VALUES (1, 1, '2018-12-30 10:00:00', 5), (2, 1, '2018-12-31 09:30:00', 7), (3, 2, '2018-12-31 00:00:00', 2);",
  ].join("\n"));

  it("finds a LEFT JOIN turned into an INNER JOIN by a WHERE predicate, without SQL", async () => {
    const executor = db();
    const report = await evaluateDataFalsification(executor, "SELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.amount > 3 GROUP BY c.name", { rows: [["a", 2]] }, context());
    expect(report.status).toBe("finding");
    expect(report.findings).toEqual([expect.objectContaining({ rule: "left_join_degenerated", message: expect.stringContaining("o.amount") })]);
    expect(executor.queries).toEqual([]);
    const kept = await evaluateDataFalsification(executor, "SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.amount > 3 WHERE o.id IS NULL OR c.status = 'x'", { rows: [["b"]] }, context());
    expect(kept.findings).toEqual([]);
    expect(kept.status).toBe("clear");
  });

  it("finds an inclusive date upper bound that drops the last day's times", async () => {
    const report = await evaluateDataFalsification(db(), "SELECT SUM(amount) FROM orders WHERE created_at BETWEEN '2018-12-01' AND '2018-12-31'", { rows: [[5]] }, context());
    expect(report.findings).toEqual([expect.objectContaining({ rule: "date_upper_bound_truncated", message: expect.stringContaining("2 rows later on 2018-12-31") })]);
    const fine = await evaluateDataFalsification(db(), "SELECT SUM(amount) FROM orders WHERE created_at <= '2018-12-29'", { rows: [[0]] }, context());
    expect(fine.status).toBe("clear");
  });

  it("finds a literal that matches no row on an empty result, when the column holds it in another case", async () => {
    const report = await evaluateDataFalsification(db(), "SELECT COUNT(*) FROM customers WHERE status = 'active'", { rows: [[0]] }, context());
    expect(report.findings).toEqual([expect.objectContaining({ rule: "literal_not_matched", message: expect.stringContaining("\"Active\"") })]);
    // A non-empty result does not run the literal rule.
    const nonEmpty = await evaluateDataFalsification(db(), "SELECT COUNT(*) FROM customers WHERE status = 'active'", { rows: [[3]] }, context());
    expect(nonEmpty.status).toBe("not_applicable");
  });

  it("reports unknown, never clear, when a probe cannot run, and not_applicable without a pattern", async () => {
    const broken: AnsweringSqlExecutor = { run: async () => { throw new Error("no such table"); } };
    const unknown = await evaluateDataFalsification(broken, "SELECT SUM(amount) FROM orders WHERE created_at <= '2018-12-31'", { rows: [[1]] }, context());
    expect(unknown.status).toBe("unknown");
    expect(dataFalsificationCoverage(unknown)).toMatchObject({ checkId: "data_falsification", ruleVersion: "data-falsification-v1", outcome: "unknown" });
    const none = await evaluateDataFalsification(broken, "SELECT 1", { rows: [[1]] }, context());
    expect(dataFalsificationCoverage(none)).toMatchObject({ outcome: "not_applicable" });
  });

  it("discloses a finding with the published Receipt and never blocks", async () => {
    const executor = db();
    const answering = new InMemoryAnswering({ store: new InMemoryAnsweringStore(), resultStore: new InMemoryResultStore(), sqlExecutor: executor });
    const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "sum", of: "amount" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    const execution = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT SUM(amount) AS total FROM orders WHERE created_at <= '2018-12-31'" }, context("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    expect(execution.coverage).toContainEqual(expect.objectContaining({ checkId: "data_falsification", outcome: "finding" }));
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, context("publish"));
    expect(receipt.disclosure?.items).toContainEqual(expect.objectContaining({ kind: "data_falsification" }));
    expect(receipt.disclosure?.summary).toContain("SQL 与数据核对发现可能的偏差");
  });
});
