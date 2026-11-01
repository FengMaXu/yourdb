#!/usr/bin/env node
/**
 * Fixed data for the visual regression snapshots (frontend migration plan, PR 0.1).
 *
 * `evaluations/visual/fixture-data/fixture.json` describes one account, its settings and
 * MCP plugins, and a few sessions holding finished answers. This script builds that into a
 * fresh data dir through the real Application and its HTTP commands, then pins every stored
 * timestamp to the fixture's values, so each build renders the same pages. Nothing calls a
 * model or a database: the sessions only hold completed messages.
 *
 *   node scripts/visual-fixture.mjs                 build into a temp dir and start the Web Host on it
 *   node scripts/visual-fixture.mjs --build <dir>   only build the data dir (knowledge goes to <dir>/knowledge-root)
 *
 * The Web Host serves frontend/dist (build it first) on DATA_AGENT_PORT, default 8790.
 * Needs the built packages (npm run build).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "evaluations", "visual", "fixture-data", "fixture.json");
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

export async function readFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

/** Build the fixture into `dataDir`; knowledge goes to `<dataDir>/knowledge-root`. Returns the paths and credentials. */
export async function buildVisualFixture(dataDir) {
  const fixture = await readFixture();
  const knowledgeRoot = path.join(dataDir, "knowledge-root");
  await mkdir(knowledgeRoot, { recursive: true });
  for (const [relative, content] of Object.entries(fixture.knowledge ?? {})) {
    const target = path.join(knowledgeRoot, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  const { createDataAgentApplication } = await load("packages/runtime/dist/index.js");
  const { createRuntimeServer } = await load("apps/server/dist/index.js");
  const { PiJsonlSessionStore } = await load("packages/runtime/dist/session-store.js");

  const application = await createDataAgentApplication({
    dataRoot: dataDir,
    host: "web",
    knowledgeRoot,
    projectRoot: root,
    systemPromptRoots: [knowledgeRoot, root],
    skillRoots: [path.join(root, ".agents", "skills")],
    // Opening a session resolves a profile; no prompt is ever sent.
    resolveProfile: async () => ({ provider: "openai", model: "fixture", apiKey: "fixture", apiFormat: "responses" }),
  });
  const app = await createRuntimeServer(application, {
    workspace: application.workspace,
    publicationReader: application,
    authorizeSession: async (userId, sessionId) => (await application.authorizeSession(userId, sessionId)) === "owned",
  });
  await app.ready();

  const sessionTimes = new Map();
  const taskTimes = new Map();
  try {
    const registered = await app.inject({ method: "POST", url: "/auth/register", payload: { username: fixture.user.username, password: fixture.user.password } });
    if (registered.statusCode !== 200) throw new Error(`register failed: ${registered.body}`);
    const token = registered.json().token;
    let sequence = 0;
    const command = async (type, extra = {}) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/runtime/command",
        headers: { authorization: `Bearer ${token}` },
        payload: { protocolVersion: 1, requestId: `fixture-${++sequence}`, command: { type, ...extra } },
      });
      const body = response.json();
      if (response.statusCode !== 200 || !body.response) throw new Error(`${type} failed: ${response.body}`);
      return body.response;
    };

    await command("config.save", { patch: fixture.settings });
    await command("mcp.config.save", { config: fixture.mcp });
    for (const task of fixture.tasks) {
      const taskId = (await command("task.create", { name: task.name })).item.id;
      taskTimes.set(taskId, Date.parse(task.createdAt));
      for (const session of task.sessions) {
        const sessionId = (await command("session.create", { taskId, name: session.name })).item.id;
        const last = session.messages.at(-1)?.at ?? session.createdAt;
        sessionTimes.set(sessionId, { created: Date.parse(session.createdAt), updated: Date.parse(last), messages: session.messages });
      }
    }
  } finally {
    await app.close();
    await application.close();
  }

  // The Application is closed, so the session files and the metadata database are ours to write.
  const store = new PiJsonlSessionStore(path.join(dataDir, "sessions"));
  for (const [sessionId, { messages }] of sessionTimes) {
    const session = await store.openByAppSessionId(sessionId);
    for (const { at, message } of messages) await session.appendMessage({ ...message, timestamp: Date.parse(at) });
  }
  await store.close();
  await pinSessionFiles(path.join(dataDir, "sessions"), sessionTimes);

  const db = new DatabaseSync(path.join(dataDir, "metadata", "app.db"));
  try {
    const clock = Date.parse(fixture.clock);
    db.prepare("UPDATE auth_users SET created_at = ?").run(clock);
    db.prepare("UPDATE auth_tokens SET created_at = ?").run(clock);
    db.prepare("UPDATE app_config SET updated_at = ?").run(clock);
    for (const [taskId, created] of taskTimes) db.prepare("UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?").run(created, created, taskId);
    for (const [sessionId, { created, updated }] of sessionTimes) db.prepare("UPDATE chat_sessions SET created_at = ?, updated_at = ? WHERE id = ?").run(created, updated, sessionId);
    // Projection jobs would otherwise run on the next start and touch updated_at again.
    db.prepare("UPDATE session_projection_outbox SET created_at = ?, updated_at = ?").run(clock, clock);
  } finally {
    db.close();
  }
  return { dataDir, knowledgeRoot, username: fixture.user.username, password: fixture.user.password, clock: fixture.clock };
}

