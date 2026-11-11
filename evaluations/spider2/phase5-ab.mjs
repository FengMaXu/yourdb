#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableStringify } from "./record.mjs";

const DEFAULT_CONTROL = "C:/data-agent-eval/runs/round11-paired-040-control";
const DEFAULT_TREATMENT = "C:/data-agent-eval/runs/round11-paired-040-hooks";
const DEFAULT_SPEC_REPORT = "docs/Spider2题面Spec提取质量-135题-槽位基线.json";
const DEFAULT_OUTPUT = "docs/Spider2七槽位Phase5同配置AB评估.json";
const DEFAULT_MARKDOWN = "docs/Spider2七槽位Phase5同配置AB评估.md";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function normalizedObservedInputs(observedInputs) {
  if (!observedInputs) return observedInputs;
  const databases = Array.isArray(observedInputs.databases)
    ? observedInputs.databases
      .map(({ path: _path, ...identity }) => identity)
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))
    : observedInputs.databases;
  return { ...observedInputs, ...(databases !== undefined ? { databases } : {}) };
}

function hasCompleteObservedDatabaseEvidence(manifest, instanceIds) {
  const databases = normalizedObservedInputs(manifest.observedInputs)?.databases;
  if (!Array.isArray(databases) || databases.length !== instanceIds.length) return false;
  const expected = new Set(instanceIds.map(String));
  const observed = new Set();
  for (const database of databases) {
    const caseId = String(database?.caseId ?? "");
    if (!expected.has(caseId) || observed.has(caseId) || database?.state !== "known" || typeof database.sha256 !== "string" || !database.sha256) return false;
    observed.add(caseId);
  }
  return observed.size === expected.size;
}

/** Semantic-Spec arm tools; the ablation arm uses begin_query_task instead. */
const SPEC_TOOLS = ["begin_answer_spec", "revise_answer_spec"];

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function withoutRunIdentity(manifest) {
  if (manifest.experimentId && manifest.schemaVersion === 1) {
    const { systemPrompt: _systemPrompt, ...fixedInputs } = manifest.inputs ?? {};
    const { semanticSpec: _semanticSpec, tools: _tools, ...fixedCapabilities } = manifest.capabilities ?? {};
    const { semanticSpecMode: _semanticSpecMode, promptProfile: _promptProfile, ...fixedAnswering } = manifest.answering ?? {};
    return {
      suite: manifest.suite,
      subject: manifest.subject,
      model: manifest.model,
      fixedInputs,
      scoring: manifest.scoring,
      budgets: manifest.budgets,
      limits: manifest.limits,
      concurrency: manifest.concurrency,
      attemptPolicy: manifest.attemptPolicy,
      comparisonPolicy: manifest.comparisonPolicy,
      fixedCapabilities,
      fixedAnswering,
      assuranceObserver: manifest.assuranceObserver,
      agentCommit: manifest.agentCommit,
      spider2Commit: manifest.spider2Commit,
      datasetSha256: manifest.datasetSha256,
      evaluatorSha256: manifest.evaluatorSha256,
      runnerSha256: manifest.runnerSha256,
      observedInputs: normalizedObservedInputs(manifest.observedInputs),
    };
  }
  const assurance = manifest.assurance ?? manifest.assuranceObserver ?? {};
  const hooks = assurance.hooks ?? {};
  const detectors = assurance.detectors ?? {};
  return {
    datasetSha256: manifest.datasetSha256,
    spider2Commit: manifest.spider2Commit,
    evaluatorSha256: manifest.evaluatorSha256,
    systemPromptSha256: manifest.systemPromptSha256,
    model: manifest.model,
    limits: manifest.limits,
    concurrency: manifest.concurrency,
    assurance: {
      ...assurance,
      arm: undefined,
      fewshot: undefined,
      hooks: { ...hooks, interpretationsOnAnomaly: undefined },
      detectors: { ...detectors, enabled: undefined },
    },
  };
}

