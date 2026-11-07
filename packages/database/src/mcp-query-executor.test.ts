import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpQueryExecutor } from "./mcp-query-executor.js";

const DELAYED_SERVER = [
  'import fs from "node:fs";',
  'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
  'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
  'import { z } from "zod";',
  'const [log, delayText] = process.argv.slice(2);',
  'fs.appendFileSync(log, JSON.stringify({ event: "started", pid: process.pid }) + "\\n");',
  'await new Promise((resolve) => setTimeout(resolve, Number(delayText)));',
  'const server = new McpServer({ name: "delayed", version: "1.0.0" });',
  'server.tool("execute_query_preview", "preview", { sql: z.string(), limit: z.number().optional(), timeoutMs: z.number().optional() }, async () => ({ content: [{ type: "text", text: JSON.stringify({ columns: ["v"], rows: [{ v: process.pid }], truncated: false }) }] }));',
  'await server.connect(new StdioServerTransport());',
].join("\n");

async function waitForStarts(log: string, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const starts = await readFile(log, "utf8").then((text) => text.trim().split("\n").filter(Boolean).length).catch(() => 0);
    if (starts >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`SERVER_START_TIMEOUT: ${count}`);
}

describe("MCP query executor connection lifecycle", () => {
  it("shares one pending connection between concurrent callers", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-mcp-shared-connect-"));
    const server = path.join(root, "server.mjs");
    const log = path.join(root, "starts.log");
    await writeFile(server, DELAYED_SERVER, "utf8");
    const executor = createMcpQueryExecutor({ command: process.execPath, args: [server, log, "150"], reconnectDelaysMs: [] });
    try {
      const [first, second] = await Promise.all([
        executor.run("SELECT 1", 1, { kind: "exploration" }),
        executor.run("SELECT 2", 1, { kind: "exploration" }),
      ]);
      expect(first.rows[0]?.[0]).toBe(second.rows[0]?.[0]);
      expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);

  it("does not let a superseded connection reset the replacement generation", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-mcp-connect-generation-"));
    const server = path.join(root, "server.mjs");
    const log = path.join(root, "starts.log");
    await writeFile(server, DELAYED_SERVER, "utf8");
    const executor = createMcpQueryExecutor({ command: process.execPath, args: [server, log, "200"], reconnectDelaysMs: [] });
    try {
      const superseded = executor.run("SELECT old", 1, { kind: "exploration" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await waitForStarts(log, 1);
      const resetting = executor.resetConnection();
      const replacement = executor.run("SELECT new", 1, { kind: "exploration" });
      await resetting;
      expect(await superseded).toBeInstanceOf(Error);
      await expect(replacement).resolves.toMatchObject({ columns: ["v"], truncated: false });
      await waitForStarts(log, 2);
    } finally {
      await executor.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 15_000);
});
