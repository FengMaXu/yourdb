#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FINISHED_STATUSES = new Set(["completed", "timeout", "max_turns"]);

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readIdsFile(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const str = String(value);
    if (!seen.has(str)) {
      seen.add(str);
      out.push(str);
    }
  }
  return out;
}

function listSubdirs(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function resolveTargetInstanceIds({ runDir, casesDir, idsFile, instanceIds }) {
  if (Array.isArray(instanceIds)) {
    return dedupeStrings(instanceIds);
  }
  if (idsFile) {
    return dedupeStrings(readIdsFile(path.resolve(idsFile)));
  }
  if (runDir) {
    const manifest = readJsonSafe(path.join(runDir, "manifest.json"));
    if (Array.isArray(manifest?.instanceIds) && manifest.instanceIds.length > 0) {
      return dedupeStrings(manifest.instanceIds);
    }
  }
  return listSubdirs(casesDir);
}

function resolveAttemptDir(caseDir) {
  const attemptsDir = path.join(caseDir, "attempts");
  if (!existsSync(attemptsDir)) {
    return existsSync(path.join(caseDir, "trace.json")) ? caseDir : undefined;
  }

  const attemptsDesc = listSubdirs(attemptsDir).reverse();
  for (const attemptName of attemptsDesc) {
    const attemptDir = path.join(attemptsDir, attemptName);
    const result = readJsonSafe(path.join(attemptDir, "result.json"));
    if (result && FINISHED_STATUSES.has(result.status)) {
      return attemptDir;
    }
  }

  for (const attemptName of attemptsDesc) {
    const attemptDir = path.join(attemptsDir, attemptName);
    if (existsSync(path.join(attemptDir, "trace.json"))) {
      return attemptDir;
    }
  }

  return undefined;
}

function findDatabaseIdentityPath(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.databaseIdentity?.path === "string" && value.databaseIdentity.path.trim()) {
    return value.databaseIdentity.path;
  }
  for (const child of Object.values(value)) {
    const found = findDatabaseIdentityPath(child);
    if (found) return found;
  }
  return undefined;
}

function loadSuiteDbMap(evaluationSuite) {
  const map = new Map();
  if (!evaluationSuite) return map;
  const liteRoot = path.resolve(evaluationSuite, "..");
  const jsonlPath = path.join(liteRoot, "spider2-lite.jsonl");
  if (!existsSync(jsonlPath)) return map;

  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item?.instance_id && item?.db) {
        map.set(String(item.instance_id), String(item.db));
      }
    } catch {
      // Ignore malformed lines in metadata fallback.
    }
  }
  return map;
}

function resolveCaseDbPath(attemptDir, caseDir, instanceId, evaluationSuite, getSuiteDbMap) {
  const searchDirs = attemptDir === caseDir ? [attemptDir] : [attemptDir, caseDir];
  for (const dir of searchDirs) {
    for (const fileName of ["result.json", "attempt.json"]) {
      const parsed = readJsonSafe(path.join(dir, fileName));
      const found = findDatabaseIdentityPath(parsed);
      if (found) return found;
    }
  }

  if (evaluationSuite) {
    const dbName = getSuiteDbMap().get(instanceId);
    if (dbName) {
      return path.resolve(evaluationSuite, "..", "resource", "databases", "spider2-localdb", `${dbName}.sqlite`);
    }
  }
  return undefined;
}

function makeProbeKey(instanceId, fieldPath, alternativeId) {
  return JSON.stringify([instanceId, fieldPath, alternativeId]);
}

/**
 * Extract deduplicated probed fields and their alternative SQLs from a Spider2 run directory.
 */
