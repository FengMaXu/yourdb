import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpQueryExecutorOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  dialect?: "sqlite" | "mysql" | "postgres" | "bigquery" | "snowflake";
  connectionId?: string;
  /** Statement time limit when the caller sets no deadline; the database server enforces it. Unresponsive workers are replaced. */
  requestTimeoutMs?: number;
  /** Explicit local-test capability; callers must provide server-side scoped enforcement before using it in production. */
  scopedExploration?: { readonly scopeId: string; readonly connectionId: string };
  /** Backoff before each reconnect after the database process is lost; defaults to 0.5s, 2s, 5s. */
  reconnectDelaysMs?: readonly number[];
}

export const DATABASE_UNAVAILABLE = "DATABASE_UNAVAILABLE";

/** The database process could not be reached even after reconnecting; the operation cannot continue. */
export class DatabaseUnavailableError extends Error {
  readonly code = DATABASE_UNAVAILABLE;
  constructor(detail: string) {
    super(`${DATABASE_UNAVAILABLE}: ${detail}`);
    this.name = "DatabaseUnavailableError";
  }
}

/**
 * How long past a statement's own time limit the client waits for the server's
 * report. The database stops the statement at the limit (MySQL MAX_EXECUTION_TIME,
 * PostgreSQL statement_timeout) and says QUERY_TIMEOUT; a server that has not
 * answered by then is unresponsive.
 */
const STATEMENT_REPORT_GRACE_MS = 5_000;

const CONNECTION_LOST = /Connection closed|EPIPE|ECONNRESET|Not connected|transport closed|ERR_STREAM_DESTROYED|spawn .*ENOENT/i;

function isConnectionLoss(error: unknown): boolean {
  return CONNECTION_LOST.test(error instanceof Error ? error.message : String(error));
}

