/** CLI entry: run as a stdio MCP server (used by hosts' query executors). */
import pg from "pg";
import { poolConfigFromEnv, startPgReferenceStdio } from "./index.js";

startPgReferenceStdio(new pg.Pool(poolConfigFromEnv())).catch((error) => {
  console.error("[mcp-pg] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
