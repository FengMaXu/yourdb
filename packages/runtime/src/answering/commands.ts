/** Inputs of the public use cases, invocation context, and the small pure helpers they share. */
import { readOnlyStatement } from "./sql-lex.js";
import { AnsweringError } from "./errors.js";
import { createHash } from "node:crypto";
import type { EvidenceKind, BoundedResult } from "./records.js";

/**
 * The single Answer Spec write (ADR-0007): fields by path, each checked and
 * applied on its own; the applied ones land as one Revision. Without taskId
 * the call starts the Query Task.
 */
export interface SetAnswerFields {
  readonly taskId?: string;
  /** The request message the task answers; required when starting a task. */
  readonly requestMessageId?: string;
  /** The Host's current user message, which a `message` citation quotes. */
  readonly currentMessageId?: string;
  readonly requestId: string;
  /** Untrusted field writes by path; the Runtime parses and checks each. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** Start a Report Task: shared fields only, never a result (ADR-0009). */
  readonly report?: boolean;
  /** Start a chart query under this Report Task; it inherits the shared fields. */
  readonly parent?: { readonly taskId: string };
  /** Chart query: bind to the Report Task's current Revision and copy its shared fields again. */
  readonly rebind?: boolean;
}

/**
 * user_confirmation sourceRef naming the user's answer to a clarification
 * (`clarification:<clarificationId>`); any other ref is a chat message id.
 */
export const CLARIFICATION_SOURCE_PREFIX = "clarification:";

export interface UntrustedEvidenceInput {
  /** Handle for the field write that cites it. */
  readonly localId?: string;
  /** "document": an authorized knowledge document, admitted with the kind the composition root configured for it. */
  readonly kind: EvidenceKind | "document";
  /**
   * Document kinds: authorized knowledge id. request_wording: ignored, Runtime
   * binds the task request message. user_confirmation: the Host's current user
   * message id, or a recorded clarification answer (CLARIFICATION_SOURCE_PREFIX);
   * the tool layer resolves the model's ref to one of these.
   */
  readonly sourceRef?: string;
  readonly contentHash?: string;
  readonly quote?: string;
  readonly preview?: BoundedResult;
}

export type ExecuteQuery =
  | {
      readonly kind: "exploration";
      readonly taskId: string;
      readonly sql: string;
      readonly limit?: number;
      /** Run this exploration as the probe of one alternative of an open field (ADR-0005). */
      readonly probe?: { readonly path: string; readonly alternativeId: string };
      /** Host-owned serialized preview cap; model-facing tools do not expose it. */
      readonly maxPreviewBytes?: number;
      readonly requestId?: string;
    }
  | {
      readonly kind: "result";
      readonly taskId: string;
      readonly revisionId: string;
      readonly sql: string;
      readonly requestId?: string;
    };

export interface PublishCandidate {
  readonly candidateId: string;
  readonly format: "auto" | "inline" | "csv";
  readonly requestId: string;
}

/** Run a published result's query again and publish the new rows as a new Receipt (ADR-0010). */
export interface RefreshPublication {
  readonly receiptId: string;
  readonly requestId: string;
}

export interface InspectAnswer {
  readonly taskId: string;
}

export interface Principal {
  readonly id: string;
}

export interface InvocationMemo {
  get(name: string): Promise<unknown | undefined>;
  set(name: string, value: unknown): Promise<void>;
}

export interface QueryExecutionScope {
  /** Opaque host-issued scope identity; the executor must enforce its policy. */
  readonly scopeId: string;
  readonly connectionId: string;
}

export interface BusinessContext {
  readonly principal: Principal;
  readonly sessionId: string;
  readonly lane: string;
  readonly operationId: string;
  readonly invocationId: string;
  /** Pi invocation memo; Answering never persists a parallel operation checkpoint. */
  readonly memo?: InvocationMemo;
  readonly signal?: AbortSignal;
  /** Host-owned deadline propagated to a scoped external executor. */
  readonly deadlineAt?: number;
  /** Only a trusted application composition may provide this capability. */
  readonly queryScope?: QueryExecutionScope;
  /** Optional host-owned optimistic guard for delegated work on one Revision. */
  readonly expectedRevisionId?: string;
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === "user_confirmation" || value === "reviewed_definition" || value === "task_document"
    || value === "request_wording" || value === "schema_fact" || value === "query_observation";
}

export function isReadOnlySql(sql: string): boolean {
  return readOnlyStatement(sql) !== undefined;
}

const SCOPED_FORBIDDEN = /\b(?:copy|attach|detach|load_file|pg_read_file|pg_ls_dir|dblink|pg_sleep|set_config|lo_import|lo_export|benchmark|sleep|sys_exec|into\s+(?:out|dump)file)\b/i;

/**
 * Conservative preflight for the delegated path. This is not a database
 * security boundary; the injected scoped executor must still enforce a
 * read-only connection and relation policy.
 */
export function isScopedReadOnlySql(sql: string): boolean {
  const statement = readOnlyStatement(sql, SCOPED_FORBIDDEN);
  return statement !== undefined && /^(?:select|with)\b/i.test(statement);
}

export function normalizeLimit(limit: number | undefined, fallback = 50, maximum = 10_000): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new AnsweringError("INVALID_REQUEST", "INVALID_QUERY_LIMIT");
  return Math.min(limit, maximum);
}

export function contentHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return { __type: "bigint", value: item.toString() };
    if (item === undefined) return { __type: "undefined" };
    return item;
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
