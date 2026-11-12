import { randomUUID } from "node:crypto";
import type { CheckCoverage, Finding, SpecFields } from "./model.js";
import type { FanoutDialect } from "./fanout-check.js";
import { grainOf, layersOf, type GroupingKeyValue, type MeasureExpression, type SourceValue, type TimeValue } from "./fields.js";
import { settled } from "./support.js";

/**
 * Calendar coverage: does the data have every period the Spec groups by? When
 * grouping (or a formula layer's `per`) has a year, quarter, month or day
 * grain and population.time names a date range, the Runtime lists the periods
 * the time field actually has in that range. Periods without data make
 * population.missing a required field (how absent periods count is then a
 * Spec decision), and the gap is disclosed with the result (ADR-0007, ADR-0003).
 */
export const CALENDAR_COVERAGE_CHECK_ID = "calendar_coverage";
export const CALENDAR_COVERAGE_RULE_VERSION = "calendar-coverage-v1";
/** Longest range checked, in periods of the grain; longer ranges are not determinable. */
export const CALENDAR_COVERAGE_MAX_PERIODS = 1_000;

export type CalendarGrain = "year" | "quarter" | "month" | "day";

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";
export interface CalendarTarget {
  readonly table: string;
  readonly column: string;
  readonly grain: CalendarGrain;
  /** Inclusive ISO dates. */
  readonly start: string;
  readonly end: string;
}

export interface CalendarCoverageReport {
  readonly ruleVersion: typeof CALENDAR_COVERAGE_RULE_VERSION;
  readonly status: "clear" | "finding" | "not_applicable" | "unknown";
  readonly target?: CalendarTarget;
  readonly expected?: number;
  readonly observed?: number;
  /** Periods of the range without data, in order. */
  readonly missing?: readonly string[];
  readonly limitations: readonly string[];
}


/** Week and hour are calendar grains this check does not count periods for. */
function calendarGrainOf(text: string): CalendarGrain | "unsupported" | undefined {
  const grain = grainOf(text);
  return grain === "week" || grain === "hour" ? "unsupported" : grain;
}

