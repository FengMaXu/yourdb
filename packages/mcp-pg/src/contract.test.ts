import { describe, expect, it, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPgReferenceServer } from "./index.js";

const db = new PGlite();
const serverSocket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0 });

afterAll(async () => {
  await serverSocket.stop();
  await db.close();
});

describe("PostgreSQL Reference MCP Server contract", () => {
  it("previews bounded rows, blocks dangerous SQL, and reports schema over the PG wire protocol", async () => {
      await serverSocket.start();
    const port = Number(serverSocket.getServerConn().split(":")[1]);
    await db.exec("CREATE TABLE contract_sales (id INT PRIMARY KEY, region TEXT, amount NUMERIC); INSERT INTO contract_sales VALUES (1,'north',10),(2,'south',20);");

    const { Pool, Client: PgClient } = await import("pg");
    const pool = new Pool({ host: "127.0.0.1", port, user: "postgres", database: "postgres", connectionTimeoutMillis: 5000 });
    await pool.query("SELECT 1");

    const { server, close } = await createPgReferenceServer({ pool });
    const client = new Client({ name: "data-agent-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const preview = await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT * FROM contract_sales", limit: 1 } });
    const payload = JSON.parse((preview.content as any)[0].text);
    expect(payload.rows).toHaveLength(1);
    expect(payload.truncated).toBe(true);
    expect(payload.contractVersion).toBe(1);
    expect(payload.columns).toEqual(["id", "region", "amount"]);

    // Result and preview statements run on a pooled client inside a read-only transaction.
    const querySpy = vi.spyOn(PgClient.prototype, "query");
    const exportResult = await client.callTool({ name: "execute_query_export", arguments: { sql: "SELECT * FROM contract_sales ORDER BY id" } });
    const exportPayload = JSON.parse((exportResult.content as any)[0].text);
    expect(exportPayload.columns).toEqual(["id", "region", "amount"]);
    expect(exportPayload.rows).toHaveLength(2);
    expect(exportPayload.truncated).toBe(false);
    const queryText = (query: unknown) => (typeof query === "string" ? query : (query as { text?: string }).text ?? "");
    expect(querySpy.mock.calls.filter(([query]) => queryText(query).includes("__result"))).toHaveLength(1);

    const dangerous = await client.callTool({ name: "execute_query_preview", arguments: { sql: "DELETE FROM contract_sales" } });
    expect(JSON.parse((dangerous.content as any)[0].text).error.code).toBe("FORBIDDEN_SQL");

    const schema = await client.callTool({ name: "get_schema", arguments: {} });
    const schemaPayload = JSON.parse((schema.content as any)[0].text);
    expect(schemaPayload.schema[0].table).toBe("contract_sales");
    expect(schemaPayload.schema[0].primaryKey).toEqual(["id"]);

    // Calendar values keep the text PostgreSQL sends; a parsed DATE would serialise as the previous day east of UTC.
    const calendarSql = "SELECT DATE '2025-12-01' AS d, TIMESTAMP '2025-12-01 08:30:00' AS ts, TIME '08:30:00' AS t";
    for (const name of ["execute_query_preview", "execute_query_export"]) {
      const calendar = await client.callTool({ name, arguments: { sql: calendarSql } });
      expect(JSON.parse((calendar.content as any)[0].text).rows[0]).toEqual({ d: "2025-12-01", ts: "2025-12-01 08:30:00", t: "08:30:00" });
    }

    // The read-only transaction is enforced by PostgreSQL, past what the keyword filter sees.
    await db.exec("CREATE SEQUENCE contract_seq");
    const write = await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT nextval('contract_seq') AS n" } });
    const writePayload = JSON.parse((write.content as any)[0].text);
    expect(writePayload.error.code).toBe("QUERY_FAILED");
    expect(writePayload.error.message).toMatch(/read-only transaction/);

    // The statement time limit reaches PostgreSQL as statement_timeout for that statement only.
    querySpy.mockClear();
    await client.callTool({ name: "execute_query_export", arguments: { sql: "SELECT 1 AS n", timeoutMs: 1234 } });
    expect(querySpy.mock.calls.map(([query]) => queryText(query))).toContain("SET LOCAL statement_timeout = 1234");

    await client.close();
    await close();
  }, 30000);
});
