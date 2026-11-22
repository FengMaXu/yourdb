import { maskSql } from "./sql-lex.js";
import { digestSql } from "./sql-digest.js";
import type { FanoutReport, FanoutTargetReport, FanoutProbeObservation } from "./model.js";

export const FANOUT_RULE_VERSION = "answering-fanout-v1" as const;
export const FANOUT_DEFAULT_MAX_TARGETS = 2;
export const FANOUT_DEFAULT_MAX_INPUT_ROWS = 50_000;

export type FanoutDialect = "sqlite" | "mysql" | "postgres" | "bigquery" | "snowflake";

export interface FanoutSchemaTable {
  readonly name: string;
  readonly columns: readonly string[];
  /** Declared type per column name, when the executor reports it. */
  readonly columnTypes?: Readonly<Record<string, string>>;
  readonly primaryKey?: readonly string[];
  readonly uniqueKeys?: readonly (readonly string[])[];
  readonly foreignKeys?: readonly { readonly columns: readonly string[]; readonly references: { readonly table: string; readonly columns: readonly string[] } }[];
}

export interface FanoutSchema {
  readonly connectionId?: string;
  readonly dialect: FanoutDialect;
  readonly tables: readonly FanoutSchemaTable[];
}

export interface FanoutProbeResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
}

