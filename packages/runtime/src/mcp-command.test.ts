import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "./protocol.js";

describe("MCP plugin commands", () => {
  it("serves plugin settings through the host's supervisor and reports invalid saves as invalid commands", async () => {
    const saved: unknown[] = [];
    const runtime = new DataAgentRuntime({});
    runtime.mcpSupervisor = {
      view: async () => ({ servers: [{ name: "qcc", enabled: false }] }),
      save: async (config) => {
        if ((config as { servers: Array<{ name: string }> }).servers.some((server) => server.name.includes(" "))) throw new Error("MCP_CONFIG_INVALID: bad name");
        saved.push(config);
        return { servers: [{ name: "qcc", enabled: true }] };
      },
      status: async () => [],
      test: async () => ({ ok: true, message: "ok" }),
      restart: async () => ({ ok: true }),
    };
    const context = { userId: "local", host: "electron" as const };
    const view = await runtime.dispatch({ protocolVersion: 1, requestId: "g", command: { type: "mcp.config.get" } }, context);
    expect(view.response).toEqual({ type: "mcp.config.result", config: { servers: [{ name: "qcc", enabled: false }] } });
    const after = await runtime.dispatch({ protocolVersion: 1, requestId: "s", command: { type: "mcp.config.save", config: { servers: [{ name: "qcc", enabled: true }] } } }, context);
    expect(after.response).toEqual({ type: "mcp.config.result", config: { servers: [{ name: "qcc", enabled: true }] } });
    expect(saved).toHaveLength(1);
    await expect(runtime.dispatch({ protocolVersion: 1, requestId: "x", command: { type: "mcp.config.save", config: { servers: [{ name: "a b" }] } } }, context))
      .rejects.toMatchObject({ code: "INVALID_COMMAND", message: "MCP_CONFIG_INVALID: bad name" });
  });
});
