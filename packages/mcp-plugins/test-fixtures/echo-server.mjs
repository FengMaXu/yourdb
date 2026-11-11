// A small MCP server for the supervisor tests: stdio when run with "stdio", or served over HTTP by the test.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function echoServer() {
  const server = new McpServer({ name: "echo", version: "1.0.0" });
  server.tool("echo", "Repeat the text", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }));
  server.tool("fail", "Always fails", {}, async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
  server.tool("env", "Read an environment variable", { name: z.string() }, async ({ name }) => ({ content: [{ type: "text", text: process.env[name] ?? "" }] }));
  return server;
}

if (process.argv[2] === "stdio") {
  const transport = new StdioServerTransport();
  await echoServer().connect(transport);
  process.stdin.on("end", () => process.exit(0));
}
