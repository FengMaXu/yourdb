import { createHash } from "node:crypto";
import type { FieldValue, SpecPath } from "./fields.js";
import type { EntityIdentityReport } from "./entity-identity.js";
import type { CalendarCoverageReport } from "./calendar-coverage.js";
import type { FieldAdvisory } from "./advice.js";

/**
 * Domain identities are branded at the Answering boundary. Constructors are
 * intentionally private to this module; callers receive opaque strings from
 * the five public use cases and must still be checked by the Store.
 */
declare const identityBrand: unique symbol;
export type Id<K extends string> = string & { readonly [identityBrand]: K };

export type TaskId = Id<"TaskId">;
export type RevisionId = Id<"RevisionId">;
export type ReadyRevisionId = Id<"ReadyRevisionId">;
export type EvidenceId = Id<"EvidenceId">;
export type QualifiedEvidenceId = Id<"QualifiedEvidenceId">;
export type AlternativeId = Id<"AlternativeId">;
export type CandidateId = Id<"CandidateId">;
export type PrivateResultRef = Id<"PrivateResultRef">;
export type PublicationId = Id<"PublicationId">;

export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * The inner loop reports obstacles instead of collapsing every failure into a
 * semantic disagreement.  This is an internal Answering contract: it does
 * not add a sixth public use case or give an Agent permission to mutate the
 * current Spec.
 */
export type ImplementationObstacleKind =
  | "technical_failure"
  | "mapping_insufficient"
  | "business_judgment_required"
  | "budget_exhausted"
  | "execution_outcome_unknown";

export type ExecutionOutcome = "not_started" | "failed" | "succeeded" | "unknown";

export type QueryAttemptKind = "revision" | "exploration" | "result";
export type QueryAttemptPurpose = "user_exploration" | "fanout_probe" | "field_probe";
export type QueryAttemptState = "blocked" | "started" | "succeeded" | "failed" | "unknown";

export interface QueryBudgetPolicy {
  readonly version: "answering-dual-loop-v1";
  /** Number of revisions after begin; a revision never resets the other counters. */
  readonly maxRevisions: number;
  /** Bounded semantic/data-property probes for one Query Task. */
  readonly maxExplorationAttempts: number;
  /** Bounded final-query implementations for one Query Task. */
  readonly maxResultAttempts: number;
  /** Wall-clock lifetime of the task budget. */
  readonly maxElapsedMs: number;
  /** Maximum observed result rows charged to the task across attempts. */
  readonly maxObservedRows: number;
}

export interface QueryBudgetState {
  readonly policy: QueryBudgetPolicy;
  readonly startedAt: string;
  readonly revisionCount: number;
  readonly explorationAttempts: number;
  readonly resultAttempts: number;
  readonly observedRows: number;
}

