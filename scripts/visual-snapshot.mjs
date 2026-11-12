#!/usr/bin/env node
/**
 * Visual regression snapshots of the web app.
 *
 * Builds the fixed data of scripts/visual-fixture.mjs, starts the Web Host on it, and drives a
 * headless Edge or Chrome over the DevTools protocol through a fixed matrix of pages, each at
 * 1440×900 and 390×844. Every screenshot is compared with its baseline by pixelmatch.
 *
 *   node scripts/visual-snapshot.mjs --update          write the baselines (run on develop)
 *   node scripts/visual-snapshot.mjs                   compare against them (run on the branch)
 *   node scripts/visual-snapshot.mjs --only chat,mcp   only pages whose name contains "chat" or "mcp"
 *
 * Options: --baseline <dir> (default .artifacts/visual/baseline), --out <dir> (default
 * .artifacts/visual/current; diffs go to <out>/diff), --max-diff-ratio <n> (share of pixels
 * allowed to differ per screenshot, default 0.001).
 * Needs the built packages (npm run build) and frontend/dist (npm run build --workspace=frontend).
 * The browser is VISUAL_BROWSER, or Edge/Chrome at their usual paths. Pages run one after another
 * in one browser, to stay inside a small machine's memory.
 *
 * To keep runs repeatable: motion is reduced and every animation, transition and caret is
 * turned off; fonts and the network settle before each shot; Date is frozen at the fixture's
 * clock; time zone and locale are pinned.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import WebSocket from "ws";
import { buildVisualFixture, startVisualHost } from "./visual-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
const update = process.argv.includes("--update");
const only = option("--only")?.split(",").map((name) => name.trim()).filter(Boolean);
const baselineDir = path.resolve(root, option("--baseline", ".artifacts/visual/baseline"));
const outDir = path.resolve(root, option("--out", ".artifacts/visual/current"));
const maxDiffRatio = Number(option("--max-diff-ratio", "0.001"));

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

// Applied only while snapshotting: the one place this project allows !important.
const FREEZE_CSS = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

// ─── Page matrix ──────────────────────────────────────────────────────────────
// `auth` signs in first; `session` opens that fixture session; `steps` run in the page, in order.
const PAGES = [
  { name: "landing", path: "/" },
  { name: "login", path: "/app" },
  { name: "chat-empty", path: "/app", auth: true, session: "新会话" },
  { name: "chat-table", path: "/app", auth: true, session: "三大行业累计销售额" },
  { name: "chat-trace-open", path: "/app", auth: true, session: "三大行业累计销售额", steps: [["expandTrace"], ["scrollTop"]] },
  { name: "tool-panel", path: "/app", auth: true, session: "三大行业累计销售额", steps: [["click", "打开详细信息"]] },
  { name: "settings-model", path: "/app", auth: true, steps: [["sidebar", "设置"], ["sidebar", "模型"]] },
  { name: "settings-database", path: "/app", auth: true, steps: [["sidebar", "设置"], ["sidebar", "数据库"]] },
  { name: "settings-environment", path: "/app", auth: true, steps: [["sidebar", "设置"], ["sidebar", "环境"]] },
  { name: "settings-channels", path: "/app", auth: true, steps: [["sidebar", "设置"], ["sidebar", "消息渠道"]] },
  { name: "mcp-installed", path: "/app", auth: true, steps: [["sidebar", "插件管理"], ["sidebar", "MCP"]] },
  { name: "mcp-settings", path: "/app", auth: true, steps: [["sidebar", "插件管理"], ["sidebar", "MCP"], ["tab", 1]] },
  { name: "skills", path: "/app", auth: true, steps: [["sidebar", "插件管理"], ["sidebar", "Skills"]] },
  { name: "knowledge", path: "/app", auth: true, steps: [["sidebar", "知识库"], ["sidebar", "business.md"]] },
  { name: "preview", path: "/app", auth: true, session: "销售摘要报告", steps: [["click", "查看"]] },
];

/** Runs inside the page: find a control by its accessible name or text, and click it. */
const PAGE_HELPERS = `window.__visual = {
  find(label) {
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="treeitem"], [role="menuitem"], summary')];
    const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
    // A disabled control is not ready yet (a toggle waiting for data): keep waiting for it.
    const usable = (el) => el.offsetParent !== null && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    return candidates.find((el) => name(el) === label && usable(el))
      || candidates.find((el) => name(el).includes(label) && usable(el));
  },
  async click(label) {
    for (let waited = 0; waited < 5000; waited += 100) { const el = this.find(label); if (el) { el.click(); return true; } await new Promise((r) => setTimeout(r, 100)); }
    return false;
  },
  tab(index) { const tabs = [...document.querySelectorAll('[role="tab"]')].filter((el) => el.offsetParent !== null); if (!tabs[index]) return false; tabs[index].click(); return true; },
  async expandTrace() {
    for (let waited = 0; waited < 5000; waited += 100) {
      const el = [...document.querySelectorAll('[aria-expanded="false"]')].find((node) => node.closest('main, .chat-area, [class*="agent"]') && !node.closest('nav'));
      if (el) { el.click(); return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  },
};`;

