import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { boundTextByLines, type BoundedReadResult, type LineRange } from "./bounded-read.js";

export interface WorkspaceArtifact { path: string; size: number; modifiedAt: number; kind: "file" }
export type WorkspaceStreamProducer = (write: (chunk: string | Uint8Array) => Promise<void>) => Promise<void>;

export class WorkspaceStore {
  readonly root: string;
  private readonly ownerUserId: string | undefined;
  private readonly ownerSessionId: string | undefined;
  constructor(root: string, ownership: { userId?: string; sessionId?: string } = {}) { this.root = path.resolve(root); this.ownerUserId = ownership.userId; this.ownerSessionId = ownership.sessionId; }
  assertAccess(context: { userId: string; sessionId?: string }): void { if (this.ownerUserId && context.userId !== this.ownerUserId) throw new Error("WORKSPACE_OWNER_MISMATCH"); if (this.ownerSessionId && context.sessionId !== this.ownerSessionId) throw new Error("WORKSPACE_SESSION_MISMATCH"); }
  /** Create an isolated direct-child workspace for one application session. */
  async scoped(sessionId: string): Promise<WorkspaceStore> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || sessionId === "." || sessionId === "..") throw new Error("INVALID_WORKSPACE_SESSION");
    const target = this.resolve(sessionId);
    await mkdir(target, { recursive: true });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
    this.assertWithin(await realpath(this.root), await realpath(target));
    return new WorkspaceStore(target, { ...(this.ownerUserId ? { userId: this.ownerUserId } : {}), sessionId });
  }
  private resolve(relativePath: string): string {
    const target = path.resolve(this.root, relativePath);
    if (!this.isWithin(this.root, target)) throw new Error("WORKSPACE_PATH_ESCAPE");
    return target;
  }
  private isWithin(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  private assertWithin(root: string, target: string): void {
    if (!this.isWithin(root, target)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
  }
  async list(): Promise<string[]> {
    return (await readdir(this.root, { recursive: true }) as string[]).filter((entry) => !entry.split(path.sep).includes(".data-agent-private") && !entry.endsWith(".audit.log"));
  }
  private assertReadable(relativePath: string): void {
    const normalized = relativePath.replaceAll("\\", "/");
    if (normalized === ".data-agent-private" || normalized.startsWith(".data-agent-private/")) throw new Error("PRIVATE_WORKSPACE_PATH");
  }
  private async safeExisting(relativePath: string): Promise<string> {
    const target = await realpath(this.resolve(relativePath));
    const root = await realpath(this.root);
    this.assertWithin(root, target);
    return target;
  }
  async read(relativePath: string): Promise<string> { return (await this.readRange(relativePath)).content; }
  async readBytes(relativePath: string): Promise<Uint8Array> { this.assertReadable(relativePath); return new Uint8Array(await readFile(await this.safeExisting(relativePath))); }
  /** Read a session path with a constrained root-file fallback. */
  async readBytesWithRootFallback(relativePath: string): Promise<Uint8Array> {
    try {
      return await this.readBytes(relativePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const normalized = relativePath.replaceAll("\\", "/");
      const parts = normalized.split("/").filter(Boolean);
      // Fallback accepts only session-id/root-file lookups; nested paths fail
      // closed so stripping one segment cannot address another Session.
      const sessionId = parts[0];
      const fileName = parts[1];
      if (parts.length !== 2 || !sessionId || !fileName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) throw error;
      return this.readBytes(fileName);
    }
  }
  async readRange(relativePath: string, range: LineRange = {}): Promise<BoundedReadResult> {
    this.assertReadable(relativePath);
    return boundTextByLines(await readFile(await this.safeExisting(relativePath), "utf8"), range);
  }
  async write(relativePath: string, content: string): Promise<void> {
    await this.writeStream(relativePath, async (write) => { await write(content); });
  }
  async delete(relativePath: string): Promise<void> { await rm(await this.safeExisting(relativePath), { force: true, recursive: true }); }
  async upload(sourcePath: string, relativePath: string): Promise<WorkspaceArtifact> {
    await this.writeStream(relativePath, async (write) => {
      for await (const chunk of createReadStream(sourcePath)) await write(chunk);
    });
    return this.artifact(relativePath);
  }
  async writeBytes(relativePath: string, content: Uint8Array): Promise<void> {
    await this.writeStream(relativePath, async (write) => { await write(content); });
  }
  /** Copy through the safe workspace boundary while preserving immutable staging. */
  async copy(sourceRelativePath: string, targetRelativePath: string): Promise<void> {
    const source = await this.safeExisting(sourceRelativePath);
    await this.writeStream(targetRelativePath, async (write) => { for await (const chunk of createReadStream(source)) await write(chunk); });
  }
  async sha256(relativePath: string): Promise<string> {
    this.assertReadable(relativePath);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(await this.safeExisting(relativePath))) digest.update(chunk);
    return digest.digest("hex");
  }
  private samePath(left: string, right: string): boolean { return path.relative(left, right) === ""; }
  private async prepareWritePath(relativePath: string, expectedRoot?: string): Promise<{ root: string; parent: string; target: string }> {
    const lexicalTarget = this.resolve(relativePath);
    const root = await realpath(this.root);
    if (expectedRoot && !this.samePath(root, expectedRoot)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");

    const relativeParent = path.relative(this.root, path.dirname(lexicalTarget));
    let parent = root;
    if (relativeParent && relativeParent !== ".") {
      for (const component of relativeParent.split(path.sep).filter(Boolean)) {
        const candidate = path.join(parent, component);
        let info;
        try {
          info = await lstat(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            await mkdir(candidate);
          } catch (mkdirError) {
            if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          }
          info = await lstat(candidate);
        }
        let canonical: string;
        try {
          canonical = await realpath(candidate);
        } catch {
          throw new Error("WORKSPACE_SYMLINK_ESCAPE");
        }
        this.assertWithin(root, canonical);
        const canonicalInfo = await stat(canonical);
        if (!info.isDirectory() && !info.isSymbolicLink() || !canonicalInfo.isDirectory()) {
          throw new Error("WORKSPACE_SYMLINK_ESCAPE");
        }
        parent = canonical;
      }
    }

    const target = path.join(parent, path.basename(lexicalTarget));
    try {
      await lstat(target);
      let canonical: string;
      try {
        canonical = await realpath(target);
      } catch {
        throw new Error("WORKSPACE_SYMLINK_ESCAPE");
      }
      this.assertWithin(root, canonical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { root, parent, target };
  }
  private async assertSafeTemporary(root: string, parent: string, temporary: string): Promise<void> {
    const currentRoot = await realpath(this.root);
    if (!this.samePath(currentRoot, root)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
    const currentParent = await realpath(parent);
    if (!this.samePath(currentParent, parent)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
    const info = await lstat(temporary);
    if (info.isSymbolicLink()) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
    this.assertWithin(root, await realpath(temporary));
  }
  private async cleanupTemporary(root: string, parent: string, temporary: string): Promise<void> {
    try {
      const currentRoot = await realpath(this.root);
      if (!this.samePath(currentRoot, root)) return;
      const currentParent = await realpath(parent);
      if (!this.samePath(currentParent, parent)) return;
      const info = await lstat(temporary);
      if (!info.isSymbolicLink()) await rm(temporary, { force: true });
    } catch {
      // Cleanup must not follow a path whose workspace components changed.
    }
  }
  /** Write incrementally to a sibling temporary file, then atomically promote it. */
  async writeStream(relativePath: string, producer: WorkspaceStreamProducer, signal?: AbortSignal): Promise<void> {
    const prepared = await this.prepareWritePath(relativePath);
    const temporary = path.join(prepared.parent, `${path.basename(prepared.target)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error("EXPORT_CANCELLED");
    };
    try {
      await producer(async (chunk) => {
        throwIfAborted();
        if (typeof chunk === "string") await handle.write(chunk);
        else await handle.write(chunk);
      });
      throwIfAborted();
      await this.assertSafeTemporary(prepared.root, prepared.parent, temporary);
      await handle.sync();
      await handle.close();
      const promotion = await this.prepareWritePath(relativePath, prepared.root);
      if (!this.samePath(promotion.parent, prepared.parent)) throw new Error("WORKSPACE_SYMLINK_ESCAPE");
      await this.assertSafeTemporary(prepared.root, prepared.parent, temporary);
      await rename(temporary, promotion.target);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await this.cleanupTemporary(prepared.root, prepared.parent, temporary);
      throw error;
    }
  }
  /** Atomically promotes an existing private file to a workspace artifact. */
  async promote(sourceRelativePath: string, targetRelativePath: string): Promise<void> {
    const source = await this.safeExisting(sourceRelativePath);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error("WORKSPACE_SOURCE_NOT_FILE");
    const target = await this.prepareWritePath(targetRelativePath);
    await rename(source, target.target);
  }
  async artifact(relativePath: string): Promise<WorkspaceArtifact> { const info=await stat(await this.safeExisting(relativePath)); return { path: relativePath, size: info.size, modifiedAt: info.mtimeMs, kind: "file" }; }
}
