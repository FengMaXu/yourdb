import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { DataAgentEventSchema, isToolProgress, parseDataAgentCommandEnvelope } from "./index.js";

describe("agent tool event contract", () => {
  const base = {
    toolCallId: "call-1",
    toolName: "query",
    result: { rows: [] },
    isError: false,
  };

  it("accepts completion arguments while keeping them optional for older events", () => {
    expect(Value.Check(DataAgentEventSchema, { type: "agent.tool_finished", ...base })).toBe(true);
    expect(Value.Check(DataAgentEventSchema, { type: "agent.tool_finished", ...base, args: { sql: "select 1" } })).toBe(true);
  });

  it("rejects malformed events before they cross the transport boundary", () => {
    expect(Value.Check(DataAgentEventSchema, { type: "agent.text_delta", delta: 42 })).toBe(false);
    expect(Value.Check(DataAgentEventSchema, { type: "agent.tool_finished", ...base })).toBe(true);
  });

  it("accepts bounded subagent progress and rejects extra or unknown fields", () => {
    const child = { key: "schema", role: "explorer", task: "列出列", currentTool: "describe_table", toolCalls: 2, startedAt: 1, status: "running", output: "pending" };
    const progress = { kind: "subagent", children: [child] };
    expect(Value.Check(DataAgentEventSchema, { type: "agent.tool_progress", toolCallId: "call-1", toolName: "subagent", progress })).toBe(true);
    expect(isToolProgress({ kind: "subagent", children: [{ ...child, endedAt: 5, status: "completed", output: "produced", currentTool: null }] })).toBe(true);
    expect(isToolProgress({ kind: "subagent", children: [{ ...child, sql: "select 1" }] })).toBe(false);
    expect(isToolProgress({ kind: "subagent", children: [1, 2, 3, 4, 5].map((index) => ({ ...child, key: `k${index}` })) })).toBe(false);
    expect(isToolProgress({ kind: "query", children: [] })).toBe(false);
  });

  it("freezes command ingress to the exact supported protocol version", () => {
    const baseCommand = { requestId: "request-1", command: { type: "runtime.probe" } };
    expect(parseDataAgentCommandEnvelope({ protocolVersion: 1, ...baseCommand })).toMatchObject({ protocolVersion: 1 });
    for (const protocolVersion of [0, 2, 1.5, "1", undefined]) {
      expect(() => parseDataAgentCommandEnvelope({ protocolVersion, ...baseCommand })).toThrow("Invalid DataAgent command envelope");
    }
  });
});
