import { createHash } from "node:crypto";
import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contentHash, stableStringify } from "./record.mjs";

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const DEFAULT_QUERY_TASK_BUDGET = Object.freeze({
  version: "answering-dual-loop-v1",
  maxRevisions: 8,
  maxExplorationAttempts: 16,
  maxResultAttempts: 8,
  maxElapsedMs: 15 * 60 * 1_000,
  maxObservedRows: 200_000,
});

const TOP_LEVEL_KEYS = new Set([
  "__path", "spider2Repo", "runsRoot", "spider2LiteRoot", "datasetPath", "evaluationSuite", "pythonExecutable",
  "localDatabasePackSha256", "concurrency", "scoreWorkers", "assurance", "llm", "modelProfiles", "selectedModelProfile",
  "limits", "backends", "answering", "queryTask", "delegation", "attemptPolicy", "comparisonPolicy", "scoring", "inputs",
  "enableSubagents", "enableWidgets", "enableDashboards", "enableClarificationTool", "hypothesisAdvisor",
]);
const LIMIT_KEYS = new Set(["timeoutMs", "providerTimeoutMs", "maxTurns", "maxToolCalls", "maxExploratoryQueries"]);
const INLINE_SECRET_KEYS = /(?:api[_-]?key|password|secret|authorization|credential|token)/i;
const BASE_TOOLS = [
  "load_skill", "search_knowledge", "read_knowledge", "update_knowledge", "read_file", "list_workspace", "write_file", "run_python",
  "query_database", "publish_query_result", "export_query", "inspect_answer", "ask_user_clarification", "subagent",
];

export function resolveSemanticSpecMode(config) {
  const mode = config.answering?.semanticSpecMode ?? "required";
  if (mode !== "required" && mode !== "disabled") throw new Error("INVALID_SEMANTIC_SPEC_MODE");
  return mode;
}

function defaultTools(config, semanticSpecMode) {
  return [
    ...BASE_TOOLS.filter((tool) => tool !== "ask_user_clarification" || config.enableClarificationTool !== false),
    ...(semanticSpecMode !== "required" ? ["begin_query_task"] : ["set_answer_spec"]),
    ...(config.enableDashboards === true ? ["generate_dashboard"] : []),
    ...(config.enableWidgets === true ? ["show_widget"] : []),
  ];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha(value) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function hashPath(value) {
  if (!value || typeof value !== "string") return undefined;
  if (!(await exists(value))) return { kind: "path", path: value, state: "missing" };
  const info = await stat(value);
  if (info.isDirectory()) {
    const hash = createHash("sha256");
    const walk = async (directory, relative = "") => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const child = path.join(directory, entry.name);
        const childRelative = path.join(relative, entry.name).split(path.sep).join("/");
        hash.update(childRelative);
        if (entry.isDirectory()) await walk(child, childRelative);
        else if (entry.isFile()) hash.update(await readFile(child));
      }
    };
    await walk(value);
    return { kind: "path", path: path.resolve(value), state: "present", entryType: "directory", sha256: hash.digest("hex") };
  }
  if (!info.isFile()) return { kind: "path", path: path.resolve(value), state: "present", entryType: "other", sha256: contentHash(path.resolve(value)) };
  const bytes = await readFile(value);
  return { kind: "path", path: path.resolve(value), state: "present", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
}

async function hashInput(value, name) {
  if (typeof value === "string") {
    const pathIdentity = await hashPath(value);
    if (pathIdentity?.state === "present") return { name, ...pathIdentity };
    return { name, kind: "content", sha256: contentHash(value), bytes: Buffer.byteLength(value, "utf8") };
  }
  if (isRecord(value) && typeof value.path === "string") return { name, ...(await hashInput(value.path, name)) };
  if (isRecord(value) && value.kind === "declared-digest" && typeof value.sha256 === "string") {
    return { name, kind: "declared-digest", state: "declared", sha256: value.sha256.toLowerCase() };
  }
  if (value === undefined || value === null) return { name, state: "missing" };
  return { name, kind: "json", sha256: contentHash(value) };
}

function assertKnownKeys(value, allowed, label) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`UNSUPPORTED_CONFIG_FIELD:${label}.${key}`);
}

function assertNoInlineSecrets(value, pathName = "config") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${pathName}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (INLINE_SECRET_KEYS.test(key) && typeof item === "string" && item.trim() && !key.endsWith("Env")) throw new Error(`INLINE_SECRET_FORBIDDEN:${pathName}.${key}`);
    assertNoInlineSecrets(item, `${pathName}.${key}`);
  }
}

