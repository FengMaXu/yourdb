import { describe, expect, it } from "vitest";
import { AgentHarness, MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InMemoryAnswering } from "../answering/service.js";
import { InMemoryAnsweringStore } from "../answering/answering-store.js";
import { InMemoryResultStore } from "../answering/result-store.js";
import { createQueryTaskDelegationResolver } from "../application/delegation.js";
import { createPiSessionHost } from "../agent/harness-factory.js";
import { createAnsweringAgentToolDefinitions } from "../tools/answering.js";
import { createSubagentToolDefinition } from "../tools/subagent.js";
import { HarnessChildExecutor } from "./child-harness.js";
import { MemoryChildSessionRepository } from "./child-session-repo.js";
import { NativeDelegation } from "./delegation.js";
import { PiSessionDelegationLedger } from "./ledger.js";

const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };

describe("main AgentHarness to child AgentHarness", () => {
  it("binds the actual prompt entry to Answering before the main agent delegates", async () => {
    const faux = fauxProvider({ provider: "host-request-entry-e2e", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentSession = await new MemorySessionRepo().create({ id: "parent-host-request" }, TODO_CONTEXT);
    const answeringStore = new InMemoryAnsweringStore();
    const resultStore = new InMemoryResultStore();
    const answering = new InMemoryAnswering({
      store: answeringStore,
      resultStore,
      sqlExecutor: { run: async () => ({ columns: ["count"], rows: [[2]], truncated: false, columnTypes: ["INTEGER"] }) },
    });
    const ledger = new PiSessionDelegationLedger(parentSession);
    const delegation = new NativeDelegation({
      executor: new HarnessChildExecutor({ sessions: new MemoryChildSessionRepository(), models, model: faux.models[0] }),
      resolver: createQueryTaskDelegationResolver({ answering, ownerSession: parentSession, principalId: "user-1", ownerSessionId: "parent-host-request" }),
      ledger,
    });
    let begun: { taskId: string; revisionId: string } | undefined;
    let childContext = "";
    const lastToolResult = (context: { messages: readonly any[] }) => context.messages.filter((message) => message.role === "toolResult").at(-1);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("set_answer_spec", { fields: spec }, { id: "begin-call" }), { stopReason: "toolUse" }),
      async (context) => {
        begun = lastToolResult(context)?.details;
        if (!begun?.taskId || !begun.revisionId) throw new Error("TEST_ANSWER_SPEC_MISSING");
        return fauxAssistantMessage(fauxToolCall("query_database", { kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, { id: "result-call" }), { stopReason: "toolUse" });
      },
      async () => fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ key: "review", role: "reviewer", task: "Review the exact candidate", taskId: begun!.taskId }] }, { id: "delegate-call" }), { stopReason: "toolUse" }),
      async (context) => {
        childContext = JSON.stringify(context);
        return fauxAssistantMessage("## 结论\n\nCandidate reviewed");
      },
      fauxAssistantMessage("Main agent retained the bounded review."),
    ]);
    const host = await createPiSessionHost({
      session: parentSession,
      sessionId: "parent-host-request",
      toolContext: { sessionId: "parent-host-request", principalId: "user-1" },
      toolDefinitions: [...createAnsweringAgentToolDefinitions(answering), createSubagentToolDefinition(delegation)],
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
      const accepted = await host.controller.prompt("Count orders from the real host prompt.", { requestId: "transport-request-123" });
      const driven = await host.lane.drive({ operationId: accepted.operationId }, TODO_CONTEXT);
      expect(driven.ok).toBe(true);
      expect(childContext).toContain("Count orders from the real host prompt.");
      const view = await answering.inspect({ taskId: begun!.taskId }, { principal: { id: "user-1" }, sessionId: "parent-host-request", lane: "main", operationId: "inspect", invocationId: "inspect" });
      expect(view.task.requestMessageId).not.toBe("transport-request-123");
      await expect(parentSession.getEntry(view.task.requestMessageId, TODO_CONTEXT)).resolves.toMatchObject({ type: "message", message: { role: "user" } });
      expect((await ledger.list()).some((item) => item.state === "settled" && item.status === "completed")).toBe(true);
    } finally {
      await delegation.close();
      await host.close();
    }
  });

  it("lets the main agent delegate reviewer work and receives only the bounded report", async () => {
    const faux = fauxProvider({ provider: "main-child-e2e", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentSession = await new MemorySessionRepo().create({ id: "parent-session" }, TODO_CONTEXT);
    const branch = await parentSession.createBranch("main", null, TODO_CONTEXT);
    const requestMessageId = await branch.appendMessage({ role: "user", content: "Count orders", timestamp: Date.now() }, TODO_CONTEXT);
    await branch.appendMessage({ role: "assistant", content: [{ type: "text", text: "PARENT_HISTORY_SECRET" }], api: "faux", provider: "main-child-e2e", model: "model", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }, TODO_CONTEXT);
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["count"], rows: [[2]], truncated: false, columnTypes: ["INTEGER"] }) },
    });
    const business = (invocationId: string) => ({ principal: { id: "user-1" }, sessionId: "parent-session", lane: "main", operationId: "setup", invocationId });
    const begun = await answering.set({ requestMessageId, requestId: "begin", fields: spec }, business("begin"));
    await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, business("candidate"));
    const ledger = new PiSessionDelegationLedger(parentSession);
    const delegation = new NativeDelegation({
      executor: new HarnessChildExecutor({ sessions: new MemoryChildSessionRepository(), models, model: faux.models[0] }),
      resolver: createQueryTaskDelegationResolver({ answering, ownerSession: parentSession, principalId: "user-1", ownerSessionId: "parent-session" }),
      ledger,
    });
    const subagent = createSubagentToolDefinition(delegation).tool;
    let initialParentContext = "";
    let childContext = "";
    let finalParentContext = "";
    faux.setResponses([
      async (context) => {
        initialParentContext = JSON.stringify(context);
        return fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ key: "review", role: "reviewer", task: "Review the exact candidate", taskId: begun.taskId }] }, { id: "delegate-call" }), { stopReason: "toolUse" });
      },
      async (context) => {
        childContext = JSON.stringify(context);
        return fauxAssistantMessage("## 结论\n\nCandidate matches the supplied scalar shape");
      },
      async (context) => {
        finalParentContext = JSON.stringify(context);
        return fauxAssistantMessage("Main implementation retained; reviewer left business intent unchecked.");
      },
    ]);
    const created = await AgentHarness.create({
      session: parentSession,
      models,
      model: faux.models[0],
      systemPrompt: "You are the main Data Agent.",
      tools: [subagent],
      activeToolNames: ["subagent"],
      toolContext: { sessionId: "parent-session", principalId: "user-1" },
    }, TODO_CONTEXT);
    const lane = await created.harness.lane("main", TODO_CONTEXT);
    const accepted = await lane.accept({ kind: "prompt", prompt: "Delegate review then finish." }, TODO_CONTEXT);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw accepted.error;
    const driven = await lane.drive({ operationId: accepted.value.operationId }, TODO_CONTEXT);
    expect(driven.ok).toBe(true);
    expect((await ledger.list()).some((item) => item.state === "settled" && item.status === "completed")).toBe(true);
    expect(initialParentContext).toContain("PARENT_HISTORY_SECRET");
    expect(childContext).not.toContain("PARENT_HISTORY_SECRET");
    expect(finalParentContext).toContain("Candidate matches the supplied scalar shape");
    expect(finalParentContext).not.toContain("You are the Data Agent reviewer subagent");
    const taskAfterReview = await answering.inspect({ taskId: begun.taskId }, business("after-review"));
    expect(taskAfterReview.candidate?.candidateId).toBeTruthy();
    expect(taskAfterReview.publication).toBeUndefined();
    expect(taskAfterReview.task.lifecycle).toBe("open");
    const entries = await lane.findEntries(undefined, TODO_CONTEXT);
    expect(entries.some((entry: any) => entry.type === "message" && entry.message?.role === "assistant" && entry.message.content?.some((item: any) => item.type === "text" && item.text.includes("Main implementation retained")))).toBe(true);
    await delegation.close();
    await created.harness.close(TODO_CONTEXT);
  });

  it("collects two real child Harnesses from one bounded main-tool invocation", async () => {
    const faux = fauxProvider({ provider: "two-child-e2e", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentSession = await new MemorySessionRepo().create({ id: "parent-two" }, TODO_CONTEXT);
    faux.setResponses([
      fauxAssistantMessage("## 结论\n\nfirst child"),
      fauxAssistantMessage("## 结论\n\nsecond child"),
    ]);
    const delegation = new NativeDelegation({
      executor: new HarnessChildExecutor({ sessions: new MemoryChildSessionRepository(), models, model: faux.models[0] }),
      resolver: {
        async resolve(task) {
          return { targetRef: `subagent:${task.key}`, prompt: task.task, systemPrompt: "Return a Markdown report.", toolDefinitions: [], checkTarget: async () => ({ state: "current" as const, reasons: [] }) };
        },
      },
      ledger: new PiSessionDelegationLedger(parentSession),
    });
    const tool = createSubagentToolDefinition(delegation).tool as any;
    const memo = new Map<string, unknown>();
    const result = await tool.execute("delegate", { tasks: [
      { key: "one", role: "explorer", task: "first" },
      { key: "two", role: "explorer", task: "second" },
    ] }, undefined, { sessionId: "parent-two", principalId: "user-1" }, {
      invocationId: "main-tool-invocation", operationId: "main-operation", turnId: "turn",
      getMemo: async (name: string) => memo.get(name),
      setMemo: async (name: string, value: unknown) => { memo.set(name, value); },
    }, TODO_CONTEXT);
    expect(faux.state.callCount).toBe(2);
    expect(result.details).toHaveLength(2);
    expect(new Set(result.details.map((item: any) => item.childSessionId)).size).toBe(2);
    expect(result.details.every((item: any) => item.status === "completed")).toBe(true);
    await delegation.close();
    await parentSession.close(TODO_CONTEXT);
  });

  it("lets the main agent delegate exploration without a Query Task or the raw child tool trace", async () => {
    const faux = fauxProvider({ provider: "main-child-explorer-e2e", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const parentSession = await new MemorySessionRepo().create({ id: "parent-explorer" }, TODO_CONTEXT);
    const branch = await parentSession.createBranch("main", null, TODO_CONTEXT);
    const requestMessageId = await branch.appendMessage({ role: "user", content: "Inspect order count", timestamp: Date.now() }, TODO_CONTEXT);
    const rawTrace = `LARGE_CHILD_TOOL_TRACE_${"x".repeat(4_000)}`;
    let queryCalls = 0;
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => { throw new Error("ANSWERING_MUST_NOT_RUN"); } },
    });
    const sqlExplorer = { run: async () => { queryCalls += 1; return { columns: ["raw"], rows: [[rawTrace]], truncated: false, columnTypes: ["TEXT"] }; } };
    const ledger = new PiSessionDelegationLedger(parentSession);
    const delegation = new NativeDelegation({
      executor: new HarnessChildExecutor({ sessions: new MemoryChildSessionRepository(), models, model: faux.models[0] }),
      resolver: createQueryTaskDelegationResolver({ answering, ownerSession: parentSession, principalId: "user-1", ownerSessionId: "parent-explorer", sqlExplorer }),
      ledger,
    });
    let childAfterToolContext = "";
    let finalParentContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("subagent", { tasks: [{ key: "explore", role: "explorer", task: "Run a bounded count observation" }] }, { id: "delegate-explore" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("explore_sql", { sql: "SELECT COUNT(*) FROM orders", limit: 50 }, { id: "explore-call" }), { stopReason: "toolUse" }),
      async (context) => {
        childAfterToolContext = JSON.stringify(context);
        return fauxAssistantMessage("## 结论\n\nExploration produced a bounded observation");
      },
      async (context) => {
        finalParentContext = JSON.stringify(context);
        return fauxAssistantMessage("Main agent retained only the bounded exploration report.");
      },
    ]);
    const created = await AgentHarness.create({
      session: parentSession,
      models,
      model: faux.models[0],
      systemPrompt: "You are the main Data Agent.",
      tools: [createSubagentToolDefinition(delegation).tool],
      activeToolNames: ["subagent"],
      toolContext: { sessionId: "parent-explorer", principalId: "user-1", requestMessageId },
    }, TODO_CONTEXT);
    const lane = await created.harness.lane("main", TODO_CONTEXT);
    const accepted = await lane.accept({ kind: "prompt", prompt: "Delegate exploration then finish." }, TODO_CONTEXT);
    if (!accepted.ok) throw accepted.error;
    const driven = await lane.drive({ operationId: accepted.value.operationId }, TODO_CONTEXT);
    expect(driven.ok).toBe(true);
    expect(queryCalls).toBe(1);
    expect(childAfterToolContext).toContain("LARGE_CHILD_TOOL_TRACE_");
    expect(childAfterToolContext).toContain("Inspect order count");
    expect(finalParentContext).toContain("Exploration produced a bounded observation");
    expect(finalParentContext).not.toContain("LARGE_CHILD_TOOL_TRACE_");
    expect((await ledger.list()).some((item) => item.state === "settled" && item.status === "completed")).toBe(true);
    await delegation.close();
    await created.harness.close(TODO_CONTEXT);
  });
});
