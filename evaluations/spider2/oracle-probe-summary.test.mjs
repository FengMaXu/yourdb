import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  aggregateProbeLabels,
  extractProbedFieldsFromRun,
  runOracleProbeSummary,
} from "./oracle-probe-summary.mjs";
import { computeStratifiedScoreboard, formatStratifiedMarkdown } from "./stratified-scoring.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("extractProbedFieldsFromRun picks latest finished attempt, handles fallbacks, and deduplicates re-probed alternatives", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "oracle-probe-extract-"));
  try {
    const runDir = path.join(tmpDir, "run");
    const liteRoot = path.join(tmpDir, "spider2-lite");
    const evaluationSuite = path.join(liteRoot, "evaluation_suite");
    mkdirSync(evaluationSuite, { recursive: true });
    writeFileSync(
      path.join(liteRoot, "spider2-lite.jsonl"),
      `${JSON.stringify({ instance_id: "local102", db: "fallback_db", question: "q" })}\n`,
    );

    // local101: attempt-001 completed, attempt-002 timeout (latest finished), attempt-003 failed (must be ignored)
    const c1a1 = path.join(runDir, "cases", "local101", "attempts", "attempt-001");
    const c1a2 = path.join(runDir, "cases", "local101", "attempts", "attempt-002");
    const c1a3 = path.join(runDir, "cases", "local101", "attempts", "attempt-003");
    mkdirSync(c1a1, { recursive: true });
    mkdirSync(c1a2, { recursive: true });
    mkdirSync(c1a3, { recursive: true });

    writeFileSync(path.join(c1a1, "result.json"), JSON.stringify({ status: "completed" }));
    writeFileSync(path.join(c1a1, "trace.json"), JSON.stringify({
      toolCalls: [
        { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "old_alt" }, sql: "SELECT 999" } },
      ],
    }));

    writeFileSync(path.join(c1a2, "result.json"), JSON.stringify({
      status: "timeout",
      nested: { databaseIdentity: { path: "/tmp/db101.sqlite" } },
    }));
    writeFileSync(path.join(c1a2, "trace.json"), JSON.stringify({
      toolCalls: [
        { toolName: "other_tool", args: { probe: { path: "metric", alternativeId: "a1" }, sql: "SELECT 0" } },
        { toolName: "query_database", args: { sql: "SELECT 1" } }, // no probe metadata
        { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "a1" }, sql: "SELECT 1 AS v" } },
        { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "a2" }, sql: "SELECT 2 AS v" } },
        // Re-probed (metric, a1) later in the same trace -> must keep latest SQL
        { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "a1" }, sql: "SELECT 10 AS v" } },
        { toolName: "query_database", args: { probe: { path: "filter", alternativeId: "f1" }, sql: "SELECT 3 AS f" } },
      ],
    }));

    writeFileSync(path.join(c1a3, "result.json"), JSON.stringify({ status: "failed" }));
    writeFileSync(path.join(c1a3, "trace.json"), JSON.stringify({
      toolCalls: [
        { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "broken" }, sql: "SELECT -1" } },
      ],
    }));

    // local102: no finished result.json -> falls back to latest attempt with trace.json; dbPath falls back via spider2-lite.jsonl
    const c2a1 = path.join(runDir, "cases", "local102", "attempts", "attempt-001");
    const c2a2 = path.join(runDir, "cases", "local102", "attempts", "attempt-002");
    mkdirSync(c2a1, { recursive: true });
    mkdirSync(c2a2, { recursive: true });
    writeFileSync(path.join(c2a1, "trace.json"), JSON.stringify({
      toolCalls: [{ toolName: "query_database", args: { probe: { path: "scope", alternativeId: "old" }, sql: "SELECT 0" } }],
    }));
    writeFileSync(path.join(c2a2, "trace.json"), JSON.stringify({
      toolCalls: [{ toolName: "query_database", args: { probe: { path: "scope", alternativeId: "s1" }, sql: "SELECT 42" } }],
    }));

    // local103: legacy layout without attempts/ directory (direct trace.json + attempt.json)
    const c3 = path.join(runDir, "cases", "local103");
    mkdirSync(c3, { recursive: true });
    writeFileSync(path.join(c3, "attempt.json"), JSON.stringify({ databaseIdentity: { path: "/tmp/db103.sqlite" } }));
    writeFileSync(path.join(c3, "trace.json"), JSON.stringify({
      toolCalls: [{ toolName: "query_database", args: { probe: { path: "order", alternativeId: "o1" }, sql: "SELECT 7" } }],
    }));

    const fields = extractProbedFieldsFromRun({ runDir, evaluationSuite });
    assert.equal(fields.length, 4);

    const f1Metric = fields.find((f) => f.instanceId === "local101" && f.path === "metric");
    assert.ok(f1Metric);
    assert.equal(f1Metric.dbPath, "/tmp/db101.sqlite");
    assert.deepEqual(
      f1Metric.alternatives.map((a) => ({ alternativeId: a.alternativeId, sql: a.sql })),
      [
        { alternativeId: "a1", sql: "SELECT 10 AS v" },
        { alternativeId: "a2", sql: "SELECT 2 AS v" },
      ],
    );

    const f1Filter = fields.find((f) => f.instanceId === "local101" && f.path === "filter");
    assert.ok(f1Filter);
    assert.equal(f1Filter.alternatives.length, 1);

    const f2Scope = fields.find((f) => f.instanceId === "local102" && f.path === "scope");
    assert.ok(f2Scope);
    assert.equal(
      f2Scope.dbPath,
      path.resolve(liteRoot, "resource", "databases", "spider2-localdb", "fallback_db.sqlite"),
    );
    assert.equal(f2Scope.alternatives[0].alternativeId, "s1");

    const f3Order = fields.find((f) => f.instanceId === "local103" && f.path === "order");
    assert.ok(f3Order);
    assert.equal(f3Order.dbPath, "/tmp/db103.sqlite");

    // idsFile filtering takes precedence over cases/ scan
    const idsFile = path.join(tmpDir, "ids.txt");
    writeFileSync(idsFile, "local102\n");
    const filtered = extractProbedFieldsFromRun({ runDir, evaluationSuite, idsFile });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].instanceId, "local102");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("aggregateProbeLabels computes all counts, categories, blind redaction, and integrates with computeStratifiedScoreboard", () => {
  const probedFields = [
    // local201: 2 fields, both covered (one unique, one several) -> all open covered & any gold probe
    {
      instanceId: "local201",
      path: "field_a",
      alternatives: [
        { alternativeId: "a1", sql: "SELECT 1", key: "k1" },
        { alternativeId: "a2", sql: "SELECT 2", key: "k2" },
      ],
    },
    {
      instanceId: "local201",
      path: "field_b",
      alternatives: [
        { alternativeId: "b1", sql: "SELECT 3", key: "k3" },
        { alternativeId: "b2", sql: "SELECT 4", key: "k4" },
      ],
    },
    // local202: 2 fields, 1 unique gold + 1 no gold -> any gold probe, NOT all open covered
    {
      instanceId: "local202",
      path: "field_c",
      alternatives: [{ alternativeId: "c1", sql: "SELECT 5", key: "k5" }],
    },
    {
      instanceId: "local202",
      path: "field_d",
      alternatives: [{ alternativeId: "d1", sql: "SELECT 6", key: "k6" }],
    },
    // local203: 1 field, no gold
    {
      instanceId: "local203",
      path: "field_e",
      alternatives: [{ alternativeId: "e1", sql: "SELECT 7", key: "k7" }],
    },
  ];

  const labelByKey = new Map([
    ["k1", true],
    ["k2", false],
    ["k3", true],
    ["k4", true],
    ["k5", true],
    ["k6", false],
    ["k7", false],
  ]);

  const openSummary = aggregateProbeLabels(probedFields, labelByKey, { blind: false });
  assert.equal(openSummary.schemaVersion, 1);
  assert.equal(openSummary.blind, false);
  assert.equal(openSummary.fieldsTotal, 5);
  assert.equal(openSummary.fieldsWithGoldCandidate, 3);
  assert.equal(openSummary.fieldRate, 0.6);
  assert.equal(openSummary.fieldsUniqueGold, 2);
  assert.equal(openSummary.fieldsSeveralGold, 1);
  assert.equal(openSummary.fieldsNoGold, 2);
  assert.equal(openSummary.casesWithOpenFields, 3);
  assert.equal(openSummary.casesWithAllOpenCovered, 1);
  assert.equal(openSummary.casesWithAnyGoldProbe, 2);
  assert.deepEqual(openSummary.fields, [
    {
      instanceId: "local201",
      path: "field_a",
      alternativesTotal: 2,
      alternativesMatched: 1,
      hasGoldCandidate: true,
      matchCategory: "unique",
    },
    {
      instanceId: "local201",
      path: "field_b",
      alternativesTotal: 2,
      alternativesMatched: 2,
      hasGoldCandidate: true,
      matchCategory: "several",
    },
    {
      instanceId: "local202",
      path: "field_c",
      alternativesTotal: 1,
      alternativesMatched: 1,
      hasGoldCandidate: true,
      matchCategory: "unique",
    },
    {
      instanceId: "local202",
      path: "field_d",
      alternativesTotal: 1,
      alternativesMatched: 0,
      hasGoldCandidate: false,
      matchCategory: "none",
    },
    {
      instanceId: "local203",
      path: "field_e",
      alternativesTotal: 1,
      alternativesMatched: 0,
      hasGoldCandidate: false,
      matchCategory: "none",
    },
  ]);

  const blindSummary = aggregateProbeLabels(probedFields, labelByKey, { blind: true });
  assert.equal(blindSummary.blind, true);
  assert.equal(blindSummary.fields, undefined);
  assert.equal(blindSummary.fieldsTotal, 5);
  assert.equal(blindSummary.fieldsWithGoldCandidate, 3);
  assert.equal(blindSummary.casesWithOpenFields, 3);
  assert.equal(blindSummary.casesWithAllOpenCovered, 1);
  assert.equal(/local\d+/.test(JSON.stringify(blindSummary)), false);

  const scoreboard = computeStratifiedScoreboard({
    denominatorIds: ["local201", "local202", "local203", "local204"],
    officialScores: { local201: 1, local202: 0, local203: 0, local204: 0 },
    probeResults: blindSummary,
    blind: true,
  });
  assert.deepEqual(scoreboard.oracleAtProbe, {
    fieldsTotal: 5,
    fieldsWithGoldCandidate: 3,
    fieldRate: 0.6,
    casesWithOpenFields: 3,
    casesWithAllOpenCovered: 1,
  });
  const md = formatStratifiedMarkdown(scoreboard);
  assert.match(md, /Oracle@Probe \(fields\) \| 3\/5 \| 60\.0%/);
  assert.match(md, /Oracle@Probe \(cases all-covered\) \| 1\/3 \| 33\.3%/);
  assert.equal(/local\d+/.test(JSON.stringify(scoreboard)), false);
  assert.equal(/local\d+/.test(md), false);
});

