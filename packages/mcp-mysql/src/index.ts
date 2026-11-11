import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import * as mysqlCallback from "mysql2";
import type { Pool } from "mysql2/promise";

export const DATABASE_MCP_CONTRACT_VERSION = 1;
const DEFAULT_PREVIEW_LIMIT = 20;
const MAX_PREVIEW_LIMIT = 10_000;

/**
 * Connections each pool may open. A query waiting for a connection still
 * spends its time budget, so a pool must hold as many connections as the host
 * runs queries at once: the Runtime caps child explorations at 12, and the
 * parent and result queries come on top. MySQL's max_connections is shared by
 * every client of the server, so these stay well under its default of 151.
 */
export const DEFAULT_PREVIEW_CONNECTIONS = 16;
export const DEFAULT_RESULT_CONNECTIONS = 8;

export interface MysqlReferenceServerOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Connections for previews (explorations); defaults to DEFAULT_PREVIEW_CONNECTIONS. */
  previewConnections?: number;
  /** Connections for result queries, EXPLAIN and schema; defaults to DEFAULT_RESULT_CONNECTIONS. */
  resultConnections?: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Credentials come from the environment or an explicitly provided config owned by the MCP Server process. */
export function credentialsFromEnv(): MysqlReferenceServerOptions {
  return {
    host: process.env.DATA_AGENT_MYSQL_HOST ?? "127.0.0.1",
    port: Number(process.env.DATA_AGENT_MYSQL_PORT ?? 3306),
    user: process.env.DATA_AGENT_MYSQL_USER ?? "root",
    password: process.env.DATA_AGENT_MYSQL_PASSWORD,
    database: process.env.DATA_AGENT_MYSQL_DATABASE,
    previewConnections: positiveInteger(process.env.DATA_AGENT_MYSQL_PREVIEW_CONNECTIONS),
    resultConnections: positiveInteger(process.env.DATA_AGENT_MYSQL_RESULT_CONNECTIONS),
  };
}

/**
 * The statement's own time limit, enforced by MySQL: when it passes, MySQL
 * stops the statement and reports ER_QUERY_TIMEOUT. A limit kept only by the
 * client would leave the statement running after the client gave up.
 */
function timed(statement: string, timeoutMs: number | undefined): string {
  return timeoutMs ? statement.replace(/^SELECT /, `SELECT /*+ MAX_EXECUTION_TIME(${Math.max(1, Math.floor(timeoutMs))}) */ `) : statement;
}

/** ER_QUERY_TIMEOUT: the statement ran past MAX_EXECUTION_TIME and MySQL stopped it. */
function isStatementTimeout(error: unknown): boolean {
  return (error as { errno?: number } | undefined)?.errno === 3024;
}

const timeoutPayload = (timeoutMs: number | undefined) => ({ error: { code: "QUERY_TIMEOUT", message: `statement stopped by MySQL after ${timeoutMs ?? 0} ms (MAX_EXECUTION_TIME)` } });

function redact(sql: string): string {
  return sql.replace(/'[^']*'/g, "'<REDACTED>'").slice(0, 200);
}

const FORBIDDEN = /\b(drop|truncate|delete|insert|update|alter|grant|revoke|call|replace|load_file|into\s+outfile)\b/i;

