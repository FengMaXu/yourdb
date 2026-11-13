import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspace.js";

describe("WorkspaceStore", () => {
  it("rejects paths outside the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const store = new WorkspaceStore(root);
    await expect(store.read("../outside.txt")).rejects.toThrow("WORKSPACE_PATH_ESCAPE");
    await expect(store.writeStream("../outside.txt", async (write) => write("must not escape"))).rejects.toThrow("WORKSPACE_PATH_ESCAPE");
    await rm(root, { recursive: true, force: true });
  });

  it("writes binary content atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const store = new WorkspaceStore(root);
    await store.writeBytes("uploads/report.bin", Uint8Array.from([0, 1, 127, 255]));
    expect([...await readFile(join(root, "uploads", "report.bin"))]).toEqual([0, 1, 127, 255]);
    await rm(root, { recursive: true, force: true });
  });

  it("limits the root fallback to a missing session/root-file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-root-"));
    const store = new WorkspaceStore(root);
    await store.writeBytes("root.png", Uint8Array.from([1, 2, 3]));
    await store.writeBytes("session-B/secret.png", Uint8Array.from([9, 9, 9]));

    expect([...await store.readBytesWithRootFallback("session-A/root.png")]).toEqual([1, 2, 3]);
    await expect(store.readBytesWithRootFallback("session-A/session-B/secret.png")).rejects.toMatchObject({ code: "ENOENT" });

    await rm(root, { recursive: true, force: true });
  });

  it("writes long single-line and empty exports atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const store = new WorkspaceStore(root);
    const longLine = "x".repeat(1024 * 1024);
    await store.writeStream("exports/long.csv", async (write) => write(longLine));
    await store.writeStream("exports/empty.csv", async () => undefined);
    expect(await readFile(join(root, "exports", "long.csv"), "utf8")).toBe(longLine);
    expect((await lstat(join(root, "exports", "empty.csv"))).size).toBe(0);
    expect((await readdir(join(root, "exports"))).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects an external symlinked parent without writing outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "data-agent-workspace-outside-"));
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(outside, join(root, "linked"), linkType);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const store = new WorkspaceStore(root);
    const uploadSource = join(outside, "upload-source.txt");
    await writeFile(uploadSource, "must not escape", "utf8");
    await expect(store.writeStream("linked/export.csv", async (write) => write("must not escape"))).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
    await expect(store.write("linked/write.txt", "must not escape")).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
    await expect(store.upload(uploadSource, "linked/upload.txt")).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
    expect(existsSync(join(outside, "export.csv"))).toBe(false);
    expect(existsSync(join(outside, "write.txt"))).toBe(false);
    expect(existsSync(join(outside, "upload.txt"))).toBe(false);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects an external symlink created before promotion and cleans up the temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "data-agent-workspace-outside-"));
    const outsideFile = join(outside, "result.csv");
    await writeFile(outsideFile, "original", "utf8");
    const target = join(root, "result.csv");
    try {
      await symlink(outsideFile, target);
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const store = new WorkspaceStore(root);
    await expect(store.writeStream("result.csv", async (write) => write("must not follow"))).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
    expect(await readFile(outsideFile, "utf8")).toBe("original");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("rejects a symlink created while an export is streaming and cleans up", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "data-agent-workspace-outside-"));
    const outsideFile = join(outside, "result.csv");
    await writeFile(outsideFile, "original", "utf8");
    const target = join(root, "result.csv");
    const store = new WorkspaceStore(root);
    await expect(store.writeStream("result.csv", async (write) => {
      await write("partial");
      await symlink(outsideFile, target);
    })).rejects.toThrow("WORKSPACE_SYMLINK_ESCAPE");
    expect(await readFile(outsideFile, "utf8")).toBe("original");
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("cleans up a partial export when cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-workspace-"));
    const store = new WorkspaceStore(root);
    const controller = new AbortController();
    await expect(store.writeStream("cancelled.csv", async (write) => {
      await write("partial");
      controller.abort();
      await write("not written");
    }, controller.signal)).rejects.toThrow("EXPORT_CANCELLED");
    expect(existsSync(join(root, "cancelled.csv"))).toBe(false);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
