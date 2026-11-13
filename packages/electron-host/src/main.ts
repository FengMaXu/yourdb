import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createConfiguredQueryExecutor, testDatabaseConnection, type DatabaseServers } from "@data-agent/database";
import { feishuProvider } from "@data-agent/channel-feishu";
import { weixinProvider } from "@data-agent/channel-weixin";
import { createMcpPluginSupervisor, databaseHostServer } from "@data-agent/mcp-plugins";

/**
 * Production Electron main entry for the TypeScript stack.
 *
 * Responsibilities:
 * - create the per-user data directories
 * - construct the shared DataAgentApplication
 * - register IPC and application publication protocols
 * - load the Renderer
 *
 * Python runs only through the isolated capability pack.
 */

export interface ElectronMainRuntimePaths {
  userDataDir: string;
  /** Packaged resources dir; resolved from process.resourcesPath by the entry. */
  resourcesPath?: string;
  rendererDist: string;
}

declare const __dirname: string;

export function resolveRuntimePaths(options: { userDataDir: string; appDir?: string }): ElectronMainRuntimePaths {
  let appDir = options.appDir;
  if (!appDir && typeof __dirname !== "undefined") {
    // Generated entry layouts place the renderer one directory above the host.
    appDir = path.resolve(__dirname, "..");
  }
  return {
    userDataDir: options.userDataDir,
    // Renderer output is packaged at <app>/dist.
    rendererDist: path.join(appDir ?? process.cwd(), "dist"),
  };
}

