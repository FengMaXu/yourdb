import { randomUUID } from "node:crypto";
import type { CheckCoverage, Finding, SpecFields } from "./model.js";
import { grainOf, layersOf, type MeasureExpression, type MeasureOperand, type SpecPath, type Grain } from "./fields.js";
import { aggregatingBlocks, aggregationCapacity, digestSql, type DigestBlock, type DigestColumn, type DigestResult, type QueryDigest } from "./sql-digest.js";
import type { FanoutDialect } from "./fanout-check.js";
import { settledField } from "./support.js";
import { maskSql } from "./sql-lex.js";

/**
 * Spec realization: does the final SQL implement the sealed fields? The Spec
 * settles meaning; this check reads only the fields and the SQL text, never
 * the conversation, and judges implementation, not whether the meaning is
 * right. A `certain` conflict cannot be a correct implementation of the
 * field and blocks before the SQL runs; a `likely` conflict is a structural
 * signal with known exceptions and is disclosed with the result (ADR-0003).
 * A path the rules cannot read is reported as not determinable, never as realized.
 */
export const SPEC_REALIZATION_CHECK_ID = "spec_realization";
export const SPEC_REALIZATION_RULE_VERSION = "spec-realization-v2";

export type RealizationVerdict =
  | { readonly path: SpecPath; readonly outcome: "realized" }
  | { readonly path: SpecPath; readonly outcome: "not_determinable"; readonly reason: string }
  | { readonly path: SpecPath; readonly outcome: "contradicted"; readonly certainty: "certain" | "likely"; readonly message: string };

export interface RealizationReport {
  readonly verdicts: readonly RealizationVerdict[];
  readonly findings: readonly Finding[];
  readonly coverage: CheckCoverage;
}

interface SqlText {
  /** Lower-cased SQL with string literals and comments blanked; structure only. */
  readonly masked: string;
  /** Lower-cased SQL with comments blanked; literals kept for date formats such as '%Y-%m'. */
  readonly withLiterals: string;
  readonly depths: Int32Array;
  /** Structure read by the SQL parser; `unsupported` leaves the digest rules not determinable. */
  readonly digest: DigestResult;
}

function sqlText(sql: string, dialect?: FanoutDialect): SqlText {
  const masked = maskSql(sql, { identifiers: false }).toLowerCase();
  const depths = new Int32Array(masked.length);
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    depths[index] = depth;
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")") depth = Math.max(0, depth - 1);
  }
  return { masked, withLiterals: maskSql(sql, { strings: false, identifiers: false }).toLowerCase(), depths, digest: digestSql(sql, dialect) };
}


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- population.source -------------------------------------------------------

/** The table name a declared source item names, or undefined when it is not a plain identifier. */
function declaredTable(item: string): string | undefined {
  const match = /^\s*([`"[]?[A-Za-z_][\w$]*[`"\]]?(?:\s*\.\s*[`"[]?[A-Za-z_][\w$-]*[`"\]]?)*)/.exec(item);
  if (!match || /[*?]/.test(item.slice(0, match[0].length + 1))) return undefined;
  const parts = match[1]!.split(".").map((part) => part.trim().replace(/^[`"[]|[`"\]]$/g, ""));
  return parts.at(-1)?.toLowerCase();
}

function sourceVerdict(fields: SpecFields, sql: SqlText): RealizationVerdict | undefined {
  const source = settledField(fields, "population.source");
  if (!source) return undefined;
  const path = "population.source";
  const names = source.tables.map(declaredTable);
  if (names.some((name) => !name)) return { path, outcome: "not_determinable", reason: "a declared table is not a plain identifier" };
  const missing = source.tables.filter((_, index) => !new RegExp(`(^|[^\\w$])${escapeRegExp(names[index]!)}($|[^\\w$])`).test(sql.masked));
  if (missing.length === 0) return { path, outcome: "realized" };
  return {
    path,
    outcome: "contradicted",
    // Calibrated on the 2026-10-10 field-tree run: correct answers skip declared lookup tables by filtering on their keys.
    certainty: "likely",
    message: `population.source declares ${missing.map((item) => JSON.stringify(item)).join(", ")}, but the SQL never reads ${missing.length === 1 ? "it" : "them"}. Read the declared source, or drop ${missing.length === 1 ? "it" : "them"} from population.source if the answer does not need ${missing.length === 1 ? "it" : "them"}`,
  };
}

