import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg, { type Pool, type CustomTypesConfig } from "pg";

export const DATABASE_MCP_CONTRACT_VERSION = 1;
const DEFAULT_PREVIEW_LIMIT = 20;
const MAX_PREVIEW_LIMIT = 10_000;
const MAX_EXPORT_ROWS = 100_000;

export interface PgReferenceServerOptions {
  pool: Pool;
  maxPreviewRows?: number;
}

function redact(sql: string): string {
  return sql.replace(/'[^']*'/g, "'<REDACTED>'").slice(0, 200);
}

/**
 * DATE, TIME, TIMESTAMP and TIMETZ keep the text PostgreSQL sends. The default
 * parser turns DATE into local midnight, which serialises as the previous day
 * on hosts east of UTC. TIMESTAMPTZ names an instant and keeps its default.
 */
const CALENDAR_OIDS = new Set([1082, 1083, 1114, 1266]);
const calendarTypes: CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => (CALENDAR_OIDS.has(oid) ? (value: string) => value : pg.types.getTypeParser(oid, format as "text"))) as CustomTypesConfig["getTypeParser"],
};

const FORBIDDEN = /\b(drop|truncate|delete|insert|update|alter|grant|revoke|call|replace|copy)\b/i;

/**
 * Connections the pool may open. A query waiting for a connection still spends
 * its time budget, so the pool holds as many as the host runs at once: the
 * Runtime caps child explorations at 12, and the parent and result queries come
 * on top. Cancelling a statement borrows one more. The default max_connections
 * of PostgreSQL is 100, shared by every client of the server.
 */
export const DEFAULT_PG_CONNECTIONS = 20;

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Credentials come from the environment owned by the MCP Server process. */
export function poolConfigFromEnv(): pg.PoolConfig {
  return {
    host: process.env.DATA_AGENT_PG_HOST ?? "127.0.0.1",
    port: Number(process.env.DATA_AGENT_PG_PORT ?? 5432),
    user: process.env.DATA_AGENT_PG_USER ?? "postgres",
    password: process.env.DATA_AGENT_PG_PASSWORD,
    database: process.env.DATA_AGENT_PG_DATABASE,
    max: positiveInteger(process.env.DATA_AGENT_PG_CONNECTIONS) ?? DEFAULT_PG_CONNECTIONS,
    connectionTimeoutMillis: 10_000,
  };
}

/** SQLSTATE 57014 query_canceled: statement_timeout passed or the statement was cancelled. */
function isQueryCanceled(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === "57014";
}

const timeoutPayload = (timeoutMs: number | undefined) => ({ error: { code: "QUERY_TIMEOUT", message: `statement stopped by PostgreSQL after ${timeoutMs ?? 0} ms (statement_timeout)` } });

