import { describe, expect, it } from "vitest";
import {
  InMemoryAnswering,
  InMemoryAnsweringStore,
  InMemoryResultStore,
  type BusinessContext,
} from "./public.js";

const context = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId,
});

function service() {
  return new InMemoryAnswering({
    store: new InMemoryAnsweringStore(),
    resultStore: new InMemoryResultStore(),
    sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[42]], truncated: false }) },
    fieldProbes: true,
    // The shared population here is assumed; this suite is about inheritance, not the population rule.
    populationDecisions: "allow_disclosed",
  });
}

const shared = {
  "population.entity": "orders",
  "population.eligibility": "n/a",
  "population.conditions": ["order_status = 'delivered'"],
  "population.time": { expression: "2018", boundary: "inclusive" },
};

const own = {
  "measure.formula": { op: "count", of: "orders" },
  "measure.countGrain": "one row per order",
  grouping: "n/a",
  selection: "n/a",
  output: { rowMode: "scalar", rowCount: 1 },
};

async function report(answering: InMemoryAnswering, fields: Record<string, unknown> = shared) {
  return answering.set({ requestMessageId: "message-1", requestId: "report", fields, report: true }, context("report"));
}

async function chart(answering: InMemoryAnswering, parentTaskId: string, requestId = "chart", fields: Record<string, unknown> = own) {
  return answering.set({ requestMessageId: "message-1", requestId, fields, parent: { taskId: parentTaskId } }, context(requestId));
}

async function revise(answering: InMemoryAnswering, taskId: string, requestId: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return answering.set({ taskId, requestId, fields, ...extra }, context(requestId));
}

async function result(answering: InMemoryAnswering, taskId: string, revisionId: string, invocation: string) {
  return answering.execute({ kind: "result", taskId, revisionId, sql: "SELECT 42" }, context(invocation));
}

