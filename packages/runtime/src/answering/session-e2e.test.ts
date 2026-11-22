import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonlSessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { FileResultStore } from "./result-store.js";
import { PiSessionAnsweringStore } from "../adapters/pi-session-answering-store.js";
import { InMemoryAnswering } from "./service.js";
import type { BusinessContext } from "./model.js";

const context = (invocationId: string): BusinessContext => ({
  principal: { id: "user-1" },
  sessionId: "session-1",
  lane: "main",
  operationId: "pi-operation-1",
  invocationId,
});

const spec = {
  "population.entity": "orders",
  "population.eligibility": "n/a",
  "population.conditions": "n/a",
  "population.time": "n/a",
  "measure.formula": { op: "count", of: "orders" },
  "measure.countGrain": "one row per order",
  grouping: "n/a",
  selection: "n/a",
  output: { rowMode: "scalar", rowCount: 1 },
};

describe("Pi Session Answering production seam", () => {
  it("persists Answering state and reuses the same Result Candidate after reconstruction", async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-answering-session-"));
    try {
      const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: root }), sessionsRoot: root });
      const native = await repo.create({ cwd: root, id: "session-1" }, TODO_CONTEXT);
      const results = new FileResultStore(join(root, "results"));
      let sqlCalls = 0;
      const sqlExecutor = { run: async () => { sqlCalls += 1; return { columns: ["count"], rows: [[1n]], truncated: false, columnTypes: ["BIGINT"] }; } };
      const first = new InMemoryAnswering({ store: new PiSessionAnsweringStore(native), resultStore: results, sqlExecutor });
      const begun = await first.set({ requestMessageId: "message-1", requestId: "begin-1", fields: spec }, context("begin-1"));
      const candidate = await first.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result-1"));
      expect(candidate.artifact.kind).toBe("candidate");
      if (candidate.artifact.kind !== "candidate") throw new Error("candidate expected");
      const reconstructed = new InMemoryAnswering({ store: new PiSessionAnsweringStore(native), resultStore: results, sqlExecutor });
      const repeated = await reconstructed.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result-1"));
      expect(repeated.artifact).toEqual(candidate.artifact);
      expect(sqlCalls).toBe(1);
      const receipt = await reconstructed.publish({ candidateId: candidate.artifact.candidateId, format: "inline", requestId: "publish-1" }, context("publish-1"));
      const recovered = await reconstructed.inspect({ taskId: begun.taskId }, context("inspect-1"));
      expect(recovered.publication).toEqual(receipt);
      expect(receipt.resultRef).toBe(candidate.artifact.resultRef);
      // Without a transport route the reference is an opaque handle (the Session Host injects its route).
      expect(receipt.publicRef).toBe(`publication:${receipt.receiptId}`);
      const encoded = await results.encodeCsv(receipt.resultRef, context("read-published"));
      expect(encoded.content).toBe("count\n1\n");
      expect(receipt.presentationContentHash).toBe(encoded.contentHash);
      expect(receipt).not.toHaveProperty("content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