test("runOracleProbeSummary skips python when 0 probes and throws clearly on python error", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "oracle-probe-zero-"));
  try {
    const runDir = path.join(tmpDir, "run");
    const suiteDir = path.join(tmpDir, "suite");
    mkdirSync(path.join(runDir, "cases", "local301", "attempts", "attempt-001"), { recursive: true });
    mkdirSync(suiteDir, { recursive: true });
    writeFileSync(
      path.join(runDir, "cases", "local301", "attempts", "attempt-001", "result.json"),
      JSON.stringify({ status: "completed", databaseIdentity: { path: "/tmp/db301.sqlite" } }),
    );
    writeFileSync(
      path.join(runDir, "cases", "local301", "attempts", "attempt-001", "trace.json"),
      JSON.stringify({ toolCalls: [{ toolName: "query_database", args: { sql: "SELECT 1" } }] }),
    );

    // Must NOT invoke python when 0 probe tool calls exist.
    const zeroSummary = runOracleProbeSummary({
      runDir,
      evaluationSuite: suiteDir,
      pythonExecutable: "nonexistent-python-executable-should-not-run",
      blind: true,
    });
    assert.equal(zeroSummary.fieldsTotal, 0);
    assert.equal(zeroSummary.fieldRate, 0);
    assert.equal(zeroSummary.fields, undefined);

    // When probes exist and python binary cannot spawn, throws clearly.
    writeFileSync(
      path.join(runDir, "cases", "local301", "attempts", "attempt-001", "trace.json"),
      JSON.stringify({
        toolCalls: [
          { toolName: "query_database", args: { probe: { path: "metric", alternativeId: "a1" }, sql: "SELECT 1" } },
        ],
      }),
    );
    assert.throws(
      () => runOracleProbeSummary({
        runDir,
        evaluationSuite: suiteDir,
        pythonExecutable: "nonexistent-python-executable-for-error-test",
      }),
      /Failed to invoke/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("CLI runs end-to-end against label_probe_alternatives.py and enforces --blind redaction", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "oracle-probe-cli-"));
  try {
    const runDir = path.join(tmpDir, "run");
    const suiteDir = path.join(tmpDir, "evaluation_suite");
    const goldDir = path.join(suiteDir, "gold", "exec_result");
    const pySiteDir = path.join(tmpDir, "py_site");
    const dbPath = path.join(tmpDir, "test.sqlite");

    mkdirSync(path.join(runDir, "cases", "local901", "attempts", "attempt-001"), { recursive: true });
    mkdirSync(goldDir, { recursive: true });
    mkdirSync(pySiteDir, { recursive: true });

    // Create a minimal SQLite database using Python's built-in sqlite3 module.
    const dbSetup = spawnSync(
      "python",
      [
        "-c",
        "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE t (x INTEGER)'); c.execute('INSERT INTO t VALUES (42)'); c.commit(); c.close()",
        dbPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(dbSetup.status, 0, dbSetup.stderr);

    // Provide a lightweight pandas shim only if pandas is not installed in the host Python.
    const hasPandas = spawnSync("python", ["-c", "import pandas"], { encoding: "utf8" }).status === 0;
    if (!hasPandas) {
      writeFileSync(
        path.join(pySiteDir, "pandas.py"),
        [
          "def read_sql_query(sql, conn):",
          "    return conn.execute(sql).fetchall()",
          "",
        ].join("\n"),
      );
    }

    writeFileSync(
      path.join(suiteDir, "gold", "spider2lite_eval.jsonl"),
      `${JSON.stringify({ instance_id: "local901", condition_cols: null, ignore_order: false })}\n`,
    );
    writeFileSync(path.join(goldDir, "local901.csv"), "x\n42\n");
    writeFileSync(
      path.join(suiteDir, "evaluate.py"),
      [
        "from pathlib import Path",
        "def resolve_gold_paths(instance_id, gold_dir):",
        "    return [Path(gold_dir) / f'{instance_id}.csv'], True",
        "def load_gold_csv(path):",
        "    lines = [l.strip() for l in Path(path).read_text(encoding='utf-8').splitlines() if l.strip()]",
        "    return [(int(lines[1]),)]",
        "def compare_pandas_table(pred, gold, condition_cols=None, ignore_order=False):",
        "    if hasattr(pred, 'values'):",
        "        pred_rows = [tuple(int(v) for v in row) for row in pred.values.tolist()]",
        "    else:",
        "        pred_rows = list(pred)",
        "    return pred_rows == gold",
        "def compare_multi_pandas_table(pred, golds, condition_cols=None, ignore_order=False):",
        "    return any(compare_pandas_table(pred, g, condition_cols, ignore_order) for g in golds)",
        "",
      ].join("\n"),
    );

    writeFileSync(
      path.join(runDir, "cases", "local901", "attempts", "attempt-001", "result.json"),
      JSON.stringify({ status: "completed", databaseIdentity: { path: dbPath } }),
    );
    writeFileSync(
      path.join(runDir, "cases", "local901", "attempts", "attempt-001", "trace.json"),
      JSON.stringify({
        toolCalls: [
          {
            toolName: "query_database",
            args: { probe: { path: "value_col", alternativeId: "alt_good" }, sql: "SELECT x FROM t" },
          },
          {
            toolName: "query_database",
            args: { probe: { path: "value_col", alternativeId: "alt_bad" }, sql: "SELECT 99 AS x" },
          },
        ],
      }),
    );

    const outBlindPath = path.join(tmpDir, "probe-blind.json");
    const env = {
      ...process.env,
      PYTHONPATH: hasPandas
        ? process.env.PYTHONPATH ?? ""
        : [pySiteDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    };

    const blindStdout = execFileSync(
      process.execPath,
      [
        path.join(HERE, "oracle-probe-summary.mjs"),
        "--run", runDir,
        "--evaluation-suite", suiteDir,
        "--blind",
        "--out", outBlindPath,
      ],
      { encoding: "utf8", env },
    );

    assert.equal(/local\d+/.test(blindStdout), false);
    const outFileText = readFileSync(outBlindPath, "utf8");
    assert.equal(/local\d+/.test(outFileText), false);

    const parsedBlind = JSON.parse(outFileText);
    assert.equal(parsedBlind.schemaVersion, 1);
    assert.equal(parsedBlind.blind, true);
    assert.equal(parsedBlind.fieldsTotal, 1);
    assert.equal(parsedBlind.fieldsWithGoldCandidate, 1);
    assert.equal(parsedBlind.fieldRate, 1);
    assert.equal(parsedBlind.fieldsUniqueGold, 1);
    assert.equal(parsedBlind.fieldsSeveralGold, 0);
    assert.equal(parsedBlind.fieldsNoGold, 0);
    assert.equal(parsedBlind.casesWithOpenFields, 1);
    assert.equal(parsedBlind.casesWithAllOpenCovered, 1);
    assert.equal(parsedBlind.casesWithAnyGoldProbe, 1);
    assert.equal(parsedBlind.fields, undefined);

    const openStdout = execFileSync(
      process.execPath,
      [
        path.join(HERE, "oracle-probe-summary.mjs"),
        "--run", runDir,
        "--evaluation-suite", suiteDir,
      ],
      { encoding: "utf8", env },
    );
    const parsedOpen = JSON.parse(openStdout);
    assert.equal(parsedOpen.blind, false);
    assert.deepEqual(parsedOpen.fields, [
      {
        instanceId: "local901",
        path: "value_col",
        alternativesTotal: 2,
        alternativesMatched: 1,
        hasGoldCandidate: true,
        matchCategory: "unique",
      },
    ]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