describe("Report Task", () => {
  it("gives a chart query the shared population of its Report Task", async () => {
    const answering = service();
    const parent = await report(answering);
    expect(parent.role).toBe("report");
    expect(parent.undeclared).toEqual([]);
    const child = await chart(answering, parent.taskId);
    expect(child.parent).toEqual({ taskId: parent.taskId, revisionId: parent.revisionId, current: true });
    expect(child.fields.find((item) => item.path === "population.entity")).toMatchObject({ value: { name: "orders" }, inherited: { taskId: parent.taskId, revisionId: parent.revisionId } });
    expect(child.fields.find((item) => item.path === "population.conditions")).toMatchObject({ inherited: { taskId: parent.taskId } });
    expect(child.undeclared).toEqual([]);
  });

  it("holds only shared fields on the Report Task", async () => {
    const answering = service();
    const parent = await report(answering, { ...shared, grouping: ["month"] });
    expect(parent.outcomes?.find((item) => item.path === "grouping")).toMatchObject({ status: "rejected", message: expect.stringContaining("only shared fields") });
  });

  it("refuses a change to an inherited field without a reason, and records and discloses one with a reason", async () => {
    const answering = service();
    const parent = await report(answering);
    const refused = await chart(answering, parent.taskId, "chart-refused", { ...own, "population.conditions": ["order_status = 'shipped'"] });
    expect(refused.outcomes?.find((item) => item.path === "population.conditions")).toMatchObject({ status: "rejected", message: expect.stringContaining("shared through the Report Task") });

    const deviated = await chart(answering, parent.taskId, "chart-deviated", { ...own, "population.conditions": { value: ["order_status = 'shipped'"], reason: "这张图只看已发货订单" } });
    expect(deviated.outcomes?.every((item) => item.status === "applied")).toBe(true);
    expect(deviated.deviations).toEqual([{ path: "population.conditions", reason: "这张图只看已发货订单" }]);
    const candidate = await result(answering, deviated.taskId, deviated.revisionId, "result");
    const receipt = await answering.publish({ candidateId: (candidate.artifact as { candidateId: string }).candidateId, format: "inline", requestId: "publish" }, context("publish"));
    expect(receipt.disclosure?.deviations).toEqual([{ path: "population.conditions", reason: "这张图只看已发货订单" }]);
    expect(receipt.disclosure?.summary).toContain("偏离报告任务的共享口径");
  });

  it("blocks a chart query after its Report Task changes, keeps exploration, and lets it rebind", async () => {
    const answering = service();
    const parent = await report(answering);
    const child = await chart(answering, parent.taskId);
    const changed = await revise(answering, parent.taskId, "parent-2", { "population.time": { value: { expression: "2017", boundary: "inclusive" }, reason: "the report covers 2017" } });
    await expect(result(answering, child.taskId, child.revisionId, "stale")).rejects.toMatchObject({ code: "PARENT_REVISION_STALE" });
    await expect(answering.execute({ kind: "exploration", taskId: child.taskId, sql: "SELECT 1" }, context("explore"))).resolves.toMatchObject({ kind: "exploration" });

    const rebound = await revise(answering, child.taskId, "rebind", {}, { rebind: true });
    expect(rebound.parent).toEqual({ taskId: parent.taskId, revisionId: changed.revisionId, current: true });
    expect(rebound.fields.find((item) => item.path === "population.time")).toMatchObject({ value: { expression: "2017" }, inherited: { revisionId: changed.revisionId } });
    await expect(result(answering, child.taskId, rebound.revisionId, "fresh")).resolves.toMatchObject({ kind: "result" });
  });

  it("returns an existing Receipt on a publish replay after the Report Task changed", async () => {
    const answering = service();
    const parent = await report(answering);
    const child = await chart(answering, parent.taskId);
    const candidate = await result(answering, child.taskId, child.revisionId, "result");
    const publish = { candidateId: (candidate.artifact as { candidateId: string }).candidateId, format: "inline" as const, requestId: "publish" };
    const receipt = await answering.publish(publish, context("publish"));
    await revise(answering, parent.taskId, "parent-2", { "population.time": { value: "2017", reason: "the report covers 2017" } });
    await expect(answering.publish(publish, context("publish-replay"))).resolves.toMatchObject({ receiptId: receipt.receiptId });
  });

  it("keeps a deviated field on rebind", async () => {
    const answering = service();
    const parent = await report(answering);
    const child = await chart(answering, parent.taskId, "chart", { ...own, "population.time": { value: "2018 Q4", reason: "只看第四季度" } });
    await revise(answering, parent.taskId, "parent-2", { "population.entity": { value: "order_items", reason: "count items" } });
    const rebound = await revise(answering, child.taskId, "rebind", {}, { rebind: true });
    expect(rebound.fields.find((item) => item.path === "population.time")).toMatchObject({ value: { expression: "2018 Q4" } });
    expect(rebound.fields.find((item) => item.path === "population.time")).not.toHaveProperty("inherited");
    expect(rebound.fields.find((item) => item.path === "population.entity")).toMatchObject({ value: { name: "order_items" }, inherited: { taskId: parent.taskId } });
  });

  it("blocks every chart query while the Report Task has a required shared field undeclared", async () => {
    const answering = service();
    const { "population.eligibility": _eligibility, ...partial } = shared;
    const parent = await report(answering, partial);
    expect(parent.undeclared).toEqual(["population.eligibility"]);
    const child = await chart(answering, parent.taskId);
    await expect(result(answering, child.taskId, child.revisionId, "blocked")).rejects.toMatchObject({ code: "PARENT_UNRESOLVED", details: { unresolved: ["population.eligibility"] } });
  });

  it("does not block chart queries on a Report Task field whose probes all match", async () => {
    const answering = service();
    const parent = await report(answering, { ...shared, "population.conditions": { open: [["status <> 'cancelled'"], ["status = 'delivered'"]] } });
    const child = await chart(answering, parent.taskId);
    await expect(result(answering, child.taskId, child.revisionId, "before")).rejects.toMatchObject({ code: "PARENT_UNRESOLVED" });
    const alternatives = parent.fields.find((item) => item.path === "population.conditions")!.alternatives!;
    for (const alternative of alternatives) {
      await answering.execute({ kind: "exploration", taskId: parent.taskId, sql: "SELECT 42", probe: { path: "population.conditions", alternativeId: alternative.id } }, context(`probe-${alternative.id}`));
    }
    await expect(result(answering, child.taskId, child.revisionId, "after")).resolves.toMatchObject({ kind: "result" });
  });

  it("lets a chart query cite its Report Task's evidence", async () => {
    const answering = service();
    const parent = await report(answering);
    const observed = await answering.execute({ kind: "exploration", taskId: parent.taskId, sql: "SELECT COUNT(*)" }, context("observe"));
    const evidenceId = (observed.artifact as { evidenceId: string }).evidenceId;
    const child = await chart(answering, parent.taskId, "chart", { ...own, "population.joinMultiplicity": { value: "orders are not joined", evidenceIds: [evidenceId], reason: "checked" } });
    expect(child.outcomes?.find((item) => item.path === "population.joinMultiplicity")).toMatchObject({ status: "applied" });
    expect(child.fields.find((item) => item.path === "population.joinMultiplicity")).toMatchObject({ status: "evidence", evidenceIds: [evidenceId] });
  });

  it("never runs a result query or publishes on the Report Task itself", async () => {
    const answering = service();
    const parent = await report(answering);
    await expect(result(answering, parent.taskId, parent.revisionId, "report-result")).rejects.toMatchObject({ code: "REPORT_TASK_NOT_PUBLISHABLE" });
  });

  it("lets a chart query take a named measure definition with its denominator and count grain", async () => {
    const answering = service();
    const parent = await report(answering, {
      ...shared,
      "measures.negative_rate": { formula: { op: "ratio", numerator: "1-2 星订单数", denominator: "有评价订单数" }, denominator: "有评价的订单", countGrain: "按订单" },
      "measures.late_rate": { formula: { op: "ratio", numerator: "超期送达订单", denominator: "已送达订单" } },
    });
    const { "measure.formula": _formula, "measure.countGrain": _grain, ...rest } = own;
    const child = await chart(answering, parent.taskId, "chart", { ...rest, "measure.formula": { ref: "negative_rate" } });
    expect(child.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "applied" });
    expect(child.measureRef).toBe("negative_rate");
    expect(child.fields.find((item) => item.path === "measure.formula")).toMatchObject({ value: { op: "ratio" }, inherited: { taskId: parent.taskId } });
    expect(child.fields.find((item) => item.path === "measure.denominator")).toMatchObject({ value: "有评价的订单", inherited: { taskId: parent.taskId } });
    expect(child.undeclared).toEqual([]);

    const unknown = await chart(answering, parent.taskId, "chart-unknown", { ...rest, "measure.formula": { ref: "gmv" } });
    expect(unknown.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "rejected", message: expect.stringContaining("negative_rate, late_rate") });

    // A ref wrapped in "value" is told where it belongs, instead of "unknown keys ref".
    const wrapped = await chart(answering, parent.taskId, "chart-wrapped", { ...rest, "measure.formula": { value: { ref: "negative_rate" } } });
    const message = wrapped.outcomes?.find((item) => item.path === "measure.formula")?.message ?? "";
    expect(message).toContain('"measure.formula": {"ref": "<measure name>"}');
    expect(message).toContain("never inside \"value\"");
    expect(message).not.toContain("unknown keys");
  });

  it("asks for a reason before a chart query uses a measure of its own when the Report Task defines measures", async () => {
    const answering = service();
    const parent = await report(answering, { ...shared, "measures.orders": { formula: { op: "count", of: "orders" } } });
    const refused = await chart(answering, parent.taskId, "chart-own");
    expect(refused.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "rejected", message: expect.stringContaining("shared through the Report Task") });
    const mine = await chart(answering, parent.taskId, "chart-own-reason", { ...own, "measure.formula": { value: { op: "sum", of: "price" }, reason: "这张图看 GMV，报告未定义" } });
    expect(mine.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "applied" });
    expect(mine.deviations).toEqual([{ path: "measure.formula", reason: "这张图看 GMV，报告未定义" }]);
  });

  it("follows a changed definition only after rebinding, and refuses a reference to an unsettled one", async () => {
    const answering = service();
    const parent = await report(answering, {
      ...shared,
      "measures.orders": { formula: { op: "count", of: "orders" } },
      "measures.late": { open: [{ formula: { op: "count", of: "late orders" } }, { formula: { op: "count", of: "late items" } }] },
    });
    const { "measure.formula": _formula, ...rest } = own;
    const orders = await chart(answering, parent.taskId, "chart-orders", { ...rest, "measure.formula": { ref: "orders" } });
    const late = await chart(answering, parent.taskId, "chart-late", { ...rest, "measure.formula": { ref: "late" } });
    expect(late.outcomes?.find((item) => item.path === "measure.formula")).toMatchObject({ status: "rejected", message: expect.stringContaining("has not settled measures.late") });
    await expect(result(answering, orders.taskId, orders.revisionId, "orders")).resolves.toMatchObject({ kind: "result" });

    await revise(answering, parent.taskId, "parent-2", { "measures.orders": { value: { formula: { op: "count_distinct", of: "order_id" } }, reason: "orders repeat" } });
    const rebound = await revise(answering, orders.taskId, "rebind", {}, { rebind: true });
    expect(rebound.fields.find((item) => item.path === "measure.formula")).toMatchObject({ value: { op: "count_distinct", of: "order_id" } });
    expect(rebound.measureRef).toBe("orders");
  });

  it("refreshes a chart query after its Report Task changed and says the shared fields moved on", async () => {
    const answering = service();
    const parent = await report(answering);
    const child = await chart(answering, parent.taskId);
    const candidate = await result(answering, child.taskId, child.revisionId, "result");
    const receipt = await answering.publish({ candidateId: (candidate.artifact as { candidateId: string }).candidateId, format: "inline", requestId: "publish" }, context("publish"));

    const unchanged = await answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-1" }, context("refresh-1"));
    expect(unchanged.disclosure?.parentSuperseded).toBeUndefined();

    const changed = await revise(answering, parent.taskId, "parent-2", { "population.time": { value: "2017", reason: "the report covers 2017" } });
    const refreshed = await answering.refresh({ receiptId: receipt.receiptId, requestId: "refresh-2" }, context("refresh-2"));
    expect(refreshed.refreshes).toBe(receipt.receiptId);
    expect(refreshed.disclosure?.parentSuperseded).toEqual({ taskId: parent.taskId, boundRevisionId: parent.revisionId, currentRevisionId: changed.revisionId });
    expect(refreshed.disclosure?.summary).toContain("报告任务口径已被修改");
  });

  it("starts a chart query only under a Report Task", async () => {
    const answering = service();
    const plain = await answering.set({ requestMessageId: "message-1", requestId: "plain", fields: shared }, context("plain"));
    await expect(chart(answering, plain.taskId, "orphan")).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("not a Report Task") });
    await expect(answering.set({ requestMessageId: "message-1", requestId: "both", fields: {}, report: true, parent: { taskId: plain.taskId } }, context("both"))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
