import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "@data-agent/runtime/testing";
import { registerElectronRuntimeIpc, type IpcMainLike } from "./index.js";

 describe("Electron IPC Host", () => {
  it("dispatches the runtime probe without trusting renderer identity", async () => {
    const runtime = new DataAgentRuntime({ agent: { prompt: async () => ({ operationId: "test-operation" }), abort: () => undefined } });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const eventListeners = new Map<string, (event: unknown) => void>();
    const ipcMain: IpcMainLike = {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
      on(channel, listener) {
        eventListeners.set(channel, listener);
      },
      removeListener(channel) {
        eventListeners.delete(channel);
      },
    };

    const unregister = registerElectronRuntimeIpc(ipcMain, runtime);
    const response = await handlers.get("data-agent:command")?.({}, {
      protocolVersion: 1,
      requestId: "req-1",
      userId: "spoofed",
      command: { type: "agent.prompt", prompt: "hello" },
    });

    expect(response).toMatchObject({
      protocolVersion: 1,
      requestId: "req-1",
      response: { type: "agent.prompt.accepted" },
    });
    unregister();
    expect(handlers.has("data-agent:command")).toBe(false);
  });

  it("filters IPC runtime events by the renderer's requested session", async () => {
    const runtime = new DataAgentRuntime();
    const eventListeners = new Map<string, (event: unknown, payload?: unknown) => void>();
    const ipcMain: IpcMainLike = {
      handle: () => undefined,
      removeHandler: () => undefined,
      on: (channel, listener) => { eventListeners.set(channel, listener); },
      removeListener: (channel) => { eventListeners.delete(channel); },
    };
    const sent: unknown[] = [];
    const sender = { send: (_channel: string, payload: unknown) => sent.push(payload) };
    const unregister = registerElectronRuntimeIpc(ipcMain, runtime);
    eventListeners.get("data-agent:events:subscribe")?.({ sender }, { sessionId: "session-1" });
    await runtime.dispatch({ protocolVersion: 1, requestId: "bind-session", sessionId: "session-1", command: { type: "runtime.probe" } }, { userId: "local", host: "electron", sessionId: "session-1" });

    runtime.clarificationManager.ask("session-2", "other", []);
    runtime.clarificationManager.ask("session-1", "wanted", []);

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((payload) => (payload as { sessionId?: string }).sessionId === "session-1")).toBe(true);
    expect(sent.some((payload) => (payload as { event?: { question?: string } }).event?.question === "wanted")).toBe(true);
    runtime.clarificationManager.cancel("session-1");
    runtime.clarificationManager.cancel("session-2");
    unregister();
  });

  it("forwards runtime events to an Electron renderer subscription", async () => {
    const runtime = new DataAgentRuntime();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const eventListeners = new Map<string, (event: unknown) => void>();
    const ipcMain: IpcMainLike = {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
      on: (channel, listener) => { eventListeners.set(channel, listener); },
      removeListener: (channel) => { eventListeners.delete(channel); },
    };
    const sent: unknown[] = [];
    const sender = { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) };
    const unregister = registerElectronRuntimeIpc(ipcMain, runtime);
    eventListeners.get("data-agent:events:subscribe")?.({ sender });

    await handlers.get("data-agent:command")?.({}, {
      protocolVersion: 1,
      requestId: "probe-event",
      command: { type: "runtime.probe" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "data-agent:event",
      payload: { event: { type: "runtime.probe.completed" } },
    });
    eventListeners.get("data-agent:events:unsubscribe")?.({ sender });
    unregister();
    expect(eventListeners.size).toBe(0);
  });
});

import { MetadataStore } from "@data-agent/runtime/testing";
import { PiJsonlSessionStore } from "../../runtime/src/session-store.js";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

describe("Electron IPC Application Host", () => {
  it("dispatches task/session/knowledge/config commands over IPC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ipc-e2e-"));
    await mkdir(path.join(root, "knowledge"), { recursive: true });
    const metadata = new MetadataStore(path.join(root, "meta.db"));
    const runtime = new DataAgentRuntime({
      metadata,
      sessions: new PiJsonlSessionStore(path.join(root, "sessions")),
      knowledgeRoot: path.join(root, "knowledge"),
      agent: { prompt: async () => undefined, abort: () => undefined },
    });
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    registerElectronRuntimeIpc({
      handle: (channel, handler) => { handlers.set(channel, handler); },
      removeHandler: (channel) => { handlers.delete(channel); },
      on: () => undefined,
      removeListener: () => undefined,
    }, runtime);

    const dispatch = (type: string, extra: Record<string, unknown> = {}) =>
      handlers.get("data-agent:command")?.({}, { protocolVersion: 1, requestId: `r-${Date.now()}`, command: { type, ...extra } });

    const created = await dispatch("task.create", { name: "IPC" }) as { response?: { type?: string; item?: { id?: string } } };
    expect(created.response?.type).toBe("mutation.result");
    const taskId = created.response!.item!.id!;
    const session = await dispatch("session.create", { taskId, name: "S" }) as { response?: { item?: { id?: string } } };
    expect(session.response?.item?.id).toBeTruthy();
    await dispatch("knowledge.save", { path: "a.md", content: "# hi" });
    const list = await dispatch("knowledge.list") as { response?: { files?: Array<{ path: string }> } };
    expect(list.response?.files?.some((f) => f.path === "a.md")).toBe(true);
    await dispatch("config.save", { patch: { key1: "v" } });
    const cfg = await dispatch("config.get") as { response?: { config?: Record<string, unknown> } };
    expect(cfg.response?.config?.key1).toBe("v");
  }, 30000);
});
