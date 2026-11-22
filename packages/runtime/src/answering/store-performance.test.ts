import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { setValue, value, type Session, type Value, type ValueWrite } from "@earendil-works/pi-agent-core/harness/session";
import { MemorySessionRepo, TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  ANSWERING_SNAPSHOT_VERSION,
  InMemoryAnsweringStore,
  assertTaskAccess,
  type AnsweringStore,
  type AnsweringStoreSnapshot,
  type AnsweringTransaction,
} from "./answering-store.js";
import { PiSessionAnsweringStore } from "../adapters/pi-session-answering-store.js";
import { AnsweringError } from "./errors.js";
import {
  clone,
  normalizeLimit,
  type AnswerRevisionRecord,
  type BusinessContext,
  type CandidateId,
  type Evidence,
  type EvidenceId,
  type PublicationId,
  type PublicationReceipt,
  type QueryAttemptRecord,
  type QueryTaskRecord,
  type ResultCandidateRecord,
  type RevisionId,
  type TaskId,
} from "./model.js";
import { assertContext } from "./support.js";
import { InMemoryAnswering } from "./service.js";
import { FileResultStore, InMemoryResultStore } from "./result-store.js";
import { createAnsweringAgentToolDefinitions } from "../tools/answering.js";
import { ResultReclamation } from "../application/result-reclamation.js";
import { identityQueries } from "./entity-identity.js";

const context = (invocationId = "invocation"): BusinessContext => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });

const scalarSpec = {
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

function countingStore(inner: AnsweringStore): AnsweringStore & { transactions: number } {
  const store = {
    transactions: 0,
    transact: <T>(command: (state: AnsweringTransaction) => T | Promise<T>, business: BusinessContext) => { store.transactions += 1; return inner.transact(command, business); },
    readTaskBundle: (taskId: TaskId, business: BusinessContext) => inner.readTaskBundle(taskId, business),
    list: (business: BusinessContext) => inner.list(business),
    listReferencedResultRefs: (business: BusinessContext) => inner.listReferencedResultRefs(business),
  };
  return store;
}

describe("T2.1 AnsweringStore holds records, not projections", () => {
  it("does not import the qualification, probe or calendar projections", () => {
    const source = readFileSync(new URL("./answering-store.ts", import.meta.url), "utf8");
    for (const module of ["qualification", "probes", "calendar-coverage"]) expect(source).not.toMatch(new RegExp(`from "\\./${module}\\.js"`));
  });

  it("throws AnsweringError from assertTaskAccess and normalizeLimit", () => {
    expect(() => assertTaskAccess(undefined, context())).toThrow(AnsweringError);
    try {
      assertTaskAccess(undefined, context());
    } catch (error) {
      expect(error).toBeInstanceOf(AnsweringError);
      expect((error as AnsweringError).code).toBe("TASK_NOT_FOUND");
    }
    expect(() => normalizeLimit(0)).toThrow(AnsweringError);
    try {
      normalizeLimit(-1);
    } catch (error) {
      expect(error).toBeInstanceOf(AnsweringError);
      expect((error as AnsweringError).code).toBe("INVALID_REQUEST");
    }
  });
});

describe("T2.3 fewer transactions per use case", () => {
  it("runs one result execution without fanout in at most four transactions", async () => {
    const store = countingStore(new InMemoryAnsweringStore());
    const answering = new InMemoryAnswering({ store, resultStore: new InMemoryResultStore(), sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[1]], truncated: false }) } });
    const begun = await answering.set({ requestMessageId: "m", requestId: "begin", fields: scalarSpec }, context("begin"));
    store.transactions = 0;
    const view = await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result"));
    expect(view.artifact.kind).toBe("candidate");
    expect(store.transactions).toBeLessThanOrEqual(4);
  });

  it("keeps the same count with field probes on", async () => {
    const store = countingStore(new InMemoryAnsweringStore());
    const answering = new InMemoryAnswering({ store, resultStore: new InMemoryResultStore(), fieldProbes: true, sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[1]], truncated: false }) } });
    const begun = await answering.set({ requestMessageId: "m", requestId: "begin", fields: scalarSpec }, context("begin"));
    store.transactions = 0;
    await answering.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result"));
    expect(store.transactions).toBeLessThanOrEqual(4);
  });

  it("set_answer_spec no longer calls inspect, and still reports a superseded Candidate", async () => {
    const inner = new InMemoryAnswering({ store: new InMemoryAnsweringStore(), resultStore: new InMemoryResultStore(), sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[1]], truncated: false }) } });
    let inspections = 0;
    const answering = { set: inner.set.bind(inner), execute: inner.execute.bind(inner), publish: inner.publish.bind(inner), refresh: inner.refresh.bind(inner), inspect: (...args: Parameters<typeof inner.inspect>) => { inspections += 1; return inner.inspect(...args); } };
    const tool = createAnsweringAgentToolDefinitions(answering).map((definition) => definition.tool).find((item) => item.name === "set_answer_spec")!;
    const invocation = (invocationId: string) => ({ operationId: "operation-1", invocationId, getMemo: async () => undefined, setMemo: async () => undefined }) as never;
    const toolContext = { sessionId: "session-1", principalId: "user-1", requestMessageId: "message-1" };
    const begun = await tool.execute("begin", { fields: scalarSpec } as never, undefined as never, toolContext, invocation("begin"), {} as never);
    const { taskId, revisionId } = begun.details as { taskId: string; revisionId: string };
    const candidate = await inner.execute({ kind: "result", taskId, revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result"));
    const unchanged = await tool.execute("same", { taskId, fields: { "measure.formula": { op: "count", of: "orders" } } } as never, undefined as never, toolContext, invocation("same"), {} as never);
    expect(JSON.stringify(unchanged.content)).toContain("ANSWER_SPEC_UNCHANGED");
    const revised = await tool.execute("revise", { taskId, fields: { "population.time": { value: "2018", reason: "the request covers 2018" } } } as never, undefined as never, toolContext, invocation("revise"), {} as never);
    const text = JSON.stringify(revised.content);
    expect(text).toContain("ANSWER_SPEC_SET");
    expect(text).toContain((candidate.artifact as { candidateId: string }).candidateId);
    expect(inspections).toBe(0);
  });
});

