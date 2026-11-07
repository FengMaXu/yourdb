import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HarnessChildExecutor } from "./child-harness.js";
import { MemoryChildSessionRepository } from "./child-session-repo.js";
import { defineDataAgentTool } from "../tools/tool-definition.js";

function setup(options: Parameters<typeof fauxProvider>[0] = {}) {
  const faux = fauxProvider({ provider: `child-test-${Math.random()}`, models: [{ id: "child-model" }], ...options });
  const models = createModels();
  models.setProvider(faux.provider);
  const sessions = new MemoryChildSessionRepository();
  const executor = new HarnessChildExecutor({ sessions, models, model: faux.models[0] });
  return { faux, executor };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  runId: "run-1",
  childSessionId: "child-1",
  parentSessionId: "parent-1",
  role: "reviewer" as const,
  prompt: "Review only TARGET_MARKER.",
  systemPrompt: "Return JSON.",
  toolDefinitions: [],
  timeoutMs: 1_000,
  ...overrides,
});

describe("HarnessChildExecutor", () => {
  it("runs a fresh AgentHarness Session and returns the final assistant text and native usage", async () => {
    const { faux, executor } = setup();
    let providerContext = "";
    let maxTokens: number | undefined;
    faux.setResponses([async (context, options) => {
      providerContext = JSON.stringify(context);
      maxTokens = options?.maxTokens;
      return fauxAssistantMessage(JSON.stringify({ summary: "reviewed", findings: [], unchecked: ["intent"], questions: [] }));
    }]);
    const accepted: string[] = [];
    const result = await executor.execute(request({ onAccepted: (operationId: string) => { accepted.push(operationId); } }));
    expect(result).toMatchObject({ status: "completed", terminalConfirmed: true, text: expect.stringContaining("reviewed") });
    expect(result.usage.inputTokens).toBeTypeOf("number");
    expect(result.usage.outputTokens).toBeTypeOf("number");
    expect(result.usage.totalTokens).toBe(result.usage.inputTokens! + result.usage.outputTokens!);
    expect(result.usage.cost).toBeNull();
    expect(maxTokens).toBe(10_240);
    expect(accepted).toHaveLength(1);
    expect(providerContext).toContain("TARGET_MARKER");
    expect(providerContext).not.toContain("PARENT_HISTORY_SECRET");
    expect(providerContext).not.toContain("## 当前可用工具");
    await executor.close();
  });

  it("starts the deadline before child Session creation", async () => {
    const faux = fauxProvider({ provider: `child-admission-timeout-${Math.random()}`, models: [{ id: "child-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const executor = new HarnessChildExecutor({
      sessions: {
        async create(input) {
          return new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("SESSION_CREATE_CANCELLED")), { once: true });
          });
        },
        async open() { return undefined; },
        async removeOrphans() { return undefined; },
      },
      models,
      model: faux.models[0],
    });
    const started = Date.now();
    const result = await executor.execute(request({ timeoutMs: 20 }));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result).toMatchObject({ status: "timed_out", terminalConfirmed: true });
    expect(faux.state.callCount).toBe(0);
    await executor.close();
  });

  it("close cancels child Session creation before model admission", async () => {
    const faux = fauxProvider({ provider: `child-admission-close-${Math.random()}`, models: [{ id: "child-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let markStarted!: () => void;
    const startedCreating = new Promise<void>((resolve) => { markStarted = resolve; });
    const executor = new HarnessChildExecutor({
      sessions: {
        async create(input) {
          markStarted();
          return new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("SESSION_CREATE_CANCELLED")), { once: true });
          });
        },
        async open() { return undefined; },
        async removeOrphans() { return undefined; },
      },
      models,
      model: faux.models[0],
    });
    const running = executor.execute(request({ timeoutMs: 10_000 }));
    await startedCreating;
    const started = Date.now();
    await executor.close();
    expect(Date.now() - started).toBeLessThan(100);
    await expect(running).resolves.toMatchObject({ status: "interrupted", terminalConfirmed: true });
    expect(faux.state.callCount).toBe(0);
  });

  it("does not drive the model when accepted-operation persistence stalls past the deadline", async () => {
    const { faux, executor } = setup();
    faux.setResponses([fauxAssistantMessage("MUST_NOT_RUN")]);
    const started = Date.now();
    const result = await executor.execute(request({
      timeoutMs: 20,
      onAccepted: async () => new Promise<never>(() => undefined),
    }));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result).toMatchObject({ status: "timed_out", terminalConfirmed: true, operationId: expect.any(String) });
    expect(faux.state.callCount).toBe(0);
    await executor.close();
  });

  it("close settles an accepted child even when persistence does not return", async () => {
    const { faux, executor } = setup();
    faux.setResponses([fauxAssistantMessage("MUST_NOT_RUN")]);
    let markAccepted!: () => void;
    const accepted = new Promise<void>((resolve) => { markAccepted = resolve; });
    const running = executor.execute(request({
      timeoutMs: 10_000,
      onAccepted: async () => {
        markAccepted();
        return new Promise<never>(() => undefined);
      },
    }));
    await accepted;
    const started = Date.now();
    await executor.close();
    expect(Date.now() - started).toBeLessThan(100);
    await expect(running).resolves.toMatchObject({ status: "interrupted", terminalConfirmed: true, operationId: expect.any(String) });
    expect(faux.state.callCount).toBe(0);
  });

  it("requests native abort and confirms a timed-out terminal state", async () => {
    const { faux, executor } = setup({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ summary: "x".repeat(2_000), findings: [], unchecked: ["slow"], questions: [] }))]);
    const result = await executor.execute(request({ timeoutMs: 10 }));
    expect(result.status).toBe("timed_out");
    expect(result.terminalConfirmed).toBe(true);
    expect(result.operationId).toBeTruthy();
    await executor.close();
  }, 10_000);

  it("propagates an active parent cancellation to the exact child operation", async () => {
    const { faux, executor } = setup({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ summary: "x".repeat(2_000), findings: [], unchecked: ["slow"], questions: [] }))]);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 10);
    const result = await executor.execute(request({ signal: abort.signal, timeoutMs: 10_000 }));
    expect(result).toMatchObject({ status: "cancelled", terminalConfirmed: true, operationId: expect.any(String) });
    await executor.close();
  }, 10_000);

  it("aborts active children before executor close returns", async () => {
    const { faux, executor } = setup({ tokensPerSecond: 1 });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ summary: "x".repeat(2_000), findings: [], unchecked: ["slow"], questions: [] }))]);
    const running = executor.execute(request({ timeoutMs: 10_000 }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await executor.close();
    await expect(running).resolves.toMatchObject({ status: "interrupted", terminalConfirmed: true });
  }, 10_000);

  it("stops before an eleventh child model request", async () => {
    const { faux, executor } = setup();
    faux.setResponses(Array.from({ length: 11 }, (_, index) => fauxAssistantMessage(fauxToolCall("missing_tool", {}, { id: `missing-${index}` }), { stopReason: "toolUse" })));
    const result = await executor.execute(request({ timeoutMs: 10_000 }));
    expect(faux.state.callCount).toBe(10);
    expect(result).toMatchObject({ status: "failed", terminalConfirmed: true, error: expect.stringContaining("SUBAGENT_MODEL_REQUEST_BUDGET_EXHAUSTED") });
    await executor.close();
  });

  it("executes at most thirty child tools even when one response requests more", async () => {
    const { faux, executor } = setup();
    let calls = 0;
    let providerPrompt = "";
    const probe = {
      name: "probe",
      label: "probe",
      description: "bounded probe",
      replay: "safe" as const,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { calls += 1; return { content: [{ type: "text" as const, text: "ok" }] }; },
    };
    faux.setResponses([async (context) => {
      providerPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage(Array.from({ length: 31 }, (_, index) => fauxToolCall("probe", {}, { id: `probe-${index}` })), { stopReason: "toolUse" });
    }]);
    await executor.execute(request({ toolDefinitions: [defineDataAgentTool(probe, { promptSnippet: "执行有界测试探针。", promptGuidelines: [] })] }));
    expect(calls).toBe(30);
    expect(providerPrompt).toContain("`probe`：执行有界测试探针。");
    await executor.close();
  });

  it("turns the last allowed request into a tool-less final report", async () => {
    const { faux, executor } = setup();
    let finalTools: number | undefined;
    let finalPrompt = "";
    faux.setResponses([
      ...Array.from({ length: 9 }, (_, index) => fauxAssistantMessage(fauxToolCall("missing_tool", {}, { id: `missing-${index}` }), { stopReason: "toolUse" })),
      async (context) => {
        finalTools = context.tools?.length ?? 0;
        finalPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("## 结论\n\nBUDGET_REPORT_MARKER");
      },
    ]);
    const result = await executor.execute(request({ timeoutMs: 10_000 }));
    expect(finalTools).toBe(0);
    expect(finalPrompt).toContain("Write the final Markdown report now");
    expect(result).toMatchObject({ status: "completed", text: expect.stringContaining("BUDGET_REPORT_MARKER") });
    await executor.close();
  });

  it("writes its report at wrap-up instead of losing it to the deadline", async () => {
    const { faux, executor } = setup();
    let wrapUpAt: number | undefined;
    let reportTools: number | undefined;
    let reportPrompt = "";
    // Slow work that runs past the wrap-up moment, as a long query would.
    const slow = {
      name: "slow",
      label: "slow",
      description: "slow probe",
      replay: "safe" as const,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute(_id: string, _input: unknown, _update: unknown, context: { wrapUpAt?: number }) {
        wrapUpAt = context.wrapUpAt;
        await new Promise((resolve) => setTimeout(resolve, 1_700));
        return { content: [{ type: "text" as const, text: "partial facts" }] };
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("slow", {}, { id: "slow-1" }), { stopReason: "toolUse" }),
      async (context) => {
        reportTools = context.tools?.length ?? 0;
        reportPrompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("## 结论\n\nWRAP_UP_REPORT_MARKER");
      },
    ]);
    const started = Date.now();
    const result = await executor.execute(request({ timeoutMs: 2_000, toolDefinitions: [defineDataAgentTool(slow as never, { promptSnippet: "执行慢速测试探针。", promptGuidelines: [] })] }));
    // The tool learned when to stop: a quarter of a short deadline is kept for the report.
    expect(wrapUpAt! - started).toBeGreaterThanOrEqual(1_400);
    expect(wrapUpAt! - started).toBeLessThanOrEqual(1_600);
    expect(reportTools).toBe(0);
    expect(reportPrompt).toContain("Write the final Markdown report now");
    expect(result).toMatchObject({ status: "completed", text: expect.stringContaining("WRAP_UP_REPORT_MARKER") });
    await executor.close();
  });

  it("returns the final report, not the first reply's preamble, from a multi-turn child", async () => {
    const { faux, executor } = setup();
    const probe = {
      name: "probe",
      label: "probe",
      description: "bounded probe",
      replay: "safe" as const,
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return { content: [{ type: "text" as const, text: "ok" }] }; },
    };
    faux.setResponses([
      fauxAssistantMessage([{ type: "text", text: "I'll start by exploring the schema." }, fauxToolCall("probe", {}, { id: "probe-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Let me write the final report.\n\n## 结论\n\nFINAL_REPORT_MARKER"),
    ]);
    const started: string[] = [];
    const result = await executor.execute(request({ timeoutMs: 10_000, onToolStarted: (toolName: string) => started.push(toolName), toolDefinitions: [defineDataAgentTool(probe, { promptSnippet: "执行有界测试探针。", promptGuidelines: [] })] }));
    expect(result).toMatchObject({ status: "completed", text: expect.stringContaining("FINAL_REPORT_MARKER") });
    expect(result.text).not.toContain("I'll start by exploring");
    expect(started).toEqual(["probe"]);
    await executor.close();
  });

  it("keeps a report cut at the output cap instead of misreading it as a context overflow", async () => {
    const { faux, executor } = setup();
    faux.setResponses([async (_context, options) => fauxAssistantMessage(`## 结论

${"x".repeat((options?.maxTokens ?? 0) * 4)}`, { stopReason: "length" })]);
    const result = await executor.execute(request({ timeoutMs: 10_000 }));
    expect(result.error ?? "").not.toContain("context window");
    expect(result).toMatchObject({ status: "completed", text: expect.stringContaining("## 结论") });
    await executor.close();
  });

  it("does not create a model call when the parent signal is already aborted", async () => {
    const { faux, executor } = setup();
    const abort = new AbortController();
    abort.abort();
    const result = await executor.execute(request({ signal: abort.signal }));
    expect(result).toMatchObject({ status: "cancelled", terminalConfirmed: true });
    expect(faux.state.callCount).toBe(0);
    await executor.close();
  });
});