export function extractProbedFieldsFromRun({
  runDir,
  casesDir,
  evaluationSuite,
  idsFile,
  instanceIds,
} = {}) {
  const resolvedRunDir = runDir ? path.resolve(runDir) : undefined;
  const resolvedCasesDir = casesDir
    ? path.resolve(casesDir)
    : resolvedRunDir
      ? path.join(resolvedRunDir, "cases")
      : undefined;

  if (!resolvedCasesDir) {
    throw new Error("extractProbedFieldsFromRun requires runDir or casesDir");
  }

  const targetIds = resolveTargetInstanceIds({
    runDir: resolvedRunDir,
    casesDir: resolvedCasesDir,
    idsFile,
    instanceIds,
  });

  let suiteDbMapCache;
  const getSuiteDbMap = () => {
    if (!suiteDbMapCache) {
      suiteDbMapCache = loadSuiteDbMap(evaluationSuite);
    }
    return suiteDbMapCache;
  };

  const probedFields = [];
  for (const instanceId of targetIds) {
    const caseDir = path.join(resolvedCasesDir, instanceId);
    if (!existsSync(caseDir)) continue;

    const attemptDir = resolveAttemptDir(caseDir);
    if (!attemptDir) continue;

    const trace = readJsonSafe(path.join(attemptDir, "trace.json"));
    const toolCalls = Array.isArray(trace?.toolCalls) ? trace.toolCalls : [];

    // Keep latest SQL per (path, alternativeId) while grouping by path.
    const byPath = new Map();
    for (const call of toolCalls) {
      if (
        call?.toolName === "query_database"
        && call.args?.probe?.path
        && call.args?.probe?.alternativeId
        && typeof call.args?.sql === "string"
      ) {
        const fieldPath = String(call.args.probe.path);
        const alternativeId = String(call.args.probe.alternativeId);
        let altMap = byPath.get(fieldPath);
        if (!altMap) {
          altMap = new Map();
          byPath.set(fieldPath, altMap);
        }
        altMap.set(alternativeId, call.args.sql);
      }
    }

    if (byPath.size === 0) continue;

    const dbPath = resolveCaseDbPath(attemptDir, caseDir, instanceId, evaluationSuite, getSuiteDbMap);
    for (const [fieldPath, altMap] of byPath.entries()) {
      const alternatives = [];
      for (const [alternativeId, sql] of altMap.entries()) {
        alternatives.push({
          alternativeId,
          sql,
          key: makeProbeKey(instanceId, fieldPath, alternativeId),
        });
      }
      probedFields.push({
        instanceId,
        path: fieldPath,
        dbPath,
        alternatives,
      });
    }
  }

  return probedFields;
}

function lookupLabelMatch(labelByKey, key) {
  if (!labelByKey) return undefined;
  if (labelByKey instanceof Map) {
    return labelByKey.has(key) ? labelByKey.get(key) : undefined;
  }
  if (typeof labelByKey === "object" && Object.prototype.hasOwnProperty.call(labelByKey, key)) {
    return labelByKey[key];
  }
  return undefined;
}

function isAlternativeMatched(field, alt, labelByKey) {
  const candidates = [];
  if (alt?.key !== undefined) candidates.push(String(alt.key));
  const instanceId = String(field.instanceId ?? "");
  const fieldPath = String(field.path ?? "");
  const alternativeId = String(alt?.alternativeId ?? "");
  candidates.push(
    makeProbeKey(instanceId, fieldPath, alternativeId),
    `${instanceId}::${fieldPath}::${alternativeId}`,
    `${instanceId}|${fieldPath}|${alternativeId}`,
  );

  for (const key of candidates) {
    const entry = lookupLabelMatch(labelByKey, key);
    if (entry !== undefined) {
      return typeof entry === "boolean" ? entry : Boolean(entry?.match);
    }
  }
  return false;
}

/**
 * Aggregate gold-match labels over probed fields into Oracle@Probe summary metrics.
 * When `blind === true`, omits `fields` and all case identifiers.
 */
export function aggregateProbeLabels(probedFields = [], labelByKey = new Map(), { blind = false } = {}) {
  const isBlind = Boolean(blind);
  const fieldsList = [];
  const caseFieldCoverages = new Map();

  let fieldsWithGoldCandidate = 0;
  let fieldsUniqueGold = 0;
  let fieldsSeveralGold = 0;
  let fieldsNoGold = 0;

  for (const field of probedFields ?? []) {
    const alternatives = Array.isArray(field.alternatives) ? field.alternatives : [];
    let matchedAlternatives = 0;
    for (const alt of alternatives) {
      if (isAlternativeMatched(field, alt, labelByKey)) {
        matchedAlternatives += 1;
      }
    }

    const hasGoldCandidate = matchedAlternatives >= 1;
    let matchCategory = "none";
    if (matchedAlternatives === 1) {
      matchCategory = "unique";
      fieldsUniqueGold += 1;
    } else if (matchedAlternatives >= 2) {
      matchCategory = "several";
      fieldsSeveralGold += 1;
    } else {
      fieldsNoGold += 1;
    }

    if (hasGoldCandidate) {
      fieldsWithGoldCandidate += 1;
    }

    const caseId = String(field.instanceId);
    if (!caseFieldCoverages.has(caseId)) {
      caseFieldCoverages.set(caseId, []);
    }
    caseFieldCoverages.get(caseId).push(hasGoldCandidate);

    if (!isBlind) {
      fieldsList.push({
        instanceId: caseId,
        path: String(field.path),
        alternativesTotal: alternatives.length,
        alternativesMatched: matchedAlternatives,
        hasGoldCandidate,
        matchCategory,
      });
    }
  }

  const fieldsTotal = (probedFields ?? []).length;
  const casesWithOpenFields = caseFieldCoverages.size;
  let casesWithAllOpenCovered = 0;
  let casesWithAnyGoldProbe = 0;
  for (const coverages of caseFieldCoverages.values()) {
    if (coverages.every(Boolean)) casesWithAllOpenCovered += 1;
    if (coverages.some(Boolean)) casesWithAnyGoldProbe += 1;
  }

  return {
    schemaVersion: 1,
    blind: isBlind,
    fieldsTotal,
    fieldsWithGoldCandidate,
    fieldRate: fieldsTotal > 0 ? fieldsWithGoldCandidate / fieldsTotal : 0,
    fieldsUniqueGold,
    fieldsSeveralGold,
    fieldsNoGold,
    casesWithOpenFields,
    casesWithAllOpenCovered,
    casesWithAnyGoldProbe,
    ...(isBlind ? {} : { fields: fieldsList }),
  };
}

