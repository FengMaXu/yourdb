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
});
