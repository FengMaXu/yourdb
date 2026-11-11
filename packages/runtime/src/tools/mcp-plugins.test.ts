import { describe, expect, it } from "vitest";
import { createMcpPluginToolDefinitions, type McpPluginTool } from "./mcp-plugins.js";

const tool = (name: string, result = { text: "ok", isError: false }): McpPluginTool & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    plugin: "qcc",
    name,
    description: "查询企业\n工商信息",
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    call: async (args) => { calls.push(args); return result; },
  };
};

const run = (definition: ReturnType<typeof createMcpPluginToolDefinitions>[number], input: Record<string, unknown>) =>
  definition.tool.execute("call", input, () => undefined, { sessionId: "s", principalId: "u" }, {} as never, {} as never);

describe("MCP plugin tools", () => {
  it("offers a plugin tool as the plugin describes it and returns its result", async () => {
    const search = tool("qcc_company__search");
    const [definition] = createMcpPluginToolDefinitions([search]);
    expect(definition!.tool).toMatchObject({ name: "qcc_company__search", replay: "never", description: "查询企业\n工商信息" });
    expect(definition!.tool.parameters).toMatchObject({ type: "object", required: ["keyword"] });
    expect(definition!).toMatchObject({ promptSnippet: "查询企业 工商信息", promptGuidelines: [] });
    const result = await run(definition!, { keyword: "腾讯" });
    expect(search.calls).toEqual([{ keyword: "腾讯" }]);
    expect((result.content[0] as { text: string }).text).toBe("ok");
  });

  it("fails the call when the plugin reports an error", async () => {
    const [definition] = createMcpPluginToolDefinitions([tool("qcc_risk__check", { text: "quota exceeded", isError: true })]);
    await expect(run(definition!, { keyword: "x" })).rejects.toThrow("quota exceeded");
  });
});
