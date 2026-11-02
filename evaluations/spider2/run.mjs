#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  backendForCase,
  buildAgentPrompt,
  buildEvaluationLearning,
  buildEvaluationRules,
  classifyProviderFailure,
  createRecorder,
  ddlCsvToMarkdown,
  fixedDenominatorScore,
  loadCases,
  parseCorrectIdsCsv,
  parseOfficialCaseScores,
  parseOfficialScore,
  resolveExternalKnowledge,
  resolveLocalDatabase,
  resolveMetadataDirectory,
  runPromptWithTimeout,
  safeJson,
  selectCases,
  selectModelProfile,
  sha256File,
  sha256Tree,
  stopPositionOf,
  validateOfficialEvaluatorSource,
} from "./lib.mjs";
import { manifestFromExperiment, resolveExperiment, resolveSemanticSpecMode, validateExperimentConfig } from "./experiment.mjs";
import { buildEvaluationReport, loadEpisodeRecord, persistScoreRecord } from "./evaluation.mjs";
import { attemptDirectory, createAttemptDescriptor, createAttemptLayout, writeAttemptStatus } from "./episode.mjs";
import { openAttemptRecorder, publicationFromReceipt, spanIdForIdentity, summarizeUsage } from "./record.mjs";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const localConfigPath = path.join(here, "config.local.json");
const exampleConfigPath = path.join(here, "config.example.json");

process.on("unhandledRejection", (reason) => {
  if (
    reason?.name === "HarnessClosed" ||
    reason?.name === "Closed" ||
    reason?.message?.includes("AgentHarness was closed") ||
    reason?.message?.includes("HarnessClosed") ||
    reason?.message?.includes("transport closed")
  ) {
    return;
  }
  console.error("Unhandled rejection:", reason instanceof Error ? reason.stack ?? reason.message : String(reason));
});