export async function createMysqlReferenceServer(options: MysqlReferenceServerOptions) {
  // dateStrings: DATE, DATETIME and TIMESTAMP arrive as the text MySQL sends. Parsed into a Date they
  // would sit at local midnight and serialise as UTC, so on a UTC+8 host DATE '2025-12-01' became
  // "2025-11-30T16:00:00.000Z". TIMESTAMP text is in the session time zone.
  const pool: Pool = mysql.createPool({
    host: options.host, port: options.port, user: options.user, password: options.password,
    database: options.database, connectionLimit: options.resultConnections ?? DEFAULT_RESULT_CONNECTIONS, enableKeepAlive: true, dateStrings: true,
  });
  // Promise queries buffer their complete result. Introspection uses a callback
  // pool so the response path can stop reading after the bounded preview.
  const introspectionPool = mysqlCallback.createPool({
    host: options.host, port: options.port, user: options.user, password: options.password,
    database: options.database, connectionLimit: options.previewConnections ?? DEFAULT_PREVIEW_CONNECTIONS, enableKeepAlive: true, dateStrings: true,
  });
  /** Stops a statement on the server; a closed client stream alone leaves it running. */
  const killStatement = (threadId: number | undefined): void => {
    if (threadId === undefined) return;
    pool.query(`KILL QUERY ${Math.floor(threadId)}`).catch(() => undefined);
  };
  const server = new McpServer({ name: "data-agent-mysql-reference", version: "1.0.0" });

  server.tool(
    "execute_query_preview",
    "Run a read-only MySQL query and return a bounded preview",
    {
      sql: z.string().min(1),
      limit: z.number().int().positive().max(MAX_PREVIEW_LIMIT).optional(),
      maxBytes: z.number().int().positive().max(64 * 1024).optional(),
      /** Statement time limit in ms, enforced by MySQL. */
      timeoutMs: z.number().int().positive().optional(),
    },
    async ({ sql, limit, maxBytes, timeoutMs }, extra) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      }
      const effectiveLimit = Math.min(limit ?? DEFAULT_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);
      // MySQL does not allow SHOW/DESCRIBE statements inside a derived table.
      // Stream these read-only introspection statements directly so a large SHOW
      // result is never buffered in full by the promise client.
      const isIntrospectionQuery = /^(?:show|describe|desc)\b/i.test(trimmed);
      try {
        const result = isIntrospectionQuery
          ? await readIntrospectionPreview(trimmed, effectiveLimit, maxBytes, extra.signal)
          : await readQueryPreview(trimmed, effectiveLimit, maxBytes, extra.signal, timeoutMs);
        return { content: [{ type: "text", text: JSON.stringify({ rows: result.rows, columns: result.columns, totalRows: result.totalRows, truncated: result.truncated, serverLimit: MAX_PREVIEW_LIMIT, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        if (isStatementTimeout(error)) return { content: [{ type: "text", text: JSON.stringify(timeoutPayload(timeoutMs)) }] };
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "QUERY_FAILED", message: redact(`${(error as Error).message} in ${redact(trimmed)}`).slice(0, 500) } }) }] };
      }
    },
  );

  server.tool(
    "explain_query",
    "Compile a read-only MySQL query and return its EXPLAIN plan",
    { sql: z.string().min(1) },
    async ({ sql }) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      try {
        const [rows, fields] = await pool.query(`EXPLAIN ${trimmed}`);
        const values = rows as Record<string, unknown>[];
        const columns = (fields as Array<{ name: string }> | undefined)?.map((field) => field.name) ?? (values.length > 0 ? Object.keys(values[0]) : []);
        return { content: [{ type: "text", text: JSON.stringify({ columns, rows: values, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPLAIN_FAILED", message: redact(String((error as Error).message)).slice(0, 300) } }) }] };
      }
    },
  );

  /**
   * Streams a bounded preview on its own connection. Once the preview has its
   * rows, or the caller cancels, the statement is stopped on the server, so an
   * abandoned or oversized query does not keep the connection and the server busy.
   */
  function readQueryPreview(sql: string, limit: number, maxBytes?: number, signal?: AbortSignal, timeoutMs?: number): Promise<{ rows: any[]; columns: string[]; totalRows: number; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("QUERY_CANCELLED"));
        return;
      }
      introspectionPool.getConnection((connectionError, connection) => {
        if (connectionError) {
          reject(connectionError);
          return;
        }
        // Cancelled while waiting for a connection: nobody wants the result, so the statement never starts.
        if (signal?.aborted) {
          connection.release();
          reject(new Error("QUERY_CANCELLED"));
          return;
        }
        const rows: any[] = [];
        let settled = false;
        let columns: string[] = [];
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          connection.release();
        };
        const query = connection.query(timed(`SELECT * FROM (${sql}) __preview`, timeoutMs)) as any;
        query.on("fields", (fields: Array<{ name: string }>) => { columns = fields.map((field) => field.name); });
        const queryStream = query.stream({ highWaterMark: 1 });
        const stop = () => {
          killStatement(connection.threadId ?? undefined);
          queryStream.destroy();
        };
        let onAbort = () => undefined;
        const finish = (result: { rows: any[]; columns: string[]; totalRows: number; truncated: boolean }) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          if (result.truncated) stop();
          resolve(result);
        };
        onAbort = () => {
          if (settled) return;
          settled = true;
          stop();
          reject(new Error("QUERY_CANCELLED"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queryStream.on("data", (row: any) => {
          if (settled) return;
          const candidate = [...rows, row];
          const overRows = candidate.length > limit;
          const overBytes = maxBytes !== undefined && Buffer.byteLength(JSON.stringify({ rows: candidate, columns }), "utf8") > maxBytes;
          if (overRows || overBytes) {
            finish({ rows, columns, totalRows: rows.length + 1, truncated: true });
            return;
          }
          rows.push(row);
        });
        // The connection returns to the pool only once MySQL has ended the statement.
        query.on("end", release);
        query.on("error", release);
        queryStream.on("end", () => finish({ rows, columns, totalRows: rows.length, truncated: false }));
        queryStream.on("error", (error: Error) => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            reject(error);
          }
        });
      });
    });
  }

  function readIntrospectionPreview(sql: string, limit: number, maxBytes?: number, signal?: AbortSignal): Promise<{ rows: any[]; columns: string[]; totalRows: number; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const rows: any[] = [];
      let settled = false;
      let columns: string[] = [];
      const query = introspectionPool.query(sql) as any;
      query.on("fields", (fields: Array<{ name: string }>) => { columns = fields.map((field) => field.name); });
      const queryStream = query.stream({ highWaterMark: 1 });
      let onAbort = () => undefined;
      const finish = (result: { rows: any[]; columns: string[]; totalRows: number; truncated: boolean }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        queryStream.destroy();
        resolve(result);
      };
      onAbort = () => {
        if (settled) return;
        settled = true;
        queryStream.destroy();
        reject(new Error("QUERY_CANCELLED"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      queryStream.on("data", (row: any) => {
        if (settled) return;
        rows.push(row);
        if (rows.length > limit || (maxBytes !== undefined && Buffer.byteLength(JSON.stringify({ rows, columns }), "utf8") > maxBytes)) {
          finish({ rows: rows.slice(0, Math.min(rows.length, limit)), columns, totalRows: rows.length, truncated: true });
        }
      });
      queryStream.on("end", () => finish({ rows, columns, totalRows: rows.length, truncated: false }));
      queryStream.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      });
    });
  }

  server.tool(
    "execute_query_export",
    "Run one complete bounded read-only MySQL result query",
    {
      sql: z.string().min(1),
      maxRows: z.number().int().positive().max(100000).optional(),
      /** Statement time limit in ms, enforced by MySQL. */
      timeoutMs: z.number().int().positive().optional(),
    },
    async ({ sql, maxRows: requestedMaxRows, timeoutMs }) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      const rowLimit = Math.min(requestedMaxRows ?? 100000, 100000);
      try {
        // One database statement produces the complete sealed Candidate input.
        const [rows, fields] = await pool.query(timed(`SELECT * FROM (${trimmed}) __result LIMIT ${rowLimit + 1}`, timeoutMs));
        const list = rows as Record<string, unknown>[];
        if (list.length > rowLimit) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPORT_ROW_LIMIT_EXCEEDED", rowLimit } }) }] };
        const columns = (fields as Array<{ name: string }> | undefined)?.map((field) => field.name) ?? (list.length > 0 ? Object.keys(list[0]) : []);
        return { content: [{ type: "text", text: JSON.stringify({ rows: list, columns, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        if (isStatementTimeout(error)) return { content: [{ type: "text", text: JSON.stringify(timeoutPayload(timeoutMs)) }] };
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "QUERY_FAILED", message: redact(`${(error as Error).message} in ${redact(trimmed)}`).slice(0, 500) } }) }] };
      }
    },
  );

  server.tool(
    "get_schema",
    "List tables and columns of the MySQL database",
    {},
    async () => {
      const [tables] = await pool.query("SELECT table_name AS `table` FROM information_schema.tables WHERE table_schema = DATABASE()");
      const schema = [];
      for (const t of tables as any[]) {
        const [columns] = await pool.query("SELECT column_name AS name, data_type AS dataType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [t.table]);
        const [constraints] = await pool.query("SELECT tc.constraint_name AS constraintName, tc.constraint_type AS constraintType, kcu.column_name AS columnName, kcu.referenced_table_name AS referencedTable, kcu.referenced_column_name AS referencedColumn, kcu.ordinal_position AS ordinalPosition FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_schema = kcu.constraint_schema AND tc.table_name = kcu.table_name AND tc.constraint_name = kcu.constraint_name WHERE tc.table_schema = DATABASE() AND tc.table_name = ? ORDER BY kcu.ordinal_position", [t.table]);
        const rows = constraints as Array<{ constraintName?: string; constraintType?: string; columnName?: string; referencedTable?: string; referencedColumn?: string }>;
        const primaryKey = rows.filter((row) => row.constraintType === "PRIMARY KEY" && row.columnName).map((row) => row.columnName);
        const uniqueGroups = new Map<string, string[]>();
        for (const row of rows) if (row.constraintType === "UNIQUE" && row.constraintName && row.columnName) uniqueGroups.set(row.constraintName, [...(uniqueGroups.get(row.constraintName) ?? []), row.columnName]);
        const foreignGroups = new Map<string, { columns: string[]; references: { table: string; columns: string[] } }>();
        for (const row of rows) if (row.constraintType === "FOREIGN KEY" && row.constraintName && row.columnName && row.referencedTable && row.referencedColumn) {
          const existing = foreignGroups.get(row.constraintName) ?? { columns: [], references: { table: row.referencedTable, columns: [] } };
          existing.columns.push(row.columnName);
          existing.references.columns.push(row.referencedColumn);
          foreignGroups.set(row.constraintName, existing);
        }
        schema.push({ table: t.table, columns, ...(primaryKey.length ? { primaryKey } : {}), ...(uniqueGroups.size ? { uniqueKeys: [...uniqueGroups.values()] } : {}), ...(foreignGroups.size ? { foreignKeys: [...foreignGroups.values()] } : {}) });
      }
      return { content: [{ type: "text", text: JSON.stringify({ schema, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
    },
  );

  async function close() {
    await pool.end();
    await new Promise<void>((resolve, reject) => {
      introspectionPool.end((error) => error ? reject(error) : resolve());
    });
  }
  return { server, close, contractVersion: DATABASE_MCP_CONTRACT_VERSION };
}

import { z } from "zod";

export async function startMysqlReferenceStdio(options?: MysqlReferenceServerOptions): Promise<void> {
  const { server, close } = await createMysqlReferenceServer(options ?? credentialsFromEnv());
  // The host stops the server by closing stdin; ending the pools closes each
  // session cleanly and lets the process exit instead of waiting to be killed.
  process.stdin.once("end", () => { void close().catch(() => undefined).finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
