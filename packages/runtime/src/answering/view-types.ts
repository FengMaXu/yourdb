/** Projections the Answering use cases return to callers. */
import type { FieldValue, SpecPath } from "./fields.js";
import type { EntityIdentityReport } from "./entity-identity.js";
import type { CalendarCoverageReport } from "./calendar-coverage.js";
import type { WitnessRow } from "./probe-diff.js";
import type { TaskId, RevisionId, EvidenceId, AlternativeId, CandidateId } from "./ids.js";
import type { QueryAttemptRecord, CheckCoverage, FanoutReport, AdviceOverride, BoundedResult, QueryArtifact, Finding, QueryTaskRecord, ParentBinding, Deviation, AnswerRevisionRecord, ResultCandidateRecord, PublicationReceipt } from "./records.js";

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
  /** Rows that tell differing alternative outputs apart (at most a few, bounded). */
  readonly witnesses?: readonly WitnessRow[];
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
  /** Set when no write applied: the call returned the current Revision unchanged. */
  readonly unchanged?: true;
  /** An unpublished Result Candidate of the previous Revision that this Revision made unpublishable. */
  readonly supersededCandidateId?: CandidateId;
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
  readonly probe?: ProbeView & { readonly path: SpecPath; readonly advice?: AdviceView; readonly witnesses?: readonly WitnessRow[] };
}
