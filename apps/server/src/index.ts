import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { parseDataAgentCommandEnvelope, type DataAgentCommandEnvelope, type DataAgentEventEnvelope, type RequestContext } from "@data-agent/contracts";
import type { ApplicationAuthService, ApplicationCommandHost } from "@data-agent/runtime";

interface WorkspaceHost {
  assertAccess(context: RequestContext): void;
  readBytesWithLegacyFallback(relativePath: string): Promise<Uint8Array>;
  scoped(sessionId: string): Promise<WorkspaceHost>;
  upload(tempPath: string, relativePath: string): Promise<{ readonly size: number }>;
}

export interface RuntimeServerOptions {
  contextFactory?: (request: FastifyRequest) => RequestContext | Promise<RequestContext>;
  authService?: ApplicationAuthService;
  workspace?: WorkspaceHost;
  /** Injected MCP-backed query executor; Runtime never touches business DBs directly. */
  queryExecutor?: { run(sql: string, rowLimit: number, options?: { readonly idempotencyKey?: string }): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> };
  /** Authoritative SessionDirectory check used by workspace artifact routes. */
  authorizeSession?: (userId: string, sessionId: string) => boolean | Promise<boolean>;
  /** Interval of SSE comment heartbeats that keep idle event streams open through proxies. */
  eventHeartbeatMs?: number;
  /** Receipt-only publication reader supplied by the Application Host. */
  publicationReader?: {
    readPublication(publicationId: string, context: { readonly sessionId: string; readonly userId: string }): Promise<{ readonly summary: { readonly format: "inline" | "csv"; readonly contentHash: string }; readonly content: string }>;
  };
}

