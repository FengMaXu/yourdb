import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyOutputShapeMismatch,
  computeStratifiedScoreboard,
  formatStratifiedMarkdown,
  parseCsv,
} from "./stratified-scoring.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("parseCsv handles RFC-4180 quotes, escaped quotes, embedded commas/newlines, CRLF/LF, and trailing empty lines", () => {
  const input = '\uFEFFcol_a,col_b,"col,c"\r\n1,"hello ""world""","a,b\nc"\r\n2,plain,end\r\n\r\n\n';
  const rows = parseCsv(input);
  assert.deepEqual(rows, [
    ["col_a", "col_b", "col,c"],
    ["1", 'hello "world"', "a,b\nc"],
    ["2", "plain", "end"],
  ]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\r\n\n"), []);
});

test("classifyOutputShapeMismatch detects column_subset_match (local130-style) with row/col reorder and numeric tolerance", () => {
  const pred = [
    "Quintile,StudLastName,score_num",
    "Second,Jones,22",
    "First,Bishop,10.005",
  ].join("\n");
  const gold = [
    "StudLastName,Grade,QUINTILE,score_num",
    "Bishop,98.07,First,10.0",
    "Jones,91.66,Second,22.00",
  ].join("\n");

  const res = classifyOutputShapeMismatch(pred, [gold]);
  assert.equal(res.isOutputShapeMismatch, true);
  assert.equal(res.reason, "column_subset_match");
  assert.equal(res.matchedColumns.length, 3);
});

test("classifyOutputShapeMismatch detects column_superset_match and handles NULL/empty equivalence", () => {
  const pred = [
    "extra_note,player,pts",
    "aux1,Alice,NULL",
    "aux2,Bob,15.004",
  ].join("\n");
  const gold = [
    "player,pts",
    "Bob,15",
    "Alice,",
  ].join("\n");

  const res = classifyOutputShapeMismatch(pred, gold);
  assert.equal(res.isOutputShapeMismatch, true);
  assert.equal(res.reason, "column_superset_match");
});

test("classifyOutputShapeMismatch detects synthetic_label_column_mismatch (local220-style) across multiple golds", () => {
  const pred = [
    "result_type,player_name,match_count",
    "win,Cristiano Ronaldo,199",
    "loss,Gorka Iraizoz Moreno,107",
  ].join("\n");
  const wrongGold = [
    "category,player_name,match_count",
    "most_wins,Wrong Player,199",
    "most_losses,Gorka Iraizoz Moreno,107",
  ].join("\n");
  const matchingGold = [
    "category,player_name,match_count",
    "most_losses,Gorka Iraizoz Moreno,107",
    "most_wins,Cristiano Ronaldo,199.00",
  ].join("\n");

  const res = classifyOutputShapeMismatch(pred, [wrongGold, matchingGold]);
  assert.equal(res.isOutputShapeMismatch, true);
  assert.equal(res.reason, "synthetic_label_column_mismatch");
  assert.equal(res.matchedColumns.length, 2);
});

test("classifyOutputShapeMismatch rejects numeric, entity, row-count, 2-col entity, single-col, and ignoreOrder=false mismatches", () => {
  // Numeric mismatch beyond 1e-2
  assert.equal(
    classifyOutputShapeMismatch(
      "name,val\nAlice,10.02\n",
      "name,extra,val\nAlice,x,10.00\n",
    ).isOutputShapeMismatch,
    false,
  );

  // Entity mismatch
  assert.equal(
    classifyOutputShapeMismatch(
      "name,val\nBob,10\n",
      "name,extra,val\nAlice,x,10\n",
    ).isOutputShapeMismatch,
    false,
  );

  // Row-count mismatch
  assert.equal(
    classifyOutputShapeMismatch(
      "name,val\nAlice,10\n",
      "name,val\nAlice,10\nBob,20\n",
    ).isOutputShapeMismatch,
    false,
  );

  // Empty data rows
  assert.equal(
    classifyOutputShapeMismatch("name,val\n", "name,extra,val\n").isOutputShapeMismatch,
    false,
  );

  // 2-col entity+value table MUST NOT drop entity column to match only 1 col
  assert.equal(
    classifyOutputShapeMismatch(
      "team,score\nWrongTeam,42\n",
      "team,score\nRightTeam,42\n",
    ).isOutputShapeMismatch,
    false,
  );

  // Single-col wrong value
  assert.equal(
    classifyOutputShapeMismatch(
      "val\n41\n",
      "team,val\nRightTeam,42\n",
    ).isOutputShapeMismatch,
    false,
  );

  // ignoreOrder: false rejects reordered rows
  assert.equal(
    classifyOutputShapeMismatch(
      "a,b\n2,x\n1,y\n",
      "a,b,c\n1,y,z\n2,x,w\n",
      { ignoreOrder: false },
    ).isOutputShapeMismatch,
    false,
  );
});

