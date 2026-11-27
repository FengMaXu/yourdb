import { randomUUID } from "node:crypto";
import type { BusinessContext, CheckCoverage, Finding } from "./model.js";
import { contentHash } from "./model.js";
import { SchemaProfile } from "./schema-profile.js";
import { maskSql } from "./sql-lex.js";
import { degeneratedOuterJoins, digestSql, type QueryDigest } from "./sql-digest.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";

/**
 * SQL-vs-data falsification (plan T4.3). Deterministic rules that look for a
 * known way a final SQL silently answers something other than it seems to,
 * then confirm it against the data with small bounded probes:
 *
 * 1. left_join_degenerated (static): a WHERE predicate on the right side of a
 *    LEFT JOIN that NULL rows cannot pass, which turns it into an INNER JOIN.
 * 2. date_upper_bound_truncated: `col <= 'YYYY-MM-DD'` (or BETWEEN … AND
 *    'YYYY-MM-DD') on a column that holds times on that day, which the bound
 *    drops.
 * 3. literal_not_matched: on an empty (or all-zero) result, `col = 'literal'`
 *    matches no row while the column has the value in another case or with
 *    surrounding spaces.
 * 4. temporal_anchor_drift: the SQL reads the system clock (CURRENT_DATE,
 *    NOW(), DATE('now'), ...), while all inspected table time columns end more
 *    than TEMPORAL_ANCHOR_DRIFT_DAYS earlier than the system date.
 *
 * Findings are disclosed, never blocking, until offline replay calibrates
 * them (ADR-0003). A probe that cannot run makes the rule `unknown`, never
 * `clear`.
 */
export const DATA_FALSIFICATION_CHECK_ID = "data_falsification";
export const DATA_FALSIFICATION_RULE_VERSION = "data-falsification-v2";
/** Probes per result query, over all rules. */
export const DATA_FALSIFICATION_MAX_PROBES = 4;
/** Each probe is abandoned after this long. */
export const DATA_FALSIFICATION_TIMEOUT_MS = 3_000;
/** Calendar-day gap above which current system clock references trigger a non-blocking drift notice. */
export const TEMPORAL_ANCHOR_DRIFT_DAYS = 365;
/** Cap on source tables profiled per result query for temporal anchor checks. */
export const TEMPORAL_ANCHOR_MAX_TABLES = 5;

export type DataFalsificationRule = "left_join_degenerated" | "date_upper_bound_truncated" | "literal_not_matched" | "temporal_anchor_drift";

export interface DataFalsificationFinding {
  readonly rule: DataFalsificationRule;
  readonly message: string;
}

export interface DataFalsificationReport {
  readonly ruleVersion: typeof DATA_FALSIFICATION_RULE_VERSION;
  readonly status: "clear" | "finding" | "not_applicable" | "unknown";
  readonly findings: readonly DataFalsificationFinding[];
  readonly limitations: readonly string[];
  /** Rules whose pattern occurred in the SQL. */
  readonly applied: readonly DataFalsificationRule[];
}

const IDENT = "[a-z_][a-z0-9_$]*";
const QUALIFIED = `${IDENT}(?:\\.${IDENT})?`;
const STOP = new Set(["on", "where", "join", "left", "right", "inner", "outer", "full", "cross", "group", "order", "limit", "using", "natural", "union", "having", "window", "qualify", "lateral", "set"]);

interface Text {
  /** Lower-cased SQL, literals, quoted identifiers and comments blanked. */
  readonly masked: string;
  /** Lower-cased SQL, comments blanked, literals and identifiers kept. */
  readonly literals: string;
  /** The original SQL, comments blanked, case kept (literals are read from here). */
  readonly original: string;
  readonly depths: Int32Array;
}

function textOf(sql: string): Text {
  const masked = maskSql(sql).toLowerCase();
  const original = maskSql(sql, { strings: false, identifiers: false });
  const depths = new Int32Array(masked.length);
  let depth = 0;
  for (let index = 0; index < masked.length; index++) {
    depths[index] = depth;
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")") depth = Math.max(0, depth - 1);
  }
  return { masked, literals: original.toLowerCase(), original, depths };
}

