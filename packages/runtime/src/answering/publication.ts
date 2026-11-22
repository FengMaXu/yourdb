import type {
  AnswerRevisionRecord,
  BusinessContext,
  DisclosureItem,
  FieldRecord,
  ParentSupersession,
  PublicationDisclosure,
  PublicationPermit,
  PublicationReceipt,
  PublishCandidate,
  ResultCandidateRecord,
} from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { unverifiedFields } from "./qualification.js";
import { assertDeliverable } from "./report.js";
import { fanoutDisclosureSummary } from "./fanout-execution.js";
import { ENTITY_IDENTITY_CHECK_ID, entityIdentityDisclosure } from "./entity-identity.js";
import { CALENDAR_COVERAGE_CHECK_ID, calendarCoverageDisclosure } from "./calendar-coverage.js";
import { candidateLifecycle, markCandidateCorrupt } from "./result-execution.js";
import { realizationDisclosure, SPEC_REALIZATION_CHECK_ID } from "./realization-check.js";
import { buildPhysicalProfile } from "./physical-profile.js";
import type { PrivateResultObject } from "./result-store.js";
import { now } from "./support.js";
import type { AnsweringDeps } from "./deps.js";

/** Rows echoed inline at most; a larger result is delivered as CSV only. */
export const INLINE_ROW_LIMIT = 10;
export const PUBLICATION_POLICY_VERSION = "answering-publication-v1" as const;

export function publicRefFor(receiptId: string, sessionId: string): string {
  return `/api/runtime/publications/${receiptId}?session_id=${encodeURIComponent(sessionId)}`;
}

/** The checks a Receipt carries from the Revision's data checks and the SQL, not from the rows. */
export const ROW_INDEPENDENT_CHECK_IDS: ReadonlySet<string> = new Set([SPEC_REALIZATION_CHECK_ID, ENTITY_IDENTITY_CHECK_ID, CALENDAR_COVERAGE_CHECK_ID]);

export interface ReceiptParts {
  readonly candidate: ResultCandidateRecord;
  readonly result: PrivateResultObject;
  readonly format: PublicationReceipt["format"];
  readonly presentationContentHash: string;
  readonly disclosure?: PublicationDisclosure;
  readonly refreshes?: PublicationReceipt["refreshes"];
  readonly requestId: string;
}

/** One Receipt shape for publish and refresh: the bound Candidate, its checks, and the rows' physical profile. */
export function buildReceipt(parts: ReceiptParts, context: BusinessContext): PublicationReceipt {
  const { candidate } = parts;
  const receiptId = makeInternalId("publication") as unknown as PublicationReceipt["receiptId"];
  return {
    receiptId,
    taskId: candidate.taskId,
    principalId: context.principal.id,
    sessionId: context.sessionId,
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    resultRef: candidate.resultRef,
    format: parts.format,
    publicRef: publicRefFor(receiptId, context.sessionId),
    contentHash: candidate.contentHash,
    presentationContentHash: parts.presentationContentHash,
    ...(candidate.coverage ? { coverage: candidate.coverage } : {}),
    ...(candidate.fanout ? { fanout: candidate.fanout } : {}),
    ...(parts.disclosure ? { disclosure: parts.disclosure } : {}),
    // Profiled from the integrity-checked object; it is not part of either content hash.
    physicalProfile: buildPhysicalProfile(parts.result),
    ...(parts.refreshes ? { refreshes: parts.refreshes } : {}),
    policyVersion: PUBLICATION_POLICY_VERSION,
    createdByInvocationId: context.invocationId,
    requestId: parts.requestId,
    createdAt: now(),
  };
}

/**
 * Everything a Receipt must disclose about the exact published Candidate:
 * unverified fields, decisions made while the advisor was unavailable,
 * deviations, fanout observations, likely Spec realization conflicts,
 * entity identity counts and calendar coverage.
 * Disclosure is a record, never an approval.
 */
