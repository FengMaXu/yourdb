import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataAgentRuntime } from "./protocol.js";
import { MetadataStore } from "./metadata.js";

const context = { userId: "local", host: "electron" as const };

describe("protocol application host", () => {
  it("dispatches a versioned runtime probe and retains only transport replay data", async () => {
    const runtime = new DataAgentRuntime();
    const events: unknown[] = [];
    runtime.subscribe((event) => events.push(event), { userId: "local" });
    const result = await runtime.dispatch({ protocolVersion: 1, requestId: "req-1", command: { type: "runtime.probe" } }, context);
    expect(result.response.type).toBe("runtime.probe.result");
    expect(events).toHaveLength(1);
    expect(runtime.replayAfter(0, { userId: "local" })).toMatchObject({ events: [expect.anything()], complete: true });
    expect(runtime.replayAfter(1, { userId: "local" })).toEqual({ events: [], complete: true });
  });

  it("reports an incomplete replay once events after the cursor were evicted", async () => {
    const runtime = new DataAgentRuntime();
    for (let index = 0; index < 300; index += 1) {
      await runtime.dispatch({ protocolVersion: 1, requestId: `req-${index}`, command: { type: "runtime.probe" } }, context);
    }
    const stale = runtime.replayAfter(10, { userId: "local" });
    expect(stale.complete).toBe(false);
    expect(stale.events).toHaveLength(256);
    expect(runtime.replayAfter(44, { userId: "local" }).complete).toBe(true);
    expect(runtime.replayAfter(300, { userId: "local" })).toEqual({ events: [], complete: true });
  });

  it("names its event stream by instance, so a cursor from another process is recognizable", async () => {
    const runtime = new DataAgentRuntime();
    await runtime.dispatch({ protocolVersion: 1, requestId: "req-1", command: { type: "runtime.probe" } }, context);
    const position = runtime.eventStreamPosition();
    expect(position.latestSequence).toBe(1);
    expect(position.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(runtime.eventStreamPosition().instanceId).toBe(position.instanceId);
    expect(new DataAgentRuntime().eventStreamPosition().instanceId).not.toBe(position.instanceId);
  });

  it("requires a native Application Agent adapter to return an operation identity", async () => {
    const runtime = new DataAgentRuntime({ agent: { prompt: async () => ({ operationId: "pi-operation-1" }) } });
    const result = await runtime.dispatch({ protocolVersion: 1, requestId: "prompt", command: { type: "agent.prompt", prompt: "hello" } }, context);
    expect(result.response).toEqual({ type: "agent.prompt.accepted", runId: "pi-operation-1" });
  });

  it("refreshes model resources without rebuilding an Agent runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "data-agent-runtime-skills-"));
    try {
      const skillDir = join(dir, "refreshable");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), "---\nname: refreshable\ndescription: refresh test\n---\nbody", "utf8");
      await mkdir(join(dir, "broken"), { recursive: true });
      await writeFile(join(dir, "broken", "SKILL.md"), "not a skill", "utf8");
      let resources: { skills?: readonly unknown[] } = {};
      const agent = {
        prompt: async () => ({ operationId: "pi-operation" }),
        getResources: () => resources,
        setResources: async (next: { skills?: readonly unknown[] }) => { resources = next; },
      };
      const runtime = new DataAgentRuntime({ agent, skillRoots: [dir] });
      const result = await runtime.dispatch({ protocolVersion: 1, requestId: "skills", command: { type: "skills.list" } }, context);
      expect((result.response as { skills: unknown[] }).skills).toEqual([{ name: "refreshable", description: "refresh test", tools: [] }]);
      expect((result.response as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0);
      expect((resources.skills?.[0] as { content: string }).content).toBe("body");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported versions and unsafe knowledge paths", async () => {
    const runtime = new DataAgentRuntime();
    await expect(runtime.dispatch({ protocolVersion: 99, requestId: "bad", command: { type: "runtime.probe" } }, context)).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL_VERSION" });
    const dir = await mkdtemp(join(tmpdir(), "data-agent-knowledge-path-"));
    const metadata = new MetadataStore(join(dir, "app.db"));
    try {
      const knowledge = new DataAgentRuntime({ metadata, knowledgeRoot: join(dir, "knowledge") });
      await expect(knowledge.dispatch({ protocolVersion: 1, requestId: "escape", command: { type: "knowledge.save", path: "../knowledge-evil/escape.md", content: "nope" } }, context)).rejects.toMatchObject({ code: "INVALID_COMMAND" });
      await expect(knowledge.dispatch({ protocolVersion: 1, requestId: "system", command: { type: "knowledge.save", path: ".pi\\SYSTEM.md", content: "nope" } }, context)).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    } finally {
      await metadata.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps desktop LLM secrets out of protocol responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "data-agent-desktop-config-"));
    const metadata = new MetadataStore(join(dir, "app.sqlite3"));
    try {
      const runtime = new DataAgentRuntime({ metadata, pythonExecutable: "bundled-python", bundledPythonExecutable: "bundled-python" });
      const saved = await runtime.dispatch({ protocolVersion: 1, requestId: "config", command: { type: "config.save", patch: { provider: "openai", model: "test", api_key: "secret", python_runtime: { mode: "external", executable: "custom-python" } } } }, context);
      expect((saved.response as { config?: Record<string, unknown> }).config).toEqual({ provider: "openai", model: "test", python_runtime: { mode: "external", executable: "custom-python" } });
      expect(await metadata.getConfig("ui.settings")).toEqual({ provider: "openai", model: "test", python_runtime: { mode: "external", executable: "custom-python" } });
      expect(runtime.pythonExecutablePath).toBe("custom-python");
    } finally {
      await metadata.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates the demo database once and makes it the saved connection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "data-agent-sample-db-"));
    const metadata = new MetadataStore(join(dir, "app.sqlite3"));
    try {
      const runtime = new DataAgentRuntime({ metadata });
      const saved: Array<Record<string, unknown>> = [];
      runtime.onConfigSaved = (config) => { saved.push(config); };
      await expect(runtime.dispatch({ protocolVersion: 1, requestId: "none", command: { type: "db.sample" } }, context)).rejects.toThrow("SAMPLE_DATABASE_NOT_CONFIGURED");
      runtime.sampleDatabaseRoot = join(dir, "samples");
      await runtime.dispatch({ protocolVersion: 1, requestId: "keep", command: { type: "config.save", patch: { model: "m", host: "db.example" } } }, context);
      const first = await runtime.dispatch({ protocolVersion: 1, requestId: "s1", command: { type: "db.sample" } }, context);
      const database = ((first.response as { details?: { database?: string } }).details?.database)!;
      expect(first.response).toMatchObject({ type: "test.result", success: true });
      expect(await metadata.getConfig("ui.settings")).toEqual({ model: "m", host: "db.example", driver: "sqlite", database });
      expect(saved.at(-1)).toMatchObject({ driver: "sqlite", database });

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(database, { readOnly: true });
      const orders = (db.prepare("SELECT COUNT(*) AS n, MIN(order_date) AS first, MAX(order_date) AS last FROM orders").get() as { n: number; first: string; last: string });
      const unmatched = (db.prepare("SELECT COUNT(*) AS n FROM order_items i LEFT JOIN orders o USING (order_id) WHERE o.order_id IS NULL").get() as { n: number }).n;
      db.close();
      expect(orders.n).toBeGreaterThan(2000);
      // Two years up to the day it is made, so questions about recent months find data.
      const today = new Date();
      const firstDay = new Date(Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), 1)).toISOString().slice(0, 10);
      expect(orders.first).toBe(firstDay);
      expect(orders.last <= today.toISOString().slice(0, 10)).toBe(true);
      expect(orders.last >= new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)).toBe(true);
      expect(unmatched).toBe(0);

      const second = await runtime.dispatch({ protocolVersion: 1, requestId: "s2", command: { type: "db.sample" } }, context);
      expect((second.response as { details?: { database?: string } }).details?.database).toBe(database);
    } finally {
      await metadata.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tests the saved model when asked with an empty profile", async () => {
    const runtime = new DataAgentRuntime({});
    const tested: Array<Record<string, unknown>> = [];
    runtime.llmTester = { test: async (profile) => { tested.push(profile); return { success: true, message: "ok" }; } };
    runtime.savedModelProfile = async () => ({ provider: "anthropic", model: "saved", api_key: "desktop-secret" });
    await runtime.dispatch({ protocolVersion: 1, requestId: "a", command: { type: "llm.test", profile: {} } }, context);
    await runtime.dispatch({ protocolVersion: 1, requestId: "b", command: { type: "llm.test", profile: { provider: "openai", model: "typed", api_key: "k" } } }, context);
    expect(tested).toEqual([{ provider: "anthropic", model: "saved", api_key: "desktop-secret" }, { provider: "openai", model: "typed", api_key: "k" }]);

    runtime.savedModelProfile = async () => { throw new Error("LLM_NOT_CONFIGURED: add a model API key"); };
    const missing = await runtime.dispatch({ protocolVersion: 1, requestId: "c", command: { type: "llm.test", profile: {} } }, context);
    expect(missing.response).toEqual({ type: "test.result", success: false, message: "LLM_NOT_CONFIGURED: add a model API key" });
  });
});
