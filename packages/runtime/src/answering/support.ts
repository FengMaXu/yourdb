import { AnsweringError } from "./errors.js";
import type { FieldRecord } from "./model.js";

/** Small shared helpers for the Answering use-case modules. */
export function now(): string { return new Date().toISOString(); }

export function localId(value: string, prefix: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new AnsweringError("INVALID_REQUEST", `${prefix} must not be empty`);
  return normalized;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The value of a field that is specified or decided; undefined while it is open. */
export function settled<T>(field: FieldRecord | undefined): T | undefined {
  return field && (field.state === "specified" || field.state === "decided") ? field.value as T : undefined;
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
