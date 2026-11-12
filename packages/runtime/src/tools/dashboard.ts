import { createHash, randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentHarnessTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { CHART_RENDERER_VERSIONS, datasetKey, validateDashboard, type ChartDataset, type DashboardError, type SemanticsCheck } from "@data-agent/charts";
import { CHARTS_BROWSER_SOURCE } from "@data-agent/charts/browser-source";
import { checkDashboardSpec, dashboardViewData, type DashboardSpec, type DatasetRef } from "@data-agent/contracts";
import { renderDashboardHtml, type DashboardDataSource } from "../dashboard.js";
import { readEchartsSource, resolveEchartsAssetPath } from "../echarts-asset.js";
import type { ArtifactDirectory } from "../facets/artifact-directory.js";
import type { PhysicalProfile } from "../answering/public.js";
import { ChartDataResolver, describeSource } from "../facets/chart-data.js";
import type { DerivedDatasets } from "../facets/derived-datasets.js";
import type { WorkspaceStore } from "../workspace.js";
import { trustedContext, type DataAgentToolContext } from "./answering.js";
import { MAX_WIDGET_ROWS, declaredFields, jsonSafeRows, semanticChecks } from "./charts.js";
import { defineDataAgentTool, type DataAgentToolDefinition } from "./tool-definition.js";

export const GENERATE_DASHBOARD_PARAMETERS = Type.Object({
  operation: Type.Union([Type.Literal("validate"), Type.Literal("create"), Type.Literal("edit")]),
  /** A DashboardSpec v1; validated against the published results it references. */
  spec: Type.Unknown(),
  /** The dashboard to overwrite on edit, e.g. "dashboards/sales.html". */
  editPath: Type.Optional(Type.String({ pattern: "^dashboards/.+\\.html$" })),
}, { additionalProperties: false });
type GenerateDashboardInput = Static<typeof GENERATE_DASHBOARD_PARAMETERS>;

export interface DashboardToolOptions {
  readonly workspace: WorkspaceStore;
  readonly artifacts: Pick<ArtifactDirectory, "resolveRows" | "resolveReceipt">;
  /** Derived datasets registered by run_python; without it views read published results only. */
  readonly derived?: Pick<DerivedDatasets, "resolve">;
  /** ECharts source to inline; defaults to the installed echarts build. */
  readonly echartsSource?: () => Promise<string | undefined>;
}

/** Each view's rows travel inside the HTML, so a dataset holds as many rows as a chat chart. */
export const MAX_DASHBOARD_DATASET_ROWS = MAX_WIDGET_ROWS;

function formatDashboardErrors(errors: readonly Pick<DashboardError, "code" | "message" | "path" | "hint">[]): string {
  const lines = errors.map((error) => `[${error.code}] ${error.message}${error.path ? ` (${error.path})` : ""}${error.hint ? `；建议：${error.hint}` : ""}`);
  return `DASHBOARD_SPEC_INVALID\n${lines.join("\n")}`;
}

async function defaultEchartsSource(): Promise<string | undefined> {
  const assetPath = resolveEchartsAssetPath();
  return assetPath ? readEchartsSource(assetPath) : undefined;
}

function declaredViewFields(spec: DashboardSpec): string[] {
  return [...new Set(spec.views.flatMap((view) => declaredFields(view.type === "chart" ? view.chart : view)))];
}

function generateDashboardTool(options: DashboardToolOptions): AgentHarnessTool<DataAgentToolContext> {
  return {
    name: "generate_dashboard",
    label: "generate_dashboard",
    description: "Validate or build a standalone snapshot dashboard from published query results.",
    replay: "never",
    parameters: GENERATE_DASHBOARD_PARAMETERS,
    async execute(_toolCallId, input, _onUpdate, toolContext, invocation, context): Promise<AgentToolResult<unknown>> {
      if (!Value.Check(GENERATE_DASHBOARD_PARAMETERS, input)) throw new Error("GENERATE_DASHBOARD_INPUT_INVALID: operation is validate, create or edit; editPath is dashboards/<name>.html");
      const value = input as GenerateDashboardInput;
      if (value.operation === "edit" && !value.editPath) throw new Error("GENERATE_DASHBOARD_INPUT_INVALID: edit requires editPath");
      const checked = checkDashboardSpec(value.spec);
      if (!checked.ok) throw new Error(formatDashboardErrors(checked.errors.map((error) => ({ ...error, code: "SCHEMA_INVALID" }))));
      const spec = checked.spec;

      const business = trustedContext(toolContext, invocation, context);
      const datasets: Record<string, ChartDataset> = {};
      const sources: Record<string, DashboardDataSource> = {};
      const profiles: Record<string, PhysicalProfile | undefined> = {};
      const resolver = new ChartDataResolver({ publications: options.artifacts, ...(options.derived ? { derived: options.derived } : {}) });
      const refs = new Map<string, DatasetRef>(spec.views.map((view) => [datasetKey(dashboardViewData(view)), dashboardViewData(view)]));
      for (const [key, ref] of refs) {
        const data = await resolver.resolve(ref, business);
        const label = describeSource(data.source);
        if (data.rows.length > MAX_DASHBOARD_DATASET_ROWS) {
          throw new Error(`DASHBOARD_TOO_MANY_ROWS: ${label} has ${data.rows.length} rows and a dashboard view holds at most ${MAX_DASHBOARD_DATASET_ROWS}; aggregate in the query, or use export_query for the detail`);
        }
        datasets[key] = { columns: [...data.columns], rows: jsonSafeRows(data.rows) };
        profiles[key] = data.physicalProfile;
        sources[key] = {
          kind: data.source.kind,
          id: data.source.kind === "publication" ? data.source.receiptId : data.source.derivedId,
          label,
          contentHash: data.source.contentHash,
          disclosures: [...data.disclosures],
          ...(data.source.kind === "publication" && data.source.live ? { live: true, ...(data.source.publishedAt ? { publishedAt: data.source.publishedAt } : {}) } : {}),
        };
      }

      // Validated on the same JSON-safe rows the page reads.
      const validated = validateDashboard(spec, datasets);
      if (!validated.ok) throw new Error(formatDashboardErrors(validated.errors));
      const declared = declaredViewFields(spec);
      const checks: Record<string, SemanticsCheck[]> = {};
      for (const view of spec.views) {
        const found = semanticChecks(view.type === "chart" ? view.chart.fields : view.fields, profiles[datasetKey(dashboardViewData(view))]);
        if (found.length > 0) checks[view.id] = found;
      }
      const summary = [
        ...validated.advice.map((advice) => `[LAYOUT] ${advice.message}`),
        ...validated.notices.map(({ viewId, notice }) => `[NOTICE] ${viewId}: ${notice.message}`),
        ...Object.entries(checks).flatMap(([viewId, found]) => found.map((check) => `[CHECK] ${viewId}: ${check.message}`)),
        ...Object.values(sources).flatMap((source) => [
          ...(source.kind === "derived" ? [`[DERIVED] ${source.label}`] : []),
          ...source.disclosures.map((disclosure) => `[DISCLOSURE] ${source.id}: ${disclosure}`),
        ]),
        ...(declared.length > 0 ? [`[SEMANTICS] 以下字段的语义来自模型声明，未经业务定义核实：${declared.join("、")}`] : []),
      ];
      if (value.operation === "validate") return { content: [{ type: "text", text: ["dashboard spec valid", ...summary].join("\n") }], details: null };

      const specHash = createHash("sha256").update(JSON.stringify(spec)).digest("hex").slice(0, 8);
      const relativePath = value.editPath ?? `dashboards/${spec.filename ?? `dashboard-${specHash}`}.html`;
      const echartsSource = await (options.echartsSource ?? defaultEchartsSource)();
      const html = renderDashboardHtml(
        // The local calendar day, as the reader of the page counts it.
        { spec, datasets, sources, checks, renderer: CHART_RENDERER_VERSIONS, builtOn: new Date().toLocaleDateString("sv-SE"), nonce: randomUUID() },
        { chartsSource: CHARTS_BROWSER_SOURCE, ...(echartsSource ? { echartsSource } : {}) },
      );
      await options.workspace.write(relativePath, html);
      const text = [
        `[DASHBOARD_CREATED] ${relativePath}`,
        ...summary,
        ...(echartsSource ? [] : ["[WARNING] ECharts 未找到，看板中的图表无法渲染。"]),
        ...(Object.keys(checks).length > 0 ? ["[CHECK] 是对字段声明的核对提示：声明有误就改正 spec 后用 edit 重建看板。"] : []),
        "看板页面只显示数据，以及各视图下有关数据的 [NOTICE] 与 [CHECK]；[DISCLOSURE]、[SEMANTICS] 与派生来源不印在页面上，答复用户时必须如实转述。标签旋转、截断与未声明日期等 [NOTICE] 只给你调整 spec 用，能改就改 spec 重建，不必转述。",
      ].join("\n");
      return {
        content: [{ type: "text", text }],
        details: { relativePath, fileType: "html", contentHash: createHash("sha256").update(html).digest("hex"), receiptIds: Object.values(sources).filter((source) => source.kind === "publication").map((source) => source.id), sources: Object.values(sources).map(({ kind, id, contentHash }) => ({ kind, id, contentHash })), renderer: CHART_RENDERER_VERSIONS },
      };
    },
  };
}

export function createDashboardToolDefinitions(options: DashboardToolOptions): readonly DataAgentToolDefinition<DataAgentToolContext>[] {
  return [defineDataAgentTool(generateDashboardTool(options), {
    promptSnippet: "用已发布的查询结果生成独立 HTML 快照看板。",
    promptGuidelines: [
      "仅在看板需求和 dashboard Skill 已授权时使用。spec 为 DashboardSpec v1：views 由 chart（ChartSpec）、table、kpi 组成，每个视图的数据引用 { kind: \"publication\", receiptId }；layout.rows 把视图排成一行 1–4 个格子。",
      "先 operation=\"validate\"，通过后 \"create\"；edit 需要完整 spec 和 editPath。工具不聚合、不补零，KPI 只显示一个单元格；出错时按返回的错误修改查询或 spec，有 [LAYOUT] 建议时调整 layout 再生成。",
    ],
  })];
}