// --- T2.2 benchmark ---------------------------------------------------------

function seededSnapshot(): { readonly tasks: QueryTaskRecord[]; readonly revisions: AnswerRevisionRecord[]; readonly evidence: { taskId: TaskId; items: Evidence[] }[] } {
  const tasks: QueryTaskRecord[] = [];
  const revisions: AnswerRevisionRecord[] = [];
  const evidence: { taskId: TaskId; items: Evidence[] }[] = [];
  const fields = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`field.${index}`, { state: "specified", value: { expression: `value ${index} `.repeat(12), boundary: "inclusive" }, basis: { kind: "assumed", rationale: "rationale ".repeat(10) } }]));
  for (let t = 0; t < 20; t++) {
    const taskId = `task_${t}` as TaskId;
    for (let r = 0; r < 5; r++) revisions.push({ revisionId: `revision_${t}_${r}`, taskId, requestId: `request_${t}_${r}`, createdAt: new Date(0).toISOString(), fields, state: { state: "draft" } } as unknown as AnswerRevisionRecord);
    tasks.push({ taskId, sessionId: "session-1", principalId: "user-1", requestId: `request_${t}`, requestMessageId: "message", currentRevisionId: `revision_${t}_4`, lifecycle: "open", budget: { observedRows: 0 }, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as unknown as QueryTaskRecord);
    evidence.push({ taskId, items: Array.from({ length: 10 }, (_, e) => ({ id: `evidence_${t}_${e}`, kind: "query_observation", sourceRef: `invocation_${t}_${e}`, content: "observed ".repeat(40) }) as unknown as Evidence) });
  }
  return { tasks, revisions, evidence };
}

async function seed(store: { transact: AnsweringStore["transact"] }, data: ReturnType<typeof seededSnapshot>): Promise<void> {
  await store.transact((tx) => {
    for (const task of data.tasks) tx.putTask(task);
    for (const revision of data.revisions) tx.putRevision(revision);
    for (const group of data.evidence) for (const item of group.items) tx.appendEvidence(group.taskId, item);
  }, context());
}

