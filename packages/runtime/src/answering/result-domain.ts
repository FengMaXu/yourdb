import type { SpecFields } from "./model.js";
import { settledField } from "./support.js";

/**
 * Result domain (plan T4.2): values the declared measure cannot take. It reads
 * only the sealed measure.formula and the delivered rows, at no SQL cost, and
 * is a disclosed finding, never a block, until offline replay shows a sub-rule
 * is never wrong on correct answers (ADR-0003).
 *
 * The measure column is the last numeric column of the result (the shape the
 * output convention puts it in); a result with no numeric column is read only
 * for the all-NULL rule.
 */
export const RESULT_DOMAIN_CHECK_ID = "result_domain";
export const RESULT_DOMAIN_RULE_VERSION = "result-domain-v1";

export type ResultDomainRule = "count_negative" | "count_fractional" | "percentage_as_fraction" | "ratio_as_percentage" | "measure_all_null";

export type ResultDomainOutcome =
  | { readonly kind: "clear" }
  | { readonly kind: "not_applicable"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "finding"; readonly rule: ResultDomainRule; readonly column: string; readonly message: string };

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && NUMERIC.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** The op that produces the delivered number: the top operation of the formula. */
function measureOp(fields: SpecFields): string | undefined {
  return settledField(fields, "measure.formula")?.op;
}

export function evaluateResultDomain(fields: SpecFields, result: { readonly columns: readonly string[]; readonly rows: readonly (readonly unknown[])[] }): ResultDomainOutcome {
  const op = measureOp(fields);
  if (!op) return { kind: "not_applicable", reason: "measure.formula is not settled" };
  if (result.rows.length === 0) return { kind: "not_applicable", reason: "the result has no rows" };
  const width = result.columns.length;
  const values = (index: number) => result.rows.map((row) => row[index]);
  const nonNull = (index: number) => values(index).filter((item) => item !== null && item !== undefined);
  const last = width - 1;
  if (last >= 0 && nonNull(last).length === 0) {
    return { kind: "finding", rule: "measure_all_null", column: result.columns[last]!, message: `Every row of ${result.columns[last]} is NULL, so the result carries no value of measure.formula (${op}). Check the join or filter that empties it, or the aggregate over no rows` };
  }
  let measure: number | undefined;
  for (let index = width - 1; index >= 0; index--) {
    const present = nonNull(index);
    if (present.length > 0 && present.every((item) => numberOf(item) !== undefined)) { measure = index; break; }
  }
  if (measure === undefined) return { kind: "unknown", reason: "no column holds only numbers, so the measure column is not known" };
  const column = result.columns[measure]!;
  const numbers = nonNull(measure).map((item) => numberOf(item)!);
  if (op === "count" || op === "count_distinct") {
    if (numbers.some((item) => item < 0)) return { kind: "finding", rule: "count_negative", column, message: `measure.formula is ${op}, but ${column} has a negative value. A count is never negative; check the subtraction or sign in the SQL` };
    if (numbers.some((item) => Math.abs(item - Math.round(item)) > 1e-9)) return { kind: "finding", rule: "count_fractional", column, message: `measure.formula is ${op}, but ${column} has a fractional value. A count is a whole number; check whether the SQL averages or divides instead of counting` };
    return { kind: "clear" };
  }
  const nonzero = numbers.filter((item) => item !== 0);
  if (op === "percentage" && nonzero.length > 0 && nonzero.every((item) => item > 0 && item < 1)) {
    return { kind: "finding", rule: "percentage_as_fraction", column, message: `measure.formula is percentage (100·a/b), but every nonzero ${column} lies between 0 and 1, as a fraction would. Multiply by 100, or rewrite measure.formula as ratio if a fraction is meant` };
  }
  if (op === "ratio" && nonzero.length > 0 && nonzero.every((item) => item > 1 && item <= 100) && nonzero.some((item) => item !== Math.round(item))) {
    return { kind: "finding", rule: "ratio_as_percentage", column, message: `measure.formula is ratio (a/b), but every nonzero ${column} lies between 1 and 100 with fractions, as a percentage would. Drop the factor of 100, or rewrite measure.formula as percentage if a percentage is meant` };
  }
  return { kind: "clear" };
}
