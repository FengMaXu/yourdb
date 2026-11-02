import { describe, expect, it } from "vitest";
import { InMemoryAnswering, InMemoryAnsweringStore, InMemoryResultStore, type BusinessContext } from "./public.js";
import { parseFieldValue, requiredPaths } from "./fields.js";

const context = (invocationId: string): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const REQUEST = "How many delivered orders were counted in each delivery month of 2017?";
const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };
const rationale = "Delivered orders are counted in the month the delivery happened";

function service(options: { populationDecisions?: "require_evidence" | "allow_disclosed"; fieldProbes?: boolean } = {}) {
  return new InMemoryAnswering({
    store: new InMemoryAnsweringStore(),
    resultStore: new InMemoryResultStore(),
    sqlExecutor: { run: async (sql) => ({ columns: ["n"], rows: [[sql.includes("delivered") ? 205 : 265]], truncated: false }) },
    fieldProbes: options.fieldProbes ?? true,
    ...(options.populationDecisions ? { populationDecisions: options.populationDecisions } : {}),
    evidenceSource: { readUserMessage: async (_sessionId, messageId) => messageId === "message-1" ? REQUEST : undefined },
  });
}

async function begin(answering: InMemoryAnswering, fields: Record<string, unknown> = {}) {
  return answering.set({ requestMessageId: "message-1", requestId: "begin", fields: { ...spec, ...fields } }, context("begin"));
}

/** An open field whose two alternatives were both probed, ready to be decided. */
async function probed(answering: InMemoryAnswering, path: string) {
  const view = await begin(answering, { [path]: { open: ["purchase month", "delivery month"] } });
  const field = view.fields.find((item) => item.path === path)!;
  const [purchase, delivered] = field.alternatives!.map((item) => item.id);
  const probe = await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase", probe: { path, alternativeId: purchase! } }, context("p1"));
  await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT delivered", probe: { path, alternativeId: delivered! } }, context("p2"));
  const observation = probe.artifact.kind === "exploration" ? probe.artifact.evidenceId : "";
  const decide = (id: string, write: Record<string, unknown>) => answering.set({ taskId: view.taskId, requestId: id, fields: { [path]: { value: "delivery month", rationale, ...write } } }, context(id));
  return { view, observation, decide };
}

describe("selection.orderBy", () => {
  it("takes the column and direction as text or as {column, direction}", () => {
    expect(parseFieldValue("selection", { n: 10, orderBy: "revenue desc" })).toEqual({ n: 10, orderBy: "revenue desc" });
    expect(parseFieldValue("selection", { n: 10, orderBy: { column: "revenue", direction: "DESC" } })).toEqual({ n: 10, orderBy: "revenue desc" });
    expect(() => parseFieldValue("selection", { n: 10, orderBy: { column: "revenue", direction: "down" } })).toThrow('direction must be "asc" or "desc"');
    expect(() => parseFieldValue("selection", { n: 10 })).toThrow('e.g. "revenue desc"');
    // A direction that is there but unusable is refused, never read as ascending.
    for (const direction of [1, "", "  "]) expect(() => parseFieldValue("selection", { n: 10, orderBy: { column: "revenue", direction } })).toThrow('direction must be "asc" or "desc"');
    expect(() => parseFieldValue("selection", { n: 10, orderBy: { col: "revenue", dir: "desc" } })).toThrow("unknown keys col, dir");
    expect(() => parseFieldValue("selection", { n: 10, orderBy: { direction: "desc" } })).toThrow("orderBy.column is required");
  });
});

