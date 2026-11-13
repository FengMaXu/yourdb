import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "./protocol.js";
import { KnowledgeIndex } from "./knowledge.js";

describe("knowledge.list", () => {
  it("returns the catalog metadata the model sees beside each file", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-list-"));
    try {
      await mkdir(join(root, "doc"), { recursive: true });
      await writeFile(join(root, "doc", "business.md"), "---\nknowledgeId: business-definitions\nname: 业务定义\ndescription: 业务指标与约束。\n---\n\n# Business", "utf8");
      await writeFile(join(root, "doc", "rules.md"), "---\nknowledgeId: sql-rules\nname: SQL 生成规范\ndescription: SQL 规则。\nusage: method\n---\n\n# Rules", "utf8");
      await writeFile(join(root, "doc", "notes.md"), "# Notes without frontmatter", "utf8");
      const runtime = new DataAgentRuntime({ knowledge: new KnowledgeIndex(), knowledgeRoot: root });
      const result = await runtime.dispatch({ protocolVersion: 1, requestId: "list", command: { type: "knowledge.list" } }, { userId: "local", host: "web" });
      const files = (result.response as { files: Array<Record<string, unknown>> }).files;
      const byPath = new Map(files.map((file) => [file.path, file]));
      expect(byPath.get("doc/business.md")).toMatchObject({ knowledgeId: "business-definitions", name: "业务定义", description: "业务指标与约束。", usage: "fact" });
      expect(byPath.get("doc/rules.md")).toMatchObject({ knowledgeId: "sql-rules", name: "SQL 生成规范", usage: "method" });
      expect(byPath.get("doc/notes.md")).toMatchObject({ knowledgeId: "path-doc-notes", name: "Notes without frontmatter" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