async function traceMetrics(runPath, instanceIds, attemptId) {
  const metrics = { queryCalls: 0, explorationQueries: 0, resultQueries: 0, unclassifiedQueries: 0, explorationArtifacts: 0, resultArtifacts: 0, traceFiles: 0, missingTraceFiles: 0 };
  for (const instanceId of instanceIds) {
    try {
      const canonical = attemptId ? path.join(runPath, "cases", String(instanceId), "attempts", attemptId, "trace.json") : undefined;
      const target = canonical && await exists(canonical) ? canonical : path.join(runPath, "cases", String(instanceId), "trace.json");
      const trace = await readJson(target);
      metrics.traceFiles += 1;
      for (const call of trace.toolCalls ?? []) {
        if (call.toolName !== "query_database") continue;
        metrics.queryCalls += 1;
        const args = call.args ?? {};
        const details = call.result?.details ?? {};
        const artifactKind = details.artifactKind ?? details.artifact?.kind;
        const exploration = (args.kind ?? args.mode) === "exploration" || artifactKind === "exploration";
        const result = (args.kind ?? args.mode) === "result" || artifactKind === "result_candidate" || artifactKind === "candidate";
        if (exploration) metrics.explorationQueries += 1;
        else if (result) metrics.resultQueries += 1;
        else metrics.unclassifiedQueries += 1;
        if (artifactKind === "exploration") metrics.explorationArtifacts += 1;
        if (artifactKind === "result_candidate" || artifactKind === "candidate") metrics.resultArtifacts += 1;
      }
    } catch {
      metrics.missingTraceFiles += 1;
    }
  }
  return metrics;
}

function summaryMetrics(summary, official, trace) {
  const fixed = official?.execResult?.fixedDenominator ?? official?.sql?.fixedDenominator;
  const publicationStatuses = summary.publicationStatuses ?? {};
  const published = Object.entries(publicationStatuses)
    .filter(([status]) => status === "published" || status === "published_approved" || status === "published_with_disagreement")
    .reduce((total, [, count]) => total + Number(count), 0);
  return {
    total: summary.total,
    sqlCoverage: summary.sqlCoverage,
    csvCoverage: summary.csvCoverage,
    published,
    publicationStatuses,
    averageDurationMs: summary.averageDurationMs,
    averageToolCalls: summary.averageToolCalls,
    anomalyCount: summary.anomalyCount ?? 0,
    interpretationHookCount: summary.interpretationHookCount ?? 0,
    interpretationBudgetSkipCount: summary.interpretationBudgetSkipCount ?? 0,
    trace,
    officialFixedDenominator: fixed ? {
      score: fixed.score,
      correct: fixed.correct,
      total: fixed.total,
      missingSubmissions: fixed.missingSubmissions,
    } : null,
  };
}

function caseScores(official) {
  return official?.execResult?.caseScores ?? official?.sql?.caseScores ?? {};
}

function semanticSpecMode(manifest) {
  return manifest.answering?.semanticSpecMode ?? manifest.capabilities?.semanticSpec?.resolved;
}

