import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createConfiguredQueryExecutor, testDatabaseConnection, type DatabaseServers } from "./connection.js";

/**
 * Statement time limits and cancellation need a real PostgreSQL server; PGlite
 * runs single-threaded in process and can do neither. CI starts one and sets
 * DATA_AGENT_TEST_PG=1.
 */
const enabled = process.env.DATA_AGENT_TEST_PG === "1";
const settings = {
  driver: "postgres",
  host: process.env.DATA_AGENT_PG_HOST ?? "127.0.0.1",
  port: Number(process.env.DATA_AGENT_PG_PORT ?? 5432),
  user: process.env.DATA_AGENT_PG_USER ?? "postgres",
  password: process.env.DATA_AGENT_PG_PASSWORD ?? "postgres",
  database: process.env.DATA_AGENT_PG_DATABASE ?? "postgres",
};
const pgCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp-pg/dist/cli.js");
const servers: DatabaseServers = {
  mysql: { command: process.execPath, args: ["unused"] },
  postgres: { command: process.execPath, args: [pgCli] },
};

describe.runIf(enabled)("PostgreSQL contract MCP server against a real server", () => {
  const configured = createConfiguredQueryExecutor({ readSettings: async () => settings, servers });
  // A session of its own, to watch what the server is running.
  const observer = new pg.Client({ host: settings.host, port: settings.port, user: settings.user, password: settings.password, database: settings.database });

  beforeAll(async () => {
    await observer.connect();
    await observer.query("DROP SEQUENCE IF EXISTS contract_seq; CREATE SEQUENCE contract_seq");
  });

  afterAll(async () => {
    await configured.close();
    await observer.end();
  });

  /** Statements other sessions are running whose text contains the marker. */
  const running = async (marker: string): Promise<number> => {
    const result = await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1", [`%${marker}%`]);
    return result.rows[0].n as number;
  };
  const eventually = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return check();
  };

  it("tests the connection", async () => {
    expect(await testDatabaseConnection(settings, servers)).toMatchObject({ success: true, message: expect.stringContaining("PostgreSQL 连接成功") });
  });

  it("stops a statement at its time limit and keeps serving", async () => {
    const executor = await configured.resolve();
    const started = Date.now();
    await expect(executor.run("SELECT pg_sleep(20) AS timeout_marker", 1, { deadlineAt: Date.now() + 1_000 })).rejects.toThrow(/^QUERY_TIMEOUT/);
    // PostgreSQL stopped it near the limit, well before the 20 s sleep or the client grace.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await running("timeout_marker")).toBe(0);
    expect(await executor.run("SELECT 1 AS n", 1)).toMatchObject({ rows: [[1]] });
  }, 30_000);

  it("cancels a running statement on the server when the call is cancelled", async () => {
    const executor = await configured.resolve();
    const controller = new AbortController();
    const call = executor.run("SELECT pg_sleep(30) AS cancel_marker", 1, { signal: controller.signal });
    call.catch(() => undefined);
    expect(await eventually(async () => (await running("cancel_marker")) === 1, 10_000)).toBe(true);
    controller.abort();
    await expect(call).rejects.toThrow();
    // The statement is gone from the server, not merely abandoned by the client.
    expect(await eventually(async () => (await running("cancel_marker")) === 0, 5_000)).toBe(true);
    expect(await executor.run("SELECT 2 AS n", 1)).toMatchObject({ rows: [[2]] });
  }, 40_000);

  it("refuses writes the keyword filter does not see", async () => {
    const executor = await configured.resolve();
    await expect(executor.run("SELECT nextval('contract_seq') AS n", 1)).rejects.toThrow(/read-only transaction/);
  });
});
