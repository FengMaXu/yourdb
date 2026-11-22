/** Stored domain records: tasks, revisions, fields, evidence, attempts, candidates and receipts. */
import type { FieldValue, SpecPath } from "./fields.js";
import type { EntityIdentityReport } from "./entity-identity.js";
import type { CalendarCoverageReport } from "./calendar-coverage.js";
import type { ProbeSample } from "./probe-diff.js";
import type { FieldAdvisory } from "./advice.js";
import type { TaskId, RevisionId, ReadyRevisionId, EvidenceId, AlternativeId, CandidateId, PrivateResultRef, PublicationId, NonEmpty } from "./ids.js";

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
  /** probeContext of the other fields when the probe ran; a probe without one is stale. */
  readonly context?: string;
  readonly rowCount: number;
  /** A bounded normalized sample of the output, for witness rows (plan T4.1). */
  readonly sample?: ProbeSample;
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
  readonly kind: "shape_conflict" | "result_incomplete" | "integrity_conflict" | "join_fanout" | "realization_conflict" | "entity_identity" | "calendar_coverage" | "result_domain" | "data_falsification" | "physical_candidates";
  readonly message: string;
  readonly blocking: boolean;
  readonly checkId?: string;
  /** Spec fields the finding concerns, when a check knows them. */
  readonly paths?: readonly SpecPath[];
  /** calendar_coverage: the periods with no data. */
  readonly periods?: readonly string[];
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

export type DisclosureItemKind =
  | "assumed" | "decided" | "unadvised" | "undecided" | "deviation" | "parent_superseded"
  | "join_fanout" | "join_fanout_unknown" | "realization_conflict" | "entity_identity" | "calendar_coverage" | "result_domain" | "data_falsification" | "physical_candidates";

/**
 * One disclosure, structured so a reader can show it beside the Spec field it concerns.
 * `detail` is the check's own wording (model-facing); a UI writes its own text from kind and paths.
 */
export interface DisclosureItem {
  readonly kind: DisclosureItemKind;
  /** Spec fields concerned; empty when it concerns the answer as a whole. */
  readonly paths: readonly string[];
  readonly detail?: string;
  /** calendar_coverage: the periods with no data. */
  readonly periods?: readonly string[];
}

export interface PublicationDisclosure {
  readonly required: true;
  /** Fields whose value no qualifying evidence settles (ADR-0006). */
  readonly unverifiedFields: readonly UnverifiedField[];
  /** One line for the model and text-only channels. */
  readonly summary: string;
  readonly items: readonly DisclosureItem[];
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
  /** Observed column facts of the published rows, when the Receipt records them. */
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
