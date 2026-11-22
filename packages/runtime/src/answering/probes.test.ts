import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_BUDGET_POLICY,
  InMemoryAnswering,
  InMemoryAnsweringStore,
  InMemoryResultStore,
  type AnsweringStore,
  type BusinessContext,
} from "./public.js";
import { resultFingerprint } from "./result-fingerprint.js";

const context = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId,
});

const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };
const PATH = "population.timeField";
const PURCHASE = "Count each order in the month it was purchased";
const DELIVERED = "Count each order in the month it was delivered";
const RATIONALE = "Delivered orders are counted when the delivery event happens";

type Output = { columns: string[]; rows: unknown[][]; truncated: boolean };

function service(outputs: Record<string, Output>, options: { fieldProbes?: boolean; budgetPolicy?: typeof DEFAULT_QUERY_BUDGET_POLICY } = {}) {
  const calls: { sql: string; limit: number }[] = [];
  const answering = new InMemoryAnswering({
    store: new InMemoryAnsweringStore(),
    resultStore: new InMemoryResultStore(),
    sqlExecutor: {
      run: async (sql, limit) => {
        calls.push({ sql, limit });
        const output = outputs[sql];
        if (!output) throw new Error(`unexpected SQL ${sql}`);
        return output;
      },
    },
    fieldProbes: options.fieldProbes ?? true,
    ...(options.budgetPolicy ? { budgetPolicy: options.budgetPolicy } : {}),
  });
  return { answering, calls };
}

async function begin(answering: InMemoryAnswering) {
  const view = await answering.set({ requestMessageId: "message-1", requestId: "begin-1", fields: { ...spec, [PATH]: { open: [PURCHASE, DELIVERED] } } }, context("begin"));
  const field = view.fields.find((item) => item.path === PATH)!;
  return { view, purchase: field.alternatives![0]!.id, delivered: field.alternatives![1]!.id };
}

function decide(answering: InMemoryAnswering, taskId: string, value: string, id = "decide") {
  return answering.set({ taskId, requestId: id, fields: { [PATH]: { value, rationale: RATIONALE } } }, context(id));
}

function probe(answering: InMemoryAnswering, taskId: string, sql: string, alternativeId: string, id: string) {
  return answering.execute({ kind: "exploration", taskId, sql, probe: { path: PATH, alternativeId } }, context(id));
}

describe("result fingerprint", () => {
  it("ignores column names, column order and row order", () => {
    expect(resultFingerprint(["a", "b"], [[1, "x"], [2, "y"]])).toBe(resultFingerprint(["y", "z"], [["y", 2], ["x", 1]]));
  });

  it("compares numbers at two decimals and numeric text as numbers", () => {
    expect(resultFingerprint(["v"], [[1.004]])).toBe(resultFingerprint(["v"], [[1]]));
    expect(resultFingerprint(["v"], [["205"]])).toBe(resultFingerprint(["v"], [[205]]));
    expect(resultFingerprint(["v"], [[" x "]])).toBe(resultFingerprint(["v"], [["x"]]));
  });

  it("distinguishes different values, row counts and shapes", () => {
    expect(resultFingerprint(["v"], [[205]])).not.toBe(resultFingerprint(["v"], [[265]]));
    expect(resultFingerprint(["v"], [[1]])).not.toBe(resultFingerprint(["v"], [[1], [1]]));
    expect(resultFingerprint(["a", "b"], [[1, 2], [3, 4]])).not.toBe(resultFingerprint(["a", "b"], [[1, 4], [3, 2]]));
    expect(resultFingerprint(["v"], [[null]])).not.toBe(resultFingerprint(["v"], [[""]]));
  });
});

