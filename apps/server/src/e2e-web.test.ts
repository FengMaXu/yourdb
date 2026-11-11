import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeServer } from "./index.js";
import { DataAgentRuntime, MetadataStore } from "@data-agent/runtime/testing";
import { PiJsonlSessionStore } from "../../../packages/runtime/src/session-store.js";

describe("Web Application Host end-to-end", () => {
  let app: Awaited<ReturnType<typeof createRuntimeServer>>;
  let root = "";
  let token = "";

  const command = (type: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/runtime/command",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: { protocolVersion: 1, requestId: `req-${Date.now()}-${Math.random()}`, command: { type, ...extra } },
    });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "e2e-web-"));
    const metadata = new MetadataStore(path.join(root, "metadata.db"));
    const knowledgeRoot = path.join(root, "knowledge");
    await mkdir(knowledgeRoot, { recursive: true });
    const sessions = new PiJsonlSessionStore(path.join(root, "sessions"));
    const runtime = new DataAgentRuntime({ metadata, sessions, knowledgeRoot, agent: { prompt: async () => ({ operationId: "test-operation" }), getTranscript: async () => [] } } as never);
    app = await createRuntimeServer(runtime);
    await app.ready();
  });

  it("covers auth, tasks, sessions, knowledge, and config", async () => {
    // auth
    await app.inject({ method: "POST", url: "/auth/register", payload: { username: "alice", password: "secret123" } });
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "alice", password: "secret123" } });
    expect(login.statusCode).toBe(200);
    const loginPayload = login.json() as { user: unknown; token: string };
    expect(loginPayload.user).toBeTruthy();
    token = loginPayload.token;

    // task + session lifecycle
    const created = await command("task.create", { name: "E2E" });
    const taskId = created.json().response.item.id;
    const sessionCreated = await command("session.create", { taskId, name: "S1" });
    expect(sessionCreated.json().response.type).toBe("mutation.result");
    const sessionId = sessionCreated.json().response.item.id;
    const listed = await command("task.list");
    expect(listed.json().response.items.some((item: { id: string }) => item.id === taskId)).toBe(true);

    // transcript projection (empty but valid)
    const transcript = await command("session.transcript", { sessionId });
    if (!transcript.json().response) console.error("E2E-DEBUG2", JSON.stringify(transcript.json()));
    expect(transcript.json().response).toMatchObject({ type: "session.transcript.result", messages: [] });

    // knowledge list + save + search
    const saved = await command("knowledge.save", { path: "docs/note.md", content: "# note\nhello world" });
    if (!saved.json().response) console.error("DEBUG3", JSON.stringify(saved.json()));
    expect(saved.json().response).toMatchObject({ type: "knowledge.save.result" });
    const knowledgeList = await command("knowledge.list");
    expect(knowledgeList.json().response.files.some((f: { path: string }) => f.path === "docs/note.md")).toBe(true);

    // settings round-trip
    await command("config.save", { patch: { mysql_host: "localhost" } });
    const cfg = await command("config.get");
    expect(cfg.json().response.config.mysql_host).toBe("localhost");

    // skills listing
    const skills = await command("skills.list");
    expect(skills.json().response.type).toBe("skills.list.result");

    // mcp config round-trip
    await command("mcp.config.save", { config: { servers: [] } });
    const mcpcfg = await command("mcp.config.get");
    expect(mcpcfg.json().response.config).toEqual({ servers: [] });

  });

  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  });
});