/**
 * Extract probed alternatives from a run, evaluate each alternative against Spider2 gold
 * via `label_probe_alternatives.py`, and return aggregated Oracle@Probe metrics.
 */
export function runOracleProbeSummary({
  runDir,
  casesDir,
  evaluationSuite,
  pythonExecutable = "python",
  idsFile,
  instanceIds,
  blind = false,
} = {}) {
  const probedFields = extractProbedFieldsFromRun({
    runDir,
    casesDir,
    evaluationSuite,
    idsFile,
    instanceIds,
  });

  const items = [];
  for (const field of probedFields) {
    if (!field.dbPath) continue;
    for (const alt of field.alternatives) {
      items.push({
        key: alt.key,
        instanceId: field.instanceId,
        dbPath: field.dbPath,
        sql: alt.sql,
      });
    }
  }

  const labelByKey = new Map();
  if (items.length > 0) {
    if (!evaluationSuite) {
      throw new Error("evaluationSuite is required when labeling probed alternatives");
    }
    const input = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const result = spawnSync(
      pythonExecutable,
      [path.join(here, "label_probe_alternatives.py"), path.resolve(evaluationSuite)],
      {
        input,
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    if (result.error) {
      throw new Error(`Failed to invoke ${pythonExecutable} for label_probe_alternatives.py: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim().slice(0, 500);
      const stdout = (result.stdout || "").trim().slice(0, 500);
      const detail = stderr || stdout || `exit status ${result.status}`;
      throw new Error(`label_probe_alternatives.py failed (${result.status}): ${detail}`);
    }

    for (const line of (result.stdout || "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line);
      labelByKey.set(parsed.key, Boolean(parsed.match));
    }
  }

  return aggregateProbeLabels(probedFields, labelByKey, { blind });
}

function requireArgValue(argv, index, flag) {
  if (index + 1 >= argv.length) {
    throw new Error(`MISSING_ARGUMENT_VALUE: ${flag}`);
  }
  return argv[index + 1];
}

function parseCliArgs(argv) {
  const opts = { blind: false, python: "python" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--blind") {
      opts.blind = true;
    } else if (arg === "--run") {
      opts.run = requireArgValue(argv, i, arg);
      i += 1;
    } else if (arg === "--evaluation-suite") {
      opts.evaluationSuite = requireArgValue(argv, i, arg);
      i += 1;
    } else if (arg === "--python") {
      opts.python = requireArgValue(argv, i, arg);
      i += 1;
    } else if (arg === "--ids-file") {
      opts.idsFile = requireArgValue(argv, i, arg);
      i += 1;
    } else if (arg === "--out") {
      opts.out = requireArgValue(argv, i, arg);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`UNKNOWN_ARGUMENT: ${arg}`);
    }
  }
  return opts;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help || !opts.run || !opts.evaluationSuite) {
    console.log(
      "Usage: node evaluations/spider2/oracle-probe-summary.mjs --run <runDir> --evaluation-suite <suiteDir> [--python <exe>] [--ids-file <path>] [--blind] [--out <json>]",
    );
    process.exit(opts.help ? 0 : 1);
  }

  const summary = runOracleProbeSummary({
    runDir: path.resolve(opts.run),
    evaluationSuite: path.resolve(opts.evaluationSuite),
    pythonExecutable: opts.python,
    idsFile: opts.idsFile ? path.resolve(opts.idsFile) : undefined,
    blind: opts.blind,
  });

  const jsonText = `${JSON.stringify(summary, null, 2)}\n`;
  if (opts.out) {
    const outPath = path.resolve(opts.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, jsonText, "utf8");
  }
  process.stdout.write(jsonText);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
