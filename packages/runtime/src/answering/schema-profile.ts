import { randomUUID } from "node:crypto";
import { contentHash, type BusinessContext, type CheckCoverage, type Finding, type SpecFields } from "./model.js";
import type { FanoutSchema, FanoutSchemaTable } from "./fanout-check.js";
import type { AnsweringSqlExecutor } from "./sql-execution.js";
import { quoteIdentifier } from "./entity-identity.js";
import { settledField } from "./support.js";

/**
 * Schema Profile (ADR-0007 step 4, plan T5.3): Runtime-owned facts about the
 * connected database, read once per Answering instance (one session) and
 * reused by every Query Task. It is not a model tool and defines nothing of
 * the business: it records what the data physically holds — row counts, key
 * cardinalities, time column formats and ranges, low-cardinality values — so
 * data checks stop re-scanning the same tables on every set call. Its reads
 * are bounded, never charged to a task's budget, and a table above the row
 * threshold is not scanned beyond its row count; the skip is recorded.
 */
export const SCHEMA_PROFILE_VERSION = "schema-profile-v1";
/** Above this many rows a table is not scanned beyond COUNT(*). */
export const SCHEMA_PROFILE_MAX_ROWS = 200_000;
/** Each profile read is abandoned after this long. */
export const SCHEMA_PROFILE_TIMEOUT_MS = 5_000;
/** Text columns sampled for low-cardinality values per table, and values kept per column. */
export const SCHEMA_PROFILE_ENUM_COLUMNS = 5;
export const SCHEMA_PROFILE_ENUM_VALUES = 20;
/** Maximum inferred shared-key join candidates included in one SchemaTopology summary. */
export const SCHEMA_TOPOLOGY_MAX_CANDIDATES = 40;

export interface SchemaJoinEdge {
  readonly source: "foreign_key" | "shared_key";
  readonly fromTable: string;
  readonly fromColumns: readonly string[];
  readonly toTable: string;
  readonly toColumns: readonly string[];
}

export interface SchemaTopology {
  readonly foreignKeys: readonly SchemaJoinEdge[];
  readonly sharedKeyCandidates: readonly SchemaJoinEdge[];
}

export type TimeFormat = "iso_date" | "iso_timestamp" | "integer" | "other";

export interface TimeColumnProfile {
  readonly column: string;
  readonly format: TimeFormat;
  readonly min?: string;
  readonly max?: string;
}

export interface EnumColumnProfile {
  readonly column: string;
  readonly values: readonly string[];
}

export interface TableProfile {
  readonly table: string;
  readonly rows?: number;
  /** Distinct counts of the declared primary and unique keys. */
  readonly keys: readonly { readonly columns: readonly string[]; readonly distinct: number }[];
  readonly timeColumns: readonly TimeColumnProfile[];
  readonly enumColumns: readonly EnumColumnProfile[];
  readonly limitations: readonly string[];
}

export interface SchemaProfileOptions {
  readonly maxRows?: number;
  readonly timeoutMs?: number;
}

const TIME_TYPE = /date|time/i;
const TIME_NAME = /(^|_)(date|time|day|ts|timestamp)($|_)|_at$|_on$/i;
const TEXT_TYPE = /char|text|string|clob/i;
const MONEY_NAME = /amount|price|revenue|sales|total|value|cost|payment|fee|spend|profit/i;
const NUMERIC_TYPE = /int|real|num|dec|float|double|money/i;

function formatOf(value: unknown): TimeFormat {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return "iso_date";
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) return "iso_timestamp";
  if (/^-?\d+$/.test(text)) return "integer";
  return "other";
}

/**
 * One cache per Answering instance. Every read is memoized by its SQL, so
 * data checks of any task that need the same count read it once.
 */
export class SchemaProfile {
  private readonly reads = new Map<string, Promise<readonly (readonly unknown[])[] | undefined>>();
  private readonly tables = new Map<string, Promise<TableProfile>>();
  /** SQL statements actually sent to the database (for tests and diagnostics). */
  executed = 0;