export function composeDisclosure(revision: AnswerRevisionRecord, candidate: ResultCandidateRecord, parentSuperseded?: ParentSupersession): PublicationDisclosure | undefined {
  const unverified = unverifiedFields(revision.fields);
  const assumed = unverified.filter((item) => item.kind === "assumed").map((item) => item.path);
  const decided = unverified.filter((item) => item.kind === "decided").map((item) => item.path);
  const fanoutDisclosure = candidate.fanout && (candidate.fanout.status === "finding" || candidate.fanout.status === "unknown")
    ? fanoutDisclosureSummary(candidate.fanout)
    : "";
  const realization = realizationDisclosure(candidate.findings);
  const identity = entityIdentityDisclosure(candidate.findings);
  const calendar = calendarCoverageDisclosure(candidate.findings);
  const unadvised = (Object.entries(revision.fields) as [string, FieldRecord][])
    .filter(([, field]) => field.state === "decided" && field.adviceUnavailable)
    .map(([path]) => path);
  const undecided = (Object.entries(revision.fields) as [string, FieldRecord][])
    .filter(([, field]) => field.state === "decided" && field.adviceUndecided)
    .map(([path]) => path);
  const deviations = revision.deviations ?? [];
  const findings = candidate.findings ?? [];
  const items: DisclosureItem[] = [
    ...(decided.length > 0 ? [{ kind: "decided" as const, paths: decided }] : []),
    ...(assumed.length > 0 ? [{ kind: "assumed" as const, paths: assumed }] : []),
    ...(unadvised.length > 0 ? [{ kind: "unadvised" as const, paths: unadvised }] : []),
    ...(undecided.length > 0 ? [{ kind: "undecided" as const, paths: undecided }] : []),
    ...deviations.map((item) => ({ kind: "deviation" as const, paths: [item.path], detail: item.reason })),
    ...(parentSuperseded ? [{ kind: "parent_superseded" as const, paths: [] }] : []),
    ...(fanoutDisclosure && candidate.fanout
      ? [candidate.fanout.status === "finding"
        ? { kind: "join_fanout" as const, paths: ["measure.formula"], detail: fanoutDisclosure }
        : { kind: "join_fanout_unknown" as const, paths: ["measure.formula"], detail: candidate.fanout.unsupportedReasons?.length ? candidate.fanout.unsupportedReasons.join(", ") : "coverage unavailable" }]
      : []),
    ...findings.filter((item) => item.kind === "realization_conflict" && !item.blocking)
      .map((item) => ({ kind: "realization_conflict" as const, paths: [...(item.paths ?? [])], detail: item.message })),
    ...findings.filter((item) => item.kind === "entity_identity")
      .map((item) => ({ kind: "entity_identity" as const, paths: [...(item.paths ?? ["population.entity"])], detail: item.message })),
    ...findings.filter((item) => item.kind === "calendar_coverage")
      .map((item) => ({ kind: "calendar_coverage" as const, paths: [...(item.paths ?? ["population.time"])], detail: item.message, ...(item.periods ? { periods: item.periods } : {}) })),
  ];
  if (unverified.length === 0 && unadvised.length === 0 && undecided.length === 0 && deviations.length === 0 && !parentSuperseded && !fanoutDisclosure && !realization && !identity && !calendar) return undefined;
  return {
    required: true,
    unverifiedFields: unverified,
    summary: [
      ...(decided.length > 0 ? [`以下字段在多种解释中按字面选择，未被权威证据唯一确定：${decided.join(", ")}。`] : []),
      ...(assumed.length > 0 ? [`以下字段为假定，未被合格证据证实：${assumed.join(", ")}。`] : []),
      ...(unadvised.length > 0 ? [`以下字段的候选解释结果不同，但比较建议服务不可用，决定未经比较：${unadvised.join(", ")}。`] : []),
      ...(undecided.length > 0 ? [`以下字段的候选解释结果不同，比较也无法区分，且无法询问用户，决定未经裁决：${undecided.join(", ")}。`] : []),
      ...(deviations.length > 0 ? [`以下字段偏离报告任务的共享口径：${deviations.map((item) => `${item.path}（${item.reason}）`).join("；")}。`] : []),
      ...(parentSuperseded ? ["本次只刷新了数据；这张图所依据的报告任务口径已被修改，图仍按修改前的口径计算。"] : []),
      ...(fanoutDisclosure ? [fanoutDisclosure] : []),
      ...(realization ? [realization] : []),
      ...(identity ? [identity] : []),
      ...(calendar ? [calendar] : []),
    ].join(" "),
    items,
    ...(fanoutDisclosure && candidate.fanout ? { fanoutStatus: candidate.fanout.status } : {}),
    ...(deviations.length > 0 ? { deviations } : {}),
    ...(parentSuperseded ? { parentSuperseded } : {}),
  };
}

type PublicationPreparation =
  | { readonly state: "replay"; readonly candidate: ResultCandidateRecord; readonly receipt: PublicationReceipt }
  | {
      readonly state: "new";
      readonly candidate: ResultCandidateRecord;
      readonly permit: PublicationPermit;
      readonly disclosure?: PublicationDisclosure;
    };

