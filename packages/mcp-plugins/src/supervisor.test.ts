import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpPluginSupervisor, type McpPluginSupervisor } from "./supervisor.js";
import type { StoredMcpConfig } from "./config.js";
import { databaseHostServer, type McpHostServer, type McpPreset } from "./presets.js";
// @ts-expect-error -- a plain ESM fixture without types
import { echoServer } from "../test-fixtures/echo-server.mjs";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test-fixtures/echo-server.mjs");
const stdio = (extra: Record<string, unknown> = {}) => ({ name: "echo", enabled: true, transport: "stdio", command: process.execPath, args: [fixture, "stdio"], ...extra });

const supervisors: McpPluginSupervisor[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.close();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

function supervise(initial: unknown, presets: readonly McpPreset[], hostServers: readonly McpHostServer[] = []) {
  let stored: unknown = initial;
  const supervisor = createMcpPluginSupervisor({
    readConfig: async () => stored,
    writeConfig: async (config: StoredMcpConfig) => { stored = config; },
    presets,
    hostServers,
    connectTimeoutMs: 10_000,
  });
  supervisors.push(supervisor);
  return { supervisor, stored: () => stored };
}

/** A Streamable HTTP MCP endpoint that requires `Authorization: Bearer <token>`; `token` may be a set the test changes. */
async function httpEndpoint(token: string | Set<string> = "secret"): Promise<string> {
  const accepted = typeof token === "string" ? new Set([token]) : token;
  const server = http.createServer(async (req, res) => {
    if (![...accepted].some((value) => req.headers.authorization === `Bearer ${value}`)) { res.writeHead(401).end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); });
    await echoServer().connect(transport);
    await transport.handleRequest(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}

describe("MCP plugin supervisor", () => {
  it("lists the database first as pre-installed and on, with its connection state, and keeps it out of plugin saves", async () => {
    let reachable = true;
    const database = databaseHostServer(async () => { if (!reachable) throw new Error("DATABASE_UNAVAILABLE: connect ECONNREFUSED"); });
    const { supervisor } = supervise(undefined, [], [database]);
    expect(((await supervisor.view()) as { servers: unknown[] }).servers[0]).toMatchObject({ name: "database", enabled: true, host_managed: true, default_enabled: true, settings_hint: "在「设置 → 数据库」中配置" });
    expect(await supervisor.status()).toEqual([{ name: "database", enabled: true, connected: true, toolCount: 4, hostManaged: true }]);
    expect(await supervisor.test("database")).toEqual({ ok: true, message: "已连接，共 4 个工具" });
    reachable = false;
    expect(await supervisor.status()).toEqual([{ name: "database", enabled: true, connected: false, toolCount: 0, hostManaged: true }]);
    expect(await supervisor.test("database")).toEqual({ ok: false, message: "DATABASE_UNAVAILABLE: connect ECONNREFUSED" });
    await expect(supervisor.save({ servers: [{ name: "database", enabled: false }] })).rejects.toThrow("已被预装插件使用");
  });

  it("serves the tools of an enabled stdio plugin under prefixed names", async () => {
    const { supervisor } = supervise({ servers: [stdio({ env: { PLUGIN_VALUE: "from-env" } })] }, []);
    const tools = await supervisor.tools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo__echo", "echo__env", "echo__fail"]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(await byName.echo__echo!.call({ text: "hi" })).toEqual({ text: "echo:hi", isError: false });
    expect(await byName.echo__env!.call({ name: "PLUGIN_VALUE" })).toEqual({ text: "from-env", isError: false });
    expect(await byName.echo__fail!.call({})).toEqual({ text: "boom", isError: true });
    expect(await supervisor.status()).toEqual([{ name: "echo", enabled: true, connected: true, toolCount: 3, hostManaged: false }]);
  }, 30_000);

  it("connects a Streamable HTTP plugin with its saved headers", async () => {
    const url = await httpEndpoint();
    const { supervisor } = supervise({ servers: [{ name: "remote", enabled: true, transport: "http", url, headers: { Authorization: "Bearer secret" } }] }, []);
    expect(await supervisor.test("remote")).toEqual({ ok: true, message: "已连接，共 3 个工具" });
    const echo = (await supervisor.tools()).find((tool) => tool.name === "remote__echo")!;
    expect(await echo.call({ text: "x" })).toMatchObject({ text: "echo:x" });
  }, 30_000);

  it("reports a refused connection instead of serving its tools, and does not retry it for every session", async () => {
    let attempts = 0;
    const url = await httpEndpoint();
    const { supervisor } = supervise({ servers: [{ name: "remote", enabled: true, transport: "http", url, headers: { Authorization: "Bearer wrong" } }] }, []);
    servers[0]!.prependListener("request", () => { attempts += 1; });
    expect((await supervisor.test("remote")).ok).toBe(false);
    const afterTest = attempts;
    expect(await supervisor.tools()).toEqual([]);
    expect(await supervisor.tools()).toEqual([]);
    expect(attempts).toBe(afterTest);
    // Testing again retries at once.
    await supervisor.test("remote");
    expect(attempts).toBeGreaterThan(afterTest);
  }, 30_000);

  it("drops the tools of a plugin once it is disabled", async () => {
    const { supervisor } = supervise({ servers: [stdio()] }, []);
    expect(await supervisor.tools()).toHaveLength(3);
    await supervisor.save({ servers: [{ ...stdio(), enabled: false }] });
    expect(await supervisor.tools()).toEqual([]);
    expect(await supervisor.test("echo")).toEqual({ ok: false, message: "插件未启用，请先启用后再测试" });
  }, 30_000);

  it("keeps a session's tools working when the key changes under them, and says why when they cannot", async () => {
    const valid = new Set(["key-old"]);
    const url = await httpEndpoint(valid);
    const preset: McpPreset = {
      id: "remote",
      title: "Remote",
      description: "test preset",
      fields: [{ key: "apiKey", label: "API Key", kind: "secret", required: true }],
      connections: (values) => [{ id: "remote", transport: "streamable-http", url, headers: { Authorization: `Bearer ${String(values.apiKey ?? "")}` } }],
    };
    const { supervisor } = supervise(undefined, [preset]);
    await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: { apiKey: "key-old" } }] });
    // A session takes its tools once, when it starts.
    const echo = (await supervisor.tools()).find((tool) => tool.originalName === "echo")!;
    expect(await echo.call({ text: "a" })).toEqual({ text: "echo:a", isError: false });

    // The user swaps the key in settings, and the old one stops working.
    valid.add("key-new");
    valid.delete("key-old");
    await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: { apiKey: "key-new" } }] });
    expect(await echo.call({ text: "b" })).toEqual({ text: "echo:b", isError: false });

    // A key the platform refuses is named as the reason, not as a bare disconnect.
    await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: { apiKey: "key-wrong" } }] });
    await expect(echo.call({ text: "c" })).rejects.toThrow(/MCP_PLUGIN_DISCONNECTED: remote（.+）/);

    await supervisor.save({ servers: [{ name: "remote", enabled: false, field_values: { apiKey: "key-new" } }] });
    await expect(echo.call({ text: "d" })).rejects.toThrow("插件已停用或已移除");
  }, 30_000);

  it("lists presets, keeps their secrets out of the view and connects with the saved key", async () => {
    const url = await httpEndpoint("tok-9f3");
    const preset: McpPreset = {
      id: "remote",
      title: "Remote",
      description: "test preset",
      fields: [{ key: "apiKey", label: "API Key", kind: "secret", required: true }],
      connections: (values) => [{ id: "remote", transport: "streamable-http", url, headers: { Authorization: `Bearer ${String(values.apiKey ?? "")}` } }],
    };
    const { supervisor, stored } = supervise(undefined, [preset]);
    const listed = await supervisor.view() as { servers: Array<Record<string, unknown>> };
    expect(listed.servers).toMatchObject([{ name: "remote", enabled: false, preset: { id: "remote", fields: [{ key: "apiKey", configured: false }] } }]);

    await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: {} }] });
    expect(await supervisor.test("remote")).toEqual({ ok: false, message: "请先填写 API Key" });

    const view = await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: { apiKey: "tok-9f3" } }] }) as { servers: Array<Record<string, unknown>> };
    expect(JSON.stringify(view)).not.toContain("tok-9f3");
    expect(view.servers[0]).toMatchObject({ preset: { fields: [{ key: "apiKey", configured: true }] }, field_values: {} });
    // The page never had the key; saving from it again keeps the key.
    await supervisor.save({ servers: [{ name: "remote", enabled: true, field_values: {} }] });
    expect(stored()).toMatchObject({ servers: [{ name: "remote", field_values: { apiKey: "tok-9f3" } }] });
    expect(await supervisor.test("remote")).toEqual({ ok: true, message: "已连接，共 3 个工具" });
    expect(await supervisor.status()).toEqual([{ name: "remote", enabled: true, connected: true, toolCount: 3, hostManaged: false }]);
  }, 30_000);
});
