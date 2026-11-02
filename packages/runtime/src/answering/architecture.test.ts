import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { ANSWERING_QUERY_PARAMETERS, SET_ANSWER_SPEC_PARAMETERS, createAnsweringAgentToolDefinitions } from "../tools/answering.js";
import { parseFieldWrite } from "./field-transition.js";
import { ALWAYS_REQUIRED } from "./fields.js";
import { InMemoryAnsweringStore, type AnsweringStore, type AnsweringTransaction } from "./answering-store.js";
import { InMemoryAnswering } from "./service.js";
import { InMemoryResultStore } from "./result-store.js";
import type { BusinessContext } from "./model.js";

const context = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId,
});

class GateEncodingResultStore extends InMemoryResultStore {
  started!: () => void;
  release!: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve; });
  private readonly releasePromise = new Promise<void>((resolve) => { this.release = resolve; });
  waitUntilStarted(): Promise<void> { return this.startedPromise; }
  override async encodeCsv(ref: Parameters<InMemoryResultStore["encodeCsv"]>[0], context: BusinessContext) {
    this.started();
    await this.releasePromise;
    return super.encodeCsv(ref, context);
  }
}

class FailOnceAtReceiptCommit implements AnsweringStore {
  private failed = false;
  constructor(private delegate: InMemoryAnsweringStore, private readonly responseLost: boolean) {}

  async transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T> {
    let wroteReceipt = false;
    const before = this.delegate.snapshot();
    const answer = await this.delegate.transact((tx) => command(new Proxy(tx, {
      get(target, property, receiver) {
        if (property === "putReceipt") return (...args: Parameters<AnsweringTransaction["putReceipt"]>) => { wroteReceipt = true; return target.putReceipt(...args); };
        return Reflect.get(target, property, receiver);
      },
    })), context);
    if (wroteReceipt && !this.failed) {
      this.failed = true;
      if (!this.responseLost) this.delegate = new InMemoryAnsweringStore(before);
      throw new Error(this.responseLost ? "RECEIPT_RESPONSE_LOST" : "RECEIPT_COMMIT_FAILED");
    }
    return answer;
  }

  inspect(taskId: Parameters<AnsweringStore["inspect"]>[0], context: BusinessContext) { return this.delegate.inspect(taskId, context); }
  list(context: BusinessContext) { return this.delegate.list(context); }
  listReferencedResultRefs(context: BusinessContext) { return this.delegate.listReferencedResultRefs(context); }
}

const scalarSpec = {
  "population.entity": "orders",
  "population.eligibility": "n/a",
  "population.conditions": "n/a",
  "population.time": "n/a",
  "measure.formula": { op: "count", of: "orders" },
  "measure.countGrain": "one row per order",
  grouping: "n/a",
  selection: "n/a",
  output: { rowMode: "scalar", rowCount: 1 },
};