function isRequestTimeout(error: unknown): boolean {
  return /timed out|timeout|RequestTimeout/i.test(error instanceof Error ? error.message : String(error));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("QUERY_CANCELLED")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("QUERY_CANCELLED")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface McpQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export interface McpQueryExecutionOptions {
  readonly kind?: "exploration" | "result";
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly maxPreviewBytes?: number;
  readonly scope?: { readonly scopeId: string; readonly connectionId: string };
}

/** Keep the declared column types that get_schema reports (e.g. PRAGMA table_info.type). */
function columnTypesOf(columns: unknown): Record<string, string> | undefined {
  if (!Array.isArray(columns)) return undefined;
  const entries = columns.flatMap((column) => {
    const record = column && typeof column === "object" ? column as { name?: unknown; type?: unknown } : undefined;
    return typeof record?.name === "string" && typeof record.type === "string" && record.type.trim() ? [[record.name, record.type.trim()] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export interface McpSchemaEvidence {
  connectionId: string;
  dialect: "sqlite" | "mysql" | "postgres" | "bigquery" | "snowflake";
  tables: Array<{
    name: string;
    columns: string[];
    columnTypes?: Record<string, string>;
    primaryKey?: string[];
    uniqueKeys?: string[][];
    foreignKeys?: Array<{ columns: string[]; references: { table: string; columns: string[] } }>;
  }>;
}

/**
 * Infrastructure adapter: connects to a Data Agent contract MCP database
 * server (stdio) and executes read-only queries for the Runtime.
 * The Runtime never touches business
 * databases directly; all SQL flows through this MCP client.
 */
export function createMcpQueryExecutor(options: McpQueryExecutorOptions) {
  type Connection = { readonly generation: number; readonly client: Client; readonly transport: StdioClientTransport };
  type ConnectionState =
    | { readonly kind: "disconnected"; readonly generation: number }
    | ({ readonly kind: "connecting"; readonly ready: Promise<Connection> } & Connection)
    | ({ readonly kind: "connected" } & Connection);

  let connection: ConnectionState = { kind: "disconnected", generation: 0 };
  const owns = (generation: number, transport: StdioClientTransport): boolean =>
    connection.kind !== "disconnected" && connection.generation === generation && connection.transport === transport;

  const resetGeneration = async (expectedGeneration?: number): Promise<void> => {
    const current = connection;
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) return;
    connection = { kind: "disconnected", generation: current.generation + 1 };
    if (current.kind !== "disconnected") await current.transport.close().catch(() => undefined);
  };
  const resetConnection = (): Promise<void> => resetGeneration();

  const connect = (): Promise<Connection> => {
    if (connection.kind === "connected") return Promise.resolve(connection);
    if (connection.kind === "connecting") return connection.ready;

    const generation = connection.generation + 1;
    const transport = new StdioClientTransport({
      command: options.command,
      args: options.args ?? [],
      env: options.env ? { ...options.env } : undefined,
    });
    const client = new Client({ name: "data-agent-query-executor", version: "1.0.0" });
    let resolveReady!: (connected: Connection) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<Connection>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    connection = { kind: "connecting", generation, client, transport, ready };
    transport.onerror = (error) => console.error("[mcp-query-executor] transport error:", error.message);
    transport.onclose = () => {
      if (owns(generation, transport)) connection = { kind: "disconnected", generation: generation + 1 };
      console.error("[mcp-query-executor] transport closed");
    };
    // client.connect(transport) invokes start(); do not call it separately.
    void client.connect(transport).then(
      () => {
        if (!owns(generation, transport)) {
          void transport.close().catch(() => undefined);
          rejectReady(new Error("MCP_CONNECTION_SUPERSEDED"));
          return;
        }
        const connected: Connection = { generation, client, transport };
        connection = { kind: "connected", ...connected };
        resolveReady(connected);
      },
      (error: unknown) => {
        if (owns(generation, transport)) connection = { kind: "disconnected", generation: generation + 1 };
        void transport.close().catch(() => undefined);
        rejectReady(error);
      },
    );
    return ready;
  };

  const reconnectDelays = options.reconnectDelaysMs ?? [500, 2_000, 5_000];
  /**
   * Runs one read-only MCP call, replacing a lost database process and retrying
   * the call after a health check. Exhausting the reconnects is terminal for
   * the caller: the Agent must not work around a missing database.
   */
  const withConnection = async <T>(
    operation: (connected: Client) => Promise<T>,
    signal?: AbortSignal,
    resetOnError?: (error: unknown) => boolean,
  ): Promise<T> => {
    let lastError: unknown;
    let failedGeneration: number | undefined;
    for (let attempt = 0; attempt <= reconnectDelays.length; attempt += 1) {
      if (attempt > 0) {
        if (failedGeneration !== undefined) await resetGeneration(failedGeneration);
        await delay(reconnectDelays[attempt - 1]!, signal);
      }
      let connected: Connection | undefined;
      try {
        connected = await connect();
        if (attempt > 0) await connected.client.listTools(undefined, { timeout: 10_000 });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (connected) failedGeneration = connected.generation;
        lastError = error;
        continue;
      }
      try {
        return await operation(connected.client);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (resetOnError?.(error)) {
          await resetGeneration(connected.generation);
          throw error;
        }
        if (!isConnectionLoss(error)) throw error;
        failedGeneration = connected.generation;
        lastError = error;
      }
    }
    if (failedGeneration !== undefined) await resetGeneration(failedGeneration);
    throw new DatabaseUnavailableError(`database process unavailable after ${reconnectDelays.length} reconnects (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  };
  const run = async (sql: string, rowLimit: number, execution?: McpQueryExecutionOptions): Promise<McpQueryResult> => {
      if (execution?.signal?.aborted) throw new Error("QUERY_CANCELLED");
      const finalResult = execution?.kind === "result";
      const effectiveLimit = Math.min(Math.max(1, Math.floor(rowLimit)), finalResult ? 100000 : 10000);
      // A cancelled call is stopped on the server through MCP cancellation, so the process stays.
      // Only a server that missed its own time limit and the grace after it is replaced.
      const result = await withConnection((c) => {
        const remaining = execution?.deadlineAt ? Math.max(1, execution.deadlineAt - Date.now()) : undefined;
        // The server enforces the statement's limit itself; the client only waits for its answer.
        const statementMs = Math.max(1, Math.floor(Math.min(options.requestTimeoutMs ?? 60_000, remaining ?? Number.POSITIVE_INFINITY)));
        return c.callTool({
          name: finalResult ? "execute_query_export" : "execute_query_preview",
          arguments: finalResult
            ? { sql, maxRows: effectiveLimit, timeoutMs: statementMs }
            : { sql, limit: effectiveLimit, timeoutMs: statementMs, ...(execution?.maxPreviewBytes ? { maxBytes: execution.maxPreviewBytes } : {}) },
        }, undefined, {
          timeout: statementMs + STATEMENT_REPORT_GRACE_MS,
          ...(execution?.signal ? { signal: execution.signal } : {}),
        });
      }, execution?.signal, isRequestTimeout) as unknown as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      const text = result.content?.find((part) => part.type === "text")?.text;
      if (!text) throw new Error("MCP_QUERY_EMPTY_RESPONSE");
      if (result.isError) throw new Error(`MCP_TOOL_ERROR: ${text.slice(0, 300)}`);
      let payload: { error?: { code: string; message?: string }; columns?: string[]; rows?: unknown[]; truncated?: boolean };
      try { payload = JSON.parse(text) as typeof payload; }
      catch { throw new Error(`MCP_QUERY_BAD_RESPONSE: ${text.slice(0, 300)}`); }
      if (payload.error) throw new Error(`${payload.error.code}${payload.error.message ? `: ${payload.error.message}` : ""}`);
      const rows = (payload.rows ?? []) as Record<string, unknown>[];
      const columns = payload.columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);
      return {
        columns,
        rows: rows.map((row) => columns.map((col) => row[col])),
        truncated: Boolean(payload.truncated),
      };
    };
  const scopedExploration = options.scopedExploration ? {
    scope: options.scopedExploration,
    run: (sql: string, rowLimit: number, execution: McpQueryExecutionOptions) => run(sql, rowLimit, { ...execution, kind: "exploration", scope: options.scopedExploration }),
  } : undefined;
  return {
    dialect: options.dialect ?? "mysql",
    run,
    ...(scopedExploration ? { scopedExploration } : {}),
    async getSchema(): Promise<McpSchemaEvidence> {
      const result = await withConnection((c) => c.callTool({ name: "get_schema", arguments: {} })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      const text = result.content?.find((part) => part.type === "text")?.text;
      if (!text) throw new Error("MCP_SCHEMA_EMPTY_RESPONSE");
      if (result.isError) throw new Error(`MCP_TOOL_ERROR: ${text.slice(0, 300)}`);
      let payload: { schema?: Array<{ table?: unknown; columns?: Array<{ name?: unknown; type?: unknown }>; primaryKey?: unknown; uniqueKeys?: unknown; foreignKeys?: unknown }> };
      try { payload = JSON.parse(text) as typeof payload; }
      catch { throw new Error(`MCP_SCHEMA_BAD_RESPONSE: ${text.slice(0, 300)}`); }
      return {
        connectionId: options.connectionId ?? `${options.dialect ?? "mysql"}:${String(options.env?.DATA_AGENT_MYSQL_DATABASE ?? "configured")}`,
        dialect: options.dialect ?? "mysql",
        tables: (payload.schema ?? []).flatMap((table) => typeof table.table === "string" ? [{
          name: table.table,
          columns: (table.columns ?? []).flatMap((column) => typeof column.name === "string" ? [column.name] : []),
          ...(columnTypesOf(table.columns) ? { columnTypes: columnTypesOf(table.columns)! } : {}),
          ...(Array.isArray(table.primaryKey) ? { primaryKey: table.primaryKey.filter((column): column is string => typeof column === "string") } : {}),
          ...(Array.isArray(table.uniqueKeys) ? { uniqueKeys: table.uniqueKeys.filter((key): key is string[] => Array.isArray(key) && key.every((column) => typeof column === "string")) } : {}),
          ...(Array.isArray(table.foreignKeys) ? { foreignKeys: table.foreignKeys.filter((key): key is { columns: string[]; references: { table: string; columns: string[] } } => Boolean(key && typeof key === "object" && Array.isArray((key as any).columns) && (key as any).references && typeof (key as any).references.table === "string" && Array.isArray((key as any).references.columns))).map((key) => ({ columns: key.columns, references: key.references })) } : {}),
        }] : []),
      };
    },
    resetConnection,
    async close(): Promise<void> {
      await resetConnection();
    },
  };
}
