import type { ImplementationObstacle } from "./model.js";

export const DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE";

/** Executor adapters mark an unreachable database with this code (see mcp-query-executor). */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; message?: unknown };
  return record.code === DATABASE_UNAVAILABLE || (typeof record.message === "string" && record.message.startsWith(`${DATABASE_UNAVAILABLE}:`));
}

export class AnsweringError extends Error {
  readonly code:
    | "ANSWERING_CONTEXT_INVALID"
    | "ANSWERING_OPERATION_ABORTED"
    | "INVALID_REQUEST"
    | "TASK_NOT_FOUND"
    | "REVISION_STALE"
    | "REVISION_NOT_FOUND"
    | "UNRESOLVED_ASSUMPTIONS"
    | "INVALID_QUERY"
    | "QUERY_EXECUTION_FAILED"
    | "EXPLORATION_NOT_PUBLISHABLE"
    | "CANDIDATE_NOT_FOUND"
    | "PUBLICATION_NOT_FOUND"
    | "RESULT_INCOMPLETE"
    | "RESULT_REF_MISSING"
    | "RESULT_INTEGRITY_MISMATCH"
    | "RESULT_EXECUTION_OUTCOME_UNKNOWN"
    | "CANDIDATE_CHECK_FAILED"
    | "IMPLEMENTATION_BUDGET_EXHAUSTED"
    | "INLINE_RESULT_TOO_LARGE"
    | "PUBLICATION_STALE"
    | "PUBLICATION_ALREADY_EXISTS"
    /** Evidence Admission rejected a quote, source or reference (ADR-0004). */
    | "EVIDENCE_REJECTED"
    /** A revision tried a transition the Runtime state machine does not allow (ADR-0004). */
    | "SPEC_TRANSITION_INVALID"
    /** A Report Task holds shared fields; it never runs a result query or publishes (ADR-0009). */
    | "REPORT_TASK_NOT_PUBLISHABLE"
    /** The chart query's bound parent Revision is no longer the Report Task's current one. */
    | "PARENT_REVISION_STALE"
    /** The Report Task still has unhandled shared fields, hypotheses or choices. */
    | "PARENT_UNRESOLVED"
    /** The database could not be reached even after reconnecting; the operation must end. */
    | "DATABASE_UNAVAILABLE"
    /** The result reproduces the output of a Choice alternative that was not adopted (ADR-0005). */
    | "DECISION_NOT_REALIZED"
    /** The final SQL cannot implement a sealed field, so it was not run. */
    | "SPEC_NOT_REALIZED";
  readonly details?: unknown;
  readonly obstacle?: ImplementationObstacle;

  constructor(code: AnsweringError["code"], message: string, details?: unknown) {
    super(message);
    this.name = "AnsweringError";
    this.code = code;
    this.details = details;
    const record = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
    if (record?.obstacle && typeof record.obstacle === "object") this.obstacle = record.obstacle as ImplementationObstacle;
  }
}