describe("set: each path on its own, one Revision per call", () => {
  it("lands every applied path as one Revision charged once", async () => {
    const answering = service();
    const view = await begin(answering);
    const revised = await answering.set({
      taskId: view.taskId,
      requestId: "revise-1",
      fields: {
        "measure.formula": { value: { op: "count_distinct", of: "order_id" }, reason: "orders repeat across items" },
        "population.conditions": { value: ["order_status = 'delivered'"], reason: "only delivered orders" },
      },
    }, context("revise-1"));
    expect(revised.outcomes).toEqual([{ path: "measure.formula", status: "applied" }, { path: "population.conditions", status: "applied" }]);
    expect(revised.parentRevisionId).toBe(view.revisionId);
    expect(revised.fields.find((item) => item.path === "measure.formula")).toMatchObject({ status: "assumed", value: { op: "count_distinct", of: "order_id" } });
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.task.budget?.revisionCount).toBe(1);
    expect(inspected.currentRevision.rewrites).toEqual([
      { path: "measure.formula", reason: "orders repeat across items" },
      { path: "population.conditions", reason: "only delivered orders" },
    ]);
  });

  it("skips a rejected path, applies the others and reports why", async () => {
    const answering = service();
    const view = await begin(answering);
    const revised = await answering.set({
      taskId: view.taskId,
      requestId: "revise-mixed",
      fields: {
        grouping: ["delivery_month"],
        "population.time": { value: "2017", reason: "the request names 2017" },
      },
    }, context("revise-mixed"));
    expect(revised.outcomes).toEqual([
      { path: "grouping", status: "rejected", code: "SPEC_TRANSITION_INVALID", message: 'grouping is already set; add "reason" to change it' },
      { path: "population.time", status: "applied" },
    ]);
    expect(revised.fields.find((item) => item.path === "grouping")).toMatchObject({ status: "not_applicable" });
  });

  it("writes and charges nothing when every path is rejected", async () => {
    const answering = service();
    const view = await begin(answering);
    const revised = await answering.set({ taskId: view.taskId, requestId: "revise-none", fields: { grouping: ["month"], metric: "count" } }, context("revise-none"));
    expect(revised.revisionId).toBe(view.revisionId);
    expect(revised.outcomes?.map((item) => item.status)).toEqual(["rejected", "rejected"]);
    const inspected = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(inspected.task.budget?.revisionCount).toBe(0);
  });

  it("starts the task even when every path is rejected, so a later call can continue it", async () => {
    const answering = service();
    const view = await answering.set({ requestMessageId: "message-1", requestId: "begin-bad", fields: { metric: "count" } }, context("begin-bad"));
    expect(view.taskId).toMatch(/^task_/);
    expect(view.outcomes).toEqual([expect.objectContaining({ path: "metric", status: "rejected" })]);
    expect(view.undeclared).toContain("population.entity");
  });

  it("registers the evidence of applied paths only", async () => {
    const answering = service();
    const view = await begin(answering, {
      "population.time": { value: "2017", basis: "request", quote: "of 2017" },
      grouping: { value: ["delivery_month"], basis: "request", quote: "each harvest month" },
    });
    expect(view.outcomes?.find((item) => item.path === "population.time")).toMatchObject({ status: "applied" });
    expect(view.outcomes?.find((item) => item.path === "grouping")).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
    expect(view.fields.find((item) => item.path === "population.time")).toMatchObject({ status: "request" });
    const store = await answering.inspect({ taskId: view.taskId }, context("inspect"));
    expect(store.currentRevision.fields["population.time"]).toMatchObject({ basis: { kind: "evidence" } });
  });
});

describe("bases and layers (ADR-0006, ADR-0007)", () => {
  it("lets an observation settle a physical field but not a semantic one", async () => {
    const answering = service();
    const view = await begin(answering);
    const explored = await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase" }, context("explore"));
    const observation = explored.artifact.kind === "exploration" ? explored.artifact.evidenceId : "";
    const revised = await answering.set({
      taskId: view.taskId,
      requestId: "observed",
      fields: {
        "population.joinMultiplicity": { value: "order_items repeat each order; count distinct order_id", evidenceIds: [observation] },
        "population.eligibility": { value: "orders without items are excluded", evidenceIds: [observation], reason: "observed" },
      },
    }, context("observed"));
    expect(revised.fields.find((item) => item.path === "population.joinMultiplicity")).toMatchObject({ status: "evidence" });
    // An observation cannot settle who counts while the user can still be asked.
    expect(revised.outcomes?.find((item) => item.path === "population.eligibility")).toMatchObject({ status: "rejected", message: expect.stringContaining("material population") });
  });

  it("records an eligibility assumption as disclosed when no clarification path exists", async () => {
    const answering = service({ populationDecisions: "allow_disclosed" });
    const view = await begin(answering, { "population.eligibility": { value: "customers with no orders count as zero", basis: "assumed", rationale: "every customer is listed" } });
    expect(view.fields.find((item) => item.path === "population.eligibility")).toMatchObject({ status: "assumed", rationale: "every customer is listed" });
    expect(view.unverified).toContain("population.eligibility");
  });

  it("rejects an unknown evidence id instead of downgrading it to an assumption", async () => {
    const answering = service();
    const view = await begin(answering, { grouping: { value: ["month"], evidenceIds: ["evidence_missing"], reason: "x" } });
    expect(view.outcomes?.find((item) => item.path === "grouping")).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
  });
});

