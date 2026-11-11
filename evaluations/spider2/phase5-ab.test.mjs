import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPhase5Report } from "./phase5-ab.mjs";

function manifest(arm, enabled, interpretations) {
  return {
    runId: `phase5-${arm}`,
    agentCommit: "agent",
    spider2Commit: "spider2",
    datasetSha256: "dataset",
    evaluatorSha256: "evaluator",
    systemPromptSha256: "prompt",
    model: { provider: "openai", model: "test", apiFormat: "chat" },
    limits: { maxTurns: 20, maxToolCalls: 50, maxExploratoryQueries: 6 },
    concurrency: 1,
    assurance: {
      mode: "shadow",
      reviewerModel: "test",
      planner: true,
      shadowDelivery: "publish_with_disagreement",
      hooks: { informOnQuery: true, interpretationsOnAnomaly: interpretations, integrityBlocks: true, terminateAfterExport: true },
      detectors: { enabled, tierA: ["join_fanout"], tierB: ["shape_mismatch"], disabled: [] },
      interpretations: { triggerTiers: ["A"], maxCyclesPerTask: 1 },
      delivery: "deliver_with_disclosure",
    },
    instanceIds: ["local001"],
  };
}

const summary = (csvCoverage) => ({
  total: 1,
  statuses: { completed: 1 },
  publicationStatuses: { published_with_disagreement: 1 },
  sqlCoverage: csvCoverage,
  csvCoverage,
  averageDurationMs: 10,
  averageToolCalls: 2,
  anomalyCount: 0,
  interpretationHookCount: 0,
  interpretationBudgetSkipCount: 0,
});

const official = (score) => ({ execResult: { fixedDenominator: { score, correct: score ? 1 : 0, total: 1, missingSubmissions: score ? 0 : 1 }, caseScores: { local001: score ? 1 : 0 } } });