function isSemanticSpecAblation(control, treatment, hookDifferences) {
  const modes = new Set([semanticSpecMode(control), semanticSpecMode(treatment)]);
  if (modes.size !== 2 || !modes.has("required") || !modes.has("disabled") || hookDifferences.length !== 0) return false;
  const { semanticSpec: _controlSemanticSpec, tools: _controlTools, ...controlFixedCapabilities } = control.capabilities ?? {};
  const { semanticSpec: _treatmentSemanticSpec, tools: _treatmentTools, ...treatmentFixedCapabilities } = treatment.capabilities ?? {};
  if (!sameValue(controlFixedCapabilities, treatmentFixedCapabilities)) return false;
  if (!control.baselineLockSha256 || !treatment.baselineLockSha256 || control.baselineLockSha256 === treatment.baselineLockSha256) return false;
  if (!sameValue(control.assuranceObserver ?? {}, treatment.assuranceObserver ?? {})) return false;
  if (control.capabilities?.specFeedback?.resolved === true || treatment.capabilities?.specFeedback?.resolved === true) return false;
  const manifests = [control, treatment];
  for (const manifest of manifests) {
    const mode = semanticSpecMode(manifest);
    if (manifest.answering?.promptProfile !== `semantic-spec-${mode}`) return false;
    if (typeof manifest.systemPromptSha256 !== "string" || manifest.systemPromptSha256 !== manifest.inputs?.systemPrompt?.sha256) return false;
    if (manifest.observedCapabilities?.tools?.state !== "observed" || manifest.observedCapabilities?.tools?.coverage !== "complete") return false;
    const expectedCases = (manifest.instanceIds ?? manifest.suite?.instanceIds ?? []).length;
    if (manifest.observedCapabilities.tools.observedCases !== expectedCases || manifest.observedCapabilities.tools.expectedCases !== expectedCases) return false;
    const declared = [...(manifest.capabilities?.tools?.resolved ?? [])].sort();
    const observed = [...(manifest.observedCapabilities?.tools?.resolved ?? [])].sort();
    if (!sameValue(declared, observed)) return false;
    const selected = mode === "required" ? SPEC_TOOLS : ["begin_query_task"];
    const excluded = mode === "required" ? ["begin_query_task"] : SPEC_TOOLS;
    if (!selected.every((tool) => observed.includes(tool)) || excluded.some((tool) => observed.includes(tool))) return false;
  }
  if (control.systemPromptSha256 === treatment.systemPromptSha256) return false;
  const controlTools = new Set(control.observedCapabilities.tools.resolved);
  const treatmentTools = new Set(treatment.observedCapabilities.tools.resolved);
  const differing = [...new Set([...controlTools, ...treatmentTools])].filter((tool) => controlTools.has(tool) !== treatmentTools.has(tool)).sort();
  // compare_hypotheses may differ too: it only exists alongside the semantic Spec.
  return sameValue(differing.filter((tool) => tool !== "compare_hypotheses"), ["begin_query_task", ...SPEC_TOOLS].sort());
}

