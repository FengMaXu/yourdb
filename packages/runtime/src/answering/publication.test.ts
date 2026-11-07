import { describe, expect, it } from "vitest";
import { createAnsweringAgentToolDefinitions } from "../tools/answering.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { composeDisclosure } from "./publication.js";
import { InMemoryResultStore } from "./result-store.js";
import { InMemoryAnswering } from "./service.js";
import type { AnswerRevisionRecord, BusinessContext, ResultCandidateRecord } from "./model.js";

const evidenceBasis = { kind: "evidence", evidenceIds: ["evidence_q"] } as const;
const fields = {
  "population.entity": { state: "specified", value: { name: "orders" }, basis: evidenceBasis },
  "measure.formula": { state: "specified", value: { op: "count", of: "orders" }, basis: evidenceBasis },
  grouping: { state: "not_applicable" },
  output: { state: "specified", value: { rowMode: "scalar" }, basis: evidenceBasis },
};
const alternatives = [{ id: "alternative_1", value: "按下单月份" }, { id: "alternative_2", value: "按送达月份" }];

function revision(overrides: Record<string, unknown> = {}): AnswerRevisionRecord {
  return { taskId: "task_1", revisionId: "revision_1", requestId: "r", fields, state: { state: "draft", revisionId: "revision_1" }, createdAt: "t", ...overrides } as unknown as AnswerRevisionRecord;
}

function candidate(overrides: Partial<ResultCandidateRecord> = {}): ResultCandidateRecord {
  return { candidateId: "candidate_1", coverage: [], findings: [], ...overrides } as unknown as ResultCandidateRecord;
}

describe("Publication disclosure", () => {
  it("discloses nothing when every field has evidence and nothing is unverified", () => {
    expect(composeDisclosure(revision(), candidate())).toBeUndefined();
  });

  it("discloses unverified decisions, assumptions and fanout findings together", () => {
    const disclosure = composeDisclosure(
      revision({
        fields: {
          ...fields,
          "measure.formula": { state: "specified", value: { op: "count", of: "orders" }, basis: { kind: "assumed" } },
          "population.timeField": { state: "decided", alternatives, alternativeId: "alternative_1", value: "按下单月份", rationale: "r", basis: { kind: "assumed", rationale: "r" } },
        },
      }),
      candidate({ fanout: { ruleVersion: "answering-fanout-v1", status: "finding", snapshotScope: "result_snapshot", targets: [] } }),
    );
    expect(disclosure).toMatchObject({
      required: true,
      unverifiedFields: [{ path: "measure.formula", kind: "assumed" }, { path: "population.timeField", kind: "decided" }],
      fanoutStatus: "finding",
    });
    expect(disclosure?.summary).toContain("按字面选择");
    expect(disclosure?.summary).toContain("population.timeField");
    expect(disclosure?.summary).toContain("假定，未被合格证据证实：measure.formula");
    expect(disclosure?.summary).toContain("JOIN fanout");
  });

  it("does not disclose a decision that qualifying evidence settled", () => {
    const disclosure = composeDisclosure(
      revision({ fields: { ...fields, "population.timeField": { state: "decided", alternatives, alternativeId: "alternative_2", value: "按送达月份", rationale: "r", basis: evidenceBasis } } }),
      candidate(),
    );
    expect(disclosure).toBeUndefined();
  });
});

const context = (invocationId: string): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const listSpec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "sum", of: "sales" }, grouping: "n/a", selection: "n/a", output: { rowMode: "full" } };

class CountingResultStore extends InMemoryResultStore {
  encodings = 0;

  override async encodeCsv(...args: Parameters<InMemoryResultStore["encodeCsv"]>): ReturnType<InMemoryResultStore["encodeCsv"]> {
    this.encodings += 1;
    return super.encodeCsv(...args);
  }
}

async function publishedAnswering(store = new InMemoryAnsweringStore(), resultStore = new InMemoryResultStore()) {
  const answering = new InMemoryAnswering({
    store,
    resultStore,
    // A leading NULL and DECIMAL text are the cases first-row type inference gets wrong.
    sqlExecutor: { run: async () => ({ columns: ["region", "amount"], rows: [["east", null], ["west", "12.50"], ["north", "-3.25"]], truncated: false }) },
  });
  const begun = await answering.set({ requestMessageId: "message-1", requestId: "begin-1", fields: listSpec }, context("begin-1"));
  const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT region, amount FROM orders" }, context("execute-1"));
  if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
  const candidateHash = (await answering.inspect({ taskId: begun.taskId }, context("inspect-candidate"))).candidate?.contentHash;
  if (!candidateHash) throw new Error("expected a stored Candidate hash");
  return { answering, store, resultStore, taskId: begun.taskId, candidateId: execution.artifact.candidateId, candidateHash };
}

