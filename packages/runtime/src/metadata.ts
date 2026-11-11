declare const __dirname: string;

import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
export class MetadataStore {
  private readonly worker: Worker;
  private next = 1;
  private pending = new Map<number, Pending>();
  constructor(dbPath: string) {
    // Works both as native ESM (import.meta.url preferred) and inside an esbuild
  // CJS bundle where import.meta.url is defined away and only __dirname exists.
  const sourceDir = typeof import.meta.url === "string"
    ? path.dirname(fileURLToPath(import.meta.url))
    : __dirname;
    // SQLite cannot create missing parent directories.
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const workerCandidates = [
      // The Electron CJS bundle stages a CJS worker next to main.cjs.
      path.join(sourceDir, "metadata-worker.cjs"),
      // Native runtime builds keep the ESM worker next to metadata.js.
      path.join(sourceDir, "metadata-worker.js"),
      path.resolve(sourceDir, "../dist/metadata-worker.js"),
    ];
    const workerPath = workerCandidates.find(existsSync);
    if (!workerPath) throw new Error(`METADATA_WORKER_NOT_FOUND: ${workerCandidates.join(", ")}`);
    this.worker = new Worker(workerPath, { workerData: { path: path.resolve(dbPath) } });
    this.worker.on("message", (message: { id: number; ok: boolean; result?: unknown; error?: string }) => { const p=this.pending.get(message.id); if(!p)return; this.pending.delete(message.id); message.ok?p.resolve(message.result):p.reject(new Error(message.error)); });
    this.worker.on("error", error => { for(const p of this.pending.values())p.reject(error); this.pending.clear(); });
  }
  call(op: string, userId: string, values: Record<string, unknown> = {}): Promise<any> { const id=this.next++; return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,op,userId,...values});}); }
  async knowledgeCachePut(cachePath: string, revision: number, payload: unknown): Promise<void> { await this.call("knowledge.cache_put", "system", { cachePath, revision, payload: JSON.stringify(payload) }); }
  async knowledgeCacheGet(cachePath: string, revision: number): Promise<unknown> { return this.call("knowledge.cache_get", "system", { cachePath, revision }); }
  async knowledgeCacheClear(): Promise<void> { await this.call("knowledge.cache_clear", "system"); }
  async pendingOutbox(): Promise<any[]> { return this.call("outbox.list", "system"); }
  async close(): Promise<void> { await this.worker.terminate(); }
  static createId(): string { return randomUUID(); }
  async getConfig(key: string): Promise<unknown> { const row = await this.call("config.get", "system", { configKey: key }) as { value: string } | null; return row ? JSON.parse(row.value) : null; }
  async setConfig(key: string, value: unknown): Promise<void> { await this.call("config.set", "system", { configKey: key, valueJson: JSON.stringify(value) }); }
  async authorizeSession(userId: string, sessionId: string): Promise<"owned" | "missing" | "forbidden"> { return this.call("session.authorize", userId, { sessionId }); }
}