describe("deciding an open field (ADR-0005, ADR-0006)", () => {
  it("records a decision backed by a qualifying request quote as verified", async () => {
    const { decide } = await probed(service(), "measure.window");
    const decided = await decide("verified", { basis: "request", quote: "each delivery month" });
    expect(decided.outcomes?.[0]).toMatchObject({ status: "applied" });
    expect(decided.fields.find((item) => item.path === "measure.window")).toMatchObject({ status: "decided", value: "delivery month", verified: true, rationale });
    expect(decided.unverified).not.toContain("measure.window");
  });

  it("does not let a request quote verify a decision on a physical field", async () => {
    const { decide } = await probed(service(), "population.timeField");
    const decided = await decide("physical", { basis: "request", quote: "each delivery month" });
    expect(decided.fields.find((item) => item.path === "population.timeField")).toMatchObject({ status: "decided", verified: false });
  });

  it("records a decision with non-qualifying or no evidence as unverified instead of failing", async () => {
    const answering = service();
    const { observation, decide } = await probed(answering, "measure.window");
    const decided = await decide("unverified", { evidenceIds: [observation] });
    expect(decided.fields.find((item) => item.path === "measure.window")).toMatchObject({ status: "decided", verified: false, rationale });
    const stored = await answering.inspect({ taskId: decided.taskId }, context("inspect"));
    expect(stored.currentRevision.fields["measure.window"]).toMatchObject({ state: "decided", basis: { kind: "assumed", citedEvidenceIds: [observation] } });
  });

  it("rejects unknown evidence, a short rationale and a value that is not an alternative", async () => {
    const { decide } = await probed(service(), "measure.window");
    expect((await decide("unknown", { evidenceIds: ["evidence_missing"] })).outcomes?.[0]).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
    expect((await decide("short", { rationale: "fits" })).outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("needs a rationale") });
    expect((await decide("other", { value: "weekly" })).outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("is not one of its alternatives") });
  });

  it("blocks an unverified population decision only when a clarification path exists", async () => {
    const strict = await probed(service({ populationDecisions: "require_evidence" }), "population.conditions");
    const blocked = await strict.decide("strict", { value: ["delivery month"] });
    expect(blocked.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("material population") });
    const headless = await probed(service({ populationDecisions: "allow_disclosed" }), "population.conditions");
    const decided = await headless.decide("headless", { value: ["delivery month"] });
    expect(decided.fields.find((item) => item.path === "population.conditions")).toMatchObject({ status: "decided", verified: false });
  });

  it("replaces open alternatives only with a reason", async () => {
    const answering = service();
    const view = await begin(answering, { "measure.window": { open: ["calendar month", "rolling 30 days"] } });
    const plain = await answering.set({ taskId: view.taskId, requestId: "plain", fields: { "measure.window": { open: ["a", "b"] } } }, context("plain"));
    expect(plain.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("or decide one of its alternatives") });
    const reopened = await answering.set({ taskId: view.taskId, requestId: "reopen", fields: { "measure.window": { open: ["a", "b"], reason: "the earlier alternatives missed the fiscal month" } } }, context("reopen"));
    expect(reopened.fields.find((item) => item.path === "measure.window")!.alternatives!.map((item) => item.value)).toEqual(["a", "b"]);
  });
});