export function validateExperimentConfig(config) {
  if (!isRecord(config)) throw new Error("EXPERIMENT_CONFIG_REQUIRED");
  assertKnownKeys(config, TOP_LEVEL_KEYS, "root");
  assertNoInlineSecrets(config);
  assertKnownKeys(config.limits, LIMIT_KEYS, "limits");
  if (config.limits?.maxExploratoryQueries !== undefined && config.limits.maxExploratoryQueries !== null) {
    throw new Error("DEPRECATED_CONFIG_FIELD:limits.maxExploratoryQueries:use_queryTask_maxExplorationAttempts");
  }
  if (config.concurrency !== undefined && (!Number.isSafeInteger(Number(config.concurrency)) || Number(config.concurrency) < 1)) throw new Error("INVALID_CONFIG_VALUE:concurrency");
  if (config.localDatabasePackSha256 !== undefined && config.localDatabasePackSha256 !== null
    && (typeof config.localDatabasePackSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(config.localDatabasePackSha256))) {
    throw new Error("INVALID_CONFIG_VALUE:localDatabasePackSha256");
  }
  if (config.limits?.maxTurns !== undefined && config.limits.maxTurns !== null && (!Number.isSafeInteger(Number(config.limits.maxTurns)) || Number(config.limits.maxTurns) < 1)) throw new Error("INVALID_CONFIG_VALUE:limits.maxTurns");
  if (config.limits?.maxToolCalls !== undefined && config.limits.maxToolCalls !== null && (!Number.isSafeInteger(Number(config.limits.maxToolCalls)) || Number(config.limits.maxToolCalls) < 1)) throw new Error("INVALID_CONFIG_VALUE:limits.maxToolCalls");
  resolveSemanticSpecMode(config);
  // ADR-0007: set_answer_spec is the only Answer Spec interface; the phase-1 switch is gone.
  if (config.answering?.specInterface !== undefined) throw new Error("DEPRECATED_CONFIG_FIELD:answering.specInterface");
  if (config.enableClarificationTool !== undefined && typeof config.enableClarificationTool !== "boolean") throw new Error("INVALID_CONFIG_VALUE:enableClarificationTool");
  return config;
}

function resolveQueryBudget(config) {
  const configured = config.queryTask ?? config.answering?.budgetPolicy ?? config.answering ?? {};
  const aliases = {
    maxRevisions: configured.maxRevisions,
    maxExplorationAttempts: configured.maxExplorationAttempts,
    maxResultAttempts: configured.maxResultAttempts,
    maxElapsedMs: configured.maxElapsedMs,
    maxObservedRows: configured.maxObservedRows,
  };
  const policy = { ...DEFAULT_QUERY_TASK_BUDGET };
  for (const [key, value] of Object.entries(aliases)) if (value !== undefined && value !== null) policy[key] = Number(value);
  for (const key of Object.keys(policy).filter((item) => item !== "version")) if (!Number.isSafeInteger(policy[key]) || policy[key] < 1) throw new Error(`INVALID_QUERY_TASK_BUDGET:${key}`);
  return policy;
}

function modelIdentity(config) {
  const llm = config.llm ?? {};
  return {
    provider: llm.provider ?? "openai",
    model: llm.model ?? null,
    apiFormat: llm.apiFormat ?? null,
    ...(llm.reasoning !== undefined ? { reasoning: Boolean(llm.reasoning) } : {}),
    ...(llm.thinkingLevel ? { thinkingLevel: llm.thinkingLevel } : {}),
    ...(llm.contextWindow !== undefined ? { contextWindow: Number(llm.contextWindow) } : {}),
    ...(llm.maxTokens !== undefined ? { maxTokens: Number(llm.maxTokens) } : {}),
    ...(config.selectedModelProfile ? { profile: config.selectedModelProfile } : {}),
  };
}

function capability(config, configured, resolved = configured) {
  return {
    configured,
    resolved,
    executed: "unknown",
    coverage: "not_started",
  };
}

function configuredCapabilities(config, activeTools, semanticSpecMode) {
  const assurance = config.assurance ?? {};
  const advisor = config.hypothesisAdvisor ?? assurance.enumerator ?? assurance.plannerLlm;
  const jevAvailable = Boolean(process.env.TYPESAFE_API_KEY?.trim());
  const fanoutEnabled = config.answering?.fanout?.enabled !== false;
  return {
    tools: capability(config, [...activeTools], [...activeTools]),
    semanticSpec: capability(config, semanticSpecMode, semanticSpecMode),
    fanout: capability(config, fanoutEnabled, fanoutEnabled),
    hypothesisAdvisor: capability(config, Boolean(advisor || jevAvailable), jevAvailable),
    delegation: capability(config, config.enableSubagents !== false, config.enableSubagents !== false),
    clarification: capability(config, config.enableClarificationTool !== false, config.enableClarificationTool !== false),
    widgets: capability(config, config.enableWidgets === true, config.enableWidgets === true),
    dashboards: capability(config, config.enableDashboards === true, config.enableDashboards === true),
  };
}