// --- selection and selection.ties -------------------------------------------

/** Row cap of the outermost query: LIMIT k, FETCH FIRST k ROWS, or TOP k, at parenthesis depth 0. */
function outermostCap(sql: SqlText): { readonly rows: number; readonly withTies: boolean } | undefined {
  // MySQL's LIMIT offset, count caps at its second number.
  const patterns: readonly [RegExp, (match: RegExpMatchArray) => { readonly rows: number; readonly withTies: boolean }][] = [
    [/\blimit\s+(\d+)(?:\s*,\s*(\d+))?/g, (match) => ({ rows: Number(match[2] ?? match[1]), withTies: false })],
    [/\bfetch\s+(?:first|next)\s+(\d+)\s+rows?\s+(only|with\s+ties)/g, (match) => ({ rows: Number(match[1]), withTies: /ties/.test(match[2]!) })],
    [/\bselect\s+(?:distinct\s+)?top\s+(\d+)(\s+with\s+ties)?/g, (match) => ({ rows: Number(match[1]), withTies: Boolean(match[2]) })],
  ];
  let last: { readonly index: number; readonly rows: number; readonly withTies: boolean } | undefined;
  for (const [pattern, read] of patterns) {
    for (const match of sql.masked.matchAll(pattern)) {
      if (match.index === undefined || sql.depths[match.index] !== 0) continue;
      if (!last || match.index > last.index) last = { index: match.index, ...read(match) };
    }
  }
  return last && { rows: last.rows, withTies: last.withTies };
}

function selectionVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const selection = settledField(fields, "selection");
  const ties = settledField(fields, "selection.ties");
  if (!selection || !ties) return [];
  const path = "selection.ties";
  const cap = outermostCap(sql);
  if (!cap) {
    // Without a final row cap the cut is a rank filter; ROW_NUMBER alone breaks ties arbitrarily.
    if (ties === "include_ties" && /\brow_number\s*\(/.test(sql.masked) && !/\b(dense_rank|rank)\s*\(/.test(sql.masked)) {
      return [{ path, outcome: "contradicted", certainty: "likely", message: `selection.ties=include_ties, but the SQL ranks only with ROW_NUMBER, which keeps one row per tie arbitrarily. Use RANK or DENSE_RANK, or rewrite selection.ties with a reason` }];
    }
    return [{ path, outcome: "not_determinable", reason: "the outermost query has no row cap; the cut is made by a filter the rules do not read" }];
  }
  if (ties === "strict" && cap.rows !== selection.n) {
    return [{ path: "selection", outcome: "contradicted", certainty: "certain", message: `selection.n=${selection.n}, but the outermost query keeps ${cap.rows} rows. Cap the final query at ${selection.n}, or rewrite selection with a reason` }];
  }
  if (ties === "include_ties" && cap.rows <= selection.n && !cap.withTies) {
    return [{ path, outcome: "contradicted", certainty: "certain", message: `selection.ties=include_ties, but the outermost query is capped at ${cap.rows} rows, which drops rows tied at the cut. Filter on RANK() <= ${selection.n} instead of a row cap, or rewrite selection.ties with a reason` }];
  }
  return [{ path, outcome: "realized" }];
}

// --- measure.formula ----------------------------------------------------------

const AGGREGATE_OPS = new Set(["count", "count_distinct", "sum", "avg", "median", "min", "max"]);

function operands(expression: MeasureExpression): readonly MeasureOperand[] {
  return [expression.of, expression.numerator, expression.denominator, expression.from, expression.to].filter((item): item is MeasureOperand => item !== undefined);
}

function someOp(expression: MeasureExpression, ops: ReadonlySet<string>): boolean {
  return ops.has(expression.op) || operands(expression).some((item) => typeof item !== "string" && someOp(item, ops));
}

/** Aggregation layers on the deepest path: avg per country of avg per player of sum per match is 3. */
function aggregateDepth(expression: MeasureExpression): number {
  const below = Math.max(0, ...operands(expression).map((item) => typeof item === "string" ? 0 : aggregateDepth(item)));
  return below + (AGGREGATE_OPS.has(expression.op) ? 1 : 0);
}

const AGGREGATE_CALL = /\b(count|sum|avg|min|max|median|total|group_concat|string_agg|array_agg|percentile_cont|percentile_disc|approx_quantiles|stddev\w*|variance)\s*\(/g;

function closingParen(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index++) {
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")" && --depth === 0) return index;
  }
  return masked.length;
}

