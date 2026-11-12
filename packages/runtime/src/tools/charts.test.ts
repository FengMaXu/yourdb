import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAnsweringStore } from "../answering/answering-store.js";
import { InMemoryResultStore } from "../answering/result-store.js";
import { InMemoryAnswering } from "../answering/service.js";
import type { BusinessContext, PublicationId } from "../answering/model.js";
import { ArtifactDirectory } from "../facets/artifact-directory.js";
import { WorkspaceStore } from "../workspace.js";
import { validateWidgetSpec } from "../widget.js";
import { createAnsweringAgentToolDefinitions } from "./answering.js";
import { CHART_COMPILER_VERSION, CHART_THEME_VERSION } from "@data-agent/charts";
import { MAX_WIDGET_ROWS, createChartToolDefinitions, type ChartRenderRecord } from "./charts.js";
import { createCoreAgentToolDefinitions } from "./core.js";

const context = (invocationId: string): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const invocation = (invocationId: string) => ({ operationId: "operation-1", invocationId, getMemo: async () => undefined, setMemo: async () => undefined }) as never;
const toolContext = { sessionId: "session-1", principalId: "user-1" } as never;
const listSpec = { "population.entity": "industries", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "sum", of: "sales" }, grouping: "n/a", selection: "n/a", output: { rowMode: "full" } };

