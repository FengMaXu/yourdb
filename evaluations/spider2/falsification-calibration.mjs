#!/usr/bin/env node
// Offline replay calibration for the plan's T4.2 (result_domain) and T4.3
// (data_falsification) rules, as ADR-0003 requires before any rule may block:
// run each rule on historical final SQL + delivered rows, and count how often
// it fires on wrong answers (recall) and on correct answers (false positives),
// on a development run and on an independent holdout run.
//
// Usage:
//   npm run build:runtime
//   node evaluations/spider2/falsification-calibration.mjs \
//     --dev C:/Users/Lenovo/data-agent-eval/fewshot135-case-evidence.jsonl \
//     --holdout C:/Users/Lenovo/data-agent-eval/runs-gpt55-system0904/system0904-gpt55-paired040-default-001 \
//     --databases C:/data-agent-eval/Spider2/spider2-lite/resource/databases/spider2-localdb \
//     --labels evaluations/spider2/wrong118-classification-adjudicated.jsonl \
//     --out docs/answering-falsification-calibration.json
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const dist = (file) => pathToFileURL(path.join(root, "packages/runtime/dist/answering", file)).href;
const { evaluateDataFalsification } = await import(dist("data-falsification.js"));
const { evaluateResultDomain } = await import(dist("result-domain.js"));
const { maskSql } = await import(dist("sql-lex.js"));

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[argv[index].replace(/^--/, "")] = argv[index + 1];
  return out;
}

/** CSV text to rows; quoted fields with doubled quotes, as the Spider2 submissions write them. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index++; }
      else if (char === "\"") quoted = false;
      else field += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * The measure op the final SELECT computes, read from its last output
 * expression. Historical runs predate the field-tree Spec, so this stands in
 * for measure.formula; a final SELECT that only renames a CTE column has none.
 */