async function preparePublication(deps: AnsweringDeps, input: PublishCandidate, context: BusinessContext): Promise<PublicationPreparation> {
  const candidateId = input.candidateId as unknown as ResultCandidateRecord["candidateId"];
  return deps.store.transact((tx) => {
    const candidate = tx.getCandidate(candidateId);
    if (!candidate) throw new AnsweringError("CANDIDATE_NOT_FOUND", `Candidate ${input.candidateId} was not found`);
    const task = tx.getTask(candidate.taskId);
    assertTaskAccess(task, context);
    if (task.currentRevisionId !== candidate.revisionId) throw new AnsweringError("PUBLICATION_STALE", "Candidate belongs to an old revision");
    if (candidateLifecycle(candidate).state !== "ready") throw new AnsweringError("RESULT_INTEGRITY_MISMATCH", "Corrupt Result Candidate cannot be published");
    const revision = tx.getRevision(candidate.revisionId);
    if (!revision || revision.state.state !== "ready") throw new AnsweringError("PUBLICATION_STALE", "Candidate revision is not sealed for publication");
    const existingForTask = task.publicationId ? tx.getReceipt(task.publicationId) : undefined;
    if (existingForTask && existingForTask.candidateId !== candidate.candidateId) {
      throw new AnsweringError("PUBLICATION_ALREADY_EXISTS", "A Query Task already has a publication receipt for this revision", { receiptId: existingForTask.receiptId, candidateId: existingForTask.candidateId });
    }
    const existing = tx.findReceiptByRequest(candidate.taskId, input.requestId) ?? tx.findReceiptByCandidate(candidate.taskId, candidate.candidateId) ?? existingForTask;
    if (existing) return { state: "replay", candidate, receipt: existing } as const;
    // A replay returns the Receipt already made; only a new publication needs a deliverable Report Task (ADR-0009).
    assertDeliverable(tx, task);
    const disclosure = composeDisclosure(revision, candidate);
    return {
      state: "new",
      candidate,
      permit: {
        candidateId: candidate.candidateId,
        taskId: candidate.taskId,
        revisionId: candidate.revisionId,
        resultRef: candidate.resultRef,
        contentHash: candidate.contentHash,
        policyVersion: PUBLICATION_POLICY_VERSION,
      },
      ...(disclosure ? { disclosure } : {}),
    } as const;
  }, context);
}

async function replayPublication(deps: AnsweringDeps, preparation: Extract<PublicationPreparation, { readonly state: "replay" }>, input: PublishCandidate, context: BusinessContext): Promise<PublicationReceipt> {
  const requestedFormat = input.format === "auto" ? preparation.receipt.format : input.format;
  if (requestedFormat !== preparation.receipt.format) throw new AnsweringError("PUBLICATION_ALREADY_EXISTS", "A different format was already published for this request");
  try {
    await deps.resultStore.openAuthorized(preparation.candidate.resultRef, preparation.receipt, context);
  } catch {
    await markCandidateCorrupt(deps, preparation.candidate, context);
    throw new AnsweringError("RESULT_INTEGRITY_MISMATCH", "Published Receipt references a missing or changed private result");
  }
  return preparation.receipt;
}

type PublicationCommitOutcome =
  | { readonly state: "created"; readonly receipt: PublicationReceipt }
  | { readonly state: "existing"; readonly receipt: PublicationReceipt };

async function commitPublication(deps: AnsweringDeps, receipt: PublicationReceipt, context: BusinessContext): Promise<PublicationCommitOutcome> {
  return deps.store.transact((tx) => {
    const currentTask = tx.getTask(receipt.taskId);
    assertTaskAccess(currentTask, context);
    if (currentTask.currentRevisionId !== receipt.revisionId) throw new AnsweringError("PUBLICATION_STALE", "Revision changed during publication");
    const existing = tx.findReceiptByRequest(receipt.taskId, receipt.requestId) ?? tx.findReceiptByCandidate(receipt.taskId, receipt.candidateId);
    if (existing) return { state: "existing", receipt: existing } as const;
    // The Report Task may have changed while the bytes were encoded.
    assertDeliverable(tx, currentTask);
    tx.putReceipt(receipt);
    tx.putTask({ ...currentTask, publicationId: receipt.receiptId, lifecycle: "published", updatedAt: receipt.createdAt });
    return { state: "created", receipt } as const;
  }, context);
}

/** Publish the exact immutable Candidate of the current sealed Revision; SQL is never re-run. */
export async function publishCandidate(deps: AnsweringDeps, input: PublishCandidate, context: BusinessContext): Promise<PublicationReceipt> {
  const preparation = await preparePublication(deps, input, context);
  if (preparation.state === "replay") return replayPublication(deps, preparation, input, context);
  const { permit } = preparation;
  let result: PrivateResultObject;
  try {
    const opened = await deps.resultStore.openPrivate(permit.resultRef, context);
    if (!opened || opened.contentHash !== permit.contentHash || opened.resultRef !== permit.resultRef) throw new Error("RESULT_INTEGRITY_MISMATCH");
    result = opened;
  } catch {
    await markCandidateCorrupt(deps, preparation.candidate, context);
    throw new AnsweringError("RESULT_INTEGRITY_MISMATCH", "Result Candidate content hash does not match ResultStore");
  }
  const format = input.format === "auto" ? (result.rowCount <= INLINE_ROW_LIMIT ? "inline" : "csv") : input.format;
  if (format === "inline" && result.rowCount > INLINE_ROW_LIMIT) throw new AnsweringError("INLINE_RESULT_TOO_LARGE", `Inline publication is limited to ${INLINE_ROW_LIMIT} rows`);
  // The published artifact is always CSV; format only decides whether the rows are also echoed inline.
  const encoded = await deps.resultStore.encodeCsv(result.resultRef, context);
  const receipt = buildReceipt({ candidate: preparation.candidate, result, format, presentationContentHash: encoded.contentHash, ...(preparation.disclosure ? { disclosure: preparation.disclosure } : {}), requestId: input.requestId }, context);
  return (await commitPublication(deps, receipt, context)).receipt;
}