/**
 * How many aggregation layers the SQL can perform: each SELECT block that
 * aggregates is one layer, and each windowed aggregate is one more.
 */
function aggregateCapacity(sql: SqlText): number {
  const selects = [...sql.masked.matchAll(/\bselect\b/g)].map((match) => match.index!);
  const blocks = new Set<number>();
  let windows = 0;
  for (const match of sql.masked.matchAll(AGGREGATE_CALL)) {
    const at = match.index!;
    const open = at + match[0].length - 1;
    if (/^\s*over\b/.test(sql.masked.slice(closingParen(sql.masked, open) + 1))) {
      windows += 1;
      continue;
    }
    // The owning SELECT is the nearest one before the call whose parenthesis level the text never leaves on the way to the call.
    const owner = selects.filter((select) => select < at).reverse().find((select) => {
      for (let offset = select; offset <= at; offset++) if (sql.depths[offset]! < sql.depths[select]!) return false;
      return true;
    });
    if (owner !== undefined) blocks.add(owner);
  }
  return blocks.size + windows;
}

function formulaVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const formula = settledField(fields, "measure.formula");
  if (!formula) return [];
  const path = "measure.formula";
  const verdicts: RealizationVerdict[] = [];
  // A percentage-point difference of ratios needs the same factor of 100 as a percentage.
  const hundredOp = someOp(formula, new Set(["percentage"])) ? "percentage" : someOp(formula, new Set(["pp_difference"])) ? "pp_difference" : undefined;
  if (hundredOp && !/(^|[^\w.])(100(\.0*)?|1e2)([^\w.]|$)/.test(sql.masked)) {
    const message = hundredOp === "percentage"
      ? "measure.formula uses percentage (100·a/b), but the SQL never multiplies by 100. Multiply by 100, or rewrite measure.formula as ratio with a reason"
      : "measure.formula uses pp_difference (a percentage-point difference), but the SQL never multiplies by 100. Multiply the difference of the ratios by 100, or rewrite measure.formula as difference with a reason";
    verdicts.push({ path, outcome: "contradicted", certainty: "certain", message });
  }
  if (someOp(formula, new Set(["count_distinct"])) && !/\bdistinct\b/.test(sql.masked)) {
    verdicts.push({ path, outcome: "contradicted", certainty: "likely", message: "measure.formula uses count_distinct, but the SQL has no DISTINCT. Count distinct keys unless an earlier GROUP BY already made them unique" });
  }
  const depth = aggregateDepth(formula);
  // The digest counts aggregation blocks exactly; the text scan is the fallback when the parser cannot read the SQL.
  const capacity = sql.digest.status === "parsed" ? aggregationCapacity(sql.digest) : aggregateCapacity(sql);
  if (depth > 1 && capacity < depth) {
    verdicts.push({ path, outcome: "contradicted", certainty: "likely", message: `measure.formula nests ${depth} aggregation layers, but the SQL aggregates in at most ${capacity}. Compute each layer per its declared grain, unless the source rows are already at an inner layer's grain` });
  }
  return verdicts.length > 0 ? verdicts : [{ path, outcome: "realized" }];
}

// --- grouping grain -----------------------------------------------------------

