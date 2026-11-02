import { deleteValue, setValue, value, type Session, type Value, type ValueWrite } from "@earendil-works/pi-agent-core/harness/session";
import { TODO_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  ANSWERING_SNAPSHOT_VERSION,
  InMemoryAnsweringStore,
  type AnsweringStore,
  type AnsweringStoreSnapshot,
  type AnsweringTransaction,
} from "../answering/answering-store.js";
import type { AnswerTaskView, BusinessContext, TaskId, QueryTaskRecord } from "../answering/model.js";

/** Before per-record storage: the whole snapshot as one Value, rewritten on every change. Read once, then migrated. */
const LEGACY_ANSWERING_STATE = value<JsonValue>("data-agent.answering", "state");
/** One Value per record, keyed `<kind>/<id>` (evidence and attempts: `<kind>/<taskId>/<id>`). */
const RECORDS_NAMESPACE = "data-agent.answering.records";
const ALL_RECORDS = value<StoredRecord>(RECORDS_NAMESPACE, "");
const recordValue = (key: string): Value<StoredRecord> => value<StoredRecord>(RECORDS_NAMESPACE, key);

/**
 * A stored record and its place among the records of its kind. The in-memory
 * store keeps insertion order (an updated record keeps its place), and some
 * lookups depend on it, e.g. the latest attempt for a query.
 */
interface StoredRecord {
  readonly order: number;
  readonly record: JsonValue;
}

function encodeJson(valueToEncode: unknown): JsonValue {
  return JSON.parse(JSON.stringify(valueToEncode, (_key, valueToVisit) => typeof valueToVisit === "bigint" ? { __type: "bigint", value: valueToVisit.toString() } : valueToVisit)) as JsonValue;
}

function decodeJson(valueToDecode: unknown): unknown {
  return JSON.parse(JSON.stringify(valueToDecode), (_key, valueToVisit) => valueToVisit && typeof valueToVisit === "object" && valueToVisit.__type === "bigint" ? BigInt(valueToVisit.value) : valueToVisit);
}

function isSnapshot(valueToCheck: unknown): valueToCheck is AnsweringStoreSnapshot {
  if (!valueToCheck || typeof valueToCheck !== "object") return false;
  const record = valueToCheck as Record<string, unknown>;
  // Records of an earlier Answer Spec model are not read (ADR-0007).
  return record.version === ANSWERING_SNAPSHOT_VERSION && Array.isArray(record.tasks) && Array.isArray(record.revisions) && Array.isArray(record.evidence)
    && Array.isArray(record.candidates) && Array.isArray(record.receipts);
}

/** The snapshot as records keyed by kind and id, in snapshot order. */
function snapshotRecords(snapshot: AnsweringStoreSnapshot): Map<string, JsonValue> {
  const records = new Map<string, JsonValue>();
  for (const task of snapshot.tasks) records.set(`task/${task.taskId}`, encodeJson(task));
  for (const revision of snapshot.revisions) records.set(`revision/${revision.revisionId}`, encodeJson(revision));
  for (const group of snapshot.evidence) for (const item of group.items) records.set(`evidence/${group.taskId}/${item.id}`, encodeJson(item));
  for (const group of snapshot.attempts ?? []) for (const item of group.items) records.set(`attempt/${group.taskId}/${item.attemptId}`, encodeJson(item));
  for (const candidate of snapshot.candidates) records.set(`candidate/${candidate.candidateId}`, encodeJson(candidate));
  for (const receipt of snapshot.receipts) records.set(`receipt/${receipt.receiptId}`, encodeJson(receipt));
  return records;
}

