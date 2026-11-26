#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STRICT_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse RFC-4180 CSV text into rows of string cells.
 * Handles quoted cells, escaped `""`, embedded commas/newlines, CRLF/LF, and trailing empty lines.
 */
export function parseCsv(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let hasContent = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      hasContent = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
      hasContent = true;
    } else if (ch === "\r") {
      if (input[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      hasContent = false;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      hasContent = false;
    } else {
      cell += ch;
      hasContent = true;
    }
  }

  if (inQuotes || hasContent || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

function normalizeCell(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed === "" || trimmed.toUpperCase() === "NULL") {
    return { kind: "null", text: "" };
  }
  if (STRICT_NUMBER_RE.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return { kind: "number", num: num === 0 ? 0 : num, text: trimmed };
    }
  }
  return { kind: "string", text: trimmed };
}

function cellsEqual(a, b, tolerance) {
  if (a.kind !== b.kind) return false;
  if (a.kind === "null") return true;
  if (a.kind === "number") return Math.abs(a.num - b.num) <= tolerance;
  return a.text === b.text;
}

function compareNormalizedCells(a, b) {
  const rank = (c) => (c.kind === "null" ? 0 : c.kind === "number" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a.kind === "number") return a.num - b.num;
  if (a.kind === "string") return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
  return 0;
}

function columnsMultisetCompatible(predRows, pCol, goldRows, gCol, tolerance) {
  if (predRows.length !== goldRows.length) return false;
  let pNulls = 0;
  let gNulls = 0;
  const pNums = [];
  const gNums = [];
  const pStrs = [];
  const gStrs = [];

  for (let i = 0; i < predRows.length; i += 1) {
    const pc = predRows[i][pCol];
    const gc = goldRows[i][gCol];
    if (pc.kind === "null") pNulls += 1;
    else if (pc.kind === "number") pNums.push(pc.num);
    else pStrs.push(pc.text);

    if (gc.kind === "null") gNulls += 1;
    else if (gc.kind === "number") gNums.push(gc.num);
    else gStrs.push(gc.text);
  }

  if (pNulls !== gNulls || pNums.length !== gNums.length || pStrs.length !== gStrs.length) {
    return false;
  }

  pStrs.sort();
  gStrs.sort();
  for (let i = 0; i < pStrs.length; i += 1) {
    if (pStrs[i] !== gStrs[i]) return false;
  }

  pNums.sort((a, b) => a - b);
  gNums.sort((a, b) => a - b);
  for (let i = 0; i < pNums.length; i += 1) {
    if (Math.abs(pNums[i] - gNums[i]) > tolerance) return false;
  }
  return true;
}

function rowsMatch(predRow, predCols, goldRow, goldCols, tolerance) {
  for (let i = 0; i < predCols.length; i += 1) {
    if (!cellsEqual(predRow[predCols[i]], goldRow[goldCols[i]], tolerance)) return false;
  }
  return true;
}

function bipartiteMatchRows(predBucket, predCols, goldBucket, goldCols, tolerance) {
  const n = predBucket.length;
  const matchGtoP = new Int32Array(n).fill(-1);

  const dfs = (u, visited) => {
    for (let v = 0; v < n; v += 1) {
      if (visited[v]) continue;
      if (!rowsMatch(predBucket[u], predCols, goldBucket[v], goldCols, tolerance)) continue;
      visited[v] = 1;
      if (matchGtoP[v] === -1 || dfs(matchGtoP[v], visited)) {
        matchGtoP[v] = u;
        return true;
      }
    }
    return false;
  };

  for (let u = 0; u < n; u += 1) {
    const visited = new Uint8Array(n);
    if (!dfs(u, visited)) return false;
  }
  return true;
}

