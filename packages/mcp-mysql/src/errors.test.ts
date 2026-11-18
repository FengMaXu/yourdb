import { describe, expect, it } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMysqlReferenceServer, describeError } from "./index.js";

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("failure causes", () => {
  it("names the cause of an AggregateError whose own message is empty", () => {
    const refused = (address: string) => Object.assign(new Error(`connect ECONNREFUSED ${address}:3306`), { code: "ECONNREFUSED" });
    const error = Object.assign(new AggregateError([refused("::1"), refused("127.0.0.1")], ""), { code: "ECONNREFUSED" });
    expect(describeError(error)).toBe("connect ECONNREFUSED ::1:3306; connect ECONNREFUSED 127.0.0.1:3306");
    expect(describeError(Object.assign(new Error(""), { code: "ETIMEDOUT" }))).toBe("ETIMEDOUT");
    expect(describeError("plain")).toBe("plain");
  });

  it("says the connection was refused when no MySQL listens, for queries and schema alike", async () => {
    const port = await closedPort();
    // localhost resolves to both ::1 and 127.0.0.1 on most hosts, which is how the empty AggregateError arises.
    const { server, close } = await createMysqlReferenceServer({ host: "localhost", port, user: "u", password: "p", database: "d" });
    const client = new Client({ name: "data-agent-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const query = await client.callTool({ name: "execute_query_preview", arguments: { sql: "SELECT 1", limit: 1 } }) as { content: Array<{ text: string }> };
      const payload = JSON.parse(query.content[0]!.text) as { error: { code: string; message: string } };
      expect(payload.error.code).toBe("QUERY_FAILED");
      expect(payload.error.message).toMatch(/ECONNREFUSED/);

      const schema = await client.callTool({ name: "get_schema", arguments: {} }) as { isError?: boolean; content: Array<{ text: string }> };
      expect(schema.isError).toBe(true);
      expect(schema.content[0]!.text).toMatch(/SCHEMA_FAILED: .*ECONNREFUSED/);
    } finally {
      await client.close();
      await close();
    }
  });
});