/** 20 transactions shaped like set/execute: read a task and its revision, write the task. */
async function workload(store: { transact: AnsweringStore["transact"] }): Promise<number> {
  const started = performance.now();
  for (let index = 0; index < 20; index++) {
    await store.transact((tx) => {
      const task = tx.getTask(`task_${index}` as TaskId)!;
      tx.getRevision(task.currentRevisionId);
      tx.listEvidence(task.taskId);
      tx.putTask({ ...task, updatedAt: new Date(index + 1).toISOString() });
    }, context(`write-${index}`));
  }
  return performance.now() - started;
}

async function session(): Promise<Session<any>> {
  return new MemorySessionRepo().create({}, TODO_CONTEXT) as Promise<Session<any>>;
}

describe("T2.2 store read/write path", () => {
  it("runs 20 transactions on a 20-task session at least 70% faster than before", async () => {
    const data = seededSnapshot();
    const legacy = new LegacyPiSessionAnsweringStore(await session());
    const current = new PiSessionAnsweringStore(await session());
    await seed(legacy, data);
    await seed(current, data);
    // Warm both, then take the best of three runs each to damp scheduler noise.
    await workload(legacy);
    await workload(current);
    const legacyMs = Math.min(await workload(legacy), await workload(legacy), await workload(legacy));
    const currentMs = Math.min(await workload(current), await workload(current), await workload(current));
    console.log(`[store-benchmark] legacy ${legacyMs.toFixed(1)}ms, current ${currentMs.toFixed(1)}ms, reduction ${(100 * (1 - currentMs / legacyMs)).toFixed(1)}%`);
    expect(currentMs).toBeLessThanOrEqual(legacyMs * 0.3);
    // Same records either way.
    expect((await current.list(context())).map((task) => task.updatedAt)).toEqual((await legacy.list(context())).map((task) => task.updatedAt));
  });

  it("rolls a failed transaction back in the in-memory store and the Session adapter", async () => {
    for (const store of [new InMemoryAnsweringStore(), new PiSessionAnsweringStore(await session())]) {
      await seed(store, seededSnapshot());
      const before = await store.list(context());
      await expect(store.transact((tx) => {
        tx.putTask({ ...tx.getTask("task_0" as TaskId)!, updatedAt: "changed" });
        tx.appendEvidence("task_0" as TaskId, { id: "evidence_new", kind: "query_observation" } as unknown as Evidence);
        throw new Error("COMMAND_FAILED");
      }, context("fail"))).rejects.toThrow("COMMAND_FAILED");
      expect(await store.list(context())).toEqual(before);
      expect(await store.transact((tx) => tx.listEvidence("task_0" as TaskId).map((item) => item.id), context())).not.toContain("evidence_new");
    }
  });

  it("reads another writer's records on the next transaction", async () => {
    const shared = await session();
    const first = new PiSessionAnsweringStore(shared);
    const second = new PiSessionAnsweringStore(shared);
    await first.transact((tx) => { tx.putTask({ taskId: "a", sessionId: "session-1", principalId: "user-1", currentRevisionId: "r" } as unknown as QueryTaskRecord); }, context());
    expect((await second.list(context())).map((task) => task.taskId)).toEqual(["a"]);
    await second.transact((tx) => { tx.putTask({ taskId: "b", sessionId: "session-1", principalId: "user-1", currentRevisionId: "r" } as unknown as QueryTaskRecord); }, context());
    expect(await first.transact((tx) => [tx.getTask("a" as TaskId)?.taskId, tx.getTask("b" as TaskId)?.taskId], context())).toEqual(["a", "b"]);
  });
});

