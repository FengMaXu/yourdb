import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataAgentRuntime } from "./protocol.js";
import { WorkspaceStore } from "./workspace.js";

describe("workspace commands", () => {
  it("writes and reads through DataAgentRuntime", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-command-"));
    const runtime = new DataAgentRuntime({ workspace: new WorkspaceStore(root) });
    const context = { userId: "local", host: "electron" as const };
    await runtime.dispatch({ protocolVersion: 1, requestId: "write", command: { type: "workspace.write", path: "note.txt", content: "one\ntwo\nthree" } }, context);
    const result = await runtime.dispatch({ protocolVersion: 1, requestId: "read", command: { type: "workspace.read", path: "note.txt", startLine: 2, endLine: 3 } }, context);
    expect((result.response as { content: string }).content).toBe("two\nthree");
    const whole = await runtime.dispatch({ protocolVersion: 1, requestId: "whole", command: { type: "workspace.read", path: "note.txt" } }, context);
    expect((whole.response as { content: string }).content).toBe("one\ntwo\nthree");
    await expect(runtime.dispatch({ protocolVersion: 1, requestId: "invalid", command: { type: "workspace.read", path: "note.txt", startLine: 3, endLine: 2 } }, context)).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await expect(runtime.dispatch({ protocolVersion: 1, requestId: "escape", command: { type: "workspace.read", path: "../outside.txt" } }, context)).rejects.toThrow();
    await writeFile(join(root, "large.txt"), "z".repeat(60000), "utf8");
    const capped = await runtime.dispatch({ protocolVersion: 1, requestId: "cap", command: { type: "workspace.read", path: "large.txt" } }, context);
    expect(Buffer.byteLength((capped.response as { content: string }).content, "utf8")).toBeLessThanOrEqual(50 * 1024);
    await rm(root, { recursive: true, force: true });
  });
});