  constructor(
    private readonly executor: AnsweringSqlExecutor,
    private readonly loadSchema: (context: BusinessContext) => Promise<FanoutSchema | undefined>,
    private readonly options: SchemaProfileOptions = {},
  ) {}

  get maxRows(): number {
    return this.options.maxRows ?? SCHEMA_PROFILE_MAX_ROWS;
  }

  /** Rows of a read-only statement, memoized; undefined when it failed or timed out (a limitation, not an error). */
  read(sql: string, limit: number, context: BusinessContext, key = "schema-profile"): Promise<readonly (readonly unknown[])[] | undefined> {
    const memo = `${limit}\u0000${sql}`;
    const cached = this.reads.get(memo);
    if (cached) return cached;
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? SCHEMA_PROFILE_TIMEOUT_MS);
    const pending = (async () => {
      this.executed += 1;
      try {
        const result = await this.executor.run(sql, limit, {
          kind: "exploration",
          idempotencyKey: `${key}:${contentHash({ sql })}`,
          signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
          ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
          ...(context.queryScope ? { scope: context.queryScope } : {}),
        });
        return result.rows;
      } catch (error) {
        if (context.signal?.aborted) {
          // A cancelled read says nothing about the data; the next caller reads again.
          this.reads.delete(memo);
          throw error;
        }
        return undefined;
      }
    })();
    this.reads.set(memo, pending);
    return pending;
  }

  /** A single number a statement returns, memoized; undefined when it could not be read. */
  async count(sql: string, context: BusinessContext, key?: string): Promise<number | undefined> {
    const rows = await this.read(sql, 1, context, key);
    const value = Number(rows?.[0]?.[0]);
    return rows && Number.isFinite(value) ? value : undefined;
  }

  async schemaTable(table: string, context: BusinessContext): Promise<FanoutSchemaTable | undefined> {
    const schema = await this.loadSchema(context).catch(() => undefined);
    return findSchemaTable(schema, table);
  }

  /** Native foreign-key and candidate shared-key join topology across the database schema. */
  async topology(context: BusinessContext): Promise<SchemaTopology | undefined> {
    const schema = await this.loadSchema(context).catch(() => undefined);
    return schema ? extractSchemaTopology(schema) : undefined;
  }

  /** The profile of one table, read once per session. */
  profile(table: string, context: BusinessContext): Promise<TableProfile> {
    const key = table.toLowerCase();
    const cached = this.tables.get(key);
    if (cached) return cached;
    const pending = this.collect(table, context).catch((error: unknown) => {
      this.tables.delete(key);
      throw error;
    });
    this.tables.set(key, pending);
    return pending;
  }

  private async collect(table: string, context: BusinessContext): Promise<TableProfile> {
    const dialect = this.executor.dialect;
    const name = quoteIdentifier(table, dialect);
    const limitations: string[] = [];
    const rows = await this.count(`SELECT COUNT(*) AS n FROM ${name}`, context);
    if (rows === undefined) return { table, keys: [], timeColumns: [], enumColumns: [], limitations: ["the table could not be counted"] };
    const schema = await this.schemaTable(table, context);
    if (!schema) limitations.push("the executor reports no schema for the table; column facts skipped");
    if (rows > this.maxRows) {
      limitations.push(`more than ${this.maxRows} rows; only the row count is read`);
      return { table, rows, keys: [], timeColumns: [], enumColumns: [], limitations };
    }
    const column = (item: string) => quoteIdentifier(item, dialect);
    const keys: { columns: readonly string[]; distinct: number }[] = [];
    for (const key of [schema?.primaryKey, ...(schema?.uniqueKeys ?? [])].filter((item): item is readonly string[] => Boolean(item?.length))) {
      const distinct = await this.count(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${key.map(column).join(", ")} FROM ${name}) AS d`, context);
      if (distinct === undefined) limitations.push(`key ${key.join(", ")} could not be counted`);
      else keys.push({ columns: key, distinct });
    }
    const timeColumns: TimeColumnProfile[] = [];
    for (const item of timeLike(schema)) {
      const range = await this.read(`SELECT MIN(${column(item)}) AS lo, MAX(${column(item)}) AS hi FROM ${name}`, 1, context);
      if (!range) { limitations.push(`${item} could not be read`); continue; }
      const [min, max] = range[0] ?? [];
      timeColumns.push({ column: item, format: formatOf(min ?? max), ...(min !== null && min !== undefined ? { min: String(min) } : {}), ...(max !== null && max !== undefined ? { max: String(max) } : {}) });
    }
    const enumColumns: EnumColumnProfile[] = [];
    for (const item of (schema?.columns ?? []).filter((name) => TEXT_TYPE.test(schema?.columnTypes?.[name] ?? "")).slice(0, SCHEMA_PROFILE_ENUM_COLUMNS)) {
      const values = await this.read(`SELECT DISTINCT ${column(item)} FROM ${name} LIMIT ${SCHEMA_PROFILE_ENUM_VALUES + 1}`, SCHEMA_PROFILE_ENUM_VALUES + 1, context);
      if (!values) { limitations.push(`${item} could not be read`); continue; }
      if (values.length <= SCHEMA_PROFILE_ENUM_VALUES) enumColumns.push({ column: item, values: values.map((row) => String(row[0])) });
    }
    return { table, rows, keys, timeColumns, enumColumns, limitations };
  }
}

function timeLike(schema: FanoutSchemaTable | undefined): readonly string[] {
  // SQLite stores dates as TEXT: a text or untyped column counts when its name says it holds a time.
  return (schema?.columns ?? []).filter((name) => {
    const type = schema?.columnTypes?.[name] ?? "";
    return TIME_TYPE.test(type) || ((!type || TEXT_TYPE.test(type)) && TIME_NAME.test(name));
  });
}

function moneyLike(schema: FanoutSchemaTable | undefined): readonly string[] {
  return (schema?.columns ?? []).filter((name) => MONEY_NAME.test(name) && (!schema?.columnTypes?.[name] || NUMERIC_TYPE.test(schema.columnTypes[name]!)));
}

const GENERIC_KEY_NAMES = new Set(["id", "code", "name", "key", "type", "status", "date", "value", "index"]);
const SPECIFIC_KEY_COLUMN = /^[a-z][a-z0-9_]*_(id|key|code)$/i;

function findSchemaTable(schema: FanoutSchema | undefined, table: string): FanoutSchemaTable | undefined {
  const wanted = table.toLowerCase();
  return schema?.tables.find((item) => item.name.toLowerCase() === wanted || item.name.toLowerCase().split(".").at(-1) === wanted.split(".").at(-1));
}

function edgePairKey(tableA: string, colsA: readonly string[], tableB: string, colsB: readonly string[]): string {
  const sideA = `${tableA.toLowerCase()}:${colsA.map((col) => col.toLowerCase()).join(",")}`;
  const sideB = `${tableB.toLowerCase()}:${colsB.map((col) => col.toLowerCase()).join(",")}`;
  return [sideA, sideB].sort().join("<>");
}

function matchColumns(columns: readonly string[], targetColumns: readonly string[]): readonly string[] | undefined {
  const matched: string[] = [];
  for (const target of targetColumns) {
    const found = columns.find((col) => col.toLowerCase() === target.toLowerCase());
    if (!found) return undefined;
    matched.push(found);
  }
  return matched;
}

function compareEdges(left: SchemaJoinEdge, right: SchemaJoinEdge): number {
  const a = `${left.fromTable.toLowerCase()}:${left.fromColumns.join(",").toLowerCase()}->${left.toTable.toLowerCase()}:${left.toColumns.join(",").toLowerCase()}`;
  const b = `${right.fromTable.toLowerCase()}:${right.fromColumns.join(",").toLowerCase()}->${right.toTable.toLowerCase()}:${right.toColumns.join(",").toLowerCase()}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Physical join topology derived strictly from database metadata (ADR-0007):
 * declared foreign keys plus exact shared-key candidates (declared keys first,
 * then specific `*_id` / `*_key` / `*_code` fallback for PK-less schemas).
 */
export function extractSchemaTopology(schema: FanoutSchema | undefined): SchemaTopology {
  if (!schema || schema.tables.length === 0) return { foreignKeys: [], sharedKeyCandidates: [] };
  const foreignKeys: SchemaJoinEdge[] = [];
  const seenPairs = new Set<string>();
  const fkExactSeen = new Set<string>();

  for (const table of schema.tables) {
    for (const fk of table.foreignKeys ?? []) {
      const targetTable = findSchemaTable(schema, fk.references.table);
      const toTable = targetTable?.name ?? fk.references.table;
      const explicitTo = fk.references.columns;
      const toColumns = explicitTo.length > 0
        ? explicitTo
        : targetTable?.primaryKey && targetTable.primaryKey.length === fk.columns.length
          ? targetTable.primaryKey
          : [];
      const exactKey = `${table.name.toLowerCase()}:${fk.columns.join(",").toLowerCase()}->${toTable.toLowerCase()}:${toColumns.join(",").toLowerCase()}`;
      if (fkExactSeen.has(exactKey)) continue;
      fkExactSeen.add(exactKey);
      foreignKeys.push({
        source: "foreign_key",
        fromTable: table.name,
        fromColumns: [...fk.columns],
        toTable,
        toColumns: [...toColumns],
      });
      seenPairs.add(edgePairKey(table.name, fk.columns, toTable, toColumns));
    }
  }

  const pkCandidates: SchemaJoinEdge[] = [];
  for (const target of schema.tables) {
    const keySets = [...(target.primaryKey?.length ? [target.primaryKey] : []), ...(target.uniqueKeys ?? [])];
    for (const keyColumns of keySets) {
      if (keyColumns.length === 0) continue;
      if (keyColumns.length === 1 && GENERIC_KEY_NAMES.has(keyColumns[0]!.toLowerCase())) continue;
      const targetCols = matchColumns(target.columns, keyColumns) ?? keyColumns;
      for (const other of schema.tables) {
        if (other.name.toLowerCase() === target.name.toLowerCase()) continue;
        const otherCols = matchColumns(other.columns, keyColumns);
        if (!otherCols) continue;
        const pair = edgePairKey(other.name, otherCols, target.name, targetCols);
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        pkCandidates.push({
          source: "shared_key",
          fromTable: other.name,
          fromColumns: otherCols,
          toTable: target.name,
          toColumns: [...targetCols],
        });
      }
    }
  }

  const bySpecificColumn = new Map<string, { readonly table: FanoutSchemaTable; readonly column: string }[]>();
  for (const table of schema.tables) {
    const seenInTable = new Set<string>();
    for (const column of table.columns) {
      const lower = column.toLowerCase();
      if (!SPECIFIC_KEY_COLUMN.test(lower) || seenInTable.has(lower)) continue;
      seenInTable.add(lower);
      bySpecificColumn.set(lower, [...(bySpecificColumn.get(lower) ?? []), { table, column }]);
    }
  }

  const fallbackCandidates: SchemaJoinEdge[] = [];
  for (const column of [...bySpecificColumn.keys()].sort()) {
    const entries = bySpecificColumn.get(column)!;
    if (entries.length < 2 || entries.length > 6) continue;
    const sorted = [...entries].sort((left, right) => left.table.name.toLowerCase().localeCompare(right.table.name.toLowerCase()));
    for (let leftIndex = 0; leftIndex < sorted.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex += 1) {
        const left = sorted[leftIndex]!;
        const right = sorted[rightIndex]!;
        const pair = edgePairKey(left.table.name, [left.column], right.table.name, [right.column]);
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        fallbackCandidates.push({
          source: "shared_key",
          fromTable: left.table.name,
          fromColumns: [left.column],
          toTable: right.table.name,
          toColumns: [right.column],
        });
      }
    }
  }

  foreignKeys.sort(compareEdges);
  pkCandidates.sort(compareEdges);
  fallbackCandidates.sort(compareEdges);
  return {
    foreignKeys,
    sharedKeyCandidates: [...pkCandidates, ...fallbackCandidates].slice(0, SCHEMA_TOPOLOGY_MAX_CANDIDATES),
  };
}

// --- physical multi-candidate reminder ---------------------------------------

export const PHYSICAL_CANDIDATES_CHECK_ID = "physical_candidates";
export const PHYSICAL_CANDIDATES_RULE_VERSION = "physical-candidates-v1";

export interface PhysicalCandidatesReport {
  readonly ruleVersion: typeof PHYSICAL_CANDIDATES_RULE_VERSION;
  readonly status: "clear" | "finding" | "not_applicable" | "unknown";
  readonly findings: readonly { readonly path: "population.timeField" | "measure.formula"; readonly table: string; readonly columns: readonly string[]; readonly message: string }[];
  readonly limitations: readonly string[];
}

/** A field written as a plain assumption, rather than opened or settled by evidence. */
function assumed(fields: SpecFields, path: "population.timeField" | "measure.formula"): boolean {
  const field = fields[path];
  return field?.state === "specified" && field.basis.kind === "assumed";
}

/**
 * Several columns of the same kind in a declared source table (several date
 * columns, several amount columns) while the model assumed one without
 * opening the choice: a reminder to confirm which one the question means. It
 * reads only the schema, never data, and is disclosed, never blocking.
 */
export async function evaluatePhysicalCandidates(fields: SpecFields, profile: SchemaProfile, context: BusinessContext): Promise<PhysicalCandidatesReport> {
  const source = settledField(fields, "population.source");
  const checkTime = assumed(fields, "population.timeField");
  const formula = settledField(fields, "measure.formula");
  const checkMoney = assumed(fields, "measure.formula") && formula !== undefined && ["sum", "avg", "median", "min", "max"].includes(formula.op);
  if (!source || (!checkTime && !checkMoney)) return { ruleVersion: PHYSICAL_CANDIDATES_RULE_VERSION, status: "not_applicable", findings: [], limitations: [] };
  const findings: PhysicalCandidatesReport["findings"][number][] = [];
  const limitations: string[] = [];
  const timeField = settledField(fields, "population.timeField")?.toLowerCase() ?? "";
  const operand = typeof formula?.of === "string" ? formula.of.toLowerCase() : "";
  for (const table of source.tables.slice(0, 3)) {
    const schema = await profile.schemaTable(table.trim(), context);
    if (!schema) { limitations.push(`no schema for ${table}`); continue; }
    const times = timeLike(schema);
    if (checkTime && times.length >= 2 && times.some((column) => timeField.includes(column.toLowerCase()))) {
      findings.push({ path: "population.timeField", table: schema.name, columns: times, message: `population.timeField is assumed, but ${schema.name} has ${times.length} time columns (${times.join(", ")}). Confirm which one the question dates by, or open population.timeField with the candidates and probe them` });
    }
    const money = moneyLike(schema);
    if (checkMoney && money.length >= 2 && money.some((column) => operand.includes(column.toLowerCase()))) {
      findings.push({ path: "measure.formula", table: schema.name, columns: money, message: `measure.formula is assumed and sums or averages one amount column, but ${schema.name} has ${money.length} amount-like columns (${money.join(", ")}). Confirm which amount the question means, or open measure.formula with the candidates and probe them` });
    }
  }
  const status = findings.length > 0 ? "finding" : limitations.length > 0 ? "unknown" : "clear";
  return { ruleVersion: PHYSICAL_CANDIDATES_RULE_VERSION, status, findings, limitations };
}

export function physicalCandidatesCoverage(report: PhysicalCandidatesReport): CheckCoverage {
  const reason = report.status === "finding" ? report.findings.map((item) => item.message).join(" | ") : report.limitations.length > 0 ? report.limitations.join(" | ") : report.status === "not_applicable" ? "no assumed time field or amount over a declared source" : undefined;
  return { checkId: PHYSICAL_CANDIDATES_CHECK_ID, ruleVersion: report.ruleVersion, outcome: report.status, ...(reason ? { reason } : {}) };
}

export function physicalCandidatesFindings(report: PhysicalCandidatesReport): readonly Finding[] {
  return report.findings.map((item) => ({ id: `finding_physical_candidates_${randomUUID()}`, kind: "physical_candidates" as const, message: item.message, blocking: false, checkId: PHYSICAL_CANDIDATES_CHECK_ID, paths: [item.path] }));
}