describe("T2.4 reclaiming unreferenced result files", () => {
  it("removes expired orphans and keeps referenced and in-flight files", async () => {
    const root = await mkdtemp(path.join(process.cwd(), ".tmp-reclaim-"));
    try {
      const resultStore = new FileResultStore(root);
      const answeringStore = new InMemoryAnsweringStore();
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let hold = false;
      const answering = new InMemoryAnswering({
        store: answeringStore,
        resultStore,
        sqlExecutor: { run: async () => { if (hold) await gate; return { columns: ["n"], rows: [[1]], truncated: false }; } },
      });
      const reclamation = new ResultReclamation({ answeringStore, resultStore, context: () => context("reclaim") });
      const tracked = reclamation.track(answering);
      const begun = await tracked.set({ requestMessageId: "m", requestId: "begin", fields: scalarSpec }, context("begin"));
      const referenced = await tracked.execute({ kind: "result", taskId: begun.taskId, revisionId: begun.revisionId, sql: "SELECT COUNT(*) FROM orders" }, context("result"));
      const referencedRef = (await answeringStore.listReferencedResultRefs(context()))[0]!.resultRef;
      expect(referenced.artifact.kind).toBe("candidate");

      // An orphan a crashed execution left behind an hour ago, and one written just now.
      const expired = await resultStore.createPrivate({ columns: ["n"], rows: [[2]], truncated: false }, context("orphan"));
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(path.join(root, `${expired.resultRef}.json`), old, old);
      const fresh = await resultStore.createPrivate({ columns: ["n"], rows: [[3]], truncated: false }, context("fresh"));
      await writeFile(path.join(root, "unrelated.txt"), "kept");

      // While a result query is in flight nothing is reclaimed.
      hold = true;
      const revised = await tracked.set({ taskId: begun.taskId, requestId: "revise", fields: { "population.time": { value: "2018", reason: "the request covers 2018" } } }, context("revise"));
      const inFlight = tracked.execute({ kind: "result", taskId: begun.taskId, revisionId: revised.revisionId, sql: "SELECT COUNT(*) FROM orders WHERE y = 2018" }, context("result-2"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await reclamation.reclaim()).toEqual([]);
      release!();
      await inFlight;

      const removed = await reclamation.reclaim();
      expect(removed).toEqual([expired.resultRef]);
      const files = await readdir(root);
      expect(files).toContain(`${referencedRef}.json`);
      expect(files).toContain(`${fresh.resultRef}.json`);
      expect(files).toContain("unrelated.txt");
      expect(files).not.toContain(`${expired.resultRef}.json`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("T2.5 entity identity bounds", () => {
  it("quotes reserved table and column names for the dialect", () => {
    expect(identityQueries({ table: "order", keyColumns: ["group", "user_id"] }, "sqlite")).toEqual({
      rows: "SELECT COUNT(*) AS n FROM \"order\"",
      distinctRows: "SELECT COUNT(*) AS n FROM (SELECT DISTINCT * FROM \"order\") AS d",
      distinctKeys: "SELECT COUNT(*) AS n FROM (SELECT DISTINCT \"group\", user_id FROM \"order\") AS d",
    });
    expect(identityQueries({ table: "shop.group" }, "mysql").rows).toBe("SELECT COUNT(*) AS n FROM shop.`group`");
    // A plain name stays bare, so a case-folding dialect reads it as written.
    expect(identityQueries({ table: "Orders" }, "postgres").rows).toBe("SELECT COUNT(*) AS n FROM Orders");
  });

  const spec = { ...scalarSpec, "population.entity": { name: "order", keyColumns: ["order_id"] }, "population.source": { tables: ["order"] }, "measure.formula": { op: "count", of: "order_id" } };

  it("reads a reserved-name table through a real SQLite database", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE \"order\" (order_id INTEGER, amount INTEGER); INSERT INTO \"order\" VALUES (1, 10), (1, 10), (2, 5);");
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        dialect: "sqlite",
        run: async (sql) => {
          const statement = db.prepare(sql);
          const columns = statement.columns().map((column) => column.name);
          return { columns, rows: (statement.all() as Record<string, unknown>[]).map((row) => columns.map((column) => row[column])), truncated: false };
        },
      },
    });
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    expect(view.entityIdentity?.observations).toEqual([{ table: "order", keyColumns: ["order_id"], rows: 3, distinctRows: 2, distinctKeys: 2 }]);
  });

  it("skips DISTINCT above the row threshold, and a count past its timeout, as limitations", async () => {
    const queries: string[] = [];
    const large = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async (sql) => { queries.push(sql); return { columns: ["n"], rows: [[250_000]], truncated: false }; } },
    });
    const view = await large.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    expect(view.entityIdentity).toMatchObject({ status: "unknown", observations: [{ rows: 250_000, limitation: "more than 200000 rows; distinct counts skipped" }] });
    expect(queries.some((sql) => sql.includes("DISTINCT"))).toBe(false);

    const slow = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      entityIdentity: { timeoutMs: 20 },
      sqlExecutor: {
        run: async (_sql, _limit, options) => new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("QUERY_CANCELLED")), { once: true });
        }),
      },
    });
    const started = Date.now();
    const timed = await slow.set({ requestMessageId: "m", requestId: "begin", fields: spec }, context("begin"));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(timed.entityIdentity).toMatchObject({ status: "unknown", observations: [{ limitation: "the table could not be counted" }] });
  });
});

