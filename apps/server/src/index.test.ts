import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "@data-agent/runtime/testing";
import { createRuntimeServer } from "./index.js";
import { WorkspaceStore } from "@data-agent/runtime/testing";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

 const trustedWebContext = { contextFactory: () => ({ userId: "web-dev", host: "web" as const }) };

 describe("Fastify Host", () => {
  it("supports Web registration and Bearer-token login", async () => {
    const app = await createRuntimeServer(new DataAgentRuntime());
    const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "alice", password: "secret" } });
    expect(registered.statusCode).toBe(200);
    const loggedIn = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "alice", password: "secret" } });
    expect(loggedIn.statusCode).toBe(200);
    expect(loggedIn.json().token).toEqual(expect.any(String));
    await app.close();
  });

  it("rejects runtime commands without authentication by default", async () => {
    const app = await createRuntimeServer(new DataAgentRuntime());
    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/command",
      payload: { protocolVersion: 1, requestId: "unauthenticated", command: { type: "runtime.probe" } },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "AUTH_REQUIRED" } });
    await app.close();
  });

  it("dispatches the same runtime probe contract as Electron", async () => {
    const app = await createRuntimeServer(new DataAgentRuntime(), trustedWebContext);

    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/command",
      payload: {
        protocolVersion: 1,
        requestId: "req-1",
        command: { type: "runtime.probe" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      protocolVersion: 1,
      requestId: "req-1",
      response: { type: "runtime.probe.result" },
    });
    await app.close();
  });

  it("uploads a Workspace file through the dedicated multipart route", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-server-workspace-"));
    const app = await createRuntimeServer(new DataAgentRuntime(), { ...trustedWebContext, workspace: new WorkspaceStore(root) });
    const form = new FormData(); form.append("file", new Blob(["hello"]), "hello.txt");
    const response = await app.inject({ method: "POST", url: "/api/workspace/upload", payload: form as any, headers: { "content-type": "multipart/form-data" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ filename: "hello.txt", relative_path: "hello.txt", size: 5 });
    expect(await readFile(join(root, "hello.txt"), "utf8")).toBe("hello");
    await app.close(); await rm(root, { recursive: true, force: true });
  });

  it("stores uploads inside the requested session workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-server-session-upload-"));
    const app = await createRuntimeServer(new DataAgentRuntime(), { ...trustedWebContext, workspace: new WorkspaceStore(root) });
    const form = new FormData(); form.append("file", new Blob(["isolated"]), "report.txt");

    const response = await app.inject({ method: "POST", url: "/api/workspace/upload?session_id=session-A", payload: form as any, headers: { "content-type": "multipart/form-data" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ relative_path: "report.txt", session_id: "session-A" });
    expect(await readFile(join(root, "session-A", "report.txt"), "utf8")).toBe("isolated");
    await expect(readFile(join(root, "report.txt"), "utf8")).rejects.toThrow();
    await app.close(); await rm(root, { recursive: true, force: true });
  });

  it("lets a prompt reference a file uploaded to the same session", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-server-attachment-"));
    const workspace = new WorkspaceStore(root);
    const prompts: string[] = [];
    const runtime = new DataAgentRuntime({ workspace, agent: { prompt: async (text: string) => { prompts.push(text); return { operationId: "op" }; } } });
    const app = await createRuntimeServer(runtime, { ...trustedWebContext, workspace });
    const form = new FormData(); form.append("file", new Blob(["region,amount\nEast,1\n"]), "sales.csv");
    await app.inject({ method: "POST", url: "/api/workspace/upload?session_id=session-A", payload: form as any, headers: { "content-type": "multipart/form-data" } });

    const command = (sessionId: string) => ({ protocolVersion: 1, requestId: `prompt-${sessionId}`, sessionId, command: { type: "agent.prompt", prompt: "汇总", attachments: [{ path: "sales.csv" }] } });
    const accepted = await app.inject({ method: "POST", url: "/api/runtime/command", payload: command("session-A") });
    const elsewhere = await app.inject({ method: "POST", url: "/api/runtime/command", payload: command("session-B") });

    expect(accepted.statusCode).toBe(200);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^汇总\n\n<attachments>\n[\s\S]*- sales\.csv \(\d+ B\)\n<\/attachments>$/);
    expect(elsewhere.statusCode).toBe(400);
    expect(prompts).toHaveLength(1);
    await app.close(); await rm(root, { recursive: true, force: true });
  });

  it("serves workspace-root images through a session URL without changing their bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-server-image-"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    await writeFile(join(root, "chart.png"), png);
    const app = await createRuntimeServer(new DataAgentRuntime(), { ...trustedWebContext, workspace: new WorkspaceStore(root) });

    const response = await app.inject({ method: "GET", url: "/api/workspace/download?path=session-A%2Fchart.png" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(png);
    await app.close(); await rm(root, { recursive: true, force: true });
  });

  it("accepts a query access token for authenticated inline workspace images", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-server-auth-image-"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, "chart.png"), png);
    const runtime = new DataAgentRuntime();
    const app = await createRuntimeServer(runtime, { workspace: new WorkspaceStore(root) });
    const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { username: "alice", password: "secret" } });
    const token = registered.json().token as string;

    const response = await app.inject({
      method: "GET",
      url: `/api/workspace/download?path=session-A%2Fchart.png&access_token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.rawPayload).toEqual(png);
    await app.close(); await rm(root, { recursive: true, force: true });
  });

  it("authorizes every session-scoped command before Runtime dispatch", async () => {
    let prompts = 0;
    const runtime = new DataAgentRuntime({ agent: { prompt: async () => { prompts += 1; return { operationId: "must-not-run" }; } } });
    const app = await createRuntimeServer(runtime, { ...trustedWebContext, authorizeSession: async () => false });
    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/command",
      payload: { protocolVersion: 1, requestId: "denied", sessionId: "other-users-session", command: { type: "agent.prompt", prompt: "hello" } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: "SESSION_ACCESS_DENIED" } });
    expect(prompts).toBe(0);
    await app.close();
  });

  it("downloads an immutable publication only through its Receipt and Session", async () => {
    let reads = 0;
    const app = await createRuntimeServer(new DataAgentRuntime(), {
      ...trustedWebContext,
      authorizeSession: async (_userId, sessionId) => sessionId === "session-A",
      publicationReader: {
        readPublication: async (publicationId, context) => {
          reads += 1;
          expect(publicationId).toBe("publication-1");
          expect(context).toEqual({ userId: "web-dev", sessionId: "session-A" });
          return { summary: { format: "csv", contentHash: "sealed-hash" }, content: "value\n1\n" };
        },
      },
    });
    const denied = await app.inject({ method: "GET", url: "/api/runtime/publications/publication-1?session_id=session-B" });
    expect(denied.statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: "/api/runtime/publications/publication-1?session_id=session-A" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["content-disposition"]).toContain("publication-1.csv");
    expect(response.body).toBe("﻿value\n1\n");
    expect(reads).toBe(1);
    await app.close();
  });

  it("starts an agent prompt through the HTTP Host", async () => {
    const app = await createRuntimeServer(new DataAgentRuntime({ agent: { prompt: async () => ({ operationId: "test-operation" }), abort: () => undefined } }), trustedWebContext);
    const response = await app.inject({ method: "POST", url: "/api/runtime/command", payload: { protocolVersion: 1, requestId: "prompt", command: { type: "agent.prompt", prompt: "hello" } } });
    expect(response.statusCode).toBe(200);
    expect(response.json().response.type).toBe("agent.prompt.accepted");
    await app.close();
  });

  it("rejects malformed commands at the HTTP boundary", async () => {
    const app = await createRuntimeServer(new DataAgentRuntime(), trustedWebContext);

    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/command",
      payload: { protocolVersion: 1, requestId: "req-1", command: { type: "unknown" } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_COMMAND" } });
    await app.close();
  });
});
