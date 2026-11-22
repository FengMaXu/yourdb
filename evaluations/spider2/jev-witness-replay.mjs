#!/usr/bin/env node
// Plan T4.1: does adding probe witness rows to Jev's evidence change how often
// Jev picks the right alternative of a pending field?
//
// From one Jev-enabled run, every field Jev advised on is rebuilt from the
// Session records (alternatives, probe records with their output samples) and
// the trace (each alternative's probe SQL). Each alternative's probe SQL is run
// against the real database and compared with gold by the official evaluator;
// a field whose alternatives exactly one of which reproduces gold is a labelled
// sample. Jev is then asked twice per sample with the production evidence
// builder: with the witness rows, and without them. Nothing else differs.
//
// Usage:
//   npm run build:runtime
//   node evaluations/spider2/jev-witness-replay.mjs --run <run_id> \
//     [--runs-root C:/data-agent-eval/runs] [--lite-root C:/data-agent-eval/Spider2/spider2-lite] \
//     [--python C:/data-agent-eval/.venv/Scripts/python.exe] [--env-file evaluations/spider2/.env.local] [--out report.json]
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const dist = (file) => pathToFileURL(path.join(root, "packages/runtime/dist", file)).href;
const { probeEvidence } = await import(dist("answering/advice-execution.js"));
const { summarizeProbes } = await import(dist("answering/probes.js"));
const { valueKey } = await import(dist("answering/fields.js"));
const { JevHypothesisChoiceAdvisor } = await import(dist("protocol.js"));

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[argv[index].replace(/^--/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[index + 1];
  return out;
}

const options = args(process.argv.slice(2));
const runsRoot = options.runsRoot ?? "C:/data-agent-eval/runs";
const liteRoot = options.liteRoot ?? "C:/data-agent-eval/Spider2/spider2-lite";
const python = options.python ?? "C:/data-agent-eval/.venv/Scripts/python.exe";
const envFile = options.envFile ?? path.join(here, ".env.local");
if (!options.run) throw new Error("--run is required");

const apiKey = process.env.TYPESAFE_API_KEY?.trim() || (existsSync(envFile) ? readFileSync(envFile, "utf8").split(/\r?\n/).find((line) => line.startsWith("TYPESAFE_API_KEY="))?.slice(17).trim() : undefined);
if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");
const advisor = new JevHypothesisChoiceAdvisor({ apiKey, model: process.env.TYPESAFE_MODEL?.trim() || "jev-1.13.0", timeoutMs: 60_000 });

const questions = new Map(readFileSync(path.join(liteRoot, "spider2-lite.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((item) => [item.instance_id, item]));

/** The attempt that represents the case: the latest one that finished. */
function finalAttempt(caseDir) {
  const dir = path.join(caseDir, "attempts");
  if (!existsSync(dir)) return undefined;
  const attempts = readdirSync(dir).sort().reverse();
  return attempts.find((attempt) => {
    const file = path.join(dir, attempt, "result.json");
    return existsSync(file) && ["completed", "timeout", "max_turns"].includes(JSON.parse(readFileSync(file, "utf8")).status);
  });
}

/** Latest Answering record per key from the Session's JSONL value writes. */
function answeringRecords(sessionDir) {
  const records = new Map();
  const files = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".jsonl")) files.push(full); } };
  if (existsSync(sessionDir)) walk(sessionDir);
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      for (const op of Array.isArray(parsed) ? parsed : [parsed]) {
        if (op?.kind === "value" && /^data-agent\.answering\.v\d+\.records$/.test(op.namespace ?? "") && op.value?.record) records.set(op.key, op.value.record);
      }
    }
  }
  return records;
}

function databasePath(attemptDir) {
  const find = (value) => {
    if (!value || typeof value !== "object") return undefined;
    if (value.databaseIdentity?.path) return value.databaseIdentity.path;
    for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
    return undefined;
  };
  for (const file of ["result.json", "attempt.json"]) {
    const full = path.join(attemptDir, file);
    if (existsSync(full)) { const found = find(JSON.parse(readFileSync(full, "utf8"))); if (found) return found; }
  }
  return undefined;
}