export async function createRuntimeServer(
  runtime: ApplicationCommandHost,
  options: RuntimeServerOptions = {},
): Promise<FastifyInstance> {
  if (options.queryExecutor) runtime.queryExecutor = options.queryExecutor;
  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });
  const auth = options.authService ?? runtime.authService;
  const publicUser = (user: { id: string; username: string; displayName: string }) => ({ id: user.id, username: user.username, display_name: user.displayName });
  app.post("/auth/register", async (request, reply) => {
    const body = request.body as { username?: string; password?: string; displayName?: string; display_name?: string };
    try {
      await auth.register(body.username ?? "", body.password ?? "", body.displayName ?? body.display_name);
      const result = await auth.login(body.username ?? "", body.password ?? "");
      return { token: result.token, expires_at: 0, user: publicUser(result.user) };
    } catch (error) {
      const code = error instanceof Error && error.message === "AUTH_REGISTRATION_CLOSED" ? "AUTH_REGISTRATION_CLOSED" : "AUTH_REGISTRATION_FAILED";
      return reply.code(400).send({ error: { code } });
    }
  });
  app.post("/auth/login", async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    try {
      const result = await auth.login(body.username ?? "", body.password ?? "");
      return { token: result.token, expires_at: 0, user: publicUser(result.user) };
    } catch {
      return reply.code(401).send({ error: { code: "AUTH_INVALID_CREDENTIALS" } });
    }
  });
  app.get("/auth/status", async (request) => {
    const user = await auth.authenticate(requestToken(request));
    const registrationOpen = (await auth.userCount()) === 0;
    return { authenticated: Boolean(user), user: user ? publicUser(user) : null, registration_open: registrationOpen };
  });
  app.post("/auth/logout", async (request) => { await auth.logout(requestToken(request) ?? ""); return { ok: true }; });
  const contextFactory = options.contextFactory ?? (async (request: FastifyRequest): Promise<RequestContext> => {
    const user = await auth.authenticate(requestToken(request));
    if (!user) throw new Error("AUTH_REQUIRED");
    return { userId: user.id, host: "web" };
  });
  const resolveContext = async (request: FastifyRequest, reply: { code(statusCode: number): { send(payload: unknown): unknown } }): Promise<RequestContext | undefined> => {
    try {
      return await contextFactory(request);
    } catch {
      reply.code(401).send({ error: { code: "AUTH_REQUIRED" } });
      return undefined;
    }
  };
  if (options.workspace) {
    app.get("/api/workspace/download", async (request, reply) => {
      const context = await resolveContext(request, reply);
      if (!context) return;
      const query = request.query as { path?: string };
      try {
        options.workspace!.assertAccess(context);
        const workspacePath = query.path ?? "";
        await assertSessionPathAccess(options.authorizeSession, context.userId, workspacePath);
        const bytes = await options.workspace!.readBytesWithLegacyFallback(workspacePath);
        return reply.type(workspaceContentType(workspacePath)).send(Buffer.from(bytes));
      } catch {
        return reply.code(403).send({ error: { code: "WORKSPACE_ACCESS_DENIED" } });
      }
    });
    app.post("/api/workspace/upload", async (request, reply) => {
      const context = await resolveContext(request, reply);
      if (!context) return;
      try {
        options.workspace!.assertAccess(context);
        const part = await request.file();
        if (!part) return reply.code(400).send({ error: { code: "WORKSPACE_FILE_REQUIRED" } });
        const query = request.query as { session_id?: string };
        if (query.session_id && !(await options.authorizeSession?.(context.userId, query.session_id) ?? true)) return reply.code(403).send({ error: { code: "SESSION_ACCESS_DENIED" } });
        const targetWorkspace = query.session_id ? await options.workspace!.scoped(query.session_id) : options.workspace!;
        const tempDir = await mkdtemp(path.join(tmpdir(), "data-agent-upload-"));
        const tempPath = path.join(tempDir, "upload");
        try {
          await pipeline(part.file, createWriteStream(tempPath));
          const relativePath = safeUploadFileName(part.filename);
          const artifact = await targetWorkspace.upload(tempPath, relativePath);
          return { filename: relativePath, session_id: query.session_id ?? "", relative_path: relativePath, size: artifact.size };
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      } catch {
        return reply.code(400).send({ error: { code: "WORKSPACE_UPLOAD_FAILED" } });
      }
    });
  }

  if (options.publicationReader) {
    app.get("/api/runtime/publications/:publicationId", async (request, reply) => {
      const context = await resolveContext(request, reply);
      if (!context) return;
      const params = request.params as { publicationId?: string };
      const query = request.query as { session_id?: string };
      if (!params.publicationId || !query.session_id) return reply.code(400).send({ error: { code: "PUBLICATION_CONTEXT_REQUIRED" } });
      if (options.authorizeSession && !(await options.authorizeSession(context.userId, query.session_id))) return reply.code(403).send({ error: { code: "SESSION_ACCESS_DENIED" } });
      try {
        const artifact = await options.publicationReader!.readPublication(params.publicationId, { userId: context.userId, sessionId: query.session_id });
        // Publications are always CSV; the BOM lets Excel detect UTF-8 (Chinese headers/values).
        reply.header("Content-Disposition", `attachment; filename="${params.publicationId}.csv"`);
        return reply.type("text/csv; charset=utf-8").send(`﻿${artifact.content}`);
      } catch {
        return reply.code(404).send({ error: { code: "PUBLICATION_NOT_FOUND" } });
      }
    });
  }

  app.get("/api/runtime/events", async (request, reply) => {
    const context = await resolveContext(request, reply);
    if (!context) return;
    const query = request.query as { session_id?: string; after_sequence?: string; instance?: string };
    if (query.session_id && options.authorizeSession && !(await options.authorizeSession(context.userId, query.session_id))) {
      return reply.code(403).send({ error: { code: "SESSION_ACCESS_DENIED" } });
    }
    const headerCursor = request.headers["last-event-id"];
    const rawCursor = query.after_sequence ?? (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor);
    const hasCursor = typeof rawCursor === "string" && /^\d+$/.test(rawCursor);
    const afterSequence = parseEventCursor(rawCursor);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    // Flush headers now: once the client sees the response, its subscription exists.
    reply.raw.write(": connected\n\n");
    // Which process this is, and where its events stand: a client whose cursor came from
    // another instance (the server restarted) resynchronizes from a snapshot instead of replaying.
    const position = runtime.eventStreamPosition();
    reply.raw.write(`event: hello\ndata: ${JSON.stringify(position)}\n\n`);
    const sameInstance = query.instance === undefined || query.instance === position.instanceId;
    let replaying = true;
    let closed = false;
    const pending: DataAgentEventEnvelope[] = [];
    let unsubscribe: () => void = () => undefined;
    const send = (envelope: DataAgentEventEnvelope): void => {
      if (closed || (query.session_id && envelope.sessionId !== query.session_id)) return;
      try {
        reply.raw.write(`id: ${envelope.sequence}\ndata: ${JSON.stringify(envelope)}\n\n`);
      } catch {
        closed = true;
        unsubscribe();
      }
    };
    unsubscribe = runtime.subscribe((envelope) => {
      if (replaying) pending.push(envelope);
      else send(envelope);
    }, { userId: context.userId, ...(query.session_id ? { sessionId: query.session_id } : {}) });
    // The client reloads a snapshot and resumes after the latest event, so it does not resync again on every reconnect.
    const resync = (reason: "evicted" | "restarted"): void => {
      if (!closed) reply.raw.write(`event: resync\ndata: ${JSON.stringify({ afterSequence, latestSequence: position.latestSequence, reason })}\n\n`);
    };
    if (hasCursor && !sameInstance) {
      // The cursor is another process's: what it followed (a run, say) may have ended with that process.
      resync("restarted");
    } else if (hasCursor) {
      const replay = runtime.replayAfter(afterSequence, { userId: context.userId, ...(query.session_id ? { sessionId: query.session_id } : {}) });
      // A partial replay would splice a hole into the client's state; it reloads a snapshot instead.
      if (replay.complete) for (const envelope of replay.events) send(envelope);
      else resync("evicted");
    }
    replaying = false;
    for (const envelope of pending) send(envelope);
    // Long silent phases (a subagent, a long model thought) must not look like a dead connection.
    const heartbeat = setInterval(() => {
      if (closed) return;
      try { reply.raw.write(": heartbeat\n\n"); } catch { closed = true; unsubscribe(); }
    }, options.eventHeartbeatMs ?? 15_000);
    heartbeat.unref?.();
    request.raw.on("close", () => { closed = true; clearInterval(heartbeat); unsubscribe(); });
  });

  app.post("/api/runtime/command", async (request, reply) => {
    const context = await resolveContext(request, reply);
    if (!context) return;
    try {
      const command: DataAgentCommandEnvelope = parseDataAgentCommandEnvelope(request.body);
      if (command.sessionId && options.authorizeSession && !(await options.authorizeSession(context.userId, command.sessionId))) {
        return reply.code(403).send({ error: { code: "SESSION_ACCESS_DENIED" } });
      }
      const effectiveContext = context.sessionId || !command.sessionId
        ? context
        : { ...context, sessionId: command.sessionId };
      return await runtime.dispatch(command, effectiveContext);
    } catch (error) {
      const runtimeError = toRuntimeError(error);
      return reply.code(400).send({
        error: {
          code: runtimeError.code,
          message: runtimeError.message,
        },
      });
    }
  });

  return app;
}

