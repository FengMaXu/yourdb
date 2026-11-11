import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("metadata worker requires a parent port");
const db = new DatabaseSync(workerData.path as string);
db.exec("PRAGMA journal_mode = WAL");
// The semantic model module is gone; drop the table earlier versions created.
db.exec("DROP TABLE IF EXISTS semantic_sources");
db.exec(`CREATE TABLE IF NOT EXISTS knowledge_cache (path TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS tasks (id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL, deleted_at REAL, PRIMARY KEY(user_id,id)); CREATE TABLE IF NOT EXISTS session_projection_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL, target_sequence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS auth_users (username TEXT PRIMARY KEY, user_id TEXT NOT NULL, display_name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS auth_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL, created_at REAL NOT NULL); CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT NOT NULL, user_id TEXT NOT NULL, task_id TEXT NOT NULL, name TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL, deleted_at REAL, PRIMARY KEY(user_id,id)); CREATE UNIQUE INDEX IF NOT EXISTS uq_chat_sessions_global_id ON chat_sessions(id);`);
// Channel boundary (ADR-0011): inbound dedupe, address/actor bindings, and the delivery outbox.
// Their times come from the channel hub (`at`), so due and interrupted checks use one clock.
db.exec(`CREATE TABLE IF NOT EXISTS channel_inbound (channel TEXT NOT NULL, request_id TEXT NOT NULL, address_json TEXT NOT NULL, actor_json TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(channel, request_id)); CREATE TABLE IF NOT EXISTS channel_links (channel TEXT NOT NULL, tenant TEXT NOT NULL, external_user_id TEXT NOT NULL, user_id TEXT NOT NULL, linked_at REAL NOT NULL, role TEXT NOT NULL DEFAULT 'account', PRIMARY KEY(channel, tenant, external_user_id)); CREATE TABLE IF NOT EXISTS channel_access_requests (id TEXT PRIMARY KEY, channel TEXT NOT NULL, tenant TEXT NOT NULL, external_user_id TEXT NOT NULL, actor_json TEXT NOT NULL, audience TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, decided_at REAL, decided_by TEXT); CREATE TABLE IF NOT EXISTS channel_link_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at REAL NOT NULL, used_at REAL); CREATE TABLE IF NOT EXISTS channel_bindings (session_id TEXT PRIMARY KEY, channel TEXT NOT NULL, tenant TEXT NOT NULL, chat_id TEXT NOT NULL, thread_key TEXT NOT NULL, user_id TEXT NOT NULL, task_id TEXT NOT NULL, address_json TEXT NOT NULL, actor_json TEXT NOT NULL, created_at REAL NOT NULL, last_active_at REAL NOT NULL, superseded_at REAL); CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bindings_current ON channel_bindings(channel, tenant, chat_id, thread_key, user_id) WHERE superseded_at IS NULL; CREATE TABLE IF NOT EXISTS channel_delivery_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, idempotency_key TEXT NOT NULL, target_json TEXT NOT NULL, deliverable_json TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at REAL NOT NULL, error TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE(channel, idempotency_key));`);
// channel_links gained its role after it was first created.
if (!(db.prepare("PRAGMA table_info(channel_links)").all() as { name: string }[]).some((column) => column.name === "role")) db.exec("ALTER TABLE channel_links ADD COLUMN role TEXT NOT NULL DEFAULT 'account'");
const now = () => Date.now();
// Fields arrive untyped from MetadataStore.call and are bound as SQL parameters as sent.
parentPort.on("message", (message: { id: number; op: string; userId: string; [key: string]: any }) => {
  try {
    const result = (() => {
      const t = now();
      if (message.op === "task.create") { const id = message.idValue as string; db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, NULL)").run(id, message.userId, message.name, t, t); return { id, name: message.name, createdAt: t, updatedAt: t }; }
      if (message.op === "task.list") return db.prepare("SELECT id,name,created_at createdAt,updated_at updatedAt FROM tasks WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC").all(message.userId);
      if (message.op === "task.rename") { const t = now(); db.prepare("UPDATE tasks SET name=?,updated_at=? WHERE user_id=? AND id=? AND deleted_at IS NULL").run(message.name, t, message.userId, message.taskId); return db.prepare("SELECT id,name,created_at createdAt,updated_at updatedAt FROM tasks WHERE user_id=? AND id=?").get(message.userId, message.taskId); }
      if (message.op === "task.delete") { const t = now(); db.prepare("UPDATE tasks SET deleted_at=?,updated_at=? WHERE user_id=? AND id=?").run(t,t,message.userId,message.taskId); return { id: message.taskId }; }
      if (message.op === "knowledge.cache_put") { const t = now(); db.prepare("INSERT INTO knowledge_cache (path,revision,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET revision=excluded.revision, payload=excluded.payload, updated_at=excluded.updated_at").run(message.cachePath, message.revision, message.payload, t); return { cached: true }; }
      if (message.op === "knowledge.cache_get") { const row = db.prepare("SELECT payload FROM knowledge_cache WHERE path=? AND revision=?").get(message.cachePath, message.revision) as { payload: string } | undefined; return row ? JSON.parse(row.payload) : null; }
      if (message.op === "knowledge.cache_clear") { db.prepare("DELETE FROM knowledge_cache").run(); return { cleared: true }; }
      if (message.op === "outbox.list") return db.prepare("SELECT id,user_id userId,session_id sessionId,target_sequence targetSequence,status,attempts,error FROM session_projection_outbox WHERE status='pending' ORDER BY id").all();
      if (message.op === "outbox.enqueue") { const t = now(); db.prepare("INSERT INTO session_projection_outbox (user_id,session_id,target_sequence,status,attempts,created_at,updated_at) VALUES (?,?,?,'pending',0,?,?)").run(message.userId, message.sessionId, message.sequence ?? 0, t, t); return { queued: true }; }
      if (message.op === "session.create") { const id = message.idValue as string; const t = now(); db.prepare("INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?, ?, NULL)").run(id,message.userId,message.taskId,message.name ?? "New session",t,t); return { id, taskId: message.taskId, name: message.name ?? "New session", createdAt:t, updatedAt:t }; }
      if (message.op === "session.list") return db.prepare("SELECT id,task_id taskId,name,created_at createdAt,updated_at updatedAt FROM chat_sessions WHERE user_id=? AND deleted_at IS NULL AND (? IS NULL OR task_id=?) ORDER BY updated_at DESC").all(message.userId,message.taskId ?? null,message.taskId ?? null);
      if (message.op === "session.rename") { const t=now(); db.prepare("UPDATE chat_sessions SET name=?,updated_at=? WHERE user_id=? AND id=? AND deleted_at IS NULL").run(message.name,t,message.userId,message.sessionId); return db.prepare("SELECT id,task_id taskId,name,created_at createdAt,updated_at updatedAt FROM chat_sessions WHERE user_id=? AND id=?").get(message.userId,message.sessionId); }
      if (message.op === "session.delete") { const t=now(); db.prepare("UPDATE chat_sessions SET deleted_at=?,updated_at=? WHERE user_id=? AND id=?").run(t,t,message.userId,message.sessionId); return { id: message.sessionId }; }
      if (message.op === "session.authorize") {
        const active = db.prepare("SELECT DISTINCT user_id userId FROM chat_sessions WHERE id=? AND deleted_at IS NULL").all(message.sessionId) as { userId: string }[];
        if (active.length === 0) return "missing";
        // Session IDs have exactly one active owner; ambiguous ownership fails closed.
        if (active.length !== 1) return "forbidden";
        return active[0]?.userId === message.userId ? "owned" : "forbidden";
      }
      if (message.op === "channel.inbound.accept") {
        // Insert-first: a second delivery of the same platform event finds the row and is dropped.
        const inserted = db.prepare("INSERT OR IGNORE INTO channel_inbound (channel,request_id,address_json,actor_json,status,created_at,updated_at) VALUES (?,?,?,?,'accepted',?,?)").run(message.channel, message.requestId, message.addressJson, message.actorJson, message.at, message.at);
        return { accepted: inserted.changes === 1 };
      }
      if (message.op === "channel.inbound.settle") { db.prepare("UPDATE channel_inbound SET status=?,updated_at=? WHERE channel=? AND request_id=?").run(message.status, t, message.channel, message.requestId); return { settled: true }; }
      if (message.op === "channel.inbound.interrupted") return db.prepare("SELECT request_id requestId,address_json addressJson,actor_json actorJson FROM channel_inbound WHERE channel=? AND status='accepted' AND created_at<? ORDER BY created_at").all(message.channel, message.before);
      // Only a linked identity may use a channel (ADR-0011); there is no automatic account.
      if (message.op === "channel.link.get") return db.prepare("SELECT user_id userId, role FROM channel_links WHERE channel=? AND tenant=? AND external_user_id=?").get(message.channel, message.tenant, message.externalUserId) ?? null;
      if (message.op === "channel.link.set") { db.prepare("INSERT INTO channel_links (channel,tenant,external_user_id,user_id,linked_at,role) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,tenant,external_user_id) DO UPDATE SET user_id=excluded.user_id, linked_at=excluded.linked_at, role=excluded.role").run(message.channel, message.tenant, message.externalUserId, message.userId, message.at, message.role); return { linked: true }; }
      if (message.op === "channel.link.remove") { db.prepare("DELETE FROM channel_links WHERE channel=? AND tenant=? AND external_user_id=?").run(message.channel, message.tenant, message.externalUserId); return { removed: true }; }
      if (message.op === "channel.link.list") return db.prepare("SELECT channel, tenant, external_user_id externalUserId, role, linked_at linkedAt FROM channel_links ORDER BY linked_at").all();
      if (message.op === "channel.request.latest") return db.prepare("SELECT id, status, decided_at decidedAt FROM channel_access_requests WHERE channel=? AND tenant=? AND external_user_id=? ORDER BY created_at DESC LIMIT 1").get(message.channel, message.tenant, message.externalUserId) ?? null;
      if (message.op === "channel.request.create") { db.prepare("INSERT INTO channel_access_requests (id,channel,tenant,external_user_id,actor_json,audience,text,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)").run(message.requestId, message.channel, message.tenant, message.externalUserId, message.actorJson, message.audience, message.text, message.at); return { created: true }; }
      if (message.op === "channel.request.get") return db.prepare("SELECT id, actor_json actorJson, audience, text, status, created_at createdAt FROM channel_access_requests WHERE id=?").get(message.requestId) ?? null;
      if (message.op === "channel.request.pending") return db.prepare("SELECT id, actor_json actorJson, audience, text, created_at createdAt FROM channel_access_requests WHERE status='pending' ORDER BY created_at").all();
      // Only a pending request can be decided, once; the update tells who won when two members decide at the same time.
      if (message.op === "channel.request.decide") return { decided: db.prepare("UPDATE channel_access_requests SET status=?, decided_at=?, decided_by=? WHERE id=? AND status='pending'").run(message.status, message.at, message.decidedBy, message.requestId).changes === 1 };
      if (message.op === "channel.code.create") {
        const inserted = db.prepare("INSERT OR IGNORE INTO channel_link_codes (code,user_id,expires_at,used_at) VALUES (?,?,?,NULL)").run(message.code, message.userId, message.expiresAt);
        return { created: inserted.changes === 1 };
      }
      if (message.op === "channel.code.consume") {
        // Single use: the same statement checks and spends the code.
        const row = db.prepare("UPDATE channel_link_codes SET used_at=? WHERE code=? AND used_at IS NULL AND expires_at>? RETURNING user_id userId").get(message.at, message.code, message.at) as { userId: string } | undefined;
        return row?.userId ?? null;
      }
      // One current Session per address and speaker; superseded ones keep routing their late events.
      if (message.op === "channel.session.find") return db.prepare("SELECT session_id sessionId,task_id taskId,last_active_at lastActiveAt FROM channel_bindings WHERE channel=? AND tenant=? AND chat_id=? AND thread_key=? AND user_id=? AND superseded_at IS NULL").get(message.channel, message.tenant, message.chatId, message.threadKey, message.userId) ?? null;
      if (message.op === "channel.session.bind") {
        db.prepare("INSERT OR IGNORE INTO channel_bindings (session_id,channel,tenant,chat_id,thread_key,user_id,task_id,address_json,actor_json,created_at,last_active_at,superseded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)").run(message.sessionId, message.channel, message.tenant, message.chatId, message.threadKey, message.userId, message.taskId, message.addressJson, message.actorJson, message.at, message.at);
        return db.prepare("SELECT session_id sessionId,task_id taskId,last_active_at lastActiveAt FROM channel_bindings WHERE channel=? AND tenant=? AND chat_id=? AND thread_key=? AND user_id=? AND superseded_at IS NULL").get(message.channel, message.tenant, message.chatId, message.threadKey, message.userId);
      }
      if (message.op === "channel.session.supersede") { db.prepare("UPDATE channel_bindings SET superseded_at=? WHERE session_id=? AND superseded_at IS NULL").run(message.at, message.sessionId); return { superseded: true }; }
      if (message.op === "channel.session.touch") { db.prepare("UPDATE channel_bindings SET last_active_at=? WHERE session_id=?").run(message.at, message.sessionId); return { touched: true }; }
      if (message.op === "channel.session.get") return db.prepare("SELECT user_id userId,address_json addressJson,actor_json actorJson FROM channel_bindings WHERE session_id=?").get(message.sessionId) ?? null;
      if (message.op === "channel.task.find") return db.prepare("SELECT task_id taskId FROM channel_bindings WHERE channel=? AND tenant=? AND chat_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1").get(message.channel, message.tenant, message.chatId, message.userId) ?? null;
      if (message.op === "channel.outbox.enqueue") {
        const inserted = db.prepare("INSERT OR IGNORE INTO channel_delivery_outbox (channel,idempotency_key,target_json,deliverable_json,session_id,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,'pending',0,?,?,?)").run(message.channel, message.idempotencyKey, message.targetJson, message.deliverableJson, message.sessionId ?? null, message.at, message.at, message.at);
        return { queued: inserted.changes === 1 };
      }
      if (message.op === "channel.outbox.due") return db.prepare("SELECT id,channel,idempotency_key idempotencyKey,target_json targetJson,deliverable_json deliverableJson,session_id sessionId,attempts FROM channel_delivery_outbox WHERE status='pending' AND next_attempt_at<=? AND (? IS NULL OR channel=?) ORDER BY id LIMIT ?").all(message.now, message.channel ?? null, message.channel ?? null, message.limit ?? 50);
      if (message.op === "channel.outbox.settle") { db.prepare("UPDATE channel_delivery_outbox SET status=?,attempts=?,next_attempt_at=?,error=?,updated_at=? WHERE id=?").run(message.status, message.attempts, message.nextAttemptAt ?? message.at, message.error ?? null, message.at, message.outboxId); return { settled: true }; }
      if (message.op === "config.get") return db.prepare("SELECT value_json AS value FROM app_config WHERE key=?").get(message.configKey) ?? null;
      if (message.op === "config.set") { const t=now(); db.prepare("INSERT INTO app_config (key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at").run(message.configKey, message.valueJson, t); return { saved: true }; }
      if (message.op === "auth.userCount") return { count: (db.prepare("SELECT COUNT(*) AS c FROM auth_users").get() as { c: number }).c };
      if (message.op === "auth.register") {
        const t = now();
        try {
          db.prepare("INSERT INTO auth_users (username, user_id, display_name, salt, hash, created_at) VALUES (?,?,?,?,?,?)")
            .run(message.username, message.userId, message.displayName, message.salt, message.hash, t);
          return { ok: true };
        } catch { return { ok: false, reason: "AUTH_REGISTRATION_FAILED" }; }
      }
      if (message.op === "auth.verify") {
        const row = db.prepare("SELECT user_id userId, display_name displayName, salt, hash FROM auth_users WHERE username=?").get(message.username) ?? null;
        return row;
      }
      if (message.op === "auth.token.set") { db.prepare("INSERT OR REPLACE INTO auth_tokens (token, user_id, username, display_name, created_at) VALUES (?,?,?,?,?)").run(message.token, message.userId, message.username, message.displayName, now()); return { ok: true }; }
      if (message.op === "auth.token.get") return db.prepare("SELECT user_id userId, username, display_name displayName FROM auth_tokens WHERE token=?").get(message.token) ?? null;
      if (message.op === "auth.token.delete") { db.prepare("DELETE FROM auth_tokens WHERE token=?").run(message.token); return { ok: true }; }
      if (message.op === "skills.list") { const { readdirSync } = require("node:fs"); const root = message.skillsRoot as string; try { return readdirSync(root, { withFileTypes: true }).filter((e: any) => e.isDirectory()).map((e: any) => ({ name: e.name })); } catch { return []; } }
      throw new Error(`Unknown metadata operation: ${message.op}`);
    })();
    parentPort!.postMessage({ id: message.id, ok: true, result });
  } catch (error) { parentPort!.postMessage({ id: message.id, ok:false, error: error instanceof Error ? error.message : String(error) }); }
});
