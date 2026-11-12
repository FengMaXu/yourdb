import { isRecord } from "./primitives.js";

export type WidgetKind = "kpi" | "chart" | "table" | "steps";

/**
 * Every widget the Runtime builds carries this version. A transcript widget
 * without it is drawn from its own data rows (ADR-0008 decision 11).
 */
export const CHART_WIDGET_CONTRACT_VERSION = 2;

export interface WidgetSpecInput {
  [key: string]: unknown;
}

export interface WidgetPayload extends WidgetSpecInput {
  widget_id: string;
  kind: WidgetKind;
  title: string;
  tool_call_id: string;
}

export interface WidgetLifecycleDetails {
  widgetEvent: "widget";
  widgetId: string;
  toolCallId: string;
  toolName: "show_widget";
  widget: WidgetPayload;
}

export type WidgetValidationResult = {
  ok: true;
  spec: WidgetSpecInput;
} | {
  ok: false;
  error: string;
};

/** Minimum server-side validation shared by the tool and its event adapter. */
export function validateWidgetSpec(kind: WidgetKind, value: unknown): WidgetValidationResult {
  if (!isRecord(value)) return { ok: false, error: "spec must be an object" };
  if (value.title !== undefined && typeof value.title !== "string") {
    return { ok: false, error: "spec.title must be a string when provided" };
  }

  if (kind === "kpi") {
    const hasValue = typeof value.value === "string" || typeof value.value === "number";
    if (!hasValue && !Array.isArray(value.data)) {
      return { ok: false, error: "kpi spec requires a scalar value or data array" };
    }
  } else if (kind === "chart" && value.contractVersion === CHART_WIDGET_CONTRACT_VERSION) {
    // A Runtime-built ChartSpec widget: the spec plus the published rows it was resolved against.
    const dataset = isRecord(value.dataset) ? value.dataset : undefined;
    if (!isRecord(value.chartSpec) || !dataset || !Array.isArray(dataset.columns) || !Array.isArray(dataset.rows)) {
      return { ok: false, error: "chart widget requires chartSpec and a resolved dataset" };
    }
  } else if (!Array.isArray(value.data) && !(kind === "chart" && Array.isArray(value.series))) {
    return { ok: false, error: `${kind} spec requires a data array${kind === "chart" ? " or series array" : ""}` };
  }

  return { ok: true, spec: value };
}

function isWidgetKind(value: unknown): value is WidgetKind {
  return value === "kpi" || value === "chart" || value === "table" || value === "steps";
}

function isWidgetPayload(value: unknown): value is WidgetPayload {
  if (!isRecord(value)) return false;
  return typeof value.widget_id === "string"
    && isWidgetKind(value.kind)
    && typeof value.title === "string"
    && typeof value.tool_call_id === "string";
}

/** Guard for the details of a finished show_widget call, as the Pi event stream reports them. */
export function isWidgetLifecycleDetails(value: unknown): value is WidgetLifecycleDetails {
  if (!isRecord(value)) return false;
  if (value.widgetEvent !== "widget") return false;
  if (typeof value.widgetId !== "string" || value.widgetId.length === 0) return false;
  if (typeof value.toolCallId !== "string" || value.toolCallId.length === 0) return false;
  return value.toolName === "show_widget" && isWidgetPayload(value.widget);
}

export function widgetText(widget: WidgetPayload): string {
  return `[widget:${widget.kind}] ${widget.title}: ${JSON.stringify(widget)}`;
}