/** Each entry's time is when it was appended; replace it with the message's fixture time. */
async function pinSessionFiles(sessionsRoot, sessionTimes) {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  await walk(sessionsRoot);
  for (const file of files) {
    // Pi session storage v4: a header object, then value records and batches (arrays) of entries.
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const header = lines.find((line) => line?.kind === "header");
    const times = sessionTimes.get(header?.id);
    if (!times) continue;
    header.createdAt = times.created;
    for (const entry of lines.flat()) {
      if (entry?.kind !== "entry") continue;
      entry.timestamp = typeof entry.message?.timestamp === "number" ? entry.message.timestamp : times.created;
    }
    await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n", "utf8");
  }
}

/** Start the Web Host on a built fixture. Resolves once it listens; `stop()` ends it. */
export async function startVisualHost({ dataDir, knowledgeRoot }, port = Number(process.env.DATA_AGENT_PORT ?? 8790)) {
  const child = spawn(process.execPath, [path.join(root, "scripts", "start-web-host.mjs")], {
    env: { ...process.env, DATA_AGENT_DATA_DIR: dataDir, DATA_AGENT_KNOWLEDGE_DIR: knowledgeRoot, DATA_AGENT_PORT: String(port), DATA_AGENT_HOST: "127.0.0.1", DATA_AGENT_CHANNEL_IDLE_MINUTES: "0", FEISHU_APP_ID: "", FEISHU_APP_SECRET: "", TYPESAFE_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) throw new Error(`web host exited:\n${output}`);
    if (output.includes("listening on")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!output.includes("listening on")) { child.kill(); throw new Error(`web host did not start within 60 s:\n${output}`); }
  return {
    url,
    output: () => output,
    stop: () => new Promise((resolve) => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); child.kill(); }),
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const buildIndex = process.argv.indexOf("--build");
  if (buildIndex >= 0) {
    const dir = path.resolve(process.argv[buildIndex + 1] ?? "");
    await rm(dir, { recursive: true, force: true });
    const built = await buildVisualFixture(dir);
    console.log(`visual fixture built in ${built.dataDir}`);
  } else {
    const dir = await mkdtemp(path.join(tmpdir(), "visual-fixture-"));
    const built = await buildVisualFixture(dir);
    const host = await startVisualHost(built);
    console.log(`visual fixture: ${host.url}/app  (user ${built.username} / ${built.password})`);
    console.log(`data dir: ${dir} (removed on exit)`);
    const stop = async () => { await host.stop(); await rm(dir, { recursive: true, force: true }).catch(() => undefined); process.exit(0); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
