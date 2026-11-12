import { Type, type Static, type TSchema } from "typebox";

/**
 * The marks a ChartSpec can draw (ADR-0008). Each is one schema; the list at the
 * end is the only place a mark is registered in the contract. Marks are only
 * ever added: persisted specs name existing ones.
 */

const Strict = { additionalProperties: false } as const;
const Name = Type.String({ minLength: 1 });

const FieldRefSchema = Type.Object({ field: Name }, Strict);
const PositionRefSchema = Type.Object({ field: Name, axis: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])) }, Strict);
const SeriesRefSchema = Type.Object({
  field: Name,
  order: Type.Optional(Type.Array(Type.String())),
  colors: Type.Optional(Type.Record(Type.String(), Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" }))),
}, Strict);

export const ChartLayerSchema = Type.Object({
  /** "area" is a line filled down to the axis; stacked, it shows a total over time. */
  type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("area"), Type.Literal("scatter")]),
  y: PositionRefSchema,
  /** Splits a long table into one series per value of this field. */
  series: Type.Optional(SeriesRefSchema),
  /** Observation identity for scatter points; repeated coordinates are allowed. */
  id: Type.Optional(FieldRefSchema),
  size: Type.Optional(FieldRefSchema),
  label: Type.Optional(FieldRefSchema),
  /** Only bar, line and area. Any value but "none" is part-of-whole and must be additive, complete and non-negative. */
  stack: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("stacked"), Type.Literal("percent")])),
  name: Type.Optional(Name),
}, Strict);
export type ChartLayer = Static<typeof ChartLayerSchema>;

/**
 * Focus + Context (设计原则及配色方案.md): the named x categories, or scatter points by `id`, take the tone's
 * colour and every other bar or point the context colour. Single-series charts only; series have their colours.
 */
export const ChartHighlightSchema = Type.Object({
  values: Type.Array(Name, { minItems: 1, maxItems: 5 }),
  tone: Type.Optional(Type.Union([Type.Literal("focus"), Type.Literal("bad"), Type.Literal("good")])),
  /**
   * Index of the one layer the highlight is on; the chart's other bar and scatter layers become a lighter
   * backdrop, as in a paired "share of orders vs share of complaints" chart. All of them when omitted.
   */
  layer: Type.Optional(Type.Integer({ minimum: 0 })),
}, Strict);

/**
 * A reference line on a value axis, read from a column that holds one value in every row, such as a
 * site-wide average the query computes alongside each category. The spec never carries the number.
 */
export const ChartReferenceSchema = Type.Object({
  field: Name,
  label: Type.Optional(Name),
  axis: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right")])),
}, Strict);

/** A labelled span of x categories, such as a promotion period; `to` defaults to `from`. */
export const ChartBandSchema = Type.Object({ from: Name, to: Type.Optional(Name), label: Name }, Strict);

export const CartesianChartSchema = Type.Object({
  mark: Type.Literal("cartesian"),
  x: FieldRefSchema,
  layers: Type.Array(ChartLayerSchema, { minItems: 1 }),
  orientation: Type.Optional(Type.Union([Type.Literal("vertical"), Type.Literal("horizontal")])),
  highlight: Type.Optional(ChartHighlightSchema),
  references: Type.Optional(Type.Array(ChartReferenceSchema, { minItems: 1, maxItems: 3 })),
  bands: Type.Optional(Type.Array(ChartBandSchema, { minItems: 1, maxItems: 4 })),
}, Strict);
export type CartesianChart = Static<typeof CartesianChartSchema>;

export const PieChartSchema = Type.Object({
  mark: Type.Literal("pie"),
  category: FieldRefSchema,
  value: FieldRefSchema,
  donut: Type.Optional(Type.Boolean()),
}, Strict);
export type PieChart = Static<typeof PieChartSchema>;

/** Two category axes and a colour measure; each (x, y) cell holds at most one row. */
export const HeatmapChartSchema = Type.Object({
  mark: Type.Literal("heatmap"),
  x: FieldRefSchema,
  y: FieldRefSchema,
  color: Type.Object({
    field: Name,
    /** "diverging" colours both sides of a midpoint, which must be declared: it is a judgement, never inferred. */
    scale: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("diverging")])),
    /** In the field's stored units, like the data. */
    midpoint: Type.Optional(Type.Number()),
  }, Strict),
}, Strict);
export type HeatmapChart = Static<typeof HeatmapChartSchema>;

