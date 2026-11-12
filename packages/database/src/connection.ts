import path from "node:path";
import { createMcpQueryExecutor, type McpQueryExecutorOptions } from "./mcp-query-executor.js";

/** Databases the product connects to; each has a contract MCP server. */
export const DATABASE_DRIVERS = ["mysql", "postgres", "sqlite"] as const;
export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number];

/** For SQLite, `database` is the file path and the network fields are unused. */
export interface DatabaseConnection {
  readonly driver: DatabaseDriver;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly database?: string;
}

/** How a host starts one database's MCP server process. */
export interface McpServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type DatabaseServers = Readonly<Record<DatabaseDriver, McpServerLaunch>>;

const DRIVER_FACTS: Readonly<Record<DatabaseDriver, { readonly label: string; readonly envPrefix: string; readonly defaultPort?: number }>> = {
  mysql: { label: "MySQL", envPrefix: "DATA_AGENT_MYSQL", defaultPort: 3306 },
  postgres: { label: "PostgreSQL", envPrefix: "DATA_AGENT_PG", defaultPort: 5432 },
  sqlite: { label: "SQLite", envPrefix: "DATA_AGENT_SQLITE" },
};

export function isDatabaseDriver(value: unknown): value is DatabaseDriver {
  return typeof value === "string" && (DATABASE_DRIVERS as readonly string[]).includes(value);
}

/**
 * Reads a connection from saved settings or a test request. A missing driver
 * is MySQL, which every connection was before drivers existed; an unknown one
 * is refused rather than silently connected as MySQL. An unusable port is
 * refused too, so a test never succeeds against the default port instead.
 */