// ---------------------------------------------------------------------------
// Baseline: the Answering store and its Pi Session adapter as of 0d5a82f (before
// plan Phase 2), copied verbatim except for renames and the dropped inspect().
// ---------------------------------------------------------------------------

interface LegacyStore {
  transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T>;
  list(context: BusinessContext): Promise<readonly QueryTaskRecord[]>;
  listReferencedResultRefs(context: BusinessContext): Promise<readonly ResultCandidateRecord[]>;
}

type StoreState = {
  tasks: Map<TaskId, QueryTaskRecord>;
  revisions: Map<RevisionId, AnswerRevisionRecord>;
  evidence: Map<TaskId, Map<EvidenceId, Evidence>>;
  attempts: Map<TaskId, Map<string, QueryAttemptRecord>>;
  candidates: Map<CandidateId, ResultCandidateRecord>;
  receipts: Map<PublicationId, PublicationReceipt>;
};

function emptyState(): StoreState {
  return {
    tasks: new Map(),
    revisions: new Map(),
    evidence: new Map(),
    attempts: new Map(),
    candidates: new Map(),
    receipts: new Map(),
  };
}

function cloneState(source: StoreState): StoreState {
  return {
    tasks: new Map([...source.tasks].map(([key, value]) => [key, clone(value)])),
    revisions: new Map([...source.revisions].map(([key, value]) => [key, clone(value)])),
    evidence: new Map([...source.evidence].map(([taskId, values]) => [taskId, new Map([...values].map(([key, value]) => [key, clone(value)]))])),
    attempts: new Map([...source.attempts].map(([taskId, values]) => [taskId, new Map([...values].map(([key, value]) => [key, clone(value)]))])),
    candidates: new Map([...source.candidates].map(([key, value]) => [key, clone(value)])),
    receipts: new Map([...source.receipts].map(([key, value]) => [key, clone(value)])),
  };
}


function taskVisible(task: QueryTaskRecord, context: BusinessContext): boolean {
  return task.sessionId === context.sessionId && task.principalId === context.principal.id;
}

