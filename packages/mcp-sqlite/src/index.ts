import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export const DATABASE_MCP_CONTRACT_VERSION = 1;
const DEFAULT_PREVIEW_LIMIT = 20;
const MAX_PREVIEW_LIMIT = 10_000;
const FORBIDDEN_SQL = /\b(drop|truncate|delete|insert|update|alter|grant|revoke|call|replace|attach|detach|vacuum|pragma)\b/i;

function readonlySql(sql: string): { allowed: true } | { allowed: false; reason: string } {
  if (FORBIDDEN_SQL.test(sql)) return { allowed: false, reason: "Statement contains a high-risk SQL operation" };
  if (sql.includes(";")) return { allowed: false, reason: "Multiple SQL statements are not supported" };
  return { allowed: true };
}
export interface SqliteServerOptions { databasePath: string; maxPreviewRows?: number }

function forbiddenSql(reason: string) {
  const message = `${reason}. Only read-only SELECT/WITH queries are supported; rewrite the request without write operations or multiple statements.`;
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "FORBIDDEN_SQL", message } }) }] };
}

/**
 * Cells as the server has always returned them: integers as JavaScript numbers
 * (precision past 2^53 is lost, as before) and BLOBs as Buffers. node:sqlite
 * would otherwise throw on out-of-range integers and return Uint8Arrays.
 */
function cell(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value);
  return value;
}

function rowsOf(rows: Iterable<unknown>): Iterable<Record<string, unknown>> {
  return (function* () {
    for (const row of rows) yield Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, cell(value)]));
  })();
}

