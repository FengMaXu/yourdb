import { AnsweringError } from "./errors.js";
import type { BusinessContext, FieldRecord } from "./model.js";
import type { FieldPath, FieldValues, SpecPath } from "./fields.js";

/** Small shared helpers for the Answering use-case modules. */
export { asRecord, now } from "../primitives.js";

export function localId(value: string, prefix: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new AnsweringError("INVALID_REQUEST", `${prefix} must not be empty`);
  return normalized;
}

/**
 * The value of a field that is specified or decided, typed by its path;
 * undefined while it is open, not applicable or unset. This is the single
 * decoding point from a stored FieldRecord to a path's value type: the value
 * was parsed by parseFieldValue for that same path when it was written.
 */
export function settledField<P extends FieldPath>(fields: Partial<Record<SpecPath, FieldRecord>>, path: P): FieldValues[P] | undefined {
  const field = fields[path];
  return isSettled(field) ? field.value as FieldValues[P] : undefined;
}

/** The values a field can still take, typed by its path: its value, or every alternative while it is open. */
export function possibleValues<P extends FieldPath>(fields: Partial<Record<SpecPath, FieldRecord>>, path: P): readonly FieldValues[P][] {
  const field = fields[path];
  if (!field) return [];
  if (field.state === "specified" || field.state === "decided") return [field.value as FieldValues[P]];
  if (field.state === "open") return field.alternatives.map((item) => item.value as FieldValues[P]);
  return [];
}

/** A field is settled once it is specified or decided. */
export function isSettled(field: FieldRecord | undefined): field is Extract<FieldRecord, { readonly state: "specified" | "decided" }> {
  return field?.state === "specified" || field?.state === "decided";
}

/** The column type of a sample value, for result columns the driver did not type. */
export function inferType(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return "BIGINT";
  if (typeof value === "number") return Number.isInteger(value) ? "INTEGER" : "REAL";
  if (typeof value === "boolean") return "BOOLEAN";
  if (typeof value === "object") return "JSON";
  return "TEXT";
}

/** Every Answering operation runs for an identified principal, session, operation and invocation, and stops once aborted. */
export function assertContext(context: BusinessContext): void {
  if (!context?.principal?.id || !context.sessionId || !context.operationId || !context.invocationId) {
    throw new AnsweringError("ANSWERING_CONTEXT_INVALID", "Answering requires principal, session, operation and invocation identities");
  }
  if (context.signal?.aborted) throw new AnsweringError("ANSWERING_OPERATION_ABORTED", "Answering operation was cancelled");
}
