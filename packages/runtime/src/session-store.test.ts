import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { PiJsonlSessionStore } from "./session-store.js";

describe("PiJsonlSessionStore", () => {
  it("creates and lists persisted Pi sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-sessions-"));
    const store = new PiJsonlSessionStore(root);
    const session = await store.create({ userId: "local" });
    await session.native.setName("Analysis", TODO_CONTEXT);
    const sessions = await store.list();
    expect(sessions).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });
});
