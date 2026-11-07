import type {
  AnswerRevisionRecord,
  BusinessContext,
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
import { entityIdentityDisclosure } from "./entity-identity.js";
import { calendarCoverageDisclosure } from "./calendar-coverage.js";
import { candidateLifecycle, markCandidateCorrupt } from "./result-execution.js";
import { realizationDisclosure } from "./realization-check.js";
import { buildPhysicalProfile } from "./physical-profile.js";
import type { PrivateResultObject } from "./result-store.js";
import { now } from "./support.js";
import type { AnsweringDeps } from "./deps.js";

const INLINE_ROW_LIMIT = 10;

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
        policyVersion: "answering-publication-v1",
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
  if (format === "inline" && result.rowCount > INLINE_ROW_LIMIT) throw new AnsweringError("INLINE_RESULT_TOO_LARGE", "Inline publication is limited to ten rows");
  // The published artifact is always CSV; format only decides whether the rows are also echoed inline.
  const encoded = await deps.resultStore.encodeCsv(result.resultRef, context);
  const receiptId = makeInternalId("publication") as unknown as PublicationReceipt["receiptId"];
  const receipt: PublicationReceipt = {
    receiptId,
    taskId: permit.taskId,
    principalId: context.principal.id,
    sessionId: context.sessionId,
    candidateId: permit.candidateId,
    revisionId: permit.revisionId,
    resultRef: permit.resultRef,
    format,
    publicRef: `/api/runtime/publications/${receiptId}?session_id=${encodeURIComponent(context.sessionId)}`,
    contentHash: permit.contentHash,
    presentationContentHash: encoded.contentHash,
    ...(preparation.candidate.coverage ? { coverage: preparation.candidate.coverage } : {}),
    ...(preparation.candidate.fanout ? { fanout: preparation.candidate.fanout } : {}),
    ...(preparation.disclosure ? { disclosure: preparation.disclosure } : {}),
    // Profiled from the integrity-checked object; it is not part of either content hash.
    physicalProfile: buildPhysicalProfile(result),
    policyVersion: permit.policyVersion,
    createdByInvocationId: context.invocationId,
    requestId: input.requestId,
    createdAt: now(),
  };
  return (await commitPublication(deps, receipt, context)).receipt;
}