async function assertSessionPathAccess(
  authorizeSession: RuntimeServerOptions["authorizeSession"],
  userId: string,
  relativePath: string,
): Promise<void> {
  if (!authorizeSession) return;
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  // Session-scoped artifacts are addressed as <sessionId>/<path>. A path with
  // a second segment is never treated as a root-relative escape when an
  // authoritative SessionDirectory is available.
  if (parts.length >= 2 && !(await authorizeSession(userId, parts[0]))) throw new Error("SESSION_ACCESS_DENIED");
}

function safeUploadFileName(fileName: string): string {
  const name = path.posix.basename(fileName.replaceAll("\\", "/"));
  if (!name || name === "." || name === "..") throw new Error("WORKSPACE_FILE_REQUIRED");
  return name;
}

function workspaceContentType(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  return ({
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function requestToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  const match = typeof value === "string" ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  if (match?.[1]) return match[1];

  // Native browser resources such as <img> and EventSource cannot attach an
  // Authorization header. Allow a query token on GET requests only; mutating
  // endpoints continue to require the Bearer header.
  if (request.method !== "GET") return undefined;
  const query = request.query as { access_token?: unknown };
  return typeof query.access_token === "string" && query.access_token ? query.access_token : undefined;
}

function parseEventCursor(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

type RuntimeErrorCode = "INVALID_COMMAND" | "UNSUPPORTED_PROTOCOL_VERSION" | "INVALID_CONTEXT";
interface RuntimeErrorShape { readonly code: RuntimeErrorCode; readonly message: string; }

function toRuntimeError(error: unknown): RuntimeErrorShape {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "UNSUPPORTED_PROTOCOL_VERSION") {
    return { code: "UNSUPPORTED_PROTOCOL_VERSION", message: error instanceof Error ? error.message : String(error) };
  }
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "INVALID_CONTEXT") {
    return { code: "INVALID_CONTEXT", message: error instanceof Error ? error.message : String(error) };
  }
  if (error instanceof TypeError) return { code: "INVALID_COMMAND", message: error.message };
  if (process.env.DATA_AGENT_DEBUG_ERRORS === "1") console.error("[data-agent] command failed:", error);
  return { code: "INVALID_COMMAND", message: "DataAgent command failed" };
}
