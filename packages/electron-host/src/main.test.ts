import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { MetadataStore } from "@data-agent/runtime/testing";
import { registerApplicationProtocol, registerDesktopCapabilities, resolveRuntimePaths, startElectronHost } from "./main.js";

describe("resolveRuntimePaths", () => {
  it("resolves the renderer dist relative to the frontend root in dev layout", () => {
    // Dev: frontend/electron-host/main.cjs -> app root is two levels up.
    const fakeDir = path.join("D:", "data_agent", "frontend", "electron-host");
    const paths = resolveRuntimePaths({ userDataDir: "C:\\u", appDir: path.resolve(fakeDir, "..") });
    expect(paths.rendererDist).toBe(path.join("D:", "data_agent", "frontend", "dist"));
    expect(paths.userDataDir).toBe("C:\\u");
  });

  it("resolves the renderer dist inside app.asar when packaged", () => {
    // Packaged: resources/app.asar/electron-host -> app root is one level up.
    const fakeDir = path.join("C:", "app", "resources", "app.asar", "electron-host");
    const paths = resolveRuntimePaths({ userDataDir: "C:\\u", appDir: path.resolve(fakeDir, "..") });
    expect(paths.rendererDist).toBe(path.join("C:", "app", "resources", "app.asar", "dist"));
  });

  it("serves publications only through a Receipt-aware application callback", async () => {
    let handler: ((request: { url: string }) => Promise<Response>) | undefined;
    await registerApplicationProtocol({
      handle: async (_scheme, next) => { handler = next; },
      unhandle: () => undefined,
    }, {
      writeBytes: async () => undefined,
      readBytesWithLegacyFallback: async () => new Uint8Array(),
    }, async (_userId, sessionId) => sessionId === "session-1", async (publicationId, context) => {
      expect(publicationId).toBe("publication-1");
      expect(context).toEqual({ userId: "local", sessionId: "session-1" });
      return { summary: { format: "csv" }, content: "value\n1\n" };
    });
    const denied = await handler?.({ url: "data-agent://publication/runtime/publications/guess?session_id=session-2" });
    expect(denied?.status).toBe(404);
    const published = await handler?.({ url: "data-agent://publication/runtime/publications/publication-1?session_id=session-1" });
    expect(published?.headers.get("content-type")).toContain("text/csv");
    expect(await published?.text()).toBe("value\n1\n");
  });

  it("starts the desktop Application with a workspace and host testers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "electron-start-"));
    const metadata = new MetadataStore(path.join(root, "metadata", "app.db"));
    await metadata.setConfig("ui.settings", { provider: "openai", model: "test-model", api_key: "test-key" });
    await metadata.close();
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const eventListeners = new Map<string, (event: unknown, payload?: unknown) => void>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
      on: (channel: string, listener: (event: unknown, payload?: unknown) => void) => { eventListeners.set(channel, listener); },
      removeListener: (channel: string) => { eventListeners.delete(channel); },
    };
    let quitCalled = false;
    const loadedFiles: string[] = [];
    let rendererSmokeScript = "";
    let protocolHandler: ((request: { url: string }) => Promise<Response>) | undefined;
    const protocol = {
      registerSchemesAsPrivileged: vi.fn(),
      handle: vi.fn(async (_scheme: string, handler: (request: { url: string }) => Promise<Response>) => { protocolHandler = handler; }),
      unhandle: vi.fn(),
    };
    const previousSmoke = process.env.DATA_AGENT_SMOKE;
    process.env.DATA_AGENT_SMOKE = "1";
    try {
      const host = await startElectronHost({
        app: { whenReady: async () => undefined, getPath: () => root, quit: () => { quitCalled = true; } },
        BrowserWindow: class {
          webContents = { executeJavaScript: async (script: string) => {
            rendererSmokeScript = script;
            return { probe: "runtime.probe.result", config: "config.get.result", artifact: "smoke-renderer.txt", chat: "agent.prompt.accepted" };
          } };
          async loadFile(file: string) { loadedFiles.push(file); }
          async loadURL() { /* smoke mode */ }
        },
        ipcMain,
        protocol,
      });
      expect(quitCalled).toBe(false);
      expect(loadedFiles).toHaveLength(1);
      expect(loadedFiles[0]).toMatch(/[\\/]dist[\\/]index\.html$/);
      expect(rendererSmokeScript).toContain("SMOKE_CHAT_TIMEOUT");
      expect(await readFile(path.join(root, "smoke.ok"), "utf8")).toBe("renderer-runtime-config-upload-chat");
      const command = handlers.get("data-agent:command");
      const context = { protocolVersion: 1, requestId: "desktop-test", command: { type: "llm.test", profile: {} } };
      const tested = await command?.({}, context) as { response?: { type?: string; success?: boolean } };
      expect(tested.response).toMatchObject({ type: "test.result", success: false });
      await command?.({}, { protocolVersion: 1, requestId: "workspace-test", command: { type: "workspace.write", path: "upload.txt", content: "desktop" } });
      expect(await readFile(path.join(root, "workspace", "upload.txt"), "utf8")).toBe("desktop");
      const protocolResponse = await protocolHandler?.({ url: "data-agent://workspace/workspace/files/preview?path=upload.txt" });
      expect(await protocolResponse?.text()).toBe("desktop");
      expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce();
      expect((host.runtime as { dispatch?: unknown })).toBeTruthy();
      await host.dispose();
      expect(handlers.size).toBe(0);
    } finally {
      if (previousSmoke === undefined) delete process.env.DATA_AGENT_SMOKE;
      else process.env.DATA_AGENT_SMOKE = previousSmoke;
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("loads the Vite URL when Electron is started in development mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "electron-dev-"));
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const eventListeners = new Map<string, (event: unknown, payload?: unknown) => void>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
      on: (channel: string, listener: (event: unknown, payload?: unknown) => void) => { eventListeners.set(channel, listener); },
      removeListener: (channel: string) => { eventListeners.delete(channel); },
    };
    const loaded: string[] = [];
    const previousDev = process.env.DATA_AGENT_DEV;
    const previousUrl = process.env.DATA_AGENT_DEV_URL;
    process.env.DATA_AGENT_DEV = "1";
    process.env.DATA_AGENT_DEV_URL = "http://127.0.0.1:5199";
    try {
      const host = await startElectronHost({
        app: { whenReady: async () => undefined, getPath: () => root, quit: () => undefined },
        BrowserWindow: class {
          async loadFile(file: string) { loaded.push(`file:${file}`); }
          async loadURL(url: string) { loaded.push(`url:${url}`); }
        },
        ipcMain,
      });
      expect(loaded).toEqual(["url:http://127.0.0.1:5199"]);
      await host.dispose();
    } finally {
      if (previousDev === undefined) delete process.env.DATA_AGENT_DEV;
      else process.env.DATA_AGENT_DEV = previousDev;
      if (previousUrl === undefined) delete process.env.DATA_AGENT_DEV_URL;
      else process.env.DATA_AGENT_DEV_URL = previousUrl;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("registers secure secret, Python picker, update, menu, and binary upload handlers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "electron-capabilities-"));
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>) => { handlers.set(channel, listener); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    };
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ""),
    };
    const workspace = { writeBytes: vi.fn(async () => undefined) };
    const updater = {
      checkForUpdates: vi.fn(async () => ({ checking: true })),
      downloadUpdate: vi.fn(async () => ({ downloaded: true })),
      quitAndInstall: vi.fn(),
    };
    const unregister = registerDesktopCapabilities(ipcMain, {
      userDataDir: root,
      safeStorage,
      dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["C:\\\\Python\\\\python.exe"] })) },
      autoUpdater: updater,
      workspace,
    });

    await handlers.get("data-agent:save-secrets")?.({}, { openai_api_key: "secret", default_model: "gpt-test" });
    expect(await readFile(path.join(root, "secrets.json"), "utf8")).not.toContain("secret");
    expect(await handlers.get("data-agent:get-stored-secrets")?.({}, undefined)).toEqual({ openai_api_key: "secret", default_model: "gpt-test" });
    expect(await handlers.get("data-agent:select-python-executable")?.({}, undefined)).toContain("python.exe");
    expect(await handlers.get("data-agent:check-for-updates")?.({}, undefined)).toEqual({ checking: true });
    expect(await handlers.get("data-agent:download-update")?.({}, undefined)).toEqual({ downloaded: true });
    expect(await handlers.get("data-agent:quit-and-install-update")?.({}, undefined)).toEqual({ ok: true });
    expect(await handlers.get("data-agent:show-menu")?.({}, undefined)).toBe(false);
    expect(await handlers.get("data-agent:workspace-upload")?.({}, { fileName: "..\\\\report.csv", bytes: Uint8Array.from([1, 2, 3]), sessionId: "s1" })).toMatchObject({ relative_path: "report.csv", size: 3, session_id: "s1" });
    expect(workspace.writeBytes).toHaveBeenCalledWith("s1/report.csv", expect.any(Uint8Array));
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();

    unregister();
    expect(handlers.size).toBe(0);
    await rm(root, { recursive: true, force: true });
  });
});