export interface FanoutProbeRequest {
  readonly targetId: string;
  readonly sql: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

export type FanoutProbeRunner = (request: FanoutProbeRequest) => Promise<FanoutProbeResult>;

interface ParsedRelation {
  readonly kind: "FROM" | "JOIN";
  readonly relation: string;
  readonly normalizedRelation: string;
  readonly alias: string;
  readonly sourceSql: string;
}

export interface FanoutTarget {
  readonly targetId: string;
  readonly blockDepth: number;
  readonly aggregateExpressions: readonly string[];
  readonly aggregateFunctions: readonly ("COUNT" | "SUM")[];
  readonly sourceRelation: string;
  readonly sourceAlias: string;
  readonly sourceKey: string;
  readonly sourceKeySql: string;
  readonly sourceSql: string;
  readonly joinedRelation?: string;
  readonly fromSql: string;
  readonly unavailableReason?: string;
}

export interface FanoutPlan {
  readonly targets: readonly FanoutTarget[];
  readonly potential: boolean;
  readonly unsupportedReasons: readonly string[];
}

export interface FanoutCheckInput {
  readonly sql: string;
  readonly schema?: FanoutSchema;
  readonly dialect?: FanoutDialect;
  readonly runProbe: FanoutProbeRunner;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly maxTargets?: number;
  readonly maxInputRows?: number;
}

/** Literals and comments blanked, identifiers kept; offsets match the SQL (shared lexer, sql-lex.ts). */
function maskLiteralsAndComments(sql: string): string {
  return maskSql(sql, { identifiers: false });
}

function depthByOffset(maskedSql: string): Int32Array {
  const depths = new Int32Array(maskedSql.length);
  let depth = 0;
  for (let index = 0; index < maskedSql.length; index++) {
    depths[index] = depth;
    if (maskedSql[index] === "(") depth += 1;
    else if (maskedSql[index] === ")") depth = Math.max(0, depth - 1);
  }
  return depths;
}

function keywordOffsets(maskedSql: string, keyword: RegExp): number[] {
  return [...maskedSql.matchAll(keyword)].flatMap((match) => match.index === undefined ? [] : [match.index]);
}

function normalizeIdentifier(value: string): string {
  return value
    .split(".")
    .map((part) => part.replace(/^[`"\[]|[`"\]]$/g, ""))
    .join(".");
}

function baseName(value: string): string {
  const normalized = normalizeIdentifier(value);
  return normalized.split(".").at(-1) ?? normalized;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedIdentifier(alias: string, column: string): string {
  return `${quoteIdentifier(normalizeIdentifier(alias))}.${quoteIdentifier(normalizeIdentifier(column))}`;
}

function schemaTableFor(value: string, schema?: FanoutSchema): FanoutSchemaTable | undefined {
  const normalized = normalizeIdentifier(value).toLowerCase();
  return schema?.tables.find((table) => normalizeIdentifier(table.name).toLowerCase() === normalized
    || baseName(table.name).toLowerCase() === baseName(value).toLowerCase());
}

function chooseUniqueKey(table: FanoutSchemaTable | undefined): string | undefined {
  if (!table) return undefined;
  if (table.primaryKey?.length === 1 && table.primaryKey[0]) return table.primaryKey[0];
  const unique = table.uniqueKeys?.find((key) => key.length === 1 && key[0]);
  return unique?.[0];
}

function relationPattern(): RegExp {
  const identifier = "[`\\\"\\[]?[A-Za-z_][A-Za-z0-9_$-]*[`\\\"\\]]?";
  const wholeBacktickPath = "`[A-Za-z_][A-Za-z0-9_$-]*(?:\\.[A-Za-z_][A-Za-z0-9_$-]*){1,2}`";
  const relationReference = `(?:${wholeBacktickPath}|${identifier}(?:\\.${identifier}){0,2})`;
  const reserved = "ON|USING|JOIN|LEFT|RIGHT|FULL|INNER|OUTER|CROSS|WHERE|GROUP|HAVING|ORDER|LIMIT|QUALIFY|UNION|INTERSECT|EXCEPT|WINDOW";
  return new RegExp(`\\b(FROM|JOIN)\\s+(${relationReference})(?:\\s+(?:AS\\s+)?((?!(?:${reserved})\\b)${identifier}))?`, "gi");
}

function relationList(maskedFrom: string, originalFrom: string, schema?: FanoutSchema): ParsedRelation[] {
  const result: ParsedRelation[] = [];
  for (const match of maskedFrom.matchAll(relationPattern())) {
    if (match.index === undefined || !match[2]) continue;
    const relation = normalizeIdentifier(match[2]);
    const alias = normalizeIdentifier(match[3] ?? baseName(relation));
    const matchedText = originalFrom.slice(match.index, match.index + match[0].length);
    const sourceSql = matchedText.replace(/^(FROM|JOIN)\s+/i, "").trim();
    const table = schemaTableFor(relation, schema);
    result.push({
      kind: String(match[1]).toUpperCase() as "FROM" | "JOIN",
      relation: table?.name ?? relation,
      normalizedRelation: relation.toLowerCase(),
      alias,
      sourceSql,
    });
  }
  return result;
}

function aggregatePattern(): RegExp {
  return /\b(COUNT|SUM)\s*\(\s*(?!DISTINCT\b)([^()]+?)\s*\)/gi;
}

function simpleColumn(value: string): { qualifier?: string; column: string } | undefined {
  const normalized = value.trim();
  if (normalized === "*") return { column: "*" };
  if (!/^(?:[`"\[]?[A-Za-z_][A-Za-z0-9_$-]*[`"\]]?\.)?[`"\[]?[A-Za-z_][A-Za-z0-9_$-]*[`"\]]?$/.test(normalized)) return undefined;
  const parts = normalized.split(".");
  if (parts.length === 1) return { column: normalizeIdentifier(parts[0]!) };
  return { qualifier: normalizeIdentifier(parts[0]!), column: normalizeIdentifier(parts[1]!) };
}

function blockEnd(sql: string, masked: string, depths: Int32Array, fromOffset: number, blockDepth: number, boundaries: readonly number[]): number {
  const boundary = boundaries.find((offset) => offset > fromOffset && depths[offset] === blockDepth);
  let end = boundary ?? sql.length;
  for (let offset = fromOffset; offset < end; offset++) {
    if (masked[offset] === ")" && depths[offset] === blockDepth) {
      end = offset;
      break;
    }
    if (masked[offset] === ";" && depths[offset] === blockDepth) {
      end = offset;
      break;
    }
  }
  return end;
}

function findRelation(relations: readonly ParsedRelation[], qualifier: string | undefined, column: string, schema?: FanoutSchema): ParsedRelation | undefined {
  if (qualifier) {
    return relations.find((relation) => relation.alias.toLowerCase() === qualifier.toLowerCase()
      || relation.normalizedRelation === qualifier.toLowerCase()
      || baseName(relation.relation).toLowerCase() === baseName(qualifier).toLowerCase());
  }
  if (!schema) return undefined;
  const candidates = relations.filter((relation) => schemaTableFor(relation.relation, schema)?.columns.some((item) => normalizeIdentifier(item).toLowerCase() === column.toLowerCase()));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function targetIdentity(depth: number, relation: ParsedRelation, sourceKey: string, fromSql: string): string {
  return `block:${depth}:${relation.relation}:${relation.alias}:${sourceKey}:${fromSql}`;
}

/**
 * Conservatively identifies physical JOIN blocks containing non-distinct
 * COUNT(key) or simple SUM(column). It never claims a derived CTE is safe.
 */
export function planFanoutTargets(sql: string, schema?: FanoutSchema): FanoutPlan {
  // When the parser reads the statement and no block aggregates over a join, nothing can fan out.
  const digest = digestSql(sql);
  if (digest.status === "parsed" && !digest.blocks.some((block) => block.relations.some((relation) => relation.join) && block.aggregates.some((item) => !item.windowed && (item.fn === "count" || item.fn === "sum")))) {
    return { targets: [], potential: false, unsupportedReasons: [] };
  }
  const masked = maskLiteralsAndComments(sql);
  const depths = depthByOffset(masked);
  const selectOffsets = keywordOffsets(masked, /\bSELECT\b/gi);
  const fromOffsets = keywordOffsets(masked, /\bFROM\b/gi);
  const boundaries = keywordOffsets(masked, /\b(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|QUALIFY|WINDOW|UNION|INTERSECT|EXCEPT)\b/gi);
  const targets: FanoutTarget[] = [];
  const unsupportedReasons: string[] = [];
  let potential = false;

  for (const aggregate of masked.matchAll(aggregatePattern())) {
    if (aggregate.index === undefined || !aggregate[1] || !aggregate[2]) continue;
    const depth = depths[aggregate.index] ?? 0;
    const selectOffset = selectOffsets.filter((offset) => offset < aggregate.index! && depths[offset] === depth).at(-1);
    const fromOffset = fromOffsets.find((offset) => offset > aggregate.index! && depths[offset] === depth);
    if (selectOffset === undefined || fromOffset === undefined) continue;
    const end = blockEnd(sql, masked, depths, fromOffset, depth, boundaries);
    const originalFrom = sql.slice(fromOffset, end).trim();
    const maskedFrom = masked.slice(fromOffset, end);
    const relations = relationList(maskedFrom, originalFrom, schema);
    const joins = relations.filter((relation) => relation.kind === "JOIN");
    if (!joins.length) continue;
    potential = true;

    const functionName = String(aggregate[1]).toUpperCase() as "COUNT" | "SUM";
    const expression = aggregate[2].trim();
    const parsedColumn = simpleColumn(expression);
    if (!parsedColumn || parsedColumn.column === "*") {
      unsupportedReasons.push("unsupported_aggregate_expression");
      continue;
    }
    const source = findRelation(relations, parsedColumn.qualifier, parsedColumn.column, schema);
    if (!source) {
      unsupportedReasons.push("source_relation_unresolved");
      continue;
    }
    const sourceTable = schemaTableFor(source.relation, schema);
    const sourceKey = functionName === "COUNT" ? parsedColumn.column : chooseUniqueKey(sourceTable);
    if (!sourceKey) {
      const reason = functionName === "SUM" ? "source_unique_key_unavailable" : "source_key_unresolved";
      unsupportedReasons.push(reason);
      const joinedRelation = [...joins].reverse().find((relation) => relation.normalizedRelation !== source.normalizedRelation)?.relation ?? joins.at(-1)?.relation;
      const targetId = targetIdentity(depth, source, "unknown", originalFrom);
      if (!targets.some((target) => target.targetId === targetId)) {
        targets.push({
          targetId,
          blockDepth: depth,
          aggregateExpressions: [expression],
          aggregateFunctions: [functionName],
          sourceRelation: source.relation,
          sourceAlias: source.alias,
          sourceKey: "unknown",
          sourceKeySql: "unknown",
          sourceSql: source.sourceSql,
          ...(joinedRelation ? { joinedRelation } : {}),
          fromSql: originalFrom,
          unavailableReason: reason,
        });
      }
      continue;
    }
    const sourceKeySql = functionName === "COUNT"
      ? expression
      : quoteQualifiedIdentifier(source.alias, sourceKey);
    const joinedRelation = [...joins].reverse().find((relation) => relation.normalizedRelation !== source.normalizedRelation)?.relation ?? joins.at(-1)?.relation;
    const targetId = targetIdentity(depth, source, sourceKey, originalFrom);
    const existing = targets.find((target) => target.targetId === targetId);
    if (existing) {
      const index = targets.indexOf(existing);
      targets[index] = {
        ...existing,
        aggregateExpressions: [...existing.aggregateExpressions, expression],
        aggregateFunctions: [...existing.aggregateFunctions, functionName],
      };
      continue;
    }
    targets.push({
      targetId,
      blockDepth: depth,
      aggregateExpressions: [expression],
      aggregateFunctions: [functionName],
      sourceRelation: source.relation,
      sourceAlias: source.alias,
      sourceKey,
      sourceKeySql,
      sourceSql: source.sourceSql,
      ...(joinedRelation ? { joinedRelation } : {}),
      fromSql: originalFrom,
    });
  }

  return { targets, potential, unsupportedReasons: [...new Set(unsupportedReasons)] };
}

export function hasPotentialFanout(sql: string): boolean {
  return planFanoutTargets(sql).potential;
}

function numberAt(row: readonly unknown[] | undefined, index: number): number | undefined {
  const value = row?.[index];
  const number = typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function probeObservation(target: FanoutTarget, row: readonly unknown[] | undefined, maxInputRows: number): FanoutProbeObservation | undefined {
  const sourceRows = numberAt(row, 0);
  const sourceNonNullKeys = numberAt(row, 1);
  const sourceDistinctKeys = numberAt(row, 2);
  const joinedRows = numberAt(row, 3);
  const joinedNonNullKeys = numberAt(row, 4);
  const joinedDistinctKeys = numberAt(row, 5);
  if (sourceRows === undefined || sourceNonNullKeys === undefined || sourceDistinctKeys === undefined
    || joinedRows === undefined || joinedNonNullKeys === undefined || joinedDistinctKeys === undefined) return undefined;
  return {
    sourceRows,
    sourceNonNullKeys,
    sourceDistinctKeys,
    joinedRows,
    joinedNonNullKeys,
    joinedDistinctKeys,
    complete: sourceRows <= maxInputRows && joinedRows <= maxInputRows,
    ...(joinedDistinctKeys > 0 ? { fanoutFactor: joinedNonNullKeys / joinedDistinctKeys } : {}),
    sourceRelation: target.sourceRelation,
    sourceKey: target.sourceKey,
  };
}

function probeSql(target: FanoutTarget, maxInputRows: number): string {
  const sentinel = maxInputRows + 1;
  return [
    "WITH _data_agent_source_keys AS (",
    `  SELECT ${target.sourceKeySql} AS _data_agent_probe_key FROM ${target.sourceSql} LIMIT ${sentinel}`,
    "), _data_agent_joined_keys AS (",
    `  SELECT ${target.sourceKeySql} AS _data_agent_probe_key ${target.fromSql} LIMIT ${sentinel}`,
    ")",
    "SELECT",
    "  (SELECT COUNT(*) FROM _data_agent_source_keys) AS source_rows,",
    "  (SELECT COUNT(_data_agent_probe_key) FROM _data_agent_source_keys) AS source_non_null_keys,",
    "  (SELECT COUNT(DISTINCT _data_agent_probe_key) FROM _data_agent_source_keys) AS source_distinct_keys,",
    "  (SELECT COUNT(*) FROM _data_agent_joined_keys) AS joined_rows,",
    "  (SELECT COUNT(_data_agent_probe_key) FROM _data_agent_joined_keys) AS joined_non_null_keys,",
    "  (SELECT COUNT(DISTINCT _data_agent_probe_key) FROM _data_agent_joined_keys) AS joined_distinct_keys",
  ].join("\n");
}

function statusFor(targets: readonly FanoutTargetReport[], potential: boolean, unsupportedReasons: readonly string[]): FanoutReport["status"] {
  if (!potential) return "not_applicable";
  if (targets.some((target) => target.status === "finding")) return "finding";
  if (targets.some((target) => target.status === "unknown") || unsupportedReasons.length > 0) return "unknown";
  if (targets.length > 0 && targets.every((target) => target.status === "clear")) return "clear";
  return "unknown";
}

function reasonFromError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(text)) return "probe_timeout";
  if (/budget/i.test(text)) return "probe_budget_exhausted";
  if (/cancel|abort/i.test(text)) return "probe_cancelled";
  return "probe_error";
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("QUERY_CANCELLED");
}

/**
 * Executes only the bounded, read-only fanout probes planned from one result
 * SQL. A finding is observational and never grants delivery authority.
 */
export async function checkFanout(input: FanoutCheckInput): Promise<FanoutReport> {
  assertNotCancelled(input.signal);
  const dialect = input.dialect ?? input.schema?.dialect;
  const plan = planFanoutTargets(input.sql, input.schema);
  const maxTargets = Math.max(1, Math.trunc(input.maxTargets ?? FANOUT_DEFAULT_MAX_TARGETS));
  const maxInputRows = Math.max(1, Math.trunc(input.maxInputRows ?? FANOUT_DEFAULT_MAX_INPUT_ROWS));
  const selected = plan.targets.slice(0, maxTargets);
  const omitted = plan.targets.length > selected.length;
  const targetReports: FanoutTargetReport[] = [];

  if (!plan.potential) {
    return { ruleVersion: FANOUT_RULE_VERSION, status: "not_applicable", snapshotScope: "unbound", targets: [], ...(plan.unsupportedReasons.length ? { unsupportedReasons: plan.unsupportedReasons } : {}) };
  }
  if (dialect !== "sqlite") {
    return {
      ruleVersion: FANOUT_RULE_VERSION,
      status: "unknown",
      snapshotScope: "unbound",
      targets: selected.map((target) => ({ ...target, status: "unknown", reason: dialect ? "unsupported_dialect" : "schema_unavailable" })),
      unsupportedReasons: [...new Set([...plan.unsupportedReasons, dialect ? "unsupported_dialect" : "schema_unavailable"])],
    };
  }
  if (!input.schema) {
    return {
      ruleVersion: FANOUT_RULE_VERSION,
      status: "unknown",
      snapshotScope: "unbound",
      targets: selected.map((target) => ({ ...target, status: "unknown", reason: "schema_unavailable" })),
      unsupportedReasons: [...new Set([...plan.unsupportedReasons, "schema_unavailable"])],
    };
  }
  if (!selected.length) {
    return {
      ruleVersion: FANOUT_RULE_VERSION,
      status: "unknown",
      snapshotScope: "unbound",
      targets: [],
      unsupportedReasons: [...new Set([...plan.unsupportedReasons, "unsupported_shape"])],
    };
  }

  for (const target of selected) {
    assertNotCancelled(input.signal);
    if (target.unavailableReason) {
      targetReports.push({ ...target, status: "unknown", reason: target.unavailableReason });
      continue;
    }
    let raw: FanoutProbeResult;
    try {
      raw = await input.runProbe({ targetId: target.targetId, sql: probeSql(target, maxInputRows), ...(input.signal ? { signal: input.signal } : {}), ...(input.deadlineAt ? { deadlineAt: input.deadlineAt } : {}) });
    } catch (error) {
      if ((error as { readonly fanoutFatal?: unknown } | undefined)?.fanoutFatal === true) throw error;
      if (input.signal?.aborted || /cancel|abort/i.test(error instanceof Error ? error.message : String(error))) throw error;
      targetReports.push({ ...target, status: "unknown", reason: reasonFromError(error) });
      continue;
    }
    assertNotCancelled(input.signal);
    const observation = probeObservation(target, raw.rows[0], maxInputRows);
    if (!observation) {
      targetReports.push({ ...target, status: "unknown", reason: raw.truncated ? "input_limit_exceeded" : "probe_result_invalid" });
      continue;
    }
    if (!observation.complete) {
      targetReports.push({ ...target, status: "unknown", reason: "input_limit_exceeded", observation });
      continue;
    }
    if (observation.sourceRows !== observation.sourceNonNullKeys || observation.sourceNonNullKeys !== observation.sourceDistinctKeys) {
      targetReports.push({ ...target, status: "unknown", reason: "source_key_unproven", observation });
      continue;
    }
    if (observation.joinedNonNullKeys > observation.joinedDistinctKeys) {
      targetReports.push({ ...target, status: "finding", observation, reason: "source_key_repeated_after_join" });
    } else {
      targetReports.push({ ...target, status: "clear", observation });
    }
  }
  if (omitted) {
    targetReports.push({
      targetId: "fanout-omitted-targets",
      blockDepth: -1,
      aggregateExpressions: [],
      aggregateFunctions: [],
      sourceRelation: "unknown",
      sourceAlias: "unknown",
      sourceKey: "unknown",
      sourceKeySql: "unknown",
      sourceSql: "unknown",
      fromSql: "unknown",
      status: "unknown",
      reason: "probe_budget_exhausted",
    });
  }
  const status = statusFor(targetReports, plan.potential, plan.unsupportedReasons);
  return {
    ruleVersion: FANOUT_RULE_VERSION,
    status,
    snapshotScope: targetReports.some((target) => target.observation) ? "probe_statement" : "unbound",
    targets: targetReports,
    ...(plan.unsupportedReasons.length ? { unsupportedReasons: plan.unsupportedReasons } : {}),
  };
}
