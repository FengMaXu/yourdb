import type { BoundedResult, QueryExecutionScope } from "./model.js";
import type { FanoutDialect, FanoutSchema } from "./fanout-check.js";
import { AnsweringError } from "./errors.js";
import { inferType } from "./support.js";

export interface SqlQueryResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly truncated: boolean;
  readonly columnTypes?: readonly string[];
}

/** Adapter errors may mark an external call as unknown; Answering must not retry it. */
export class SqlExecutionError extends Error {
  readonly outcome: "failed" | "unknown";
  readonly obstacleKind: "technical_failure" | "mapping_insufficient" | "business_judgment_required";

  constructor(
    message: string,
    outcome: "failed" | "unknown" = "failed",
    obstacleKind: "technical_failure" | "mapping_insufficient" | "business_judgment_required" = "technical_failure",
  ) {
    super(message);
    this.name = "SqlExecutionError";
    this.outcome = outcome;
    this.obstacleKind = obstacleKind;
  }
}

export interface AnsweringSqlExecutor {
  readonly dialect?: FanoutDialect;
  readonly getSchema?: (signal?: AbortSignal) => Promise<FanoutSchema>;
  run(sql: string, rowLimit: number, options: {
    readonly kind: "exploration" | "result";
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
    readonly maxPreviewBytes?: number;
    readonly scope?: QueryExecutionScope;
  }): Promise<SqlQueryResult>;
}


function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { __type: "bigint", value: item.toString() } : item), "utf8");
}

export function boundedResult(result: SqlQueryResult, maxBytes?: number): BoundedResult {
  const columns = [...result.columns];
  const rows = result.rows.map((row) => [...row]);
  const columnTypes = [...(result.columnTypes ?? columns.map((_, index) => inferType(rows[0]?.[index])))];
  let bounded: BoundedResult = { columns, rows, columnTypes, rowCount: rows.length, truncated: result.truncated };
  if (maxBytes === undefined) return bounded;
  const limit = Math.max(1_024, Math.min(Math.trunc(maxBytes), 64 * 1_024));
  while (bounded.rows.length > 0 && serializedByteLength(bounded) > limit) {
    const nextRows = bounded.rows.slice(0, -1);
    bounded = { ...bounded, rows: nextRows, truncated: true };
  }
  if (serializedByteLength(bounded) > limit) {
    throw new AnsweringError("INVALID_REQUEST", "Exploration preview metadata exceeds the serialized byte limit");
  }
  return bounded;
}