test("Phase 5 A/B verifier recognizes semantic-spec mode as the sole experiment factor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phase5-semantic-spec-ab-test-"));
  const control = path.join(root, "control");
  const treatment = path.join(root, "treatment");
  const spec = path.join(root, "missing-spec.json");
  const v1Manifest = (mode, model = "test") => {
    const tools = ["query_database", "export_query", ...(mode === "required" ? ["begin_answer_spec", "revise_answer_spec"] : ["begin_query_task"])];
    const promptSha = `prompt-${mode}`;
    return {
      schemaVersion: 1,
      experimentId: `experiment-${mode}`,
      suite: { name: "spider2-lite", dataset: "dataset", evaluator: "evaluator", instanceIds: ["local001"] },
      subject: { provider: "openai", model, apiFormat: "chat" },
      inputs: { systemPrompt: { sha256: promptSha }, dataset: { sha256: "dataset" }, database: { sha256: "database" }, config: { sha256: "config" }, runtimeSource: { sha256: "runtime" }, skills: { sha256: "skills" } },
      scoring: { scorer: "official" },
      budgets: { episode: { timeoutMs: 1 }, queryTask: { maxExplorationAttempts: 2 } },
      limits: { timeoutMs: 1, maxTurns: 2, maxToolCalls: 3 },
      attemptPolicy: { includeInPrimary: "first_complete_or_explicit_policy" },
      comparisonPolicy: { repetitions: 1 },
      capabilities: {
        semanticSpec: { configured: mode, resolved: mode },
        tools: { resolved: tools },
      },
      observedCapabilities: { tools: { state: "observed", coverage: "complete", observedCases: 1, expectedCases: 1, resolved: tools } },
      observedInputs: { databases: [{ caseId: "local001", state: "known", backend: "sqlite", path: "C:/db/local001.sqlite", sha256: "database-observed" }] },
      answering: { semanticSpecMode: mode, promptProfile: `semantic-spec-${mode}` },
      assuranceObserver: { hooks: {} },
      baselineLockSha256: `lock-${mode}`,
      systemPromptSha256: promptSha,
      concurrency: 1,
      instanceIds: ["local001"],
    };
  };
  try {
    for (const run of [control, treatment]) await mkdir(path.join(run, "cases", "local001"), { recursive: true });
    await mkdir(path.join(control, "official_score"), { recursive: true });
    await mkdir(path.join(treatment, "official_score"), { recursive: true });
    await writeFile(path.join(control, "manifest.json"), JSON.stringify(v1Manifest("disabled")));
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(v1Manifest("required")));
    for (const run of [control, treatment]) {
      await writeFile(path.join(run, "summary.json"), JSON.stringify(summary(1)));
      await writeFile(path.join(run, "official_score", "summary.json"), JSON.stringify(official(1)));
      await writeFile(path.join(run, "cases", "local001", "trace.json"), JSON.stringify({ toolCalls: [] }));
    }
    const result = await buildPhase5Report(control, treatment, spec);
    assert.equal(result.json.comparison.sameExperimentalInputs, true);
    assert.equal(result.json.comparison.databaseEvidenceComplete, true);
    assert.equal(result.json.comparison.onlyExpectedDifferences, true);
    assert.equal(result.json.comparison.semanticSpecAblation, true);
    assert.equal(result.json.comparison.caseScoreDelta.unchanged.length, 1);
    assert.deepEqual(result.json.comparison.caseScoreDelta.missingBoth, []);
    assert.equal(result.json.methodology.experimentFactor, "semantic_spec_mode");

    const relocatedDatabase = v1Manifest("required");
    relocatedDatabase.observedInputs.databases[0].path = "D:/other-root/local001.sqlite";
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(relocatedDatabase));
    const relocated = await buildPhase5Report(control, treatment, spec);
    assert.equal(relocated.json.comparison.sameExperimentalInputs, true);
    assert.equal(relocated.json.comparison.onlyExpectedDifferences, true);

    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(v1Manifest("required", "different-model")));
    const confounded = await buildPhase5Report(control, treatment, spec);
    assert.equal(confounded.json.comparison.sameExperimentalInputs, false);
    assert.equal(confounded.json.comparison.onlyExpectedDifferences, false);

    const missingObserved = v1Manifest("required");
    delete missingObserved.observedCapabilities;
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(missingObserved));
    const unobserved = await buildPhase5Report(control, treatment, spec);
    assert.equal(unobserved.json.comparison.semanticSpecAblation, false);
    assert.equal(unobserved.json.comparison.onlyExpectedDifferences, false);

    const wrongPrompt = v1Manifest("required");
    wrongPrompt.systemPromptSha256 = "prompt-disabled";
    wrongPrompt.inputs.systemPrompt.sha256 = "prompt-disabled";
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(wrongPrompt));
    const promptMismatch = await buildPhase5Report(control, treatment, spec);
    assert.equal(promptMismatch.json.comparison.semanticSpecAblation, false);
    assert.equal(promptMismatch.json.comparison.onlyExpectedDifferences, false);

    const differentDatabase = v1Manifest("required");
    differentDatabase.observedInputs.databases[0].sha256 = "different-database";
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(differentDatabase));
    const databaseMismatch = await buildPhase5Report(control, treatment, spec);
    assert.equal(databaseMismatch.json.comparison.sameExperimentalInputs, false);
    assert.equal(databaseMismatch.json.comparison.databaseEvidenceComplete, true);
    assert.equal(databaseMismatch.json.comparison.onlyExpectedDifferences, false);

    const missingDatabaseEvidence = v1Manifest("required");
    delete missingDatabaseEvidence.observedInputs;
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(missingDatabaseEvidence));
    const databaseUnknown = await buildPhase5Report(control, treatment, spec);
    assert.equal(databaseUnknown.json.comparison.databaseEvidenceComplete, false);
    assert.equal(databaseUnknown.json.comparison.sameExperimentalInputs, false);
    assert.equal(databaseUnknown.json.comparison.onlyExpectedDifferences, false);

    const changedLimits = v1Manifest("required");
    changedLimits.limits.maxTurns = 99;
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(changedLimits));
    const limitsMismatch = await buildPhase5Report(control, treatment, spec);
    assert.equal(limitsMismatch.json.comparison.sameExperimentalInputs, false);
    assert.equal(limitsMismatch.json.comparison.onlyExpectedDifferences, false);

    const changedConfig = v1Manifest("required");
    changedConfig.inputs.config.sha256 = "different-config";
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(changedConfig));
    const configMismatch = await buildPhase5Report(control, treatment, spec);
    assert.equal(configMismatch.json.comparison.sameExperimentalInputs, false);
    assert.equal(configMismatch.json.comparison.onlyExpectedDifferences, false);

    const missingBaselineLock = v1Manifest("required");
    delete missingBaselineLock.baselineLockSha256;
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(missingBaselineLock));
    const unlocked = await buildPhase5Report(control, treatment, spec);
    assert.equal(unlocked.json.comparison.semanticSpecAblation, false);
    assert.equal(unlocked.json.comparison.onlyExpectedDifferences, false);

    const incompleteToolCoverage = v1Manifest("required");
    incompleteToolCoverage.observedCapabilities.tools.observedCases = 0;
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(incompleteToolCoverage));
    const partialTools = await buildPhase5Report(control, treatment, spec);
    assert.equal(partialTools.json.comparison.semanticSpecAblation, false);
    assert.equal(partialTools.json.comparison.onlyExpectedDifferences, false);

    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(v1Manifest("required")));
    for (const run of [control, treatment]) {
      await writeFile(path.join(run, "official_score", "summary.json"), JSON.stringify({ execResult: { fixedDenominator: { score: 0, correct: 0, total: 1, missingSubmissions: 1 }, caseScores: {} } }));
    }
    const missingBoth = await buildPhase5Report(control, treatment, spec);
    assert.deepEqual(missingBoth.json.comparison.caseScoreDelta.unchanged, ["local001"]);
    assert.deepEqual(missingBoth.json.comparison.caseScoreDelta.missingBoth, ["local001"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 5 A/B verifier checks the intended switches and fixed-denominator outcome", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "phase5-ab-test-"));
  const control = path.join(root, "control");
  const treatment = path.join(root, "treatment");
  const spec = path.join(root, "spec.json");
  try {
    for (const run of [control, treatment]) await mkdir(path.join(run, "cases", "local001"), { recursive: true });
    await mkdir(path.join(control, "official_score"), { recursive: true });
    await mkdir(path.join(treatment, "official_score"), { recursive: true });
    await writeFile(path.join(control, "manifest.json"), JSON.stringify(manifest("control", false, false)));
    await writeFile(path.join(treatment, "manifest.json"), JSON.stringify(manifest("hooks", true, true)));
    await writeFile(path.join(control, "summary.json"), JSON.stringify(summary(0.5)));
    await writeFile(path.join(treatment, "summary.json"), JSON.stringify(summary(1)));
    await writeFile(path.join(control, "official_score", "summary.json"), JSON.stringify(official(0.5)));
    await writeFile(path.join(treatment, "official_score", "summary.json"), JSON.stringify(official(0)));
    const trace = { toolCalls: [{ toolName: "query_database", args: { mode: "exploration" }, result: { details: { artifactKind: "exploration" } } }, { toolName: "query_database", args: { mode: "result" }, result: { details: { artifactKind: "result_candidate" } } }] };
    await writeFile(path.join(control, "cases", "local001", "trace.json"), JSON.stringify(trace));
    await writeFile(path.join(treatment, "cases", "local001", "trace.json"), JSON.stringify(trace));
    const slotMetric = { coverage: 1, precision: 1, recall: 1, mismatchRate: 0, overConstraintRate: null };
    await writeFile(spec, JSON.stringify({ aggregate: {
      sevenFacetSlots: { facets: Object.fromEntries(["entity", "metric", "filters", "groupBy", "time", "ranking", "output"].map((facet) => [facet, slotMetric])) },
      slots: { outputColumns: { coverage: 0, precision: null, recall: 0, mismatchRate: null, overConstraintRate: null } },
    } }));

    const result = await buildPhase5Report(control, treatment, spec);
    assert.equal(result.json.comparison.sameExperimentalInputs, true);
    assert.equal(result.json.comparison.onlyExpectedDifferences, true);
    assert.equal(result.json.comparison.csvCoverageNonDecreasing, true);
    assert.equal(result.json.comparison.accuracyNonDecreasing, false);
    assert.equal(result.json.arms.control.metrics.trace.explorationQueries, 1);
    assert.equal(result.json.arms.treatment.metrics.trace.resultQueries, 1);
    assert.match(result.markdown, /135 题七槽位离线指标/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
