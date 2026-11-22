import { randomUUID } from "node:crypto";
import type { CheckCoverage, Finding, SpecFields } from "./model.js";
import type { OutputValue } from "./fields.js";
import type { PrivateResultObject } from "./result-store.js";
import { evaluateResultDomain, RESULT_DOMAIN_CHECK_ID, RESULT_DOMAIN_RULE_VERSION } from "./result-domain.js";

type CheckUnknownReason = "digest_unavailable" | "schema_unavailable" | "insufficient_evidence";

type CheckOutcome =
  | { readonly kind: "confirmed"; readonly finding: Finding }
  | { readonly kind: "clear" }
  | { readonly kind: "not_applicable"; readonly reason?: string }
  | { readonly kind: "unknown"; readonly reason: CheckUnknownReason | string };

export interface CandidateCheckInput {
  readonly fields: SpecFields;
  readonly result: PrivateResultObject;
  readonly queryHash: string;
}

export interface CandidateCheck {
  readonly id: string;
  readonly ruleVersion?: string;
  evaluate(input: CandidateCheckInput): CheckOutcome;
}

export interface CandidateCheckReport {
  readonly findings: readonly Finding[];
  readonly coverage: readonly CheckCoverage[];
}

function finding(kind: Finding["kind"], message: string, blocking: boolean, checkId: string): Finding {
  return { id: `finding_${kind}_${cryptoRandomId()}`, kind, message, blocking, checkId };
}

function cryptoRandomId(): string {
  // Candidate findings are informational identities; they are not a second
  // state authority and are recreated with the immutable candidate.
  return randomUUID();
}

const shapeCheck: CandidateCheck = {
  id: "result_shape",
  evaluate(input) {
    const field = input.fields.output;
    if (!field || (field.state !== "specified" && field.state !== "decided")) return { kind: "not_applicable" };
    const output = field.value as OutputValue;
    if (output.rowMode === "scalar" && input.result.rowCount !== 1) {
      return { kind: "confirmed", finding: finding("shape_conflict", `Expected one scalar row but received ${input.result.rowCount}`, true, "result_shape") };
    }
    // A declared count is a promise for top_n and for grouped (e.g. "the three industries"); full/detail stay unchecked.
    if ((output.rowMode === "top_n" || output.rowMode === "grouped") && output.rowCount !== undefined && input.result.rowCount !== output.rowCount) {
      return { kind: "confirmed", finding: finding("shape_conflict", `Expected ${output.rowCount} ${output.rowMode} rows but received ${input.result.rowCount}. Fix the query if groups are missing or duplicated, or revise output.rowCount if the declaration is wrong`, true, "result_shape") };
    }
    if (output.columns && (output.columns.length !== input.result.columns.length || output.columns.some((column, index) => column !== input.result.columns[index]))) {
      // Name both lists: the fix is either SQL aliases or the declared columns, and only the pair shows which.
      const message = `Result columns do not match the declared output shape: declared ${JSON.stringify(output.columns)}, result ${JSON.stringify(input.result.columns)}. Alias the SQL columns to the declared names in the same order, or revise output.columns if the declaration is wrong`;
      return { kind: "confirmed", finding: finding("shape_conflict", message, true, "result_shape") };
    }
    return { kind: "clear" };
  },
};

const completenessCheck: CandidateCheck = {
  id: "result_completeness",
  evaluate(input) {
    return input.result.truncated
      ? { kind: "confirmed", finding: finding("result_incomplete", "A truncated result cannot be published as a complete candidate", true, "result_completeness") }
      : { kind: "clear" };
  },
};

const identityCheck: CandidateCheck = {
  id: "result_identity",
  evaluate(input) {
    return input.result.resultRef && input.result.contentHash && input.queryHash
      ? { kind: "clear" }
      : { kind: "confirmed", finding: finding("integrity_conflict", "Result identity is incomplete", true, "result_identity") };
  },
};

/** Plan T4.2: values the declared measure cannot take; disclosed, never blocking (ADR-0003). */
const domainCheck: CandidateCheck = {
  id: RESULT_DOMAIN_CHECK_ID,
  ruleVersion: RESULT_DOMAIN_RULE_VERSION,
  evaluate(input) {
    const outcome = evaluateResultDomain(input.fields, input.result);
    if (outcome.kind === "finding") return { kind: "confirmed", finding: { ...finding("result_domain", outcome.message, false, RESULT_DOMAIN_CHECK_ID), paths: ["measure.formula"] } };
    return outcome;
  },
};

const DEFAULT_CANDIDATE_CHECKS: readonly CandidateCheck[] = [completenessCheck, shapeCheck, identityCheck, domainCheck];

/**
 * Keep all check outcomes, not only blocking findings. `unknown` and
 * `not_applicable` are coverage facts for the Candidate; they are never
 * silently converted to `clear` and do not become a generic publish gate.
 */
export function evaluateCandidateCheckReport(input: CandidateCheckInput, checks: readonly CandidateCheck[] = DEFAULT_CANDIDATE_CHECKS): CandidateCheckReport {
  const findings: Finding[] = [];
  const coverage: CheckCoverage[] = [];
  for (const check of checks) {
    const outcome = check.evaluate(input);
    const version = check.ruleVersion ? { ruleVersion: check.ruleVersion } : {};
    switch (outcome.kind) {
      case "confirmed":
        findings.push(outcome.finding);
        coverage.push({ checkId: check.id, ...version, outcome: "finding", reason: outcome.finding.message });
        break;
      case "clear":
        coverage.push({ checkId: check.id, ...version, outcome: "clear" });
        break;
      case "not_applicable":
        coverage.push({ checkId: check.id, ...version, outcome: "not_applicable", ...(outcome.reason ? { reason: outcome.reason } : {}) });
        break;
      case "unknown":
        coverage.push({ checkId: check.id, ...version, outcome: "unknown", reason: outcome.reason });
        break;
    }
  }
  return { findings, coverage };
}

export function candidateCheckFailure(findings: readonly Finding[]): Finding | undefined {
  return findings.find((item) => item.blocking);
}