function parseArgs(argv) {
  const [command = "preflight", ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`UNEXPECTED_ARGUMENT:${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { command, options };
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

async function loadEnvironmentFile(filePath) {
  if (!(await exists(filePath))) return;
  const content = await readFile(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function expandEnvironment(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item)]));
  return value;
}

async function loadConfig(explicitPath) {
  const selected = explicitPath
    ? path.resolve(explicitPath)
    : await exists(localConfigPath) ? localConfigPath : exampleConfigPath;
  const config = expandEnvironment(JSON.parse(await readFile(selected, "utf8")));
  config.__path = selected;
  config.spider2Repo = path.resolve(config.spider2Repo);
  config.runsRoot = path.resolve(config.runsRoot);
  config.spider2LiteRoot = path.resolve(config.spider2LiteRoot ?? path.join(config.spider2Repo, "spider2-lite"));
  config.datasetPath = path.join(config.spider2LiteRoot, "spider2-lite.jsonl");
  config.evaluationSuite = path.join(config.spider2LiteRoot, "evaluation_suite");
  config.limits = {
    timeoutMs: null,
    maxTurns: null,
    maxToolCalls: null,
    maxExploratoryQueries: null,
    ...(config.limits ?? {}),
  };
  config.concurrency = Math.max(1, Number(config.concurrency ?? 3));
  config.assurance = {
    mode: "off",
    reviewerModel: "none",
    reviewerPromptVersion: "5",
    reviewPolicyVersion: "2",
    reviewCoverageSchemaVersion: "4",
    planner: true,
    reviewer: { enabled: false },
    shadowDelivery: "publish_with_disagreement",
    hooks: {
      informOnQuery: true,
      informOnUnresolvedHypotheses: false,
      interpretationsOnAnomaly: true,
      integrityBlocks: true,
      terminateAfterExport: true,
    },
    detectors: {
      enabled: true,
      tierA: DEFAULT_TIER_A_DETECTORS,
      tierB: DEFAULT_TIER_B_DETECTORS,
      disabled: [],
    },
    interpretations: {
      triggerTiers: ["A"],
      maxCyclesPerTask: 1,
      minRemainingTurns: 6,
      minRemainingToolCalls: 10,
    },
    dirtyDataAction: "multi_candidate",
    delivery: "deliver_with_disclosure",
    includeResultRows: true,
    maxResultRows: 2000,
    maxResultBytes: 262144,
    maxNumericRows: 10000,
    ...(config.assurance ?? {}),
    // This prompt is defined in this runner/runtime version; callers cannot
    // relabel it as an older calibrated prompt.
    reviewerPromptVersion: "5",
  };
  validateExperimentConfig(config);
  return config;
}

const DEFAULT_TIER_A_DETECTORS = [];
const DEFAULT_TIER_B_DETECTORS = [];
const ASSURANCE_HOOK_NAMES = ["informOnQuery", "informOnUnresolvedHypotheses", "interpretationsOnAnomaly", "integrityBlocks", "terminateAfterExport"];

// These values are retained only as explicit offline-observer metadata. They
// never alter the Application Host or grant a Reviewer/Detector publish power.
function assuranceHookSwitches(config, options = {}) {
  const configured = config.assurance?.hooks ?? {};
  const switches = Object.fromEntries(ASSURANCE_HOOK_NAMES.map((name) => [name, configured[name] !== false]));
  if (options.disableHook !== undefined && Object.hasOwn(switches, options.disableHook)) switches[options.disableHook] = false;
  if (options.enableHook !== undefined && Object.hasOwn(switches, options.enableHook)) switches[options.enableHook] = true;
  return switches;
}

function detectorPolicyFromConfig(config) {
  const configured = config.assurance?.detectors ?? {};
  return {
    enabled: configured.enabled !== false,
    tierA: Array.isArray(configured.tierA) ? configured.tierA.map(String) : DEFAULT_TIER_A_DETECTORS,
    tierB: Array.isArray(configured.tierB) ? configured.tierB.map(String) : DEFAULT_TIER_B_DETECTORS,
    disabled: Array.isArray(configured.disabled) ? configured.disabled.map(String) : [],
  };
}

function interpretationPolicyFromConfig(config) {
  const configured = config.assurance?.interpretations ?? {};
  return {
    triggerTiers: Array.isArray(configured.triggerTiers) ? configured.triggerTiers : [],
    maxCyclesPerTask: 0,
    minRemainingTurns: 0,
    minRemainingToolCalls: 0,
    dirtyDataAction: "offline_observer",
  };
}

function profileFromConfig(config) {
  const llm = config.llm ?? {};
  const apiKey = llm.apiKey ?? (llm.apiKeyEnv ? process.env[llm.apiKeyEnv] : undefined);
  const baseUrl = llm.baseUrl ?? (llm.baseUrlEnv ? process.env[llm.baseUrlEnv] : undefined);
  return {
    provider: llm.provider ?? "openai",
    model: llm.model,
    apiKey,
    baseUrl,
    apiFormat: llm.apiFormat ?? "chat",
    reasoning: llm.reasoning,
    maxTokens: llm.maxTokens,
    thinkingLevel: llm.thinkingLevel,
    thinkingLevelMap: llm.thinkingLevelMap,
    contextWindow: llm.contextWindow,
  };
}

async function runModelCanary(config) {
  const profile = profileFromConfig(config);
  if (!["openai", "openrouter", "deepseek"].includes(profile.provider) || !profile.baseUrl || (profile.apiFormat && profile.apiFormat !== "chat")) {
    throw new Error("MODEL_CANARY_REQUIRES_OPENAI_COMPATIBLE_CHAT_API");
  }
  const startedAt = Date.now();
  const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`PROVIDER_CANARY_FAILED:network:${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`PROVIDER_CANARY_FAILED:${response.status}:${body.slice(0, 500)}`);
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { throw new Error("PROVIDER_CANARY_FAILED:invalid_json"); }
  if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) throw new Error("PROVIDER_CANARY_FAILED:no_choices");
  const result = {
    ok: true,
    provider: profile.provider,
    model: profile.model,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
  const target = path.join(config.runsRoot, "_preflight", "model-canary.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(result, null, 2), "utf8");
  return result;
}

function substitute(value, context) {
  if (typeof value !== "string") return value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => context[name] ?? `{${name}}`);
}

async function backendExecutor(instance, config, createMcpQueryExecutor) {
  const backend = backendForCase(instance);
  if (backend === "sqlite") {
    const databasePath = await resolveLocalDatabase(config, config.spider2LiteRoot, instance);
    return {
      executor: createMcpQueryExecutor({
        command: process.execPath,
        args: [path.join(projectRoot, "apps", "server", "dist", "reference-sqlite-mcp.js"), databasePath],
        dialect: "sqlite",
        requestTimeoutMs: Number(config.limits?.mcpRequestTimeoutMs ?? 60_000),
        scopedExploration: { scopeId: `eval-${instance.instance_id}`, connectionId: `sqlite-${instance.instance_id}` },
      }),
      databasePath,
    };
  }
  const mcp = config.backends?.[backend]?.mcp;
  if (!mcp?.command) throw new Error(`BACKEND_MCP_NOT_CONFIGURED:${backend}`);
  const context = {
    db: instance.db,
    instance_id: instance.instance_id,
    spider2Repo: config.spider2Repo,
    spider2LiteRoot: config.spider2LiteRoot,
  };
  return {
    executor: createMcpQueryExecutor({
      command: substitute(mcp.command, context),
      args: (mcp.args ?? []).map((item) => substitute(item, context)),
      env: Object.fromEntries(Object.entries(mcp.env ?? {}).map(([key, value]) => [key, substitute(value, context)])),
      dialect: backend,
      connectionId: instance.instance_id,
    }),
  };
}

function withKnowledgeMetadata(content, metadata) {
  const source = String(content ?? "").replace(/^\uFEFF/, "");
  if (/^---\s*\r?\nknowledgeId:\s*/.test(source)) return source;
  return [
    "---",
    `knowledgeId: ${metadata.knowledgeId}`,
    `name: ${metadata.name}`,
    `description: ${metadata.description}`,
    ...(metadata.usage ? [`usage: ${metadata.usage}`] : []),
    "---",
    "",
    source.replace(/^\s+/, ""),
  ].join("\n");
}

async function prepareKnowledge(instance, config, caseRoot, KnowledgeIndex, WorkspaceStore) {
  const knowledgeRoot = path.join(caseRoot, "knowledge");
  const knowledgeDoc = path.join(knowledgeRoot, "doc");
  const workspaceRoot = path.join(caseRoot, "workspace");
  const workspaceDocs = path.join(workspaceRoot, "docs");
  await Promise.all([mkdir(knowledgeDoc, { recursive: true }), mkdir(workspaceDocs, { recursive: true })]);
  // Built-in method guides only; the repository knowledge/ holds production-specific documents.
  const [baseRules, baseSemanticGuide] = await Promise.all([
    readFile(path.join(projectRoot, ".agents", "knowledge", "doc", "rules.md"), "utf8").catch(() => ""),
    readFile(path.join(projectRoot, ".agents", "knowledge", "doc", "semantic_guide.md"), "utf8").catch(() => ""),
  ]);

  const metadataDir = await resolveMetadataDirectory(config.spider2LiteRoot, instance);
  const ddlPath = path.join(metadataDir, "DDL.csv");
  if (!(await exists(ddlPath))) throw new Error(`DDL_NOT_FOUND:${ddlPath}`);
  const schemaMarkdown = ddlCsvToMarkdown(await readFile(ddlPath, "utf8"), instance.db);
  await Promise.all([
    writeFile(path.join(knowledgeDoc, "db_schema.md"), withKnowledgeMetadata(schemaMarkdown, { knowledgeId: "database-schema", name: "数据库结构", description: "提供表、列、类型及正式结构信息，用于物理映射；字段存在不自动证明业务含义。" }), "utf8"),
    copyFile(ddlPath, path.join(workspaceDocs, "DDL.csv")),
  ]);

  const externalFiles = await resolveExternalKnowledge(config.spider2LiteRoot, instance);
  const businessSections = [`# External Knowledge for ${instance.instance_id}`];
  if (externalFiles.length === 0) businessSections.push("", "No task-specific external knowledge was supplied by Spider2.");
  await mkdir(path.join(workspaceDocs, "external"), { recursive: true });
  for (const source of externalFiles) {
    const name = path.basename(source);
    const content = await readFile(source, "utf8");
    businessSections.push("", `## ${name}`, "", content);
    await copyFile(source, path.join(workspaceDocs, "external", name));
  }
  await writeFile(path.join(knowledgeDoc, "business.md"), withKnowledgeMetadata(businessSections.join("\n"), { knowledgeId: "business-definitions", name: "业务定义", description: "提供业务指标、枚举、阈值和已知业务约束；内容未明确时不得用通用经验补造业务定义。" }), "utf8");
  await writeFile(path.join(knowledgeDoc, "semantic_guide.md"), withKnowledgeMetadata(baseSemanticGuide || "# Semantic Guide\n\nNo semantic guide is configured.\n", { knowledgeId: "semantic-guide", usage: "method", name: "数据分析语义理解指引", description: "用于拆解问题、建立七槽位，并按专题处理总体、连接权重、多级聚合、时间、排名、事件序列和状态歧义；不提供具体业务枚举。" }), "utf8");
  await writeFile(path.join(knowledgeDoc, "rules.md"), withKnowledgeMetadata(buildEvaluationRules(baseRules, instance), { knowledgeId: "sql-rules", usage: "method", name: "SQL 生成规范", description: "用于把当前 Answer Spec 实现为安全、符合目标方言的 SQL，包括聚合、精度、NULL 和方言规则；不负责决定业务口径。" }), "utf8");
  await writeFile(path.join(knowledgeDoc, "query_patterns.md"), withKnowledgeMetadata("# Verified Query Patterns\n\nNo benchmark-specific query patterns are provided.\n", { knowledgeId: "query-patterns", name: "已验证查询模版", description: "提供可复用的查询结构和适用前提；只有当前口径与前提匹配时才能复用。" }), "utf8");
  await writeFile(path.join(knowledgeDoc, "learning.md"), withKnowledgeMetadata(buildEvaluationLearning(""), { knowledgeId: "learning-notes", usage: "method", name: "历史纠错与经验", description: "提供历史错误、方言陷阱和可复用经验；证据等级低于用户、业务定义和正式 Schema。" }), "utf8");

  const knowledge = new KnowledgeIndex({ requireMetadata: true });
  await knowledge.loadDirectory(knowledgeRoot);
  return {
    knowledge,
    knowledgeRoot,
    workspace: new WorkspaceStore(workspaceRoot),
    workspaceRoot,
    metadataDir,
    externalFiles,
  };
}


function authorizedDeliveryFromCalls(calls) {
  for (const call of [...(calls ?? [])].reverse()) {
    if (call.isError || !["export_query", "publish_query_result", "query_database"].includes(call.toolName)) continue;
    const details = call.result?.details ?? {};
    const receipt = details.receiptId && details.candidateId ? details : details.publicationReceipt;
    if (!receipt?.receiptId || !receipt.candidateId) continue;
    const handle = call.args?.candidateId ?? call.args?.queryArtifactId ?? details.queryArtifactId ?? receipt.candidateId ?? receipt.queryArtifactId;
    const mixedHandles = call.args?.candidateId !== undefined && call.args?.queryArtifactId !== undefined;
    if (mixedHandles || !handle || handle !== (receipt.candidateId ?? receipt.queryArtifactId ?? details.queryArtifactId)) continue;
    if (call.toolName === "query_database" && call.args?.deliverIfEligible !== true && call.args?.mode !== "result") continue;
    return { call, receipt, candidateId: handle };
  }
  return undefined;
}

async function collectArtifacts(instance, attemptRoot, adapter, recorder) {
  const delivery = authorizedDeliveryFromCalls(recorder.calls);
  const sqlDir = path.join(attemptRoot, "submissions", "sql");
  const csvDir = path.join(attemptRoot, "submissions", "csv");
  await Promise.all([mkdir(sqlDir, { recursive: true }), mkdir(csvDir, { recursive: true })]);

  let finalSql;
  let finalCsv;
  let csvError;
  const receipt = delivery?.receipt;
  if (delivery) {
    try {
      if (!receipt?.receiptId) throw new Error("PUBLICATION_RECEIPT_MISSING");
      const authorizedSql = await adapter.readPublicationSql(receipt.receiptId);
      finalSql = { sql: authorizedSql.sql, toolCallId: delivery.call.toolCallId, toolName: delivery.call.toolName, queryArtifactId: delivery.candidateId, queryHash: authorizedSql.queryHash };
      await writeFile(path.join(sqlDir, `${instance.instance_id}.sql`), `${authorizedSql.sql}\n`, "utf8");
      const authorized = await adapter.readPublication(receipt.receiptId);
      if (authorized.summary.format !== "csv") throw new Error(`PUBLISHED_FORMAT_NOT_CSV:${authorized.summary.format}`);
      if (!authorized.content.length) throw new Error("CSV_EMPTY_FILE");
      finalCsv = path.join(csvDir, `${instance.instance_id}.csv`);
      await writeFile(finalCsv, authorized.content, "utf8");
    } catch (caught) {
      // Delivery read failure is separate from the fact that a Receipt exists.
      csvError = caught instanceof Error ? caught.message : String(caught);
    }
  }
  return { finalSql, finalCsv, csvError, receipt };
}

async function evaluationSystemPrompt(config) {
  const semanticSpecMode = resolveSemanticSpecMode(config);
  const noClarification = config.enableClarificationTool === false
    ? "\n\nHeadless evaluation: ask_user_clarification is unavailable. Do not call it or substitute another user-input tool. Use available task evidence; if a material ambiguity remains unresolved, explain the limitation rather than inventing a business rule or result.\n"
    : "";
  if (semanticSpecMode === "disabled") {
    return `${await readFile(path.join(here, "prompts", "semantic-spec-disabled.md"), "utf8")}${noClarification}`;
  }
  const source = await readFile(path.join(projectRoot, ".pi", "SYSTEM.md"), "utf8");
  if (config.assurance?.fewshot !== false) return `${source}${noClarification}`;
  const supportedSections = [
    { start: "\n### 1.5 口径推导示范", end: "\n---\n\n## 2. 输出与交付" },
    { start: "\n#### 口径推导与 SQL 示例", end: "\n---\n\n### 4. 预览结果并导出" },
  ];
  for (const boundary of supportedSections) {
    const sectionStart = source.indexOf(boundary.start);
    const sectionEnd = source.indexOf(boundary.end, sectionStart);
    if (sectionStart >= 0 && sectionEnd >= 0) return `${source.slice(0, sectionStart)}${source.slice(sectionEnd)}${noClarification}`;
  }
  throw new Error("FEWSHOT_SECTION_BOUNDARY_NOT_FOUND");
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorCodeFromToolCall(call) {
  const details = call?.result?.details && typeof call.result.details === "object" ? call.result.details : {};
  const content = Array.isArray(call?.result?.content)
    ? call.result.content.filter((item) => item && typeof item.text === "string").map((item) => item.text).join("\\n")
    : "";
  const text = [details.reason, details.error, details.code, call?.result?.error, content].filter((value) => typeof value === "string").join(" ");
  const match = text.match(/\b(?:INTEGRITY_[A-Z0-9_]+|SHAPE_ZERO_SCORE|[A-Z][A-Z0-9_]{2,})\b/);
  return match?.[0] ?? "UNKNOWN";
}

function publicationStatusFor(recorder, status) {
  const receiptStatus = recorder?.calls.map((call) => {
    const details = call.result?.details ?? {};
    const receipt = details.receiptId && details.candidateId ? details : details.publicationReceipt;
    return receipt?.status;
  }).filter(Boolean).at(-1);
  if (receiptStatus) return receiptStatus;
  const currentReceipt = recorder?.calls.some((call) => {
    const details = call.result?.details ?? {};
    return (details.receiptId && details.candidateId) || details.publicationReceipt?.receiptId;
  });
  if (currentReceipt) return "published";
  if (status === "provider_error" || recorder?.providerFailure) return "not_published_provider_error";
  const publicationCalls = recorder?.calls.filter((call) => call.toolName === "export_query" || call.toolName === "publish_query_result") ?? [];
  if (publicationCalls.length === 0) return "not_published_no_export_call";
  const last = publicationCalls.at(-1);
  const code = errorCodeFromToolCall(last);
  if (/^(?:INTEGRITY_[A-Z0-9_]+|SHAPE_ZERO_SCORE)$/.test(code)) return `not_published_integrity:${code}`;
  return `not_published_export_failed:${code}`;
}

function nativeEventFromObservation(observation) {
  const event = observation?.event;
  if (!event || typeof event.type !== "string") return undefined;
  if (event.type === "run_start") return { type: "agent_start", runId: event.runId };
  if (event.type === "message_start") return { type: "message_start", runId: event.runId, message: event.message };
  if (event.type === "message_update") return { type: "message_update", runId: event.runId, assistantMessageEvent: event.event };
  if (event.type === "message_end") return { type: "message_end", runId: event.runId, message: event.message };
  if (event.type === "tool_start") return { type: "tool_execution_start", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
  if (event.type === "tool_update") return { type: "tool_execution_update", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult };
  if (event.type === "tool_end") return { type: "tool_execution_end", runId: event.runId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError === true };
  if (event.type === "run_end" && event.status === "failed") return { type: "message_end", runId: event.runId, message: { role: "assistant", stopReason: "error", errorMessage: event.error?.message ?? "Pi operation failed" } };
  if (event.type === "run_end") return { type: "agent_end", runId: event.runId, messages: [] };
  return undefined;
}

async function waitForApplicationOperation(adapter, operationId, maxWaitMs = Infinity) {
  const startedAt = Date.now();
  while (true) {
    const snapshot = await adapter.getExecutionSnapshot?.();
    if (snapshot?.lastResult?.operationId === operationId) return snapshot;
    const open = await adapter.getOpenOperations();
    if (!open.some((operation) => operation.operationId === operationId)) return snapshot;
    if (Date.now() - startedAt >= maxWaitMs) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function requireKnownOperationTerminal(snapshot, operationId) {
  if (snapshot?.lastResult?.operationId !== operationId) {
    const error = new Error("OPERATION_TERMINAL_UNKNOWN");
    error.name = "OperationTerminalUnknownError";
    throw error;
  }
  if (["failed", "error"].includes(snapshot.lastResult.status)) {
    const error = new Error(snapshot.lastResult.error?.message ?? "Pi operation failed");
    error.name = "PiOperationError";
    error.nativeStatus = snapshot.lastResult.status;
    error.nativeError = snapshot.lastResult.error;
    throw error;
  }
  return snapshot;
}

function fanoutMetrics(calls) {
  const reports = calls.flatMap((call) => {
    const details = call.result?.details;
    const report = details && typeof details === "object" && details.fanout && typeof details.fanout === "object" ? details.fanout : undefined;
    return report ? [report] : [];
  });
  const unique = [];
  const seen = new Set();
  for (const report of reports) {
    const key = JSON.stringify(report);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(report);
  }
  const targets = unique.flatMap((report) => Array.isArray(report.targets) ? report.targets : []);
  const findings = targets.filter((target) => target?.status === "finding");
  const unknown = targets.filter((target) => target?.status === "unknown");
  const byStatus = Object.fromEntries(["clear", "finding", "not_applicable", "unknown"].map((status) => [status, unique.filter((report) => report.status === status).length]));
  return {
    reports: unique,
    reportCount: unique.length,
    targetCount: targets.length,
    findingCount: findings.length,
    unknownCount: unknown.length,
    byStatus,
    enabled: unique.length > 0,
  };
}

async function recordInternalCallSpans(attemptRecorder, call, index, traceId, toolSpanId) {
  const callId = call.toolCallId ?? `tool-${index + 1}`;
  const finishedAt = call.finishedAt ?? call.startedAt;
  if (call.toolName === "query_database") {
    const queryKind = call.args?.kind ?? call.args?.mode;
    await attemptRecorder.recordEvent({
      eventId: `${callId}:database`,
      type: queryKind === "result" ? "db.result_query" : "db.exploration_query",
      occurredAt: finishedAt,
      traceId,
      parentSpanId: toolSpanId,
      payload: { invocationId: `${callId}:database`, startedAt: call.startedAt, endedAt: finishedAt, status: call.isError ? "failed" : "completed", isError: call.isError },
    });
  }
  const fanout = call.result?.details?.fanout;
  if (!fanout || typeof fanout !== "object") return;
  const fanoutIdentity = `${callId}:fanout`;
  const fanoutSpanId = spanIdForIdentity(traceId, `fanout:${fanoutIdentity}`);
  await attemptRecorder.recordEvent({
    eventId: fanoutIdentity,
    type: "answering.fanout",
    occurredAt: finishedAt,
    traceId,
    parentSpanId: toolSpanId,
    payload: { invocationId: fanoutIdentity, endedAt: finishedAt, status: fanout.status === "unknown" ? "unknown" : "completed" },
  });
  for (const [targetIndex, target] of (Array.isArray(fanout.targets) ? fanout.targets : []).entries()) {
    const targetIdentity = `${fanoutIdentity}:probe:${target.targetId ?? targetIndex + 1}`;
    await attemptRecorder.recordEvent({
      eventId: targetIdentity,
      type: "db.probe",
      occurredAt: finishedAt,
      traceId,
      parentSpanId: fanoutSpanId,
      payload: { invocationId: targetIdentity, targetId: target.targetId, endedAt: finishedAt, status: target.status === "unknown" ? "unknown" : "completed" },
    });
  }
}

function knowledgeMetrics(calls, startedAt) {
  const knowledgeCalls = calls.filter((call) => call.toolName === "search_knowledge" || call.toolName === "read_knowledge");
  const contentRefs = knowledgeCalls.flatMap((call) => {
    const details = call.result?.details;
    if (call.toolName === "search_knowledge" && Array.isArray(details?.hits)) {
      return details.hits.map((hit) => hit?.contentRef).filter((value) => typeof value === "string");
    }
    return typeof details?.contentRef === "string" ? [details.contentRef] : [];
  });
  const firstSql = calls.find((call) => call.toolName === "query_database");
  return {
    searchCalls: knowledgeCalls.filter((call) => call.toolName === "search_knowledge").length,
    readCalls: knowledgeCalls.filter((call) => call.toolName === "read_knowledge").length,
    returnedContentRefs: contentRefs.length,
    duplicateContentRefs: contentRefs.length - new Set(contentRefs).size,
    toolDurationMs: knowledgeCalls.reduce((sum, call) => sum + Number(call.durationMs ?? 0), 0),
    firstSqlAfterMs: firstSql?.startedAt ? Math.max(0, firstSql.startedAt - startedAt) : null,
  };
}

async function createCaseRunner(config, runDir, systemPrompt, attemptId = "attempt-001", experimentId = "legacy", attemptMode = "run", queryBudgetPolicy, retryOfAttemptId, fanoutEnabled = true, semanticSpecMode = "required") {
  const protocol = await import("@data-agent/runtime/testing");
  const { createMcpQueryExecutor } = await import("../../packages/database/dist/mcp-query-executor.js");
  const profile = profileFromConfig(config);
  return async (instance) => {
    const startedAt = Date.now();
    const legacyCaseRoot = path.join(runDir, "cases", instance.instance_id);
    const caseRoot = attemptDirectory(runDir, instance.instance_id, attemptId);
    await Promise.all([mkdir(legacyCaseRoot, { recursive: true }), mkdir(caseRoot, { recursive: true })]);
    let executor;
    let application;
    let adapter;
    let stopObservations;
    let attemptRecorder;
    let attemptLayout;
    // Streaming observations carry the partial message so far; retaining all of them grows
    // quadratically with reply length. Keep only the count and the run_end facts we read.
    const nativeObservations = {
      count: 0,
      types: [],
      lastRunEnd: undefined,
      lastFailedRunEnd: undefined,
      push(observation) {
        this.count += 1;
        if (observation?.event?.type) this.types.push(observation.event.type);
        if (observation?.event?.type !== "run_end") return;
        this.lastRunEnd = observation;
        if (observation.event?.status === "failed") this.lastFailedRunEnd = observation;
      },
    };
    const jevObservations = [];
    let activeTools = [];
    let databaseIdentity = { state: "unknown", backend: backendForCase(instance) };
    let harness;
    let recorder;
    let prepared;
    let status = "completed";
    let error;
    let artifacts = {};
    const cleanupErrors = [];
    try {
      attemptLayout = await createAttemptLayout(runDir, createAttemptDescriptor({
        runId: path.basename(runDir),
        caseId: instance.instance_id,
        attemptId,
        experimentId,
        traceId: `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`,
        mode: attemptMode,
        inputIdentity: { experimentId, caseId: instance.instance_id },
        budgetSnapshot: queryBudgetPolicy ?? null,
        ...(attemptMode === "retry" && retryOfAttemptId ? { retryOf: retryOfAttemptId } : {}),
        ...(attemptMode === "continue" && retryOfAttemptId ? { continuesFrom: retryOfAttemptId } : {}),
      }));
      prepared = await prepareKnowledge(instance, config, caseRoot, protocol.KnowledgeIndex, protocol.WorkspaceStore);
      const backend = await backendExecutor(instance, config, createMcpQueryExecutor);
      executor = backend.executor;
      databaseIdentity = backend.databasePath
        ? { state: "known", backend: backendForCase(instance), path: backend.databasePath, sha256: await sha256File(backend.databasePath) }
        : { state: "unknown", backend: backendForCase(instance), reason: "external_backend_snapshot_not_exposed" };
      const sessionId = `${path.basename(runDir)}-${instance.instance_id}-${attemptId}`;
      const hypothesisChoiceAdvisor = process.env.TYPESAFE_API_KEY?.trim() && protocol.JevHypothesisChoiceAdvisor
        ? new protocol.JevHypothesisChoiceAdvisor({
            apiKey: process.env.TYPESAFE_API_KEY.trim(),
            model: process.env.TYPESAFE_MODEL?.trim() || "jev-1.13.0",
            ...(process.env.TYPESAFE_ENDPOINT?.trim() ? { endpoint: process.env.TYPESAFE_ENDPOINT.trim() } : {}),
            onObservation: (observation) => jevObservations.push(observation),
          })
        : undefined;
      application = new protocol.DataAgentSessionApplication({
        sessionRoot: path.join(caseRoot, "session"),
        workspace: prepared.workspace,
        knowledge: prepared.knowledge,
        knowledgeRoot: prepared.knowledgeRoot,
        pythonExecutable: config.pythonExecutable,
        queryExecutor: executor,
        resultRoot: path.join(caseRoot, "results"),
        profile,
        ...(hypothesisChoiceAdvisor ? { hypothesisChoiceAdvisor } : {}),
        ...(queryBudgetPolicy ? { answeringBudgetPolicy: queryBudgetPolicy } : {}),
        semanticSpecMode,
        enableClarificationTool: config.enableClarificationTool !== false,
        answeringFanout: { enabled: fanoutEnabled },
        // Spider2 external knowledge is task-supplied, not a reviewed business definition.
        answeringEvidenceDocuments: { "business-definitions": "task_document" },
        systemPrompt,
        systemPromptRoots: [prepared.knowledgeRoot, projectRoot],
        projectRoot,
        // Product Skills plus evaluation-only protocol Skills; requires-tools keeps each arm's protocol Skill exclusive.
        skillRoots: [path.join(projectRoot, ".agents", "skills"), path.join(here, "skills")],
        createMissingSessions: true,
        enableWidgets: config.enableWidgets === true,
        enableDashboards: config.enableDashboards === true,
        enableSubagents: config.enableSubagents !== false,
        delegationRoot: path.join(caseRoot, "subagents"),
        delegationKnowledgePaths: [
          "doc/business.md",
          "doc/db_schema.md",
          "doc/learning.md",
          "doc/query_patterns.md",
          "doc/rules.md",
          "doc/semantic_guide.md",
        ],
      });
      adapter = application.createAgentAdapter({ userId: "evaluation", host: "web", sessionId });
      activeTools = [...await adapter.getActiveTools()];
      stopObservations = adapter.subscribeObservations((observation) => {
        nativeObservations.push(observation);
      }, { userId: "evaluation", sessionId });
      attemptRecorder = await openAttemptRecorder(adapter, path.join(caseRoot, "record"), {
        runId: path.basename(runDir),
        caseId: instance.instance_id,
        attemptId,
        traceId: `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`,
      });
      let currentOperationId;
      harness = {
        subscribe(listener) {
          return adapter.subscribeObservations((observation) => {
            const nativeEvent = nativeEventFromObservation(observation);
            if (nativeEvent) listener(nativeEvent);
          }, { userId: "evaluation", sessionId });
        },
        async prompt(text) {
          const accepted = await adapter.prompt(text, { sessionId, userId: "evaluation", requestId: sessionId + ":prompt" });
          currentOperationId = accepted.operationId;
          const snapshot = await waitForApplicationOperation(adapter, accepted.operationId);
          requireKnownOperationTerminal(snapshot, accepted.operationId);
          return accepted;
        },
        async abort() {
          if (currentOperationId) await adapter.requestAbort(currentOperationId, { sessionId, userId: "evaluation" });
          else await adapter.abort({ sessionId, userId: "evaluation" });
        },
        async waitForIdle(maxWaitMs = 15000) {
          if (currentOperationId) await waitForApplicationOperation(adapter, currentOperationId, maxWaitMs);
        },
      };
      recorder = createRecorder(harness, config.limits);
      if (attemptMode === "continue") {
        const snapshot = await adapter.getExecutionSnapshot({ userId: "evaluation", sessionId });
        const open = await adapter.getOpenOperations({ userId: "evaluation", sessionId });
        if (open.length === 0 && snapshot?.lastResult?.operationId !== currentOperationId) {
          if (snapshot?.lastResult?.operationId) currentOperationId = snapshot.lastResult.operationId;
          else throw new Error("CONTINUE_OPERATION_NOT_OPEN");
        }
        currentOperationId = open[0]?.operationId ?? snapshot?.lastResult?.operationId ?? currentOperationId;
        if (!currentOperationId) throw new Error("CONTINUE_OPERATION_ID_REQUIRED");
        const continued = await waitForApplicationOperation(adapter, currentOperationId, config.limits.timeoutMs ?? Infinity);
        requireKnownOperationTerminal(continued, currentOperationId);
      } else {
        await runPromptWithTimeout(harness, buildAgentPrompt(instance), config.limits.timeoutMs, recorder);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const limitFailure = Boolean(recorder?.limitError) || message === "MAX_TURNS" || message === "MAX_TOOL_CALLS" || message === "TASK_TIMEOUT";
      const providerFailure = limitFailure ? undefined : caught?.providerFailure ?? recorder?.providerFailure ?? classifyProviderFailure(message);
      error = caught instanceof Error ? { name: caught.name, message, stack: caught.stack } : { message };
      if (providerFailure) error.provider = providerFailure;
      status = providerFailure ? "provider_error"
        : error.message === "TASK_TIMEOUT" ? "timeout"
          : error.message === "OPERATION_TERMINAL_UNKNOWN" ? "unknown"
            : error.message?.startsWith("LOCAL_DATABASE_NOT_FOUND") || error.message?.startsWith("METADATA_DIR_NOT_FOUND") || error.message?.startsWith("DDL_NOT_FOUND") || error.message?.includes("EXTERNAL_KNOWLEDGE")
              ? "resource_error" : "error";
      const nativeFailure = nativeObservations.lastFailedRunEnd;
      if (!limitFailure && nativeFailure && status === "completed") {
        status = "error";
        error ??= { name: "PiOperationError", message: nativeFailure.event?.error?.message ?? "Pi operation failed" };
      }
      if (recorder && status === "error" && recorder.terminalReason !== "completed") status = recorder.terminalReason;
    } finally {
      await recorder?.waitForAbort?.().catch(() => undefined);
      await harness?.waitForIdle?.().catch(() => undefined);
      if (prepared && recorder && adapter) artifacts = await collectArtifacts(instance, caseRoot, adapter, recorder).catch((caught) => ({ ...artifacts, csvError: caught instanceof Error ? caught.message : String(caught) }));
      await attemptRecorder?.flush?.();
      stopObservations?.();
      recorder?.unsubscribe();
      try { await application?.close(); } catch (caught) { cleanupErrors.push(caught instanceof Error ? { name: caught.name, message: caught.message } : { message: String(caught) }); }
      try { await executor?.close(); } catch (caught) { cleanupErrors.push(caught instanceof Error ? { name: caught.name, message: caught.message } : { message: String(caught) }); }
    }
    const nativeFailure = nativeObservations.lastFailedRunEnd;
    if (nativeFailure && status === "completed") {
      const nativeMessage = nativeFailure.event?.error?.message ?? "Pi operation failed";
      const nativeProviderFailure = classifyProviderFailure(nativeMessage);
      status = nativeProviderFailure ? "provider_error" : "error";
      error ??= { name: nativeProviderFailure ? "ProviderError" : "PiOperationError", message: nativeMessage };
      if (nativeProviderFailure) error.provider = nativeProviderFailure;
    }
    if (recorder?.infraFailure) {
      status = "infra_error";
      error = { name: "InfrastructureError", message: recorder.infraFailure };
    }
    const limitTerminated = Boolean(recorder?.limitError) || ["timeout", "max_turns", "max_tool_calls"].includes(status);
    if (recorder?.providerFailure && !artifacts.finalCsv && !limitTerminated && status === "completed") {
      const failure = recorder.providerFailure;
      error ??= { name: "ProviderError", message: failure.message };
      error.provider ??= failure;
      status = "provider_error";
    }
    const recordedKnowledgeMetrics = knowledgeMetrics(recorder?.calls ?? [], startedAt);
    const recordedFanoutMetrics = fanoutMetrics(recorder?.calls ?? []);
    const result = {
      instanceId: instance.instance_id,
      db: instance.db,
      backend: backendForCase(instance),
      status,
      stopPosition: stopPositionOf(recorder?.calls ?? []),
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      turns: recorder?.turnCount ?? 0,
      toolCalls: recorder?.calls.length ?? 0,
      toolErrors: recorder?.calls.filter((call) => call.isError).length ?? 0,
      knowledgeMetrics: recordedKnowledgeMetrics,
      finalSql: artifacts.finalSql ?? null,
      csvGenerated: Boolean(artifacts.finalCsv),
      csvError: artifacts.csvError ?? null,
      error: error ?? null,
      ...(attemptRecorder?.persistenceError ? { recordIncomplete: true, recordPersistenceError: attemptRecorder.persistenceError } : {}),
      semanticSpecMode,
      assuranceMode: "answering-fanout",
      assuranceManifest: { mode: "answering-fanout", policyVersion: "answering-publication-v1", reviewerOnline: false, detectorsOnline: recordedFanoutMetrics.enabled, fanoutRuleVersion: "answering-fanout-v1" },
      publicationStatus: publicationStatusFor(recorder, status),
      assuranceAuditRecords: [],
      anomalies: recordedFanoutMetrics.findingCount > 0 ? recordedFanoutMetrics.reports.flatMap((report) => (report.targets ?? []).filter((target) => target.status === "finding").map((target) => ({ detector: "join_fanout", status: "observed", targetId: target.targetId, sourceRelation: target.sourceRelation, sourceKey: target.sourceKey, observation: target.observation }))) : [],
      fanoutMetrics: recordedFanoutMetrics,
      anomalyMetrics: { total: recordedFanoutMetrics.findingCount, byDetector: recordedFanoutMetrics.findingCount > 0 ? { join_fanout: recordedFanoutMetrics.findingCount } : {}, distinctFingerprintsBySlot: {}, interpretationHookCount: 0, unresolvedHypothesisHookCount: 0, unresolvedHypothesisIds: [], interpretationBudgetSkipCount: 0, detectorTiers: { tierA: ["join_fanout"], tierB: [], disabled: [], enabled: recordedFanoutMetrics.enabled } },
      nativeObservationCount: nativeObservations.count,
      activeTools,
      databaseIdentity,
      jevObservationCount: jevObservations.length,
      ...(cleanupErrors.length ? { cleanupErrors, cleanupFailed: true } : {}),
      nativeTerminalStatus: nativeObservations.lastRunEnd?.event?.status ?? "unknown",
    };
    if (attemptRecorder) {
      for (const [index, call] of (recorder?.calls ?? []).entries()) {
        await attemptRecorder.recordEvent({
          eventId: `${call.toolCallId ?? `tool-${index + 1}`}:start`,
          type: "tool_start",
          occurredAt: call.startedAt,
          traceId: `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`,
          payload: { toolCallId: call.toolCallId ?? `tool-${index + 1}`, toolName: call.toolName, args: call.args },
        });
        if (call.finishedAt !== undefined) await attemptRecorder.recordEvent({
          eventId: `${call.toolCallId ?? `tool-${index + 1}`}:end`,
          type: "tool_end",
          occurredAt: call.finishedAt,
          traceId: `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`,
          payload: { toolCallId: call.toolCallId ?? `tool-${index + 1}`, toolName: call.toolName, isError: call.isError, result: call.result },
        });
        const traceId = `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`;
        const toolSpanId = spanIdForIdentity(traceId, `tool:${call.toolCallId ?? `tool-${index + 1}`}`);
        await recordInternalCallSpans(attemptRecorder, call, index, traceId, toolSpanId);
        const childOutcomes = call.toolName === "subagent" && Array.isArray(call.result?.details) ? call.result.details : [];
        for (const outcome of childOutcomes) {
          if (!outcome?.runId) continue;
          const parentSpanId = toolSpanId;
          await attemptRecorder.recordEvent({
            eventId: `${outcome.runId}:start`,
            type: "child_operation_start",
            occurredAt: call.startedAt,
            traceId,
            parentSpanId,
            payload: { runId: outcome.runId, key: outcome.key, operationId: outcome.operationId, status: "running" },
          });
          await attemptRecorder.recordEvent({
            eventId: `${outcome.runId}:end`,
            type: "child_operation_end",
            occurredAt: call.finishedAt ?? call.startedAt,
            traceId,
            parentSpanId,
            payload: { runId: outcome.runId, key: outcome.key, operationId: outcome.operationId, status: outcome.status, usage: outcome.usage },
          });
        }
      }
      const traceId = `${path.basename(runDir)}:${instance.instance_id}:${attemptId}`;
      for (const [index, observation] of jevObservations.entries()) {
        await attemptRecorder.recordEvent({
          eventId: `jev-${index + 1}-${observation.kind}`,
          type: "jev_request",
          occurredAt: observation.startedAt,
          traceId,
          payload: observation,
        });
      }
      const sealedAt = Date.now();
      const sealed = await attemptRecorder.seal({
        execution: {
          state: status === "completed" ? "completed" : status === "provider_error" ? "provider_failed" : status === "timeout" ? "budget_exhausted" : status,
          startedAt,
          endedAt: sealedAt,
          sourceRefs: attemptRecorder.events.map((fact) => fact.eventId),
          observationCoverage: Boolean(nativeObservations.lastRunEnd) ? { state: "complete" } : { state: "partial", reason: "run_end_missing" },
        },
        publication: artifacts.receipt
          ? publicationFromReceipt(artifacts.receipt, artifacts.csvError ? { readError: artifacts.csvError } : {})
          : {
              state: (recorder?.calls ?? []).some((call) => call.toolName === "export_query" || call.toolName === "publish_query_result") ? "invalid" : "not_published",
              observationCoverage: { state: "complete", reason: "no_publication_receipt" },
            },
        coverage: {
          state: Boolean(nativeObservations.lastRunEnd) && !attemptRecorder.persistenceError && cleanupErrors.length === 0 ? "complete" : "partial",
          nativeObservationCount: nativeObservations.count,
          ...(attemptRecorder.persistenceError ? { recordPersistenceError: attemptRecorder.persistenceError } : {}),
          ...(cleanupErrors.length ? { cleanupErrors } : {}),
          ...(artifacts.csvError ? { publicationReadError: artifacts.csvError } : {}),
        },
        deliveryRequirement: { format: "csv", satisfied: artifacts.receipt?.format === "csv" && Boolean(artifacts.finalCsv) },
        process: {
          turns: recorder?.turnCount ?? 0,
          toolCalls: recorder?.calls.length ?? 0,
          explorationQueries: (recorder?.calls ?? []).filter((call) => call.toolName === "query_database" && (call.args?.kind ?? call.args?.mode) === "exploration").length,
          resultQueries: (recorder?.calls ?? []).filter((call) => call.toolName === "query_database" && (call.args?.kind ?? call.args?.mode) === "result").length,
          fanoutProbes: recordedFanoutMetrics.targetCount,
          revisions: (recorder?.calls ?? []).filter((call) => call.toolName === "set_answer_spec" && call.args?.taskId).length,
        },
        capabilities: {
          semanticSpec: { configured: true, executed: (recorder?.calls ?? []).some((call) => (semanticSpecMode === "required" ? ["set_answer_spec"] : ["begin_query_task"]).includes(call.toolName)), coverage: semanticSpecMode },
          fanout: { configured: fanoutEnabled, executed: recordedFanoutMetrics.reportCount > 0, coverage: recordedFanoutMetrics.reportCount > 0 ? "observed" : fanoutEnabled ? "not_observed" : "disabled" },
        },
      });
      result.episodeRecord = sealed.episode;
      result.usage = summarizeUsage(sealed.projection.spans);
    }
    const trace = { events: recorder?.events ?? [], toolCalls: recorder?.calls ?? [], nativeEventTypes: nativeObservations.types, knowledgeMetrics: recordedKnowledgeMetrics, fanoutMetrics: recordedFanoutMetrics, assuranceAuditRecords: [], anomalies: result.anomalies, episodeRecord: result.episodeRecord ?? null };
    const writes = [
      writeFile(path.join(caseRoot, "result.json"), JSON.stringify(result, null, 2), "utf8"),
      writeFile(path.join(caseRoot, "trace.json"), JSON.stringify(trace, null, 2), "utf8"),
    ];
    // Compatibility projections are read-only views for the existing report
    // scripts; never overwrite the first projection when a Retry is appended.
    if (attemptId === "attempt-001" || !(await exists(path.join(legacyCaseRoot, "result.json")))) {
      writes.push(writeFile(path.join(legacyCaseRoot, "result.json"), JSON.stringify(result, null, 2), "utf8"));
      writes.push(writeFile(path.join(legacyCaseRoot, "trace.json"), JSON.stringify(trace, null, 2), "utf8"));
    }
    await Promise.all(writes);
    if (attemptLayout) await writeAttemptStatus(attemptLayout, status, {
      finishedAt: new Date().toISOString(),
      ...(result.recordIncomplete ? { recordIncomplete: true } : {}),
      ...(cleanupErrors.length ? { cleanupFailed: true, cleanupErrors } : {}),
    });
    return result;
  };
}

async function gitCommit(directory) {
  try { return (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { windowsHide: true })).stdout.trim(); }
  catch { return null; }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
}

function endpointIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return `sha256:${sha256Text(value)}`;
  }
}

const EVALUATION_ADAPTER_FILES = ["run.mjs", "lib.mjs", "experiment.mjs", "episode.mjs", "record.mjs", "evaluation.mjs", "adapters/legacy-record.mjs", "baseline-report.mjs", "phase5-ab.mjs", "phase6-evaluate.mjs"];

async function evaluationAdapterSha256() {
  const hash = createHash("sha256");
  for (const name of EVALUATION_ADAPTER_FILES) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path.join(here, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function currentBaselineSurface(config) {
  const systemPrompt = await evaluationSystemPrompt(config);
  return {
    agentCommit: await gitCommit(projectRoot),
    systemPromptSha256: sha256Text(systemPrompt),
    semanticSpecMode: resolveSemanticSpecMode(config),
    enableClarificationTool: config.enableClarificationTool !== false,
    runtimeDistSha256: await sha256Tree(path.join(projectRoot, "packages", "runtime", "dist")),
    runtimeSourceSha256: await sha256Tree(path.join(projectRoot, "packages", "runtime", "src")),
    runtimeBuildProvenanceSha256: await sha256File(path.join(projectRoot, "packages", "runtime", "dist", "build-provenance.json")),
    skillsSha256: await sha256Tree(path.join(projectRoot, ".agents", "skills")),
    evaluationSkillsSha256: await sha256Tree(path.join(here, "skills")),
    // The launcher at apps/server/dist/reference-sqlite-mcp.js only imports this server.
    sqliteMcpSha256: await sha256File(path.join(projectRoot, "packages", "mcp-sqlite", "dist", "index.js")),
    queryExecutorSha256: await sha256File(path.join(projectRoot, "packages", "database", "dist", "mcp-query-executor.js")),
    serverSourceSha256: await sha256Tree(path.join(projectRoot, "apps", "server", "src")),
    serverBuildProvenanceSha256: await sha256File(path.join(projectRoot, "apps", "server", "dist", "build-provenance.json")),
    evaluationAdapter: {
      sourceSha256: await evaluationAdapterSha256(),
      files: EVALUATION_ADAPTER_FILES,
    },
    spider2: {
      commit: await gitCommit(config.spider2Repo),
      datasetSha256: await sha256File(config.datasetPath),
      evaluatorSha256: await sha256File(path.join(config.evaluationSuite, "evaluate.py")),
    },
    model: {
      provider: config.llm?.provider ?? "openai",
      model: config.llm?.model,
      apiFormat: config.llm?.apiFormat,
      baseUrl: endpointIdentity(config.llm?.baseUrlEnv ? process.env[config.llm.baseUrlEnv] : config.llm?.baseUrl),
      ...(config.selectedModelProfile ? { profile: config.selectedModelProfile } : {}),
    },
    limits: config.limits,
    concurrency: config.concurrency,
    localDatabasePackSha256: config.localDatabasePackSha256 ?? null,
  };
}

function baselineLockPath(config) {
  const mode = resolveSemanticSpecMode(config);
  return path.join(config.runsRoot, "_baseline", mode === "required" ? "agent-surface-lock.json" : `agent-surface-lock.semantic-spec-${mode}.json`);
}

async function freezeCommand(config) {
  await assertFormalCompatibility(config);
  await assertBuildProvenance();
  const lockPath = baselineLockPath(config);
  const lockDir = path.dirname(lockPath);
  await mkdir(lockDir, { recursive: true });
  const lock = { version: 1, frozenAt: new Date().toISOString(), surface: await currentBaselineSurface(config) };
  await writeFile(lockPath, JSON.stringify(lock, null, 2), "utf8");
  console.log(`Baseline surface frozen: ${lockPath}`);
  console.log(JSON.stringify(lock.surface, null, 2));
  return lock;
}

async function assertBaselineFrozen(config) {
  const lockPath = baselineLockPath(config);
  if (!(await exists(lockPath))) throw new Error("BASELINE_SURFACE_NOT_FROZEN");
  const expected = JSON.parse(await readFile(lockPath, "utf8")).surface;
  const actual = await currentBaselineSurface(config);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("BASELINE_SURFACE_CHANGED");
  return lockPath;
}

async function assertBuildProvenance() {
  const packages = [
    [path.join(projectRoot, "packages", "runtime"), path.join(projectRoot, "packages", "runtime", "dist", "build-provenance.json")],
    [path.join(projectRoot, "apps", "server"), path.join(projectRoot, "apps", "server", "dist", "build-provenance.json")],
  ];
  const checked = [];
  for (const [packageRoot, provenancePath] of packages) {
    if (!(await exists(provenancePath))) throw new Error(`BUILD_PROVENANCE_MISSING:${provenancePath}`);
    const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
    const sourceSha256 = await sha256Tree(path.join(packageRoot, "src"));
    if (provenance.sourceSha256 !== sourceSha256) throw new Error(`BUILD_PROVENANCE_STALE:${packageRoot}`);
    checked.push({ package: provenance.package, sourceSha256, provenancePath });
  }
  return checked;
}

async function assertFormalCompatibility(config) {
  const target = path.join(config.runsRoot, "_preflight", "gold-compatibility.json");
  if (!(await exists(target))) throw new Error("FORMAL_RUN_REQUIRES_GOLD_PREFLIGHT");
  const result = JSON.parse(await readFile(target, "utf8"));
  const datasetSha256 = await sha256File(config.datasetPath);
  const evaluatorSha256 = await sha256File(path.join(config.evaluationSuite, "evaluate.py"));
  if (!result.ok || result.datasetSha256 !== datasetSha256 || result.evaluatorSha256 !== evaluatorSha256) {
    throw new Error("FORMAL_RUN_BLOCKED_BY_GOLD_INCOMPATIBILITY");
  }
}

function resumeStatusesFromOptions(options) {
  const value = options.resumeStatuses ?? options.resumeStatus ?? "error,provider_error,infra_error,timeout";
  return new Set(String(value).split(",").map((s) => s.trim()).filter(Boolean));
}

async function runCommand(config, options) {
  await assertBuildProvenance();
  if (options.formal || options.baseline) await assertFormalCompatibility(config);
  const hookSwitches = assuranceHookSwitches(config, options);
  const detectorPolicy = detectorPolicyFromConfig(config);
  const interpretationPolicy = interpretationPolicyFromConfig(config);
  const resumeStatuses = resumeStatusesFromOptions(options);
  const baselineLockPath = options.baseline ? await assertBaselineFrozen(config) : undefined;
  const modelCanary = options.formal || options.baseline ? await runModelCanary(config) : undefined;
  const allCases = await loadCases(config.datasetPath);
  const ids = options.idsFile ? (await readFile(path.resolve(options.idsFile), "utf8")).split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : undefined;
  const selected = selectCases(allCases, {
    instanceId: options.instanceId,
    backend: options.backend,
    ids,
    maxCases: options.maxCases === undefined ? undefined : Number(options.maxCases),
  });
  if (selected.length === 0) throw new Error("NO_CASES_SELECTED");
  const runId = options.runId || `spider2-${options.backend ?? "mixed"}-${timestampId()}`;
  const runDir = path.join(config.runsRoot, runId);
  if (await exists(runDir) && !options.resume && !options.continue && !options.retry) throw new Error(`RUN_ALREADY_EXISTS:${runDir}`);
  const previousManifestPath = path.join(runDir, "manifest.json");
  const previousManifest = (options.resume || options.continue || options.retry) && await exists(previousManifestPath)
    ? JSON.parse(await readFile(previousManifestPath, "utf8"))
    : undefined;
  if (options.resume && !options.continue && !options.retry) throw new Error("RESUME_SEMANTICS_EXPLICIT_CONTINUE_OR_RETRY");
  await mkdir(runDir, { recursive: true });
  const systemPrompt = await evaluationSystemPrompt(config);
  const experiment = await resolveExperiment({
    config,
    instanceIds: selected.map((item) => item.instance_id),
    inputs: {
      systemPrompt,
      paths: {
        runtimeBuild: path.join(projectRoot, "packages", "runtime", "dist"),
        runtimeSource: path.join(projectRoot, "packages", "runtime", "src"),
        serverBuild: path.join(projectRoot, "apps", "server", "dist"),
        skills: path.join(projectRoot, ".agents", "skills"),
        knowledge: path.join(projectRoot, ".agents", "knowledge"),
        toolPromptCatalog: path.join(projectRoot, "packages", "runtime", "src", "agent", "tool-prompt-catalog.ts"),
        runner: fileURLToPath(import.meta.url),
        library: path.join(projectRoot, "evaluations", "spider2", "lib.mjs"),
      },
    },
  });

  const attemptMode = options.retry ? "retry" : options.continue ? "continue" : "run";
  if (attemptMode === "continue" && !previousManifest) throw new Error("CONTINUE_SOURCE_MANIFEST_REQUIRED");
  if (attemptMode === "retry" && !previousManifest) throw new Error("RETRY_SOURCE_MANIFEST_REQUIRED");
  if ((attemptMode === "continue" || attemptMode === "retry") && previousManifest?.experimentId && previousManifest.experimentId !== experiment.experimentId) throw new Error(`${attemptMode.toUpperCase()}_EXPERIMENT_MISMATCH`);
  if (attemptMode === "continue" && JSON.stringify(previousManifest?.budgets) !== JSON.stringify(experiment.budgets)) throw new Error("CONTINUE_BUDGET_RESET");
  const attemptId = options.attemptId ?? (attemptMode === "continue" ? previousManifest?.attemptPolicy?.selectedAttemptId ?? "attempt-001" : attemptMode === "retry" ? `attempt-${timestampId()}` : "attempt-001");
  const manifest = {
    ...manifestFromExperiment(experiment),
    runId,
    attemptPolicy: { ...experiment.attemptPolicy, selectedMode: attemptMode, selectedAttemptId: attemptId, ...(attemptMode === "retry" && previousManifest?.attemptPolicy?.selectedAttemptId ? { retryOf: previousManifest.attemptPolicy.selectedAttemptId } : {}) },
    agentCommit: await gitCommit(projectRoot),
    spider2Commit: await gitCommit(config.spider2Repo),
    datasetSha256: await sha256File(config.datasetPath),
    evaluatorSha256: await sha256File(path.join(config.evaluationSuite, "evaluate.py")),
    runnerSha256: await evaluationAdapterSha256(),
    systemPromptSha256: sha256Text(systemPrompt),
    model: { provider: config.llm?.provider ?? "openai", model: config.llm?.model, apiFormat: config.llm?.apiFormat, ...(config.llm?.contextWindow !== undefined ? { contextWindow: Number(config.llm.contextWindow) } : {}), ...(config.llm?.maxTokens !== undefined ? { maxTokens: Number(config.llm.maxTokens) } : {}), ...(config.llm?.thinkingLevel ? { thinkingLevel: config.llm.thinkingLevel } : {}), ...(config.selectedModelProfile ? { profile: config.selectedModelProfile } : {}) },
    answering: {
      semanticSpecMode: experiment.capabilities.semanticSpec.resolved,
      enableClarificationTool: experiment.capabilities.clarification.resolved,
      promptProfile: `semantic-spec-${experiment.capabilities.semanticSpec.resolved}`,
      interface: ["begin", "revise", "execute", "publish", "inspect"],
      policyVersion: "answering-publication-v1",
      reviewerOnline: false,
      detectorsOnline: experiment.capabilities.fanout.resolved,
      fanoutRuleVersion: "answering-fanout-v1",
    },
    // Legacy assurance switches remain manifest-only experiment metadata; they
    // do not grant online publication authority in the Application Host.
    assuranceObserver: {
      mode: "offline",
      hooks: hookSwitches,
      detectors: detectorPolicy,
      interpretations: interpretationPolicy,
    },
    // A scoped --resume must not shrink the original run denominator. Keep the
    // prior manifest's population and merge untouched case results below.
    instanceIds: previousManifest?.instanceIds ?? selected.map((item) => item.instance_id),
    limits: config.limits,
    concurrency: Number(options.concurrency ?? config.concurrency),
    configPath: config.__path,
    ...(baselineLockPath ? { baselineLockSha256: await sha256File(baselineLockPath) } : {}),
    ...(modelCanary ? { modelCanary } : {}),
    status: "running",
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const runCase = await createCaseRunner(config, runDir, systemPrompt, attemptId, experiment.experimentId, attemptMode, experiment.budgets.queryTask, previousManifest?.attemptPolicy?.selectedAttemptId, experiment.capabilities.fanout.resolved, experiment.capabilities.semanticSpec.resolved);
  const resultById = new Map();
  if (options.resume || options.continue || options.retry) {
    const priorIds = previousManifest?.instanceIds ?? selected.map((item) => item.instance_id);
    for (const instanceId of priorIds) {
      const resultPath = path.join(runDir, "cases", instanceId, "result.json");
      if (await exists(resultPath)) resultById.set(instanceId, JSON.parse(await readFile(resultPath, "utf8")));
    }
  }
  let nextIndex = 0;
  let abortResult;
  const concurrency = Math.max(1, Math.min(selected.length, Number(options.concurrency ?? config.concurrency)));
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (abortResult) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= selected.length) return;
      const instance = selected[index];
      const existing = path.join(runDir, "cases", instance.instance_id, "result.json");
      if (options.resume && await exists(existing)) {
        const previous = JSON.parse(await readFile(existing, "utf8"));
        const suspiciousCompleted = previous.status === "completed" && previous.toolCalls === 0 && !previous.csvGenerated;
        if (!resumeStatuses.has(previous.status) && !suspiciousCompleted) {
          resultById.set(instance.instance_id, previous);
          continue;
        }
      }
      console.log(`[${index + 1}/${selected.length}] ${instance.instance_id} (${backendForCase(instance)})`);
      const result = await runCase(instance);
      resultById.set(instance.instance_id, result);
      console.log(`  ${result.status} ${result.durationMs}ms sql=${Boolean(result.finalSql)} csv=${result.csvGenerated}`);
      if (result.status === "provider_error" || result.status === "infra_error" || ((options.formal || options.baseline) && ["error", "resource_error"].includes(result.status))) {
        abortResult ??= result;
      }
    }
  });
  await Promise.all(workers);
  const results = [...resultById.values()].sort((a, b) => a.instanceId.localeCompare(b.instanceId));
  const observedToolSets = results.filter((result) => Array.isArray(result.activeTools)).map((result) => JSON.stringify([...result.activeTools].sort()));
  if (observedToolSets.length) {
    const distinctToolSets = [...new Set(observedToolSets)];
    const toolCoverageComplete = observedToolSets.length === results.length && distinctToolSets.length === 1;
    manifest.observedCapabilities = {
      ...(manifest.observedCapabilities ?? {}),
      tools: {
        state: "observed",
        resolved: JSON.parse(distinctToolSets[0]),
        coverage: toolCoverageComplete ? "complete" : "partial",
        observedCases: observedToolSets.length,
        expectedCases: results.length,
        ...(distinctToolSets.length > 1 ? { observedVariants: distinctToolSets.map((value) => JSON.parse(value)) } : {}),
      },
    };
  }
  const observedDatabaseIdentities = results.filter((result) => result.databaseIdentity).map((result) => JSON.stringify({ caseId: result.instanceId, ...result.databaseIdentity }));
  if (observedDatabaseIdentities.length) {
    manifest.observedInputs = { ...(manifest.observedInputs ?? {}), databases: [...new Set(observedDatabaseIdentities)].map((value) => JSON.parse(value)) };
  }
  await writeFile(path.join(runDir, "cases.jsonl"), `${results.map(safeJson).join("\n")}\n`, "utf8");
  await writeSummary(runDir, results);
  const infrastructureFailures = results.filter((item) => ["provider_error", "resource_error", "error", "unknown"].includes(item.status));
  const expectedCases = previousManifest?.instanceIds?.length ?? selected.length;
  const complete = results.length === expectedCases && infrastructureFailures.length === 0;
  manifest.status = complete ? "completed" : "incomplete";
  manifest.completedAt = new Date().toISOString();
  manifest.completedCases = results.length;
  manifest.infrastructureFailures = infrastructureFailures.map((item) => ({ instanceId: item.instanceId, status: item.status, message: item.error?.message ?? null }));
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (!complete) {
    const reason = abortResult ? `${abortResult.instanceId}:${abortResult.status}:${abortResult.error?.message ?? "unknown"}` : `completed=${results.length}/${expectedCases}`;
    throw new Error(`RUN_INCOMPLETE:${reason}`);
  }
  console.log(`Run completed: ${runDir}`);
  if (options.score) await scoreCommand(config, { run: runId, attempt: manifest.attemptPolicy.selectedAttemptId });
  return runDir;
}

async function runEvaluator(config, resultDir, mode, outputDir) {
  const extension = mode === "sql" ? ".sql" : ".csv";
  const files = (await readdir(resultDir).catch(() => [])).filter((name) => name.endsWith(extension) && !name.endsWith("-ids.csv"));
  if (files.length === 0) return { mode, skipped: true, reason: "no_submission_files" };
  const python = config.pythonExecutable || "python";
  const evaluator = path.join(config.evaluationSuite, "evaluate.py");
  const evaluatorSource = await readFile(evaluator, "utf8");
  validateOfficialEvaluatorSource(evaluatorSource);
  const evaluatorArgs = [
    evaluator,
    "--result_dir", resultDir,
    "--mode", mode,
    "--gold_dir", "gold",
  ];
  if (/add_argument\(["']--max_workers["']/.test(evaluatorSource)) evaluatorArgs.push("--max_workers", String(config.scoreWorkers ?? 4));
  try {
    const { stdout, stderr } = await execFileAsync(python, evaluatorArgs, {
      cwd: config.evaluationSuite,
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
      // The official evaluator uses open()/read() without an explicit encoding
      // for submitted SQL. Force UTF-8 mode on Windows so UTF-8 SQL is not
      // decoded with the system GBK code page.
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    const output = `${stdout}${stderr}`;
    await writeFile(path.join(outputDir, `${mode}.log`), output, "utf8");
    const submittedIds = files.map((name) => path.basename(name, extension));
    const idsPath = `${resultDir}-ids.csv`;
    const correctIds = await exists(idsPath) ? parseCorrectIdsCsv(await readFile(idsPath, "utf8")) : [];
    const caseScores = Object.fromEntries(submittedIds.map((id) => [id, correctIds.includes(id) ? 1 : 0]));
    return { mode, skipped: false, ...parseOfficialScore(output), caseScores: Object.keys(caseScores).length ? caseScores : parseOfficialCaseScores(output) };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`;
    await writeFile(path.join(outputDir, `${mode}.log`), output, "utf8");
    return { mode, skipped: false, error: error.message, ...parseOfficialScore(output), caseScores: parseOfficialCaseScores(output) };
  }
}

async function loadAttemptEpisodes(runDir, manifest, attemptId) {
  const records = [];
  for (const instanceId of manifest?.instanceIds ?? []) {
    const canonical = attemptId && attemptId !== "legacy" ? path.join(runDir, "cases", instanceId, "attempts", attemptId) : undefined;
    const legacyEpisode = path.join(runDir, "cases", instanceId, "result.json");
    try {
      if (canonical && await exists(path.join(canonical, "episode.json"))) records.push(await loadEpisodeRecord(canonical));
      else if (await exists(legacyEpisode)) {
        const result = JSON.parse(await readFile(legacyEpisode, "utf8"));
        if (result.episodeRecord) records.push(result.episodeRecord);
      }
    } catch {
      // Missing/corrupt EpisodeRecord is disclosed by the evaluation report.
    }
  }
  return records;
}

async function submissionDirectoryForRun(runDir, manifest, mode, attemptId) {
  const extension = mode === "sql" ? "sql" : "csv";
  const target = path.join(runDir, "official_score", "inputs", attemptId ?? "legacy", mode);
  await mkdir(target, { recursive: true });
  for (const instanceId of manifest?.instanceIds ?? []) {
    const attemptSource = attemptId ? path.join(runDir, "cases", instanceId, "attempts", attemptId, "submissions", mode, `${instanceId}.${extension}`) : undefined;
    const legacySource = path.join(runDir, "submissions", mode, `${instanceId}.${extension}`);
    const source = attemptSource && await exists(attemptSource) ? attemptSource : legacySource;
    if (await exists(source)) await copyFile(source, path.join(target, `${instanceId}.${extension}`));
  }
  return target;
}

async function scoreCommand(config, options) {
  if (!options.run) throw new Error("--run is required");
  const runDir = path.join(config.runsRoot, options.run);
  const manifestPath = path.join(runDir, "manifest.json");
  let manifest;
  if (await exists(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const datasetSha256 = await sha256File(config.datasetPath);
    const evaluatorSha256 = await sha256File(path.join(config.evaluationSuite, "evaluate.py"));
    const mismatch = manifest.datasetSha256 !== datasetSha256 || manifest.evaluatorSha256 !== evaluatorSha256;
    if (mismatch && !options.allowVersionMismatch) throw new Error("SCORE_VERSION_MISMATCH");
  }
  const outputDir = path.join(runDir, "official_score");
  await mkdir(outputDir, { recursive: true });
  const attemptId = options.attempt ?? manifest?.attemptPolicy?.selectedAttemptId ?? "legacy";
  const sqlSubmissionDir = await submissionDirectoryForRun(runDir, manifest, "sql", attemptId === "legacy" ? undefined : attemptId);
  const csvSubmissionDir = await submissionDirectoryForRun(runDir, manifest, "csv", attemptId === "legacy" ? undefined : attemptId);
  // Older official evaluators share a fixed `temp/` directory, so SQL and
  // exec-result modes must run sequentially to avoid cross-mode corruption.
  const scoreStartedAt = new Date().toISOString();
  const sql = await runEvaluator(config, sqlSubmissionDir, "sql", outputDir);
  const execResult = await runEvaluator(config, csvSubmissionDir, "exec_result", outputDir);
  const expectedTotal = manifest?.instanceIds?.length;
  if (Number.isInteger(expectedTotal)) {
    sql.fixedDenominator = fixedDenominatorScore(sql.correct, expectedTotal, sql.total);
    execResult.fixedDenominator = fixedDenominatorScore(execResult.correct, expectedTotal, execResult.total);
  }
  const episodes = await loadAttemptEpisodes(runDir, manifest, attemptId);
  const evaluation = buildEvaluationReport(episodes, execResult.caseScores ?? {}, { experimentId: manifest?.experimentId ?? null, denominatorIds: manifest?.instanceIds ?? [] });
  const scoreRunId = `score-${Date.now()}`;
  const scoreOutcome = [sql, execResult].some((item) => item.error) ? "failed" : [sql, execResult].every((item) => item.skipped) ? "unknown" : "completed";
  const scoreFinishedAt = new Date().toISOString();
  const scoreTraceId = `score-trace:${scoreRunId}`;
  const scoreRecord = {
    schemaVersion: 1,
    scoreRunId,
    scoreTraceId,
    attemptId,
    scorer: "official-spider2-evaluator",
    sourceRefs: episodes.map((episode) => episode.traceId).filter(Boolean),
    correctnessByCase: execResult.caseScores ?? {},
    evaluation,
    span: {
      schemaVersion: 1,
      spanId: `score-span:${scoreRunId}`,
      traceId: scoreTraceId,
      kind: "scorer",
      name: "official-spider2-evaluator",
      lifecycle: "ended",
      outcome: scoreOutcome,
      startedAt: scoreStartedAt,
      endedAt: scoreFinishedAt,
      sourceRefs: episodes.map((episode) => episode.traceId).filter(Boolean),
    },
    createdAt: scoreFinishedAt,
  };
  const result = { sql, execResult, attemptId, episodeCount: episodes.length, scoredAt: new Date().toISOString() };
  await writeFile(path.join(outputDir, "summary.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(path.join(outputDir, "evaluation.json"), JSON.stringify(evaluation, null, 2), "utf8");
  await persistScoreRecord(scoreRecord, path.join(outputDir, "score-record.json"));
  console.log(JSON.stringify(result, null, 2));
  await reportCommand(config, options);
  return result;
}

async function loadCaseResults(runDir, manifest, attemptId) {
  const selected = [];
  for (const instanceId of manifest?.instanceIds ?? []) {
    const attemptResult = attemptId && attemptId !== "legacy"
      ? path.join(runDir, "cases", instanceId, "attempts", attemptId, "result.json")
      : undefined;
    const legacyResult = path.join(runDir, "cases", instanceId, "result.json");
    const source = attemptResult && await exists(attemptResult) ? attemptResult : legacyResult;
    if (await exists(source)) {
      try { selected.push(JSON.parse(await readFile(source, "utf8"))); } catch { /* report exposes the missing/corrupt case through denominator limits */ }
    }
  }
  if (selected.length || manifest?.instanceIds?.length) return selected;
  const target = path.join(runDir, "cases.jsonl");
  if (!(await exists(target))) return [];
  return (await readFile(target, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function writeSummary(runDir, results) {
  const statuses = {};
  const backends = {};
  const publicationStatuses = {};
  const stopPositions = {};
  for (const result of results) {
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    // Results written before stopPosition existed have none; they are left out rather than guessed.
    if (result.stopPosition) {
      const key = `${result.status}:${result.stopPosition}`;
      stopPositions[key] = (stopPositions[key] ?? 0) + 1;
    }
    backends[result.backend] = (backends[result.backend] ?? 0) + 1;
    if (result.publicationStatus) publicationStatuses[result.publicationStatus] = (publicationStatuses[result.publicationStatus] ?? 0) + 1;
  }
  const summary = {
    total: results.length,
    statuses,
    backends,
    publicationStatuses,
    stopPositions,
    sqlCoverage: results.length ? results.filter((item) => item.finalSql).length / results.length : 0,
    csvCoverage: results.length ? results.filter((item) => item.csvGenerated).length / results.length : 0,
    averageDurationMs: results.length ? Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / results.length) : 0,
    averageToolCalls: results.length ? results.reduce((sum, item) => sum + item.toolCalls, 0) / results.length : 0,
    anomalyCount: results.reduce((sum, item) => sum + Number(item.anomalyMetrics?.total ?? 0), 0),
    interpretationHookCount: results.reduce((sum, item) => sum + Number(item.anomalyMetrics?.interpretationHookCount ?? 0), 0),
    unresolvedHypothesisHookCount: results.reduce((sum, item) => sum + Number(item.anomalyMetrics?.unresolvedHypothesisHookCount ?? 0), 0),
    unresolvedHypothesisCount: results.reduce((sum, item) => sum + Number(item.anomalyMetrics?.unresolvedHypothesisIds?.length ?? 0), 0),
    interpretationBudgetSkipCount: results.reduce((sum, item) => sum + Number(item.anomalyMetrics?.interpretationBudgetSkipCount ?? 0), 0),
  };
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  return summary;
}

async function reportCommand(config, options) {
  if (!options.run) throw new Error("--run is required");
  const runDir = path.join(config.runsRoot, options.run);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : undefined;
  const attemptId = options.attempt ?? manifest?.attemptPolicy?.selectedAttemptId ?? "legacy";
  const results = await loadCaseResults(runDir, manifest, attemptId);
  const summary = await writeSummary(runDir, results);
  const officialPath = path.join(runDir, "official_score", "summary.json");
  const official = await exists(officialPath) ? JSON.parse(await readFile(officialPath, "utf8")) : null;
  const evaluationPath = path.join(runDir, "official_score", "evaluation.json");
  const evaluation = await exists(evaluationPath) ? JSON.parse(await readFile(evaluationPath, "utf8")) : null;
  const sqlCaseScores = official?.sql?.caseScores ?? {};
  const csvCaseScores = official?.execResult?.caseScores ?? {};
  const failures = results.filter((item) => item.status !== "completed" || !item.finalSql || !item.csvGenerated || sqlCaseScores[item.instanceId] === 0 || csvCaseScores[item.instanceId] === 0);
  const report = [
    `# Spider2 Agent Evaluation: ${options.run}`,
    "",
    `- Cases: ${summary.total}`,
    `- Status: ${Object.entries(summary.statuses).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- SQL coverage: ${(summary.sqlCoverage * 100).toFixed(2)}%`,
    `- CSV coverage: ${(summary.csvCoverage * 100).toFixed(2)}%`,
    `- Publication statuses: ${Object.entries(summary.publicationStatuses).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- Stop positions (status:position): ${Object.entries(summary.stopPositions).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}`,
    `- Average latency: ${summary.averageDurationMs} ms`,
    `- Average tool calls: ${summary.averageToolCalls.toFixed(2)}`,
    `- Registered anomalies: ${summary.anomalyCount}`,
    `- Interpretation Hook injections: ${summary.interpretationHookCount}`,
    `- Unresolved-hypothesis Hook injections: ${summary.unresolvedHypothesisHookCount} (${summary.unresolvedHypothesisCount} hypothesis IDs)`,
    `- Interpretation budget skips: ${summary.interpretationBudgetSkipCount}`,
    ...(evaluation ? [`- EpisodeRecord evaluation: ${evaluation.metrics?.total ?? 0} denominator cases; unknown limitations=${evaluation.limitations?.join(",") || "none"}`] : []),
    ...(official ? [
      `- Official SQL EX (submitted only): ${official.sql?.score ?? "not available"} (${official.sql?.correct ?? 0}/${official.sql?.total ?? 0})`,
      `- SQL EX (fixed run denominator): ${official.sql?.fixedDenominator?.score ?? "not available"} (${official.sql?.fixedDenominator?.correct ?? 0}/${official.sql?.fixedDenominator?.total ?? summary.total})`,
      `- Official End-to-End EX (submitted only): ${official.execResult?.score ?? "not available"} (${official.execResult?.correct ?? 0}/${official.execResult?.total ?? 0})`,
      `- End-to-End EX (fixed run denominator): ${official.execResult?.fixedDenominator?.score ?? "not available"} (${official.execResult?.fixedDenominator?.correct ?? 0}/${official.execResult?.fixedDenominator?.total ?? summary.total})`,
    ] : []),
    "",
    "## Cases needing review",
    "",
    ...(failures.length ? failures.map((item) => `- ${item.instanceId}: status=${item.status}${item.stopPosition ? `, stop=${item.stopPosition}` : ""}, sql=${Boolean(item.finalSql)}, csv=${item.csvGenerated}, sqlEX=${sqlCaseScores[item.instanceId] ?? "n/a"}, csvEX=${csvCaseScores[item.instanceId] ?? "n/a"}${item.csvError ? `, csvError=${item.csvError}` : ""}${item.error?.message ? `, error=${item.error.message}` : ""}`) : ["None."]),
    "",
  ].join("\n");
  await writeFile(path.join(runDir, "report.md"), report, "utf8");
  console.log(`Report: ${path.join(runDir, "report.md")}`);
  return report;
}

async function runGoldCompatibilityCheck(config, selected, option) {
  const goldSqlDir = path.join(config.evaluationSuite, "gold", "sql");
  let candidates = [];
  for (const instance of selected) {
    if (backendForCase(instance) !== "sqlite") continue;
    const source = path.join(goldSqlDir, `${instance.instance_id}.sql`);
    if (await exists(source)) candidates.push({ instance, source });
  }
  const requested = option === true ? undefined : String(option);
  if (requested && !/^\d+$/.test(requested)) candidates = candidates.filter(({ instance }) => instance.instance_id === requested);
  else candidates = candidates.slice(0, requested ? Math.max(1, Number(requested)) : 3);
  if (candidates.length === 0) return { ok: false, error: "NO_GOLD_SQL_CASES_AVAILABLE", testedIds: [] };

  const checkRoot = path.join(config.runsRoot, "_preflight", `gold-${timestampId()}`);
  const submissionDir = path.join(checkRoot, "submission");
  const outputDir = path.join(checkRoot, "official_score");
  await Promise.all([mkdir(submissionDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  for (const { instance, source } of candidates) await copyFile(source, path.join(submissionDir, `${instance.instance_id}.sql`));
  const score = await runEvaluator(config, submissionDir, "sql", outputDir);
  const result = {
    ok: !score.error && score.total === candidates.length && score.correct === candidates.length,
    testedIds: candidates.map(({ instance }) => instance.instance_id),
    score,
    spider2Commit: await gitCommit(config.spider2Repo),
    datasetSha256: await sha256File(config.datasetPath),
    evaluatorSha256: await sha256File(path.join(config.evaluationSuite, "evaluate.py")),
    checkedAt: new Date().toISOString(),
    evidenceDir: checkRoot,
  };
  await mkdir(path.join(config.runsRoot, "_preflight"), { recursive: true });
  await writeFile(path.join(config.runsRoot, "_preflight", "gold-compatibility.json"), JSON.stringify(result, null, 2), "utf8");
  return result;
}

async function preflightCommand(config, options) {
  const required = [
    config.datasetPath,
    path.join(config.evaluationSuite, "evaluate.py"),
    path.join(config.evaluationSuite, "gold", "spider2lite_eval.jsonl"),
    path.join(projectRoot, "packages", "runtime", "dist", "index.js"),
    path.join(projectRoot, "packages", "database", "dist", "mcp-query-executor.js"),
    path.join(projectRoot, "apps", "server", "dist", "reference-sqlite-mcp.js"),
  ];
  const missing = [];
  for (const target of required) if (!(await exists(target))) missing.push(target);
  if (missing.length) throw new Error(`PREFLIGHT_MISSING:\n${missing.join("\n")}`);
  const cases = await loadCases(config.datasetPath);
  const counts = {};
  for (const item of cases) counts[backendForCase(item)] = (counts[backendForCase(item)] ?? 0) + 1;
  const ids = options.idsFile ? (await readFile(path.resolve(options.idsFile), "utf8")).split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : undefined;
  const selected = selectCases(cases, {
    backend: options.backend,
    instanceId: options.instanceId,
    ids,
    maxCases: options.maxCases ? Number(options.maxCases) : undefined,
  });
  const issues = [];
  let buildProvenance;
  try { buildProvenance = await assertBuildProvenance(); }
  catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  for (const instance of selected) {
    try {
      await resolveMetadataDirectory(config.spider2LiteRoot, instance);
      await resolveExternalKnowledge(config.spider2LiteRoot, instance);
      if (backendForCase(instance) === "sqlite") await resolveLocalDatabase(config, config.spider2LiteRoot, instance);
      else if (!config.backends?.[backendForCase(instance)]?.mcp?.command) issues.push(`${instance.instance_id}:BACKEND_MCP_NOT_CONFIGURED`);
    } catch (error) {
      issues.push(`${instance.instance_id}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const goldCompatibility = options.goldCheck ? await runGoldCompatibilityCheck(config, selected, options.goldCheck) : undefined;
  if (goldCompatibility && !goldCompatibility.ok) issues.push(`GOLD_COMPATIBILITY_FAILED:${goldCompatibility.testedIds.join(",") || goldCompatibility.error}`);
  let modelCanary;
  if (options.modelCanary) {
    try { modelCanary = await runModelCanary(config); }
    catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  }
  const result = {
    ok: issues.length === 0,
    config: config.__path,
    spider2Repo: config.spider2Repo,
    spider2LiteRoot: config.spider2LiteRoot,
    runsRoot: config.runsRoot,
    totalCases: cases.length,
    counts,
    checkedCases: selected.length,
    issues: issues.slice(0, 100),
    ...(buildProvenance ? { buildProvenance } : {}),
    ...(goldCompatibility ? { goldCompatibility } : {}),
    ...(modelCanary ? { modelCanary } : {}),
    llmKeyAvailable: Boolean(process.env[config.llm?.apiKeyEnv ?? "OPENAI_API_KEY"]),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  return result;
}

function usage() {
  return [
    "Usage: node evaluations/spider2/run.mjs <preflight|freeze|run|score|rescore|report> [options]",
    "",
    "Safety: `run` executes model/database work. Always pass an explicit --run-id and case selector.",
    "Use `<command> --help` only for this usage text; it never loads credentials or starts work.",
    "`run --continue` keeps an existing attempt; `run --retry` appends a new attempt without replacing canonical evidence.",
    "Use `--semantic-spec-mode required|disabled` only for a pre-registered semantic-spec ablation; disabled keeps Query Task/Candidate/Receipt semantics.",
    "Use `--disable-clarification` for both headless A/B arms to remove the blocking clarification tool without changing product defaults.",
  ].join("\n");
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "help" || options.help) {
    console.log(usage());
    return;
  }
  if (options.envFile) await loadEnvironmentFile(path.resolve(options.envFile));
  else {
    await loadEnvironmentFile(path.join(projectRoot, ".env"));
    await loadEnvironmentFile(path.join(here, ".env.local"));
  }
  let config = selectModelProfile(await loadConfig(options.config), options.modelProfile);
  if (options.semanticSpecMode) config = { ...config, answering: { ...(config.answering ?? {}), semanticSpecMode: String(options.semanticSpecMode) } };
  if (options.disableClarification) config = { ...config, enableClarificationTool: false };
  validateExperimentConfig(config);
  if (command === "preflight") await preflightCommand(config, options);
  else if (command === "freeze") await freezeCommand(config);
  else if (command === "run") await runCommand(config, options);
  else if (command === "score" || command === "rescore") await scoreCommand(config, options);
  else if (command === "report") await reportCommand(config, options);
  else throw new Error(`UNKNOWN_COMMAND:${command}`);
}

async function flushCliOutput() {
  const flush = (stream) => new Promise((resolve) => {
    if (!stream || stream.destroyed || !stream.writable) resolve();
    else stream.write("", resolve);
  });
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
}

async function terminateCli(exitCode) {
  await flushCliOutput();
  process.exit(exitCode);
}

main().then(
  () => terminateCli(process.exitCode ?? 0),
  async (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    await terminateCli(1);
  },
);
