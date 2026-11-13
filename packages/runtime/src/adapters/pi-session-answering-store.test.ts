import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiSessionAnsweringStore } from "./pi-session-answering-store.js";
import type { BusinessContext, QueryTaskRecord } from "../answering/model.js";

const context: BusinessContext = { principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "op-1", invocationId: "inv-1" };

const task = (taskId: string, revision: number): QueryTaskRecord => ({
  taskId, sessionId: "session-1", principalId: "user-1", requestId: `request-${taskId}`, currentRevisionId: `${taskId}-r${revision}`,
} as unknown as QueryTaskRecord);

async function withSession<T>(run: (session: Awaited<ReturnType<JsonlSessionRepo["create"]>>, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.cwd(), ".tmp-answering-records-"));
  try {
    const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
    return await run(await repo.create({ cwd: root, id: "session-1" }, TODO_CONTEXT), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Every Answering Value write recorded in the session file, as namespace/key. */
async function answeringWrites(root: string): Promise<string[]> {
  const writes: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".jsonl")) {
        for (const line of (await readFile(path, "utf8")).split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line) as unknown;
          for (const op of (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ kind?: string; op?: string; namespace?: string; key?: string }>) {
            if (op.kind === "value" && op.namespace?.startsWith("data-agent.answering")) writes.push(`${op.op} ${op.namespace}/${op.key}`);
          }
        }
      }
    }
  };
  await visit(root);
  return writes;
}

describe("PiSessionAnsweringStore", () => {
  it("writes only the records a transaction changed", async () => {
    await withSession(async (session, root) => {
      const store = new PiSessionAnsweringStore(session);
      await store.transact((state) => { state.putTask(task("t1", 1)); state.putTask(task("t2", 1)); }, context);
      const first = await answeringWrites(root);
      expect(first).toEqual(["set data-agent.answering.records/task/t1", "set data-agent.answering.records/task/t2"]);

      await store.transact((state) => { state.putTask(task("t2", 2)); }, context);
      expect((await answeringWrites(root)).slice(first.length)).toEqual(["set data-agent.answering.records/task/t2"]);

      // Nothing changed, nothing written.
      const count = (await answeringWrites(root)).length;
      await store.transact((state) => { state.putTask(task("t2", 2)); }, context);
      expect(await answeringWrites(root)).toHaveLength(count);
    });
  });

  it("keeps the order records were first stored in, also across updates and a reload", async () => {
    await withSession(async (session) => {
      const store = new PiSessionAnsweringStore(session);
      for (const id of ["tz", "ta", "tm"]) await store.transact((state) => { state.putTask(task(id, 1)); }, context);
      await store.transact((state) => { state.putTask(task("tz", 2)); }, context);
      const reloaded = new PiSessionAnsweringStore(session);
      expect((await reloaded.list(context)).map((record) => [record.taskId, record.currentRevisionId])).toEqual([["tz", "tz-r2"], ["ta", "ta-r1"], ["tm", "tm-r1"]]);
    });
  });

  it("keeps ids with a slash apart, and their records with their task", async () => {
    await withSession(async (session) => {
      const store = new PiSessionAnsweringStore(session);
      const evidence = (id: string) => ({ id, kind: "note" }) as never;
      await store.transact((state) => {
        state.putTask(task("a/b", 1));
        state.putTask(task("a", 1));
        state.appendEvidence("a/b" as never, evidence("c"));
        state.appendEvidence("a" as never, evidence("b/c"));
      }, context);
      const reloaded = new PiSessionAnsweringStore(session);
      const items = await reloaded.transact((state) => [state.listEvidence("a/b" as never).map((item) => item.id), state.listEvidence("a" as never).map((item) => item.id)], context);
      expect(items).toEqual([["c"], ["b/c"]]);
    });
  });
});