export interface QueryAttemptRecord {
  readonly attemptId: string;
  readonly taskId: TaskId;
  readonly kind: QueryAttemptKind;
  readonly purpose?: QueryAttemptPurpose;
  readonly revisionId: RevisionId;
  readonly invocationId: string;
  readonly queryHash?: string;
  readonly state: QueryAttemptState;
  readonly sqlExecuted: boolean;
  readonly outcome: ExecutionOutcome;
  readonly obstacleKind?: ImplementationObstacleKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CheckCoverage {
  readonly checkId: string;
  readonly ruleVersion?: string;
  readonly outcome: "clear" | "finding" | "not_applicable" | "unknown";
  readonly reason?: string;
}

export interface FanoutProbeObservation {
  readonly sourceRows: number;
  readonly sourceNonNullKeys: number;
  readonly sourceDistinctKeys: number;
  readonly joinedRows: number;
  readonly joinedNonNullKeys: number;
  readonly joinedDistinctKeys: number;
  readonly complete: boolean;
  readonly fanoutFactor?: number;
  readonly sourceRelation: string;
  readonly sourceKey: string;
}

export interface FanoutTargetReport {
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
  readonly status: "clear" | "finding" | "unknown";
  readonly reason?: string;
  readonly observation?: FanoutProbeObservation;
}

export interface FanoutReport {
  readonly ruleVersion: string;
  readonly status: "clear" | "finding" | "not_applicable" | "unknown";
  readonly snapshotScope: "probe_statement" | "result_snapshot" | "unbound";
  readonly targets: readonly FanoutTargetReport[];
  readonly unsupportedReasons?: readonly string[];
}

export interface ImplementationObstacle {
  readonly kind: ImplementationObstacleKind;
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
  readonly message: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly attempts: readonly QueryAttemptRecord[];
  readonly coverage: readonly CheckCoverage[];
  readonly requiresOuterDecision: boolean;
  readonly retryable: boolean;
  readonly sqlExecuted: boolean;
  readonly executionOutcome: ExecutionOutcome;
  readonly queryHash?: string;
}

export interface EvidenceBase {
  readonly id: EvidenceId;
  readonly kind: EvidenceKind;
  readonly authority: EvidenceAuthority;
  readonly sourceRef: string;
  readonly contentHash?: string;
  /** For query observations, binds a replayed invocation to its SQL input. */
  readonly queryHash?: string;
  readonly quote?: string;
  readonly observedAt: string;
  /** Set only by Runtime Evidence Admission after the quote was found in a trusted source text. */
  readonly verification?: EvidenceVerification;
}

export interface EvidenceVerification {
  readonly method: "user_message_quote" | "clarification_answer_quote" | "document_quote";
  /** Hash of the complete trusted source text at admission time. */
  readonly sourceContentHash: string;
}

/** Evidence kinds whose authority comes from a quoted text and therefore require verification. */
export type TextEvidenceKind = "user_confirmation" | "reviewed_definition" | "task_document" | "request_wording";

export function isTextEvidenceKind(kind: EvidenceKind): kind is TextEvidenceKind {
  return kind === "user_confirmation" || kind === "reviewed_definition" || kind === "task_document" || kind === "request_wording";
}

export type EvidenceKind =
  | "user_confirmation"
  | "reviewed_definition"
  | "task_document"
  | "request_wording"
  | "schema_fact"
  | "query_observation";

export type EvidenceAuthority =
  | "user"
  | "reviewed_business_definition"
  | "task_document"
  | "request_wording"
  | "schema"
  | "observation";

export type Evidence =
  | (EvidenceBase & { readonly kind: "user_confirmation"; readonly authority: "user" })
  | (EvidenceBase & { readonly kind: "reviewed_definition"; readonly authority: "reviewed_business_definition" })
  | (EvidenceBase & { readonly kind: "task_document"; readonly authority: "task_document" })
  | (EvidenceBase & { readonly kind: "request_wording"; readonly authority: "request_wording" })
  | (EvidenceBase & { readonly kind: "schema_fact"; readonly authority: "schema" })
  | (EvidenceBase & { readonly kind: "query_observation"; readonly authority: "observation"; readonly preview: BoundedResult });

/** One alternative of an open field; the Runtime issues its id for probes and the decision. */
export interface FieldAlternative {
  readonly id: AlternativeId;
  readonly value: FieldValue;
}

/** An alternative that cannot be executed on its own; recorded instead of a probe (ADR-0005). */
export interface ProbeWaiver {
  readonly alternativeId: AlternativeId;
  readonly reason: string;
}

/** Why a decision departs from the advice's clear lean, with the evidence that outweighs it. */
export interface AdviceOverride {
  readonly reason: string;
  readonly evidenceIds: NonEmpty<EvidenceId>;
}

/**
 * What a value rests on. The Runtime, not the model, decides which applies
 * (ADR-0006): cited evidence that qualifies for the field's layer makes it
 * evidence; anything else is an assumption, disclosed at publication.
 */
export type FieldBasis =
  | { readonly kind: "evidence"; readonly evidenceIds: NonEmpty<EvidenceId> }
  | { readonly kind: "assumed"; readonly rationale?: string; readonly citedEvidenceIds?: readonly EvidenceId[] };

/**
 * One field of the Answer Spec (ADR-0007). A field is not applicable, has a
 * value with a basis, or is open between alternatives until it is decided.
 * `inherited` marks a chart query's copy of a Report Task field (ADR-0009).
 */
export type FieldRecord = (
  | { readonly state: "not_applicable" }
  | { readonly state: "specified"; readonly value: FieldValue; readonly basis: FieldBasis }
  | { readonly state: "open"; readonly alternatives: NonEmpty<FieldAlternative>; readonly waivers?: readonly ProbeWaiver[] }
  | {
      readonly state: "decided";
      readonly alternatives: NonEmpty<FieldAlternative>;
      readonly waivers?: readonly ProbeWaiver[];
      readonly alternativeId: AlternativeId;
      readonly value: FieldValue;
      readonly rationale: string;
      readonly basis: FieldBasis;
      readonly adviceOverride?: AdviceOverride;
      /** The advisor failed when advice was required; the decision was made without it and is disclosed. */
      readonly adviceUnavailable?: string;
      /** The advisor favoured no alternative and no user could be asked; the decision is disclosed (its recommendation kind). */
      readonly adviceUndecided?: string;
    }
) & { readonly inherited?: ParentBinding };

export type SpecFields = Readonly<Partial<Record<SpecPath, FieldRecord>>>;

/** A field that already had a state and was rewritten, with the reason given (ADR-0004 continuity). */
export interface FieldRewrite {
  readonly path: SpecPath;
  readonly reason: string;
}

/**
 * Runtime record of one exploration executed as an alternative's probe. The
 * fingerprint compares complete outputs the way the answer will be judged.
 */
export interface FieldProbeRecord {
  readonly path: SpecPath;
  readonly alternativeId: AlternativeId;
  readonly revisionId: RevisionId;
  readonly evidenceId: EvidenceId;
  /** probeContext of the other fields when the probe ran; absent on probes recorded before contexts, which are stale. */
  readonly context?: string;
  readonly rowCount: number;
  readonly outcome:
    | { readonly state: "available"; readonly fingerprint: string }
    | { readonly state: "unavailable"; readonly reason: string };
  readonly probedAt: string;
}

export interface DraftRevision {
  readonly state: "draft";
  readonly revisionId: RevisionId;
}

export interface ReadyRevision {
  readonly state: "ready";
  readonly revisionId: RevisionId;
  readonly ready: ReadyRevisionId;
}

export type RevisionState = DraftRevision | ReadyRevision;

export interface BoundedResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly columnTypes: readonly string[];
  readonly rowCount: number;
  readonly truncated: boolean;
}

