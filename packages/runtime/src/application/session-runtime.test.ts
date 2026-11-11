import { describe, expect, it } from "vitest";
import { MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceStore } from "../workspace.js";
import { composeKnowledgeCatalogPrompt, composeSubagentSystemPrompt, createDataAgentSessionHost, type DataAgentModelProfile } from "./session-runtime.js";
import type { BusinessContext } from "../answering/model.js";
import { KnowledgeIndex } from "../knowledge.js";
import { ClarificationManager } from "../clarification.js";
import { InMemoryAnsweringStore } from "../answering/answering-store.js";
import type { CompareHypothesesInput, HypothesisChoiceAdvisor } from "../judgment/hypothesis-choice.js";

const profile: DataAgentModelProfile = { provider: "openai", model: "test-model", apiKey: "test" };
const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };

const business = (invocationId: string, scope?: { readonly scopeId: string; readonly connectionId: string }): BusinessContext => ({
  principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId,
  ...(scope ? { queryScope: scope } : {}),
});

describe("Session Runtime scoped query composition", () => {
  it("does not load a protocol Skill whose required tools are absent in the ablation arm", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-skills-"));
    const skillRoot = path.join(root, "skills");
    await mkdir(path.join(skillRoot, "spec"), { recursive: true });
    await writeFile(path.join(skillRoot, "spec", "SKILL.md"), ["---", "name: spec", "description: protocol", "requires-tools:", "  - set_answer_spec", "---", "ANSWER SPEC BODY"].join("\n"), "utf8");
    const invocation = { invocationId: "invoke-skill", operationId: "operation-1", turnId: "turn-1", getMemo: async () => undefined, setMemo: async () => undefined };
    const context = { sessionId: "session-1", principalId: "user-1" };
    const hosts = await Promise.all((["required", "disabled"] as const).map((semanticSpecMode) => createDataAgentSessionHost({
      sessionId: "session-1",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, `workspace-${semanticSpecMode}`)),
      profile,
      systemPrompt: "You are Data Agent.",
      skillRoots: [skillRoot],
      semanticSpecMode,
    })));
    try {
      const [required, disabled] = hosts as [typeof hosts[number], typeof hosts[number]];
      const load = (host: typeof required) => host.tools.find((tool) => tool.name === "load_skill")!;
      await expect(load(required).execute("load", { name: "spec" }, undefined, context, invocation, TODO_CONTEXT)).resolves.toMatchObject({ content: [{ text: "ANSWER SPEC BODY" }] });
      await expect(load(disabled).execute("load", { name: "spec" }, undefined, context, invocation, TODO_CONTEXT)).rejects.toThrow("SKILL_NOT_FOUND");
    } finally {
      await Promise.all(hosts.map((host) => host.close()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("admits only composition-authorized documents and real Session user text as evidence", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-evidence-"));
    const knowledgeRoot = path.join(root, "knowledge");
    await mkdir(path.join(knowledgeRoot, "doc"), { recursive: true });
    await writeFile(path.join(knowledgeRoot, "doc", "business.md"), ["---", "knowledgeId: business-definitions", "name: 业务定义", "description: test", "---", "", "订单数按订单实体计数，取消订单不计入。", ""].join("\n"), "utf8");
    await writeFile(path.join(knowledgeRoot, "doc", "rules.md"), ["---", "knowledgeId: sql-rules", "name: SQL 规范", "description: test", "---", "", "计数时使用 COUNT(DISTINCT key)。", ""].join("\n"), "utf8");
    const knowledge = new KnowledgeIndex({ requireMetadata: true });
    await knowledge.loadDirectory(knowledgeRoot);
    const session = await new MemorySessionRepo().create({ id: "session-evidence" }, TODO_CONTEXT);
    const branch = await session.createBranch("main", null, TODO_CONTEXT);
    const requestMessageId = await branch.appendMessage({ role: "user", content: "统计有效订单数", timestamp: Date.now() }, TODO_CONTEXT);
    const host = await createDataAgentSessionHost({
      session,
      sessionId: "session-1",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, "workspace")),
      knowledge,
      answeringEvidenceDocuments: { "business-definitions": "reviewed_definition" },
      profile,
      systemPrompt: "You are Data Agent.",
    });
    try {
      const begun = await host.answering.set({
        requestMessageId,
        requestId: "begin-evidence",
        fields: {
          ...spec,
          "population.entity": { value: "orders", basis: "request", quote: "有效订单数" },
          "population.conditions": { value: ["status <> 'cancelled'"], cite: [{ source: "knowledge:business-definitions", quote: "取消订单不计入" }] },
        },
      }, business("begin-evidence"));
      expect(begun.outcomes?.every((item) => item.status === "applied")).toBe(true);
      expect(begun.fields.find((item) => item.path === "population.entity")).toMatchObject({ status: "request" });
      expect(begun.fields.find((item) => item.path === "population.conditions")).toMatchObject({ status: "evidence" });
      const rules = await host.answering.set({
        requestMessageId,
        requestId: "begin-rules-as-definition",
        fields: { ...spec, "population.conditions": { value: ["distinct keys"], cite: [{ source: "knowledge:sql-rules", quote: "COUNT(DISTINCT key)" }] } },
      }, business("begin-rules-as-definition"));
      expect(rules.outcomes?.find((item) => item.path === "population.conditions")).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
      const wrong = await host.answering.set({
        requestMessageId,
        requestId: "begin-wrong-quote",
        fields: { ...spec, "population.entity": { value: "orders", basis: "request", quote: "全部订单数" } },
      }, business("begin-wrong-quote"));
      expect(wrong.outcomes?.find((item) => item.path === "population.entity")).toMatchObject({ status: "rejected", code: "EVIDENCE_REJECTED" });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("injects the Knowledge Catalog without injecting document bodies", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-catalog-"));
    try {
      await (await import("node:fs/promises")).writeFile(path.join(root, "guide.md"), "---\nknowledgeId: semantic-guide\nname: Semantic Guide\ndescription: Seven-slot query semantics.\n---\n\n# Guide\n\nbody text", "utf8");
      const knowledge = new KnowledgeIndex({ requireMetadata: true });
      await knowledge.loadDirectory(root);
      const prompt = composeKnowledgeCatalogPrompt("BASE", knowledge);
      expect(prompt).toContain("semantic-guide");
      expect(prompt).toContain("Seven-slot query semantics.");
      expect(prompt).not.toContain("body text");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("groups the catalog into method guides and delegated facts when subagents are enabled", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-catalog-groups-"));
    try {
      const { writeFile: write } = await import("node:fs/promises");
      await write(path.join(root, "guide.md"), "---\nknowledgeId: semantic-guide\nname: Semantic Guide\ndescription: Method.\nusage: method\n---\n\nbody", "utf8");
      await write(path.join(root, "schema.md"), "---\nknowledgeId: database-schema\nname: Schema\ndescription: Tables.\n---\n\nbody", "utf8");
      const knowledge = new KnowledgeIndex({ requireMetadata: true });
      await knowledge.loadDirectory(root);
      const grouped = composeKnowledgeCatalogPrompt("BASE", knowledge, { delegation: true });
      const direct = grouped.indexOf("你可直接读取");
      const delegated = grouped.indexOf("通过子 Agent 获取");
      expect(direct).toBeGreaterThan(0);
      expect(delegated).toBeGreaterThan(direct);
      expect(grouped.slice(direct, delegated)).toContain("semantic-guide");
      expect(grouped.slice(delegated)).toContain("database-schema");
      const flat = composeKnowledgeCatalogPrompt("BASE", knowledge);
      expect(flat).not.toContain("通过子 Agent 获取");
      expect(flat).toContain("database-schema");
      await write(path.join(root, "bad.md"), "---\nknowledgeId: bad-usage\nname: Bad\ndescription: Bad.\nusage: sometimes\n---\n\nbody", "utf8");
      await expect(new KnowledgeIndex({ requireMetadata: true }).loadDirectory(root)).rejects.toThrow("KNOWLEDGE_METADATA_INVALID_USAGE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes fact gathering to explorers while the main agent keeps every decision", () => {
    const prompt = composeSubagentSystemPrompt("BASE");
    expect(prompt.startsWith("BASE")).toBe(true);
    expect(prompt).toContain("业务定义（business-definitions）、数据库结构（database-schema）");
    expect(prompt).toContain("已验证查询模版（query-patterns）");
    expect(prompt).toContain("由你决定");
    expect(prompt).toContain("方法类知识");
    expect(prompt).toContain("MECE");
    expect(prompt).toContain("每个子任务只回答一个问题");
    expect(prompt).not.toContain("untrusted");
  });

  it("lets the user's answer to a clarification confirm the Spec, verified against the answer the Session recorded", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-clarification-"));
    const manager = new ClarificationManager(5000);
    const answeringStore = new InMemoryAnsweringStore();
    const session = await new MemorySessionRepo().create({ id: "session-clarification" }, TODO_CONTEXT);
    const branch = await session.createBranch("main", null, TODO_CONTEXT);
    const requestMessageId = await branch.appendMessage({ role: "user", content: "统计订单量", timestamp: Date.now() }, TODO_CONTEXT);
    const host = await createDataAgentSessionHost({
      session,
      sessionId: "session-1",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      clarifications: manager,
      answeringStore,
    });
    const toolContext = { sessionId: "session-1", principalId: "user-1", requestMessageId };
    const memo = new Map<string, unknown>();
    const call = (id: string) => ({
      invocationId: id, operationId: "operation-1", turnId: "turn-1",
      getMemo: async (key: string) => memo.get(key),
      setMemo: async (key: string, value: unknown) => { memo.set(key, value); },
    });
    try {
      const begun = await host.answering.set({ requestMessageId, requestId: "begin-clarification", fields: spec }, business("begin-clarification"));
      const ask = host.tools.find((item) => item.name === "ask_user_clarification")!;
      const asking = ask.execute("call-ask", { question: "订单量按哪种订单统计？", options: ["全部下单订单", "仅已送达订单"] }, undefined, toolContext, call("invoke-ask"), TODO_CONTEXT);
      const pending = manager.pendingFor("session-1");
      if (!pending) throw new Error("clarification not asked");
      manager.answer(pending.clarificationId, "全部下单订单");
      const answered = await asking;
      // The answer and the id to cite it by come back together.
      expect(JSON.stringify(answered.content)).toContain(`clarificationId=${pending.clarificationId}`);

      const set = host.tools.find((item) => item.name === "set_answer_spec")!;
      const cite = (quote: string) => ({ taskId: begun.taskId, fields: { "population.conditions": { value: ["全部下单订单"], cite: [{ source: `clarification:${pending.clarificationId}`, quote }], reason: "用户澄清了订单范围" } } });
      const wrong = await set.execute("call-wrong", cite("仅已送达订单"), undefined, toolContext, call("invoke-wrong"), TODO_CONTEXT);
      expect(JSON.stringify(wrong.content)).toMatch(/not found verbatim in the user's answer/);
      await set.execute("call-revise", cite("全部下单订单"), undefined, toolContext, call("invoke-revise"), TODO_CONTEXT);
      const admitted = await answeringStore.transact((state) => state.listEvidence(begun.taskId), business("read-evidence"));
      expect(admitted).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: "user_confirmation",
        sourceRef: `clarification:${pending.clarificationId}`,
        quote: "全部下单订单",
        verification: expect.objectContaining({ method: "clarification_answer_quote" }),
      })]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("asks the configured Jev advisor with the exact Session request once an open field's probes differ", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-jev-"));
    const observed: CompareHypothesesInput[] = [];
    const advisor: HypothesisChoiceAdvisor = {
      compare: async (input) => {
        observed.push(input);
        return {
          model: "jev-test",
          recommendation: { kind: "insufficient_evidence" },
          probabilities: input.hypotheses.map((item) => ({ hypothesisId: item.id, probability: 0.1 })),
          abstentionProbabilities: { insufficientEvidence: 0.6, multiplePlausible: 0.1, noneSupported: 0.1 },
          confidence: 0.5,
        };
      },
    };
    const session = await new MemorySessionRepo().create({ id: "session-jev" }, TODO_CONTEXT);
    const branch = await session.createBranch("main", null, TODO_CONTEXT);
    const requestMessageId = await branch.appendMessage({ role: "user", content: "年度月均收入如何计算？", timestamp: Date.now() }, TODO_CONTEXT);
    const host = await createDataAgentSessionHost({
      session,
      sessionId: "session-1",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      hypothesisChoiceAdvisor: advisor,
      queryExecutor: { run: async (sql) => ({ columns: ["n"], rows: [[sql.includes("twelve") ? 12 : 9]], truncated: false }) },
    });
    try {
      // The comparison is the Runtime's own step, not a model tool.
      expect(host.tools.some((item) => item.name === "compare_hypotheses")).toBe(false);
      const begun = await host.answering.set({
        requestMessageId,
        requestId: "begin-jev",
        fields: { ...spec, "measure.denominator": { open: ["按十二个月计算", "按有记录月份计算"] } },
      }, business("begin-jev"));
      const [twelve, recorded] = begun.fields.find((item) => item.path === "measure.denominator")!.alternatives!.map((item) => item.id as string);
      await host.answering.execute({ kind: "exploration", taskId: begun.taskId, sql: "SELECT twelve", probe: { path: "measure.denominator", alternativeId: twelve! } }, business("probe-twelve"));
      expect(observed).toHaveLength(0);
      const last = await host.answering.execute({ kind: "exploration", taskId: begun.taskId, sql: "SELECT recorded", probe: { path: "measure.denominator", alternativeId: recorded! } }, business("probe-recorded"));
      expect(observed).toHaveLength(1);
      expect(last.probe).toMatchObject({ advice: { recommendation: "insufficient_evidence" } });
      expect(observed[0]).toMatchObject({
        originalQuestion: "年度月均收入如何计算？",
        hypotheses: [{ statement: "measure.denominator: 按十二个月计算" }, { statement: "measure.denominator: 按有记录月份计算" }],
        evidence: [{ kind: "request_wording", content: "年度月均收入如何计算？" }, { id: "probe_outputs" }],
      });
      const unchanged = await host.answering.inspect({ taskId: begun.taskId }, business("inspect-after-jev"));
      expect(unchanged.currentRevision.fields["measure.denominator"]).toMatchObject({ state: "open" });
      expect(unchanged.task.currentRevisionId).toBe(begun.revisionId);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes the executor Schema and dialect into the Answering fanout check", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-fanout-"));
    const calls: string[] = [];
    const session = await new MemorySessionRepo().create({ id: "session-fanout" }, TODO_CONTEXT);
    const host = await createDataAgentSessionHost({
      session,
      sessionId: "session-fanout",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      queryExecutor: {
        dialect: "sqlite",
        getSchema: async () => ({ dialect: "sqlite", tables: [
          { name: "customers", columns: ["customer_id"], primaryKey: ["customer_id"] },
          { name: "rental", columns: ["rental_id", "customer_id"], primaryKey: ["rental_id"] },
        ] }),
        run: async (sql, _limit, options) => {
          calls.push(options?.kind ?? "unknown");
          if (sql.includes("_data_agent_source_keys")) return { columns: ["source_rows", "source_non_null_keys", "source_distinct_keys", "joined_rows", "joined_non_null_keys", "joined_distinct_keys"], rows: [[1, 1, 1, 2, 2, 1]], truncated: false };
          return { columns: ["n"], rows: [[2]], truncated: false };
        },
      },
    });
    try {
      const begun = await host.answering.set({ requestMessageId: "request-fanout", requestId: "begin-fanout", fields: { ...spec, "population.entity": "customer", output: { rowMode: "scalar", rowCount: 1, columns: ["n"] } } }, business("begin-fanout"));
      const result = await host.answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(c.customer_id) AS n FROM customers c JOIN rental r ON r.customer_id = c.customer_id" }, business("result-fanout"));
      expect(result.fanout).toMatchObject({ status: "finding" });
      expect(calls).toEqual(["result", "exploration"]);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes a delegated exploration only through the explicitly scoped executor", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-session-runtime-scope-"));
    const scope = { scopeId: "scope-1", connectionId: "connection-1" };
    let genericCalls = 0;
    let scopedCalls = 0;
    let receivedOptions: unknown;
    const session = await new MemorySessionRepo().create({ id: "session-1" }, TODO_CONTEXT);
    const host = await createDataAgentSessionHost({
      session,
      sessionId: "session-1",
      principalId: "user-1",
      workspace: new WorkspaceStore(path.join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      queryExecutor: {
        run: async () => { genericCalls += 1; throw new Error("UNSCOPED_EXECUTOR_MUST_NOT_RUN"); },
        scopedExploration: {
          scope,
          run: async (_sql, _limit, options) => {
            scopedCalls += 1;
            receivedOptions = options;
            return { columns: ["n"], rows: [[1]], truncated: false, columnTypes: ["INTEGER"] };
          },
        },
      },
    });
    try {
      expect(host.tools.some((item) => item.name === "compare_hypotheses")).toBe(false);
      const begun = await host.answering.set({ requestMessageId: "request-1", requestId: "begin-1", fields: spec }, business("begin-1"));
      const explored = await host.answering.execute({ kind: "exploration", taskId: begun.taskId, sql: "SELECT 1", limit: 1, maxPreviewBytes: 4 * 1024 }, business("explore-1", scope));
      expect(explored.artifact.kind).toBe("exploration");
      expect(scopedCalls).toBe(1);
      expect(genericCalls).toBe(0);
      expect(receivedOptions).toMatchObject({ kind: "exploration", scope, maxPreviewBytes: 4 * 1024 });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