describe("Probes of open fields (ADR-0005)", () => {
  const outputs = {
    "SELECT purchase": { columns: ["n"], rows: [[265]], truncated: false },
    "SELECT delivered": { columns: ["n"], rows: [[205]], truncated: false },
    "SELECT delivered again": { columns: ["total"], rows: [[265.001]], truncated: false },
  };

  it("refuses to decide an open field before every alternative has a probe", async () => {
    const { answering } = service(outputs);
    const { view, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", view.fields.find((item) => item.path === PATH)!.alternatives![0]!.id, "probe-purchase");
    const result = await decide(answering, view.taskId, DELIVERED);
    expect(result.outcomes?.[0]).toMatchObject({ status: "rejected", code: "SPEC_TRANSITION_INVALID", message: expect.stringContaining(`for ${delivered}`) });
    expect(result.revisionId).toBe(view.revisionId);
  });

  it("records probe outputs, shows that they differ and then allows a decision", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    const first = await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    expect(first.probe).toMatchObject({ path: PATH, alternativeId: purchase, state: "available", rowCount: 1 });
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    const decided = await decide(answering, view.taskId, DELIVERED);
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided", value: DELIVERED, verified: false, outputs: "distinct" });
    expect(decided.unverified).toContain(PATH);
  });

  it("treats an open field whose probes all match as equivalent without a decision", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    await probe(answering, view.taskId, "SELECT delivered again", delivered, "probe-delivered");
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.open).toEqual([]);
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT purchase" }, context("result")))
      .resolves.toMatchObject({ artifact: { kind: "candidate" } });
  });

  it("keeps an open field blocking while its probe outputs differ", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.open).toEqual([PATH]);
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT result" }, context("result")))
      .rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { open: [PATH] } });
  });

  it("opens an equivalent field again when another field changes after its probes", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    await probe(answering, view.taskId, "SELECT delivered again", delivered, "probe-delivered");
    expect((await answering.inspect({ taskId: view.taskId }, context("inspect-1"))).open).toEqual([]);

    // The probes ran without a grouping; under a monthly grouping the alternatives may differ.
    const regrouped = await answering.set({ taskId: view.taskId, requestId: "regroup", fields: { grouping: { value: ["month"], reason: "the request asks per month" } } }, context("regroup"));
    expect(regrouped.open).toEqual([PATH]);
    expect(regrouped.fields.find((item) => item.path === PATH)?.alternatives?.map((item) => item.probe?.state)).toEqual(["stale", "stale"]);
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: regrouped.revisionId, sql: "SELECT purchase" }, context("result")))
      .rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { open: [PATH] } });

    await probe(answering, view.taskId, "SELECT purchase", purchase, "reprobe-purchase");
    await probe(answering, view.taskId, "SELECT delivered again", delivered, "reprobe-delivered");
    expect((await answering.inspect({ taskId: view.taskId }, context("inspect-2"))).open).toEqual([]);
  });

  it("refuses a decision on probes taken while other fields held different states", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    await answering.set({ taskId: view.taskId, requestId: "condition", fields: { "population.conditions": { value: ["status = 'delivered'"], reason: "only delivered orders count" } } }, context("condition"));

    const refused = await decide(answering, view.taskId, DELIVERED);
    expect(refused.outcomes?.[0]).toMatchObject({ status: "rejected", code: "SPEC_TRANSITION_INVALID", message: expect.stringContaining("were probed before other fields changed") });

    await probe(answering, view.taskId, "SELECT purchase", purchase, "reprobe-purchase");
    await probe(answering, view.taskId, "SELECT delivered", delivered, "reprobe-delivered");
    const decided = await decide(answering, view.taskId, DELIVERED, "decide-again");
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided", value: DELIVERED });
  });

  it("marks an over-cap probe output unavailable but counts it as probed", async () => {
    const { answering } = service({ ...outputs, "SELECT big": { columns: ["n"], rows: [[1]], truncated: true } });
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT big", purchase, "probe-big");
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    const decided = await decide(answering, view.taskId, DELIVERED);
    const field = decided.fields.find((item) => item.path === PATH)!;
    expect(field).toMatchObject({ status: "decided", outputs: "incomplete" });
    expect(field.alternatives!.map((item) => item.probe?.state)).toEqual(["unavailable", "available"]);
  });

  it("does not charge probes to the exploration budget and shows only a bounded preview", async () => {
    const many = { columns: ["n"], rows: Array.from({ length: 300 }, (_, index) => [index]), truncated: false };
    const { answering } = service({ ...outputs, "SELECT many": many }, { budgetPolicy: { ...DEFAULT_QUERY_BUDGET_POLICY, maxExplorationAttempts: 1 } });
    const { view, purchase, delivered } = await begin(answering);
    const probed = await probe(answering, view.taskId, "SELECT many", purchase, "probe-many");
    expect(probed.preview.rows).toHaveLength(50);
    expect(probed.probe).toMatchObject({ rowCount: 300, state: "available" });
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    await expect(answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase" }, context("explore"))).resolves.toMatchObject({ kind: "exploration" });
  });

  it("lets a waiver stand in for a probe of an alternative that cannot run alone", async () => {
    const { answering } = service(outputs);
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    const short = await answering.set({ taskId: view.taskId, requestId: "waive-short", fields: { [PATH]: { notProbeable: { [purchase]: "cannot" } } } }, context("waive-short"));
    expect(short.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("needs a reason") });
    await answering.set({ taskId: view.taskId, requestId: "waive", fields: { [PATH]: { notProbeable: { [purchase]: "The purchase month cannot be separated from other fields here" } } } }, context("waive"));
    const decided = await decide(answering, view.taskId, DELIVERED);
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided" });
  });

  it("rejects probes of unknown alternatives and probes when tracking is off", async () => {
    const { answering } = service(outputs);
    const { view } = await begin(answering);
    await expect(probe(answering, view.taskId, "SELECT purchase", "alternative_missing", "probe-missing")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase", probe: { path: "grouping", alternativeId: "a" } }, context("probe-closed"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const off = service(outputs, { fieldProbes: false });
    const untracked = await begin(off.answering);
    expect(untracked.view.fields.find((item) => item.path === PATH)!.alternatives![0]).not.toHaveProperty("probe");
    await expect(probe(off.answering, untracked.view.taskId, "SELECT purchase", untracked.purchase, "probe-off")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const decided = await decide(off.answering, untracked.view.taskId, PURCHASE, "decide-off");
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided" });
  });

  it("blocks a result that reproduces the output of an alternative the Revision did not adopt", async () => {
    const { answering } = service({ ...outputs, "SELECT final purchase": { columns: ["orders"], rows: [["265"]], truncated: false }, "SELECT final delivered": { columns: ["orders"], rows: [[205]], truncated: false } });
    const { view, purchase, delivered } = await begin(answering);
    await probe(answering, view.taskId, "SELECT purchase", purchase, "probe-purchase");
    await probe(answering, view.taskId, "SELECT delivered", delivered, "probe-delivered");
    const decided = await decide(answering, view.taskId, DELIVERED);
    const blocked = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: decided.revisionId, sql: "SELECT final purchase" }, context("result-purchase")).catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      code: "DECISION_NOT_REALIZED",
      message: expect.stringContaining(`${PATH} adopted ${delivered}, but the result equals the probe output of ${purchase}`),
      obstacle: { kind: "business_judgment_required", retryable: true },
      details: { conflicts: [{ path: PATH, adoptedAlternativeId: delivered, realizedAlternativeId: purchase }] },
    });
    const accepted = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: decided.revisionId, sql: "SELECT final delivered" }, context("result-delivered"));
    expect(accepted.artifact.kind).toBe("candidate");
  });

  it("refuses a final SQL that cannot implement a sealed field without running it", async () => {
    const top3 = "SELECT city, COUNT(*) FROM orders GROUP BY city ORDER BY 2 DESC LIMIT 3";
    const { answering, calls } = service({ [top3]: { columns: ["city", "orders"], rows: [["a", 3], ["b", 2], ["c", 1]], truncated: false } });
    const fields = { ...spec, grouping: ["city"], selection: { n: 3, orderBy: "orders desc" }, "selection.ties": "strict", output: { rowMode: "top_n", rowCount: 3 } };
    const view = await answering.set({ requestMessageId: "message-1", requestId: "begin-1", fields }, context("begin"));
    const blocked = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: top3.replace("LIMIT 3", "LIMIT 5") }, context("result-wrong")).catch((error: unknown) => error);
    expect(blocked).toMatchObject({
      code: "SPEC_NOT_REALIZED",
      message: expect.stringContaining("selection.n=3, but the outermost query keeps 5 rows"),
      obstacle: { kind: "technical_failure", retryable: true, sqlExecuted: false },
    });
    expect(calls).toEqual([]);
    const accepted = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: top3 }, context("result-right"));
    expect(accepted).toMatchObject({ artifact: { kind: "candidate" }, coverage: expect.arrayContaining([expect.objectContaining({ checkId: "spec_realization", outcome: "clear" })]) });
  });

  it("does not block a result when the rejected alternative was never probed", async () => {
    const { answering } = service({ ...outputs, "SELECT final purchase": { columns: ["orders"], rows: [[265]], truncated: false } });
    const { view, purchase, delivered } = await begin(answering);
    const reason = "The month cannot be separated from other fields in this query";
    await answering.set({ taskId: view.taskId, requestId: "waive", fields: { [PATH]: { notProbeable: { [purchase]: reason, [delivered]: reason } } } }, context("waive"));
    const decided = await decide(answering, view.taskId, DELIVERED);
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: decided.revisionId, sql: "SELECT final purchase" }, context("result"))).resolves.toMatchObject({ artifact: { kind: "candidate" } });
  });

  it("runs an exploration issued alongside a field write against the Revision that write created", async () => {
    const inner = new InMemoryAnsweringStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let explorationTransactions = 0;
    const store: AnsweringStore = {
      transact: async (command, business) => {
        // Hold the exploration after it read the current Revision, while the field write lands.
        if (business.invocationId === "explore" && ++explorationTransactions === 2) await gate;
        return inner.transact(command, business);
      },
      readTaskBundle: (taskId, business) => inner.readTaskBundle(taskId, business),
      list: (business) => inner.list(business),
      listReferencedResultRefs: (business) => inner.listReferencedResultRefs(business),
    };
    const answering = new InMemoryAnswering({ store, resultStore: new InMemoryResultStore(), sqlExecutor: { run: async () => outputs["SELECT purchase"]! }, fieldProbes: true });
    const { view } = await begin(answering);
    const exploring = answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase" }, context("explore"));
    while (explorationTransactions < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    const written = await answering.set({ taskId: view.taskId, requestId: "write", fields: { grouping: { value: ["month"], reason: "per month" } } }, context("write"));
    release();
    await expect(exploring).resolves.toMatchObject({ kind: "exploration" });
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.attempts.find((attempt) => attempt.kind === "exploration")).toMatchObject({ revisionId: written.revisionId, state: "succeeded" });
  });
});