function rowMultisetMatch(predRows, predCols, goldRows, goldCols, tolerance, ignoreOrder) {
  if (predRows.length !== goldRows.length) return false;
  if (!ignoreOrder) {
    for (let i = 0; i < predRows.length; i += 1) {
      if (!rowsMatch(predRows[i], predCols, goldRows[i], goldCols, tolerance)) return false;
    }
    return true;
  }

  const bucketKey = (row, cols) => {
    let key = "";
    for (let i = 0; i < cols.length; i += 1) {
      const cell = row[cols[i]];
      if (cell.kind === "null") key += "\x00N";
      else if (cell.kind === "number") key += "\x00#";
      else key += `\x00S${cell.text.length}:${cell.text}`;
    }
    return key;
  };

  const predBuckets = new Map();
  const goldBuckets = new Map();
  for (let i = 0; i < predRows.length; i += 1) {
    const pk = bucketKey(predRows[i], predCols);
    if (!predBuckets.has(pk)) predBuckets.set(pk, []);
    predBuckets.get(pk).push(predRows[i]);

    const gk = bucketKey(goldRows[i], goldCols);
    if (!goldBuckets.has(gk)) goldBuckets.set(gk, []);
    goldBuckets.get(gk).push(goldRows[i]);
  }

  if (predBuckets.size !== goldBuckets.size) return false;

  const sortBucket = (bucket, cols) => {
    bucket.sort((a, b) => {
      for (let i = 0; i < cols.length; i += 1) {
        const cmp = compareNormalizedCells(a[cols[i]], b[cols[i]]);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  };

  for (const [key, pBucket] of predBuckets.entries()) {
    const gBucket = goldBuckets.get(key);
    if (!gBucket || gBucket.length !== pBucket.length) return false;
    if (pBucket.length === 1) {
      if (!rowsMatch(pBucket[0], predCols, gBucket[0], goldCols, tolerance)) return false;
      continue;
    }

    sortBucket(pBucket, predCols);
    sortBucket(gBucket, goldCols);
    let orderedMatch = true;
    for (let i = 0; i < pBucket.length; i += 1) {
      if (!rowsMatch(pBucket[i], predCols, gBucket[i], goldCols, tolerance)) {
        orderedMatch = false;
        break;
      }
    }
    if (orderedMatch) continue;
    if (pBucket.length > 500) return false;
    if (!bipartiteMatchRows(pBucket, predCols, gBucket, goldCols, tolerance)) return false;
  }

  return true;
}

function findInjectiveColumnMapping(sourceRows, sourceColIndices, targetRows, targetColIndices, tolerance, ignoreOrder) {
  const k = sourceColIndices.length;
  if (k === 0 || k > targetColIndices.length) return null;

  const candidates = sourceColIndices.map((sCol) =>
    targetColIndices.filter((tCol) => columnsMultisetCompatible(sourceRows, sCol, targetRows, tCol, tolerance)),
  );
  if (candidates.some((list) => list.length === 0)) return null;

  // Order source columns by fewest candidates first for fast backtracking.
  const order = sourceColIndices.map((_, idx) => idx).sort((a, b) => candidates[a].length - candidates[b].length);
  const chosenTarget = new Array(k);
  const usedTarget = new Set();

  const backtrack = (depth) => {
    if (depth === k) {
      return rowMultisetMatch(sourceRows, sourceColIndices, targetRows, chosenTarget, tolerance, ignoreOrder);
    }
    const pos = order[depth];
    for (const tCol of candidates[pos]) {
      if (usedTarget.has(tCol)) continue;
      usedTarget.add(tCol);
      chosenTarget[pos] = tCol;
      if (backtrack(depth + 1)) return true;
      usedTarget.delete(tCol);
    }
    return false;
  };

  return backtrack(0) ? chosenTarget : null;
}

function isNonNumericStringColumn(rows, colIdx) {
  let nonNullCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const cell = rows[i][colIdx];
    if (cell.kind === "null") continue;
    nonNullCount += 1;
    if (cell.kind === "number") return false;
  }
  return nonNullCount > 0;
}

function parseTable(csvText) {
  const rawRows = parseCsv(csvText);
  if (rawRows.length < 2) return null;
  const headers = rawRows[0].map((h) => String(h ?? "").trim());
  const numCols = headers.length;
  if (numCols === 0) return null;
  const dataRows = rawRows.slice(1);
  if (dataRows.some((r) => r.length !== numCols)) return null;
  const normalizedRows = dataRows.map((r) => r.map((cell) => normalizeCell(cell)));
  return { headers, rows: normalizedRows, numCols };
}

function buildMatchedColumns(predHeaders, predCols, goldHeaders, goldCols) {
  return predCols.map((pIdx, i) => ({
    predIndex: pIdx,
    predHeader: predHeaders[pIdx],
    goldIndex: goldCols[i],
    goldHeader: goldHeaders[goldCols[i]],
  }));
}

function matchSubset(predTable, goldTable, tolerance, ignoreOrder) {
  const predIndices = predTable.headers.map((_, i) => i);
  const goldIndices = goldTable.headers.map((_, i) => i);
  const chosenGold = findInjectiveColumnMapping(predTable.rows, predIndices, goldTable.rows, goldIndices, tolerance, ignoreOrder);
  return chosenGold ? buildMatchedColumns(predTable.headers, predIndices, goldTable.headers, chosenGold) : null;
}

function matchSuperset(predTable, goldTable, tolerance, ignoreOrder) {
  const predIndices = predTable.headers.map((_, i) => i);
  const goldIndices = goldTable.headers.map((_, i) => i);
  const chosenPred = findInjectiveColumnMapping(goldTable.rows, goldIndices, predTable.rows, predIndices, tolerance, ignoreOrder);
  return chosenPred ? buildMatchedColumns(predTable.headers, chosenPred, goldTable.headers, goldIndices) : null;
}

function matchSyntheticLabelColumn(predTable, goldTable, tolerance, ignoreOrder) {
  const pCols = predTable.numCols;
  const gCols = goldTable.numCols;
  if (pCols < 2 || gCols < 2 || Math.abs(pCols - gCols) > 1) return null;

  const predNonNumeric = [];
  for (let i = 0; i < pCols; i += 1) {
    if (isNonNumericStringColumn(predTable.rows, i)) predNonNumeric.push(i);
  }
  const goldNonNumeric = [];
  for (let i = 0; i < gCols; i += 1) {
    if (isNonNumericStringColumn(goldTable.rows, i)) goldNonNumeric.push(i);
  }

  const predDropOptions = pCols === gCols ? predNonNumeric : pCols === gCols + 1 ? predNonNumeric : [null];
  const goldDropOptions = pCols === gCols ? goldNonNumeric : gCols === pCols + 1 ? goldNonNumeric : [null];

  for (const dropP of predDropOptions) {
    const keptP = [];
    for (let i = 0; i < pCols; i += 1) if (i !== dropP) keptP.push(i);
    if (keptP.length < 2) continue;

    for (const dropG of goldDropOptions) {
      const keptG = [];
      for (let i = 0; i < gCols; i += 1) if (i !== dropG) keptG.push(i);
      if (keptG.length < 2 || keptP.length !== keptG.length) continue;

      const mapping = findInjectiveColumnMapping(predTable.rows, keptP, goldTable.rows, keptG, tolerance, ignoreOrder);
      if (mapping) {
        return buildMatchedColumns(predTable.headers, keptP, goldTable.headers, mapping);
      }
    }
  }
  return null;
}

/**
 * Classify whether a failed prediction CSV differs from Gold CSV(s) purely by output shape:
 * - `column_subset_match`: 1 <= predCols < goldCols, injective 100% row-multiset match
 * - `column_superset_match`: predCols > goldCols, injective 100% row-multiset match
 * - `synthetic_label_column_mismatch`: drop 1 non-numeric string column from Pred and/or Gold leaving >= 2 matching columns
 */
export function classifyOutputShapeMismatch(predCsvText, goldCsvTexts, options = {}) {
  const tolerance = options.tolerance ?? 1e-2;
  const ignoreOrder = options.ignoreOrder ?? true;
  const predTable = parseTable(predCsvText);
  if (!predTable) {
    return { isOutputShapeMismatch: false };
  }

  const goldList = Array.isArray(goldCsvTexts) ? goldCsvTexts : [goldCsvTexts];
  for (const goldCsvText of goldList) {
    const goldTable = parseTable(goldCsvText);
    if (!goldTable) continue;
    if (predTable.rows.length !== goldTable.rows.length || predTable.rows.length === 0) continue;

    if (predTable.numCols >= 1 && predTable.numCols < goldTable.numCols) {
      const matched = matchSubset(predTable, goldTable, tolerance, ignoreOrder);
      if (matched) {
        return {
          isOutputShapeMismatch: true,
          reason: "column_subset_match",
          matchedColumns: matched,
          predColumns: predTable.headers,
          goldColumns: goldTable.headers,
        };
      }
    }

    if (predTable.numCols > goldTable.numCols) {
      const matched = matchSuperset(predTable, goldTable, tolerance, ignoreOrder);
      if (matched) {
        return {
          isOutputShapeMismatch: true,
          reason: "column_superset_match",
          matchedColumns: matched,
          predColumns: predTable.headers,
          goldColumns: goldTable.headers,
        };
      }
    }

    if (predTable.numCols >= 2 && goldTable.numCols >= 2 && Math.abs(predTable.numCols - goldTable.numCols) <= 1) {
      const matched = matchSyntheticLabelColumn(predTable, goldTable, tolerance, ignoreOrder);
      if (matched) {
        return {
          isOutputShapeMismatch: true,
          reason: "synthetic_label_column_mismatch",
          matchedColumns: matched,
          predColumns: predTable.headers,
          goldColumns: goldTable.headers,
        };
      }
    }
  }

  return {
    isOutputShapeMismatch: false,
    predColumns: predTable.headers,
  };
}

function summarizeProbeResults(probeResults, denominatorSet) {
  if (!probeResults) return undefined;

  if (typeof probeResults.fieldsTotal === "number" && typeof probeResults.fieldsWithGoldCandidate === "number") {
    const fieldsTotal = probeResults.fieldsTotal;
    const fieldsWithGoldCandidate = probeResults.fieldsWithGoldCandidate;
    return {
      fieldsTotal,
      fieldsWithGoldCandidate,
      fieldRate: fieldsTotal > 0 ? fieldsWithGoldCandidate / fieldsTotal : 0,
      casesWithOpenFields: probeResults.casesWithOpenFields ?? null,
      casesWithAllOpenCovered: probeResults.casesWithAllOpenCovered ?? null,
    };
  }

  if (Array.isArray(probeResults.fields) || Array.isArray(probeResults)) {
    const rawFields = Array.isArray(probeResults) ? probeResults : probeResults.fields;
    const fields = rawFields.filter((f) => {
      const id = f.instanceId ?? f.instance_id ?? f.caseId ?? f.id;
      return !id || !denominatorSet || denominatorSet.has(id);
    });
    const fieldsTotal = fields.length;
    const isCovered = (f) => Boolean(f.hasGoldCandidate ?? f.covered ?? f.matchesGold ?? f.goldCandidate);
    const fieldsWithGoldCandidate = fields.filter(isCovered).length;
    const byCase = new Map();
    for (const f of fields) {
      const id = f.instanceId ?? f.instance_id ?? f.caseId ?? f.id;
      if (!id) continue;
      if (!byCase.has(id)) byCase.set(id, []);
      byCase.get(id).push(isCovered(f));
    }
    const casesWithOpenFields = byCase.size > 0 ? byCase.size : (probeResults.casesWithOpenFields ?? null);
    let casesWithAllOpenCovered = probeResults.casesWithAllOpenCovered ?? null;
    if (byCase.size > 0) {
      casesWithAllOpenCovered = 0;
      for (const list of byCase.values()) {
        if (list.every(Boolean)) casesWithAllOpenCovered += 1;
      }
    }
    return {
      fieldsTotal,
      fieldsWithGoldCandidate,
      fieldRate: fieldsTotal > 0 ? fieldsWithGoldCandidate / fieldsTotal : 0,
      casesWithOpenFields,
      casesWithAllOpenCovered,
    };
  }

  // jev-witness-replay-v1.json style summary
  if (typeof probeResults.advisedFields === "number") {
    const fieldsTotal = probeResults.advisedFields;
    const several = probeResults.unlabelledReason?.severalMatchGold ?? 0;
    const noMatch = probeResults.unlabelledReason?.noAlternativeMatchesGold;
    const labelled = probeResults.labelledFields ?? 0;
    const fieldsWithGoldCandidate = typeof noMatch === "number"
      ? Math.max(0, fieldsTotal - noMatch)
      : labelled + several;
    let casesWithOpenFields = probeResults.casesWithOpenFields ?? null;
    let casesWithAllOpenCovered = probeResults.casesWithAllOpenCovered ?? null;
    if (casesWithOpenFields === null && Array.isArray(probeResults.results)) {
      const uniqueCases = new Set(
        probeResults.results
          .map((r) => r.instanceId ?? r.instance_id ?? r.caseId)
          .filter((id) => id && (!denominatorSet || denominatorSet.has(id))),
      );
      if (fieldsTotal === fieldsWithGoldCandidate && uniqueCases.size > 0) {
        casesWithOpenFields = uniqueCases.size;
        casesWithAllOpenCovered = uniqueCases.size;
      } else if (probeResults.results.length === fieldsTotal && uniqueCases.size > 0) {
        casesWithOpenFields = uniqueCases.size;
      }
    }
    return {
      fieldsTotal,
      fieldsWithGoldCandidate,
      fieldRate: fieldsTotal > 0 ? fieldsWithGoldCandidate / fieldsTotal : 0,
      casesWithOpenFields,
      casesWithAllOpenCovered,
    };
  }

  return undefined;
}

/**
 * Compute stratified scoreboard across rawExec, cleanExec, outputShapeMismatch, coreSemantic, and optional oracleAtProbe.
 * When `blind === true`, omits all case IDs, per-case rows, SQL, CSV snippets, or failure lists.
 */
export function computeStratifiedScoreboard({
  denominatorIds,
  officialScores = {},
  goldDefectIds = [],
  outputShapeMismatchIds = [],
  probeResults = undefined,
  blind = false,
}) {
  const denom = [...new Set((denominatorIds ?? []).map(String))].sort();
  const denomSet = new Set(denom);
  const goldDefectSet = new Set((goldDefectIds ?? []).map(String));
  const mismatchSet = new Set((outputShapeMismatchIds ?? []).map(String));

  const isCorrect = (id) => officialScores[id] === 1 || officialScores[id] === true;

  const goldDefectInDenom = denom.filter((id) => goldDefectSet.has(id));
  const cleanDenom = denom.filter((id) => !goldDefectSet.has(id));

  const rawCorrect = denom.filter((id) => isCorrect(id)).length;
  const cleanCorrect = cleanDenom.filter((id) => isCorrect(id)).length;

  const osmRawIds = denom.filter((id) => !isCorrect(id) && mismatchSet.has(id));
  const osmCleanIds = cleanDenom.filter((id) => !isCorrect(id) && mismatchSet.has(id));

  const coreRawCorrect = denom.filter((id) => isCorrect(id) || mismatchSet.has(id)).length;
  const coreCleanCorrect = cleanDenom.filter((id) => isCorrect(id) || mismatchSet.has(id)).length;

  const oracleAtProbe = summarizeProbeResults(probeResults, denomSet);

  const scoreboard = {
    schemaVersion: 1,
    blind: Boolean(blind),
    denominatorTotal: denom.length,
    cleanDenominatorTotal: cleanDenom.length,
    rawExec: {
      correct: rawCorrect,
      total: denom.length,
      rate: denom.length > 0 ? rawCorrect / denom.length : 0,
    },
    cleanExec: {
      correct: cleanCorrect,
      total: cleanDenom.length,
      rate: cleanDenom.length > 0 ? cleanCorrect / cleanDenom.length : 0,
    },
    goldDefects: {
      count: goldDefectInDenom.length,
      ...(blind ? {} : { caseIds: goldDefectInDenom }),
    },
    outputShapeMismatch: {
      count: osmRawIds.length,
      rate: denom.length > 0 ? osmRawIds.length / denom.length : 0,
      cleanCount: osmCleanIds.length,
      cleanRate: cleanDenom.length > 0 ? osmCleanIds.length / cleanDenom.length : 0,
      ...(blind ? {} : { caseIds: osmRawIds }),
    },
    coreSemantic: {
      rawCorrect: coreRawCorrect,
      rawTotal: denom.length,
      rawRate: denom.length > 0 ? coreRawCorrect / denom.length : 0,
      cleanCorrect: coreCleanCorrect,
      cleanTotal: cleanDenom.length,
      cleanRate: cleanDenom.length > 0 ? coreCleanCorrect / cleanDenom.length : 0,
    },
  };

  if (oracleAtProbe) {
    scoreboard.oracleAtProbe = oracleAtProbe;
  }

  return scoreboard;
}

function pct(rate) {
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Format scoreboard as a GitHub-Flavored Markdown summary table.
 * Strictly aggregate-only when `scoreboard.blind === true` (zero case IDs).
 */
export function formatStratifiedMarkdown(scoreboard) {
  const rows = [
    ["Metric", "Count", "Rate"],
    [
      "Raw Exec",
      `${scoreboard.rawExec.correct}/${scoreboard.rawExec.total}`,
      pct(scoreboard.rawExec.rate),
    ],
    [
      `Clean Exec (excl. ${scoreboard.goldDefects?.count ?? 0} gold defects)`,
      `${scoreboard.cleanExec.correct}/${scoreboard.cleanExec.total}`,
      pct(scoreboard.cleanExec.rate),
    ],
    [
      "Output-Shape Mismatch (raw)",
      `${scoreboard.outputShapeMismatch.count}/${scoreboard.rawExec.total}`,
      pct(scoreboard.outputShapeMismatch.rate),
    ],
    [
      "Output-Shape Mismatch (clean)",
      `${scoreboard.outputShapeMismatch.cleanCount}/${scoreboard.cleanExec.total}`,
      pct(scoreboard.outputShapeMismatch.cleanRate),
    ],
    [
      "Core Semantic (raw)",
      `${scoreboard.coreSemantic.rawCorrect}/${scoreboard.coreSemantic.rawTotal}`,
      pct(scoreboard.coreSemantic.rawRate),
    ],
    [
      "Core Semantic (clean)",
      `${scoreboard.coreSemantic.cleanCorrect}/${scoreboard.coreSemantic.cleanTotal}`,
      pct(scoreboard.coreSemantic.cleanRate),
    ],
  ];

  if (scoreboard.oracleAtProbe) {
    const o = scoreboard.oracleAtProbe;
    rows.push([
      "Oracle@Probe (fields)",
      `${o.fieldsWithGoldCandidate}/${o.fieldsTotal}`,
      pct(o.fieldRate),
    ]);
    if (o.casesWithOpenFields !== null && o.casesWithOpenFields !== undefined) {
      const covered = o.casesWithAllOpenCovered ?? "-";
      const rateStr = typeof o.casesWithAllOpenCovered === "number" && o.casesWithOpenFields > 0
        ? pct(o.casesWithAllOpenCovered / o.casesWithOpenFields)
        : "-";
      rows.push([
        "Oracle@Probe (cases all-covered)",
        `${covered}/${o.casesWithOpenFields}`,
        rateStr,
      ]);
    }
  }

  const lines = [
    `| ${rows[0].join(" | ")} |`,
    "| --- | ---: | ---: |",
    ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`),
  ];

  if (!scoreboard.blind && Array.isArray(scoreboard.outputShapeMismatch?.caseIds) && scoreboard.outputShapeMismatch.caseIds.length > 0) {
    lines.push("", `Output-shape mismatch cases (${scoreboard.outputShapeMismatch.caseIds.length}): ${scoreboard.outputShapeMismatch.caseIds.join(", ")}`);
  }

  return lines.join("\n");
}

function readIdsFile(filePath) {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readGoldDefectIds(labelsPath) {
  if (!labelsPath) return [];
  const ids = [];
  for (const line of readFileSync(labelsPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (item.error_layer === "标准答案有问题") {
      const id = item.instance_id ?? item.instanceId ?? item.id ?? item.caseId;
      if (id) ids.push(String(id));
    }
  }
  return ids;
}

function listAttemptDirs(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function loadOfficialScores(runDir) {
  const scores = {};
  const inputsDir = path.join(runDir, "official_score", "inputs");
  for (const attempt of listAttemptDirs(inputsDir)) {
    const attemptDir = path.join(inputsDir, attempt);
    const csvIdsPath = path.join(attemptDir, "csv-ids.csv");
    const correctSet = new Set();
    if (existsSync(csvIdsPath)) {
      const lines = readFileSync(csvIdsPath, "utf8").split(/\r?\n/).slice(1);
      for (const line of lines) {
        const cleaned = line.trim().replace(/^sf_/, "");
        if (cleaned) correctSet.add(cleaned);
      }
    }
    const csvDir = path.join(attemptDir, "csv");
    const scanDir = existsSync(csvDir) ? csvDir : attemptDir;
    for (const file of readdirSync(scanDir)) {
      if (!file.endsWith(".csv") || file === "csv-ids.csv" || file === "sql-ids.csv") continue;
      const id = file.slice(0, -4);
      if (existsSync(csvIdsPath)) {
        scores[id] = correctSet.has(id) ? 1 : 0;
      }
    }
  }

  const summaryPath = path.join(runDir, "official_score", "summary.json");
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    const caseScores = summary.execResult?.caseScores ?? {};
    for (const [id, value] of Object.entries(caseScores)) {
      if (value === 0 || value === 1) scores[id] = value;
    }
  }

  const scoreRecordPath = path.join(runDir, "official_score", "score-record.json");
  if (existsSync(scoreRecordPath)) {
    const record = JSON.parse(readFileSync(scoreRecordPath, "utf8"));
    const byCase = record.correctnessByCase ?? {};
    for (const [id, value] of Object.entries(byCase)) {
      if (value === 0 || value === 1) scores[id] = value;
    }
  }

  return scores;
}

function resolvePredCsvPath(runDir, caseId, selectedAttemptId, inputsAttemptsDesc, casesJsonlCsvMap) {
  const inputsDir = path.join(runDir, "official_score", "inputs");
  const orderedInputAttempts = selectedAttemptId && inputsAttemptsDesc.includes(selectedAttemptId)
    ? [selectedAttemptId, ...inputsAttemptsDesc.filter((a) => a !== selectedAttemptId)]
    : inputsAttemptsDesc;

  for (const attempt of orderedInputAttempts) {
    const nested = path.join(inputsDir, attempt, "csv", `${caseId}.csv`);
    if (existsSync(nested)) return nested;
    const flat = path.join(inputsDir, attempt, `${caseId}.csv`);
    if (existsSync(flat)) return flat;
  }

  const caseAttemptsDir = path.join(runDir, "cases", caseId, "attempts");
  const caseAttemptsDesc = listAttemptDirs(caseAttemptsDir).reverse();
  const orderedCaseAttempts = selectedAttemptId && caseAttemptsDesc.includes(selectedAttemptId)
    ? [selectedAttemptId, ...caseAttemptsDesc.filter((a) => a !== selectedAttemptId)]
    : caseAttemptsDesc;

  for (const attempt of orderedCaseAttempts) {
    const subCsv = path.join(caseAttemptsDir, attempt, "submissions", "csv", `${caseId}.csv`);
    if (existsSync(subCsv)) return subCsv;
    const directCsv = path.join(caseAttemptsDir, attempt, "result.csv");
    if (existsSync(directCsv)) return directCsv;
  }

  const directCandidates = [
    path.join(runDir, "cases", caseId, "submissions", "csv", `${caseId}.csv`),
    path.join(runDir, "cases", caseId, "result.csv"),
  ];
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const jsonlPath = casesJsonlCsvMap.get(caseId);
  if (jsonlPath && existsSync(jsonlPath)) return jsonlPath;

  return null;
}

function loadCasesJsonlCsvMap(runDir) {
  const map = new Map();
  const casesJsonlPath = path.join(runDir, "cases.jsonl");
  if (!existsSync(casesJsonlPath)) return map;
  for (const line of readFileSync(casesJsonlPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const id = item.instanceId ?? item.instance_id ?? item.caseId;
      const csvPath = item.resultCsvPath ?? item.csvPath;
      if (id && csvPath) map.set(String(id), String(csvPath));
    } catch {
      // Ignore malformed lines in fallback scan.
    }
  }
  return map;
}

function resolveGoldCsvPaths(goldExecDir, caseId) {
  if (!existsSync(goldExecDir)) return [];
  const exact = `${caseId}.csv`;
  const prefix = `${caseId}_`;
  return readdirSync(goldExecDir)
    .filter((f) => f === exact || (f.startsWith(prefix) && f.endsWith(".csv")))
    .sort()
    .map((f) => path.join(goldExecDir, f));
}

function parseCliArgs(argv) {
  const opts = { blind: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--blind") {
      opts.blind = true;
    } else if (arg === "--run") {
      opts.run = argv[++i];
    } else if (arg === "--gold") {
      opts.gold = argv[++i];
    } else if (arg === "--ids-file") {
      opts.idsFile = argv[++i];
    } else if (arg === "--labels") {
      opts.labels = argv[++i];
    } else if (arg === "--probe-labels") {
      opts.probeLabels = argv[++i];
    } else if (arg === "--out") {
      opts.out = argv[++i];
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
  if (opts.help || !opts.run || !opts.gold) {
    console.log("Usage: node evaluations/spider2/stratified-scoring.mjs --run <runDir> --gold <goldExecDir> [--ids-file <path>] [--labels <jsonl>] [--probe-labels <json>] [--blind] [--out <json>]");
    process.exit(opts.help ? 0 : 1);
  }

  const runDir = path.resolve(opts.run);
  const goldExecDir = path.resolve(opts.gold);
  const manifestPath = path.join(runDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const officialScores = loadOfficialScores(runDir);

  const denominatorIds = opts.idsFile
    ? readIdsFile(path.resolve(opts.idsFile))
    : Array.isArray(manifest.instanceIds) && manifest.instanceIds.length > 0
      ? manifest.instanceIds
      : Object.keys(officialScores);

  const goldDefectIds = opts.labels ? readGoldDefectIds(path.resolve(opts.labels)) : [];
  const probeResults = opts.probeLabels ? JSON.parse(readFileSync(path.resolve(opts.probeLabels), "utf8")) : undefined;

  const selectedAttemptId = manifest.attemptPolicy?.selectedAttemptId;
  const inputsAttemptsDesc = listAttemptDirs(path.join(runDir, "official_score", "inputs")).reverse();
  const casesJsonlCsvMap = loadCasesJsonlCsvMap(runDir);

  const outputShapeMismatchIds = [];
  for (const caseId of denominatorIds) {
    if (officialScores[caseId] === 1) continue;
    const predPath = resolvePredCsvPath(runDir, caseId, selectedAttemptId, inputsAttemptsDesc, casesJsonlCsvMap);
    if (!predPath) continue;
    const goldPaths = resolveGoldCsvPaths(goldExecDir, caseId);
    if (goldPaths.length === 0) continue;

    const predCsvText = readFileSync(predPath, "utf8");
    const goldCsvTexts = goldPaths.map((p) => readFileSync(p, "utf8"));
    const classification = classifyOutputShapeMismatch(predCsvText, goldCsvTexts);
    if (classification.isOutputShapeMismatch) {
      outputShapeMismatchIds.push(caseId);
    }
  }

  const scoreboard = computeStratifiedScoreboard({
    denominatorIds,
    officialScores,
    goldDefectIds,
    outputShapeMismatchIds,
    probeResults,
    blind: opts.blind,
  });

  if (opts.out) {
    writeFileSync(path.resolve(opts.out), `${JSON.stringify(scoreboard, null, 2)}\n`, "utf8");
  }

  console.log(formatStratifiedMarkdown(scoreboard));
  console.log("");
  console.log(JSON.stringify(scoreboard, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