describe("Publication Physical Profile", () => {
  it("replays the durable Receipt without encoding the Candidate again", async () => {
    const resultStore = new CountingResultStore();
    const { answering, candidateId } = await publishedAnswering(new InMemoryAnsweringStore(), resultStore);
    const first = await answering.publish({ candidateId, format: "auto", requestId: "publish-once" }, context("publish-once"));
    const replay = await answering.publish({ candidateId, format: "auto", requestId: "publish-replay" }, context("publish-replay"));
    expect(replay).toEqual(first);
    expect(resultStore.encodings).toBe(1);
  });

  it("rejects an inconsistent persisted Candidate lifecycle without changing its snapshot shape", async () => {
    const first = await publishedAnswering();
    const snapshot = first.store.snapshot();
    const inconsistent = {
      ...snapshot,
      candidates: snapshot.candidates.map((item) => item.candidateId === first.candidateId ? { ...item, status: "ready" as const, publishable: false } : item),
    };
    const reopened = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(inconsistent),
      resultStore: first.resultStore,
      sqlExecutor: { run: async () => { throw new Error("SQL must not re-run"); } },
    });
    await expect(reopened.publish({ candidateId: first.candidateId, format: "auto", requestId: "publish-inconsistent" }, context("publish-inconsistent"))).rejects.toMatchObject({ code: "RESULT_INTEGRITY_MISMATCH" });
  });

  it("attaches a profile of every stored row without changing either content hash", async () => {
    const { answering, resultStore, candidateId, candidateHash } = await publishedAnswering();
    const receipt = await answering.publish({ candidateId, format: "auto", requestId: "publish-1" }, context("publish-1"));
    expect(receipt.physicalProfile).toEqual({
      version: 1,
      rowCount: 3,
      truncated: false,
      columns: [
        { name: "region", kind: "text", nullCount: 0, distinctCount: 3 },
        { name: "amount", kind: "decimal", encodedAs: "string", nullCount: 1, distinctCount: 2, min: "-3.25", max: "12.50" },
      ],
    });
    expect(receipt.contentHash).toBe(candidateHash);
    expect(receipt.presentationContentHash).toBe((await resultStore.encodeCsv(receipt.resultRef, context("encode"))).contentHash);
    await expect(resultStore.openAuthorized(receipt.resultRef, receipt, context("open"))).resolves.toMatchObject({ contentHash: candidateHash });
  });

  it("keeps reading Receipts published before profiling existed", async () => {
    const first = await publishedAnswering();
    const published = await first.answering.publish({ candidateId: first.candidateId, format: "auto", requestId: "publish-legacy" }, context("publish-legacy"));
    const snapshot = first.store.snapshot();
    const legacySnapshot = { ...snapshot, receipts: snapshot.receipts.map(({ physicalProfile: _profile, ...receipt }) => receipt) };
    const reopened = new InMemoryAnswering({ store: new InMemoryAnsweringStore(legacySnapshot), resultStore: first.resultStore, sqlExecutor: { run: async () => { throw new Error("SQL must not re-run"); } } });

    const retried = await reopened.publish({ candidateId: first.candidateId, format: "auto", requestId: "publish-legacy" }, context("publish-legacy-retry"));
    expect(retried.receiptId).toBe(published.receiptId);
    expect(retried.physicalProfile).toBeUndefined();
    const view = await reopened.inspect({ taskId: first.taskId }, context("inspect-legacy"));
    expect(view.publication?.receiptId).toBe(published.receiptId);
    await expect(first.resultStore.openAuthorized(retried.resultRef, retried, context("open-legacy"))).resolves.toMatchObject({ contentHash: published.contentHash });
  });

  it("keeps the profile out of model-visible publish and inspect text", async () => {
    const { answering, taskId, candidateId } = await publishedAnswering();
    const tools = createAnsweringAgentToolDefinitions(answering).map((definition) => definition.tool);
    const invocation = (invocationId: string) => ({ operationId: "operation-1", invocationId, getMemo: async () => undefined, setMemo: async () => undefined }) as never;
    const toolContext = { sessionId: "session-1", principalId: "user-1" };

    const published = await tools.find((tool) => tool.name === "publish_query_result")!.execute("publish", { candidateId, format: "inline" } as never, undefined, toolContext as never, invocation("publish-tool"), {} as never);
    const publishText = (published.content[0] as { text: string }).text;
    expect(publishText).toMatch(/^\[PUBLISHED\] inline \[download\]\(/);
    expect(publishText).not.toContain("physicalProfile");

    const inspected = await tools.find((tool) => tool.name === "inspect_answer")!.execute("inspect", { taskId } as never, undefined, toolContext as never, invocation("inspect-tool"), {} as never);
    const inspectText = (inspected.content[0] as { text: string }).text;
    expect(inspectText).toContain(`"receiptId"`);
    expect(inspectText).not.toContain("physicalProfile");
    expect((inspected.details as { publication?: { physicalProfile?: unknown } }).publication?.physicalProfile).toBeDefined();
  });
});
