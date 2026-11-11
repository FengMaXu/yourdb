import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PiJsonlSessionStore } from "../session-store.js";
import { WorkspaceStore } from "../workspace.js";
import { DataAgentSessionApplication } from "./host.js";
import type { DataAgentModelProfile } from "../agent/harness-factory.js";
import type { HypothesisChoiceAdvisor } from "../judgment/hypothesis-choice.js";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";

const profile: DataAgentModelProfile = { provider: "openai", model: "test-model", apiKey: "test" };
const invocation = (id: string) => ({
  invocationId: id,
  operationId: "pi-operation-1",
  turnId: "pi-turn-1",
  getMemo: async () => undefined,
  setMemo: async () => undefined,
});

const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": "one row per order", grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };

describe("DataAgent Session Application production composition", () => {
  it("never creates over a corrupt or inaccessible durable Session", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-open-error-"));
    let creates = 0;
    const application = new DataAgentSessionApplication({
      sessionStore: {
        create: async () => { creates += 1; throw new Error("MUST_NOT_CREATE"); },
        list: async () => [],
        open: async () => { throw new Error("SESSION_CORRUPT"); },
        openByAppSessionId: async () => { throw new Error("SESSION_CORRUPT"); },
      },
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      createMissingSessions: true,
      authorizeSession: async () => true,
    });
    try {
      await expect(application.session({ userId: "user-1", host: "web", sessionId: "session-1" })).rejects.toThrow("SESSION_CORRUPT");
      expect(creates).toBe(0);
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps one Session Host per user/session and rejects cross-user attachment", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-auth-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    try {
      await sessionStore.create({ sessionId: "session-1", userId: "user-1" });
      const application = new DataAgentSessionApplication({
        sessionStore,
        workspace: new WorkspaceStore(join(root, "workspace")),
        profile,
        systemPrompt: "You are Data Agent.",
        createMissingSessions: false,
        authorizeSession: async () => true,
      });
      const first = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const same = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      expect(same).toBe(first);
      const observations = [];
      const adapter = application.createAgentAdapter({ userId: "user-1", host: "web", sessionId: "session-1" });
      const stopObservations = adapter.subscribeObservations((observation) => observations.push(observation));
      await expect(adapter.getExecutionSnapshot()).resolves.toMatchObject({ sessionId: "session-1", current: null, lastOperationId: null });
      stopObservations();
      expect(observations).toEqual([]);
      expect(first.tools.map((tool) => tool.name)).not.toContain("subagent");
      await expect(application.session({ userId: "user-2", host: "web", sessionId: "session-1" })).rejects.toThrow("SESSION_ACCESS_DENIED");
      await application.close();
    } finally {
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers the bounded subagent tool only when explicitly enabled", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-subagent-tools-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    await sessionStore.create({ sessionId: "session-2" });
    const application = new DataAgentSessionApplication({
      sessionStore,
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      enableSubagents: ({ sessionId }) => sessionId === "session-1",
      delegationRoot: join(root, "subagents"),
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      expect(host.tools.map((tool) => tool.name)).toContain("subagent");
      expect((await host.harness.getTools(TODO_CONTEXT)).map((tool) => tool.name)).toContain("subagent");
      const disabled = await application.session({ userId: "user-1", host: "web", sessionId: "session-2" });
      expect(disabled.tools.map((tool) => tool.name)).not.toContain("subagent");
    } finally {
      await application.close();
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies Skill tool permissions to the native Pi lane", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-skill-tools-"));
    const skillRoot = join(root, "skills");
    const skillDir = join(skillRoot, "query-only");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: query-only\ndescription: query only\nallowed-tools:\n  - query_database\n  - unregistered_tool\n---\nquery instructions", "utf8");
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    const application = new DataAgentSessionApplication({
      sessionStore,
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      skillRoots: [skillRoot],
      enableSubagents: true,
      delegationRoot: join(root, "subagents"),
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      expect(await host.lane.getActiveTools(TODO_CONTEXT)).toContain("read_file");
      const loadSkill = host.tools.find((tool) => tool.name === "load_skill")! as any;
      await loadSkill.execute("load-skill", { name: "query-only" }, undefined, { sessionId: "session-1", principalId: "user-1" }, invocation("load-skill"), TODO_CONTEXT);
      const active = await host.lane.getActiveTools(TODO_CONTEXT);
      expect(active).toEqual(expect.arrayContaining([
        "load_skill",
        "set_answer_spec",
        "query_database",
        "publish_query_result",
        "export_query",
        "inspect_answer",
        "ask_user_clarification",
        "subagent",
      ]));
      expect(active).not.toEqual(expect.arrayContaining(["write_file", "run_python", "unregistered_tool"]));
    } finally {
      await application.close();
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps pinned protocol tools while applying each built-in Skill allowlist", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-built-in-skill-tools-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    const application = new DataAgentSessionApplication({
      sessionStore,
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      skillRoots: [join(process.cwd(), "..", "..", ".agents", "skills")],
      enableSubagents: true,
      delegationRoot: join(root, "subagents"),
      // With an advisor configured, no Skill may hide the Answering protocol tools.
      hypothesisChoiceAdvisor: { compare: async () => { throw new Error("not called"); } } satisfies HypothesisChoiceAdvisor,
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const loadSkill = host.tools.find((tool) => tool.name === "load_skill")! as any;
      for (const name of ["chart", "dashboard", "report"]) {
        await loadSkill.execute(`load-${name}`, { name }, undefined, { sessionId: "session-1", principalId: "user-1" }, invocation(`load-${name}`), TODO_CONTEXT);
        const active = await host.lane.getActiveTools(TODO_CONTEXT);
        expect(active).toEqual(expect.arrayContaining(["load_skill", "set_answer_spec", "query_database", "publish_query_result", "export_query", "inspect_answer", "ask_user_clarification", "subagent"]));
        expect(active).not.toContain("list_workspace");
      }
    } finally {
      await application.close();
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the neutral Query Task bootstrap only for the semantic-spec ablation arm", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-semantic-spec-ablation-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    const application = new DataAgentSessionApplication({
      sessionStore,
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      semanticSpecMode: "disabled",
      enableClarificationTool: false,
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const names = host.tools.map((tool) => tool.name);
      expect(names).toContain("begin_query_task");
      expect(names).not.toContain("set_answer_spec");
      expect(names).not.toContain("ask_user_clarification");
    } finally {
      await application.close();
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits the clarification tool in headless evaluation while keeping the query tools", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-headless-clarification-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    const application = new DataAgentSessionApplication({
      sessionStore,
      workspace: new WorkspaceStore(join(root, "workspace")),
      profile,
      systemPrompt: "You are Data Agent.",
      enableClarificationTool: false,
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const active = await host.lane.getActiveTools(TODO_CONTEXT);
      expect(active).not.toContain("ask_user_clarification");
      expect(active).toEqual(expect.arrayContaining(["set_answer_spec", "query_database", "export_query"]));
    } finally {
      await application.close();
      await sessionStore.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Pi Session Answering state and one shared publish path across restart", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-application-host-"));
    const sessionStore = new PiJsonlSessionStore(join(root, "sessions"));
    await sessionStore.create({ sessionId: "session-1" });
    let calls = 0;
    const create = (store: PiJsonlSessionStore, query: (sql: string, limit: number) => Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }>) => new DataAgentSessionApplication({
      sessionStore: store,
      workspace: new WorkspaceStore(join(root, "workspace")),
      resultRoot: join(root, "results"),
      profile,
      systemPrompt: "You are Data Agent.",
      queryExecutor: { run: query },
      createMissingSessions: false,
      authorizeSession: async () => true,
    });
    const application = create(sessionStore, async () => { calls += 1; return { columns: ["count"], rows: [[1]], truncated: false }; });
    try {
      const host = await application.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const names = host.tools.map((tool) => tool.name);
      expect(names).toContain("set_answer_spec");
      expect(names).toContain("query_database");
      expect(names).toContain("publish_query_result");
      expect(names).toContain("export_query");
      const context = { sessionId: "session-1", principalId: "user-1", requestMessageId: "user-message-1" };
      const update = host.tools.find((tool) => tool.name === "set_answer_spec")! as any;
      const query = host.tools.find((tool) => tool.name === "query_database")! as any;
      const publish = host.tools.find((tool) => tool.name === "publish_query_result")! as any;
      const began = await update.execute("call-begin", { fields: spec }, undefined, context, invocation("call-begin"), TODO_CONTEXT);
      expect(began.details.taskId).toMatch(/^task_/);
      const execution = await query.execute("call-result", { kind: "result", taskId: began.details.taskId, revisionId: began.details.revisionId, sql: "SELECT COUNT(*) FROM orders" }, undefined, context, invocation("call-result"), TODO_CONTEXT);
      expect(execution.details.artifact.kind).toBe("candidate");
      const receipt = await publish.execute("call-publish", { candidateId: execution.details.artifact.candidateId, format: "inline" }, undefined, context, invocation("call-publish"), TODO_CONTEXT);
      expect(receipt.details.format).toBe("inline");
      expect(receipt.details).not.toHaveProperty("content");
      expect(receipt.content[0].text).toContain("count");
      const publicationAdapter = application.createAgentAdapter({ userId: "user-1", host: "web", sessionId: "session-1" });
      const published = await publicationAdapter.readPublication(receipt.details.receiptId);
      const publishedSql = await publicationAdapter.readPublicationSql(receipt.details.receiptId);
      expect(published.summary.publicationId).toBe(receipt.details.receiptId);
      expect(published.content).toContain("count");
      expect(publishedSql.candidateId).toBe(execution.details.artifact.candidateId);
      expect(publishedSql.sql).toContain("SELECT COUNT(*)");
      expect(calls).toBe(1);
      await application.close();
      await sessionStore.close();

      const recoveredStore = new PiJsonlSessionStore(join(root, "sessions"));
      const recovered = create(recoveredStore, async () => { throw new Error("SQL_MUST_NOT_RUN_ON_INSPECT"); });
      const recoveredHost = await recovered.session({ userId: "user-1", host: "web", sessionId: "session-1" });
      const inspect = recoveredHost.tools.find((tool) => tool.name === "inspect_answer")! as any;
      const view = await inspect.execute("call-inspect", { taskId: began.details.taskId }, undefined, context, invocation("call-inspect"), TODO_CONTEXT);
      expect(view.details.publication.receiptId).toBe(receipt.details.receiptId);
      expect(calls).toBe(1);
      await recovered.close();
      await recoveredStore.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
