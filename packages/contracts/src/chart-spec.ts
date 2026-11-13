import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ChartMarkSchema, chartMarkSchema } from "./chart-marks.js";

/**
 * ChartSpec v1 (ADR-0008): one serializable chart description shared by chat
 * widgets, dashboards and reports. It carries no data transformation or
 * aggregation and reads its data through a Dataset Reference. The marks it can
 * draw are listed in chart-marks.ts; further marks are added there without
 * changing existing members.
 */
export const CHART_SPEC_VERSION = 1 as const;

const Strict = { additionalProperties: false } as const;
const Name = Type.String({ minLength: 1 });

export const DatasetRefSchema = Type.Union([
  Type.Object({ kind: Type.Literal("publication"), receiptId: Name }, Strict),
  Type.Object({ kind: Type.Literal("derived"), derivedId: Name }, Strict),
  /** A published result whose query the app may run again on request, publishing each refresh as a new Receipt (ADR-0010). */
  Type.Object({ kind: Type.Literal("live"), receiptId: Name }, Strict),
]);
export type DatasetRef = Static<typeof DatasetRefSchema>;

export const MagnitudeSchema = Type.Union([Type.Literal(1), Type.Literal(1e3), Type.Literal(1e4), Type.Literal(1e6), Type.Literal(1e8)]);

export const FieldMetaSchema = Type.Union([
  Type.Object({
    type: Type.Literal("quantitative"),
    label: Type.Optional(Name),
    /** What a stored 0.12 means. */
    storage: Type.Union([Type.Literal("raw"), Type.Literal("ratio"), Type.Literal("percent")]),
    /** Defaults from storage: ratio and percent display as percent, raw as raw. */
    display: Type.Optional(Type.Union([Type.Literal("raw"), Type.Literal("percent")])),
    unit: Type.Optional(Name),
    magnitude: Type.Optional(Type.Object({ stored: MagnitudeSchema, shown: Type.Optional(MagnitudeSchema) }, Strict)),
    additivity: Type.Union([Type.Literal("additive"), Type.Literal("non_additive")]),
  }, Strict),
  Type.Object({
    type: Type.Literal("temporal"),
    label: Type.Optional(Name),
    grain: Type.Union([Type.Literal("year"), Type.Literal("quarter"), Type.Literal("month"), Type.Literal("week"), Type.Literal("day"), Type.Literal("hour"), Type.Literal("minute")]),
    /** "floating" for calendar values without a time zone, otherwise an IANA zone name. */
    zone: Name,
  }, Strict),
  Type.Object({ type: Type.Literal("ordinal"), label: Type.Optional(Name), order: Type.Array(Type.String(), { minItems: 1 }) }, Strict),
  Type.Object({ type: Type.Literal("nominal"), label: Type.Optional(Name) }, Strict),
]);
export type FieldMeta = Static<typeof FieldMetaSchema>;

export const ChartSelectionSchema = Type.Object({
  kind: Type.Literal("top_n"),
  by: Name,
  n: Type.Integer({ minimum: 1 }),
  order: Type.Union([Type.Literal("desc"), Type.Literal("asc")]),
}, Strict);

export const ChartViewportSchema = Type.Object({
  mode: Type.Union([Type.Literal("scroll"), Type.Literal("zoom")]),
  window: Type.Integer({ minimum: 1 }),
}, Strict);

export const ChartSpecSchema = Type.Object({
  version: Type.Literal(CHART_SPEC_VERSION),
  title: Type.Optional(Name),
  subtitle: Type.Optional(Name),
  data: DatasetRefSchema,
  /** Model-declared field semantics; Runtime records them as Dataset Annotations. */
  fields: Type.Optional(Type.Record(Type.String(), FieldMetaSchema)),
  chart: ChartMarkSchema,
  selection: Type.Optional(ChartSelectionSchema),
  viewport: Type.Optional(ChartViewportSchema),
}, Strict);
export type ChartSpec = Static<typeof ChartSpecSchema>;

export interface ChartSpecSchemaError {
  readonly path: string;
  readonly message: string;
}

/**
 * Structural validation only; semantic checks against data live in @data-agent/charts.
 * A known `mark` is checked against its own schema, so errors name what that mark needs
 * rather than listing every union member's requirements.
 */
export function checkChartSpec(value: unknown): { readonly ok: true; readonly spec: ChartSpec } | { readonly ok: false; readonly errors: readonly ChartSpecSchemaError[] } {
  if (Value.Check(ChartSpecSchema, value)) return { ok: true, spec: value };
  const toError = (prefix: string) => (error: { instancePath: string; message: string }) => ({ path: `${prefix}${error.instancePath}` || "/", message: error.message });
  const all = Value.Errors(ChartSpecSchema, value);
  const chart = value && typeof value === "object" ? (value as { chart?: unknown }).chart : undefined;
  const mark = chart && typeof chart === "object" ? (chart as { mark?: unknown }).mark : undefined;
  const branch = typeof mark === "string" ? chartMarkSchema(mark) : undefined;
  if (!branch) return { ok: false, errors: all.map(toError("")) };
  const outside = all.filter((error) => error.instancePath !== "/chart" && !error.instancePath.startsWith("/chart/"));
  return { ok: false, errors: [...outside.map(toError("")), ...Value.Errors(branch, chart).map(toError("/chart"))] };
}