export async function createPgReferenceServer(options: PgReferenceServerOptions) {
  const pool = options.pool;
  const maxPreviewRows = Math.min(options.maxPreviewRows ?? MAX_PREVIEW_LIMIT, MAX_PREVIEW_LIMIT);

  // An idle pooled session can fail (server restart, idle timeout); without a
  // listener the pool's error event would end the process.
  pool.on("error", (error) => console.error("[mcp-pg] idle connection error:", error.message));

  /**
   * Cancels a statement from its own session outside the pool: a saturated
   * pool would queue the cancel behind the work it is meant to stop.
   */
  const cancelStatement = async (processId: number): Promise<void> => {
    const canceller = new pg.Client((pool as unknown as { options: pg.ClientConfig }).options);
    try {
      await canceller.connect();
      await canceller.query("SELECT pg_cancel_backend($1)", [processId]);
    } finally {
      await canceller.end().catch(() => undefined);
    }
  };
  const cancelled = () => Object.assign(new Error("QUERY_CANCELLED"), { code: "57014" });

  /**
   * Runs one statement in a read-only transaction. PostgreSQL enforces the
   * statement's own time limit, and a cancelled MCP call cancels the statement
   * on the server; a closed client alone would leave it running.
   */
  const runBounded = async (text: string, timeoutMs: number | undefined, signal: AbortSignal | undefined) => {
    if (signal?.aborted) throw cancelled();
    const client = await pool.connect();
    const processId = (client as unknown as { processID?: number }).processID;
    let cancelling: Promise<void> | undefined;
    const cancel = () => { if (processId !== undefined) cancelling = cancelStatement(processId).catch(() => undefined); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      // The call may have been cancelled while it waited for a connection.
      if (signal?.aborted) throw cancelled();
      await client.query("BEGIN READ ONLY");
      if (timeoutMs) await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      const result = await client.query({ text, types: calendarTypes });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      // A cancel can land after the statement ended. The session is discarded,
      // never reused, so it cannot stop another call's statement.
      await cancelling;
      client.release(cancelling ? true : undefined);
    }
  };
  const failure = (error: unknown, trimmed: string, timeoutMs: number | undefined, signal: AbortSignal | undefined) => {
    if (isQueryCanceled(error)) return signal?.aborted ? { error: { code: "QUERY_CANCELLED" } } : timeoutPayload(timeoutMs);
    return { error: { code: "QUERY_FAILED", message: redact(`${(error as Error).message} in ${redact(trimmed)}`).slice(0, 500) } };
  };

  const server = new McpServer({ name: "data-agent-pg-reference", version: "1.0.0" });

  server.tool(
    "execute_query_preview",
    "Run a read-only PostgreSQL query and return a bounded preview",
    {
      sql: z.string().min(1),
      limit: z.number().int().positive().max(MAX_PREVIEW_LIMIT).optional(),
      maxBytes: z.number().int().positive().max(64 * 1024).optional(),
      /** Statement time limit in ms, enforced by PostgreSQL. */
      timeoutMs: z.number().int().positive().optional(),
    },
    async ({ sql, limit, maxBytes, timeoutMs }, extra) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      }
      const effectiveLimit = Math.min(limit ?? DEFAULT_PREVIEW_LIMIT, maxPreviewRows);
      try {
        const result = await runBounded(`SELECT * FROM (${trimmed}) __preview LIMIT ${effectiveLimit + 1}`, timeoutMs, extra.signal);
        const columns = result.fields.map((field) => field.name);
        let rows = result.rows.slice(0, effectiveLimit);
        let truncated = result.rows.length > effectiveLimit;
        if (maxBytes !== undefined) {
          while (rows.length > 0 && Buffer.byteLength(JSON.stringify({ rows, columns }), "utf8") > maxBytes) {
            rows = rows.slice(0, -1);
            truncated = true;
          }
          if (Buffer.byteLength(JSON.stringify({ rows, columns }), "utf8") > maxBytes) throw new Error("QUERY_PREVIEW_BYTES_EXCEEDED");
        }
        return { content: [{ type: "text", text: JSON.stringify({ rows, columns, totalRows: result.rows.length, truncated, serverLimit: maxPreviewRows, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(failure(error, trimmed, timeoutMs, extra.signal)) }] };
      }
    },
  );

  server.tool(
    "explain_query",
    "Compile a read-only PostgreSQL query and return its EXPLAIN plan",
    { sql: z.string().min(1) },
    async ({ sql }, extra) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      try {
        // EXPLAIN ANALYZE executes the statement; the read-only transaction keeps it from writing.
        const result = await runBounded(`EXPLAIN ${trimmed}`, undefined, extra.signal);
        const columns = result.fields.map((field) => field.name);
        return { content: [{ type: "text", text: JSON.stringify({ columns, rows: result.rows, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPLAIN_FAILED", message: redact(String((error as Error).message)).slice(0, 300) } }) }] };
      }
    },
  );

  server.tool(
    "execute_query_export",
    "Run one complete bounded read-only PostgreSQL result query",
    {
      sql: z.string().min(1),
      maxRows: z.number().int().positive().max(MAX_EXPORT_ROWS).optional(),
      /** Statement time limit in ms, enforced by PostgreSQL. */
      timeoutMs: z.number().int().positive().optional(),
    },
    async ({ sql, maxRows: requestedMaxRows, timeoutMs }, extra) => {
      const trimmed = sql.trim().replace(/;+\s*$/, "");
      if (FORBIDDEN.test(trimmed)) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "FORBIDDEN_SQL" } }) }] };
      const rowLimit = Math.min(requestedMaxRows ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
      try {
        const result = await runBounded(`SELECT * FROM (${trimmed}) __result LIMIT ${rowLimit + 1}`, timeoutMs, extra.signal);
        if (result.rows.length > rowLimit) return { content: [{ type: "text", text: JSON.stringify({ error: { code: "EXPORT_ROW_LIMIT_EXCEEDED", rowLimit } }) }] };
        const columns = result.fields.map((field) => field.name);
        return { content: [{ type: "text", text: JSON.stringify({ rows: result.rows, columns, truncated: false, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
      } catch (error) {
        return { content: [{ type: "text", text: JSON.stringify(failure(error, trimmed, timeoutMs, extra.signal)) }] };
      }
    },
  );

  server.tool(
    "get_schema",
    "List tables and columns of the PostgreSQL database",
    {},
    async () => {
      const tables = await pool.query("SELECT table_name AS \"table\" FROM information_schema.tables WHERE table_schema='public'");
      const schema = [];
      for (const t of tables.rows as any[]) {
        const columns = await pool.query("SELECT column_name AS name, data_type AS \"dataType\" FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t.table]);
        const constraints = await pool.query("SELECT tc.constraint_name AS \"constraintName\", tc.constraint_type AS \"constraintType\", kcu.column_name AS \"columnName\", ccu.table_name AS \"referencedTable\", ccu.column_name AS \"referencedColumn\", kcu.ordinal_position AS \"ordinalPosition\" FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_schema=kcu.constraint_schema AND tc.table_schema=kcu.table_schema AND tc.table_name=kcu.table_name AND tc.constraint_name=kcu.constraint_name LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_schema=ccu.constraint_schema AND tc.constraint_name=ccu.constraint_name WHERE tc.constraint_schema='public' AND tc.table_name=$1 ORDER BY kcu.constraint_name, kcu.ordinal_position", [t.table]);
        const rows = constraints.rows as Array<{ constraintName?: string; constraintType?: string; columnName?: string; referencedTable?: string; referencedColumn?: string }>;
        const primaryKey = rows.filter((row) => row.constraintType === "PRIMARY KEY" && row.columnName).map((row) => row.columnName!);
        const uniqueGroups = new Map<string, string[]>();
        for (const row of rows) if (row.constraintType === "UNIQUE" && row.constraintName && row.columnName) uniqueGroups.set(row.constraintName, [...(uniqueGroups.get(row.constraintName) ?? []), row.columnName]);
        const foreignGroups = new Map<string, { columns: string[]; references: { table: string; columns: string[] } }>();
        for (const row of rows) if (row.constraintType === "FOREIGN KEY" && row.constraintName && row.columnName && row.referencedTable && row.referencedColumn) {
          const existing = foreignGroups.get(row.constraintName) ?? { columns: [], references: { table: row.referencedTable, columns: [] } };
          existing.columns.push(row.columnName);
          existing.references.columns.push(row.referencedColumn);
          foreignGroups.set(row.constraintName, existing);
        }
        schema.push({ table: t.table, columns: columns.rows, ...(primaryKey.length ? { primaryKey } : {}), ...(uniqueGroups.size ? { uniqueKeys: [...uniqueGroups.values()] } : {}), ...(foreignGroups.size ? { foreignKeys: [...foreignGroups.values()] } : {}) });
      }
      return { content: [{ type: "text", text: JSON.stringify({ schema, contractVersion: DATABASE_MCP_CONTRACT_VERSION }) }] };
    },
  );

  async function close() { await pool.end(); }
  return { server, close, contractVersion: DATABASE_MCP_CONTRACT_VERSION };
}

export async function startPgReferenceStdio(pool: Pool): Promise<void> {
  const { server, close } = await createPgReferenceServer({ pool });
  // The host stops the server by closing stdin; ending the pool closes each
  // session cleanly and lets the process exit instead of waiting to be killed.
  process.stdin.once("end", () => { void close().catch(() => undefined).finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
