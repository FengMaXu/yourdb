import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createConfiguredQueryExecutor, databaseConnectionFrom, databaseExecutorOptions, testDatabaseConnection, type DatabaseServers } from "./connection.js";

const servers: DatabaseServers = {
  mysql: { command: "node", args: ["mysql-server.js"], env: { BASE: "1" } },
  postgres: { command: "node", args: ["pg-server.js"] },
  sqlite: { command: "node", args: ["sqlite-server.js"] },
};

describe("databaseConnectionFrom", () => {
  it("treats a connection saved without a driver as MySQL", () => {
    expect(databaseConnectionFrom({ host: "db", port: "3307", user: "u", password: "", database: "sales" }))
      .toEqual({ driver: "mysql", host: "db", port: 3307, user: "u", password: "", database: "sales" });
  });

  it("refuses an unknown driver instead of connecting it as MySQL", () => {
    expect(() => databaseConnectionFrom({ driver: "oracle" })).toThrow("UNSUPPORTED_DATABASE_DRIVER: oracle");
  });

  it("refuses a port it cannot use instead of falling back to the default", () => {
    for (const port of ["abc", 0, 70000, "3306.5"]) expect(() => databaseConnectionFrom({ port })).toThrow("INVALID_DATABASE_PORT");
    expect(databaseConnectionFrom({ port: "" })).toEqual({ driver: "mysql" });
  });

  it("reads a SQLite connection as its file alone and refuses one without a file", () => {
    expect(databaseConnectionFrom({ driver: "sqlite", host: "db", port: "3306", user: "u", password: "p", database: " C:/data/sales.sqlite " }))
      .toEqual({ driver: "sqlite", database: "C:/data/sales.sqlite" });
    for (const database of [undefined, "", "   "]) expect(() => databaseConnectionFrom({ driver: "sqlite", database })).toThrow("SQLITE_DATABASE_FILE_REQUIRED");
    for (const database of ["sales.sqlite", "data/sales.sqlite"]) expect(() => databaseConnectionFrom({ driver: "sqlite", database })).toThrow("SQLITE_DATABASE_PATH_NOT_ABSOLUTE");
  });

  it("keeps an empty password the user saved", () => {
    expect(databaseConnectionFrom({ driver: "postgres", password: "" })).toEqual({ driver: "postgres", password: "" });
  });
});

describe("databaseExecutorOptions", () => {
  it("starts the driver's MCP server with its credentials and dialect", () => {
    expect(databaseExecutorOptions({ driver: "postgres", host: "pg", port: 5433, user: "analyst", password: "secret", database: "sales" }, servers)).toEqual({
      command: "node",
      args: ["pg-server.js"],
      env: { DATA_AGENT_PG_HOST: "pg", DATA_AGENT_PG_PORT: "5433", DATA_AGENT_PG_USER: "analyst", DATA_AGENT_PG_PASSWORD: "secret", DATA_AGENT_PG_DATABASE: "sales" },
      dialect: "postgres",
      connectionId: "postgres:sales",
    });
    expect(databaseExecutorOptions({ driver: "mysql", database: "sales" }, servers)).toMatchObject({
      args: ["mysql-server.js"],
      env: { BASE: "1", DATA_AGENT_MYSQL_DATABASE: "sales" },
      dialect: "mysql",
    });
    expect(databaseExecutorOptions({ driver: "sqlite", database: "C:/data/sales.sqlite" }, servers)).toEqual({
      command: "node",
      args: ["sqlite-server.js"],
      env: { DATA_AGENT_SQLITE_DATABASE: "C:/data/sales.sqlite" },
      dialect: "sqlite",
      connectionId: "sqlite:C:/data/sales.sqlite",
    });
  });
});

describe("createConfiguredQueryExecutor", () => {
  it("keeps the executor while the connection is unchanged and replaces it when the driver changes", async () => {
    let settings: Record<string, unknown> = { host: "db", database: "sales" };
    const configured = createConfiguredQueryExecutor({ readSettings: async () => settings, servers });
    const first = await configured.resolve();
    expect(first.dialect).toBe("mysql");
    expect(await configured.resolve()).toBe(first);
    settings = { ...settings, driver: "postgres" };
    const second = await configured.resolve();
    expect(second).not.toBe(first);
    expect(second.dialect).toBe("postgres");
    await configured.close();
  });

  it("applies concurrent resolves in call order, so a slow read of old settings cannot win", async () => {
    const reads = [
      { delayMs: 50, settings: { database: "old" } },
      { delayMs: 0, settings: { database: "new" } },
      { delayMs: 0, settings: { database: "new" } },
    ];
    const configured = createConfiguredQueryExecutor({
      readSettings: () => { const read = reads.shift()!; return new Promise((resolve) => setTimeout(() => resolve(read.settings), read.delayMs)); },
      servers,
    });
    const [first, second] = await Promise.all([configured.resolve(), configured.resolve()]);
    expect(first).not.toBe(second);
    // The newer settings stay current: resolving them again keeps the same executor.
    expect(await configured.resolve()).toBe(second);
    await configured.close();
  });
});