describe("Answering architecture boundaries", () => {
  it("keeps the tool schemas strict where the Runtime does not parse per path", () => {
    expect(Value.Check(SET_ANSWER_SPEC_PARAMETERS, { fields: scalarSpec })).toBe(true);
    expect(Value.Check(SET_ANSWER_SPEC_PARAMETERS, { taskId: "task-1", fields: { grouping: { value: ["team_id"], reason: "per team" } } })).toBe(true);
    // The old seven-facet envelope is not accepted under another name.
    expect(Value.Check(SET_ANSWER_SPEC_PARAMETERS, { spec: scalarSpec })).toBe(false);
    expect(Value.Check(SET_ANSWER_SPEC_PARAMETERS, { fields: scalarSpec, hypotheses: [] })).toBe(false);
    expect(Value.Check(ANSWERING_QUERY_PARAMETERS, { kind: "result", taskId: "task-1", sql: "SELECT 1" })).toBe(false);
    expect(Value.Check(ANSWERING_QUERY_PARAMETERS, { kind: "exploration", taskId: "task-1", revisionId: "revision-1", sql: "SELECT 1" })).toBe(false);
    expect(Value.Check(ANSWERING_QUERY_PARAMETERS, { kind: "result", taskId: "task-1", revisionId: "revision-1", sql: "SELECT 1" })).toBe(true);
    expect(Value.Check(ANSWERING_QUERY_PARAMETERS, { kind: "exploration", taskId: "task-1", sql: "SELECT 1", probe: { path: "grouping", alternativeId: "a" } })).toBe(true);
    expect(Value.Check(ANSWERING_QUERY_PARAMETERS, { kind: "exploration", taskId: "task-1", sql: "SELECT 1", probe: { choiceId: "c", alternativeId: "a" } })).toBe(false);
  });

  it("rejects an unknown path or malformed value on that path alone, naming the fix", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const view = await answering.set({
      requestMessageId: "message-paths",
      requestId: "begin-paths",
      fields: {
        ...scalarSpec,
        metric: "count",
        reason: "the earlier value was a guess",
        measures: { formula: { op: "count", of: "orders" } },
        output: { rowMode: "rows", rowCount: 4 },
        "measure.formula": { op: "average", of: "amount" },
        "selection.ties": "first",
      },
    }, context("begin-paths"));
    const outcome = (path: string) => view.outcomes?.find((item) => item.path === path);
    expect(outcome("metric")).toMatchObject({ status: "rejected", message: expect.stringContaining("unknown field path metric") });
    expect(outcome("reason")).toMatchObject({ status: "rejected", message: expect.stringContaining("reason is not a field path: it goes inside the field") });
    expect(outcome("measures")).toMatchObject({ status: "rejected", message: expect.stringContaining('"measures.<name>"') });
    expect(outcome("output")).toMatchObject({ status: "rejected", message: 'output.rowMode "rows": use one of scalar, top_n, grouped, full, detail' });
    expect(outcome("measure.formula")).toMatchObject({ status: "rejected", message: expect.stringContaining("use one of count, count_distinct, sum") });
    expect(outcome("selection.ties")).toMatchObject({ status: "rejected", message: expect.stringContaining('"strict"') });
    expect(outcome("population.entity")).toMatchObject({ status: "applied" });
    expect(view.undeclared).toEqual(["measure.formula", "output"]);
  });

  it("binds a message citation to the Host's current message and a clarification only by its prefix", () => {
    const cited = parseFieldWrite("population.conditions", { value: ["status = 'paid'"], cite: [{ source: "message", quote: "按最大值" }, { source: "clarification:clar-1", quote: "按最大值" }] }, "message-followup");
    expect(cited.evidence).toEqual([
      { localId: "population.conditions#cite1", kind: "user_confirmation", sourceRef: "message-followup", quote: "按最大值" },
      { localId: "population.conditions#cite2", kind: "user_confirmation", sourceRef: "clarification:clar-1", quote: "按最大值" },
    ]);
    // A label the model made up is neither the current message nor a clarification.
    expect(() => parseFieldWrite("population.conditions", { value: ["x"], cite: [{ source: "current request", quote: "按最大值" }] }, "message-followup")).toThrow(/must be knowledge:<id>, schema:<table.column>, clarification:<id> or message/);
    expect(() => parseFieldWrite("population.conditions", { value: ["x"], cite: [{ source: "message", quote: "按最大值" }] })).toThrow(/current user message is not available/);
    // A request quote is checked against the task's own request; the model never names that message.
    expect(parseFieldWrite("population.entity", { value: "orders", basis: "request", quote: "订单数" }).evidence).toEqual([{ localId: "population.entity#request", kind: "request_wording", quote: "订单数" }]);
  });

  it("replaces set_answer_spec with a neutral Query Task bootstrap in semantic-spec ablation mode", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      semanticQualificationMode: "bypassed",
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const definitions = createAnsweringAgentToolDefinitions(answering, undefined, { semanticSpecMode: "disabled" });
    const tools = definitions.map((definition) => definition.tool);
    expect(tools.map((tool) => tool.name)).toContain("begin_query_task");
    expect(tools.map((tool) => tool.name)).not.toContain("set_answer_spec");
    const begin = tools.find((tool) => tool.name === "begin_query_task")!;
    const invocation = (invocationId: string) => ({
      operationId: "operation-ablation",
      invocationId,
      getMemo: async () => undefined,
      setMemo: async () => undefined,
    }) as any;
    const toolContext = { sessionId: "session-1", principalId: "user-1", requestMessageId: "message-ablation" };
    const begun = await begin.execute("begin", {}, undefined, toolContext, invocation("begin-ablation"), {} as never);
    const view = begun.details as { taskId: string; revisionId: string; undeclared: string[] };
    expect(view.undeclared).toEqual(ALWAYS_REQUIRED);
    const duplicate = await begin.execute("begin-again", {}, undefined, toolContext, invocation("begin-ablation-again"), {} as never);
    expect(duplicate.details).toMatchObject({ taskId: view.taskId, revisionId: view.revisionId });
    const query = tools.find((tool) => tool.name === "query_database")!;
    const candidate = await query.execute("result", { kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT 1" } as never, undefined, toolContext, invocation("result-ablation"), {} as never);
    expect((candidate.content[0] as { text: string }).text).toMatch(/^\[RESULT_CANDIDATE\] candidateId=candidate_/);
    const candidateId = (candidate.details as { artifact: { candidateId: string } }).artifact.candidateId;
    const publish = tools.find((tool) => tool.name === "export_query")!;
    const receipt = await publish.execute("publish", { candidateId, format: "csv" }, undefined, toolContext, invocation("publish-ablation"), {} as never);
    expect(receipt.details).toMatchObject({ candidateId, format: "csv" });
  });

  it("places host-generated exploration and candidate handles in model-visible tool text", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const begun = await answering.set({ requestMessageId: "message-handles", requestId: "begin-handles", fields: scalarSpec }, context("begin-handles"));
    const query = createAnsweringAgentToolDefinitions(answering).map((definition) => definition.tool).find((tool) => tool.name === "query_database")!;
    const invocation = (invocationId: string) => ({
      operationId: "operation-handles",
      invocationId,
      getMemo: async () => undefined,
      setMemo: async () => undefined,
    }) as any;
    const toolContext = { sessionId: "session-1", principalId: "user-1" };

    const exploration = await query.execute("explore", { kind: "exploration", taskId: begun.taskId, sql: "SELECT 1" } as never, undefined, toolContext, invocation("explore-handles"), {} as never);
    expect((exploration.content[0] as { text: string }).text).toMatch(/^\[EXPLORATION_EVIDENCE\] evidenceId=evidence_/);
    expect((exploration.content[0] as { text: string }).text).toContain("do not resubmit the observation body");

    const candidate = await query.execute("result", { kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" } as never, undefined, toolContext, invocation("result-handles"), {} as never);
    expect((candidate.content[0] as { text: string }).text).toMatch(/^\[RESULT_CANDIDATE\] candidateId=candidate_/);
  });

  it("executes result SQL once and publishes only the immutable candidate", async () => {
    let calls = 0;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; } },
    });
    const begun = await answering.set({ requestMessageId: "message-1", requestId: "begin-1", fields: scalarSpec }, context("begin-1"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-1"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish-1" }, context("publish-1"));
    const retry = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish-2" }, context("publish-2"));
    expect(calls).toBe(1);
    expect(retry).toEqual(receipt);
    expect(receipt.revisionId).toBe(execution.artifact.revisionId);
    expect(receipt.resultRef).toBe(execution.artifact.resultRef);
    expect(receipt.contentHash).toBeTruthy();
    expect(receipt.policyVersion).toBe("answering-publication-v1");
  });

  it("marks a Candidate corrupt when its private object disappears, including Receipt retry", async () => {
    const resultStore = new InMemoryResultStore();
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore,
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const begun = await answering.set({ requestMessageId: "message-integrity", requestId: "begin-integrity", fields: scalarSpec }, context("begin-integrity"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-integrity"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
    await resultStore.discard(execution.artifact.resultRef, context("discard-integrity"));
    await expect(answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-integrity" }, context("publish-integrity"))).rejects.toMatchObject({ code: "RESULT_INTEGRITY_MISMATCH" });
    await expect(answering.inspect({ taskId: begun.taskId }, context("inspect-integrity"))).resolves.toMatchObject({ candidate: { status: "corrupt", publishable: false } });
  });

  it("does not return a committed Receipt when its ResultStore object is later lost", async () => {
    const resultStore = new InMemoryResultStore();
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore,
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const begun = await answering.set({ requestMessageId: "message-receipt-loss", requestId: "begin-receipt-loss", fields: scalarSpec }, context("begin-receipt-loss"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-receipt-loss"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-loss" }, context("publish-receipt-loss"));
    await resultStore.discard(execution.artifact.resultRef, context("discard-receipt-loss"));
    await expect(answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-retry" }, context("publish-receipt-retry"))).rejects.toMatchObject({ code: "RESULT_INTEGRITY_MISMATCH" });
    expect(receipt.resultRef).toBe(execution.artifact.resultRef);
  });

  it("rejects publication when the current Revision changes during encoding", async () => {
    const resultStore = new GateEncodingResultStore();
    let calls = 0;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore,
      sqlExecutor: { run: async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; } },
    });
    const begun = await answering.set({ requestMessageId: "message-publish-race", requestId: "begin-publish-race", fields: scalarSpec }, context("begin-publish-race"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-publish-race"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected candidate");
    const publishing = answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-race" }, context("publish-race"));
    await resultStore.waitUntilStarted();
    await answering.set({ taskId: begun.taskId, requestId: "revise-during-publish", fields: { grouping: { value: ["region"], reason: "per region" } } }, context("revise-during-publish"));
    resultStore.release();
    await expect(publishing).rejects.toMatchObject({ code: "PUBLICATION_STALE" });
    await expect(answering.inspect({ taskId: begun.taskId }, context("inspect-publish-race"))).resolves.not.toHaveProperty("publication");
    expect(calls).toBe(1);
  });

  it("keeps publication invisible before Receipt commit and recovers after retry", async () => {
    const store = new FailOnceAtReceiptCommit(new InMemoryAnsweringStore(), false);
    let calls = 0;
    const answering = new InMemoryAnswering({
      store,
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; } },
    });
    const begun = await answering.set({ requestMessageId: "message-receipt-fail", requestId: "begin-receipt-fail", fields: scalarSpec }, context("begin-receipt-fail"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-receipt-fail"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected candidate");
    await expect(answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-fail" }, context("publish-receipt-fail"))).rejects.toThrow("RECEIPT_COMMIT_FAILED");
    await expect(answering.inspect({ taskId: begun.taskId }, context("inspect-before-retry"))).resolves.not.toHaveProperty("publication");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-fail" }, context("publish-receipt-retry"));
    expect(receipt.candidateId).toBe(execution.artifact.candidateId);
    expect(calls).toBe(1);
  });

  it("finds the same Receipt when commit succeeded but its response was lost", async () => {
    const store = new FailOnceAtReceiptCommit(new InMemoryAnsweringStore(), true);
    let calls = 0;
    const answering = new InMemoryAnswering({
      store,
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => { calls += 1; return { columns: ["value"], rows: [[1]], truncated: false }; } },
    });
    const begun = await answering.set({ requestMessageId: "message-receipt-lost", requestId: "begin-receipt-lost", fields: scalarSpec }, context("begin-receipt-lost"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-receipt-lost"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected candidate");
    await expect(answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-lost" }, context("publish-receipt-lost"))).rejects.toThrow("RECEIPT_RESPONSE_LOST");
    const committed = (await answering.inspect({ taskId: begun.taskId }, context("inspect-committed"))).publication;
    const recovered = await answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-receipt-lost" }, context("publish-receipt-retry"));
    expect(recovered).toEqual(committed);
    expect(calls).toBe(1);
  });

  it("records disclosure for an unverified decision without granting reviewer authority", async () => {
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["value"], rows: [[1]], truncated: false }) },
    });
    const opened = await answering.set({
      requestMessageId: "message-2",
      requestId: "begin-2",
      fields: { ...scalarSpec, "population.timeField": { open: ["order_date", "delivered_date"] } },
    }, context("begin-2"));
    const begun = await answering.set({
      taskId: opened.taskId,
      requestId: "decide-2",
      fields: { "population.timeField": { value: "order_date", rationale: "The request counts orders in the month they were placed" } },
    }, context("decide-2"));
    const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT 1" }, context("execute-2"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "inline", requestId: "publish-3" }, context("publish-3"));
    expect(receipt.disclosure?.required).toBe(true);
    expect(receipt.disclosure?.summary).toContain("权威证据");
  });
});