function compareCaseScores(control, treatment, denominatorIds = []) {
  const ids = [...new Set([...denominatorIds, ...Object.keys(control), ...Object.keys(treatment)])].sort();
  const improved = [];
  const regressed = [];
  const unchanged = [];
  const missingBoth = [];
  for (const id of ids) {
    if (!Object.hasOwn(control, id) && !Object.hasOwn(treatment, id)) missingBoth.push(id);
    const left = Number(control[id] ?? 0);
    const right = Number(treatment[id] ?? 0);
    if (right > left) improved.push(id);
    else if (right < left) regressed.push(id);
    else unchanged.push(id);
  }
  return { improved, regressed, unchanged, missingBoth };
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${(Number(value) * 100).toFixed(2)}%`;
}

function renderMarkdown(report) {
  const c = report.arms.control.metrics;
  const t = report.arms.treatment.metrics;
  const comparison = report.comparison;
  const rows = [
    ["固定分母官方 EX", c.officialFixedDenominator?.score, t.officialFixedDenominator?.score, true],
    ["SQL 覆盖", c.sqlCoverage, t.sqlCoverage, true],
    ["CSV 覆盖", c.csvCoverage, t.csvCoverage, true],
    ["平均工具调用", c.averageToolCalls, t.averageToolCalls, false],
    ["平均耗时（毫秒）", c.averageDurationMs, t.averageDurationMs, false],
    ["异常数", c.anomalyCount, t.anomalyCount, false],
    ["解释 Hook 注入数", c.interpretationHookCount, t.interpretationHookCount, false],
    ["预算跳过数", c.interpretationBudgetSkipCount, t.interpretationBudgetSkipCount, false],
    ["探索查询数（用途已标注）", c.trace.explorationQueries, t.trace.explorationQueries, false],
    ["结果查询数（用途已标注）", c.trace.resultQueries, t.trace.resultQueries, false],
    ["用途未标注查询数", c.trace.unclassifiedQueries, t.trace.unclassifiedQueries, false],
    ["缺失 Trace 文件数", c.trace.missingTraceFiles, t.trace.missingTraceFiles, false],
  ].map(([label, left, right, isRate]) => `| ${label} | ${isRate ? percent(left) : left ?? "—"} | ${isRate ? percent(right) : right ?? "—"} |`).join("\n");
  return [
    "# Spider2 七槽位 Phase 5 同配置 A/B 评估",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `- control：${report.arms.control.runPath}`,
    `- treatment：${report.arms.treatment.runPath}`,
    `- 同数据集/模型/预算/题目：${report.comparison.sameExperimentalInputs ? "是" : "否"}`,
    `- 逐题数据库身份覆盖完整：${report.comparison.databaseEvidenceComplete ? "是" : "否"}`,
    `- 仅预期开关不同：${report.comparison.onlyExpectedDifferences ? "是" : "否"}`,
    `- SQL 用途路由证据完整：${report.comparison.routingEvidenceComplete ? "是" : "否"}`,
    "",
    "## 1. 指标",
    "",
    "| 指标 | control | treatment |",
    "|---|---:|---:|",
    rows,
    "",
    "## 2. 135 题七槽位离线指标",
    "",
    report.specQuality ? [
      "| 槽位 | Coverage | Precision | Recall | 错配率 | 过度约束率 |",
      "|---|---:|---:|---:|---:|---:|",
      ...Object.entries(report.specQuality.facets).map(([facet, metric]) => `| ${facet} | ${percent(metric.coverage)} | ${percent(metric.precision)} | ${percent(metric.recall)} | ${percent(metric.mismatchRate)} | ${percent(metric.overConstraintRate)} |`),
      report.specQuality.outputColumns
        ? `| output.columns | ${percent(report.specQuality.outputColumns.coverage)} | ${percent(report.specQuality.outputColumns.precision)} | ${percent(report.specQuality.outputColumns.recall)} | ${percent(report.specQuality.outputColumns.mismatchRate)} | ${percent(report.specQuality.outputColumns.overConstraintRate)} |`
        : "| output.columns | — | — | — | — | — |", 
    ].join("\n") : "未加载 135 题槽位报告。",
    "",
    "## 3. 逐题分数变化",
    "", 
    `- 提升：${comparison.caseScoreDelta.improved.length} 题（${comparison.caseScoreDelta.improved.join(", ") || "无"}）`,
    `- 回退：${comparison.caseScoreDelta.regressed.length} 题（${comparison.caseScoreDelta.regressed.join(", ") || "无"}）`,
    `- 不变：${comparison.caseScoreDelta.unchanged.length} 题（其中两组均未提交：${comparison.caseScoreDelta.missingBoth.length} 题）`,
    "",
    "## 4. 方案验收判断",
    "",
    `- 完整性：${report.comparison.sameExperimentalInputs && report.comparison.onlyExpectedDifferences ? "通过" : "不通过"}`,
    `- SQL 用途路由证据完整：${report.comparison.routingEvidenceComplete ? "通过" : "不通过（旧运行未记录显式 mode）"}`,
    `- 发布覆盖不下降：${report.comparison.csvCoverageNonDecreasing ? "通过" : "不通过"}`,
    `- 固定分母准确率不下降：${report.comparison.accuracyNonDecreasing ? "通过" : "不通过"}`,
    `- 成本不增加一项仅作观测：平均工具调用变化 ${(Number(t.averageToolCalls ?? 0) - Number(c.averageToolCalls ?? 0)).toFixed(2)}`,
    "",
    "## 5. 结论",
    "",
    `本 A/B 的实验完整性${report.comparison.sameExperimentalInputs && report.comparison.onlyExpectedDifferences && report.comparison.routingEvidenceComplete ? "通过" : "不完全"}。按照方案的效果判断，当前 treatment ${report.comparison.accuracyNonDecreasing && report.comparison.csvCoverageNonDecreasing ? "可继续推进" : "不应作为默认策略推广"}；保留逐题结果和失败原因，下一轮应先用当前 HEAD 记录显式 SQL mode 后重跑，并分析回退题。`,
    "",
    "> 该 A/B 使用仓库外已完成的 40 题同配置运行作为可复核基线；它不是对 135 题重新调用模型的替代。若要获得当前 HEAD 的 135 题端到端效果，需提供模型凭据后按同一 Manifest 规则重跑 control/treatment。",
    "",
  ].join("\n");
}

export async function buildPhase5Report(controlPath, treatmentPath, specReportPath) {
  const [controlManifest, treatmentManifest, controlSummary, treatmentSummary] = await Promise.all([
    readJson(path.join(controlPath, "manifest.json")),
    readJson(path.join(treatmentPath, "manifest.json")),
    readJson(path.join(controlPath, "summary.json")),
    readJson(path.join(treatmentPath, "summary.json")),
  ]);
  const [controlOfficial, treatmentOfficial, specReport] = await Promise.all([
    await exists(path.join(controlPath, "official_score", "summary.json")) ? readJson(path.join(controlPath, "official_score", "summary.json")) : undefined,
    await exists(path.join(treatmentPath, "official_score", "summary.json")) ? readJson(path.join(treatmentPath, "official_score", "summary.json")) : undefined,
    await exists(specReportPath) ? readJson(specReportPath) : undefined,
  ]);
  const controlIds = [...(controlManifest.instanceIds ?? [])].map(String).sort();
  const treatmentIds = [...(treatmentManifest.instanceIds ?? [])].map(String).sort();
  const semanticModes = new Set([semanticSpecMode(controlManifest), semanticSpecMode(treatmentManifest)]);
  const semanticSpecPair = semanticModes.size === 2 && semanticModes.has("required") && semanticModes.has("disabled");
  const databaseEvidenceComplete = !semanticSpecPair || (
    hasCompleteObservedDatabaseEvidence(controlManifest, controlIds)
    && hasCompleteObservedDatabaseEvidence(treatmentManifest, treatmentIds)
  );
  const sameExperimentalInputs = sameValue(withoutRunIdentity(controlManifest), withoutRunIdentity(treatmentManifest))
    && sameValue(controlIds, treatmentIds)
    && controlManifest.datasetSha256 === treatmentManifest.datasetSha256
    && databaseEvidenceComplete;
  const controlAssurance = controlManifest.assurance ?? controlManifest.assuranceObserver ?? {};
  const treatmentAssurance = treatmentManifest.assurance ?? treatmentManifest.assuranceObserver ?? {};
  const controlHooks = controlAssurance.hooks ?? {};
  const treatmentHooks = treatmentAssurance.hooks ?? {};
  const hookDifferences = [...new Set([...Object.keys(controlHooks), ...Object.keys(treatmentHooks)])].filter((key) => controlHooks[key] !== treatmentHooks[key]);
  const semanticSpecAblation = isSemanticSpecAblation(controlManifest, treatmentManifest, hookDifferences);
  const expectedFactorDifference = controlManifest.experimentId || treatmentManifest.experimentId
    ? semanticSpecAblation || (hookDifferences.length === 1 && hookDifferences[0] === "informOnUnresolvedHypotheses" && controlHooks.informOnUnresolvedHypotheses === false && treatmentHooks.informOnUnresolvedHypotheses === true)
    : controlAssurance.detectors?.enabled === false
      && treatmentAssurance.detectors?.enabled === true
      && controlAssurance.hooks?.interpretationsOnAnomaly === false
      && treatmentAssurance.hooks?.interpretationsOnAnomaly === true
      && controlAssurance.hooks?.integrityBlocks === treatmentAssurance.hooks?.integrityBlocks
      && controlAssurance.hooks?.terminateAfterExport === treatmentAssurance.hooks?.terminateAfterExport;
  const onlyExpectedDifferences = sameExperimentalInputs && expectedFactorDifference;
  const [controlTrace, treatmentTrace] = await Promise.all([
    traceMetrics(controlPath, controlIds, controlManifest.attemptPolicy?.selectedAttemptId),
    traceMetrics(treatmentPath, treatmentIds, treatmentManifest.attemptPolicy?.selectedAttemptId),
  ]);
  const controlMetrics = summaryMetrics(controlSummary, controlOfficial, controlTrace);
  const treatmentMetrics = summaryMetrics(treatmentSummary, treatmentOfficial, treatmentTrace);
  const controlAccuracy = controlMetrics.officialFixedDenominator?.score;
  const treatmentAccuracy = treatmentMetrics.officialFixedDenominator?.score;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    methodology: {
      offlineSpecReport: specReportPath,
      offlineSpecReportSha256: specReport ? sha256(await readFile(specReportPath)) : null,
      experimentalUnit: semanticSpecAblation
        ? "同一批 instance_id；control 与 treatment 使用同一模型、数据集、预算和评测器，仅切换 semanticSpecMode=disabled|required 及对应 begin_query_task/update_answer_spec 工具和系统提示"
        : "同一批 instance_id；control 与 treatment 使用同一模型、数据集、预算和评测器，仅切换预注册的 assurance hook",
      experimentFactor: semanticSpecAblation ? "semantic_spec_mode" : "assurance_hook",
      correctnessSource: "官方 exec_result fixedDenominator；未提交题目计入固定分母",
    },
    specQuality: specReport?.aggregate?.sevenFacetSlots
      ? { ...specReport.aggregate.sevenFacetSlots, outputColumns: specReport.aggregate.slots?.outputColumns ?? null }
      : null,
    arms: {
      control: { runPath: controlPath, manifestSha256: sha256(await readFile(path.join(controlPath, "manifest.json"))), metrics: controlMetrics },
      treatment: { runPath: treatmentPath, manifestSha256: sha256(await readFile(path.join(treatmentPath, "manifest.json"))), metrics: treatmentMetrics },
    },
    comparison: {
      sameExperimentalInputs,
      databaseEvidenceComplete,
      onlyExpectedDifferences,
      semanticSpecAblation,
      sameInstanceCount: controlIds.length === treatmentIds.length,
      csvCoverageNonDecreasing: Number(treatmentMetrics.csvCoverage ?? 0) >= Number(controlMetrics.csvCoverage ?? 0),
      accuracyNonDecreasing: controlAccuracy !== null && controlAccuracy !== undefined && treatmentAccuracy !== null && treatmentAccuracy !== undefined
        ? treatmentAccuracy >= controlAccuracy
        : null,
      routingEvidenceComplete: controlMetrics.trace.missingTraceFiles === 0 && treatmentMetrics.trace.missingTraceFiles === 0
        && controlMetrics.trace.unclassifiedQueries === 0 && treatmentMetrics.trace.unclassifiedQueries === 0,
      caseScoreDelta: compareCaseScores(caseScores(controlOfficial), caseScores(treatmentOfficial), [...new Set([...controlIds, ...treatmentIds])]),
    },
  };
  return { json: report, markdown: renderMarkdown(report) };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_m, letter) => letter.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) options[key] = true;
    else { options[key] = value; i += 1; }
  }
  return options;
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  const options = parseArgs(process.argv.slice(2));
  const control = path.resolve(options.control ?? DEFAULT_CONTROL);
  const treatment = path.resolve(options.treatment ?? DEFAULT_TREATMENT);
  const specReport = path.resolve(options.specReport ?? DEFAULT_SPEC_REPORT);
  const output = path.resolve(options.output ?? DEFAULT_OUTPUT);
  const markdown = path.resolve(options.markdown ?? DEFAULT_MARKDOWN);
  const result = await buildPhase5Report(control, treatment, specReport);
  await writeFile(output, `${JSON.stringify(result.json, null, 2)}\n`, "utf8");
  await writeFile(markdown, result.markdown, "utf8");
  console.log(JSON.stringify({ output, markdown, ...result.json.comparison }, null, 2));
}