test("computeStratifiedScoreboard and formatStratifiedMarkdown compute strata and redact all IDs when blind=true", () => {
  const denom = ["local001", "local002", "local003", "local004", "local005"];
  const officialScores = { local001: 1, local002: 1, local003: 0, local004: 0, local005: 0 };
  const goldDefectIds = ["local002", "local003"];
  const outputShapeMismatchIds = ["local004"];
  const probeResults = {
    advisedFields: 10,
    labelledFields: 6,
    unlabelledReason: { noAlternativeMatchesGold: 2, severalMatchGold: 2 },
    casesWithOpenFields: 4,
    casesWithAllOpenCovered: 3,
  };

  const openBoard = computeStratifiedScoreboard({
    denominatorIds: denom,
    officialScores,
    goldDefectIds,
    outputShapeMismatchIds,
    probeResults,
    blind: false,
  });

  assert.equal(openBoard.rawExec.correct, 2);
  assert.equal(openBoard.rawExec.total, 5);
  assert.equal(openBoard.cleanExec.correct, 1);
  assert.equal(openBoard.cleanExec.total, 3);
  assert.equal(openBoard.outputShapeMismatch.count, 1);
  assert.equal(openBoard.outputShapeMismatch.cleanCount, 1);
  assert.deepEqual(openBoard.outputShapeMismatch.caseIds, ["local004"]);
  assert.equal(openBoard.coreSemantic.rawCorrect, 3);
  assert.equal(openBoard.coreSemantic.cleanCorrect, 2);
  assert.equal(openBoard.coreSemantic.cleanTotal, 3);
  assert.equal(openBoard.oracleAtProbe.fieldsTotal, 10);
  assert.equal(openBoard.oracleAtProbe.fieldsWithGoldCandidate, 8);
  assert.equal(openBoard.oracleAtProbe.fieldRate, 0.8);
  assert.equal(openBoard.oracleAtProbe.casesWithOpenFields, 4);
  assert.equal(openBoard.oracleAtProbe.casesWithAllOpenCovered, 3);

  const openMd = formatStratifiedMarkdown(openBoard);
  assert.match(openMd, /local004/);
  assert.match(openMd, /Oracle@Probe \(fields\)/);

  const blindBoard = computeStratifiedScoreboard({
    denominatorIds: denom,
    officialScores,
    goldDefectIds,
    outputShapeMismatchIds,
    probeResults,
    blind: true,
  });
  const blindJson = JSON.stringify(blindBoard);
  const blindMd = formatStratifiedMarkdown(blindBoard);
  assert.equal(/local\d+/.test(blindJson), false);
  assert.equal(/local\d+/.test(blindMd), false);
  assert.equal(blindBoard.outputShapeMismatch.caseIds, undefined);
  assert.equal(blindBoard.goldDefects.caseIds, undefined);
});

test("CLI runs end-to-end across retried attempts and enforces --blind redaction", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "stratified-scoring-test-"));
  try {
    const runDir = path.join(tmpDir, "run");
    const goldDir = path.join(tmpDir, "gold");
    mkdirSync(path.join(runDir, "official_score", "inputs", "attempt-001", "csv"), { recursive: true });
    mkdirSync(path.join(runDir, "official_score", "inputs", "attempt-002", "csv"), { recursive: true });
    mkdirSync(goldDir, { recursive: true });

    writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({
      instanceIds: ["local901", "local902", "local903"],
      attemptPolicy: { selectedAttemptId: "attempt-002" },
    }));
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-001", "csv-ids.csv"), "instance_id\nsflocal\n");
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-001", "csv", "local901.csv"), "a\n1\n");
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-001", "csv", "local902.csv"), "a,b\n1,2\n");
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-002", "csv-ids.csv"), "instance_id\nsf_local901\n");
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-002", "csv", "local901.csv"), "a\n1\n");
    writeFileSync(path.join(runDir, "official_score", "inputs", "attempt-002", "csv", "local903.csv"), "k,v\nx,9\n");

    writeFileSync(path.join(goldDir, "local901.csv"), "a\n1\n");
    writeFileSync(path.join(goldDir, "local902.csv"), "a,b,c\n1,2,3\n");
    writeFileSync(path.join(goldDir, "local903.csv"), "k,v\ny,9\n");

    const idsPath = path.join(tmpDir, "ids.txt");
    writeFileSync(idsPath, "local901\nlocal902\nlocal903\n");
    const outPath = path.join(tmpDir, "out-blind.json");

    const stdout = execFileSync(
      process.execPath,
      [
        path.join(HERE, "stratified-scoring.mjs"),
        "--run", runDir,
        "--gold", goldDir,
        "--ids-file", idsPath,
        "--blind",
        "--out", outPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(/local\d+/.test(stdout), false);
    const outJson = readFileSync(outPath, "utf8");
    assert.equal(/local\d+/.test(outJson), false);
    const parsed = JSON.parse(outJson);
    assert.equal(parsed.rawExec.correct, 1);
    assert.equal(parsed.rawExec.total, 3);
    assert.equal(parsed.outputShapeMismatch.count, 1);
    assert.equal(parsed.coreSemantic.cleanCorrect, 2);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dataset firewall IDs: 50 exposed + 85 blind holdout with 0 overlap and 15 frozen overlaps", () => {
  const readLines = (name) =>
    readFileSync(path.join(HERE, name), "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

  const exposed = readLines("regression-exposed-50-ids.txt");
  const blind = readLines("blind-holdout-ids.txt");
  const frozen = readLines("phase6-frozen-100-ids.txt");

  assert.equal(exposed.length, 50);
  assert.equal(new Set(exposed).size, 50);
  assert.deepEqual(exposed, [...exposed].sort());

  assert.equal(blind.length, 85);
  assert.equal(new Set(blind).size, 85);
  assert.deepEqual(blind, [...blind].sort());

  const exposedSet = new Set(exposed);
  const blindSet = new Set(blind);
  assert.deepEqual(exposed.filter((id) => blindSet.has(id)), []);
  assert.equal(frozen.filter((id) => exposedSet.has(id)).length, 15);
  assert.equal(frozen.filter((id) => blindSet.has(id)).length, 85);
});