// 1. Advised fields with their alternatives, probes and probe SQL.
const samples = [];
const casesDir = path.join(runsRoot, options.run, "cases");
for (const instanceId of readdirSync(casesDir).sort()) {
  const attempt = finalAttempt(path.join(casesDir, instanceId));
  if (!attempt) continue;
  const attemptDir = path.join(casesDir, instanceId, "attempts", attempt);
  const records = answeringRecords(path.join(attemptDir, "session"));
  const trace = existsSync(path.join(attemptDir, "trace.json")) ? JSON.parse(readFileSync(path.join(attemptDir, "trace.json"), "utf8")) : { toolCalls: [] };
  const probeSql = new Map();
  for (const call of trace.toolCalls ?? []) {
    if (call.toolName === "query_database" && call.args?.probe?.alternativeId && typeof call.args.sql === "string") probeSql.set(`${call.args.probe.path}|${call.args.probe.alternativeId}`, call.args.sql);
  }
  const revisions = [...records.entries()].filter(([key]) => key.startsWith("revision/")).map(([, record]) => record);
  const dbPath = databasePath(attemptDir);
  for (const [key, task] of records) {
    if (!key.startsWith("task/") || !Array.isArray(task.fieldAdvice)) continue;
    for (const advice of task.fieldAdvice) {
      if (advice.recommendation === "unavailable" || !Array.isArray(advice.alternativeIds) || advice.alternativeIds.length < 2) continue;
      const wanted = [...advice.alternativeIds].sort().join(",");
      const field = revisions.filter((revision) => revision.taskId === task.taskId).map((revision) => revision.fields?.[advice.path])
        .find((candidate) => (candidate?.state === "open" || candidate?.state === "decided") && candidate.alternatives.map((item) => item.id).sort().join(",") === wanted);
      if (!field) continue;
      const summary = summarizeProbes(advice.path, field.alternatives, task.fieldProbes ?? [], field.waivers ?? [], undefined);
      if (new Set(summary.fingerprints.values()).size < 2) continue;
      const sqls = field.alternatives.map((alternative) => probeSql.get(`${advice.path}|${alternative.id}`));
      samples.push({ instanceId, taskId: task.taskId, path: advice.path, field, summary, sqls, dbPath, recorded: advice });
    }
  }
}

// 2. Gold labels from the official comparison.
const items = samples.flatMap((sample, index) => sample.sqls.map((sql, position) => sql && sample.dbPath ? [{ key: `${index}:${position}`, instanceId: sample.instanceId, dbPath: sample.dbPath, sql }] : []).flat());
const labelled = spawnSync(python, [path.join(here, "label_probe_alternatives.py"), path.join(liteRoot, "evaluation_suite")], { input: items.map((item) => JSON.stringify(item)).join("\n"), encoding: "utf8", maxBuffer: 1 << 26 });
if (labelled.status !== 0) throw new Error(`labeling failed: ${labelled.stderr.slice(0, 500)}`);
const matches = new Map(labelled.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((item) => [item.key, item]));
for (const [index, sample] of samples.entries()) {
  sample.matches = sample.field.alternatives.map((_alternative, position) => matches.get(`${index}:${position}`)?.match === true);
}
const usable = samples.filter((sample) => sample.matches.filter(Boolean).length === 1);

// 3. Jev with and without the witness rows.
const pick = (assessment) => assessment.recommendation.kind === "hypothesis"
  ? assessment.recommendation.hypothesisId
  : [...assessment.probabilities].sort((left, right) => right.probability - left.probability)[0]?.hypothesisId;
const results = [];
for (const sample of usable) {
  const question = questions.get(sample.instanceId)?.question ?? "";
  const hypotheses = sample.field.alternatives.map((alternative) => ({ id: alternative.id, statement: `${sample.path}: ${valueKey(alternative.value)}` }));
  const request = { id: "request", kind: "request_wording", authority: "request_wording", authorityRank: 3, sourceRef: "user_request", content: question };
  const correctId = sample.field.alternatives[sample.matches.indexOf(true)].id;
  const ask = async (witnesses) => {
    try {
      const assessment = await advisor.compare({ originalQuestion: question, hypotheses, evidence: [request, probeEvidence(sample.field, sample.summary, { witnesses })] });
      return { pick: pick(assessment), lean: assessment.recommendation.kind, correct: pick(assessment) === correctId, probability: assessment.probabilities.find((item) => item.hypothesisId === correctId)?.probability ?? 0 };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const withWitness = await ask(true);
  const withoutWitness = await ask(false);
  results.push({ instanceId: sample.instanceId, path: sample.path, alternatives: hypotheses.length, witnessRows: sample.summary.witnesses.length, withWitness, withoutWitness, recordedInRun: { pick: sample.recorded.recommendedAlternativeId ?? sample.recorded.lean?.alternativeId, correct: (sample.recorded.recommendedAlternativeId ?? sample.recorded.lean?.alternativeId) === correctId } });
}

const scored = results.filter((item) => !item.withWitness.error && !item.withoutWitness.error);
const rate = (key) => scored.length ? scored.filter((item) => item[key].correct).length / scored.length : 0;
const report = {
  run: options.run,
  advisedFields: samples.length,
  labelledFields: usable.length,
  scoredFields: scored.length,
  unlabelledReason: { noAlternativeMatchesGold: samples.filter((sample) => sample.matches.every((match) => !match)).length, severalMatchGold: samples.filter((sample) => sample.matches.filter(Boolean).length > 1).length },
  accuracy: { withWitness: rate("withWitness"), withoutWitness: rate("withoutWitness"), deltaPoints: 100 * (rate("withWitness") - rate("withoutWitness")) },
  meanProbabilityOnCorrect: { withWitness: scored.reduce((sum, item) => sum + item.withWitness.probability, 0) / (scored.length || 1), withoutWitness: scored.reduce((sum, item) => sum + item.withoutWitness.probability, 0) / (scored.length || 1) },
  pairedChanges: { fixedByWitness: scored.filter((item) => item.withWitness.correct && !item.withoutWitness.correct).map((item) => `${item.instanceId}:${item.path}`), brokenByWitness: scored.filter((item) => !item.withWitness.correct && item.withoutWitness.correct).map((item) => `${item.instanceId}:${item.path}`) },
  results,
};
if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