// ─── Browser over the DevTools protocol ───────────────────────────────────────
function browserPath() {
  return [
    process.env.VISUAL_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find((candidate) => candidate && existsSync(candidate));
}

async function launch(userDataDir) {
  const executable = browserPath();
  if (!executable) throw new Error("No Edge or Chrome found; set VISUAL_BROWSER");
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--font-render-hinting=none", "--force-color-profile=srgb", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300 && !existsSync(portFile); attempt++) await sleep(100);
  if (!existsSync(portFile)) { child.kill(); throw new Error(`${executable} did not open a debugging port within 30 s`); }
  // On Windows the file can exist while the browser still holds it open.
  let port;
  for (let attempt = 0; attempt < 50 && !port; attempt++) {
    port = await readFile(portFile, "utf8").then((text) => text.split("\n")[0].trim(), () => undefined);
    if (!port) await sleep(100);
  }
  if (!port) { child.kill(); throw new Error("could not read the browser's debugging port"); }
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message} ${message.error.data ?? ""}`)); else resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  // A renderer that dies (for example out of memory) never answers: fail the call instead of hanging the run.
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} got no answer within 60 s`)); }, 60_000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, listeners, close: () => { socket.close(); child.kill(); } };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One tab per screenshot, so no state leaks between pages. */
async function snapshot(browser, { url, viewport, clock, storage }) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  const inflight = new Set();
  let lastActivity = Date.now();
  const close = async () => { browser.listeners.delete(listener); await browser.send("Target.closeTarget", { targetId }).catch(() => undefined); };
  const listener = (message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      const text = details.exception?.description ?? details.text;
      // The browser's own built-in extensions (Edge's translate helper, say) can throw in the page; only the app's errors count.
      if (!/chrome-extension:\/\//.test(`${details.url ?? ""} ${text}`)) errors.push(text);
    }
    if (message.method === "Network.requestWillBeSent") { inflight.add(message.params.requestId); lastActivity = Date.now(); }
    if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") { inflight.delete(message.params.requestId); lastActivity = Date.now(); }
  };
  browser.listeners.add(listener);
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "light" }] });
    await send("Emulation.setTimezoneOverride", { timezoneId: "Asia/Shanghai" });
    await send("Emulation.setLocaleOverride", { locale: "zh-CN" }).catch(() => undefined);
    const fixed = Date.parse(clock);
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const fixed = ${fixed}; const RealDate = Date;
      // Works with and without new, like Date itself: Date() returns the frozen time as a string.
      function FrozenDate(...args) {
        if (!new.target) return new RealDate(fixed).toString();
        return args.length === 0 ? new RealDate(fixed) : new RealDate(...args);
      }
      FrozenDate.prototype = RealDate.prototype;
      FrozenDate.now = () => fixed;
      FrozenDate.parse = RealDate.parse;
      FrozenDate.UTC = RealDate.UTC;
      globalThis.Date = FrozenDate;
      try { localStorage.clear(); ${Object.entries(storage).map(([key, value]) => value === null ? `localStorage.removeItem(${JSON.stringify(key)});` : `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join(" ")} } catch {}
      const style = () => { const node = document.createElement('style'); node.textContent = ${JSON.stringify(FREEZE_CSS)}; document.documentElement.appendChild(node); };
      if (document.documentElement) style(); else document.addEventListener('DOMContentLoaded', style);
    })();` });
    // Wait for the load event, at most 30 s; either way the listener goes.
    const loaded = new Promise((resolve) => {
      const finish = () => { browser.listeners.delete(done); clearTimeout(timer); resolve(); };
      const done = (message) => { if (message.sessionId === sessionId && message.method === "Page.loadEventFired") finish(); };
      const timer = setTimeout(finish, 30_000);
      browser.listeners.add(done);
    });
    lastActivity = Date.now();
    await send("Page.navigate", { url });
    await loaded;
    await settle(send, inflight, () => lastActivity);
    await send("Runtime.evaluate", { expression: PAGE_HELPERS });
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    return {
      errors,
      evaluate,
      close,
      settle: () => settle(send, inflight, () => lastActivity),
      /** Late scrolls and font swaps move the page after the network is idle: shoot until two frames agree. */
      capture: async () => {
        let previous;
        for (let attempt = 0; attempt < 8; attempt++) {
          const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
          const png = Buffer.from(data, "base64");
          if (previous && previous.equals(png)) return png;
          previous = png;
          await sleep(400);
        }
        throw new Error("the page kept changing; no two consecutive screenshots matched");
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Wait for fonts, for the network to be idle for 500 ms, and for two frames. */
async function settle(send, inflight, lastActivity) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (inflight.size === 0 && Date.now() - lastActivity() > 500) break;
    await sleep(100);
  }
  await send("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))) : null", awaitPromise: true }).catch(() => undefined);
}