function readStatement(db: DatabaseSync, sql: string): StatementSync {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

/**
 * The database contract MCP server for one SQLite file. The file is opened
 * read-only, so no statement can change it whatever passes the SQL guard.
 */
export function createSqliteServer(options: SqliteServerOptions) {
  const db = new DatabaseSync(options.databasePath, { readOnly: true });
  const maxRows = Math.min(options.maxPreviewRows ?? MAX_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);

  const server = new McpServer(
    { name: "data-agent-sqlite", version: "1.0.0" },
    { capabilities: { resources: {} } },
  );

  const previewShape = {
    sql: z.string().min(1),
    limit: z.number().int().positive().max(MAX_PREVIEW_LIMIT).optional(),
    maxBytes: z.number().int().positive().max(64 * 1024).optional(),
  };
  server.tool(
    "execute_query_preview",
    "Run a read-only SQLite query and return a bounded preview",
    previewShape,
    async ({ sql, limit, maxBytes }, extra) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      const guard = readonlySql(trimmed);
      if (!guard.allowed) return forbiddenSql(guard.reason);
      if (!/^(?:SELECT|WITH)\b/i.test(trimmed)) return forbiddenSql("Only SELECT/WITH statements are supported");
      if (extra.signal?.aborted) return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "QUERY_CANCELLED" } }) }] };
      const effectiveLimit = Math.min(limit ?? DEFAULT_PREVIEW_LIMIT, maxRows);
      const statement = readStatement(db, `SELECT * FROM (${trimmed}) __preview LIMIT ?`);
      const columns: string[] = statement.columns().map((column: { name: string }) => column.name);
      const rows: any[] = [];
      let truncated = false;
      const byteLimit = maxBytes === undefined ? undefined : Math.max(1_024, maxBytes - 512);
      for (const row of rowsOf(statement.iterate(effectiveLimit + 1))) {
        if (extra.signal?.aborted) return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code: "QUERY_CANCELLED" } }) }] };
        const candidate = [...rows, row];
        if (candidate.length > effectiveLimit || (byteLimit !== undefined && Buffer.byteLength(JSON.stringify({ columns, rows: candidate }), "utf8") > byteLimit)) {
          truncated = true;
          break;
        }
        rows.push(row);
      }
      return { content: [{ type: "text", text: JSON.stringify({ columns, rows, totalRows: rows.length + (truncated ? 1 : 0), truncated, serverLimit: maxRows, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
    },
  );

  server.tool(
    "execute_query_export",
    "Run one complete bounded read-only SQLite result query",
    { sql: z.string().min(1), maxRows: z.number().int().positive().max(100000).optional() },
    async ({ sql, maxRows: requestedMaxRows }) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      const guard = readonlySql(trimmed);
      if (!guard.allowed) return forbiddenSql(guard.reason);
      if (!/^(?:SELECT|WITH)\b/i.test(trimmed)) return forbiddenSql("Only SELECT/WITH statements are supported");
      const rowLimit = Math.min(requestedMaxRows ?? 100000, 100000);
      const statement = readStatement(db, `SELECT * FROM (${trimmed}) __result LIMIT ?`);
      const columns: string[] = statement.columns().map((column: { name: string }) => column.name);
      const rows = [...rowsOf(statement.all(rowLimit + 1))];
      if (rows.length > rowLimit) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPORT_ROW_LIMIT_EXCEEDED", rowLimit } }) }] };
      return { content: [{ type: "text", text: JSON.stringify({ rows, columns, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
    },
  );

  server.tool(
    "explain_query",
    "Compile a read-only SQLite query and return its EXPLAIN QUERY PLAN",
    { sql: z.string().min(1) },
    async ({ sql }) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      const guard = readonlySql(trimmed);
      if (!guard.allowed) return forbiddenSql(guard.reason);
      try {
        const statement = readStatement(db, `EXPLAIN QUERY PLAN ${trimmed}`);
        const columns: string[] = statement.columns().map((column: { name: string }) => column.name);
        const rows = [...rowsOf(statement.all())];
        return { content: [{ type: "text", text: JSON.stringify({ columns, rows, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPLAIN_FAILED", message: String((error as Error).message).slice(0, 300) } }) }] };
      }
    },
  );

  server.tool(
    "get_schema",
    "List tables and columns of the SQLite database",
    {},
    async () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const schema = tables.map((t: any) => {
        const quoted = JSON.stringify(t.name).slice(1, -1);
        const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string; type?: string; pk?: number }>;
        const primaryKey = columns.filter((column) => Number(column.pk) > 0).sort((left, right) => Number(left.pk) - Number(right.pk)).map((column) => column.name);
        const indexes = db.prepare(`PRAGMA index_list(${quoted})`).all() as Array<{ name: string; unique?: number }>;
        const uniqueKeys = indexes.filter((index) => Number(index.unique) === 1).flatMap((index) => {
          const entries = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name).slice(1, -1)})`).all() as Array<{ name?: string; seqno?: number }>;
          return [entries.sort((left, right) => Number(left.seqno) - Number(right.seqno)).flatMap((entry) => entry.name ? [entry.name] : [])];
        }).filter((key) => key.length > 0);
        const foreignRows = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{ id?: number; seq?: number; from?: string; table?: string; to?: string }>;
        const foreignKeys = [...new Set(foreignRows.map((row) => row.id).filter((id): id is number => id !== undefined))].flatMap((id) => {
          const rows = foreignRows.filter((row) => row.id === id).sort((left, right) => Number(left.seq) - Number(right.seq));
          const first = rows[0];
          if (!first?.table) return [];
          return [{ columns: rows.flatMap((row) => row.from ? [row.from] : []), references: { table: first.table, columns: rows.flatMap((row) => row.to ? [row.to] : []) } }];
        });
        return { table: t.name, columns, ...(primaryKey.length ? { primaryKey } : {}), ...(uniqueKeys.length ? { uniqueKeys } : {}), ...(foreignKeys.length ? { foreignKeys } : {}) };
      });
      return { content: [{ type: "text", text: JSON.stringify({ schema, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
    },
  );

  // Publication remains an Answering operation; this tool only returns the
  // complete bounded rows needed to seal one immutable Result Candidate.
  return { server, db, close: () => db.close(), contractVersion: DATABASE_MCP_CONTRACT_VERSION, maxRows };
}

export async function startSqliteStdio(options: SqliteServerOptions): Promise<void> {
  const { server } = createSqliteServer(options);
  await server.connect(new StdioServerTransport());
}