async function inputIdentities(config, input) {
  const paths = input?.paths ?? {};
  const source = {
    systemPrompt: input?.systemPrompt ?? paths.systemPrompt ?? path.join(process.cwd(), ".pi", "SYSTEM.md"),
    dataset: input?.dataset ?? config.datasetPath,
    evaluator: input?.evaluator ?? (config.evaluationSuite ? path.join(config.evaluationSuite, "evaluate.py") : undefined),
    runtimeBuild: input?.runtimeBuild ?? paths.runtimeBuild,
    serverBuild: input?.serverBuild ?? paths.serverBuild,
    skills: input?.skills ?? paths.skills,
    knowledge: input?.knowledge ?? paths.knowledge,
    toolPromptCatalog: input?.toolPromptCatalog ?? paths.toolPromptCatalog,
    runtimeSource: input?.runtimeSource ?? paths.runtimeSource,
    runner: input?.runner ?? paths.runner,
    library: input?.library ?? paths.library,
    config: input?.config ?? paths.config ?? config.__path,
    database: input?.database ?? paths.database ?? (config.localDatabasePackSha256 ? { kind: "declared-digest", sha256: config.localDatabasePackSha256 } : undefined),
  };
  const identities = {};
  for (const [name, value] of Object.entries(source)) identities[name] = await hashInput(value, name);
  return identities;
}

export async function resolveExperiment(input = {}) {
  const config = input.config ?? input;
  validateExperimentConfig(config);
  const semanticSpecMode = resolveSemanticSpecMode(config);
  const configuredTools = input.activeTools ?? config.inputs?.activeTools ?? defaultTools(config, semanticSpecMode);
  const activeTools = [...configuredTools].filter((tool) => tool !== "subagent" || config.enableSubagents !== false);
  const identities = await inputIdentities(config, input.inputs ?? config.inputs);
  const subject = modelIdentity(config);
  const capabilities = configuredCapabilities(config, activeTools, semanticSpecMode);
  const budgets = {
    episode: {
      timeoutMs: config.limits?.timeoutMs ?? null,
      maxTurns: config.limits?.maxTurns ?? null,
      maxToolCalls: config.limits?.maxToolCalls ?? null,
    },
    queryTask: resolveQueryBudget(config),
    delegation: {
      maxTasks: config.delegation?.maxTasks ?? null,
      maxConcurrent: config.delegation?.maxConcurrent ?? null,
      timeoutMs: config.delegation?.timeoutMs ?? null,
      maxToolCalls: config.delegation?.maxToolCalls ?? null,
    },
  };
  const suite = {
    name: input.suiteName ?? "spider2-lite",
    dataset: config.datasetPath ?? null,
    evaluator: config.evaluationSuite ?? null,
    instanceIds: input.instanceIds ? [...input.instanceIds].sort() : null,
    version: input.suiteVersion ?? null,
  };
  const resolved = {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    suite,
    subject,
    capabilities,
    budgets,
    inputs: identities,
    scoring: {
      scorer: config.scoring?.scorer ?? "official-spider2-evaluator",
      version: config.scoring?.version ?? null,
      parameters: config.scoring?.parameters ?? {},
    },
    attemptPolicy: {
      continue: config.attemptPolicy?.continue ?? "same_attempt",
      retry: config.attemptPolicy?.retry ?? "new_attempt",
      includeInPrimary: config.attemptPolicy?.includeInPrimary ?? "first_complete_or_explicit_policy",
    },
    comparisonPolicy: {
      fixedFactors: config.comparisonPolicy?.fixedFactors ?? ["suite", "inputs.dataset", "inputs.database", "scoring"],
      allowedFactors: config.comparisonPolicy?.allowedFactors ?? ["subject", "capabilities", "budgets"],
      repetitions: config.comparisonPolicy?.repetitions ?? 1,
    },
    configPath: config.__path ?? null,
  };
  resolved.experimentId = sha({ ...resolved, experimentId: undefined });
  return resolved;
}

export function manifestFromExperiment(experiment, extra = {}) {
  if (!experiment || experiment.schemaVersion !== EXPERIMENT_SCHEMA_VERSION) throw new Error("EXPERIMENT_IDENTITY_REQUIRED");
  return {
    schemaVersion: EXPERIMENT_SCHEMA_VERSION,
    experimentId: experiment.experimentId,
    suite: experiment.suite,
    subject: experiment.subject,
    capabilities: experiment.capabilities,
    budgets: experiment.budgets,
    inputs: experiment.inputs,
    scoring: experiment.scoring,
    attemptPolicy: experiment.attemptPolicy,
    comparisonPolicy: experiment.comparisonPolicy,
    ...extra,
  };
}

export function assertComparableExperiments(left, right) {
  if (!left?.experimentId || !right?.experimentId) throw new Error("EXPERIMENT_IDENTITY_REQUIRED");
  const fixed = (experiment) => ({
    suite: experiment.suite,
    inputs: { dataset: experiment.inputs?.dataset, database: experiment.inputs?.database },
    scoring: experiment.scoring,
  });
  const leftFixed = stableStringify(fixed(left));
  const rightFixed = stableStringify(fixed(right));
  const onlyExpectedDifferences = leftFixed === rightFixed;
  return {
    comparable: onlyExpectedDifferences,
    onlyExpectedDifferences,
    fixedFactorsMatch: onlyExpectedDifferences,
    differences: onlyExpectedDifferences ? [] : ["suite_or_fixed_inputs_or_scoring"],
  };
}

