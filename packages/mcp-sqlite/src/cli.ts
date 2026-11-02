/**
 * CLI entry: run as a stdio MCP server (used by hosts' query executors). The
 * file comes from the first argument or DATA_AGENT_SQLITE_DATABASE.
 */
import path from "node:path";
import { startSqliteStdio } from "./index.js";

const file = process.argv[2] || process.env.DATA_AGENT_SQLITE_DATABASE;
if (!file) {
  console.error("[mcp-sqlite] no database file: pass a path or set DATA_AGENT_SQLITE_DATABASE");
  process.exit(2);
}
startSqliteStdio({ databasePath: path.resolve(file) }).catch((error) => {
  console.error("[mcp-sqlite] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