/** Stored records back to a snapshot; within each kind, records keep the order they were first stored in. */
function recordsSnapshot(stored: ReadonlyMap<string, StoredRecord>): AnsweringStoreSnapshot {
  const byKind = new Map<string, { readonly key: string; readonly stored: StoredRecord }[]>();
  for (const [key, entry] of stored) {
    const kind = key.slice(0, key.indexOf("/"));
    const list = byKind.get(kind) ?? [];
    list.push({ key, stored: entry });
    byKind.set(kind, list);
  }
  const records = <T>(kind: string): { readonly key: string; readonly record: T }[] => (byKind.get(kind) ?? [])
    .sort((left, right) => left.stored.order - right.stored.order)
    .map(({ key, stored: entry }) => ({ key, record: decodeJson(entry.record) as T }));
  const grouped = <T>(kind: string): { taskId: TaskId; items: T[] }[] => {
    const groups = new Map<string, T[]>();
    for (const { key, record } of records<T>(kind)) {
      const taskId = key.split("/")[1]!;
      groups.set(taskId, [...(groups.get(taskId) ?? []), record]);
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

type Reader = Pick<Session<any>, "getValue" | "scanValues">;

/**
 * Pi Session adapter for Answering. The domain module only sees AnsweringStore;
 * Pi namespaces and mutation contexts stop at this adapter boundary.
 *
 * Every record is its own Session Value, and a write commits only the records
 * the transaction changed: one Answer Spec field changes one revision record,
 * instead of rewriting every task, revision, evidence item and candidate of
 * the session (which grew a session file by tens of megabytes). A session
 * written in the earlier single-Value form is read from it and migrated on its
 * first write.
 *
 * Each write is a single native Session mutation. The in-memory delegate is
 * rebuilt from the Values inside that mutation, then replaced only after Pi
 * accepts the commit. It is therefore a cache, never a second write authority.
 */
export class PiSessionAnsweringStore implements AnsweringStore {
  private delegate = new InMemoryAnsweringStore();
  private loaded = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: Session<any>,
    private readonly piContext: Context = TODO_CONTEXT,
  ) {}

  /** The stored records, and whether they still sit in the legacy single Value. */
  private async readRecords(reader: Reader): Promise<{ readonly records: Map<string, StoredRecord>; readonly legacy: boolean }> {
    const stored = await reader.scanValues(ALL_RECORDS, this.piContext);
    if (stored.length > 0) return { records: new Map(stored.map((entry) => [entry.address.key, entry.value])), legacy: false };
    const legacy = await reader.getValue(LEGACY_ANSWERING_STATE, this.piContext);
    const decoded = legacy ? decodeJson(legacy.value) : undefined;
    if (!isSnapshot(decoded)) return { records: new Map(), legacy: false };
    let order = 0;
    return { records: new Map([...snapshotRecords(decoded)].map(([key, record]) => [key, { order: order++, record }])), legacy: true };
  }

  private async readSnapshot(): Promise<AnsweringStoreSnapshot | undefined> {
    const { records } = await this.readRecords(this.session);
    return records.size > 0 ? recordsSnapshot(records) : undefined;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.readSnapshot();
    this.delegate = stored ? new InMemoryAnsweringStore(stored) : new InMemoryAnsweringStore();
    this.loaded = true;
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
        const { records: before, legacy } = await this.readRecords(mutator);
        const nextDelegate = new InMemoryAnsweringStore(before.size > 0 ? recordsSnapshot(before) : this.delegate.snapshot());
        answer = await nextDelegate.transact(command, context);
        const after = snapshotRecords(nextDelegate.snapshot());
        let nextOrder = Math.max(-1, ...[...before.values()].map((entry) => entry.order)) + 1;
        const writes: ValueWrite[] = [];
        for (const [key, record] of after) {
          const previous = before.get(key);
          if (!legacy && previous && JSON.stringify(previous.record) === JSON.stringify(record)) continue;
          writes.push(setValue(recordValue(key), { order: previous?.order ?? nextOrder++, record }));
        }
        for (const key of before.keys()) if (!after.has(key)) writes.push(deleteValue(recordValue(key)));
        if (legacy) writes.push(deleteValue(LEGACY_ANSWERING_STATE));
        if (writes.length > 0) await mutator.commit(writes, this.piContext);
        this.delegate = nextDelegate;
        this.loaded = true;
      }, this.piContext);
      return answer;
    });
  }

  async inspect(taskId: TaskId, context: BusinessContext): Promise<AnswerTaskView | undefined> {
    return this.enqueue(async () => {
      await this.reload();
      return this.delegate.inspect(taskId, context);
    });
  }

  async list(context: BusinessContext): Promise<readonly QueryTaskRecord[]> {
    return this.enqueue(async () => {
      await this.reload();
      return this.delegate.list(context);
    });
  }

  async listReferencedResultRefs(context: BusinessContext): Promise<readonly import("../answering/model.js").ResultCandidateRecord[]> {
    return this.enqueue(async () => {
      await this.reload();
      const tasks = await this.delegate.list(context);
      const visible = new Set(tasks.map((task) => task.taskId));
      return this.delegate.snapshot().candidates.filter((candidate) => visible.has(candidate.taskId));
    });
  }

  private async reload(): Promise<void> {
    const stored = await this.readSnapshot();
    this.delegate = stored ? new InMemoryAnsweringStore(stored) : new InMemoryAnsweringStore();
    this.loaded = true;
  }
}
