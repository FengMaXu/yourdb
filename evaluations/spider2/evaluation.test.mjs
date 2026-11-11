import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationReport, compareEpisodes, compareExperiments, legacyRecordFromResult, scoreAttempt } from "./evaluation.mjs";

test("scorer failure is unavailable and never becomes incorrect", async () => {
  const record = { attemptId: "attempt", caseId: "case", traceId: "trace", execution: { state: "completed" } };
  const score = await scoreAttempt(record, async () => { throw new Error("SCORER_DOWN"); });
  assert.equal(score.correctness.state, "unavailable");
  assert.notEqual(score.correctness.state, "incorrect");
  assert.equal(score.span.outcome, "unknown");
});

test("evaluation report keeps four dimensions and fixed denominator unknowns visible", () => {
  const records = [
    { caseId: "a", execution: { state: "completed" }, publication: { state: "published" }, correctness: { state: "correct" }, coverage: { state: "checked" }, usage: { state: "known", usage: { cost: { total: 1 } } } },
    { caseId: "b", execution: { state: "unknown" }, publication: { state: "unknown" }, correctness: { state: "unknown" }, coverage: { state: "unknown" } },
  ];
  const report = buildEvaluationReport(records, { a: 1 }, { denominatorIds: ["a", "b", "c"] });
  assert.equal(report.metrics.total, 3);
  assert.equal(report.metrics.dimensions.execution.unknown, 2);
  assert.equal(report.metrics.correctness.missingSubmissions, 2);
  assert.ok(report.limitations.includes("missing_episode_record"));
  assert.equal(report.metrics.dimensions.correctness.correct, 1);
});

test("core report exposes format, process, capability, categorized usage, and span coverage", () => {
  const record = {
    caseId: "a",
    execution: { state: "completed", startedAt: 10, endedAt: 30 },
    publication: { state: "published", format: "csv" },
    correctness: { state: "correct" },
    coverage: { state: "complete" },
    deliveryRequirement: { format: "csv", satisfied: true },
    process: { turns: 2, toolCalls: 3, revisions: 1, explorationQueries: 1, resultQueries: 1, fanoutProbes: 2 },
    capabilities: { fanout: { configured: true, executed: true, coverage: "observed" } },
    usage: {
      state: "known",
      mainUsage: { totalTokens: 10, cost: { total: 0.1 } },
      childUsage: { totalTokens: 4, cost: { total: 0.04 } },
      jevUsage: { totalTokens: 2, cost: { total: 0.02 } },
      modelSpanCount: 1,
      childSpanCount: 1,
      jevSpanCount: 1,
    },
    integrity: { projectionConflicts: 1 },
    spans: [
      { spanId: "root", kind: "agent", name: "agent.operation", lifecycle: "ended", outcome: "completed", durationMs: 20, observationCoverage: { state: "complete" } },
      { spanId: "tool", parentSpanId: "root", kind: "tool", name: "tool.query_database", lifecycle: "ended", outcome: "completed", durationMs: 5, observationCoverage: { state: "complete" } },
      { spanId: "probe", parentSpanId: "missing", kind: "database", name: "db.probe", lifecycle: "ended", outcome: "failed", observationCoverage: { state: "partial" } },
    ],
  };
  const report = buildEvaluationReport([record], { a: 1 }, { denominatorIds: ["a"] });
  assert.equal(report.metrics.publicationSummary.formatCoverage, 1);
  assert.equal(report.metrics.process.fanoutProbes, 2);
  assert.equal(report.metrics.capabilities.fanout.executed, 1);
  assert.equal(report.metrics.usage.child.totalTokens, 4);
  assert.equal(report.metrics.usage.jev.totalCost, 0.02);
  assert.equal(report.metrics.spans.byKind["db.probe"].failureRate, 1);
  assert.equal(report.metrics.spans.danglingParent, 1);
  assert.equal(report.metrics.spans.conflicts, 1);
});

test("paired comparison reports improvement, regression, and incomplete evidence", () => {
  const result = compareEpisodes(
    [{ caseId: "a", correctness: { state: "incorrect" }, coverage: { state: "checked" } }, { caseId: "b", correctness: { state: "correct" }, coverage: { state: "unknown" } }],
    [{ caseId: "a", correctness: { state: "correct" }, coverage: { state: "checked" } }, { caseId: "b", correctness: { state: "incorrect" }, coverage: { state: "unknown" } }],
  );
  assert.deepEqual(result.improved, ["a"]);
  assert.deepEqual(result.regressed, ["b"]);
  assert.deepEqual(result.incomplete, ["b"]);
});

test("legacy conversion is explicit and leaves correctness unknown", () => {
  const record = legacyRecordFromResult(
    { instanceId: "local001", status: "completed", csvGenerated: true },
    { events: [], toolCalls: [{ toolName: "export_query", args: { candidateId: "candidate" }, result: { details: { publicationReceipt: { receiptId: "receipt", candidateId: "candidate", format: "csv" } } } }] },
    { runId: "run", attemptId: "legacy" },
  );
  assert.equal(record.publication.state, "published");
  assert.equal(record.correctness.state, "unknown");
  assert.equal(record.coverage.state, "partial");
});

test("comparison remains non-formal when fixed identities differ", () => {
  const left = { experimentId: "left", suite: { name: "suite" }, inputs: { dataset: { sha256: "a" }, database: { sha256: "a" } }, scoring: { scorer: "s" } };
  const right = { experimentId: "right", suite: { name: "suite" }, inputs: { dataset: { sha256: "b" }, database: { sha256: "a" } }, scoring: { scorer: "s" } };
  assert.equal(compareExperiments(left, right).formal, false);
});
