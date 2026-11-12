#!/usr/bin/env node
/** Production launcher for the Fastify Web Host. */
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const toUrl = (value) => { const normalized = value.split(path.sep).join("/"); return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`; };
const dataDir = process.env.DATA_AGENT_DATA_DIR
  ? path.resolve(process.env.DATA_AGENT_DATA_DIR)
  : path.join(root, ".data_agent", "runtime-web");
// The repository knowledge/ is the single source of truth; a per-data-dir copy silently drifts out of date.
const knowledgeRoot = process.env.DATA_AGENT_KNOWLEDGE_DIR
  ? path.resolve(process.env.DATA_AGENT_KNOWLEDGE_DIR)
  : path.join(root, "knowledge");
const packagedRoot = process.resourcesPath ?? root;
const skillRoots = [path.join(root, ".agents", "skills"), path.join(packagedRoot, ".agents", "skills")];
const builtinKnowledgeRoots = [path.join(root, ".agents", "knowledge"), path.join(packagedRoot, ".agents", "knowledge")];
const pythonExecutable = process.env.DATA_AGENT_PYTHON
  ?? [path.join(root, "dist", "python-runtime", "python.exe"), path.join(root, "dist", "python-runtime", "Scripts", "python.exe")].find((candidate) => existsSync(candidate));

const { createDataAgentApplication } = await import(toUrl(path.join(root, "packages/runtime/dist/index.js")));
const { createRuntimeServer } = await import(toUrl(path.join(root, "apps/server/dist/index.js")));
const { createConfiguredQueryExecutor } = await import(toUrl(path.join(root, "packages/database/dist/index.js")));
const { createHostTesters } = await import(toUrl(path.join(root, "apps/server/dist/host-testers.js")));
const { createMcpPluginSupervisor, databaseHostServer } = await import(toUrl(path.join(root, "packages/mcp-plugins/dist/index.js")));

const databaseServers = {
  mysql: { command: process.execPath, args: [path.join(root, "packages", "mcp-mysql", "dist", "cli.js")] },
  postgres: { command: process.execPath, args: [path.join(root, "packages", "mcp-pg", "dist", "cli.js")] },
  sqlite: { command: process.execPath, args: [path.join(root, "packages", "mcp-sqlite", "dist", "cli.js")] },
};

let application;
const queryExecutor = createConfiguredQueryExecutor({
  readSettings: () => application.getConfig("ui.settings"),
  servers: databaseServers,
});
const resolveQueryExecutor = () => queryExecutor.resolve();

application = await createDataAgentApplication({
  dataRoot: dataDir,
  host: "web",
  knowledgeRoot,
  builtinKnowledgeRoots,
  pythonExecutable,
  queryExecutor: resolveQueryExecutor,
  ...(process.env.TYPESAFE_API_KEY?.trim() ? {
    jevHypothesisComparison: {
      apiKey: process.env.TYPESAFE_API_KEY.trim(),
      model: process.env.TYPESAFE_MODEL?.trim() || "jev-1.13.0",
      ...(process.env.TYPESAFE_ENDPOINT?.trim() ? { endpoint: process.env.TYPESAFE_ENDPOINT.trim() } : {}),
    },
  } : {}),
  // Enable bounded reviewer and authorized knowledge exploration. SQL exploration
  // remains unavailable until the host supplies a database-enforced scoped executor.
  enableSubagents: true,
  delegationKnowledgePaths: ["doc/business.md", "doc/db_schema.md", "doc/query_patterns.md", "doc/learning.md", "doc/rules.md", "doc/semantic_guide.md"],
  resolveProfile: async (_context, app) => {
    const saved = (await app.getConfig("ui.settings")) ?? {};
    const config = saved && typeof saved === "object" ? saved : {};
    const profile = {
      provider: String(config.provider ?? "openai"),
      model: String(config.model ?? ""),
      apiKey: String(config.api_key ?? config.openai_api_key ?? config.anthropic_api_key ?? ""),
      ...(config.base_url ? { baseUrl: String(config.base_url) } : {}),
      apiFormat: config.api_format === "chat" || config.apiFormat === "chat" ? "chat" : "responses",
    };
    if (config.llm_enabled === false || !profile.apiKey || !profile.model) throw new Error("LLM_NOT_CONFIGURED: add a model API key in Settings → Model");
    return profile;
  },
  // The system prompt ships with the repository; the knowledge folder never supplies one.
  systemPromptRoots: [root],
  projectRoot: root,
  packagedRoot,
  skillRoots,
});
application.setHostTesters(createHostTesters({ databaseServers }));
application.setMcpPlugins(createMcpPluginSupervisor({
  readConfig: () => application.getConfig("mcp.config"),
  writeConfig: (config) => application.setConfig("mcp.config", config),
  hostServers: [databaseHostServer(() => queryExecutor.check())],
}));
resolveQueryExecutor().catch((error) => console.warn("[data-agent-web] mcp query executor unavailable:", error.message));

const app = await createRuntimeServer(application, {
  workspace: application.workspace,
  publicationReader: application,
  authorizeSession: async (userId, sessionId) => (await application.authorizeSession(userId, sessionId)) === "owned",
});

const webDist = process.env.DATA_AGENT_WEB_DIST ? path.resolve(process.env.DATA_AGENT_WEB_DIST) : path.join(root, "frontend", "dist");
app.get("/app/", async (_request, reply) => reply.redirect("/app"));
if (existsSync(path.join(webDist, "index.html"))) {
  const fastifyStatic = await import("@fastify/static").then((module) => module.default).catch(() => null);
  if (fastifyStatic) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.method !== "GET") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      return reply.sendFile("index.html");
    });
  } else console.warn("[data-agent-web] @fastify/static not installed; renderer not served");
}

const port = Number(process.env.DATA_AGENT_PORT ?? 8787);
const host = process.env.DATA_AGENT_HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`[data-agent-web] listening on http://${host}:${port}`);
console.log(`[data-agent-web] data dir: ${dataDir}`);
console.log(`[data-agent-web] knowledge dir: ${knowledgeRoot} (${application.knowledge.catalog().length} documents)`);

// Channels (ADR-0011). The settings page connects one by scanning a QR code; FEISHU_APP_ID and
// FEISHU_APP_SECRET still work as a fallback when nothing has been saved. Results reach a group only
// when its chat id is listed in FEISHU_GROUP_DELIVERY_CHATS; otherwise they go to the asker privately.
const { feishuProvider } = await import(toUrl(path.join(root, "packages/channel-feishu/dist/index.js")));
const { weixinProvider } = await import(toUrl(path.join(root, "packages/channel-weixin/dist/index.js")));
const { createDashboardSnapshotter } = await import(toUrl(path.join(root, "packages/runtime/dist/index.js")));
const groupChats = new Set((process.env.FEISHU_GROUP_DELIVERY_CHATS ?? "").split(",").map((chatId) => chatId.trim()).filter(Boolean));
// A chat's next message after this much quiet starts a new conversation; "/new" starts one at any time.
const idleMinutes = Number(process.env.DATA_AGENT_CHANNEL_IDLE_MINUTES ?? 120);
const feishuAppId = process.env.FEISHU_APP_ID?.trim();
const feishuAppSecret = process.env.FEISHU_APP_SECRET?.trim();
// Scan-to-connect retries switching a new bot to the long connection; each refusal Feishu gives is logged here.
const channels = await application.enableChannels([
  feishuProvider({ onError: (error) => console.error("[data-agent-web] feishu:", error instanceof Error ? error.message : error) }),
  // Personal WeChat through ClawBot: private chats only, connected by scanning in the settings page.
  weixinProvider({ onError: (error) => console.error("[data-agent-web] weixin:", error instanceof Error ? error.message : error) }),
], {
  allowGroupDelivery: (address) => groupChats.has(address.chatId),
  // Dashboards reach phones as a picture; it needs Edge or Chrome on this host, and without one only the page is sent.
  snapshot: createDashboardSnapshotter(),
  ...(idleMinutes > 0 ? { idleSessionMs: idleMinutes * 60_000 } : {}),
  fallback: {
    feishu: feishuAppId && feishuAppSecret ? { appId: feishuAppId, appSecret: feishuAppSecret, ...(process.env.FEISHU_DOMAIN === "lark" ? { domain: "https://open.larksuite.com" } : {}) } : undefined,
  },
});
for (const channel of channels.list()) console.log(`[data-agent-web] channel ${channel.id}: ${channel.state}${channel.message ? ` (${channel.message})` : ""}`);