/** The calendar grain the answer is computed per: a grouping key first, then a formula layer's `per`. */
function grainFor(fields: SpecFields): CalendarGrain | "unsupported" | undefined {
  const keys = settled<readonly (string | GroupingKeyValue)[]>(fields.grouping) ?? [];
  const formula = settled<MeasureExpression>(fields["measure.formula"]);
  const texts = [
    ...keys.map((key) => typeof key === "string" ? key : key.grain ?? key.key),
    ...(formula ? layersOf(formula).flatMap((layer) => layer.per ? [layer.per] : []) : []),
  ];
  return texts.map(calendarGrainOf).find(Boolean);
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

/** The first and last date the expression names, or a reason it cannot be read. */
export function dateRange(expression: string): { readonly start: string; readonly end: string } | { readonly reason: string } {
  if (/\bQ[1-4]\b|quarter|季度|week|周/i.test(expression)) return { reason: "population.time names quarters or weeks; only ISO dates and years are read" };
  const tokens = [...expression.matchAll(/(?<!\d)(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(?!\d)/g)]
    .filter((match) => Number(match[1]) >= 1900 && Number(match[1]) <= 2100);
  if (tokens.length === 0) return { reason: "population.time names no date" };
  const first = tokens[0]!;
  const last = tokens.at(-1)!;
  const start = new Date(Date.UTC(Number(first[1]), Number(first[2] ?? 1) - 1, Number(first[3] ?? 1)));
  const end = last[3]
    ? new Date(Date.UTC(Number(last[1]), Number(last[2]) - 1, Number(last[3])))
    : new Date(Date.UTC(Number(last[1]), last[2] ? Number(last[2]) : 12, 0));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return { reason: "population.time dates do not form a range" };
  return { start: iso(start), end: iso(end) };
}

/** Every period of the grain that the inclusive range touches, in order. */
export function periodsIn(grain: CalendarGrain, start: string, end: string): readonly string[] {
  const out: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last && out.length <= CALENDAR_COVERAGE_MAX_PERIODS) {
    const period = periodOf(grain, iso(cursor));
    if (out.at(-1) !== period) out.push(period);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** The period of the grain an ISO date text (YYYY-MM or longer) falls in. */
export function periodOf(grain: CalendarGrain, text: string): string {
  const year = text.slice(0, 4);
  const month = Number(text.slice(5, 7));
  if (grain === "year") return year;
  if (grain === "quarter") return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
  if (grain === "month") return text.slice(0, 7);
  return text.slice(0, 10);
}

/** What to read for this Revision: a target, a reason it cannot be read, or nothing when no calendar grain applies. */
export function calendarTarget(fields: SpecFields): { readonly target?: CalendarTarget; readonly limitation?: string } {
  const grain = grainFor(fields);
  const time = settled<TimeValue>(fields["population.time"]);
  if (!grain || !time) return {};
  if (grain === "unsupported") return { limitation: "only year, quarter, month and day grains are read" };
  const range = dateRange(time.expression);
  if ("reason" in range) return { limitation: range.reason };
  if (periodsIn(grain, range.start, range.end).length > CALENDAR_COVERAGE_MAX_PERIODS) return { limitation: `the range has more than ${CALENDAR_COVERAGE_MAX_PERIODS} ${grain} periods` };
  const timeField = settled<string>(fields["population.timeField"]);
  const source = settled<SourceValue>(fields["population.source"]);
  // table.column may be followed by prose; a bare column must stand alone, so "the date the order shipped" names nothing.
  const named = timeField
    ? new RegExp(`^\\s*(${IDENTIFIER})\\.(${IDENTIFIER})`).exec(timeField) ?? new RegExp(`^\\s*(${IDENTIFIER})\\s*(?:$|[(（,;，；:：])`).exec(timeField)
    : null;
  if (!named) return { limitation: "population.timeField does not name a column; write it as table.column" };
  const [table, column] = named[2] ? [named[1]!, named[2]] : [source?.tables.length === 1 ? source.tables[0]!.trim() : undefined, named[1]!];
  if (!table || !new RegExp(`^${IDENTIFIER}$`).test(table)) return { limitation: "the table of population.timeField is not known; write it as table.column" };
  return { target: { table, column, grain, ...range } };
}

function textOf(column: string, dialect: FanoutDialect | undefined): string | undefined {
  if (!dialect || dialect === "sqlite" || dialect === "postgres") return `CAST(${column} AS TEXT)`;
  if (dialect === "mysql") return `CAST(${column} AS CHAR)`;
  return undefined;
}

/**
 * Distinct date prefixes of the time field inside the range. Only the
 * validated identifiers and Runtime-made ISO dates enter the SQL.
 */
export function calendarQuery(target: CalendarTarget, dialect?: FanoutDialect): string | undefined {
  const text = textOf(target.column, dialect);
  if (!text) return undefined;
  const length = target.grain === "day" ? 10 : 7;
  const after = new Date(`${target.end}T00:00:00Z`);
  after.setUTCDate(after.getUTCDate() + 1);
  return `SELECT DISTINCT SUBSTR(${text}, 1, ${length}) AS p FROM ${target.table} WHERE ${target.column} >= '${target.start}' AND ${target.column} < '${iso(after)}'`;
}

/** Compare the periods the range spans with the date prefixes the data has. */
export function evaluateCalendarCoverage(target: CalendarTarget, prefixes: readonly unknown[]): CalendarCoverageReport {
  const texts = prefixes.map((item) => String(item ?? ""));
  if (texts.some((item) => !/^\d{4}-\d{2}/.test(item))) {
    return { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", target, limitations: [`${target.table}.${target.column} is not stored as ISO dates`] };
  }
  const expected = periodsIn(target.grain, target.start, target.end);
  const observed = new Set(texts.map((item) => periodOf(target.grain, item)));
  const missing = expected.filter((period) => !observed.has(period));
  return {
    ruleVersion: CALENDAR_COVERAGE_RULE_VERSION,
    status: missing.length > 0 ? "finding" : "clear",
    target,
    expected: expected.length,
    observed: expected.length - missing.length,
    missing,
    limitations: [],
  };
}

export function calendarCoverageMessage(report: CalendarCoverageReport): string | undefined {
  if (report.status !== "finding" || !report.target || !report.missing) return undefined;
  const { target, missing } = report;
  const shown = missing.length > 6 ? `${missing.slice(0, 6).join(", ")} …` : missing.join(", ");
  return `population.time spans ${report.expected} ${target.grain} periods (${target.start}..${target.end}), but ${target.table}.${target.column} has data in ${report.observed}; no data in ${shown}. Write population.missing: whether a period without data appears with zero (the SQL then needs a calendar of every period) or is left out`;
}

/** population.missing becomes required while periods are missing and it has no state. */
export function calendarRequiredPaths(report: CalendarCoverageReport | undefined): readonly "population.missing"[] {
  return report?.status === "finding" ? ["population.missing"] : [];
}

export function calendarCoverageCoverage(report: CalendarCoverageReport | undefined): CheckCoverage {
  if (!report) return { checkId: CALENDAR_COVERAGE_CHECK_ID, ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, outcome: "not_applicable", reason: "No calendar grain over a dated population.time." };
  const reason = calendarCoverageMessage(report) ?? (report.limitations.length > 0 ? report.limitations.join("; ") : undefined);
  return { checkId: CALENDAR_COVERAGE_CHECK_ID, ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, outcome: report.status, ...(reason ? { reason } : {}) };
}

export function calendarCoverageFindings(report: CalendarCoverageReport | undefined): readonly Finding[] {
  const message = report ? calendarCoverageMessage(report) : undefined;
  return message ? [{ id: `finding_calendar_coverage_${randomUUID()}`, kind: "calendar_coverage", message, blocking: false, checkId: CALENDAR_COVERAGE_CHECK_ID }] : [];
}

export function calendarCoverageDisclosure(findings: readonly Finding[]): string {
  const items = findings.filter((item) => item.kind === "calendar_coverage");
  return items.length > 0 ? `时间范围内有期间没有数据（数据计数，未裁决业务口径）：${items.map((item) => item.message).join("；")}。` : "";
}

export function renderCalendarCoverage(report: CalendarCoverageReport | undefined): string {
  if (!report || report.status === "not_applicable") return "";
  const message = calendarCoverageMessage(report);
  const counts = report.target && report.expected !== undefined ? ` ${report.target.table}.${report.target.column} ${report.target.grain} ${report.target.start}..${report.target.end} expected=${report.expected} observed=${report.observed}` : "";
  return [`[CALENDAR_COVERAGE] status=${report.status}${counts}`, ...(message ? [`finding: ${message}`] : []), ...(report.limitations.length > 0 ? [`limitations: ${report.limitations.join("; ")}`] : [])].join("\n");
}
