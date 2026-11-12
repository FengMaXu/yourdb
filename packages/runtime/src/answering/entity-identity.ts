import { randomUUID } from "node:crypto";
import type { CheckCoverage, Finding, SpecFields } from "./model.js";
import { layersOf, type EntityValue, type MeasureExpression, type SourceValue } from "./fields.js";
import { settled } from "./support.js";

/**
 * Entity identity: does one row of a declared source stand for one entity?
 * The check reads only population.entity, population.source and
 * measure.formula, counts rows, distinct rows and distinct declared keys of
 * each source table, and reports what the counts contradict. It states data
 * facts; whether duplicates are one entity or separate events stays a Spec
 * decision. Findings are disclosed, never blocking (ADR-0003).
 */
export const ENTITY_IDENTITY_CHECK_ID = "entity_identity";
export const ENTITY_IDENTITY_RULE_VERSION = "entity-identity-v2";
/** Source tables checked per Revision. */
export const ENTITY_IDENTITY_MAX_TABLES = 3;
/** Above this many rows the DISTINCT counts are skipped and reported as not determinable. */
export const ENTITY_IDENTITY_MAX_ROWS = 2_000_000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What one source table holds; counts are absent when they were not taken. */
export interface TableIdentityObservation {
  readonly table: string;
  readonly keyColumns?: readonly string[];
  readonly rows?: number;
  readonly distinctRows?: number;
  readonly distinctKeys?: number;
  /** Why a count is missing: the table or key could not be read, or the table is too large. */
  readonly limitation?: string;
}

export interface EntityIdentityFinding {
  readonly code: "key_not_unique" | "duplicate_rows";
  readonly paths: readonly string[];
  readonly table: string;
  readonly message: string;
}

export interface EntityIdentityReport {
  readonly ruleVersion: typeof ENTITY_IDENTITY_RULE_VERSION;
  readonly status: "clear" | "finding" | "not_applicable" | "unknown";
  readonly observations: readonly TableIdentityObservation[];
  readonly findings: readonly EntityIdentityFinding[];
  readonly limitations: readonly string[];
}


