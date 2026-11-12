import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeWriter, KnowledgeWriteDeniedError } from "./knowledge-write.js";

async function readAuditLog(auditPath: string): Promise<Array<{ operation: string; path: string }>> {
  return (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("KnowledgeWriter", () => {
  it("appends learning and writes drafts atomically with audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-kwrite-"));
    await mkdir(join(root, "doc"), { recursive: true });
    await writeFile(join(root, "doc", "learning.md"), "# Learning\n", "utf8");
    const writer = new KnowledgeWriter(root);
    await writer.write("append_learning", "doc/learning.md", "wrong join caused duplicate rows");
    expect(await readFile(join(root, "doc", "learning.md"), "utf8")).toContain("duplicate rows");
    const learningBlock = "### 错误: duplicate join\n\n**说明**: remove repeated business entities before joining";
    await writer.write("append_learning", "doc/learning.md", learningBlock);
    const duplicate = await writer.write("append_learning", "doc/learning.md", learningBlock.replace(/\n/g, "\r\n"));
    expect(duplicate.bytesWritten).toBe(0);
    expect((await readFile(join(root, "doc", "learning.md"), "utf8")).split("duplicate join")).toHaveLength(2);
    await writer.write("write_draft", "drafts/note.md", "draft text");
    expect(await readFile(join(root, "drafts", "note.md"), "utf8")).toBe("draft text");
    expect(await readAuditLog(writer.auditPath)).toHaveLength(4);
    await rm(root, { recursive: true, force: true });
  });

  it("denies canonical business writes and system prompt edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-kdeny-"));
    const writer = new KnowledgeWriter(root);
    await expect(writer.write("write_draft", "doc/business.md", "x")).rejects.toThrow("CANONICAL_WRITE_DENIED");
    await expect(writer.write("update_schema", ".pi/SYSTEM.md", "x")).rejects.toThrow("SYSTEM_PROMPT_IMMUTABLE");
    await rm(root, { recursive: true, force: true });
  });
});
