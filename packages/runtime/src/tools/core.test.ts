import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { KnowledgeIndex, MAX_KNOWLEDGE_DOCUMENT_LINES } from "../knowledge.js";
import { WorkspaceStore } from "../workspace.js";
import { createCoreAgentToolDefinitions } from "./core.js";

describe("model-facing knowledge tools", () => {
  it("returns bounded search content and uses knowledge/section handles instead of line ranges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "data-agent-knowledge-tools-"));
    try {
      await mkdir(path.join(root, "doc"), { recursive: true });
      await writeFile(path.join(root, "doc", "schema.md"), "# Players\n\nsecret marker\nfield", "utf8");
      const knowledge = new KnowledgeIndex();
      await knowledge.loadDirectory(root);
      const tools = createCoreAgentToolDefinitions({ workspace: new WorkspaceStore(root), knowledge, knowledgeRoot: root }).map((definition) => definition.tool);
      const search = tools.find((tool) => tool.name === "search_knowledge")!;
      const read = tools.find((tool) => tool.name === "read_knowledge")!;

      const located = await search.execute("search", { query: "secret marker" } as never, undefined, undefined, undefined as never, {} as never);
      const locatedText = (located.content[0] as { text: string }).text;
      expect(locatedText).toContain("secret marker");
      expect(located.details).toMatchObject({ hits: [{ path: "doc/schema.md", sectionId: expect.any(String), startLine: 1, endLine: 4, score: expect.any(Number), contentRef: expect.any(String) }] });
      const hit = (located.details as { hits: Array<{ knowledgeId: string; sectionId: string }> }).hits[0]!;

      expect(Value.Check(search.parameters, { query: "secret", maxResults: 8 })).toBe(true);
      expect(Value.Check(search.parameters, { query: "secret", maxResults: 9 })).toBe(false);
      expect(Value.Check(read.parameters, { knowledgeId: hit.knowledgeId })).toBe(true);
      expect(Value.Check(read.parameters, { path: "doc/schema.md", startLine: 1, endLine: 4 })).toBe(false);
      const excerpt = await read.execute("read", { knowledgeId: hit.knowledgeId, sectionId: hit.sectionId } as never, undefined, undefined, undefined as never, {} as never);
      expect((excerpt.content[0] as { text: string }).text).toContain("secret marker");
      expect(excerpt.details).toMatchObject({ mode: "section", contentRef: expect.any(String), sectionId: hit.sectionId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps search payloads bounded and continues only within selected sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "data-agent-knowledge-continuation-"));
    try {
      const lines = ["# Large section", ...Array.from({ length: 300 }, (_, index) => `needle ${index} ${"x".repeat(120)}`)];
      await writeFile(path.join(root, "large.md"), lines.join("\n"), "utf8");
      const knowledge = new KnowledgeIndex();
      await knowledge.loadDirectory(root);
      const tools = createCoreAgentToolDefinitions({ workspace: new WorkspaceStore(root), knowledge, knowledgeRoot: root }).map((definition) => definition.tool);
      const search = tools.find((tool) => tool.name === "search_knowledge")!;
      const read = tools.find((tool) => tool.name === "read_knowledge")!;

      const located = await search.execute("search", { query: "needle", maxResults: 8 } as never, undefined, undefined, undefined as never, {} as never);
      expect(Buffer.byteLength((located.content[0] as { text: string }).text, "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect((located.details as { hits: unknown[] }).hits.length).toBeGreaterThan(0);

      const document = knowledge.getDocument("path-large");
      const sectionId = document.sections[0]!.sectionId;
      const whole = await read.execute("whole", { knowledgeId: "path-large" } as never, undefined, undefined, undefined as never, {} as never);
      expect(whole.details).toMatchObject({ mode: "full_document", truncated: true });
      expect(whole.details).not.toHaveProperty("continuationToken");
      expect(Buffer.byteLength((whole.content[0] as { text: string }).text, "utf8")).toBeLessThanOrEqual(16 * 1024);

      const first = await read.execute("first", { knowledgeId: "path-large", sectionId } as never, undefined, undefined, undefined as never, {} as never);
      expect(first.details).toMatchObject({ mode: "section", truncated: true, continuationToken: expect.any(String) });
      expect(Buffer.byteLength((first.content[0] as { text: string }).text, "utf8")).toBeLessThanOrEqual(16 * 1024);
      expect((first.details as { endLine: number }).endLine).toBeLessThan(document.sections[0]!.endLine);
      const continuationToken = (first.details as { continuationToken: string }).continuationToken;
      await expect(read.execute("mismatch", { knowledgeId: "path-large", sectionId: "other-section", continuationToken } as never, undefined, undefined, undefined as never, {} as never)).rejects.toThrow("KNOWLEDGE_CONTINUATION_SECTION_MISMATCH");
      const second = await read.execute("second", { knowledgeId: "path-large", continuationToken } as never, undefined, undefined, undefined as never, {} as never);
      expect(second.details).toMatchObject({ mode: "section", sectionId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an oversized line instead of returning or discarding a partial line", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "data-agent-knowledge-long-line-"));
    try {
      await writeFile(path.join(root, "long.md"), `# Long\n${"x".repeat(20 * 1024)}`, "utf8");
      const knowledge = new KnowledgeIndex();
      await knowledge.loadDirectory(root);
      const read = createCoreAgentToolDefinitions({ workspace: new WorkspaceStore(root), knowledge, knowledgeRoot: root }).map((definition) => definition.tool).find((tool) => tool.name === "read_knowledge")!;
      const sectionId = knowledge.getDocument("path-long").sections[0]!.sectionId;
      const first = await read.execute("first", { knowledgeId: "path-long", sectionId } as never, undefined, undefined, undefined as never, {} as never);
      const token = (first.details as { continuationToken: string }).continuationToken;
      const blocked = await read.execute("blocked", { knowledgeId: "path-long", continuationToken: token } as never, undefined, undefined, undefined as never, {} as never);
      expect(blocked.details).toMatchObject({ mode: "section", content: "", truncated: true, oversizedLine: { lineNumber: 2, byteLength: 20 * 1024 } });
      expect(blocked.details).not.toHaveProperty("continuationToken");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads short documents in full and requires a section for large documents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "data-agent-knowledge-size-"));
    try {
      await mkdir(path.join(root, "doc"), { recursive: true });
      await writeFile(path.join(root, "doc", "short.md"), "# Short\n\nshort content", "utf8");
      await writeFile(path.join(root, "doc", "boundary499.md"), Array.from({ length: MAX_KNOWLEDGE_DOCUMENT_LINES - 1 }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");
      await writeFile(path.join(root, "doc", "boundary500.md"), Array.from({ length: MAX_KNOWLEDGE_DOCUMENT_LINES }, (_, index) => `line ${index + 1}`).join("\n"), "utf8");
      await writeFile(path.join(root, "doc", "many-sections.md"), Array.from({ length: MAX_KNOWLEDGE_DOCUMENT_LINES }, (_, index) => `# Section ${index + 1}`).join("\n"), "utf8");
      const knowledge = new KnowledgeIndex();
      await knowledge.loadDirectory(root);
      const tools = createCoreAgentToolDefinitions({ workspace: new WorkspaceStore(root), knowledge, knowledgeRoot: root }).map((definition) => definition.tool);
      const read = tools.find((tool) => tool.name === "read_knowledge")!;

      const short = await read.execute("short", { knowledgeId: "path-doc-short" } as never, undefined, undefined, undefined as never, {} as never);
      expect(short.details).toMatchObject({ mode: "full_document", lineCount: 3 });
      const boundary499 = await read.execute("boundary499", { knowledgeId: "path-doc-boundary499" } as never, undefined, undefined, undefined as never, {} as never);
      expect(boundary499.details).toMatchObject({ mode: "full_document", lineCount: 499 });
      const boundary500 = await read.execute("boundary500", { knowledgeId: "path-doc-boundary500" } as never, undefined, undefined, undefined as never, {} as never);
      expect(boundary500.details).toMatchObject({ mode: "section_required", lineCount: 500, sections: expect.any(Array), omittedSectionCount: 0 });
      const manySections = await read.execute("many-sections", { knowledgeId: "path-doc-many-sections" } as never, undefined, undefined, undefined as never, {} as never);
      expect(manySections.details).toMatchObject({ mode: "section_required", lineCount: 500, omittedSectionCount: expect.any(Number) });
      expect((manySections.details as { omittedSectionCount: number }).omittedSectionCount).toBeGreaterThan(0);
      expect(Buffer.byteLength((manySections.content[0] as { text: string }).text, "utf8")).toBeLessThanOrEqual(16 * 1024);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
