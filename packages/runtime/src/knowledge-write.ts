import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type KnowledgeWriteOperation = "append_learning" | "write_draft" | "update_schema";

const CANONICAL_DOCS = ["doc/business.md", "doc/rules.md", "doc/query_patterns.md", ".pi/SYSTEM.md"];

export class KnowledgeWriteDeniedError extends Error {
  constructor(message: string) { super(message); this.name = "KnowledgeWriteDeniedError"; }
}

export interface KnowledgeWriteResult { operation: KnowledgeWriteOperation; path: string; bytesWritten: number }

function normalizeLearning(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function learningAlreadyExists(previous: string, candidate: string): boolean {
  const normalizedCandidate = normalizeLearning(candidate);
  if (!normalizedCandidate) return false;
  if (previous.includes(candidate.trim())) return true;
  return previous
    .split(/\n(?=### )|\n---+\s*\n/)
    .some((block) => normalizeLearning(block) === normalizedCandidate);
}

export class KnowledgeWriter {
  readonly root: string;
  private readonly auditPath: string;
  private readonly isBuiltin: (relativePath: string) => boolean;
  constructor(root: string, auditPath?: string, options: { readonly isBuiltin?: (relativePath: string) => boolean } = {}) {
    this.root = path.resolve(root);
    this.auditPath = auditPath ?? path.join(this.root, ".audit.log");
    this.isBuiltin = options.isBuiltin ?? (() => false);
  }
  private resolve(relativePath: string): string { const target = path.resolve(this.root, relativePath); if (!target.startsWith(`${this.root}${path.sep}`) && target !== this.root) throw new Error("KNOWLEDGE_PATH_ESCAPE"); return target; }
  assertAllowed(operation: KnowledgeWriteOperation, relativePath: string): void {
    const normalized = relativePath.split(path.sep).join("/").replace(/^\.\//, "");
    if (normalized === "agent.md" || normalized.startsWith(".pi/")) throw new KnowledgeWriteDeniedError("SYSTEM_PROMPT_IMMUTABLE");
    // A user-root copy would silently override the built-in document.
    if (this.isBuiltin(normalized)) throw new KnowledgeWriteDeniedError(`BUILTIN_WRITE_DENIED:${normalized}`);
    if (CANONICAL_DOCS.includes(normalized) && operation !== "update_schema") throw new KnowledgeWriteDeniedError(`CANONICAL_WRITE_DENIED:${normalized}`);
    if (operation === "append_learning" && !normalized.startsWith("doc/learning")) throw new KnowledgeWriteDeniedError("LEARNING_APPEND_ONLY");
  }
  async write(operation: KnowledgeWriteOperation, relativePath: string, content: string): Promise<KnowledgeWriteResult> {
    this.assertAllowed(operation, relativePath);
    const target = this.resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    if (operation === "append_learning") {
      let previous = ""; try { previous = await readFile(target, "utf8"); } catch { /* new file */ }
      if (learningAlreadyExists(previous, content)) {
        await this.audit(operation, relativePath);
        return { operation, path: relativePath, bytesWritten: 0 };
      }
      await writeFile(target, previous + (previous.endsWith("\n") || previous === "" ? "" : "\n") + content + "\n", "utf8");
      await this.audit(operation, relativePath);
      return { operation, path: relativePath, bytesWritten: content.length };
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, target);
    await this.audit(operation, relativePath);
    return { operation, path: relativePath, bytesWritten: (await stat(target)).size };
  }
  private async audit(operation: string, relativePath: string): Promise<void> {
    await mkdir(path.dirname(this.auditPath), { recursive: true });
    await appendFile(this.auditPath, `${JSON.stringify({ id: randomUUID(), timestamp: Date.now(), operation, path: relativePath })}\n`, "utf8");
  }
}
