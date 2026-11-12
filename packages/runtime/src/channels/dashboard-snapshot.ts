import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface DashboardSnapshotOptions {
  /** Edge or Chrome; found in the usual install locations when omitted. */
  readonly browserPath?: string;
  /** CSS width of the page; dashboards lay out for desktop widths. */
  readonly width?: number;
  readonly scale?: number;
  /** Time after load for charts to finish their entry animation. */
  readonly settleMs?: number;
  readonly timeoutMs?: number;
}

/** Tall pages are cut here; IM image viewers refuse very long images. */
const MAX_HEIGHT = 8_000;

/** A configured path is used as is: a wrong one fails instead of quietly picking another browser. */
export function findBrowser(explicit?: string): string | undefined {
  const configured = explicit ?? process.env.DATA_AGENT_SNAPSHOT_BROWSER;
  if (configured) return existsSync(configured) ? configured : undefined;
  return [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!));
}

type Cdp = { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>; waitFor(method: string, sessionId: string): Promise<void>; close(): void };

async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("DASHBOARD_SNAPSHOT_CDP_UNREACHABLE")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const waiters: { method: string; sessionId: string; resolve: () => void }[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; sessionId?: string };
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(new Error(message.error.message));
      else entry?.resolve(message.result);
      return;
    }
    for (const waiter of waiters.filter((item) => item.method === message.method && item.sessionId === message.sessionId)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    waitFor: (method, sessionId) => new Promise<void>((resolve) => { waiters.push({ method, sessionId, resolve }); }),
    close: () => socket.close(),
  };
}

/**
 * Renders a self-contained dashboard page to PNG with a headless browser over
 * the DevTools protocol. Each call uses its own browser and profile, so a
 * failed render leaves nothing behind for the next one.
 */
export function createDashboardSnapshotter(options: DashboardSnapshotOptions = {}): (html: Uint8Array) => Promise<Uint8Array> {
  const width = options.width ?? 1200;
  const scale = options.scale ?? 1.5;
  return async (html) => {
    const executable = findBrowser(options.browserPath);
    if (!executable) throw new Error("DASHBOARD_SNAPSHOT_NO_BROWSER");
    const work = await mkdtemp(path.join(tmpdir(), "dashboard-snapshot-"));
    const page = path.join(work, "dashboard.html");
    await writeFile(page, html);
    const profile = path.join(work, "profile");
    const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    let cdp: Cdp | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async (): Promise<Uint8Array> => {
      const portFile = path.join(profile, "DevToolsActivePort");
      for (let attempt = 0; attempt < 300 && !existsSync(portFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const [port] = (await readFile(portFile, "utf8")).split("\n");
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { webSocketDebuggerUrl: string };
      cdp = await connect(webSocketDebuggerUrl);
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: scale, mobile: false }, sessionId);
      const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url: pathToFileURL(page).href }, sessionId);
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 1_500));
      const { result } = await cdp.send("Runtime.evaluate", { expression: "Math.ceil(document.documentElement.scrollHeight)", returnByValue: true }, sessionId);
      const height = Math.min(MAX_HEIGHT, Math.max(1, Number(result.value) || 900));
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, sessionId);
      return new Uint8Array(Buffer.from(data as string, "base64"));
    };
    try {
      return await Promise.race([
        capture(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DASHBOARD_SNAPSHOT_TIMEOUT")), options.timeoutMs ?? 60_000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      cdp?.close();
      child.kill();
      // The browser may hold its profile for a moment after being killed.
      await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    }
  };
}
