import type { BusinessContext, ParentSupersession, PublicationId, PublicationReceipt, RefreshPublication, ResultCandidateRecord } from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { candidateCheckFailure, evaluateCandidateCheckReport } from "./candidate-checks.js";
import { evaluateFanout, fanoutCoverage, fanoutFindings } from "./fanout-execution.js";
import { buildReceipt, composeDisclosure, INLINE_ROW_LIMIT, ROW_INDEPENDENT_CHECK_IDS } from "./publication.js";
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
  let committed = false;
  try {
    const checkReport = evaluateCandidateCheckReport({ fields: revision.fields, result: privateResult, queryHash: candidate.queryHash });
    const failure = candidateCheckFailure(checkReport.findings);
    if (failure) throw new AnsweringError("CANDIDATE_CHECK_FAILED", `The refreshed result failed an online CandidateCheck: ${failure.message}`);
    const fanout = await evaluateFanout(deps, candidate.taskId, candidate.revisionId, candidate.queryHash, candidate.sql, context);
    // Spec realization, entity identity and calendar coverage read the sealed fields, the SQL and the
    // Revision's data checks, none of which a refresh changes: carry the original's verdicts unchanged.
    const carried = (candidate.findings ?? []).filter((item) => item.checkId !== undefined && ROW_INDEPENDENT_CHECK_IDS.has(item.checkId) && !item.blocking);
    const carriedCoverage = (candidate.coverage ?? []).filter((item) => ROW_INDEPENDENT_CHECK_IDS.has(item.checkId));
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
      findings: [...checkReport.findings, ...carried, ...fanoutFindings(fanout)],
      coverage: [...checkReport.coverage, ...carriedCoverage, fanoutCoverage(fanout)],
      fanout,
      createdByInvocationId: context.invocationId,
      createdAt: now(),
      status: "ready",
      publishable: true,
    };
    const disclosure = composeDisclosure(revision, refreshed, parentSuperseded);
    const encoded = await deps.resultStore.encodeCsv(privateResult.resultRef, context);
    const format = original.format === "inline" && privateResult.rowCount > INLINE_ROW_LIMIT ? "csv" : original.format;
    const receipt = buildReceipt({ candidate: refreshed, result: privateResult, format, presentationContentHash: encoded.contentHash, ...(disclosure ? { disclosure } : {}), refreshes: original.receiptId, requestId: input.requestId }, context);
    const stored = await deps.store.transact((tx) => {
      const task = tx.getTask(receipt.taskId);
      assertTaskAccess(task, context);
      const existing = tx.findReceiptByRequest(receipt.taskId, receipt.requestId);
      if (existing) return existing;
      tx.putCandidate(refreshed);
      tx.putReceipt(receipt);
      return receipt;
    }, context);
    committed = stored.receiptId === receipt.receiptId;
    return stored;
  } finally {
    // A failed check, a lost race to an equal request, or any error leaves the new object unreferenced.
    if (!committed) await deps.resultStore.discard(privateResult.resultRef, context).catch(() => undefined);
  }
}
