import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSqliteServer } from "./index.js";
import { DatabaseSync } from "node:sqlite";

describe("SQLite MCP server", () => {
  it("negotiates the contract, enforces limits, and blocks dangerous SQL", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-mcp-sqlite-"));
    const dbPath = join(root, "ref.sqlite3");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, amount REAL)");
    seed.prepare("INSERT INTO sales (region, amount) VALUES (?, ?)").run("north", 10);
    seed.prepare("INSERT INTO sales (region, amount) VALUES (?, ?)").run("south", 20);
    seed.close();

    const { server, close } = createSqliteServer({ databasePath: dbPath });
    const client = new Client({ name: "data-agent-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const preview = await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT * FROM sales", limit: 1 } });
    const payload = JSON.parse((preview.content as any)[0].text);
    expect(payload.rows).toHaveLength(1);
    expect(payload.truncated).toBe(true);
    expect(payload.contractVersion).toBe(1);

    const exportResult = await client.callTool({ name: "execute_query_export", arguments: { sql: "SELECT * FROM sales ORDER BY id" } });
    const exportPayload = JSON.parse((exportResult.content as any)[0].text);
    expect(exportPayload.rows).toHaveLength(2);
    expect(exportPayload.columns).toEqual(["id", "region", "amount"]);
    expect(exportPayload.truncated).toBe(false);

    const explain = await client.callTool({ name: "explain_query", arguments: { sql: "SELECT * FROM sales WHERE amount > 10" } });
    const explainPayload = JSON.parse((explain.content as any)[0].text);
    expect(explainPayload.columns).toContain("detail");
    expect(explainPayload.rows.length).toBeGreaterThan(0);

    const dangerous = await client.callTool({ name: "execute_query_preview", arguments: { sql: "DROP TABLE sales" } });
    const dangerousPayload = JSON.parse((dangerous.content as any)[0].text);
    expect(dangerousPayload.error.code).toBe("FORBIDDEN_SQL");
    expect(dangerousPayload.error.message).toContain("high-risk");
    const pragma = await client.callTool({ name: "execute_query_preview", arguments: { sql: "PRAGMA user_version" } });
    expect(JSON.parse((pragma.content as any)[0].text).error.code).toBe("FORBIDDEN_SQL");

    // The byte limit truncates exactly where serializing the whole preview would.
    const sized = JSON.parse(((await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT * FROM sales ORDER BY id", limit: 10, maxBytes: 1_536 } })).content as any)[0].text);
    expect(sized.rows).toHaveLength(2);
    expect(sized.truncated).toBe(false);

    const union = await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT region FROM sales UNION ALL SELECT region FROM sales" } });
    expect(JSON.parse((union.content as any)[0].text).rows).toHaveLength(4);

    const schema = await client.callTool({ name: "get_schema", arguments: {} });
    const schemaPayload = JSON.parse((schema.content as any)[0].text);
    expect(schemaPayload.schema[0].table).toBe("sales");
    expect(schemaPayload.schema[0].columns[0].name).toBe("id");
    expect(schemaPayload.schema[0].primaryKey).toEqual(["id"]);

    const listedTools = await client.listTools();
    expect(listedTools.tools.some((tool) => tool.name === "export_query")).toBe(false);
    const forbiddenExport = await client.callTool({ name: "export_query", arguments: { sql: "SELECT * FROM sales" } });
    expect(forbiddenExport.isError).toBe(true);
    expect((forbiddenExport.content as any)[0].text).toContain("Tool export_query not found");

    await client.close();
    await close();
    await rm(root, { recursive: true, force: true });
  });

  it("describes tables whose names are not bare identifiers, and only SQLite's own tables are hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-mcp-sqlite-"));
    const dbPath = join(root, "ref.sqlite3");
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE "Db-IMDB__Movie" (id INTEGER PRIMARY KEY, title TEXT UNIQUE);
      CREATE TABLE "it's" (movie_id INTEGER REFERENCES "Db-IMDB__Movie"(id));
      CREATE TABLE "sqlite-sakila__actor" (actor_id INTEGER);
      CREATE VIEW titles AS SELECT title FROM "Db-IMDB__Movie";
      ANALYZE;`);
    seed.close();

    const { server, close } = createSqliteServer({ databasePath: dbPath });
    const client = new Client({ name: "data-agent-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const schema = JSON.parse(((await client.callTool({ name: "get_schema", arguments: {} })).content as any)[0].text).schema;
    expect(schema).toEqual([
      { table: "Db-IMDB__Movie", columns: expect.any(Array), primaryKey: ["id"], uniqueKeys: [["title"]] },
      { table: "it's", columns: expect.any(Array), foreignKeys: [{ columns: ["movie_id"], references: { table: "Db-IMDB__Movie", columns: ["id"] } }] },
      { table: "sqlite-sakila__actor", columns: expect.any(Array) },
      { table: "titles", columns: [expect.objectContaining({ name: "title" })] },
    ]);
    await client.close();
    close();
    await rm(root, { recursive: true, force: true });
  });

  it("opens the file read-only and never creates a missing one", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-mcp-sqlite-"));
    const dbPath = join(root, "ref.sqlite3");
    const seed = new DatabaseSync(dbPath);
    seed.exec("CREATE TABLE sales (id INTEGER PRIMARY KEY)");
    seed.close();

    const { db, close } = createSqliteServer({ databasePath: dbPath });
    expect(() => db.exec("INSERT INTO sales (id) VALUES (1)")).toThrow(/readonly/);
    close();

    const missing = join(root, "missing.sqlite");
    expect(() => createSqliteServer({ databasePath: missing })).toThrow();
    expect(existsSync(missing)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
