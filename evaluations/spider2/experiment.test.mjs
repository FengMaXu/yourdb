import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertComparableExperiments, manifestFromExperiment, resolveExperiment, validateExperimentConfig } from "./experiment.mjs";

function config(root) {
  return {
    __path: path.join(root, "config.json"),
    spider2Repo: root,
    runsRoot: path.join(root, "runs"),
    datasetPath: path.join(root, "dataset.jsonl"),
    evaluationSuite: root,
    llm: { provider: "openai", model: "test", apiFormat: "chat", apiKeyEnv: "TEST_KEY" },
    limits: { timeoutMs: 10, maxTurns: 2, maxToolCalls: 3, maxExploratoryQueries: null },
    assurance: { detectors: { enabled: true } },
  };
}

test("resolveExperiment records resolved model, capabilities, budgets, and content identities without secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-experiment-"));
  try {
    const current = { ...config(root), localDatabasePackSha256: "a".repeat(64) };
    await writeFile(current.__path, JSON.stringify({ fixture: true }), "utf8");
    await writeFile(current.datasetPath, "dataset", "utf8");
    await writeFile(path.join(root, "evaluate.py"), "print('ok')", "utf8");
    const experiment = await resolveExperiment({ config: current, instanceIds: ["local002", "local001"], inputs: { systemPrompt: "prompt" } });
    assert.equal(experiment.schemaVersion, 1);
    assert.equal(experiment.subject.model, "test");
    assert.equal(experiment.suite.instanceIds[0], "local001");
    assert.equal(experiment.capabilities.fanout.configured, true);
    assert.equal(experiment.capabilities.semanticSpec.resolved, "required");
    assert.equal(experiment.capabilities.tools.resolved.includes("set_answer_spec"), true);
    assert.equal(experiment.capabilities.tools.resolved.includes("begin_query_task"), false);
    const legacyDisabled = await resolveExperiment({ config: { ...current, assurance: { detectors: { enabled: false } } }, instanceIds: ["local001"], inputs: { systemPrompt: "prompt" } });
    assert.equal(legacyDisabled.capabilities.fanout.resolved, true);
    assert.equal(experiment.budgets.queryTask.maxExplorationAttempts, 16);
    assert.equal(experiment.inputs.systemPrompt.kind, "content");
    assert.equal(experiment.inputs.config.state, "present");
    assert.deepEqual(experiment.inputs.database, { name: "database", kind: "declared-digest", state: "declared", sha256: "a".repeat(64) });
    assert.equal(JSON.stringify(experiment).includes("secret"), false);
    const manifest = manifestFromExperiment(experiment);
    assert.equal(manifest.experimentId, experiment.experimentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic-spec ablation is an explicit experiment factor with a distinct tool surface", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-experiment-ablation-"));
  try {
    const current = config(root);
    await writeFile(current.datasetPath, "dataset", "utf8");
    await writeFile(path.join(root, "evaluate.py"), "print('ok')", "utf8");
    const experiment = await resolveExperiment({ config: { ...current, answering: { semanticSpecMode: "disabled" } }, instanceIds: ["local001"], inputs: { systemPrompt: "ablation prompt" } });
    const required = await resolveExperiment({ config: current, instanceIds: ["local001"], inputs: { systemPrompt: "required prompt" } });
    assert.notEqual(experiment.experimentId, required.experimentId);
    assert.equal(experiment.capabilities.semanticSpec.resolved, "disabled");
    assert.equal(experiment.capabilities.tools.resolved.includes("begin_query_task"), true);
    assert.equal(experiment.capabilities.tools.resolved.includes("set_answer_spec"), false);
    const headless = await resolveExperiment({ config: { ...current, enableClarificationTool: false, answering: { semanticSpecMode: "disabled" } }, instanceIds: ["local001"], inputs: { systemPrompt: "ablation prompt" } });
    assert.equal(headless.capabilities.clarification.resolved, false);
    assert.equal(headless.capabilities.tools.resolved.includes("ask_user_clarification"), false);
    assert.equal(headless.capabilities.tools.resolved.includes("begin_query_task"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid and deprecated config is rejected instead of silently ignored", () => {
  assert.throws(() => validateExperimentConfig({ answering: { specInterface: "fields" } }), /DEPRECATED_CONFIG_FIELD:answering.specInterface/);
  assert.throws(() => validateExperimentConfig({ unknown: true }), /UNSUPPORTED_CONFIG_FIELD/);
  assert.throws(() => validateExperimentConfig({ limits: { maxExploratoryQueries: 3 } }), /DEPRECATED_CONFIG_FIELD/);
  assert.throws(() => validateExperimentConfig({ llm: { apiKey: "secret" } }), /INLINE_SECRET_FORBIDDEN/);
  assert.throws(() => validateExperimentConfig({ answering: { semanticSpecMode: "sometimes" } }), /INVALID_SEMANTIC_SPEC_MODE/);
  assert.throws(() => validateExperimentConfig({ localDatabasePackSha256: "not-a-sha256" }), /INVALID_CONFIG_VALUE:localDatabasePackSha256/);
  assert.throws(() => validateExperimentConfig({ enableClarificationTool: "false" }), /INVALID_CONFIG_VALUE:enableClarificationTool/);
});

test("comparison identity rejects differences outside the declared fixed factors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-experiment-compare-"));
  try {
    const left = await resolveExperiment({ config: config(root), instanceIds: ["local001"], inputs: { systemPrompt: "a" } });
    const right = await resolveExperiment({ config: { ...config(root), llm: { ...config(root).llm, model: "other" } }, instanceIds: ["local001"], inputs: { systemPrompt: "a" } });
    assert.equal(assertComparableExperiments(left, right).comparable, true);
    const changed = await resolveExperiment({ config: { ...config(root), datasetPath: path.join(root, "other.jsonl") }, instanceIds: ["local001"], inputs: { systemPrompt: "a" } });
    assert.equal(assertComparableExperiments(left, changed).comparable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