export type QueryArtifact =
  | { readonly kind: "exploration"; readonly evidenceId: EvidenceId; readonly preview: BoundedResult }
  | {
      readonly kind: "candidate";
      readonly candidateId: CandidateId;
      readonly revisionId: RevisionId;
      readonly resultRef: PrivateResultRef;
    };

export interface Finding {
  readonly id: string;
  readonly kind: "shape_conflict" | "result_incomplete" | "integrity_conflict" | "join_fanout" | "realization_conflict" | "entity_identity" | "calendar_coverage";
  readonly message: string;
  readonly blocking: boolean;
  readonly checkId?: string;
}

export interface QueryTaskRecord {
  readonly taskId: TaskId;
  readonly sessionId: string;
  readonly principalId: string;
  readonly requestMessageId: string;
  readonly requestId: string;
  readonly currentRevisionId: RevisionId;
  readonly latestCandidateId?: CandidateId;
  readonly publicationId?: PublicationId;
  readonly lifecycle: "open" | "published" | "closed";
  /** Persisted task budget; a stored task without one is normalized on read/write. */
  readonly budget?: QueryBudgetState;
  /** Latest probe per field alternative; alternative ids are stable until the field is rewritten. */
  readonly fieldProbes?: readonly FieldProbeRecord[];
  /** Latest advice per open field, asked by the Runtime once the field's probe outputs differ (ADR-0005). */
  readonly fieldAdvice?: readonly FieldAdvisory[];
  /** "report": a Report Task that holds shared fields and never publishes (ADR-0009). */
  readonly role?: "report";
  /** A chart query's Report Task and the parent Revision its inherited fields were copied from. */
  readonly parent?: ParentBinding;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParentBinding {
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
}

/** A chart query's change to a field it inherits from its Report Task, with the reason given (ADR-0009 decision 3). */
export interface Deviation {
  /** A shared field path. */
  readonly path: string;
  readonly reason: string;
}


export interface AnswerRevisionRecord {
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
  readonly parentRevisionId?: RevisionId;
  readonly requestId: string;
  readonly fields: SpecFields;
  readonly state: RevisionState;
  readonly createdAt: string;
  /** Fields rewritten in this Revision, with reasons. */
  readonly rewrites?: readonly FieldRewrite[];
  /** Row, distinct-row and key counts of the declared sources, taken after the Revision commits; disclosed, never blocking. */
  readonly entityIdentity?: EntityIdentityReport;
  /** Periods of population.time the data has at the answer's calendar grain; missing periods make population.missing required. */
  readonly calendarCoverage?: CalendarCoverageReport;
  /** Inherited fields this chart query changed, with reasons; carried forward and disclosed. */
  readonly deviations?: readonly Deviation[];
  /** The Report Task measure definition this chart query's measure is copied from. */
  readonly measureRef?: string;
  /** For a chart query: the parent Revision this Revision's inherited fields came from. */
  readonly parentBinding?: ParentBinding;
}

export interface ResultCandidateRecord {
  readonly candidateId: CandidateId;
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
  readonly resultRef: PrivateResultRef;
  readonly resultSchema: readonly string[];
  readonly rowCount: number;
  readonly contentHash: string;
  /** Canonical submitted SQL retained so an authorized reviewer can inspect the exact candidate. */
  readonly sql: string;
  readonly queryHash: string;
  readonly findings: readonly Finding[];
  /** Check coverage is retained even when no blocking Finding was produced. */
  readonly coverage?: readonly CheckCoverage[];
  /** Immutable bounded JOIN fanout evidence for this exact candidate. */
  readonly fanout?: FanoutReport;
  readonly attemptId?: string;
  readonly createdByInvocationId: string;
  readonly createdAt: string;
  readonly status: "ready" | "corrupt";
  readonly publishable: boolean;
}

export interface UnverifiedField {
  readonly path: SpecPath;
  /** assumed: a value without qualifying evidence; decided: an open field decided without it. */
  readonly kind: "assumed" | "decided";
}

export interface PublicationDisclosure {
  readonly required: true;
  /** Fields whose value no qualifying evidence settles (ADR-0006). */
  readonly unverifiedFields: readonly UnverifiedField[];
  readonly summary: string;
  readonly fanoutStatus?: FanoutReport["status"];
  /** Shared fields this chart query changed from its Report Task. */
  readonly deviations?: readonly Deviation[];
  /** Set on a refresh when the Report Task has changed since the chart query copied its shared fields. */
  readonly parentSuperseded?: ParentSupersession;
}


export interface ParentSupersession {
  readonly taskId: TaskId;
  readonly boundRevisionId: RevisionId;
  readonly currentRevisionId: RevisionId;
}

/** Internal typestate. No model/HTTP caller can construct this permit. */
export interface PublicationPermit {
  readonly candidateId: CandidateId;
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
  readonly resultRef: PrivateResultRef;
  readonly contentHash: string;
  readonly policyVersion: "answering-publication-v1";
}

export interface PublicationReceipt {
  readonly receiptId: PublicationId;
  readonly taskId: TaskId;
  readonly principalId: string;
  readonly sessionId: string;
  readonly candidateId: CandidateId;
  readonly revisionId: RevisionId;
  readonly resultRef: PrivateResultRef;
  readonly format: "inline" | "csv";
  readonly publicRef: string;
  /** Hash of the immutable ResultStore object bound to this receipt. */
  readonly contentHash: string;
  /** Hash of the selected inline/CSV representation, when it is encoded. */
  readonly presentationContentHash?: string;
  readonly disclosure?: PublicationDisclosure;
  readonly policyVersion: "answering-publication-v1";
  /** Coverage is not a semantic approval; it records checks that were unavailable or inapplicable. */
  readonly coverage?: readonly CheckCoverage[];
  /** Immutable fanout evidence is disclosed with the exact published Candidate. */
  readonly fanout?: FanoutReport;
  /** Observed column facts of the published rows; absent on Receipts published before profiling existed. */
  readonly physicalProfile?: PhysicalProfile;
  /** Set on a refresh: the Receipt whose query this one ran again. That Receipt is unchanged. */
  readonly refreshes?: PublicationId;
  /** Published bytes/rows remain in ResultStore and are read only through this Receipt. */
  readonly createdByInvocationId: string;
  readonly requestId: string;
  readonly createdAt: string;
}

/**
 * Facts observed by scanning every stored row of one column. It never decides
 * scale, unit or additivity; those belong to Dataset Annotations (ADR-0008).
 */
export interface ColumnProfile {
  readonly name: string;
  readonly kind: "integer" | "decimal" | "text" | "boolean" | "json" | "null" | "mixed";
  /** Wire encoding of a numeric column, when every value shares one; DECIMAL text is "string". */
  readonly encodedAs?: "number" | "bigint" | "string";
  readonly nullCount: number;
  /** Exact number of distinct non-null values, omitted once it exceeds the counting limit. */
  readonly distinctCount?: number;
  /** Numeric columns only, as plain decimal text so no precision is lost. */
  readonly min?: string;
  readonly max?: string;
}

export interface PhysicalProfile {
  readonly version: 1;
  readonly rowCount: number;
  /** When true, the profile describes only the stored rows, not the full query result. */
  readonly truncated: boolean;
  readonly columns: readonly ColumnProfile[];
}

export interface AnswerTaskView {
  readonly task: QueryTaskRecord;
  readonly currentRevision: AnswerRevisionRecord;
  /** Required fields without a state. */
  readonly undeclared: readonly SpecPath[];
  /** Open fields whose alternatives are not shown equivalent. */
  readonly open: readonly SpecPath[];
  readonly attempts: readonly QueryAttemptRecord[];
  readonly candidate?: ResultCandidateRecord;
  readonly publication?: PublicationReceipt;
}

export interface AdviceView {
  readonly recommendation: "alternative" | "insufficient_evidence" | "multiple_plausible" | "none_supported" | "unavailable";
  readonly probabilities: readonly { readonly alternativeId: string; readonly probability: number }[];
  readonly lean?: { readonly alternativeId: string; readonly probability: number };
}

/** identical: every alternative produced the same output; distinct: at least two differ; incomplete: some output unknown. */
export type ProbeOutputs = "identical" | "distinct" | "incomplete";

export interface ProbeView {
  readonly alternativeId: AlternativeId;
  /** stale: the latest probe ran while other fields held different states. */
  readonly state: "missing" | "available" | "unavailable" | "waived" | "stale";
  readonly rowCount?: number;
  /** Short fingerprint prefix; equal prefixes mean equal outputs. */
  readonly output?: string;
  readonly reason?: string;
}

/**
 * request / evidence: settled by a verified request quote or other qualifying
 * evidence; assumed: disclosed; open: alternatives await a decision;
 * equivalent: every alternative produced the same output; decided: an open
 * field decided, verified or not.
 */
export type FieldStatus = "not_applicable" | "request" | "evidence" | "assumed" | "open" | "equivalent" | "decided";

export interface FieldView {
  readonly path: SpecPath;
  readonly status: FieldStatus;
  readonly value?: FieldValue;
  /** decided: whether qualifying evidence settled the decision. */
  readonly verified?: boolean;
  readonly rationale?: string;
  readonly evidenceIds?: readonly EvidenceId[];
  readonly alternatives?: readonly { readonly id: AlternativeId; readonly value: FieldValue; readonly probe?: ProbeView }[];
  readonly outputs?: ProbeOutputs;
  /** Advice the Runtime recorded for this field's alternatives and probe outputs; advisory only. */
  readonly advice?: AdviceView;
  readonly adviceOverride?: AdviceOverride;
  /** decided: the advisor failed and the field was decided without its advice. */
  readonly adviceUnavailable?: string;
  /** decided: the advisor favoured no alternative and the field was decided without the user. */
  readonly adviceUndecided?: string;
  readonly inherited?: ParentBinding;
}

export interface FieldOutcome {
  readonly path: string;
  readonly status: "applied" | "rejected";
  readonly code?: string;
  readonly message?: string;
}

export interface AnswerRevisionView {
  readonly taskId: TaskId;
  readonly revisionId: RevisionId;
  readonly parentRevisionId?: RevisionId;
  readonly fields: readonly FieldView[];
  /** Required fields without a state; they block the result query. */
  readonly undeclared: readonly SpecPath[];
  /** Open fields not shown equivalent; they block the result query. */
  readonly open: readonly SpecPath[];
  /** Fields disclosed at publication: assumed values and unverified decisions. */
  readonly unverified: readonly SpecPath[];
  readonly entityIdentity?: EntityIdentityReport;
  readonly calendarCoverage?: CalendarCoverageReport;
  /** Per-path outcome of the set call, in call order. */
  readonly outcomes?: readonly FieldOutcome[];
  readonly role?: "report";
  /** For a chart query: its Report Task, the bound parent Revision and whether that is still current. */
  readonly parent?: ParentBinding & { readonly current: boolean };
  readonly deviations?: readonly Deviation[];
  /** The Report Task measure definition a chart query's measure is taken from. */
  readonly measureRef?: string;
  /** For a Report Task: its chart queries still bound to an earlier Revision, which must rebind before querying. */
  readonly staleChartQueries?: readonly TaskId[];
}

export interface QueryExecutionView {
  readonly kind: "exploration" | "result";
  readonly artifact: QueryArtifact;
  readonly preview: BoundedResult;
  readonly findings: readonly Finding[];
  readonly coverage?: readonly CheckCoverage[];
  readonly fanout?: FanoutReport;
  readonly attemptId?: string;
  /** Set when the exploration ran as the probe of an open field's alternative. */
  readonly probe?: ProbeView & { readonly path: SpecPath; readonly advice?: AdviceView };
}

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
  const normalized = sql.trim().replace(/;+$|\s+/g, (match) => match.includes(";") ? "" : " ").trim();
  if (!normalized || normalized.includes(";")) return false;
  return /^(?:select|with|explain|show|describe|pragma)\b/i.test(normalized)
    && !/\b(?:insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|vacuum)\b/i.test(normalized);
}

/**
 * Conservative preflight for the delegated path. This is not a database
 * security boundary; the injected scoped executor must still enforce a
 * read-only connection and relation policy.
 */
export function isScopedReadOnlySql(sql: string): boolean {
  if (!isReadOnlySql(sql)) return false;
  const normalized = sql.trim();
  if (!/^(?:select|with)\b/i.test(normalized)) return false;
  return !/\b(?:insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|copy|attach|detach|vacuum|load_file|pg_read_file|pg_ls_dir|dblink|pg_sleep|set_config|lo_import|lo_export|benchmark|sleep|sys_exec|into\s+(?:out|dump)file)\b/i.test(normalized);
}

export function normalizeLimit(limit: number | undefined, fallback = 50, maximum = 10_000): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("INVALID_QUERY_LIMIT");
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