// ─── Comparison ───────────────────────────────────────────────────────────────
function compare(actualBuffer, baselineBuffer) {
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return { ok: false, detail: `size ${actual.width}×${actual.height}, baseline ${baseline.width}×${baseline.height}` };
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const pixels = pixelmatch(actual.data, baseline.data, diff.data, actual.width, actual.height, { threshold: 0.1 });
  const ratio = pixels / (actual.width * actual.height);
  return { ok: ratio <= maxDiffRatio, pixels, ratio, diff: PNG.sync.write(diff), detail: `${pixels} px (${(ratio * 100).toFixed(3)}%)` };
}

// ─── Run ──────────────────────────────────────────────────────────────────────
if (!existsSync(path.join(root, "frontend", "dist", "index.html"))) throw new Error("frontend/dist is missing; run npm run build --workspace=frontend");
const work = await mkdtemp(path.join(tmpdir(), "visual-snapshot-"));
const target = update ? baselineDir : outDir;
await mkdir(target, { recursive: true });
if (!update) await mkdir(path.join(outDir, "diff"), { recursive: true });

const fixture = await buildVisualFixture(path.join(work, "data"));
const host = await startVisualHost(fixture);
const browser = await launch(path.join(work, "profile"));
const failures = [];
const results = [];
try {
  const login = await (await fetch(`${host.url}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: fixture.username, password: fixture.password }) })).json();
  const token = login.token;
  const runtime = async (type, extra = {}) => (await (await fetch(`${host.url}/api/runtime/command`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ protocolVersion: 1, requestId: `visual-${Math.random()}`, command: { type, ...extra } }) })).json()).response;
  const tasks = (await runtime("task.list")).items;
  const sessions = (await Promise.all(tasks.map((task) => runtime("session.list", { taskId: task.id })))).flatMap((result, index) => result.items.map((item) => ({ ...item, taskId: tasks[index].id })));

  for (const page of PAGES.filter((item) => !only || only.some((name) => item.name.includes(name)))) {
    for (const viewport of VIEWPORTS) {
      const name = `${page.name}--${viewport.name}`;
      const session = page.session ? sessions.find((item) => item.name === page.session) : undefined;
      // A missing fixture session fails this page, not the whole run.
      if (page.session && !session) { failures.push(`${name}: fixture session not found: ${page.session}`); continue; }
      const storage = {
        app_language: "zh",
        "data-agent:auth-token": page.auth ? token : null,
        "data-agent:current-task": session ? session.taskId : null,
        "data-agent:current-session": session ? session.id : null,
      };
      const tab = await snapshot(browser, { url: `${host.url}${page.path}`, viewport, clock: fixture.clock, storage });
      try {
        for (const [action, argument] of page.steps ?? []) {
          let done;
          if (action === "click") done = await tab.evaluate(`window.__visual.click(${JSON.stringify(argument)})`);
          else if (action === "tab") done = await tab.evaluate(`window.__visual.tab(${argument})`);
          else if (action === "expandTrace") done = await tab.evaluate("window.__visual.expandTrace()");
          // The chat follows the newest message; scroll back so the expanded process is in the shot.
          else if (action === "scrollTop") done = await tab.evaluate("(() => { const list = [...document.querySelectorAll('.scrollable-area')].find((el) => el.scrollHeight > el.clientHeight && el.closest('main')); if (!list) return false; list.scrollTop = 0; return true; })()");
          else if (action === "sidebar") {
            // On a narrow screen the sidebar is closed until opened.
            done = await tab.evaluate(`window.__visual.click(${JSON.stringify(argument)})`);
            if (!done && (await tab.evaluate(`window.__visual.find("打开侧边栏") ? window.__visual.click("打开侧边栏") : false`))) { await tab.settle(); done = await tab.evaluate(`window.__visual.click(${JSON.stringify(argument)})`); }
          }
          if (!done) throw new Error(`step ${action} ${argument ?? ""} found nothing to act on`);
          await tab.settle();
        }
        const png = await tab.capture();
        await writeFile(path.join(target, `${name}.png`), png);
        if (tab.errors.length) failures.push(`${name}: script error ${tab.errors.join(" | ")}`);
        if (update) { console.log(`baseline ${name}`); continue; }
        const baselinePath = path.join(baselineDir, `${name}.png`);
        if (!existsSync(baselinePath)) { failures.push(`${name}: no baseline (run with --update on develop first)`); continue; }
        const result = compare(png, await readFile(baselinePath));
        results.push({ name, ...result });
        if (result.diff && result.pixels > 0) await writeFile(path.join(outDir, "diff", `${name}.png`), result.diff);
        console.log(`${result.ok ? "ok  " : "DIFF"} ${name} ${result.detail}`);
        if (!result.ok) failures.push(`${name}: ${result.detail}`);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await tab.close();
      }
    }
  }
} finally {
  browser.close();
  await host.stop();
  await sleep(500);
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`visual snapshot FAILED\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(update ? `baselines written to ${baselineDir}` : `visual snapshot OK (${results.length} screenshots match; current in ${outDir})`);