/** A plain, optionally schema-qualified table name, or undefined when it is not one. */
function tableName(item: string): string | undefined {
  const parts = item.trim().split(".").map((part) => part.trim().replace(/^[`"[]|[`"\]]$/g, ""));
  return parts.length <= 2 && parts.every((part) => IDENTIFIER.test(part)) ? parts.join(".") : undefined;
}

/** The column a key names: "mst_users.user_id" is user_id. */
function columnName(item: string): string | undefined {
  const last = item.trim().split(".").at(-1)?.trim().replace(/^[`"[]|[`"\]]$/g, "");
  return last && IDENTIFIER.test(last) ? last : undefined;
}

/** One table to observe and the key columns to count on it. */
export interface IdentityTarget {
  readonly table: string;
  readonly keyColumns?: readonly string[];
}

/** Tables to observe for this Revision; empty when entity or source is not settled. */
export function identityTargets(fields: SpecFields): { readonly targets: readonly IdentityTarget[]; readonly limitations: readonly string[] } {
  const entity = settled<EntityValue>(fields["population.entity"]);
  const source = settled<SourceValue>(fields["population.source"]);
  if (!entity || !source) return { targets: [], limitations: [] };
  const limitations: string[] = [];
  const keys = entity.keyColumns?.map(columnName);
  if (keys?.some((key) => !key)) limitations.push("population.entity.keyColumns has a name that is not a plain column");
  const keyColumns = keys && keys.every(Boolean) ? keys as string[] : undefined;
  const tables = source.tables.map(tableName);
  source.tables.forEach((item, index) => { if (!tables[index]) limitations.push(`source ${JSON.stringify(item)} is not a plain table name`); });
  const named = [...new Set(tables.filter((item): item is string => Boolean(item)))];
  if (named.length > ENTITY_IDENTITY_MAX_TABLES) limitations.push(`only the first ${ENTITY_IDENTITY_MAX_TABLES} source tables are checked`);
  return { targets: named.slice(0, ENTITY_IDENTITY_MAX_TABLES).map((table) => ({ table, ...(keyColumns ? { keyColumns } : {}) })), limitations };
}

/** Read-only counting queries for one target; identifiers are validated plain names. */
export function identityQueries(target: IdentityTarget): { readonly rows: string; readonly distinctRows: string; readonly distinctKeys?: string } {
  return {
    rows: `SELECT COUNT(*) AS n FROM ${target.table}`,
    distinctRows: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT * FROM ${target.table}) AS d`,
    ...(target.keyColumns ? { distinctKeys: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT ${target.keyColumns.join(", ")} FROM ${target.table}) AS d` } : {}),
  };
}

function countLayers(formula: MeasureExpression | undefined): readonly MeasureExpression[] {
  return formula ? layersOf(formula).filter((layer) => layer.op === "count") : [];
}

function names(text: string, key: string): boolean {
  return new RegExp(`(^|[^\\w])${key}($|[^\\w])`, "i").test(text);
}

/**
 * What the counts contradict in the current fields. A declared key that is
 * not unique matters only when the formula counts it: a count whose operand
 * names the key. (Any count over a single-table source fired on correct
 * answers that count events per entity, e.g. orders per employee.)
 */
export function evaluateEntityIdentity(fields: SpecFields, observations: readonly TableIdentityObservation[], limitations: readonly string[] = []): EntityIdentityReport {
  const findings: EntityIdentityFinding[] = [];
  const counts = countLayers(settled<MeasureExpression>(fields["measure.formula"]));
  for (const item of observations) {
    if (item.rows === undefined) continue;
    if (item.keyColumns && item.distinctKeys !== undefined && item.distinctKeys < item.rows) {
      if (counts.some((layer) => typeof layer.of === "string" && item.keyColumns!.some((key) => names(layer.of as string, key)))) {
        const key = item.keyColumns.join(", ");
        findings.push({
          code: "key_not_unique",
          paths: ["population.entity", "measure.formula", "measure.countGrain"],
          table: item.table,
          message: `population.entity is keyed by ${key}, but ${item.table} has ${item.rows} rows for ${item.distinctKeys} distinct ${key}; counting rows counts some entities more than once. Count distinct ${key}, or rewrite population.entity or measure.countGrain with the reason each row is a separate entity`,
        });
      }
    }
    if (item.distinctRows !== undefined && item.distinctRows < item.rows) {
      findings.push({
        code: "duplicate_rows",
        paths: ["population.entity", "population.joinMultiplicity"],
        table: item.table,
        // A data-quality fact, not a Spec instruction: deduplicating on this count alone turned a correct local041 answer wrong.
        message: `${item.table} has ${item.rows} rows but ${item.distinctRows} distinct rows (${item.rows - item.distinctRows} exact duplicates). This is a data-quality fact, not a reason to deduplicate: count the rows as stored unless the request or a business document says a repeated row is the same entity`,
      });
    }
  }
  const allLimitations = [...limitations, ...observations.flatMap((item) => item.limitation ? [`${item.table}: ${item.limitation}`] : [])];
  const status = observations.length === 0 ? (allLimitations.length > 0 ? "unknown" : "not_applicable")
    : findings.length > 0 ? "finding"
      : allLimitations.length > 0 ? "unknown" : "clear";
  return { ruleVersion: ENTITY_IDENTITY_RULE_VERSION, status, observations, findings, limitations: allLimitations };
}

export function entityIdentityCoverage(report: EntityIdentityReport | undefined): CheckCoverage {
  // No report means the Revision had no settled entity and source to count (see attachEntityIdentity).
  if (!report) return { checkId: ENTITY_IDENTITY_CHECK_ID, ruleVersion: ENTITY_IDENTITY_RULE_VERSION, outcome: "not_applicable", reason: "population.entity or population.source is not settled." };
  const reason = report.status === "finding" ? report.findings.map((item) => item.message).join(" | ")
    : report.limitations.length > 0 ? report.limitations.join("; ")
      : report.status === "not_applicable" ? "population.entity or population.source is not settled." : undefined;
  return { checkId: ENTITY_IDENTITY_CHECK_ID, ruleVersion: ENTITY_IDENTITY_RULE_VERSION, outcome: report.status, ...(reason ? { reason } : {}) };
}

export function entityIdentityFindings(report: EntityIdentityReport | undefined): readonly Finding[] {
  return (report?.findings ?? []).map((item) => ({ id: `finding_entity_identity_${randomUUID()}`, kind: "entity_identity" as const, message: item.message, blocking: false, checkId: ENTITY_IDENTITY_CHECK_ID }));
}

/** One line for the Receipt: identity facts the result was delivered with. */
export function entityIdentityDisclosure(findings: readonly Finding[]): string {
  const items = findings.filter((item) => item.kind === "entity_identity");
  return items.length > 0 ? `来源表的行与实体不一一对应（数据计数，未裁决业务口径）：${items.map((item) => item.message).join("；")}。` : "";
}

export function renderEntityIdentity(report: EntityIdentityReport | undefined): string {
  if (!report || report.status === "not_applicable") return "";
  const lines = [`[ENTITY_IDENTITY] status=${report.status}`];
  for (const item of report.observations) {
    if (item.rows !== undefined) lines.push(`- ${item.table}: rows=${item.rows}${item.distinctRows !== undefined ? ` distinct_rows=${item.distinctRows}` : ""}${item.distinctKeys !== undefined ? ` distinct(${item.keyColumns!.join(",")})=${item.distinctKeys}` : ""}`);
  }
  for (const item of report.findings) lines.push(`finding: ${item.message}`);
  if (report.limitations.length > 0) lines.push(`limitations: ${report.limitations.join("; ")}`);
  return lines.join("\n");
}