function createTransaction(state: StoreState): AnsweringTransaction {
  return {
    getTask: (taskId) => state.tasks.get(taskId),
    findTaskByRequest: (sessionId, requestId) => [...state.tasks.values()].find((task) => task.sessionId === sessionId && task.requestId === requestId),
    listChartQueries: (parentTaskId) => [...state.tasks.values()].filter((task) => task.parent?.taskId === parentTaskId),
    putTask: (task) => { state.tasks.set(task.taskId, clone(task)); },
    getRevision: (revisionId) => state.revisions.get(revisionId),
    getCurrentRevision: (taskId) => {
      const task = state.tasks.get(taskId);
      return task ? state.revisions.get(task.currentRevisionId) : undefined;
    },
    putRevision: (revision) => { state.revisions.set(revision.revisionId, clone(revision)); },
    getEvidence: (taskId, evidenceId) => state.evidence.get(taskId)?.get(evidenceId),
    listEvidence: (taskId) => [...(state.evidence.get(taskId)?.values() ?? [])].map(clone),
    appendEvidence: (taskId, evidence) => {
      const values = state.evidence.get(taskId) ?? new Map<EvidenceId, Evidence>();
      if (!values.has(evidence.id)) values.set(evidence.id, clone(evidence));
      state.evidence.set(taskId, values);
    },
    findObservationByInvocation: (taskId, invocationId) => [...(state.evidence.get(taskId)?.values() ?? [])].find((evidence) => evidence.kind === "query_observation" && evidence.sourceRef === invocationId),
    findAttemptByInvocation: (taskId, invocationId, kind) => [...(state.attempts.get(taskId)?.values() ?? [])].find((attempt) => attempt.invocationId === invocationId && (kind === undefined || attempt.kind === kind)),
    findAttemptByQuery: (taskId, revisionId, queryHash, kind) => [...(state.attempts.get(taskId)?.values() ?? [])].reverse().find((attempt) => attempt.revisionId === revisionId && attempt.queryHash === queryHash && attempt.kind === kind),
    listAttempts: (taskId) => [...(state.attempts.get(taskId)?.values() ?? [])].map(clone),
    putAttempt: (attempt) => {
      const values = state.attempts.get(attempt.taskId) ?? new Map<string, QueryAttemptRecord>();
      values.set(attempt.attemptId, clone(attempt));
      state.attempts.set(attempt.taskId, values);
    },
    getCandidate: (candidateId) => state.candidates.get(candidateId),
    findCandidateByInvocation: (taskId, invocationId) => [...state.candidates.values()].find((candidate) => candidate.taskId === taskId && candidate.createdByInvocationId === invocationId),
    findCandidateByQuery: (taskId, revisionId, queryHash) => [...state.candidates.values()].find((candidate) => candidate.taskId === taskId && candidate.revisionId === revisionId && candidate.queryHash === queryHash),
    putCandidate: (candidate) => { state.candidates.set(candidate.candidateId, clone(candidate)); },
    getReceipt: (publicationId) => state.receipts.get(publicationId),
    findReceiptByRequest: (taskId, requestId) => [...state.receipts.values()].find((receipt) => receipt.taskId === taskId && receipt.requestId === requestId),
    findReceiptByCandidate: (taskId, candidateId) => [...state.receipts.values()].find((receipt) => receipt.taskId === taskId && receipt.candidateId === candidateId),
    putReceipt: (receipt) => { state.receipts.set(receipt.receiptId, clone(receipt)); },
  };
}

class LegacyInMemoryAnsweringStore implements LegacyStore {
  private state: StoreState;
  private tail: Promise<void> = Promise.resolve();

  constructor(snapshot?: AnsweringStoreSnapshot) {
    this.state = emptyState();
    if (snapshot) {
      for (const task of snapshot.tasks) this.state.tasks.set(task.taskId, clone(task));
      for (const revision of snapshot.revisions) this.state.revisions.set(revision.revisionId, clone(revision));
      for (const group of snapshot.evidence) this.state.evidence.set(group.taskId, new Map(group.items.map((item) => [item.id, clone(item)])));
      for (const group of snapshot.attempts ?? []) this.state.attempts.set(group.taskId, new Map(group.items.map((item) => [item.attemptId, clone(item)])));
      for (const candidate of snapshot.candidates) this.state.candidates.set(candidate.candidateId, clone(candidate));
      for (const receipt of snapshot.receipts) this.state.receipts.set(receipt.receiptId, clone(receipt));
    }
  }

