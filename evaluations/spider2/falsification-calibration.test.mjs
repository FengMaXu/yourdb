import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { databaseFile, inferMeasureOp, parseCsv } from "./falsification-calibration.mjs";

test("parseCsv reads quoted fields with doubled quotes and CRLF", () => {
  assert.deepEqual(parseCsv("a,b\r\n\"x,1\",\"say \"\"hi\"\"\"\r\n"), [["a", "b"], ["x,1", "say \"hi\""]]);
});

test("inferMeasureOp reads the last output expression of the final SELECT", () => {
  assert.equal(inferMeasureOp("SELECT region, COUNT(*) AS n FROM t GROUP BY region"), "count");
  assert.equal(inferMeasureOp("SELECT COUNT(DISTINCT id) FROM t"), "count_distinct");
  assert.equal(inferMeasureOp("SELECT COUNT(x) * 1.0 / COUNT(*) AS r FROM t"), "ratio");
  assert.equal(inferMeasureOp("SELECT 100.0 * SUM(a) / SUM(b) AS p FROM t"), "percentage");
  assert.equal(inferMeasureOp("WITH c AS (SELECT COUNT(*) AS n FROM t) SELECT n FROM c"), undefined);
  assert.equal(inferMeasureOp("SELECT AVG(n) FROM (SELECT COUNT(*) AS n FROM t GROUP BY g)"), undefined);
});

test("databaseFile matches Spider2 names to the pack's file names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "calibration-"));
  try {
    writeFileSync(path.join(dir, "sqlite-sakila.sqlite"), "");
    writeFileSync(path.join(dir, "Db-IMDB.sqlite"), "");
    assert.equal(path.basename(databaseFile(dir, "SQLITE_SAKILA")), "sqlite-sakila.sqlite");
    assert.equal(path.basename(databaseFile(dir, "DB_IMDB")), "Db-IMDB.sqlite");
    assert.equal(databaseFile(dir, "missing"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
