import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMcpQueryExecutor, DATABASE_UNAVAILABLE } from "@data-agent/database";


/**
 * Proxy MCP server for connection-loss tests. The control file decides its
 * behavior: "ok" forwards to the real server; "crash" (or "crash-then-dead")
 * dies on the next query; "dead" exits immediately at start.
 */
const FLAKY_PROXY = [
  'import { spawn } from "node:child_process";',
  'import fs from "node:fs";',
  'const [realServer, databasePath, control] = process.argv.slice(2);',
  'const mode = () => fs.existsSync(control) ? fs.readFileSync(control, "utf8") : "ok";',
  'if (mode() === "dead") process.exit(1);',
  'const child = spawn(process.execPath, [realServer, databasePath], { stdio: ["pipe", "pipe", "inherit"] });',
  'child.stdout.pipe(process.stdout);',
  'process.stdin.on("data", (chunk) => {',
  '  const current = mode();',
  '  if (current.startsWith("crash") && chunk.toString().includes("execute_query_preview")) {',
  '    fs.writeFileSync(control, current === "crash-then-dead" ? "dead" : "ok");',
  '    child.kill();',
  '    process.exit(1);',
  '  }',
  '  child.stdin.write(chunk);',
  '});',
  'child.on("exit", () => process.exit(0));',
].join("\n");

async function flakyExecutor(root: string, mode: string) {
  const databasePath = path.join(root, "test.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2);");
  database.close();
  const proxyPath = path.join(root, "proxy.mjs");
  const control = path.join(root, "control.txt");
  await writeFile(proxyPath, FLAKY_PROXY, "utf8");
  await writeFile(control, mode, "utf8");
  return createMcpQueryExecutor({
    command: process.execPath,
    args: [proxyPath, path.resolve("dist/reference-sqlite-mcp.js"), databasePath, control],
    dialect: "sqlite",
    reconnectDelaysMs: [10, 20, 30],
  });
}

/**
 * Minimal MCP database server for the time-limit contract: it records each
 * call's timeoutMs, and a "SLOW" statement waits until the call is cancelled,
 * recording the cancellation and the serving process id.
 */
const RECORDING_SERVER = [
  'import fs from "node:fs";',
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  'const log = process.argv[2];',
  'const record = (entry) => fs.appendFileSync(log, JSON.stringify({ ...entry, pid: process.pid }) + "\\n");',
  'const server = new McpServer({ name: "recording", version: "1.0.0" });',
  'server.tool("execute_query_preview", "preview", { sql: z.string(), limit: z.number().optional(), maxBytes: z.number().optional(), timeoutMs: z.number().optional() }, async ({ sql, timeoutMs }, extra) => {',
  '  record({ event: "call", timeoutMs });',
  '  if (sql.includes("SLOW")) await new Promise((resolve) => extra.signal.addEventListener("abort", () => { record({ event: "cancelled" }); resolve(); }, { once: true }));',
  '  return { content: [{ type: "text", text: JSON.stringify({ columns: ["v"], rows: [{ v: 1 }], truncated: false }) }] };',
  '});',
  'await server.connect(new StdioServerTransport());',
].join("\n");