/** Bins computed by the query: one row per bin with its bounds and count. The compiler never bins. */
export const HistogramChartSchema = Type.Object({
  mark: Type.Literal("histogram"),
  start: FieldRefSchema,
  end: FieldRefSchema,
  value: FieldRefSchema,
}, Strict);
export type HistogramChart = Static<typeof HistogramChartSchema>;

/** Five statistics per category, computed by the query. The whisker definition travels with the chart. */
export const BoxplotChartSchema = Type.Object({
  mark: Type.Literal("boxplot"),
  category: FieldRefSchema,
  min: FieldRefSchema,
  q1: FieldRefSchema,
  median: FieldRefSchema,
  q3: FieldRefSchema,
  max: FieldRefSchema,
  /** What the whiskers mean: the data's extremes, or the furthest point within 1.5 IQR. */
  whisker: Type.Union([Type.Literal("min_max"), Type.Literal("iqr_1_5")]),
}, Strict);
export type BoxplotChart = Static<typeof BoxplotChartSchema>;

/**
 * Steps with running totals computed by the query: each row's start and end.
 * Rows flagged in `total` are totals drawn from zero. The compiler never accumulates.
 */
export const WaterfallChartSchema = Type.Object({
  mark: Type.Literal("waterfall"),
  step: FieldRefSchema,
  start: FieldRefSchema,
  end: FieldRefSchema,
  total: Type.Optional(FieldRefSchema),
}, Strict);
export type WaterfallChart = Static<typeof WaterfallChartSchema>;

/** An edge table: one row per (source, target) flow. Node totals are the visual sum of their flows. */
export const SankeyChartSchema = Type.Object({
  mark: Type.Literal("sankey"),
  source: FieldRefSchema,
  target: FieldRefSchema,
  value: FieldRefSchema,
}, Strict);
export type SankeyChart = Static<typeof SankeyChartSchema>;

/** Leaf rows only, each with its full path; parent areas are the visual sum of their leaves. */
export const TreemapChartSchema = Type.Object({
  mark: Type.Literal("treemap"),
  path: Type.Array(FieldRefSchema, { minItems: 1, maxItems: 4 }),
  value: FieldRefSchema,
}, Strict);
export type TreemapChart = Static<typeof TreemapChartSchema>;

/**
 * Stages in row order with the count that reached each. Widths follow the
 * values; no conversion rate is computed or shown.
 */
export const FunnelChartSchema = Type.Object({
  mark: Type.Literal("funnel"),
  stage: FieldRefSchema,
  value: FieldRefSchema,
}, Strict);
export type FunnelChart = Static<typeof FunnelChartSchema>;

/** The treemap's data as rings: leaf rows with their full path; parent angles are the visual sum of their leaves. */
export const SunburstChartSchema = Type.Object({
  mark: Type.Literal("sunburst"),
  path: Type.Array(FieldRefSchema, { minItems: 1, maxItems: 4 }),
  value: FieldRefSchema,
}, Strict);
export type SunburstChart = Static<typeof SunburstChartSchema>;

/** Every mark. The ChartSpec union and the per-mark schema check both come from this list. */
export const CHART_MARK_SCHEMAS = [
  CartesianChartSchema,
  PieChartSchema,
  HeatmapChartSchema,
  HistogramChartSchema,
  BoxplotChartSchema,
  WaterfallChartSchema,
  SankeyChartSchema,
  TreemapChartSchema,
  FunnelChartSchema,
  SunburstChartSchema,
] as const;

export const ChartMarkSchema = Type.Union([...CHART_MARK_SCHEMAS]);
export type ChartMark = Static<typeof ChartMarkSchema>;
export type ChartMarkName = ChartMark["mark"];

/** The schema of one mark, so a spec's errors name what that mark needs rather than every union member's requirements. */
export function chartMarkSchema(mark: string): TSchema | undefined {
  return CHART_MARK_SCHEMAS.find((schema) => schema.properties.mark.const === mark);
}