const GRAIN_SQL: Readonly<Record<Grain, RegExp>> = {
  year: /year|%y|yyyy|\b(substr|substring|left)\w*\s*\([^()]*,\s*(1\s*,\s*)?4\s*\)/,
  quarter: /quarter|%q|\bq\b|\/\s*3(\.0*)?\b/,
  month: /month|%m|yyyy-mm|\bmm\b|\b(substr|substring|left)\w*\s*\([^()]*,\s*(1\s*,\s*)?7\s*\)|\b(substr|substring)\w*\s*\([^()]*,\s*6\s*,\s*2\s*\)/,
  week: /week|%w|%u|%v|\biw\b|\bww\b/,
  day: /\bday|%d|\bdate\b|date\s*\(|::date|date_trunc|\b(substr|substring|left)\w*\s*\([^()]*,\s*(1\s*,\s*)?10\s*\)/,
  hour: /hour|%h|\bhh/,
};

function groupingVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const keys = settledField(fields, "grouping");
  if (!keys) return [];
  const grains = keys.flatMap((key) => typeof key === "string" || !key.grain ? [] : [key.grain]);
  if (grains.length === 0) return [{ path: "grouping", outcome: "not_determinable", reason: "no grouping key declares a calendar grain" }];
  const verdicts = grains.map((text): RealizationVerdict => {
    const grain = grainOf(text);
    if (!grain) return { path: "grouping", outcome: "not_determinable", reason: `grain ${JSON.stringify(text)} is not a calendar grain the rules read` };
    if (GRAIN_SQL[grain].test(sql.withLiterals)) return { path: "grouping", outcome: "realized" };
    return { path: "grouping", outcome: "contradicted", certainty: "likely", message: `grouping declares a ${grain} grain (${JSON.stringify(text)}), but the SQL never truncates or extracts a ${grain}. Group on the declared grain, or rewrite grouping with a reason` };
  });
  return verdicts.find((item) => item.outcome === "contradicted") ? verdicts.filter((item) => item.outcome === "contradicted") : verdicts.slice(0, 1);
}

// --- digest rules (plan T5.2): per-layer grain, count grain, condition stage -------

const DIGEST_UNREAD = "the SQL parser could not read the statement";

/** Lower-case word stems of a text, for matching a declared grain against column and table names. */
function stems(text: string): readonly string[] {
  return text.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter((word) => word.length >= 3).map((word) => word.replace(/(ies)$/, "y").replace(/(?<=[a-z]{3})s$/, ""));
}

/** Names a grouping column stands for: the column, and for an id-like column the table it belongs to. */
function columnNames(block: DigestBlock, column: DigestColumn): readonly string[] {
  const relation = block.relations.find((item) => item.alias === column.table || item.table === column.table);
  return [column.column, ...(relation ? [relation.table] : [])];
}

function mentions(per: string, names: readonly string[]): boolean {
  const wanted = stems(per);
  const have = names.flatMap(stems);
  return wanted.some((word) => have.some((name) => name === word || name.startsWith(word) || word.startsWith(name)));
}

function layerVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const formula = settledField(fields, "measure.formula");
  if (!formula) return [];
  const layers = layersOf(formula).filter((layer) => AGGREGATE_OPS.has(layer.op));
  const inner = layers.slice(1).filter((layer) => layer.per);
  if (inner.length === 0) return [];
  const path = "measure.formula";
  if (sql.digest.status !== "parsed") return [{ path, outcome: "not_determinable", reason: `${DIGEST_UNREAD}: ${sql.digest.reason}` }];
  // Innermost aggregation first, on both sides: formula layers nest outer to inner, SQL blocks by depth.
  const blocks = [...aggregatingBlocks(sql.digest)].sort((left, right) => right.depth - left.depth || right.id - left.id);
  // Fewer aggregation blocks than layers is the capacity rule’s finding; matching layers to blocks needs one block per layer.
  if (blocks.length < layers.length) return [];
  const declared = layers.slice(1).reverse();
  const verdicts: RealizationVerdict[] = [];
  declared.forEach((layer, index) => {
    const block = blocks[index];
    if (!layer.per || !block) return;
    const keys = block.groupBy.flatMap((column) => columnNames(block, column));
    if (block.groupBy.length === 0) {
      verdicts.push({ path, outcome: "contradicted", certainty: "likely", message: `measure.formula computes ${layer.op} per ${layer.per}, but the SQL block that aggregates at that layer has no GROUP BY, so it aggregates over every row at once. Group that layer by ${layer.per}` });
      return;
    }
    if (mentions(layer.per, keys)) return;
    const outer = layers.find((other) => other !== layer && other.per && mentions(other.per, keys));
    verdicts.push(outer
      ? { path, outcome: "contradicted", certainty: "likely", message: `measure.formula computes ${layer.op} per ${layer.per}, but the SQL groups that layer by ${block.groupBy.map((column) => column.column).join(", ")}, the grain of the ${outer.op} per ${outer.per} layer. Group the inner layer by ${layer.per} first` }
      : { path, outcome: "not_determinable", reason: `the GROUP BY ${block.groupBy.map((column) => column.column).join(", ")} does not name ${layer.per} in a way the rules read` });
  });
  return verdicts.length > 0 ? verdicts : [{ path, outcome: "realized" }];
}

