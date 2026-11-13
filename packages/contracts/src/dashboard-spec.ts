import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ChartSpecSchema, DatasetRefSchema, FieldMetaSchema, checkChartSpec, type DatasetRef } from "./chart-spec.js";

/**
 * DashboardSpec v1 (ADR-0008 step 4): a snapshot dashboard whose views are
 * ChartSpecs, tables, KPI cards and findings. Every view reads one Dataset Reference.
 */
export const DASHBOARD_SPEC_VERSION = 1 as const;

const Strict = { additionalProperties: false } as const;
const Name = Type.String({ minLength: 1 });
const ViewId = Type.String({ pattern: "^[A-Za-z0-9_\\-]{1,64}$" });
/** Placement used only when the spec has no `layout`, so a saved dashboard without rows still opens and refreshes. */
const Width = Type.Optional(Type.Union([Type.Literal("half"), Type.Literal("full")]));
const Fields = Type.Optional(Type.Record(Type.String(), FieldMetaSchema));

export const DashboardChartViewSchema = Type.Object({
  id: ViewId,
  type: Type.Literal("chart"),
  /** Title and subtitle come from the ChartSpec. */
  chart: ChartSpecSchema,
  width: Width,
}, Strict);

export const DashboardTableViewSchema = Type.Object({
  id: ViewId,
  type: Type.Literal("table"),
  title: Type.Optional(Name),
  subtitle: Type.Optional(Name),
  data: DatasetRefSchema,
  /** Shown in this order; all columns when omitted. */
  columns: Type.Optional(Type.Array(Type.Object({
    field: Name,
    label: Type.Optional(Name),
    /** A bar in the cell, scaled to the column's largest absolute value; declared measures only. */
    bar: Type.Optional(Type.Boolean()),
    /** Cells above the same row's `field` take the tone, e.g. a category rate above the site average is "bad". */
    compare: Type.Optional(Type.Object({ field: Name, above: Type.Union([Type.Literal("bad"), Type.Literal("good")]) }, Strict)),
  }, Strict), { minItems: 1 })),
  /** Declared semantics format numeric columns; undeclared values are shown as stored. */
  fields: Fields,
  width: Width,
}, Strict);

const CellValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);

export const DashboardKpiCardSchema = Type.Object({
  label: Type.Optional(Name),
  /** The cell shown; never aggregated. */
  value: Type.Object({ field: Name }, Strict),
  /**
   * A second cell of the same row. `kind: "change"` (default) is a signed comparison such as a change rate, drawn
   * with an arrow; `good` names the direction that is an improvement and colours it, without it the arrow stays
   * neutral. `kind: "context"` is a plain figure such as a share of the whole, drawn without sign, arrow or colour.
   */
  delta: Type.Optional(Type.Object({
    field: Name,
    label: Type.Optional(Name),
    kind: Type.Optional(Type.Union([Type.Literal("change"), Type.Literal("context")])),
    good: Type.Optional(Type.Union([Type.Literal("up"), Type.Literal("down")])),
  }, Strict)),
  /** Picks one row by column values; rows it matches must agree on the cells shown. */
  where: Type.Optional(Type.Record(Type.String(), CellValue)),
  /** A small line of `y` over every row of the view's result, ordered by `x`, such as the monthly series behind the value. */
  trend: Type.Optional(Type.Object({ x: Type.Object({ field: Name }, Strict), y: Type.Object({ field: Name }, Strict) }, Strict)),
}, Strict);
export type DashboardKpiCard = Static<typeof DashboardKpiCardSchema>;

export const DashboardKpiViewSchema = Type.Object({
  id: ViewId,
  type: Type.Literal("kpi"),
  title: Type.Optional(Name),
  subtitle: Type.Optional(Name),
  data: DatasetRefSchema,
  cards: Type.Array(DashboardKpiCardSchema, { minItems: 1, maxItems: 8 }),
  fields: Fields,
  width: Width,
}, Strict);

/**
 * Findings: each pairs a number read from one cell of the result (never aggregated, like a KPI card) with a
 * sentence the model writes about it. The sentence is the only model-written text on the page (ADR-0008
 * amendment 2026-10-02); it restates published numbers and does not introduce new ones.
 */
export const DashboardInsightSchema = Type.Object({
  value: Type.Object({ field: Name }, Strict),
  where: Type.Optional(Type.Record(Type.String(), CellValue)),
  text: Type.String({ minLength: 1, maxLength: 160 }),
  tone: Type.Optional(Type.Union([Type.Literal("focus"), Type.Literal("bad"), Type.Literal("good")])),
}, Strict);

export const DashboardInsightsViewSchema = Type.Object({
  id: ViewId,
  type: Type.Literal("insights"),
  title: Type.Optional(Name),
  data: DatasetRefSchema,
  items: Type.Array(DashboardInsightSchema, { minItems: 1, maxItems: 4 }),
  fields: Fields,
  width: Width,
}, Strict);