describe("field values and necessity (ADR-0007)", () => {
  it("parses a nested measure and asks for the grain of every inner layer", () => {
    expect(parseFieldValue("measure.formula", { op: "avg", per: "country", of: { op: "avg", per: "player", of: { op: "sum", per: "match", of: "runs" } } })).toMatchObject({ op: "avg" });
    // The outermost layer is computed per the output grouping.
    expect(parseFieldValue("measure.formula", { op: "avg", of: { op: "sum", per: "match", of: "runs" } })).toMatchObject({ op: "avg" });
    expect(() => parseFieldValue("measure.formula", { op: "avg", per: "country", of: { op: "sum", of: "runs" } })).toThrow(/give every inner layer "per"/);
    expect(() => parseFieldValue("measure.formula", { op: "ratio", of: "x" })).toThrow(/does not take of/);
    expect(() => parseFieldValue("measure.formula", { op: "custom" })).toThrow(/needs a description/);
    expect(parseFieldValue("measure.formula", { op: "custom", description: "linear regression forecast of daily sales" })).toMatchObject({ op: "custom" });
  });

  it("takes conditions with the stage they apply at and grouping keys with their grain", () => {
    expect(parseFieldValue("population.conditions", [{ condition: "median income > 0", stage: "WHERE" }, "state = 'NY'", { expression: "COUNT(*) > 4", stage: "HAVING" }]))
      .toEqual([{ condition: "median income > 0", stage: "WHERE" }, "state = 'NY'", { condition: "COUNT(*) > 4", stage: "HAVING" }]);
    expect(parseFieldValue("population.conditions", "status = 'delivered'")).toEqual(["status = 'delivered'"]);
    expect(parseFieldValue("grouping", [{ field: "industry" }, { key: "order_date", grain: "calendar year" }]))
      .toEqual(["industry", { key: "order_date", grain: "calendar year" }]);
    expect(() => parseFieldValue("grouping", [{ grain: "month" }])).toThrow(/grouping value\[0\].key is required/);
    expect(() => parseFieldValue("population.conditions", [{ condition: "x", phase: "WHERE" }])).toThrow(/unknown keys phase/);
  });

  it("requires the sub-fields the measure, selection and source call for", () => {
    const base = { formulas: [], sources: [], selection: false };
    expect(requiredPaths(base)).toEqual(["population.entity", "population.eligibility", "population.conditions", "population.time", "measure.formula", "grouping", "selection", "output"]);
    const ratioInArgmin = requiredPaths({ ...base, formulas: [{ op: "ratio", per: "pitcher", numerator: { op: "sum", per: "pitcher", of: "runs" }, denominator: { op: "sum", per: "pitcher", of: "wickets" } }], selection: true });
    expect(ratioInArgmin).toEqual(expect.arrayContaining(["measure.countGrain", "measure.denominator", "selection.ties"]));
    expect(ratioInArgmin).not.toContain("measure.window");
    expect(requiredPaths({ ...base, formulas: [{ op: "cumulative", of: "balance" }] })).toContain("measure.window");
    expect(requiredPaths({ ...base, sources: [{ tables: ["orders", "order_items"] }] })).toContain("population.joinMultiplicity");
    expect(requiredPaths({ ...base, sources: [{ tables: ["orders"] }] })).not.toContain("population.joinMultiplicity");
    // Neither timeField nor missing is required by the rules.
    expect(requiredPaths({ ...base, formulas: [{ op: "rolling", of: "x" }], sources: [{ tables: ["a", "b"] }], selection: true })).not.toEqual(expect.arrayContaining(["population.timeField"]));
  });

  it("blocks the result query until the fields the rules require are declared", async () => {
    const answering = service();
    const view = await begin(answering, { selection: { n: 3, orderBy: "orders DESC" }, output: { rowMode: "top_n", rowCount: 3 } });
    expect(view.undeclared).toEqual(["selection.ties"]);
    await expect(answering.execute({ kind: "result", taskId: view.taskId, revisionId: view.revisionId, sql: "SELECT 1" }, context("blocked")))
      .rejects.toMatchObject({ code: "UNRESOLVED_ASSUMPTIONS", details: { undeclared: ["selection.ties"] } });
    const tied = await answering.set({ taskId: view.taskId, requestId: "ties", fields: { "selection.ties": "strict" } }, context("ties"));
    expect(tied.undeclared).toEqual([]);
  });
});
