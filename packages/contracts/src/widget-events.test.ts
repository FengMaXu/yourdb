import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { DataAgentEventEnvelopeSchema } from "./index.js";

const envelope = (event: unknown) => ({
  protocolVersion: 1,
  sequence: 1,
  requestId: "request-1",
  timestamp: 1,
  event,
});

describe("Widget event contracts", () => {
  it("accept every lifecycle event and retain arbitrary widget fields", () => {
    const common = { messageId: "message-1", toolCallId: "call-1", widgetId: "widget-call-1", toolName: "show_widget" };
    const events = [
      { type: "widget", ...common, widget: { widget_id: "widget-call-1", kind: "kpi", title: "Revenue", tool_call_id: "call-1", extra: { source: "query" } } },
      { type: "widget_done", ...common },
      { type: "widget_error", ...common, error: "WIDGET_SPEC_INVALID: data is required" },
    ];
    for (const event of events) expect(Value.Check(DataAgentEventEnvelopeSchema, envelope(event))).toBe(true);
  });

  it("does not accept lifecycle events without their correlation identity", () => {
    expect(Value.Check(DataAgentEventEnvelopeSchema, envelope({
      type: "widget",
      messageId: "message-1",
      toolCallId: "call-1",
      toolName: "show_widget",
      widget: { kind: "kpi", title: "Revenue" },
    }))).toBe(false);
  });
});