export const DashboardViewSchema = Type.Union([DashboardChartViewSchema, DashboardTableViewSchema, DashboardKpiViewSchema, DashboardInsightsViewSchema]);
export type DashboardTableView = Static<typeof DashboardTableViewSchema>;
export type DashboardKpiView = Static<typeof DashboardKpiViewSchema>;
export type DashboardInsightsView = Static<typeof DashboardInsightsViewSchema>;
export type DashboardView = Static<typeof DashboardViewSchema>;

/** Chart height of a row's tiles; KPI tiles and tables size to their content. */
export const DashboardRowHeightSchema = Type.Union([Type.Literal("compact"), Type.Literal("standard"), Type.Literal("tall")]);
export type DashboardRowHeight = Static<typeof DashboardRowHeightSchema>;

/** One row of tiles, left to right: a BI page is a few rows of two to four tiles, not one view per screen. */
export const DashboardLayoutRowSchema = Type.Object({
  views: Type.Array(ViewId, { minItems: 1, maxItems: 4 }),
  /** Relative tile widths, one per view; equal when omitted. */
  widths: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 12 }), { minItems: 1, maxItems: 4 })),
  height: Type.Optional(DashboardRowHeightSchema),
}, Strict);

export const DashboardLayoutSchema = Type.Object({
  /** Every view appears in exactly one row. */
  rows: Type.Array(DashboardLayoutRowSchema, { minItems: 1, maxItems: 20 }),
}, Strict);

export const DashboardSpecSchema = Type.Object({
  version: Type.Literal(DASHBOARD_SPEC_VERSION),
  title: Name,
  subtitle: Type.Optional(Name),
  /** File name under dashboards/, without extension. */
  filename: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_\\-\\u4e00-\\u9fa5]{1,80}$" })),
  views: Type.Array(DashboardViewSchema, { minItems: 1, maxItems: 40 }),
  /** Rows of tiles; without it views are laid out in order, KPI and tables full width, charts two per row. */
  layout: Type.Optional(DashboardLayoutSchema),
}, Strict);
export type DashboardSpec = Static<typeof DashboardSpecSchema>;

export interface DashboardSpecSchemaError {
  readonly path: string;
  readonly message: string;
}

const VIEW_SCHEMAS = { chart: DashboardChartViewSchema, table: DashboardTableViewSchema, kpi: DashboardKpiViewSchema, insights: DashboardInsightsViewSchema } as const;

/**
 * Structural validation only; checks against data live in @data-agent/charts.
 * Like checkChartSpec, a view with a known `type` reports only its own schema's
 * errors, and a chart view reports the errors of its declared mark.
 */
export function checkDashboardSpec(value: unknown): { readonly ok: true; readonly spec: DashboardSpec } | { readonly ok: false; readonly errors: readonly DashboardSpecSchemaError[] } {
  if (Value.Check(DashboardSpecSchema, value)) return { ok: true, spec: value };
  const toError = (prefix: string) => (error: { instancePath: string; message: string }) => ({ path: `${prefix}${error.instancePath}` || "/", message: error.message });
  const views = value && typeof value === "object" ? (value as { views?: unknown }).views : undefined;
  if (!Array.isArray(views)) return { ok: false, errors: Value.Errors(DashboardSpecSchema, value).map(toError("")) };
  const outside = Value.Errors(DashboardSpecSchema, value).filter((error) => !/^\/views\/\d+/.test(error.instancePath)).map(toError(""));
  const inside = views.flatMap((view, index) => {
    const prefix = `/views/${index}`;
    const type = view && typeof view === "object" ? (view as { type?: unknown }).type : undefined;
    const schema = typeof type === "string" && Object.hasOwn(VIEW_SCHEMAS, type) ? VIEW_SCHEMAS[type as keyof typeof VIEW_SCHEMAS] : undefined;
    if (!schema) return Value.Check(DashboardViewSchema, view) ? [] : [{ path: `${prefix}/type`, message: "must be one of chart, table, kpi, insights" }];
    if (Value.Check(schema, view)) return [];
    const errors = Value.Errors(schema, view).filter((error) => type !== "chart" || (error.instancePath !== "/chart" && !error.instancePath.startsWith("/chart/"))).map(toError(prefix));
    if (type !== "chart") return errors;
    const chart = checkChartSpec((view as { chart?: unknown }).chart);
    return [...errors, ...(chart.ok ? [] : chart.errors.map((error) => ({ path: `${prefix}/chart${error.path === "/" ? "" : error.path}`, message: error.message })))];
  });
  return { ok: false, errors: [...outside, ...inside] };
}

/** The Dataset Reference each view reads, in view order. */
export function dashboardViewData(view: DashboardView): DatasetRef {
  return view.type === "chart" ? view.chart.data : view.data;
}
