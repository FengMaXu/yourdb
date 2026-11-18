#!/usr/bin/env node
/**
 * Browser smoke test for chart delivery, in a real headless Edge or Chrome:
 *   - a render_chart SVG loads as an image, as the file preview shows it;
 *   - a snapshot dashboard runs inside an iframe with the app preview's own
 *     srcDoc + sandbox, compiles every chart with the inlined bundle and ECharts;
 *   - the chat ChartSpecWidget, bundled from the frontend source, draws with ECharts.
 * Each page must raise no script error. Needs the built packages (npm run build).
 *
 *   node scripts/smoke-charts-browser.mjs [--out <screenshot dir>]
 * The browser is CHART_SMOKE_BROWSER, or Edge/Chrome at their usual Windows, macOS or Linux paths.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : undefined;
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

const { renderChartSvg } = await load("packages/runtime/dist/chart-render.js");
const { renderDashboardHtml } = await load("packages/runtime/dist/dashboard.js");
const { readEchartsSource, resolveEchartsAssetPath } = await load("packages/runtime/dist/echarts-asset.js");
const { CHARTS_BROWSER_SOURCE } = await load("packages/charts/dist/browser-source.js");
const { CHART_RENDERER_VERSIONS, datasetKey, validateDashboard } = await load("packages/charts/dist/index.js");

// ─── Sample data ──────────────────────────────────────────────────────────────
const ref = (receiptId) => ({ kind: "publication", receiptId });
const sales = { type: "quantitative", storage: "raw", unit: "亿元", additivity: "additive", label: "累计销售额" };
const yoy = { type: "quantitative", storage: "ratio", additivity: "non_additive", label: "同比增速" };
const month = { type: "temporal", grain: "month", zone: "floating" };
const industries = { columns: ["industry", "sales", "yoy"], rows: [["批发业", "6710.25", -0.2512], ["零售业（含网上零售和无店铺零售）", "499.88", 0.1646], ["住宿和餐饮业", "66.44", null]] };
const trend = { columns: ["month", "industry", "yoy"], rows: ["01", "02", "03", "04"].flatMap((m, i) => [[`2025-${m}-01`, "批发业", -0.1 - i * 0.02], [`2025-${m}-01`, "零售业", 0.05 + i * 0.02]]) };
const totals = { columns: ["total_sales", "yoy"], rows: [["7276.57", -0.2334]] };
const bins = { columns: ["lo", "hi", "n"], rows: [[0, 100, 12], [100, 200, 30], [200, 300, 22]] };
const boxes = { columns: ["region", "a", "b", "c", "d", "e"], rows: [["华东", 10, 25, 40, 55, 90], ["华南", 5, 18, 30, 42, 70]] };
const price = { type: "quantitative", storage: "raw", unit: "元", additivity: "non_additive", label: "单价" };
const funnelRows = { columns: ["a", "n"], rows: [["访问", 1000], ["注册", 300], ["付费", 45]] };
const flows = { columns: ["a", "b", "n"], rows: [["访问", "注册", 60], ["访问", "离开", 40], ["注册", "付费", 12]] };
const tree = { columns: ["a", "b", "n"], rows: [["批发零售", "批发", 60], ["批发零售", "零售", 30], ["住宿餐饮", "餐饮", 10]] };
const bridge = { columns: ["step", "s", "e", "t"], rows: [["期初", 0, 100, true], ["收入", 100, 160, false], ["成本", 160, 90, false], ["期末", 0, 90, true]] };
const barSpec = { version: 1, title: "三大行业累计销售额与同比增速", data: ref("p_ind"), fields: { sales, yoy }, chart: { mark: "cartesian", x: { field: "industry" }, layers: [{ type: "bar", y: { field: "sales" } }, { type: "line", y: { field: "yoy", axis: "right" } }] } };
const dashboardSpec = {
  version: 1, title: "三大行业经营分析 <A&B>", views: [
    { id: "kpi", type: "kpi", title: "核心指标", data: ref("p_total"), fields: { total_sales: sales, yoy }, cards: [{ value: { field: "total_sales" }, delta: { field: "yoy", label: "同比" } }] },
    { id: "bar", type: "chart", chart: barSpec },
    { id: "trend", type: "chart", chart: { version: 1, title: "同比增速走势", data: ref("p_trend"), fields: { yoy, month }, chart: { mark: "cartesian", x: { field: "month" }, layers: [{ type: "line", y: { field: "yoy" }, series: { field: "industry" } }] } } },
    { id: "heat", type: "chart", chart: { version: 1, title: "同比增速热力图", data: ref("p_trend"), fields: { yoy, month }, chart: { mark: "heatmap", x: { field: "month" }, y: { field: "industry" }, color: { field: "yoy", scale: "diverging", midpoint: 0 } } } },
    { id: "hist", type: "chart", chart: { version: 1, title: "订单金额分布", data: ref("p_bins"), fields: { lo: price, hi: price, n: sales }, chart: { mark: "histogram", start: { field: "lo" }, end: { field: "hi" }, value: { field: "n" } } } },
    { id: "box", type: "chart", chart: { version: 1, title: "单价分布", data: ref("p_boxes"), fields: { a: price, b: price, c: price, d: price, e: price }, chart: { mark: "boxplot", category: { field: "region" }, min: { field: "a" }, q1: { field: "b" }, median: { field: "c" }, q3: { field: "d" }, max: { field: "e" }, whisker: "min_max" } } },
    { id: "bridge", type: "chart", chart: { version: 1, title: "利润变动拆解", data: ref("p_bridge"), fields: { s: price, e: price }, chart: { mark: "waterfall", step: { field: "step" }, start: { field: "s" }, end: { field: "e" }, total: { field: "t" } } } },
    { id: "flow", type: "chart", chart: { version: 1, title: "流向", data: ref("p_flows"), fields: { n: sales }, chart: { mark: "sankey", source: { field: "a" }, target: { field: "b" }, value: { field: "n" } } } },
    { id: "tree", type: "chart", chart: { version: 1, title: "构成", data: ref("p_tree"), fields: { n: sales }, chart: { mark: "treemap", path: [{ field: "a" }, { field: "b" }], value: { field: "n" } } } },
    { id: "funnel", type: "chart", chart: { version: 1, title: "转化漏斗", data: ref("p_funnel"), fields: { n: sales }, chart: { mark: "funnel", stage: { field: "a" }, value: { field: "n" } } } },
    { id: "rings", type: "chart", chart: { version: 1, title: "构成（旭日）", data: ref("p_tree"), fields: { n: sales }, chart: { mark: "sunburst", path: [{ field: "a" }, { field: "b" }], value: { field: "n" } } } },
    { id: "area", type: "chart", chart: { version: 1, title: "同比增速（面积）", data: ref("p_trend"), fields: { yoy, month }, chart: { mark: "cartesian", x: { field: "month" }, layers: [{ type: "area", y: { field: "yoy" }, series: { field: "industry" } }] } } },
    { id: "share", type: "chart", chart: { version: 1, title: "构成", data: ref("p_ind"), fields: { sales }, chart: { mark: "pie", category: { field: "industry" }, value: { field: "sales" } } } },
    { id: "detail", type: "table", title: "明细", data: ref("p_ind"), fields: { sales, yoy } },
  ],
};

// ─── Browser over the DevTools protocol ───────────────────────────────────────
function browserPath() {
  const candidates = [
    process.env.CHART_SMOKE_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function launch(userDataDir) {
  const executable = browserPath();
  if (!executable) throw new Error("No Edge or Chrome found; set CHART_SMOKE_BROWSER");
  const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: "ignore" });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300 && !existsSync(portFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(portFile)) { child.kill(); throw new Error(`${executable} did not open a debugging port within 30 s`); }
  const [port] = (await readFile(portFile, "utf8")).split("\n");
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
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, listeners, close: () => { socket.close(); child.kill(); } };
}

/** Open a page, wait for it to settle, and collect every script error, including those of child frames. */
async function openPage(browser, url) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const errors = [];
  const sessions = new Set([sessionId]);
  const contexts = [];
  const listener = (message) => {
    if (!message.sessionId || !sessions.has(message.sessionId)) return;
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
    if (message.method === "Runtime.executionContextCreated") contexts.push({ sessionId: message.sessionId, ...message.params.context });
    if (message.method === "Runtime.executionContextDestroyed") contexts.splice(0, contexts.length, ...contexts.filter((item) => !(item.sessionId === message.sessionId && item.id === message.params.executionContextId)));
    if (message.method === "Runtime.executionContextsCleared") contexts.splice(0, contexts.length, ...contexts.filter((item) => item.sessionId !== message.sessionId));
    if (message.method === "Target.attachedToTarget") {
      sessions.add(message.params.sessionId);
      browser.send("Runtime.enable", {}, message.params.sessionId).then(() => browser.send("Runtime.runIfWaitingForDebugger", {}, message.params.sessionId)).catch(() => undefined);
    }
  };
  browser.listeners.add(listener);
  await browser.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 3400, deviceScaleFactor: 1, mobile: false }, sessionId);
  await browser.send("Page.navigate", { url }, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  /** Evaluate in the main frame, or in the child frame when `inFrame` is set. */
  const evaluate = async (expression, inFrame = false) => {
    const { frameTree } = await browser.send("Page.getFrameTree", {}, sessionId);
    // A sandboxed srcDoc frame runs out of process: it is absent from this frame tree and has its own attached session.
    const context = inFrame
      ? contexts.findLast((item) => item.sessionId !== sessionId && item.auxData?.isDefault)
      : contexts.findLast((item) => item.sessionId === sessionId && item.auxData?.frameId === frameTree.frame.id && item.auxData?.isDefault);
    if (!context) throw new Error(`no execution context for the ${inFrame ? "child" : "main"} frame`);
    const { result, exceptionDetails } = await browser.send("Runtime.evaluate", { expression, contextId: context.id, returnByValue: true }, context.sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const screenshot = async (name) => {
    if (!outDir) return;
    const { data } = await browser.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
    await writeFile(path.join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  };
  return { errors, evaluate, screenshot, close: () => { browser.listeners.delete(listener); return browser.send("Target.closeTarget", { targetId }); } };
}

// ─── Checks ───────────────────────────────────────────────────────────────────
const failures = [];
const check = (name, condition, detail) => { if (!condition) failures.push(`${name}: ${detail}`); else console.log(`ok  ${name}`); };

const work = await mkdtemp(path.join(tmpdir(), "chart-smoke-"));
if (outDir) await mkdir(outDir, { recursive: true });
const browser = await launch(path.join(work, "profile"));
try {
  // 1. render_chart output, shown by the file preview as an image.
  const svg = renderChartSvg(barSpec, industries);
  if (!svg.ok) throw new Error(JSON.stringify(svg.errors));
  await writeFile(path.join(work, "chart.svg"), svg.svg);
  await writeFile(path.join(work, "svg.html"), `<!doctype html><img id="chart" src="chart.svg">`);
  const svgPage = await openPage(browser, pathToFileURL(path.join(work, "svg.html")).href);
  const image = await svgPage.evaluate("(() => { const img = document.getElementById('chart'); return { complete: img.complete, width: img.naturalWidth }; })()");
  check("svg loads as an image", image.complete && image.width > 0, JSON.stringify(image));
  check("svg page has no script error", svgPage.errors.length === 0, svgPage.errors.join(" | "));
  await svgPage.screenshot("svg");
  await svgPage.close();

  // 2. Snapshot dashboard inside the app preview's iframe (GlobalPreviewModal: srcDoc + this sandbox).
  const datasets = { [datasetKey(ref("p_ind"))]: industries, [datasetKey(ref("p_trend"))]: trend, [datasetKey(ref("p_total"))]: totals, [datasetKey(ref("p_bins"))]: bins, [datasetKey(ref("p_boxes"))]: boxes, [datasetKey(ref("p_bridge"))]: bridge, [datasetKey(ref("p_flows"))]: flows, [datasetKey(ref("p_tree"))]: tree, [datasetKey(ref("p_funnel"))]: funnelRows };
  const validated = validateDashboard(dashboardSpec, datasets);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const sources = Object.fromEntries(Object.keys(datasets).map((key) => [key, { kind: "publication", id: key.split(":")[1], label: `发布记录 ${key.split(":")[1]}`, contentHash: "0123456789abcdef", disclosures: [] }]));
  const echartsPath = resolveEchartsAssetPath();
  if (!echartsPath) throw new Error("echarts asset not found");
  const html = renderDashboardHtml({ spec: dashboardSpec, datasets, sources, checks: {}, renderer: CHART_RENDERER_VERSIONS, builtOn: "2026-10-01", nonce: "smoke-snapshot" }, { chartsSource: CHARTS_BROWSER_SOURCE, echartsSource: await readEchartsSource(echartsPath) });
  await writeFile(path.join(work, "preview.html"), `<!doctype html><meta charset="utf-8"><body style="margin:0"><iframe id="preview" sandbox="allow-scripts allow-downloads allow-forms allow-popups" style="width:1280px;height:3360px;border:0"></iframe>
<script src="dashboard.js" charset="utf-8"></script></body>`);
  await writeFile(path.join(work, "dashboard.js"), `document.getElementById("preview").srcdoc = ${JSON.stringify(html)};`);
  const dashboardPage = await openPage(browser, pathToFileURL(path.join(work, "preview.html")).href);
  const dashboard = await dashboardPage.evaluate(`(() => ({
    panels: document.querySelectorAll("section.panel").length,
    // Drawn means the canvas holds non-background pixels, not merely that a canvas exists.
    drawn: [...document.querySelectorAll(".chart")].filter((chart) => [...chart.querySelectorAll("canvas")].some((canvas) => {
      if (canvas.width === 0 || canvas.height === 0) return false;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240)) return true;
      return false;
    })).length,
    unavailable: document.querySelectorAll(".chart-unavailable").length,
    // Number and unit are separate elements, so the text runs together.
    kpi: document.querySelector("#view-kpi .value")?.textContent,
    rows: document.querySelectorAll("#view-detail tbody tr").length,
    // Readers see the data; Receipts and hashes stay in the embedded payload.
    provenance: /发布记录|内容哈希/.test(document.querySelector("main").textContent),
    title: document.title,
  }))()`, true);
  check("dashboard renders every view in the preview sandbox", dashboard.panels === dashboardSpec.views.length, JSON.stringify(dashboard));
  check("dashboard draws every chart with ECharts", dashboard.drawn === 12 && dashboard.unavailable === 0, JSON.stringify(dashboard));
  check("dashboard KPI and table use declared semantics", dashboard.kpi === "7,277亿元" && dashboard.rows === 3 && !dashboard.provenance, JSON.stringify(dashboard));
  check("dashboard title stays escaped", dashboard.title === "三大行业经营分析 <A&B>", dashboard.title);
  check("dashboard raises no script error", dashboardPage.errors.length === 0, dashboardPage.errors.join(" | "));
  await dashboardPage.screenshot("dashboard");
  await dashboardPage.close();

  // 2b. Live refresh bridge (ADR-0010): this host page plays the app, answering the handshake and one refresh.
  const liveKey = datasetKey({ kind: "live", receiptId: "p_live" });
  const liveSpec = { version: 1, title: "实时", views: [{ id: "live", type: "table", data: { kind: "live", receiptId: "p_live" }, fields: { v: sales } }] };
  const liveHtml = renderDashboardHtml({
    spec: liveSpec,
    datasets: { [liveKey]: { columns: ["region", "v"], rows: [["华东", "10"]] } },
    sources: { [liveKey]: { kind: "publication", id: "p_live", label: "实时数据：发布记录 p_live", contentHash: "0123456789abcdef", disclosures: [], live: true } },
    checks: {}, renderer: CHART_RENDERER_VERSIONS, builtOn: "2026-10-01", nonce: "smoke-live",
  }, { chartsSource: CHARTS_BROWSER_SOURCE });
  await writeFile(path.join(work, "live.html"), liveHtml);
  await writeFile(path.join(work, "live-host.js"), `const frame = document.getElementById("preview");
window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (event.source !== frame.contentWindow || message.nonce !== "smoke-live") return;
  if (message.kind === "dashboard.ready") frame.contentWindow.postMessage({ kind: "dashboard.host", nonce: message.nonce }, "*");
  if (message.kind === "dashboard.refresh") {
    window.__requests = (window.__requests || []).concat([message]);
    frame.contentWindow.postMessage({ kind: "dashboard.refreshed", nonce: message.nonce, requestId: message.requestId,
      datasets: { ${JSON.stringify(liveKey)}: { columns: ["region", "v"], rows: [["华东", "12"], ["华南", "5"]] } },
      sources: { ${JSON.stringify(liveKey)}: { kind: "publication", id: "p_live_2", label: "实时数据：发布记录 p_live_2", contentHash: "fedcba9876543210", disclosures: [], live: true } },
      checks: {} }, "*");
  }
});
frame.srcdoc = ${JSON.stringify(liveHtml)};`);
  await writeFile(path.join(work, "live-host.html"), `<!doctype html><meta charset="utf-8"><iframe id="preview" sandbox="allow-scripts allow-downloads allow-forms allow-popups" style="width:900px;height:400px;border:0"></iframe><script src="live-host.js" charset="utf-8"></script>`);
  const livePage = await openPage(browser, pathToFileURL(path.join(work, "live-host.html")).href);
  const before = await livePage.evaluate(`(() => ({ hosted: document.body.classList.contains("hosted"), button: getComputedStyle(document.querySelector("#view-live .version button")).display, cells: [...document.querySelectorAll("#view-live tbody td")].map((td) => td.textContent) }))()`, true);
  check("live view shows its refresh control once the app answers", before.hosted && before.button !== "none", JSON.stringify(before));
  await livePage.evaluate(`document.querySelector("#view-live .version button").click()`, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await livePage.evaluate(`(() => ({ cells: [...document.querySelectorAll("#view-live tbody td")].map((td) => td.textContent), version: document.querySelector("#view-live .version span").textContent, header: document.querySelectorAll("#view-live th")[1]?.textContent }))()`, true);
  const requests = await livePage.evaluate("window.__requests || []");
  check("refresh asks for view ids only", requests.length === 1 && JSON.stringify(Object.keys(requests[0]).sort()) === JSON.stringify(["kind", "nonce", "requestId", "viewIds"]) && requests[0].viewIds[0] === "live", JSON.stringify(requests));
  check("refreshed rows and data version replace the old ones", after.cells.join(",") === "华东,12,华南,5" && after.header.endsWith("（亿元）") && after.version.includes("p_live_2"), JSON.stringify(after));
  check("live page raises no script error", livePage.errors.length === 0, livePage.errors.join(" | "));
  await livePage.close();
  // Opened on its own there is no app: no refresh control, only the snapshot.
  const standalone = await openPage(browser, pathToFileURL(path.join(work, "live.html")).href);
  const alone = await standalone.evaluate(`getComputedStyle(document.querySelector("#view-live .version button")).display`);
  check("outside the app the live view is a snapshot without refresh", alone === "none", alone);
  await standalone.close();

  // 3. The chat ChartSpecWidget, bundled from the frontend source and drawn by real ECharts.
  const bundle = await build({
    stdin: {
      contents: `import React from "react"; import { createRoot } from "react-dom/client"; import ChartSpecWidget from "./components/widgets/ChartSpecWidget";
        const widget = ${JSON.stringify({ chartSpec: barSpec, dataset: industries, disclosure: "Disclosure 示例", declaredFields: ["sales", "yoy"], semanticChecks: [{ code: "RATIO_OUT_OF_RANGE", field: "yoy", message: "CHECK 示例" }] })};
        createRoot(document.getElementById("root")).render(React.createElement("div", { style: { width: 720 } }, React.createElement(ChartSpecWidget, { widget })));`,
      resolveDir: path.join(root, "frontend", "src"), loader: "tsx",
    },
    bundle: true, format: "iife", platform: "browser", jsx: "automatic", write: false, logLevel: "silent",
    define: { "process.env.NODE_ENV": "\"production\"" },
  });
  await writeFile(path.join(work, "widget.js"), bundle.outputFiles[0].text);
  await writeFile(path.join(work, "widget.html"), `<!doctype html><meta charset="utf-8"><div id="root"></div><script src="widget.js"></script>`);
  const widgetPage = await openPage(browser, pathToFileURL(path.join(work, "widget.html")).href);
  const widget = await widgetPage.evaluate(`(() => ({ canvases: document.querySelectorAll("[data-testid=chart-spec-canvas] canvas").length, text: document.body.innerText }))()`);
  check("chat widget draws with ECharts", widget.canvases > 0, JSON.stringify(widget));
  check("chat widget shows notices, checks and provenance", ["未按 0 绘制", "CHECK 示例", "字段含义由模型声明"].every((text) => widget.text.includes(text)), widget.text);
  // The raw disclosure summary stays out of the chart: its per-clause detail lives in the Basis panel.
  check("chat widget keeps the raw disclosure summary out", !widget.text.includes("Disclosure 示例"), widget.text);
  check("chat widget raises no script error", widgetPage.errors.length === 0, widgetPage.errors.join(" | "));
  await widgetPage.screenshot("widget");
  await widgetPage.close();
} finally {
  browser.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

if (failures.length > 0) {
  console.error(`chart browser smoke FAILED\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`chart browser smoke OK${outDir ? ` (screenshots in ${outDir})` : ""}`);