export function databaseConnectionFrom(settings: unknown): DatabaseConnection {
  const record = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const filled = (value: unknown) => value !== undefined && value !== null && String(value).trim() !== "";
  // Nothing saved yet: say so, rather than dial a MySQL on localhost:3306 the user never chose.
  // The setup checklist uses the same rule (useReadiness). Settings from before the driver field
  // carried a host and mean MySQL, so they still default to it.
  if (!filled(record.driver) && !filled(record.host) && !filled(record.database)) {
    throw new Error("DATABASE_NOT_CONFIGURED: 还没有连接数据库。请在 设置 → 数据库 中连接，或在新会话页点“先用示例 SQLite 试试”。");
  }
  const driver = record.driver ?? "mysql";
  if (!isDatabaseDriver(driver)) throw new Error(`UNSUPPORTED_DATABASE_DRIVER: ${String(driver)}`);
  const text = (value: unknown) => value === undefined || value === null || value === "" ? undefined : String(value);
  if (driver === "sqlite") {
    // A file, not a server: a SQLite connection without one would open nothing.
    const file = text(record.database)?.trim();
    if (!file) throw new Error("SQLITE_DATABASE_FILE_REQUIRED: 请填写 SQLite 数据库文件路径");
    // The server process runs elsewhere than the user thinks; a relative path would open some other file.
    if (!path.isAbsolute(file)) throw new Error(`SQLITE_DATABASE_PATH_NOT_ABSOLUTE: 请填写完整路径（${file}）`);
    return { driver, database: file };
  }
  const port = text(record.port) === undefined ? undefined : Number(record.port);
  if (port !== undefined && !(Number.isSafeInteger(port) && port >= 1 && port <= 65_535)) throw new Error(`INVALID_DATABASE_PORT: ${String(record.port)}`);
  return {
    driver,
    ...(text(record.host) ? { host: text(record.host)! } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(text(record.user) ? { user: text(record.user)! } : {}),
    // An empty password is a value the user saved, not a missing one.
    ...(typeof record.password === "string" ? { password: record.password } : {}),
    ...(text(record.database) ? { database: text(record.database)! } : {}),
  };
}

/** The MCP server process, its credentials and the SQL dialect for one connection. */
export function databaseExecutorOptions(connection: DatabaseConnection, servers: DatabaseServers): McpQueryExecutorOptions {
  const launch = servers[connection.driver];
  const { envPrefix } = DRIVER_FACTS[connection.driver];
  // A SQLite connection holds only its file, which reaches the server as DATA_AGENT_SQLITE_DATABASE.
  const env: Record<string, string> = { ...(launch.env ?? {}) };
  for (const field of ["host", "port", "user", "password", "database"] as const) {
    const value = connection[field];
    if (value !== undefined) env[`${envPrefix}_${field.toUpperCase()}`] = String(value);
  }
  return {
    command: launch.command,
    args: [...launch.args],
    env,
    dialect: connection.driver,
    connectionId: `${connection.driver}:${connection.database ?? "configured"}`,
  };
}

export type DatabaseQueryExecutor = ReturnType<typeof createMcpQueryExecutor>;

/**
 * One executor for the saved connection. Each resolve rereads the settings and
 * starts a new MCP server process when the connection changed, so a driver or
 * credential change applies to the next session without a restart.
 *
 * A session keeps the executor it resolved for its whole turn. A replaced
 * executor therefore stays open until close(): closing it under a running
 * turn would fail its call, and the executor would reconnect on its own with
 * the old connection, out of reach of close().
 */
export function createConfiguredQueryExecutor(options: { readonly readSettings: () => Promise<unknown>; readonly servers: DatabaseServers }) {
  let executor: DatabaseQueryExecutor | undefined;
  let executorKey = "";
  const replaced: DatabaseQueryExecutor[] = [];
  // Resolves run one at a time, so a slow settings read cannot replace a newer connection.
  let queue: Promise<unknown> = Promise.resolve();
  const resolveNow = async (): Promise<DatabaseQueryExecutor> => {
    const next = databaseExecutorOptions(databaseConnectionFrom(await options.readSettings()), options.servers);
    const nextKey = JSON.stringify(next);
    if (executor && executorKey === nextKey) return executor;
    if (executor) replaced.push(executor);
    executor = createMcpQueryExecutor(next);
    executorKey = nextKey;
    return executor;
  };
  const resolve = (): Promise<DatabaseQueryExecutor> => {
    const resolved = queue.then(resolveNow);
    queue = resolved.catch(() => undefined);
    return resolved;
  };
  return {
    resolve,
    /** Whether the saved connection answers now: one trivial query under a short limit, through the same server process. */
    async check(timeoutMs = 5_000): Promise<void> {
      await (await resolve()).run("SELECT 1 AS ok", 1, { deadlineAt: Date.now() + timeoutMs });
    },
    async close(): Promise<void> {
      const all = [...replaced.splice(0), ...(executor ? [executor] : [])];
      executor = undefined;
      executorKey = "";
      await Promise.all(all.map((current) => current.close().catch(() => undefined)));
    },
  };
}

/** Opens the connection through its MCP server and runs one trivial query. */
export async function testDatabaseConnection(settings: unknown, servers: DatabaseServers): Promise<{ success: boolean; message: string }> {
  let connection: DatabaseConnection;
  try {
    connection = databaseConnectionFrom(settings);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
  const { label, defaultPort } = DRIVER_FACTS[connection.driver];
  const target = connection.driver === "sqlite"
    ? connection.database!
    : `${connection.host ?? "127.0.0.1"}:${connection.port ?? defaultPort}${connection.database ? `/ ${connection.database}` : ""}`;
  // A test must not wait out the reconnect backoff meant for a running session.
  const executor = createMcpQueryExecutor({ ...databaseExecutorOptions(connection, servers), reconnectDelaysMs: [] });
  try {
    await executor.run("SELECT 1 AS connection_ok", 1);
    return { success: true, message: `${label} 连接成功（${target}）` };
  } catch (error) {
    return { success: false, message: `${label} 连接失败: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await executor.close().catch(() => undefined);
  }
}