export interface MainDeps {
  app: {
    whenReady(): Promise<void>;
    getPath(name: "userData" | "appData"): string;
    setPath?(name: "userData", value: string): void;
    /** True in the installed app; false when run from the repository. */
    isPackaged?: boolean;
    quit(): void;
    requestSingleInstanceLock?(): boolean;
    on?(event: string, listener: (...args: unknown[]) => void): void;
  };
  /** Packaged resources dir (process.resourcesPath); absent in dev. */
  resourcesPath?: string;
  BrowserWindow: new (options: Record<string, unknown>) => {
    loadFile(file: string): Promise<void>;
    loadURL(url: string): Promise<void>;
    webContents?: { executeJavaScript(script: string): Promise<unknown> };
  };
  ipcMain: unknown;
  Menu?: { setApplicationMenu(menu: null): void };
  safeStorage?: ElectronSafeStorageLike;
  dialog?: ElectronDialogLike;
  autoUpdater?: ElectronUpdateServiceLike;
  protocol?: ElectronProtocolLike;
}

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface ElectronDialogLike {
  showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface ElectronUpdateServiceLike {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface ElectronProtocolLike {
  registerSchemesAsPrivileged?(schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void;
  handle(scheme: string, handler: (request: { url: string }) => Promise<Response>): Promise<void>;
  unhandle?(scheme: string): void;
}

interface DesktopIpcLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

interface WorkspaceBytesLike {
  writeBytes(relativePath: string, content: Uint8Array): Promise<void>;
}

export interface StoredLLMSecrets {
  openai_api_key?: string;
  anthropic_api_key?: string;
  default_model?: string;
  openai_base_url?: string;
}

const SECRET_FIELDS = ["openai_api_key", "anthropic_api_key", "default_model", "openai_base_url"] as const;
type SecretField = typeof SECRET_FIELDS[number];

export function registerDesktopCapabilities(
  ipcMain: DesktopIpcLike,
  options: {
    userDataDir: string;
    safeStorage?: ElectronSafeStorageLike;
    dialog?: ElectronDialogLike;
    autoUpdater?: ElectronUpdateServiceLike;
    workspace?: WorkspaceBytesLike;
    onSecretsChanged?: () => void | Promise<void>;
  },
): () => void {
  const secretPath = path.join(options.userDataDir, "secrets.json");
  const handlers = new Set<string>();
  const handle = (channel: string, listener: (event: unknown, payload: unknown) => Promise<unknown>): void => {
    ipcMain.handle(channel, listener);
    handlers.add(channel);
  };

  handle("data-agent:get-stored-secrets", async () => readStoredSecrets(secretPath, options.safeStorage));
  handle("data-agent:save-secrets", async (_event, payload) => {
    if (!options.safeStorage?.isEncryptionAvailable()) return { ok: false };
    const incoming = isRecord(payload) ? payload : {};
    const encrypted = readEncryptedSecretRecord(secretPath);
    for (const field of SECRET_FIELDS) {
      const value = incoming[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.trim()) {
        delete encrypted[field];
        continue;
      }
      encrypted[field] = options.safeStorage.encryptString(value).toString("base64");
    }
    writeEncryptedSecretRecord(secretPath, encrypted);
    await options.onSecretsChanged?.();
    return { ok: true };
  });
  handle("data-agent:select-python-executable", async () => {
    if (!options.dialog) return null;
    const result = await options.dialog.showOpenDialog({ properties: ["openFile"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("data-agent:workspace-upload", async (_event, payload) => {
    if (!options.workspace) throw new Error("WORKSPACE_NOT_CONFIGURED");
    if (!isRecord(payload) || typeof payload.fileName !== "string") throw new Error("WORKSPACE_FILE_REQUIRED");
    const bytes = toBytes(payload.bytes);
    if (!bytes) throw new Error("WORKSPACE_FILE_REQUIRED");
    const fileName = safeUploadName(payload.fileName);
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? safeSessionSegment(payload.sessionId) : "";
    const storagePath = sessionId ? `${sessionId}/${fileName}` : fileName;
    await options.workspace.writeBytes(storagePath, bytes);
    return { filename: fileName, session_id: sessionId, relative_path: fileName, size: bytes.byteLength };
  });
  handle("data-agent:get-backend-port", async () => null);
  handle("data-agent:check-for-updates", async () => options.autoUpdater ? options.autoUpdater.checkForUpdates() : { ok: false, reason: "UPDATES_NOT_CONFIGURED" });
  handle("data-agent:download-update", async () => options.autoUpdater ? options.autoUpdater.downloadUpdate() : { ok: false, reason: "UPDATES_NOT_CONFIGURED" });
  handle("data-agent:quit-and-install-update", async () => {
    if (!options.autoUpdater) return { ok: false, reason: "UPDATES_NOT_CONFIGURED" };
    options.autoUpdater.quitAndInstall();
    return { ok: true };
  });

  return () => {
    for (const channel of handlers) ipcMain.removeHandler(channel);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function readEncryptedSecretRecord(secretPath: string): Partial<Record<SecretField, string>> {
  try {
    const parsed = JSON.parse(readFileSync(secretPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.encrypted)) return {};
    const encrypted = parsed.encrypted;
    return Object.fromEntries(SECRET_FIELDS.flatMap((field) => typeof encrypted[field] === "string" ? [[field, encrypted[field] as string]] : [])) as Partial<Record<SecretField, string>>;
  } catch {
    return {};
  }
}

function readStoredSecrets(secretPath: string, safeStorage?: ElectronSafeStorageLike): StoredLLMSecrets {
  if (!safeStorage?.isEncryptionAvailable()) return {};
  const encrypted = readEncryptedSecretRecord(secretPath);
  const result: StoredLLMSecrets = {};
  for (const field of SECRET_FIELDS) {
    const value = encrypted[field];
    if (!value) continue;
    try {
      result[field] = safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      // Ignore an unreadable entry; the remaining secrets may still be valid.
    }
  }
  return result;
}

function writeEncryptedSecretRecord(secretPath: string, encrypted: Partial<Record<SecretField, string>>): void {
  const temporary = `${secretPath}.${process.pid}.tmp`;
  mkdirSync(path.dirname(secretPath), { recursive: true });
  writeFileSync(temporary, JSON.stringify({ version: 1, encrypted }, null, 2), "utf8");
  renameSync(temporary, secretPath);
}

function toBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return Uint8Array.from(value);
  return undefined;
}

function safeUploadName(fileName: string): string {
  const normalized = fileName.replaceAll("\\", "/");
  const name = path.posix.basename(normalized);
  if (!name || name === "." || name === "..") throw new Error("WORKSPACE_FILE_REQUIRED");
  return name;
}

function safeSessionSegment(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("INVALID_WORKSPACE_SESSION");
  return sessionId;
}

export async function registerApplicationProtocol(
  protocol: ElectronProtocolLike | undefined,
  workspace: WorkspaceBytesLike & { readBytesWithRootFallback(relativePath: string): Promise<Uint8Array> },
  authorizeSession?: (userId: string, sessionId: string) => boolean | Promise<boolean>,
  readPublication?: (publicationId: string, context: { readonly userId: string; readonly sessionId: string }) => Promise<{ readonly summary: { readonly format: "inline" | "csv" }; readonly content: string }>,
): Promise<() => void> {
  if (!protocol) return () => undefined;
  await protocol.handle("data-agent", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === "publication" && url.pathname.startsWith("/runtime/publications/")) {
        const publicationId = decodeURIComponent(url.pathname.slice("/runtime/publications/".length));
        const sessionId = url.searchParams.get("session_id") ?? "";
        if (!publicationId || !sessionId || !readPublication || (authorizeSession && !(await authorizeSession("local", sessionId)))) return new Response("Not found", { status: 404 });
        const artifact = await readPublication(publicationId, { userId: "local", sessionId });
        return new Response(`﻿${artifact.content}`, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${publicationId}.csv"`, "Cache-Control": "no-store" } });
      }
      if (url.hostname !== "workspace" || !url.pathname.startsWith("/workspace/files/")) return new Response("Not found", { status: 404 });
      const relativePath = url.searchParams.get("path") ?? "";
      if (!relativePath) return new Response("File path is required", { status: 400 });
      const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
      if (parts.length >= 2 && authorizeSession && !(await authorizeSession("local", parts[0]))) return new Response("Not found", { status: 404 });
      const bytes = await workspace.readBytesWithRootFallback(relativePath);
      return new Response(Buffer.from(bytes), { headers: { "Content-Type": contentTypeFor(relativePath), "Cache-Control": "no-store" } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  return () => protocol.unhandle?.("data-agent");
}

function contentTypeFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  return ({
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
function createElectronHostTesters(databaseServers: DatabaseServers) {
  return {
    dbTester: { test: (connection: Record<string, unknown>) => testDatabaseConnection(connection, databaseServers) },
    llmTester: { test: testLlmProfile },
  };
}

async function testLlmProfile(profile: Record<string, unknown>): Promise<{ success: boolean; message: string; details?: unknown }> {
  const provider = String(profile.provider ?? "openai");
  const apiKey = String(profile.api_key ?? profile.openai_api_key ?? profile.anthropic_api_key ?? "").trim();
  const model = String(profile.model ?? (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini"));
  if (!apiKey) return { success: false, message: "缺少 API Key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    if (provider === "anthropic") {
      const baseUrl = String(profile.base_url ?? "https://api.anthropic.com").replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: controller.signal,
      });
      if (response.ok) return { success: true, message: `Anthropic 连接成功（${model}）` };
      return { success: false, message: `Anthropic 校验失败 (HTTP ${response.status})`, details: (await response.text().catch(() => "")).slice(0, 300) };
    }
    const baseUrl = String(profile.base_url ?? profile.openai_base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: controller.signal,
    });
    if (response.ok) return { success: true, message: `OpenAI 兼容接口连接成功（${model}）` };
    return { success: false, message: `OpenAI 兼容接口校验失败 (HTTP ${response.status})`, details: (await response.text().catch(() => "")).slice(0, 300) };
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "AbortError" ? "请求超时（20s）" : error.message) : String(error);
    return { success: false, message: `模型服务连接失败: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

async function runPackagedRendererSmoke(window: { webContents?: { executeJavaScript(script: string): Promise<unknown> } }): Promise<void> {
  if (!window.webContents) throw new Error("SMOKE_RENDERER_WEB_CONTENTS_MISSING");
  const result = await window.webContents.executeJavaScript(`
    (async () => {
      const invoke = window.dataAgentRuntime?.invokeRuntimeCommand;
      const subscribe = window.dataAgentRuntime?.subscribeRuntimeEvents;
      const upload = window.dataAgent?.uploadWorkspaceFile;
      if (!invoke || !subscribe || !upload) throw new Error("SMOKE_PRELOAD_BRIDGE_MISSING");
      const envelope = (requestId, command, sessionId) => ({ protocolVersion: 1, requestId, ...(sessionId ? { sessionId } : {}), command });
      const probe = await invoke(envelope("smoke-probe", { type: "runtime.probe" }));
      const config = await invoke(envelope("smoke-config", { type: "config.get" }));
      const task = await invoke(envelope("smoke-task", { type: "task.create", name: "Smoke" }));
      const taskId = task?.response?.item?.id;
      const session = await invoke(envelope("smoke-session", { type: "session.create", taskId, name: "Smoke" }));
      const sessionId = session?.response?.item?.id;
      if (!sessionId) throw new Error("SMOKE_SESSION_CREATE_FAILED");
      const artifact = await upload({ fileName: "smoke-renderer.txt", bytes: new Uint8Array([115, 109, 111, 107, 101]), sessionId });
      let unsubscribe = () => undefined;
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error("SMOKE_CHAT_TIMEOUT")); }, 10000);
        unsubscribe = subscribe((event) => {
          if (event?.sessionId === sessionId && event?.event?.type === "agent.completed") {
            clearTimeout(timer);
            unsubscribe();
            resolve(true);
          }
        }, sessionId);
      });
      const chat = await invoke(envelope("smoke-chat", { type: "agent.prompt", prompt: "smoke" }, sessionId));
      await invoke(envelope("smoke-stop", { type: "agent.stop", operationId: chat?.response?.runId }, sessionId));
      await completed;
      return {
        probe: probe?.response?.type,
        config: config?.response?.type,
        artifact: artifact?.relative_path,
        chat: chat?.response?.type,
      };
    })()
  `);
  if (!isRecord(result)
    || result.probe !== "runtime.probe.result"
    || result.config !== "config.get.result"
    || result.artifact !== "smoke-renderer.txt"
    || result.chat !== "agent.prompt.accepted") {
    throw new Error(`SMOKE_RENDERER_SELF_TEST_FAILED: ${JSON.stringify(result)}`);
  }
}

export interface ElectronHostHandle {
  runtime: unknown;
  dispose(): Promise<void>;
}

/** The folder under the OS app-data dir that holds the installed app's data, as it did in 0.1.0. */
export const PACKAGED_DATA_FOLDER = "yourdb";

/**
 * Electron names the data folder after package.json's "name", which is "frontend", so 0.1.1 would
 * have started from an empty folder beside 0.1.0's. The installed app uses <appData>/yourdb; runs
 * from the repository keep Electron's default so they never touch an installed app's data.
 * Call before anything reads userData (the single-instance lock does).
 */
export function usePackagedDataFolder(app: MainDeps["app"]): void {
  if (!app.isPackaged || !app.setPath) return;
  app.setPath("userData", path.join(app.getPath("appData"), PACKAGED_DATA_FOLDER));
}

export async function startElectronHost(deps: MainDeps, overrides: Partial<ElectronMainRuntimePaths> = {}): Promise<ElectronHostHandle> {
  deps.protocol?.registerSchemesAsPrivileged?.([{
    scheme: "data-agent",
    privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
  }]);
  const { createDataAgentApplication, createDashboardSnapshotter } = await import("@data-agent/runtime");
  const { registerElectronRuntimeIpc } = await import("./index.js");

  const paths = resolveRuntimePaths({ userDataDir: deps.app.getPath("userData") });
  if (overrides.userDataDir) paths.userDataDir = overrides.userDataDir;
  if (overrides.rendererDist) paths.rendererDist = overrides.rendererDist;

  // Bundled Python runtime pack ships under extraResources; never fall back to
  // development paths inside the packaged application.
  const effectiveResources = overrides.resourcesPath ?? deps.resourcesPath;
  const packedPython = effectiveResources ? path.join(effectiveResources, "python-runtime", "python.exe") : undefined;
  const bundledPythonExecutable = packedPython && existsSync(packedPython) ? packedPython : undefined;
  for (const dir of ["metadata", "sessions", "workspace", "knowledge"]) {
    mkdirSync(path.join(paths.userDataDir, dir), { recursive: true });
  }

  const knowledgeRoot = path.join(paths.userDataDir, "knowledge");
  const secretPath = path.join(paths.userDataDir, "secrets.json");
  const resolveConfiguredProfile = async (_context: unknown, application: { getConfig(key: string): Promise<unknown> }) => {
    if (process.env.DATA_AGENT_SMOKE === "1") return { provider: "openai", model: "smoke", apiKey: "smoke", baseUrl: "http://127.0.0.1:9", apiFormat: "responses" as const };
    const saved = await application.getConfig("ui.settings");
    const cfg = isRecord(saved) ? saved : {};
    const stored = readStoredSecrets(secretPath, deps.safeStorage);
    const provider = typeof cfg.provider === "string" && cfg.provider ? cfg.provider : (stored.anthropic_api_key ? "anthropic" : "openai");
    const apiKey = firstString(
      cfg.api_key,
      provider === "anthropic" ? cfg.anthropic_api_key : cfg.openai_api_key,
      stored.anthropic_api_key && provider === "anthropic" ? stored.anthropic_api_key : undefined,
      stored.openai_api_key && provider !== "anthropic" ? stored.openai_api_key : undefined,
    );
    const model = firstString(cfg.model, stored.default_model);
    if (cfg.llm_enabled === false || !apiKey || !model) throw new Error("LLM_NOT_CONFIGURED: add a model API key in Settings → Model");
    const baseUrl = firstString(cfg.base_url, stored.openai_base_url);
    const apiFormat = cfg.api_format === "chat" || cfg.apiFormat === "chat" ? "chat" : "responses";
    return { provider, model, apiKey, apiFormat, ...(baseUrl ? { baseUrl } : {}) } as const;
  };
  const applicationRoot = path.dirname(paths.rendererDist);
  const developmentRoot = applicationRoot.includes(`${path.sep}app.asar`) ? applicationRoot : path.resolve(applicationRoot, "..");
  const packagedRoot = effectiveResources ?? applicationRoot;
  const application = await createDataAgentApplication({
    dataRoot: paths.userDataDir,
    host: "electron",
    defaultUserId: "local",
    knowledgeRoot,
    // General method guides are read in place so they update with the application.
    builtinKnowledgeRoots: [path.join(packagedRoot, ".agents", "knowledge"), path.join(developmentRoot, ".agents", "knowledge")],
    pythonExecutable: bundledPythonExecutable,
    bundledPythonExecutable,
    resolveProfile: resolveConfiguredProfile,
    ...(process.env.TYPESAFE_API_KEY?.trim() ? {
      jevHypothesisComparison: {
        apiKey: process.env.TYPESAFE_API_KEY.trim(),
        model: process.env.TYPESAFE_MODEL?.trim() || "jev-1.13.0",
        ...(process.env.TYPESAFE_ENDPOINT?.trim() ? { endpoint: process.env.TYPESAFE_ENDPOINT.trim() } : {}),
      },
    } : {}),
    // Enable bounded reviewer and authorized knowledge exploration. Delegated
    // SQL stays unavailable until a database-enforced scoped executor is supplied.
    enableSubagents: true,
    delegationKnowledgePaths: ["doc/business.md", "doc/db_schema.md", "doc/query_patterns.md", "doc/learning.md", "doc/rules.md", "doc/semantic_guide.md"],
    // The system prompt ships with the app; the knowledge folder never supplies one (writes to .pi/ are refused too).
    systemPromptRoots: [developmentRoot, packagedRoot],
    projectRoot: developmentRoot,
    packagedRoot,
    skillRoots: [path.join(developmentRoot, ".agents", "skills"), path.join(packagedRoot, ".agents", "skills")],
  });

  // Each database's contract MCP server is a bundled script run by Electron as Node.
  const mcpServer = (bundle: string) => ({
    command: process.execPath,
    args: [[
      path.join(__dirname, bundle),
      path.resolve(__dirname, "../../../frontend/electron-host", bundle),
      path.resolve(process.cwd(), "frontend/electron-host", bundle),
    ].find((candidate, index, candidates) => existsSync(candidate) || index === candidates.length - 1)!],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  const databaseServers: DatabaseServers = { mysql: mcpServer("mcp-mysql.cjs"), postgres: mcpServer("mcp-pg.cjs"), sqlite: mcpServer("mcp-sqlite.cjs") };
  application.setHostTesters(createElectronHostTesters(databaseServers));
  const queryExecutor = createConfiguredQueryExecutor({ readSettings: () => application.getConfig("ui.settings"), servers: databaseServers });
  application.setQueryExecutor(() => queryExecutor.resolve());
  const mcpPlugins = createMcpPluginSupervisor({
    readConfig: () => application.getConfig("mcp.config"),
    writeConfig: (config) => application.setConfig("mcp.config", config),
    hostServers: [databaseHostServer(() => queryExecutor.check())],
  });
  application.setMcpPlugins(mcpPlugins);
  // Message channels (ADR-0011), as the web host has them: Feishu and personal WeChat, each connected
  // by scanning in Settings → Channels. Dashboards reach phones as a picture rendered by Edge or Chrome
  // (Edge ships with Windows 10/11); without one, only the page is sent.
  const channelError = (name: string) => (error: unknown) => console.error(`[yourdb] ${name}:`, error instanceof Error ? error.message : error);
  await application.enableChannels([
    feishuProvider({ onError: channelError("feishu") }),
    weixinProvider({ onError: channelError("weixin") }),
  ], {
    snapshot: createDashboardSnapshotter(),
    // A chat's next message after two quiet hours starts a new conversation; "/new" starts one at any time.
    idleSessionMs: 120 * 60_000,
  });
  const unregisterDesktopCapabilities = registerDesktopCapabilities(deps.ipcMain as DesktopIpcLike, {
    userDataDir: paths.userDataDir,
    safeStorage: deps.safeStorage,
    dialog: deps.dialog,
    autoUpdater: deps.autoUpdater,
    workspace: application.workspace,
  });
  const unregisterRuntimeIpc = registerElectronRuntimeIpc(deps.ipcMain as never, application);
  await deps.app.whenReady();
  const unregisterWorkspaceProtocol = await registerApplicationProtocol(
    deps.protocol,
    application.workspace,
    async (userId, sessionId) => (await application.authorizeSession(userId, sessionId)) === "owned",
    (publicationId, context) => application.readPublication(publicationId, context),
  );
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await application.close();
    unregisterWorkspaceProtocol();
    unregisterDesktopCapabilities();
    unregisterRuntimeIpc();
    await queryExecutor.close();
    await mcpPlugins.close();
  };
  const isDev = process.env.DATA_AGENT_DEV === "1" || process.argv.includes("--dev");
  // Electron's stock File/Edit/View menu is English and exposes reload and DevTools; the
  // packaged app has no menu bar. Dev keeps it for those shortcuts. Windows clipboard keys
  // work without a menu.
  if (!isDev) deps.Menu?.setApplicationMenu(null);
  const window = new deps.BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devServerUrl = process.env.DATA_AGENT_DEV_URL?.trim() || "http://localhost:5173";
  if (isDev) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(path.join(paths.rendererDist, "index.html"));
  }
  if (process.env.DATA_AGENT_SMOKE === "1") {
    await runPackagedRendererSmoke(window);
    writeFileSync(path.join(paths.userDataDir, "smoke.ok"), "renderer-runtime-config-upload-chat");
  }
  return { runtime: application, dispose };
}

// This module is only loaded as an Electron main entry (tests import
// ./index.js directly), so starting unconditionally here is safe.
// Vitest imports this file for unit tests; never boot electron there.
if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") void (async () => {
  try {
    const electronModule = "electron";
    const electron = (await import(/* @vite-ignore */ electronModule)) as never as MainDeps;
    usePackagedDataFolder(electron.app);
    if (electron.app.requestSingleInstanceLock?.() === false) {
      electron.app.quit();
      return;
    }
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const smokeUserData = process.env.DATA_AGENT_SMOKE_DIR?.trim();
    const host = await startElectronHost(electron, { resourcesPath, ...(smokeUserData ? { userDataDir: smokeUserData } : {}) });
    if (process.env.DATA_AGENT_SMOKE === "1") {
      await host.dispose();
      electron.app.quit();
      return;
    }
    let quitting = false;
    electron.app.on?.("before-quit", (event) => {
      if (quitting) return;
      quitting = true;
      (event as { preventDefault?: () => void } | undefined)?.preventDefault?.();
      void host.dispose().finally(() => electron.app.quit());
    });
  } catch (error) {
    // GUI-subsystem processes have no console; persist the failure for diagnostics.
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(path.join(process.env.TEMP ?? process.cwd(), "data-agent-main-error.log"),
        `[${new Date().toISOString()}] electron host failed to start:\n${(error instanceof Error ? error.stack : String(error))}\n`);
    } catch {
      /* ignore */
    }
    console.error("electron host failed to start:", error);
    const electronModule2 = "electron";
    try {
      const { app: crashedApp } = (await import(/* @vite-ignore */ electronModule2)) as never;
      (crashedApp as { exit?: (code: number) => void }).exit?.(1);
    } catch { /* not in electron */ }
    process.exitCode = 1;
  }
})();