function countAggregates(digest: QueryDigest): readonly { readonly block: DigestBlock; readonly distinct: boolean; readonly columns: readonly DigestColumn[] }[] {
  return digest.blocks.flatMap((block) => block.aggregates.filter((item) => !item.windowed && item.fn === "count").map((item) => ({ block, distinct: item.distinct, columns: item.columns })));
}

function countGrainVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const grain = settledField(fields, "measure.countGrain");
  const formula = settledField(fields, "measure.formula");
  if (!grain || !formula || !layersOf(formula).some((layer) => layer.op === "count" || layer.op === "count_distinct")) return [];
  const path = "measure.countGrain";
  if (grain.grain === "event" || (grain.grain === "entity" && !grain.keyColumns?.length)) return [{ path, outcome: "not_determinable", reason: `countGrain ${grain.grain} names no key the rules can read` }];
  if (sql.digest.status !== "parsed") return [{ path, outcome: "not_determinable", reason: `${DIGEST_UNREAD}: ${sql.digest.reason}` }];
  const counts = countAggregates(sql.digest);
  if (counts.length === 0) return [{ path, outcome: "not_determinable", reason: "the SQL has no COUNT to compare with the count grain" }];
  if (grain.grain === "row") {
    const distinct = counts.find((item) => item.distinct);
    return distinct
      ? [{ path, outcome: "contradicted", certainty: "likely", message: `measure.countGrain counts rows, but the SQL counts COUNT(DISTINCT ${distinct.columns.map((column) => column.column).join(", ")}), which merges equal values. Count rows, or rewrite measure.countGrain as entity with its keyColumns` }]
      : [{ path, outcome: "realized" }];
  }
  const keys = new Set((grain.keyColumns ?? []).map((key) => key.split(".").at(-1)!.toLowerCase()));
  const distinctOnKey = counts.some((item) => item.distinct && item.columns.some((column) => keys.has(column.column)));
  // Rows already made unique per key by a GROUP BY below the count are entities too.
  const groupedOnKey = sql.digest.blocks.some((block) => block.groupBy.some((column) => keys.has(column.column)));
  if (distinctOnKey || groupedOnKey) return [{ path, outcome: "realized" }];
  return [{ path, outcome: "contradicted", certainty: "likely", message: `measure.countGrain counts entities by ${[...keys].join(", ")}, but the SQL counts rows (COUNT without DISTINCT on that key, and no GROUP BY on it), so an entity with several rows counts several times. Count DISTINCT ${[...keys].join(", ")}, or rewrite measure.countGrain as row` }];
}

type Stage = "pre" | "post" | "window";

function expectedStage(text: string): Stage | undefined {
  if (/window|qualify|窗口/i.test(text)) return "window";
  if (/having|group|aggregat|after|聚合后|分组后/i.test(text)) return "post";
  if (/where|row|before|聚合前|行/i.test(text)) return "pre";
  return undefined;
}

