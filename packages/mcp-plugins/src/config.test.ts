import { describe, expect, it } from "vitest";
import { configView, connectionsOf, mergeSavedConfig } from "./config.js";
import { DEFAULT_MCP_PRESETS, QCC_PRESET } from "./presets.js";

describe("MCP plugin configuration", () => {
  it("connects 企查查 to one Streamable HTTP server per chosen group with the Bearer key", () => {
    expect(connectionsOf({ name: "qcc", preset: "qcc", enabled: true, field_values: { apiKey: " k ", groups: ["company", "risk", "nope"] } }, DEFAULT_MCP_PRESETS)).toEqual([
      { id: "qcc_company", transport: "streamable-http", url: "https://agent.qcc.com/mcp/company/stream", headers: { Authorization: "Bearer k" } },
      { id: "qcc_risk", transport: "streamable-http", url: "https://agent.qcc.com/mcp/risk/stream", headers: { Authorization: "Bearer k" } },
    ]);
    // A key pasted with its "Bearer " prefix is sent once.
    expect(QCC_PRESET.connections({ apiKey: " Bearer k ", groups: ["company"] })).toMatchObject([{ headers: { Authorization: "Bearer k" } }]);
    // Without a choice, the four everyday groups.
    expect(QCC_PRESET.connections({ apiKey: "k" }).map((spec) => spec.id)).toEqual(["qcc_company", "qcc_risk", "qcc_operation", "qcc_ipr"]);
  });

  it("keeps stored headers and env a save leaves out, and masks them in the view", () => {
    const previous = { servers: [{ name: "s", enabled: true, transport: "http", url: "https://x", headers: { Authorization: "Bearer a" } }] };
    const merged = mergeSavedConfig(previous, { servers: [{ name: "s", enabled: false, transport: "http", url: "https://x" }] }, []);
    expect(merged.servers[0]).toMatchObject({ enabled: false, headers: { Authorization: "Bearer a" } });
    expect(configView(merged, []).servers[0]).toMatchObject({ headers: { configured: true, count: 1 }, env: { configured: false, count: 0 } });
  });

  it("refuses names that cannot prefix a tool, and duplicates", () => {
    expect(() => mergeSavedConfig({ servers: [] }, { servers: [{ name: "a b" }] }, [])).toThrow("MCP_CONFIG_INVALID");
    expect(() => mergeSavedConfig({ servers: [] }, { servers: [{ name: "a" }, { name: "a" }] }, [])).toThrow("重复");
  });

  it("treats an http transport as Streamable HTTP and sse as SSE", () => {
    expect(connectionsOf({ name: "a", enabled: true, transport: "http", url: "https://x" }, [])[0]).toMatchObject({ transport: "streamable-http" });
    expect(connectionsOf({ name: "a", enabled: true, transport: "sse", url: "https://x" }, [])[0]).toMatchObject({ transport: "sse" });
  });
});
