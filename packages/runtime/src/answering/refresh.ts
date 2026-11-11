import type { BusinessContext, ParentSupersession, PublicationId, PublicationReceipt, RefreshPublication, ResultCandidateRecord } from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { candidateCheckFailure, evaluateCandidateCheckReport } from "./candidate-checks.js";
import { evaluateFanout, fanoutCoverage, fanoutFindings } from "./fanout-execution.js";
import { composeDisclosure } from "./publication.js";
import { buildPhysicalProfile } from "./physical-profile.js";
import { boundedResult } from "./sql-execution.js";
import { now } from "./support.js";
import type { AnsweringDeps } from "./deps.js";

/**
 * Refresh a publication (ADR-0010): run the same result query of the same
 * sealed Revision again, apply the same CandidateChecks and fanout check,
 * and publish the new rows as a new Receipt that names the one it refreshes.
 * The Answer Spec, the SQL and the original Receipt never change, and no SQL
 * or parameter comes from the caller. A refresh is a user action on delivered
 * data, so it is not charged to the task's authoring budget.
 */
export async function refreshPublication(deps: AnsweringDeps, input: RefreshPublication, context: BusinessContext): Promise<PublicationReceipt> {
  const loaded = await deps.store.transact((tx) => {
    const original = tx.getReceipt(input.receiptId as PublicationId);
    if (!original) throw new AnsweringError("PUBLICATION_NOT_FOUND", `Publication ${input.receiptId} was not found`);
    const task = tx.getTask(original.taskId);
    assertTaskAccess(task, context);
    // Idempotent per request: a retried refresh returns the Receipt it already made.
    const existing = tx.findReceiptByRequest(original.taskId, input.requestId);
    if (existing && existing.refreshes === original.receiptId) return { existing } as const;
    if (existing) throw new AnsweringError("INVALID_REQUEST", "REFRESH_REQUEST_ID_CONFLICT");
    const candidate = tx.getCandidate(original.candidateId);
    const revision = tx.getRevision(original.revisionId);
    if (!candidate || !revision) throw new AnsweringError("PUBLICATION_NOT_FOUND", "The refreshed publication no longer has its query");
    // ADR-0009: a refresh keeps the chart query's Revision; say so when its Report Task has moved on.
    const binding = revision.parentBinding;
    const parentRevisionId = binding ? tx.getTask(binding.taskId)?.currentRevisionId : undefined;
    const parentSuperseded: ParentSupersession | undefined = binding && parentRevisionId && parentRevisionId !== binding.revisionId
      ? { taskId: binding.taskId, boundRevisionId: binding.revisionId, currentRevisionId: parentRevisionId }
      : undefined;
    return { original, task, candidate, revision, parentSuperseded } as const;
  }, context);
  if ("existing" in loaded) return loaded.existing!;
  const { original, candidate, revision, parentSuperseded } = loaded;

  const result = boundedResult(await deps.sqlExecutor.run(candidate.sql, deps.maxResultRows, {
    kind: "result",
    idempotencyKey: `refresh:${original.receiptId}:${input.requestId}`,
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
  }));
  if (result.truncated) throw new AnsweringError("RESULT_INCOMPLETE", "The refreshed result exceeds the row limit and cannot be published");
  const privateResult = await deps.resultStore.createPrivate(result, context);
  const checkReport = evaluateCandidateCheckReport({ fields: revision.fields, result: privateResult, queryHash: candidate.queryHash });
  const failure = candidateCheckFailure(checkReport.findings);
  if (failure) {
    await deps.resultStore.discard(privateResult.resultRef, context);
    throw new AnsweringError("CANDIDATE_CHECK_FAILED", `The refreshed result failed an online CandidateCheck: ${failure.message}`);
  }
  const fanout = await evaluateFanout(deps, candidate.taskId, candidate.revisionId, candidate.queryHash, candidate.sql, context);
  const refreshed: ResultCandidateRecord = {
    candidateId: makeInternalId("candidate") as unknown as ResultCandidateRecord["candidateId"],
    taskId: candidate.taskId,
    revisionId: candidate.revisionId,
    resultRef: privateResult.resultRef,
    resultSchema: [...privateResult.columns],
    rowCount: privateResult.rowCount,
    contentHash: privateResult.contentHash,
    sql: candidate.sql,
    queryHash: candidate.queryHash,
    findings: [...checkReport.findings, ...fanoutFindings(fanout)],
    coverage: [...checkReport.coverage, fanoutCoverage(fanout)],
    fanout,
    createdByInvocationId: context.invocationId,
    createdAt: now(),
    status: "ready",
    publishable: true,
  };
  const disclosure = composeDisclosure(revision, refreshed, parentSuperseded);
  const encoded = await deps.resultStore.encodeCsv(privateResult.resultRef, context);
  const receiptId = makeInternalId("publication") as unknown as PublicationReceipt["receiptId"];
  const receipt: PublicationReceipt = {
    receiptId,
    taskId: refreshed.taskId,
    principalId: context.principal.id,
    sessionId: context.sessionId,
    candidateId: refreshed.candidateId,
    revisionId: refreshed.revisionId,
    resultRef: refreshed.resultRef,
    format: original.format === "inline" && privateResult.rowCount > 10 ? "csv" : original.format,
    publicRef: `/api/runtime/publications/${receiptId}?session_id=${encodeURIComponent(context.sessionId)}`,
    contentHash: refreshed.contentHash,
    presentationContentHash: encoded.contentHash,
    ...(refreshed.coverage ? { coverage: refreshed.coverage } : {}),
    fanout,
    ...(disclosure ? { disclosure } : {}),
    physicalProfile: buildPhysicalProfile(privateResult),
    refreshes: original.receiptId,
    policyVersion: "answering-publication-v1",
    createdByInvocationId: context.invocationId,
    requestId: input.requestId,
    createdAt: refreshed.createdAt,
  };
  return deps.store.transact((tx) => {
    const task = tx.getTask(receipt.taskId);
    assertTaskAccess(task, context);
    const existing = tx.findReceiptByRequest(receipt.taskId, receipt.requestId);
    if (existing) return existing;
    tx.putCandidate(refreshed);
    tx.putReceipt(receipt);
    return receipt;
  }, context);
}