  async transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T> {
    assertContext(context);
    const run = async (): Promise<T> => {
      assertContext(context);
      const next = cloneState(this.state);
      const result = await command(createTransaction(next));
      assertContext(context);
      this.state = next;
      return result;
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list(context: BusinessContext): Promise<readonly QueryTaskRecord[]> {
    assertContext(context);
    await this.tail;
    return clone([...this.state.tasks.values()].filter((task) => taskVisible(task, context)));
  }

  async listReferencedResultRefs(context: BusinessContext): Promise<readonly ResultCandidateRecord[]> {
    assertContext(context);
    await this.tail;
    const visibleTaskIds = new Set([...this.state.tasks.values()].filter((task) => taskVisible(task, context)).map((task) => task.taskId));
    return clone([...this.state.candidates.values()].filter((candidate) => visibleTaskIds.has(candidate.taskId)));
  }

  /** Serialize the same domain records for a Session adapter. */
  snapshot(): AnsweringStoreSnapshot {
    const state = cloneState(this.state);
    return {
      version: ANSWERING_SNAPSHOT_VERSION,
      tasks: [...state.tasks.values()],
      revisions: [...state.revisions.values()],
      evidence: [...state.evidence.entries()].map(([taskId, items]) => ({ taskId, items: [...items.values()] })),
      attempts: [...state.attempts.entries()].map(([taskId, items]) => ({ taskId, items: [...items.values()] })),
      candidates: [...state.candidates.values()],
      receipts: [...state.receipts.values()],
    };
  }
}

const LEGACY_RECORDS_NAMESPACE = "data-agent.answering.records";
const LEGACY_ALL_RECORDS = value<LegacyStoredRecord>(LEGACY_RECORDS_NAMESPACE, "");
const legacyRecordValue = (key: string): Value<LegacyStoredRecord> => value<LegacyStoredRecord>(LEGACY_RECORDS_NAMESPACE, key);
const legacyRecordKey = (kind: string, ...ids: string[]): string => [kind, ...ids.map(encodeURIComponent)].join("/");

/**
 * A stored record and its place among the records of its kind. The in-memory
 * store keeps insertion order (an updated record keeps its place), and some
 * lookups depend on it, e.g. the latest attempt for a query.
 */
interface LegacyStoredRecord {
  readonly order: number;
  readonly record: JsonValue;
}

function legacyEncodeJson(valueToEncode: unknown): JsonValue {
  return JSON.parse(JSON.stringify(valueToEncode, (_key, valueToVisit) => typeof valueToVisit === "bigint" ? { __type: "bigint", value: valueToVisit.toString() } : valueToVisit)) as JsonValue;
}

function legacyDecodeJson(valueToDecode: unknown): unknown {
  return JSON.parse(JSON.stringify(valueToDecode), (_key, valueToVisit) => valueToVisit && typeof valueToVisit === "object" && valueToVisit.__type === "bigint" ? BigInt(valueToVisit.value) : valueToVisit);
}

/** Stored records back to a snapshot; within each kind, records keep the order they were first stored in. */
function legacyRecordsSnapshot(stored: ReadonlyMap<string, LegacyStoredRecord>): AnsweringStoreSnapshot {
  const byKind = new Map<string, { readonly key: string; readonly stored: LegacyStoredRecord }[]>();
  for (const [key, entry] of stored) {
    const kind = key.slice(0, key.indexOf("/"));
    const list = byKind.get(kind) ?? [];
    list.push({ key, stored: entry });
    byKind.set(kind, list);
  }
  const records = <T>(kind: string): { readonly key: string; readonly record: T }[] => (byKind.get(kind) ?? [])
    .sort((left, right) => left.stored.order - right.stored.order)
    .map(({ key, stored: entry }) => ({ key, record: legacyDecodeJson(entry.record) as T }));
  const grouped = <T>(kind: string): { taskId: TaskId; items: T[] }[] => {
    const groups = new Map<string, T[]>();
    for (const { key, record } of records<T>(kind)) {
      const taskId = decodeURIComponent(key.split("/")[1]!);
      const group = groups.get(taskId);
      if (group) group.push(record);
      else groups.set(taskId, [record]);
    }
    return [...groups].map(([taskId, items]) => ({ taskId: taskId as TaskId, items }));
  };
  return {
    version: ANSWERING_SNAPSHOT_VERSION,
    tasks: records<AnsweringStoreSnapshot["tasks"][number]>("task").map(({ record }) => record),
    revisions: records<AnsweringStoreSnapshot["revisions"][number]>("revision").map(({ record }) => record),
    evidence: grouped<AnsweringStoreSnapshot["evidence"][number]["items"][number]>("evidence"),
    attempts: grouped<NonNullable<AnsweringStoreSnapshot["attempts"]>[number]["items"][number]>("attempt"),
    candidates: records<AnsweringStoreSnapshot["candidates"][number]>("candidate").map(({ record }) => record),
    receipts: records<AnsweringStoreSnapshot["receipts"][number]>("receipt").map(({ record }) => record),
  };
}

type LegacyReader = Pick<Session<any>, "scanValues">;

/**
 * The transaction as the command sees it, recording every record it writes
 * under its stored key. Transactions only put and append; nothing deletes.
 */
function legacyRecordingWrites(state: AnsweringTransaction, written: Map<string, JsonValue>): AnsweringTransaction {
  return {
    ...state,
    putTask: (task) => { state.putTask(task); written.set(legacyRecordKey("task", task.taskId), legacyEncodeJson(task)); },
    putRevision: (revision) => { state.putRevision(revision); written.set(legacyRecordKey("revision", revision.revisionId), legacyEncodeJson(revision)); },
    appendEvidence: (taskId, evidence) => {
      // Appending an id that exists keeps the first item.
      if (state.getEvidence(taskId, evidence.id)) return;
      state.appendEvidence(taskId, evidence);
      written.set(legacyRecordKey("evidence", taskId, evidence.id), legacyEncodeJson(evidence));
    },
    putAttempt: (attempt) => { state.putAttempt(attempt); written.set(legacyRecordKey("attempt", attempt.taskId, attempt.attemptId), legacyEncodeJson(attempt)); },
    putCandidate: (candidate) => { state.putCandidate(candidate); written.set(legacyRecordKey("candidate", candidate.candidateId), legacyEncodeJson(candidate)); },
    putReceipt: (receipt) => { state.putReceipt(receipt); written.set(legacyRecordKey("receipt", receipt.receiptId), legacyEncodeJson(receipt)); },
  };
}

class LegacyPiSessionAnsweringStore {
  private delegate = new LegacyInMemoryAnsweringStore();
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: Session<any>,
    private readonly piContext: Context = TODO_CONTEXT,
  ) {}

  private async readRecords(reader: LegacyReader): Promise<Map<string, LegacyStoredRecord>> {
    return new Map((await reader.scanValues(LEGACY_ALL_RECORDS, this.piContext)).map((entry) => [entry.address.key, entry.value] as const));
  }

  private async readSnapshot(): Promise<AnsweringStoreSnapshot | undefined> {
    const records = await this.readRecords(this.session);
    return records.size > 0 ? legacyRecordsSnapshot(records) : undefined;
  }

  private async load(): Promise<void> {
    if (!this.loaded) await this.reload();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T> {
    return this.enqueue(async () => {
      await this.load();
      let answer!: T;
      await this.session.mutate(async (mutator) => {
        // Read inside the mutation so a concurrent native Session writer cannot
        // silently overwrite the Answering records between read and commit.
        const before = await this.readRecords(mutator);
        const nextDelegate = new LegacyInMemoryAnsweringStore(before.size > 0 ? legacyRecordsSnapshot(before) : this.delegate.snapshot());
        const written = new Map<string, JsonValue>();
        answer = await nextDelegate.transact((state) => command(legacyRecordingWrites(state, written)), context);
        let nextOrder = 0;
        for (const entry of before.values()) if (entry.order >= nextOrder) nextOrder = entry.order + 1;
        const writes: ValueWrite[] = [];
        for (const [key, record] of written) {
          const previous = before.get(key);
          if (previous && JSON.stringify(previous.record) === JSON.stringify(record)) continue;
          writes.push(setValue(legacyRecordValue(key), { order: previous?.order ?? nextOrder++, record }));
        }
        if (writes.length > 0) await mutator.commit(writes, this.piContext);
        this.delegate = nextDelegate;
        this.loaded = true;
      }, this.piContext);
      return answer;
    });
  }

  async list(context: BusinessContext): Promise<readonly QueryTaskRecord[]> {
    return this.enqueue(async () => {
      await this.reload();
      return this.delegate.list(context);
    });
  }

  private async reload(): Promise<void> {
    const stored = await this.readSnapshot();
    this.delegate = stored ? new LegacyInMemoryAnsweringStore(stored) : new LegacyInMemoryAnsweringStore();
    this.loaded = true;
  }
}


void clone;
void setValue;
void value;
void assertContext;
void ANSWERING_SNAPSHOT_VERSION;
export type { AnsweringStoreSnapshot, CandidateId, EvidenceId, PublicationId, PublicationReceipt, QueryAttemptRecord, RevisionId, Value, ValueWrite, JsonValue, Context };
