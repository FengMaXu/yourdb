import type { AlternativeId, CandidateId, DraftRevision, EvidenceId, FieldBasis, QueryArtifact, ReadyRevision, RevisionId, TaskId } from "./model.js";

declare const taskId: TaskId;
declare const revisionId: RevisionId;
declare const evidenceId: EvidenceId;
declare const candidateId: CandidateId;
declare const alternativeId: AlternativeId;
declare const plainString: string;
declare const draftRevision: DraftRevision;
declare const observationArtifact: Extract<QueryArtifact, { kind: "exploration" }>;
declare function needsReadyRevision(revision: ReadyRevision): void;
declare function publishCandidate(candidate: Extract<QueryArtifact, { kind: "candidate" }>): void;

// @ts-expect-error Ordinary strings cannot become trusted branded IDs.
const badFromString: TaskId = plainString;
// @ts-expect-error Branded business identities must not be interchangeable.
const badRevision: RevisionId = taskId;
// @ts-expect-error Branded evidence identity must not be used as a candidate.
const badCandidate: CandidateId = evidenceId;
// @ts-expect-error Branded alternative identity must not be used as a task.
const badTask: TaskId = alternativeId;
// @ts-expect-error Branded revision identity must not be used as evidence.
const badEvidence: EvidenceId = revisionId;
// @ts-expect-error Branded candidate identity must not be used as an alternative.
const badAlternative: AlternativeId = candidateId;

// @ts-expect-error A Draft Revision cannot cross the result execution seam.
needsReadyRevision(draftRevision);
// @ts-expect-error Exploration artifacts cannot cross the publication seam.
publishCandidate(observationArtifact);

// @ts-expect-error An evidence basis requires at least one evidence id.
const emptyEvidenceBasis: FieldBasis = { kind: "evidence", evidenceIds: [] };

void [badFromString, badRevision, badCandidate, badTask, badEvidence, badAlternative, emptyEvidenceBasis];

import type { SpecFields } from "./model.js";
import type { OutputValue, SelectionValue } from "./fields.js";
import type { settledField } from "./support.js";
declare const fields: SpecFields;
declare const read: typeof settledField;

// settledField returns the exact value type of its path.
const goodOutput: OutputValue | undefined = read(fields, "output");
// @ts-expect-error The output path does not hold a selection value.
const badSelection: SelectionValue | undefined = read(fields, "output");
// @ts-expect-error A path that is not a field path is refused at compile time.
read(fields, "measure.nope");
// @ts-expect-error A sentence field is a string, not a structured value.
const badSentence: OutputValue | undefined = read(fields, "population.eligibility");
void goodOutput; void badSelection; void badSentence;
