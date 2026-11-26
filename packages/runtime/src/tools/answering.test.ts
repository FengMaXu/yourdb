import { describe, expect, it } from "vitest";
import { InMemoryAnsweringStore } from "../answering/answering-store.js";
import { InMemoryResultStore } from "../answering/result-store.js";
import { InMemoryAnswering } from "../answering/service.js";
import { createAnsweringAgentToolDefinitions, fieldStateTable } from "./answering.js";
import type { BusinessContext } from "../answering/model.js";

const businessContext = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "operation-1",
  invocationId,
});

const toolContext = { sessionId: "session-1", principalId: "user-1", requestMessageId: "msg-1" } as never;
const invocation = (invocationId: string) => ({
  operationId: "operation-1",
  invocationId,
  getMemo: async () => undefined,
  setMemo: async () => undefined,
}) as never;

describe("answering tools probe rendering", () => {
  it("renders neutral row counts and per-column NULL summaries in [PROBE] and fieldStateTable, omitting NULL counts when unavailable", async () => {
    const outputs: Record<string, { columns: string[]; rows: unknown[][]; truncated: boolean }> = {
      "SELECT a": { columns: ["dept", "score"], rows: [["eng", 10], ["sales", null]], truncated: false },
      "SELECT b": { columns: ["dept", "score"], rows: [["eng", 10], ["sales", 20]], truncated: false },
      "SELECT c": { columns: ["dept", "score"], rows: [["eng", 10]], truncated: true },
    };
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async (sql) => outputs[sql]! },
      fieldProbes: true,
    });
    const tools = new Map(createAnsweringAgentToolDefinitions(answering).map((item) => [item.tool.name, item.tool]));
    const queryTool = tools.get("query_database")!;

    const spec = {
      "population.entity": "employees",
      "population.eligibility": "n/a",
      "population.conditions": "n/a",
      "population.time": "n/a",
      "measure.formula": { op: "count", of: "employees" },
      "measure.countGrain": { grain: "row", note: "one row per employee" },
      grouping: ["dept"],
      selection: "n/a",
      output: { rowMode: "grouped" },
      "population.timeField": { open: ["opt_a", "opt_b", "opt_c"] },
    };
    const begun = await answering.set({ requestMessageId: "msg-1", requestId: "begin", fields: spec }, businessContext("begin"));
    const [altA, altB, altC] = begun.fields.find((item) => item.path === "population.timeField")!.alternatives!.map((item) => item.id as string);

    const resA = await queryTool.execute("t1", { kind: "exploration", taskId: begun.taskId, sql: "SELECT a", probe: { path: "population.timeField", alternativeId: altA! } }, undefined, toolContext, invocation("p1"), {} as never);
    const textA = (resA.content[0] as { text: string }).text;
    expect(textA).toContain(`[PROBE] path=population.timeField alternativeId=${altA} rows=2 output=`);
    expect(textA).toContain(" nulls=[score:1]\n");

    const resB = await queryTool.execute("t2", { kind: "exploration", taskId: begun.taskId, sql: "SELECT b", probe: { path: "population.timeField", alternativeId: altB! } }, undefined, toolContext, invocation("p2"), {} as never);
    const textB = (resB.content[0] as { text: string }).text;
    expect(textB).toContain(`[PROBE] path=population.timeField alternativeId=${altB} rows=2 output=`);
    expect(textB).toContain(" nulls=none\n");

    const resC = await queryTool.execute("t3", { kind: "exploration", taskId: begun.taskId, sql: "SELECT c", probe: { path: "population.timeField", alternativeId: altC! } }, undefined, toolContext, invocation("p3"), {} as never);
    const textC = (resC.content[0] as { text: string }).text;
    expect(textC).toContain(`[PROBE] path=population.timeField alternativeId=${altC} rows=1 output unavailable:`);
    expect(textC).not.toContain("nulls=");

    const refreshed = await answering.set({ taskId: begun.taskId, requestId: "refresh", fields: {} }, businessContext("refresh"));
    const table = fieldStateTable(refreshed);
    expect(table).toContain(`${altA}=opt_a rows=2 output=`);
    expect(table).toContain("nulls=[score:1]");
    expect(table).toContain(`${altB}=opt_b rows=2 output=`);
    expect(table).toContain("nulls=none");
    expect(table).toContain(`${altC}=opt_c unavailable`);
  });
});
