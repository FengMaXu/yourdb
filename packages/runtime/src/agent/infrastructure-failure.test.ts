import { describe, expect, it } from "vitest";
import { MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { InMemoryAnswering } from "../answering/service.js";
import { InMemoryAnsweringStore } from "../answering/answering-store.js";
import { InMemoryResultStore } from "../answering/result-store.js";
import { createAnsweringAgentToolDefinitions } from "../tools/answering.js";
import { createSubagentToolDefinition } from "../tools/subagent.js";
import { defineDataAgentTool } from "../tools/tool-definition.js";
import { HarnessChildExecutor } from "../delegation/child-harness.js";
import { MemoryChildSessionRepository } from "../delegation/child-session-repo.js";
import { NativeDelegation } from "../delegation/delegation.js";
import { PiSessionDelegationLedger } from "../delegation/ledger.js";
import { createPiSessionHost } from "./harness-factory.js";
import { infrastructureFailureOf } from "./infrastructure-failure.js";

const UNAVAILABLE = "DATABASE_UNAVAILABLE: database process unavailable after 3 reconnects (Connection closed)";
const unavailable = () => Object.assign(new Error(UNAVAILABLE), { code: "DATABASE_UNAVAILABLE" });
const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };

describe("infrastructure failure", () => {
  it("extracts the database failure line from tool result text", () => {
    expect(infrastructureFailureOf([{ type: "text", text: `## probe（explorer）— failed\n\n子任务未完成：${UNAVAILABLE}\nmore` }])).toBe(UNAVAILABLE);
    expect(infrastructureFailureOf([{ type: "text", text: "[IMPLEMENTATION_OBSTACLE] syntax error" }])).toBeUndefined();
    expect(infrastructureFailureOf(undefined)).toBeUndefined();
  });

  it("ends the main operation without another model turn when the database is lost", async () => {
    const faux = fauxProvider({ provider: "db-down-main", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const session = await new MemorySessionRepo().create({ id: "db-down-main" }, TODO_CONTEXT);
    const answeringStore = new InMemoryAnsweringStore();
    const resultStore = new InMemoryResultStore();
    const answering = new InMemoryAnswering({ store: answeringStore, resultStore, sqlExecutor: { run: async () => { throw unavailable(); } } });
    const lastToolResult = (context: { messages: readonly any[] }) => context.messages.filter((message) => message.role === "toolResult").at(-1);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("set_answer_spec", { fields: spec }, { id: "begin" }), { stopReason: "toolUse" }),
      async (context) => fauxAssistantMessage(fauxToolCall("query_database", { kind: "exploration", taskId: lastToolResult(context)?.details?.taskId, sql: "SELECT 1" }, { id: "explore" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("I will look for the database file with run_python instead."),
    ]);
    const host = await createPiSessionHost({
      session,
      sessionId: "db-down-main",
      toolContext: { sessionId: "db-down-main", principalId: "user-1" },
      toolDefinitions: [...createAnsweringAgentToolDefinitions(answering)],
      answering,
      answeringStore,
      resultStore,
      systemPrompt: "You are the main Data Agent.",
      profile: { provider: faux.provider, model: faux.models[0].id },
      queryTaskProjection: {} as never,
      artifactDirectory: {} as never,
      clarificationDialogs: { subscribe: () => () => undefined } as never,
      piRuntime: { models, model: faux.models[0] },
    });
    try {
      const accepted = await host.controller.prompt("Count orders.");
      const driven = await host.lane.drive({ operationId: accepted.operationId }, TODO_CONTEXT);
      expect(driven.ok).toBe(true);
      expect(faux.state.callCount).toBe(2);
      const entries = await host.lane.findEntries({ type: "message", order: "newestFirst" }, TODO_CONTEXT);
      const toolResults = entries.map((entry: any) => entry.message).filter((message: any) => message?.role === "toolResult");
      expect(JSON.stringify(toolResults[0])).toContain("DATABASE_UNAVAILABLE");
      expect(JSON.stringify(entries)).not.toContain("run_python instead");
    } finally {
      await host.close();
    }
  });

  it("fails a child whose tool loses the database and carries the code to the parent report", async () => {
    const faux = fauxProvider({ provider: "db-down-child", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentSession = await new MemorySessionRepo().create({ id: "db-down-parent" }, TODO_CONTEXT);
    const exploreSql = defineDataAgentTool({
      name: "explore_sql",
      label: "explore_sql",
      description: "Run one read-only query.",
      parameters: Type.Object({ sql: Type.String() }),
      async execute() { throw unavailable(); },
    }, { promptSnippet: "执行一条只读探索查询。", promptGuidelines: [] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("explore_sql", { sql: "SELECT 1" }, { id: "child-explore" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("## 结论\n\nI searched the disk for the sqlite file instead."),
    ]);
    const delegation = new NativeDelegation({
      executor: new HarnessChildExecutor({ sessions: new MemoryChildSessionRepository(), models, model: faux.models[0] }),
      resolver: {
        async resolve(task) {
          return { targetRef: `subagent:${task.key}`, prompt: task.task, systemPrompt: "Return a Markdown report.", toolDefinitions: [exploreSql], checkTarget: async () => ({ state: "current" as const, reasons: [] }) };
        },
      },
      ledger: new PiSessionDelegationLedger(parentSession),
    });
    const tool = createSubagentToolDefinition(delegation).tool as any;
    const memo = new Map<string, unknown>();
    try {
      const result = await tool.execute("delegate", { tasks: [{ key: "probe", role: "explorer", task: "count rows" }] }, undefined, { sessionId: "db-down-parent", principalId: "user-1" }, {
        invocationId: "parent-invocation", operationId: "parent-operation", turnId: "turn",
        getMemo: async (name: string) => memo.get(name),
        setMemo: async (name: string, value: unknown) => { memo.set(name, value); },
      }, TODO_CONTEXT);
      expect(result.details).toEqual([expect.objectContaining({ status: "failed" })]);
      expect(infrastructureFailureOf(result.content)).toBe(UNAVAILABLE);
      expect(JSON.stringify(result.content)).not.toContain("searched the disk");
    } finally {
      await delegation.close();
      await parentSession.close(TODO_CONTEXT);
    }
  });
});