function conditionVerdicts(fields: SpecFields, sql: SqlText): readonly RealizationVerdict[] {
  const conditions = settledField(fields, "population.conditions");
  const staged = (conditions ?? []).flatMap((item) => typeof item === "string" || !item.stage ? [] : [{ condition: item.condition, stage: expectedStage(item.stage), declared: item.stage }]);
  if (staged.length === 0) return [];
  const path = "population.conditions";
  if (sql.digest.status !== "parsed") return [{ path, outcome: "not_determinable", reason: `${DIGEST_UNREAD}: ${sql.digest.reason}` }];
  const digest = sql.digest;
  const aggregating = new Set(aggregatingBlocks(digest).map((block) => block.id));
  const verdicts: RealizationVerdict[] = [];
  for (const item of staged) {
    if (!item.stage) { verdicts.push({ path, outcome: "not_determinable", reason: `stage ${JSON.stringify(item.declared)} is not a stage the rules read` }); continue; }
    const words = new Set(stems(item.condition));
    const found = new Set<Stage | "either">();
    for (const block of digest.blocks) {
      for (const filter of block.filters) {
        if (!filter.columns.some((column) => stems(column.column).some((word) => words.has(word)))) continue;
        if (filter.stage === "having") found.add("post");
        else if (filter.stage === "qualify") found.add("window");
        // A WHERE over an aggregated CTE or subquery filters groups, not source rows.
        else if (block.reads.some((id) => aggregating.has(id))) found.add("either");
        else found.add("pre");
      }
    }
    if (found.size === 0) { verdicts.push({ path, outcome: "not_determinable", reason: `no filter reads the columns of ${JSON.stringify(item.condition)}` }); continue; }
    if (found.has(item.stage) || found.has("either")) { verdicts.push({ path, outcome: "realized" }); continue; }
    const where = [...found].map((stage) => stage === "pre" ? "WHERE/ON on source rows" : stage === "post" ? "HAVING on groups" : "QUALIFY after a window").join(" and ");
    verdicts.push({ path, outcome: "contradicted", certainty: "likely", message: `population.conditions applies ${JSON.stringify(item.condition)} at stage ${JSON.stringify(item.declared)}, but the SQL filters it in ${where}. Move the filter to the declared stage, or rewrite its stage with a reason` });
  }
  const contradicted = verdicts.filter((verdict) => verdict.outcome === "contradicted");
  return contradicted.length > 0 ? contradicted : verdicts;
}

// --- report --------------------------------------------------------------------

export function evaluateSpecRealization(fields: SpecFields, sql: string, dialect?: FanoutDialect): RealizationReport {
  const text = sqlText(sql, dialect);
  const verdicts = [
    ...[sourceVerdict(fields, text)].filter((item): item is RealizationVerdict => item !== undefined),
    ...selectionVerdicts(fields, text),
    ...formulaVerdicts(fields, text),
    ...groupingVerdicts(fields, text),
    ...layerVerdicts(fields, text),
    ...countGrainVerdicts(fields, text),
    ...conditionVerdicts(fields, text),
  ];
  const findings = verdicts.flatMap((verdict): Finding[] => verdict.outcome === "contradicted"
    ? [{ id: `finding_realization_conflict_${randomUUID()}`, kind: "realization_conflict", message: verdict.message, blocking: verdict.certainty === "certain", checkId: SPEC_REALIZATION_CHECK_ID, paths: [verdict.path] }]
    : []);
  const undetermined = verdicts.flatMap((verdict) => verdict.outcome === "not_determinable" ? [`${verdict.path}: ${verdict.reason}`] : []);
  const coverage: CheckCoverage = verdicts.length === 0
    ? { checkId: SPEC_REALIZATION_CHECK_ID, ruleVersion: SPEC_REALIZATION_RULE_VERSION, outcome: "not_applicable", reason: "no sealed field has a rule that reads SQL" }
    : findings.length > 0
      ? { checkId: SPEC_REALIZATION_CHECK_ID, ruleVersion: SPEC_REALIZATION_RULE_VERSION, outcome: "finding", reason: findings.map((item) => item.message).join(" | ") }
      : undetermined.length > 0 && (verdicts.every((verdict) => verdict.outcome === "not_determinable") || verdicts.some((verdict) => verdict.outcome === "not_determinable" && verdict.reason.startsWith(DIGEST_UNREAD)))
        ? { checkId: SPEC_REALIZATION_CHECK_ID, ruleVersion: SPEC_REALIZATION_RULE_VERSION, outcome: "unknown", reason: undetermined.join(" | ") }
        : { checkId: SPEC_REALIZATION_CHECK_ID, ruleVersion: SPEC_REALIZATION_RULE_VERSION, outcome: "clear", ...(undetermined.length > 0 ? { reason: `not determinable: ${undetermined.join(" | ")}` } : {}) };
  return { verdicts, findings, coverage };
}

/** One line for the Receipt: likely conflicts the result was delivered with. */
export function realizationDisclosure(findings: readonly Finding[]): string {
  const conflicts = findings.filter((item) => item.kind === "realization_conflict" && !item.blocking);
  return conflicts.length > 0 ? `SQL 与已封存口径可能不一致（结构检查，未经人工确认）：${conflicts.map((item) => item.message).join("；")}。` : "";
}
