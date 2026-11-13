import { describe, expect, it } from "vitest";
import type { DataAgentEventEnvelope } from "@data-agent/contracts";
import { TranscriptProjector } from "./transcript.js";

function setup() {
  const emitted: DataAgentEventEnvelope[] = [];
  let sequence = 0;
  const instance = new TranscriptProjector({
    resolve: () => ({ operationId: "run-1", operation: { requestId: "request-1", runId: "run-1", sessionId: "session-1" } }),
    nextSequence: () => ++sequence,
    emit: (envelope) => emitted.push(envelope),
    onTerminal: () => undefined,
  });
  instance.project({ type: "message_start", message: { role: "assistant", id: "message-1" } });
  const start = (id = "call-1") => instance.project({ type: "tool_execution_start", toolCallId: id, toolName: "show_widget", args: {} });
  const end = (result: unknown, isError = false, id = "call-1") => instance.project({ type: "tool_execution_end", toolCallId: id, toolName: "show_widget", result, isError });
  return { instance, start, end, events: () => emitted.map((envelope) => envelope.event) };
}

function result(id = "call-1", title = "Sales") {
  return {
    content: [{ type: "text", text: "[widget:chart] Sales" }],
    details: {
      widgetEvent: "widget", widgetId: `widget-${id}`, toolCallId: id, toolName: "show_widget",
      widget: { widget_id: `widget-${id}`, tool_call_id: id, kind: "chart", title, contractVersion: 2,
        chartSpec: { version: 1 }, dataset: { columns: ["industry", "sales"], rows: [["Wholesale", 10]] } },
    },
  };
}

const widgetEvents = (events: ReturnType<ReturnType<typeof setup>["events"]>) => events.filter((event) => event.type.startsWith("widget"));

describe("TranscriptProjector widget delivery", () => {
  it("creates a widget from the result before marking it done", () => {
    const { start, end, events } = setup();
    start();
    end(result());
    expect(widgetEvents(events()).map((event) => event.type)).toEqual(["widget", "widget_done"]);
    expect(events().find((event) => event.type === "widget")).toMatchObject({ messageId: "message-1", toolCallId: "call-1", widgetId: "widget-call-1", widget: result().details.widget });
    expect(events().at(-1)).toMatchObject({ type: "agent.tool_finished", isError: false });
  });

  it("does not create a chart or mark it done for a failed tool result", () => {
    const { start, end, events } = setup();
    start();
    end(result(), true);
    expect(widgetEvents(events()).map((event) => event.type)).toEqual(["widget_error"]);
    expect(events().at(-1)).toMatchObject({ type: "agent.tool_finished", isError: true });
  });

  it.each([null, { content: [] }, { ...result(), details: { ...result().details, widget: { ...result().details.widget, dataset: {} } } }])("reports invalid final payloads instead of a false completion: %j", (invalid) => {
    const { start, end, events } = setup();
    start();
    end(invalid);
    expect(widgetEvents(events()).map((event) => event.type)).toEqual(["widget_error"]);
    expect(events().at(-1)).toMatchObject({ type: "agent.tool_finished", isError: true });
  });

  it.each([
    { kind: "kpi", value: 10 },
    { kind: "table", data: [{ sales: 10 }] },
    { kind: "steps", data: [{ title: "Done" }] },
  ])("also delivers non-chart widgets: $kind", (payload) => {
    const { start, end, events } = setup();
    start();
    const full = result();
    end({ ...full, details: { ...full.details, widget: { widget_id: "widget-call-1", tool_call_id: "call-1", title: "Widget", ...payload } } });
    expect(widgetEvents(events()).map((event) => event.type)).toEqual(["widget", "widget_done"]);
  });

  it("keeps parallel widgets attached to the message that started their calls", () => {
    const { instance, start, end, events } = setup();
    start("call-1");
    start("call-2");
    instance.project({ type: "message_start", message: { role: "assistant", id: "message-2" } });
    end(result("call-2"), false, "call-2");
    end(result("call-1"));
    const widgets = events().filter((event) => event.type === "widget");
    expect(widgets).toHaveLength(2);
    expect(widgets.map((event) => event.messageId)).toEqual(["message-1", "message-1"]);
    expect(widgets.map((event) => event.widgetId)).toEqual(["widget-call-2", "widget-call-1"]);
  });
});