/** alias (or bare table name) → table, from FROM/JOIN items of plain names. */
function relations(text: Text): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of text.masked.matchAll(new RegExp(`\\b(?:from|join)\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "g"))) {
    const table = match[1]!;
    const alias = match[2] && !STOP.has(match[2]) ? match[2] : undefined;
    map.set(alias ?? table.split(".").at(-1)!, table);
    if (alias) map.set(table.split(".").at(-1)!, table);
  }
  return map;
}

/** The text of the WHERE clause at `depth` that follows `from`, up to the clause that ends it. */
function whereAfter(text: Text, from: number, depth: number): { readonly start: number; readonly end: number } | undefined {
  const { masked, depths } = text;
  let start: number | undefined;
  const clause = /\b(where|group\s+by|order\s+by|having|limit|union|intersect|except|window|qualify|select)\b/g;
  clause.lastIndex = from;
  for (let match = clause.exec(masked); match; match = clause.exec(masked)) {
    if (depths[match.index] !== depth) {
      // Left this block through a closing parenthesis.
      if (depths[match.index]! < depth) break;
      continue;
    }
    if (start === undefined) {
      if (match[1] === "where") start = match.index + match[0].length;
      else if (match[1] !== "select") return undefined;
      continue;
    }
    return { start, end: match.index };
  }
  if (start === undefined) return undefined;
  // The block ends at the first parenthesis that closes it.
  let end = start;
  while (end < masked.length && depths[end]! >= depth) end++;
  return { start, end };
}

/** Predicates of a WHERE clause split on AND / OR at its own depth. */
function atoms(text: Text, range: { readonly start: number; readonly end: number }): readonly string[] {
  const out: string[] = [];
  const depth = text.depths[range.start]!;
  let last = range.start;
  const splitter = /\b(and|or)\b/g;
  splitter.lastIndex = range.start;
  const between = /\bbetween\b/;
  for (let match = splitter.exec(text.masked); match && match.index < range.end; match = splitter.exec(text.masked)) {
    if (text.depths[match.index] !== depth) continue;
    const piece = text.literals.slice(last, match.index);
    // The AND of BETWEEN … AND … is not a separator.
    if (match[1] === "and" && between.test(piece) && !/\bbetween\b[\s\S]*\band\b/.test(piece)) continue;
    out.push(piece.trim());
    last = match.index + match[0].length;
  }
  out.push(text.literals.slice(last, range.end).trim());
  return out.filter(Boolean);
}

function leftJoinFindings(text: Text): { readonly applied: boolean; readonly findings: DataFalsificationFinding[] } {
  const findings: DataFalsificationFinding[] = [];
  let applied = false;
  for (const match of text.masked.matchAll(new RegExp(`\\bleft\\s+(?:outer\\s+)?join\\s+(${QUALIFIED})(?:\\s+(?:as\\s+)?(${IDENT}))?`, "g"))) {
    applied = true;
    const alias = match[2] && !STOP.has(match[2]) ? match[2] : match[1]!.split(".").at(-1)!;
    const where = whereAfter(text, match.index! + match[0].length, text.depths[match.index!]!);
    if (!where) continue;
    const reference = new RegExp(`(^|[^\\w.$])${alias.replace(/\$/g, "\\$")}\\s*\\.\\s*(${IDENT})`);
    for (const atom of atoms(text, where)) {
      const column = reference.exec(atom);
      if (!column) continue;
      // A predicate NULL rows still pass keeps the outer join meaningful.
      if (/\bis\s+null\b|\bcoalesce\s*\(|\bifnull\s*\(|\bnvl\s*\(|\bisnull\s*\(|\bis\s+not\s+distinct\b|\bor\b/.test(atom)) continue;
      findings.push({
        rule: "left_join_degenerated",
        message: `The WHERE predicate "${atom.replace(/\s+/g, " ").slice(0, 120)}" filters ${alias}.${column[2]}, the right side of a LEFT JOIN; rows ${alias} does not match have NULL there and are removed, so the LEFT JOIN acts as an INNER JOIN. Move the condition into the ON clause if unmatched rows should stay, or write INNER JOIN if they should not`,
      });
      break;
    }
  }
  return { applied, findings };
}

function digestJoinFindings(digest: QueryDigest): { readonly applied: boolean; readonly findings: DataFalsificationFinding[] } {
  const applied = digest.blocks.some((block) => block.relations.some((relation) => relation.join === "left"));
  const findings = degeneratedOuterJoins(digest).map((item): DataFalsificationFinding => ({
    rule: "left_join_degenerated",
    message: `A WHERE predicate filters ${item.alias}.${item.column}, the right side of a LEFT JOIN of ${item.table}; rows ${item.alias} does not match have NULL there and are removed, so the LEFT JOIN acts as an INNER JOIN. Move the condition into the ON clause if unmatched rows should stay, or write INNER JOIN if they should not`,
  }));
  return { applied, findings };
}

interface ColumnRef {
  readonly table: string;
  readonly column: string;
}

function resolve(ref: string, rels: Map<string, string>): ColumnRef | undefined {
  const parts = ref.split(".");
  if (parts.length === 2) {
    const table = rels.get(parts[0]!);
    return table ? { table, column: parts[1]! } : undefined;
  }
  const tables = new Set(rels.values());
  return tables.size === 1 ? { table: [...tables][0]!, column: parts[0]! } : undefined;
}

function nextDay(date: string): string | undefined {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return undefined;
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

interface ProbeRunner {
  count(sql: string): Promise<number | undefined>;
  rows(sql: string, limit: number): Promise<readonly (readonly unknown[])[] | undefined>;
  readonly exhausted: () => boolean;
}

function probeRunner(executor: AnsweringSqlExecutor, context: BusinessContext, options: DataFalsificationOptions): ProbeRunner {
  let used = 0;
  const max = options.maxProbes ?? DATA_FALSIFICATION_MAX_PROBES;
  const run = async (sql: string, limit: number) => {
    if (used >= max) return undefined;
    used += 1;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DATA_FALSIFICATION_TIMEOUT_MS);
    try {
      const result = await executor.run(sql, limit, {
        kind: "exploration",
        idempotencyKey: `data-falsification:${contentHash({ sql })}`,
        signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
        ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
        ...(context.queryScope ? { scope: context.queryScope } : {}),
      });
      return result.rows;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return undefined;
    }
  };
  return {
    count: async (sql) => {
      const rows = await run(sql, 1);
      const value = Number(rows?.[0]?.[0]);
      return rows && Number.isFinite(value) ? value : undefined;
    },
    rows: run,
    exhausted: () => used >= max,
  };
}

const LITERAL = "'((?:[^']|'')*)'";

async function dateBoundFindings(text: Text, rels: Map<string, string>, probes: ProbeRunner, limitations: string[]): Promise<{ readonly applied: boolean; readonly findings: DataFalsificationFinding[] }> {
  const findings: DataFalsificationFinding[] = [];
  const bounds = [
    ...text.literals.matchAll(new RegExp(`(${QUALIFIED})\\s*<=\\s*'(\\d{4}-\\d{2}-\\d{2})'`, "g")),
    ...text.literals.matchAll(new RegExp(`(${QUALIFIED})\\s+between\\s+${LITERAL}\\s+and\\s+'(\\d{4}-\\d{2}-\\d{2})'`, "g")),
  ].map((match) => ({ ref: match[1]!, date: match.at(-1)! }));
  const seen = new Set<string>();
  for (const bound of bounds) {
    const key = `${bound.ref}|${bound.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = resolve(bound.ref, rels);
    const after = nextDay(bound.date);
    if (!ref || !after) {
      limitations.push(`the table of ${bound.ref} is not known`);
      continue;
    }
    const sameDay = await probes.count(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} > '${bound.date}' AND ${ref.column} < '${after}'`);
    if (sameDay === undefined) {
      limitations.push(`${ref.table}.${ref.column} could not be read for ${bound.date}`);
      continue;
    }
    if (sameDay > 0) {
      findings.push({
        rule: "date_upper_bound_truncated",
        message: `The SQL bounds ${bound.ref} by '${bound.date}' inclusive, but ${ref.table}.${ref.column} has ${sameDay} rows later on ${bound.date} (with a time of day), which the bound drops. Use ${bound.ref} < '${after}' to include the whole last day, unless only midnight is meant`,
      });
    }
  }
  return { applied: bounds.length > 0, findings };
}

async function literalFindings(text: Text, rels: Map<string, string>, probes: ProbeRunner, limitations: string[]): Promise<{ readonly applied: boolean; readonly findings: DataFalsificationFinding[] }> {
  const findings: DataFalsificationFinding[] = [];
  // Literals are read from the original text so their case is kept; offsets match the lower-cased text.
  const matches = [...text.literals.matchAll(new RegExp(`(${QUALIFIED})\\s*=\\s*${LITERAL}`, "g"))];
  for (const match of matches) {
    const literal = text.original.slice(match.index! + match[0].length - match[2]!.length - 1, match.index! + match[0].length - 1).replace(/''/g, "'");
    if (/^\d{4}-\d{2}/.test(literal) || /^[-+]?\d+(\.\d+)?$/.test(literal)) continue;
    const ref = resolve(match[1]!, rels);
    if (!ref) {
      limitations.push(`the table of ${match[1]} is not known`);
      continue;
    }
    if (probes.exhausted()) {
      limitations.push("the probe limit was reached");
      break;
    }
    const quoted = `'${literal.replace(/'/g, "''")}'`;
    const exact = await probes.count(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = ${quoted}`);
    if (exact === undefined) {
      limitations.push(`${ref.table}.${ref.column} could not be read`);
      continue;
    }
    if (exact > 0) continue;
    const near = await probes.rows(`SELECT DISTINCT ${ref.column} FROM ${ref.table} WHERE LOWER(TRIM(${ref.column})) = LOWER(TRIM(${quoted})) LIMIT 5`, 5);
    if (near === undefined) {
      limitations.push(`${ref.table}.${ref.column} could not be read`);
      continue;
    }
    const values = near.map((row) => String(row[0]));
    if (values.length > 0) {
      findings.push({
        rule: "literal_not_matched",
        message: `${match[1]} = '${literal}' matches no row of ${ref.table}, but ${ref.column} holds ${values.map((item) => JSON.stringify(item)).join(", ")}, which differ only in case or surrounding spaces. Use the stored value, or compare case-insensitively`,
      });
    }
  }
  return { applied: matches.length > 0, findings };
}

export interface DataFalsificationOptions {
  readonly maxProbes?: number;
  readonly timeoutMs?: number;
  readonly schemaProfile?: SchemaProfile;
  readonly now?: () => Date;
  readonly driftDays?: number;
}

const DIRECT_CLOCK_FALLBACK = /\b(now\s*\(\s*\)|current_timestamp(?:\s*\(\s*\d*\s*\))?|current_date(?:\s*\(\s*\))?|current_time(?:\s*\(\s*\d*\s*\))?|curdate\s*\(\s*\)|curtime\s*\(\s*\)|utc_date\s*\(\s*\)|utc_timestamp\s*\(\s*\)|utc_time\s*\(\s*\)|sysdate(?:\s*\(\s*\))?|getdate\s*\(\s*\)|current_datetime\s*\(\s*\)|localtimestamp(?:\s*\(\s*\d*\s*\))?|localtime(?:\s*\(\s*\d*\s*\))?|clock_timestamp\s*\(\s*\)|statement_timestamp\s*\(\s*\)|transaction_timestamp\s*\(\s*\))\b/g;
const SQLITE_NOW_FALLBACK = /\b(date|datetime|time|julianday|unixepoch)\s*\(\s*'now'/g;
const STRFTIME_NOW_FALLBACK = /\bstrftime\s*\(\s*'(?:[^']|'')*'\s*,\s*'now'/g;
const CALENDAR_DATE = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:$|[\sT]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$)/;

function parseTemporalDate(raw: string): { readonly dayMs: number; readonly isoDate: string } | undefined {
  const match = CALENDAR_DATE.exec(raw.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return {
    dayMs: date.getTime(),
    isoDate: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function fallbackCurrentTimeExpressions(text: Text): readonly string[] {
  const found = new Set<string>();
  for (const match of text.masked.matchAll(DIRECT_CLOCK_FALLBACK)) {
    found.add(match[1]!.replace(/\s+/g, "").replace(/\(\d*\)$/, "").toUpperCase());
  }
  for (const match of text.literals.matchAll(SQLITE_NOW_FALLBACK)) {
    found.add(`${match[1]!.toUpperCase()}('now')`);
  }
  for (const _match of text.literals.matchAll(STRFTIME_NOW_FALLBACK)) {
    found.add("STRFTIME('now')");
  }
  return [...found].sort();
}

async function temporalAnchorDriftFindings(
  executor: AnsweringSqlExecutor,
  digest: ReturnType<typeof digestSql>,
  text: Text,
  rels: Map<string, string>,
  context: BusinessContext,
  options: DataFalsificationOptions,
  limitations: string[],
): Promise<{ readonly applied: boolean; readonly findings: DataFalsificationFinding[] }> {
  const exprs = digest.status === "parsed" ? digest.currentTimeExpressions : fallbackCurrentTimeExpressions(text);
  const tables = [...new Set((digest.status === "parsed" ? digest.tables : [...rels.values()]).map((name) => name.trim().toLowerCase()).filter(Boolean))];
  if (exprs.length === 0 || tables.length === 0) return { applied: false, findings: [] };

  const profile = options.schemaProfile
    ?? (executor.getSchema ? new SchemaProfile(executor, (ctx) => executor.getSchema!(ctx.signal), { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) }) : undefined);
  if (!profile) {
    limitations.push("no schema available to inspect table time ranges");
    return { applied: true, findings: [] };
  }

  let incomplete = false;
  const localLimitations: string[] = [];
  if (tables.length > TEMPORAL_ANCHOR_MAX_TABLES) {
    incomplete = true;
    localLimitations.push(`more than ${TEMPORAL_ANCHOR_MAX_TABLES} tables queried; temporal range check incomplete`);
  }

  let latest: { readonly dayMs: number; readonly isoDate: string; readonly table: string; readonly column: string } | undefined;
  for (const table of tables.slice(0, TEMPORAL_ANCHOR_MAX_TABLES)) {
    let tableProfile;
    try {
      tableProfile = await profile.profile(table, context);
    } catch {
      incomplete = true;
      localLimitations.push(`${table}: could not inspect table time columns`);
      continue;
    }
    if (tableProfile.limitations.length > 0) {
      incomplete = true;
      for (const lim of tableProfile.limitations) localLimitations.push(`${table}: ${lim}`);
    }
    for (const tc of tableProfile.timeColumns) {
      if (tc.max === undefined || tc.max.trim() === "") continue;
      const parsed = parseTemporalDate(tc.max);
      if (!parsed) {
        incomplete = true;
        localLimitations.push(`${tableProfile.table}.${tc.column} max value ${JSON.stringify(tc.max)} is not a calendar date`);
        continue;
      }
      if (!latest || parsed.dayMs > latest.dayMs) latest = { ...parsed, table: tableProfile.table, column: tc.column };
    }
  }

  const refDate = (options.now ?? (() => new Date()))();
  const refDayMs = Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate());
  const refIsoDate = new Date(refDayMs).toISOString().slice(0, 10);
  const driftDays = options.driftDays ?? TEMPORAL_ANCHOR_DRIFT_DAYS;

  if (latest) {
    const gapDays = Math.floor((refDayMs - latest.dayMs) / 86_400_000);
    if (gapDays <= driftDays) return { applied: true, findings: [] };
    if (!incomplete) {
      return {
        applied: true,
        findings: [{
          rule: "temporal_anchor_drift",
          message: `The SQL reads current system time (${exprs.join(", ")}; system date ${refIsoDate}), while the latest date across queried tables is ${latest.isoDate} in ${latest.table}.${latest.column} (${gapDays} days earlier). Verify whether filtering or computing relative to the system clock vs. dataset time range is intended`,
        }],
      };
    }
    limitations.push(...localLimitations);
    return { applied: true, findings: [] };
  }

  limitations.push(...(localLimitations.length > 0 ? localLimitations : ["queried tables have no parseable time column range to compare against current system time"]));
  return { applied: true, findings: [] };
}

/** Whether a delivered result looks empty: no rows, or one row whose values are all NULL or zero. */
export function looksEmpty(rows: readonly (readonly unknown[])[]): boolean {
  if (rows.length === 0) return true;
  return rows.length === 1 && rows[0]!.every((value) => value === null || value === undefined || Number(value) === 0);
}

export async function evaluateDataFalsification(
  executor: AnsweringSqlExecutor,
  sql: string,
  result: { readonly rows: readonly (readonly unknown[])[] },
  context: BusinessContext,
  options: DataFalsificationOptions = {},
): Promise<DataFalsificationReport> {
  const text = textOf(sql);
  const rels = relations(text);
  const limitations: string[] = [];
  const probes = probeRunner(executor, context, options);
  const digest = digestSql(sql, executor.dialect);
  // The parser reads join and filter structure exactly; the text rule is the fallback when it cannot.
  const join = digest.status === "parsed" ? digestJoinFindings(digest) : leftJoinFindings(text);
  const dates = await dateBoundFindings(text, rels, probes, limitations);
  const literals = looksEmpty(result.rows) ? await literalFindings(text, rels, probes, limitations) : { applied: false, findings: [] };
  const temporal = await temporalAnchorDriftFindings(executor, digest, text, rels, context, options, limitations);
  const findings = [...join.findings, ...dates.findings, ...literals.findings, ...temporal.findings];
  const applied = ([
    ["left_join_degenerated", join.applied],
    ["date_upper_bound_truncated", dates.applied],
    ["literal_not_matched", literals.applied],
    ["temporal_anchor_drift", temporal.applied],
  ] as const).filter(([, used]) => used).map(([rule]) => rule);
  const status = findings.length > 0 ? "finding" : applied.length === 0 ? "not_applicable" : limitations.length > 0 ? "unknown" : "clear";
  return { ruleVersion: DATA_FALSIFICATION_RULE_VERSION, status, findings, limitations: [...new Set(limitations)], applied };
}

export function dataFalsificationCoverage(report: DataFalsificationReport): CheckCoverage {
  const reason = report.status === "finding"
    ? report.findings.map((item) => item.message).join(" | ")
    : report.status === "not_applicable" ? "no rule's pattern occurs in the SQL"
      : report.limitations.length > 0 ? report.limitations.join(" | ") : undefined;
  return { checkId: DATA_FALSIFICATION_CHECK_ID, ruleVersion: report.ruleVersion, outcome: report.status, ...(reason ? { reason } : {}) };
}

export function dataFalsificationFindings(report: DataFalsificationReport): readonly Finding[] {
  return report.findings.map((item) => ({ id: `finding_data_falsification_${randomUUID()}`, kind: "data_falsification" as const, message: item.message, blocking: false, checkId: DATA_FALSIFICATION_CHECK_ID }));
}