describe("testDatabaseConnection", () => {
  it("reports an unknown driver without starting a server", async () => {
    expect(await testDatabaseConnection({ driver: "oracle" }, servers)).toEqual({ success: false, message: "UNSUPPORTED_DATABASE_DRIVER: oracle" });
  });
});

describe("PostgreSQL through its contract MCP server", () => {
  const pgCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp-pg/dist/cli.js");
  const pgServers: DatabaseServers = { ...servers, postgres: { command: process.execPath, args: [pgCli] } };
  const stops: Array<() => Promise<void>> = [];

  /**
   * One PGlite database behind a socket for each server process: right after a
   * client disconnects, the PGlite socket server resets the next connection,
   * which a real PostgreSQL does not.
   */
  const startDatabase = async () => {
    const db = new PGlite();
    const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });
    await socket.start();
    stops.push(async () => { await socket.stop(); await db.close(); });
    await db.exec("CREATE TABLE orders (id INT PRIMARY KEY, amount NUMERIC); INSERT INTO orders VALUES (1, 10), (2, 20);");
    const port = Number(socket.getServerConn().split(":")[1]);
    return { port, settings: { driver: "postgres", host: "127.0.0.1", port, user: "postgres", database: "postgres" } };
  };

  afterAll(async () => {
    for (const stop of stops) await stop();
  });

  it("tests a PostgreSQL connection chosen in settings", async () => {
    const { port, settings } = await startDatabase();
    expect(await testDatabaseConnection(settings, pgServers)).toEqual({ success: true, message: `PostgreSQL 连接成功（127.0.0.1:${port}/ postgres）` });
  }, 60_000);

  it("queries and describes a PostgreSQL database chosen in settings", async () => {
    const { settings } = await startDatabase();
    const configured = createConfiguredQueryExecutor({ readSettings: async () => settings, servers: pgServers });
    try {
      await expect(configured.check()).resolves.toBeUndefined();
      const executor = await configured.resolve();
      expect(await executor.run("SELECT id, amount FROM orders ORDER BY id", 10, { kind: "result" })).toEqual({ columns: ["id", "amount"], rows: [[1, "10"], [2, "20"]], truncated: false });
      expect(await executor.getSchema()).toMatchObject({ connectionId: "postgres:postgres", dialect: "postgres", tables: [{ name: "orders", columns: ["id", "amount"], primaryKey: ["id"] }] });
    } finally {
      await configured.close();
    }
  }, 60_000);
});

describe("SQLite through its contract MCP server", () => {
  const sqliteCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp-sqlite/dist/cli.js");
  const sqliteServers: DatabaseServers = { ...servers, sqlite: { command: process.execPath, args: [sqliteCli] } };

  it("tests, queries and describes a SQLite file chosen in settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "data-agent-sqlite-"));
    const file = path.join(root, "sales.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL); INSERT INTO orders VALUES (1, 10), (2, 20);");
    seed.close();
    const settings = { driver: "sqlite", database: file };
    const configured = createConfiguredQueryExecutor({ readSettings: async () => settings, servers: sqliteServers });
    try {
      expect(await testDatabaseConnection(settings, sqliteServers)).toEqual({ success: true, message: `SQLite 连接成功（${file}）` });
      const executor = await configured.resolve();
      expect(await executor.run("SELECT id, amount FROM orders ORDER BY id", 10, { kind: "result" })).toEqual({ columns: ["id", "amount"], rows: [[1, 10], [2, 20]], truncated: false });
      expect(await executor.getSchema()).toMatchObject({ connectionId: `sqlite:${file}`, dialect: "sqlite", tables: [{ name: "orders", columns: ["id", "amount"], primaryKey: ["id"] }] });
    } finally {
      await configured.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports a missing file instead of creating an empty database", async () => {
    const file = path.join(tmpdir(), `data-agent-missing-${process.pid}.sqlite`);
    const result = await testDatabaseConnection({ driver: "sqlite", database: file }, sqliteServers);
    expect(result.success).toBe(false);
    expect(result.message).toContain("SQLite 连接失败");
    expect(existsSync(file)).toBe(false);
  }, 60_000);
});