describe("MCP query executor", () => {
  it("gives the server the statement's time limit and leaves a cancelled call to the server", async () => {
    // Under the package so the script resolves the MCP SDK and zod.
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-mcp-time-limit-"));
    const serverPath = path.join(root, "recording.mjs");
    const log = path.join(root, "calls.log");
    await writeFile(serverPath, RECORDING_SERVER, "utf8");
    const executor = createMcpQueryExecutor({ command: process.execPath, args: [serverPath, log], dialect: "mysql" });
    const entries = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: string; timeoutMs?: number; pid: number });
    try {
      // The limit is what remains of the deadline when the call is made; starting the server takes some of it.
      await executor.run("SELECT 1", 10, { kind: "exploration", deadlineAt: Date.now() + 20_000 });
      const [first] = await entries();
      expect(first!.timeoutMs).toBeGreaterThan(10_000);
      expect(first!.timeoutMs).toBeLessThanOrEqual(20_000);

      const controller = new AbortController();
      const slow = executor.run("SELECT SLOW", 10, { kind: "exploration", signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
      await expect(slow).rejects.toThrow();
      await executor.run("SELECT 1", 10, { kind: "exploration" });
      const recorded = await entries();
      // The cancellation reached the server, and the same process serves the next call.
      expect(recorded.some((entry) => entry.event === "cancelled")).toBe(true);
      expect(new Set(recorded.map((entry) => entry.pid)).size).toBe(1);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("uses bounded preview for exploration and one complete query for a result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-executor-"));
    const databasePath = path.join(root, "test.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE values_table (value INTEGER)");
    const insert = database.prepare("INSERT INTO values_table VALUES (?)");
    database.exec("BEGIN");
    for (let value = 0; value < 250; value += 1) insert.run(value);
    database.exec("COMMIT");
    database.close();

    const executor = createMcpQueryExecutor({
      command: process.execPath,
      args: [path.resolve("dist/reference-sqlite-mcp.js"), databasePath],
      dialect: "sqlite",
      scopedExploration: { scopeId: "sqlite-local-test", connectionId: "sqlite-local-test" },
    });
    try {
      expect(executor.scopedExploration?.scope).toEqual({ scopeId: "sqlite-local-test", connectionId: "sqlite-local-test" });
      const scopedExploration = executor.scopedExploration;
      if (!scopedExploration) throw new Error("SCOPED_EXPLORATION_TEST_CAPABILITY_MISSING");
      const scopedPreview = await scopedExploration.run("SELECT value FROM values_table ORDER BY value", 2, { kind: "exploration" });
      expect(scopedPreview.rows).toHaveLength(2);
      const exploration = await executor.run("SELECT value FROM values_table ORDER BY value", 225, { kind: "exploration", idempotencyKey: "explore-1" });
      expect(exploration.rows).toHaveLength(225);
      expect(exploration.truncated).toBe(true);

      const byteBounded = await executor.run("SELECT value FROM values_table ORDER BY value", 225, { kind: "exploration", idempotencyKey: "explore-bytes", maxPreviewBytes: 1_024 });
      expect(byteBounded.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(byteBounded), "utf8")).toBeLessThan(1_024);

      const result = await executor.run("SELECT value FROM values_table WHERE value < 2 ORDER BY value", 100, { kind: "result", idempotencyKey: "result-1" });
      expect(result).toEqual({ columns: ["value"], rows: [[0], [1]], truncated: false });
      await expect(executor.run("SELECT value FROM values_table", 100, { kind: "result", idempotencyKey: "result-too-large" })).rejects.toThrow("EXPORT_ROW_LIMIT_EXCEEDED");
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("keeps declared column types from get_schema and allows the pragma_table_info lookup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-executor-schema-"));
    const databasePath = path.join(root, "test.db");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE orders (order_id INTEGER PRIMARY KEY, status TEXT NOT NULL, amount REAL)");
    database.close();
    const executor = createMcpQueryExecutor({
      command: process.execPath,
      args: [path.resolve("dist/reference-sqlite-mcp.js"), databasePath],
      dialect: "sqlite",
    });
    try {
      const schema = await executor.getSchema();
      expect(schema.tables).toEqual([expect.objectContaining({
        name: "orders",
        columns: ["order_id", "status", "amount"],
        columnTypes: { order_id: "INTEGER", status: "TEXT", amount: "REAL" },
        primaryKey: ["order_id"],
      })]);
      const lookup = await executor.run("SELECT name, type FROM pragma_table_info('orders')", 1_000, { kind: "exploration", idempotencyKey: "types" });
      expect(lookup.rows).toEqual([["order_id", "INTEGER"], ["status", "TEXT"], ["amount", "REAL"]]);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
  it("replaces a lost database process and retries the query", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-executor-reconnect-"));
    const executor = await flakyExecutor(root, "crash");
    try {
      const result = await executor.run("SELECT v FROM t ORDER BY v", 10, { kind: "exploration" });
      expect(result.rows).toEqual([[1], [2]]);
      await expect(executor.getSchema()).resolves.toEqual(expect.objectContaining({ tables: [expect.objectContaining({ name: "t" })] }));
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("reports DATABASE_UNAVAILABLE when the database process cannot be restored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mcp-executor-unavailable-"));
    const executor = await flakyExecutor(root, "crash-then-dead");
    try {
      const failure = await executor.run("SELECT v FROM t", 10, { kind: "exploration" }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as { code?: string }).code).toBe(DATABASE_UNAVAILABLE);
      expect((failure as Error).message).toMatch(/^DATABASE_UNAVAILABLE: database process unavailable after 3 reconnects/);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
