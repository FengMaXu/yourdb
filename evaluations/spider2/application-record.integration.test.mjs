import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { DataAgentSessionApplication, WorkspaceStore } from "@data-agent/runtime/testing";
import { buildEvaluationReport } from "./evaluation.mjs";
import { AttemptRecorder, publicationFromReceipt } from "./record.mjs";

const profile = { provider: "openai", model: "test-model", apiKey: "test" };
const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };
const invocation = (id) => ({ invocationId: id, operationId: "operation-1", turnId: "turn-1", getMemo: async () => undefined, setMemo: async () => undefined });

 test("production Application receipt crosses EpisodeRecord into the report without rerunning SQL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spider-application-record-"));
  const application = new DataAgentSessionApplication({
    workspace: new WorkspaceStore(path.join(root, "workspace")),
    resultRoot: path.join(root, "results"),
    profile,
    systemPrompt: "You are Data Agent.",
    queryExecutor: { run: async () => ({ columns: ["count"], rows: [[1]], truncated: false }) },
    createMissingSessions: true,
  });
  try {
    const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
    const context = { sessionId: "session-1", principalId: "user-1", requestMessageId: "request-1" };
    const update = host.tools.find((tool) => tool.name === "set_answer_spec");
    const query = host.tools.find((tool) => tool.name === "query_database");
    const publish = host.tools.find((tool) => tool.name === "export_query");
    assert.ok(update && query && publish);
    const began = await update.execute("begin", { fields: spec }, undefined, context, invocation("begin"), TODO_CONTEXT);
    const executed = await query.execute("result", { kind: "result", taskId: began.details.taskId, revisionId: began.details.revisionId, sql: "SELECT COUNT(*) FROM orders" }, undefined, context, invocation("result"), TODO_CONTEXT);
    const receipt = await publish.execute("publish", { candidateId: executed.details.artifact.candidateId, format: "csv" }, undefined, context, invocation("publish"), TODO_CONTEXT);
    const adapter = application.createAgentAdapter({ userId: "user-1", host: "web", sessionId: "session-1" });
    const authorizedSql = await adapter.readPublicationSql(receipt.details.receiptId);
    const authorizedCsv = await adapter.readPublication(receipt.details.receiptId);
    assert.equal(authorizedSql.candidateId, executed.details.artifact.candidateId);
    assert.match(authorizedSql.sql, /SELECT COUNT/);
    assert.match(authorizedCsv.content, /count/);

    const recorder = new AttemptRecorder(path.join(root, "record"), { runId: "run-1", caseId: "case-1", attemptId: "attempt-1", traceId: "trace-1" });
    await recorder.recordEvent({ type: "run_start", runId: "operation-1", occurredAt: 1 });
    await recorder.recordEvent({ type: "run_end", runId: "operation-1", status: "completed", occurredAt: 2 });
    const sealed = await recorder.seal({ publication: publicationFromReceipt(receipt.details), coverage: { state: "complete" } });
    const report = buildEvaluationReport([sealed.episode], { "case-1": 1 }, { denominatorIds: ["case-1"] });
    assert.equal(sealed.episode.publication.state, "published");
    assert.equal(report.metrics.dimensions.publication.published, 1);
    assert.equal(report.metrics.dimensions.correctness.correct, 1);
    assert.equal(report.metrics.latency.averageMs, 1);
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