export function inferMeasureOp(sql) {
  const masked = maskSql(sql).toLowerCase();
  const depths = [];
  let depth = 0;
  for (const char of masked) { depths.push(depth); if (char === "(") depth++; else if (char === ")") depth = Math.max(0, depth - 1); }
  const selects = [...masked.matchAll(/\bselect\b/g)].filter((match) => depths[match.index] === 0);
  const last = selects.at(-1);
  if (!last) return undefined;
  const from = [...masked.matchAll(/\bfrom\b/g)].find((match) => match.index > last.index && depths[match.index] === 0);
  const list = masked.slice(last.index + 6, from ? from.index : masked.length);
  const items = [];
  let start = 0;
  for (let index = 0; index < list.length; index++) if (list[index] === "," && depths[last.index + 6 + index] === 0) { items.push(list.slice(start, index)); start = index + 1; }
  items.push(list.slice(start));
  const item = items.at(-1) ?? "";
  // A division or a factor of 100 decides over a COUNT inside it: COUNT(x) * 1.0 / COUNT(*) is a ratio.
  if (/\*\s*100(\.0*)?\b|\b100(\.0*)?\s*\*/.test(item)) return "percentage";
  if (/\//.test(item)) return "ratio";
  // An aggregate around the expression (AVG(...), ROUND(...)) is not the count itself.
  if (/^\s*(avg|sum|min|max|round|cast|coalesce)\s*\(/.test(item)) return undefined;
  if (/\bcount\s*\(\s*distinct\b/.test(item)) return "count_distinct";
  if (/\bcount\s*\(/.test(item)) return "count";
  return undefined;
}

function sqliteExecutor(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    dialect: "sqlite",
    run: async (sql, limit) => {
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      for (const row of statement.iterate()) {
        rows.push(columns.map((column) => row[column]));
        if (rows.length > limit) break;
      }
      return { columns, rows: rows.slice(0, limit), truncated: rows.length > limit };
    },
    close: () => db.close(),
  };
}

function devCases(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((item) => item.finalSql && item.predCsv && item.predCsv.rows.length === item.predCsv.n)
    .map((item) => ({ id: item.id, db: item.db, correct: item.score === 1, sql: item.finalSql, columns: item.predCsv.header, rows: item.predCsv.rows }));
}

function holdoutCases(runDir) {
  const scores = JSON.parse(readFileSync(path.join(runDir, "official_score/summary.json"), "utf8")).sql.caseScores;
  const meta = new Map(readFileSync(path.join(runDir, "cases.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((item) => [item.instanceId, item]));
  return Object.entries(scores).flatMap(([id, score]) => {
    const sqlFile = path.join(runDir, "submissions/sql", `${id}.sql`);
    const csvFile = path.join(runDir, "submissions/csv", `${id}.csv`);
    if (!existsSync(sqlFile) || !existsSync(csvFile)) return [];
    const [columns = [], ...rows] = parseCsv(readFileSync(csvFile, "utf8"));
    return [{ id, db: meta.get(id)?.db, correct: score === 1, sql: readFileSync(sqlFile, "utf8"), columns, rows }];
  });
}

const context = { principal: { id: "calibration" }, sessionId: "calibration", lane: "main", operationId: "calibration", invocationId: "calibration" };

/** Spider2 names a database SQLITE_SAKILA where the pack's file is sqlite-sakila.sqlite. */
export function databaseFile(databases, name) {
  if (!name) return undefined;
  const key = (text) => text.toLowerCase().replace(/\.sqlite$/, "").replace(/[^a-z0-9]/g, "");
  const match = readdirSync(databases).find((file) => file.endsWith(".sqlite") && key(file) === key(name));
  return match ? path.join(databases, match) : undefined;
}

async function evaluate(cases, databases) {
  const out = [];
  for (const item of cases) {
    const file = databaseFile(databases, item.db);
    const op = inferMeasureOp(item.sql);
    const domain = op
      ? evaluateResultDomain({ "measure.formula": { state: "specified", value: { op, of: "measure" }, basis: { kind: "assumed" } } }, { columns: item.columns, rows: item.rows })
      : { kind: "not_applicable", reason: "no measure op in the final SELECT" };
    let falsification = { status: "unknown", findings: [], limitations: ["database missing"], applied: [] };
    if (file && existsSync(file)) {
      const executor = sqliteExecutor(file);
      try {
        falsification = await evaluateDataFalsification(executor, item.sql, { rows: item.rows }, context, { timeoutMs: 10_000 });
      } finally {
        executor.close();
      }
    }
    out.push({
      id: item.id,
      correct: item.correct,
      measureOp: op ?? null,
      resultDomain: domain.kind === "finding" ? { outcome: "finding", rule: domain.rule, message: domain.message } : { outcome: domain.kind },
      dataFalsification: { outcome: falsification.status, rules: falsification.findings.map((finding) => finding.rule), applied: falsification.applied, findings: falsification.findings.map((finding) => finding.message), limitations: falsification.limitations },
    });
  }
  return out;
}

/** Per rule: fires on wrong (recall over wrong answers) and on correct (false positive rate over correct answers). */
function tally(results, labels) {
  const rules = new Map();
  const bump = (rule, item) => {
    const entry = rules.get(rule) ?? { rule, wrongHits: [], correctHits: [] };
    (item.correct ? entry.correctHits : entry.wrongHits).push(item.id);
    rules.set(rule, entry);
  };
  for (const item of results) {
    if (item.resultDomain.outcome === "finding") bump(`result_domain.${item.resultDomain.rule}`, item);
    for (const rule of new Set(item.dataFalsification.rules)) bump(`data_falsification.${rule}`, item);
  }
  const wrong = results.filter((item) => !item.correct).length;
  const correct = results.filter((item) => item.correct).length;
  const layer = (id) => labels.get(id) ?? "unlabelled";
  return {
    cases: results.length,
    wrong,
    correct,
    coverage: {
      resultDomain: Object.fromEntries(["finding", "clear", "not_applicable", "unknown"].map((key) => [key, results.filter((item) => item.resultDomain.outcome === key).length])),
      dataFalsification: Object.fromEntries(["finding", "clear", "not_applicable", "unknown"].map((key) => [key, results.filter((item) => item.dataFalsification.outcome === key).length])),
    },
    rules: [...rules.values()].map((entry) => ({
      rule: entry.rule,
      wrongHits: entry.wrongHits.length,
      recallOnWrong: wrong ? entry.wrongHits.length / wrong : 0,
      correctHits: entry.correctHits.length,
      falsePositiveRateOnCorrect: correct ? entry.correctHits.length / correct : 0,
      wrongCases: entry.wrongHits.map((id) => ({ id, errorLayer: layer(id) })),
      correctCases: entry.correctHits,
    })),
  };
}

async function main() {
  const options = args(process.argv.slice(2));
  const labels = new Map();
  if (options.labels && existsSync(options.labels)) {
    for (const line of readFileSync(options.labels, "utf8").split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      labels.set(item.instance_id, item.error_layer);
    }
  }
  const databases = options.databases;
  if (!databases || !existsSync(databases) || readdirSync(databases).length === 0) throw new Error(`--databases ${databases} has no SQLite files`);
  const dev = await evaluate(devCases(options.dev), databases);
  const holdout = options.holdout ? await evaluate(holdoutCases(options.holdout), databases) : [];
  const report = {
    generatedAt: new Date().toISOString(),
    ruleVersions: { resultDomain: "result-domain-v1", dataFalsification: "data-falsification-v1" },
    sources: { dev: options.dev, holdout: options.holdout ?? null, databases },
    dev: { ...tally(dev, labels), cases: dev },
    holdout: { ...tally(holdout, labels), cases: holdout },
  };
  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  const summary = (name, part) => [
    `${name}: ${part.wrong} wrong, ${part.correct} correct`,
    ...part.rules.map((rule) => `  ${rule.rule}: wrong ${rule.wrongHits}/${part.wrong} (${(100 * rule.recallOnWrong).toFixed(1)}%), correct ${rule.correctHits}/${part.correct} (${(100 * rule.falsePositiveRateOnCorrect).toFixed(1)}%)`),
    `  coverage result_domain ${JSON.stringify(part.coverage.resultDomain)}, data_falsification ${JSON.stringify(part.coverage.dataFalsification)}`,
  ].join("\n");
  console.log(summary("dev", report.dev));
  console.log(summary("holdout", report.holdout));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
