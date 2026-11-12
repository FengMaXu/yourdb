import { JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Application-facing adapter around the Pi 0.85 Session. The native Session
 * remains the only persistence authority; this adapter is not a second store.
 */
export class PiApplicationSession {
  constructor(readonly native: Session<any>, readonly applicationMetadata: Record<string, unknown> = {}) {}

  get id(): string { return this.native.metadata.id; }
  get metadata(): Record<string, unknown> { return { ...this.native.metadata, ...this.applicationMetadata }; }

  async appendMessage(message: AgentMessage): Promise<string> {
    const branch = await this.native.branch("main", TODO_CONTEXT)
      ?? await this.native.createBranch("main", null, TODO_CONTEXT);
    return branch.appendMessage(message, TODO_CONTEXT);
  }

  async getEntries(): Promise<readonly Entry[]> {
    return this.native.findEntries(undefined, TODO_CONTEXT);
  }
}

export type SessionInput = Session<any> | PiApplicationSession;

export function unwrapApplicationSession(session: SessionInput): Session<any> {
  return session instanceof PiApplicationSession ? session.native : session;
}

export class PiJsonlSessionStore {
  private readonly repo: JsonlSessionRepo;
  private readonly cwd: string;
  private readonly opened = new Map<string, PiApplicationSession>();
  private readonly applicationMetadata = new Map<string, Record<string, unknown>>();

  constructor(root: string) {
    this.cwd = path.resolve(root);
    this.repo = new JsonlSessionRepo({
      fileSystem: new NodeExecutionEnv({ cwd: this.cwd }),
      sessionsRoot: this.cwd,
    });
  }

  async create(metadata: Record<string, unknown> = {}): Promise<PiApplicationSession> {
    await mkdir(this.cwd, { recursive: true });
    const explicitId = typeof metadata.sessionId === "string" && metadata.sessionId.trim()
      ? metadata.sessionId.trim()
      : undefined;
    const session = await this.repo.create({ cwd: this.cwd, ...(explicitId ? { id: explicitId } : {}) }, TODO_CONTEXT);
    const appMetadata = { ...metadata };
    this.applicationMetadata.set(session.metadata.id, appMetadata);
    const wrapped = new PiApplicationSession(session, appMetadata);
    this.opened.set(session.metadata.id, wrapped);
    return wrapped;
  }

  async list(): Promise<readonly unknown[]> {
    await mkdir(this.cwd, { recursive: true });
    const listed = await this.repo.list({ cwd: this.cwd }, TODO_CONTEXT);
    return listed.map((item) => ({ ...item, metadata: this.applicationMetadata.get(item.id) ?? {} }));
  }

  async open(metadata: unknown): Promise<PiApplicationSession> {
    const value = (metadata instanceof PiApplicationSession ? metadata.native : metadata) as { id?: string; metadata?: { id?: string } };
    const id = value && typeof value === "object" ? value.metadata?.id ?? value.id : undefined;
    const existing = id ? this.opened.get(id) : undefined;
    if (existing) return existing;
    const opened = await this.repo.open(value as any, TODO_CONTEXT);
    const appMetadata = this.applicationMetadata.get(opened.metadata.id) ?? {};
    const wrapped = new PiApplicationSession(opened, appMetadata);
    this.opened.set(opened.metadata.id, wrapped);
    return wrapped;
  }

  async openByAppSessionId(sessionId: string): Promise<PiApplicationSession> {
    const metadata = (await this.repo.list({ cwd: this.cwd }, TODO_CONTEXT)).find((item) => item.id === sessionId);
    if (!metadata) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    const existing = this.opened.get(metadata.id);
    if (existing) return existing;
    const opened = await this.repo.open(metadata, TODO_CONTEXT);
    const appMetadata = this.applicationMetadata.get(metadata.id) ?? {};
    const wrapped = new PiApplicationSession(opened, appMetadata);
    this.opened.set(metadata.id, wrapped);
    return wrapped;
  }

  async close(): Promise<void> {
    await this.repo.close(TODO_CONTEXT);
  }
}