async function setup(rows: unknown[][]) {
  const store = new InMemoryAnsweringStore();
  const resultStore = new InMemoryResultStore();
  const answering = new InMemoryAnswering({ store, resultStore, sqlExecutor: { run: async () => ({ columns: ["industry", "sales"], rows, truncated: false }) } });
  const begun = await answering.set({ requestMessageId: "message-1", requestId: "begin-1", fields: listSpec }, context("begin-1"));
  const execution = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT industry, sales FROM t" }, context("execute-1"));
  if (execution.artifact.kind !== "candidate") throw new Error("expected Result Candidate");
  const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish-1" }, context("publish-1"));
  // The same Receipt-bound wiring the session runtime uses.
  const artifacts = new ArtifactDirectory({
    findPublication: (publicationId, business) => store.transact((tx) => tx.getReceipt(publicationId as PublicationId), business),
    readAuthorized: async (found, business) => resultStore.encodeCsv(found.resultRef, business),
    readRowsAuthorized: async (found, business) => {
      const result = await resultStore.openAuthorized(found.resultRef, found, business);
      return { columns: result.columns, rows: result.rows, contentHash: result.contentHash };
    },
  });
  const root = await mkdtemp(join(tmpdir(), "data-agent-charts-"));
  const workspace = new WorkspaceStore(root, { userId: "user-1", sessionId: "session-1" });
  const tool = createChartToolDefinitions({ workspace, artifacts })[0]!.tool;
  const showWidget = createCoreAgentToolDefinitions({ workspace, publishedRows: artifacts }).map((definition) => definition.tool).find((item) => item.name === "show_widget")!;
  const publishText = async () => {
    const publish = createAnsweringAgentToolDefinitions(answering, artifacts).map((definition) => definition.tool).find((item) => item.name === "publish_query_result")!;
    const result = await publish.execute("publish", { candidateId: execution.artifact.candidateId, format: "auto" } as never, undefined, toolContext, invocation("publish-2"), {} as never);
    return (result.content[0] as { text: string }).text;
  };
  return { receipt, root, tool, showWidget, publishText, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function chartSpec(receiptId: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    data: { kind: "publication", receiptId },
    fields: { sales: { type: "quantitative", storage: "raw", unit: "亿元", additivity: "additive", label: "销售额" } },
    chart: { mark: "cartesian", x: { field: "industry" }, layers: [{ type: "bar", y: { field: "sales" } }] },
    ...extra,
  };
}

describe("render_chart", () => {
  it("renders a published result into the workspace and reports notices and semantics", async () => {
    const { receipt, root, tool, cleanup } = await setup([["批发业", "5234.00"], ["零售业", "499.88"], ["住宿和餐饮业", null]]);
    const result = await tool.execute("render", { spec: chartSpec(receipt.receiptId), fileName: "行业销售额" } as never, undefined, toolContext, invocation("render-1"), {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[CHART_RENDERED\] charts\/行业销售额\.svg \(800×480\)/);
    expect(text).toContain("[NOTICE]");
    expect(text).toContain("[SEMANTICS]");
    expect(text).toContain("![标题](charts/行业销售额.svg)");
    const svg = await readFile(join(root, "charts", "行业销售额.svg"), "utf8");
    expect(svg).toContain("住宿和餐饮业");
    expect(svg).toContain("销售额（亿元）");
    await cleanup();
  });

  it("records the spec, data identity and versions next to the SVG, without rows", async () => {
    const { receipt, root, tool, cleanup } = await setup([["批发业", "5234.00"], ["住宿和餐饮业", null]]);
    const spec = chartSpec(receipt.receiptId, { title: "行业销售额" });
    const result = await tool.execute("render", { spec, fileName: "行业销售额", width: 640, height: 360 } as never, undefined, toolContext, invocation("render-record"), {} as never);
    expect(result.details).toMatchObject({ relativePath: "charts/行业销售额.svg", recordPath: "charts/行业销售额.chart.json", renderer: { compiler: CHART_COMPILER_VERSION, theme: CHART_THEME_VERSION } });
    const text = await readFile(join(root, "charts", "行业销售额.chart.json"), "utf8");
    const record = JSON.parse(text) as ChartRenderRecord;
    expect(record).toEqual({
      version: 1,
      svg: "行业销售额.svg",
      chartSpec: spec,
      data: { kind: "publication", receiptId: receipt.receiptId, contentHash: receipt.contentHash },
      renderer: { compiler: CHART_COMPILER_VERSION, theme: CHART_THEME_VERSION },
      target: "static",
      width: 640,
      height: 360,
      notices: [expect.objectContaining({ code: "NULL_VALUES" })],
      checks: [],
    });
    expect(text).not.toContain("5234.00");
    await cleanup();
  });

  it("names the receipt explicitly in publish tool text so charts can cite it", async () => {
    const { receipt, publishText, cleanup } = await setup([["批发业", 1]]);
    expect(await publishText()).toContain(`receiptId=${receipt.receiptId}`);
    await cleanup();
  });

  it("only reads published results", async () => {
    const { tool, cleanup } = await setup([["批发业", 1]]);
    const inline = { ...chartSpec("x"), data: { kind: "inline", rows: [["批发业", 1]] } };
    await expect(tool.execute("render", { spec: inline } as never, undefined, toolContext, invocation("render-inline"), {} as never)).rejects.toThrow("CHART_DATA_UNSUPPORTED");
    // A host without a derived store cannot serve derived datasets.
    const derived = { ...chartSpec("x"), data: { kind: "derived", derivedId: "d1" } };
    await expect(tool.execute("render", { spec: derived } as never, undefined, toolContext, invocation("render-derived"), {} as never)).rejects.toThrow("DERIVED_DATASET_UNAVAILABLE");
    await expect(tool.execute("render", { spec: chartSpec("publication_missing") } as never, undefined, toolContext, invocation("render-missing"), {} as never)).rejects.toThrow("PUBLICATION_NOT_FOUND");
    await cleanup();
  });

  it("returns the compiler's structured errors and writes nothing", async () => {
    const { receipt, root, tool, cleanup } = await setup([["批发业", 1], ["批发业", 2]]);
    await expect(tool.execute("render", { spec: chartSpec(receipt.receiptId), fileName: "dup" } as never, undefined, toolContext, invocation("render-dup"), {} as never))
      .rejects.toThrow(/CHART_SPEC_INVALID[\s\S]*\[DUPLICATE_KEY\][\s\S]*建议/);
    await expect(readFile(join(root, "charts", "dup.svg"), "utf8")).rejects.toThrow();
    await cleanup();
  });

  it("rejects rows that do not match the Receipt's content hash", async () => {
    const { receipt } = await setup([["批发业", 1]]);
    const tampered = new ArtifactDirectory({
      findPublication: async () => receipt,
      readAuthorized: async () => ({ content: "", contentHash: "" }),
      readRowsAuthorized: async () => ({ columns: ["industry", "sales"], rows: [["批发业", 999]], contentHash: "forged" }),
    });
    await expect(tampered.resolveRows(receipt.receiptId, context("tampered"))).rejects.toThrow("PUBLICATION_INTEGRITY_MISMATCH");
  });
});

describe("Declared semantics against the Physical Profile", () => {
  // Sales in the hundreds declared as a ratio: the profile makes the declaration doubtful.
  const misdeclared = (receiptId: string) => chartSpec(receiptId, { fields: { sales: { type: "quantitative", storage: "ratio", additivity: "additive", label: "销售额" } } });

  it("reports doubtful declarations from render_chart, in the text and the record, without blocking", async () => {
    const { receipt, root, tool, cleanup } = await setup([["批发业", "5234.00"], ["零售业", "499.88"]]);
    const result = await tool.execute("render", { spec: misdeclared(receipt.receiptId), fileName: "misdeclared" } as never, undefined, toolContext, invocation("render-check"), {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[CHART_RENDERED\]/);
    expect(text).toContain("[CHECK] 销售额 声明为比率（0.12 表示 12%），但数值范围为 [499.88, 5234.00]");
    const record = JSON.parse(await readFile(join(root, "charts", "misdeclared.chart.json"), "utf8")) as ChartRenderRecord;
    expect(record.checks.map((check) => check.code)).toEqual(["RATIO_OUT_OF_RANGE"]);
    await cleanup();
  });

  it("reports them from show_widget in the widget and the model text", async () => {
    const { receipt, showWidget, cleanup } = await setup([["批发业", "5234.00"]]);
    const result = await showWidget.execute("widget-check", { kind: "chart", spec: misdeclared(receipt.receiptId) } as never, undefined, toolContext, invocation("widget-check"), {} as never);
    const widget = (result.details as { widget: Record<string, unknown> }).widget;
    expect(widget.semanticChecks).toEqual([expect.objectContaining({ code: "RATIO_OUT_OF_RANGE", field: "sales" })]);
    expect((result.content[0] as { text: string }).text).toContain("[CHECK] 销售额 声明为比率");
    await cleanup();
  });
});

describe("show_widget chart", () => {
  const call = (showWidget: Awaited<ReturnType<typeof setup>>["showWidget"], kind: string, spec: unknown, id: string) =>
    showWidget.execute(id, { kind, spec } as never, undefined, toolContext, invocation(id), {} as never);

  it("builds a versioned widget from a published result and keeps the rows out of the model text", async () => {
    const { receipt, showWidget, cleanup } = await setup([["批发业", 9007199254740993n], ["零售业", null]]);
    const result = await call(showWidget, "chart", chartSpec(receipt.receiptId, { title: "行业销售额" }), "widget-chart");
    const widget = (result.details as { widget: Record<string, unknown> }).widget;
    expect(widget).toMatchObject({ kind: "chart", title: "行业销售额", contractVersion: 2, renderer: { compiler: CHART_COMPILER_VERSION, theme: CHART_THEME_VERSION }, receiptId: receipt.receiptId });
    // bigint survives as exact decimal text so the persisted widget stays JSON.
    expect((widget.dataset as { rows: unknown[][] }).rows).toEqual([["批发业", "9007199254740993"], ["零售业", null]]);
    expect(() => JSON.stringify(result.details)).not.toThrow();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[widget:chart\] 行业销售额 \(receiptId=.+, 2 行\)/);
    expect(text).toContain("[NOTICE]");
    expect(text).not.toContain("9007199254740993");
    expect(validateWidgetSpec("chart", widget).ok).toBe(true);
    await cleanup();
  });

  it("rejects model-written chart rows", async () => {
    const { showWidget, cleanup } = await setup([["批发业", 1]]);
    await expect(call(showWidget, "chart", { title: "Sales", data: [{ label: "North", value: 10 }] }, "widget-rows")).rejects.toThrow("CHART_DATA_UNSUPPORTED");
    await cleanup();
  });

  it("still validates widgets replayed from earlier sessions", () => {
    expect(validateWidgetSpec("chart", { title: "Sales", data: [{ label: "North", value: 10 }] }).ok).toBe(true);
    expect(validateWidgetSpec("chart", { title: "Sales", contractVersion: 2 }).ok).toBe(false);
  });

  it("returns compiler errors and bounds the rows a chat chart may hold", async () => {
    const duplicated = await setup([["批发业", 1], ["批发业", 2]]);
    await expect(call(duplicated.showWidget, "chart", chartSpec(duplicated.receipt.receiptId), "widget-dup")).rejects.toThrow(/CHART_SPEC_INVALID[\s\S]*DUPLICATE_KEY/);
    await duplicated.cleanup();
    const large = await setup(Array.from({ length: MAX_WIDGET_ROWS + 1 }, (_, index) => [`r${index}`, index]));
    await expect(call(large.showWidget, "chart", chartSpec(large.receipt.receiptId), "widget-large")).rejects.toThrow("WIDGET_CHART_TOO_MANY_ROWS");
    await large.cleanup();
  });

  it("validates declared table semantics and versions new tables", async () => {
    const { showWidget, cleanup } = await setup([["批发业", 1]]);
    await expect(call(showWidget, "table", { title: "T", data: [{ rate: 0.1 }], fields: { rate: { type: "quantitative", storage: "ratio" } } }, "table-bad")).rejects.toThrow("WIDGET_SPEC_INVALID");
    const ok = await call(showWidget, "table", { title: "T", data: [{ rate: 0.1 }], fields: { rate: { type: "quantitative", storage: "ratio", additivity: "non_additive" } } }, "table-ok");
    expect((ok.details as { widget: Record<string, unknown> }).widget).toMatchObject({ kind: "table", contractVersion: 2 });
    await cleanup();
  });
});
