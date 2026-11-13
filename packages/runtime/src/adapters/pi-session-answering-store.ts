import { setValue, value, type Session, type Value, type ValueWrite } from "@earendil-works/pi-agent-core/harness/session";
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

/**
 * One Value per record, keyed `<kind>/<id>` (evidence and attempts: `<kind>/<taskId>/<id>`),
 * each id percent-encoded so an id containing "/" can neither collide nor regroup.
 */
const RECORDS_NAMESPACE = "data-agent.answering.records";
const ALL_RECORDS = value<StoredRecord>(RECORDS_NAMESPACE, "");
const recordValue = (key: string): Value<StoredRecord> => value<StoredRecord>(RECORDS_NAMESPACE, key);
const recordKey = (kind: string, ...ids: string[]): string => [kind, ...ids.map(encodeURIComponent)].join("/");

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

type Reader = Pick<Session<any>, "scanValues">;

/**
 * The transaction as the command sees it, recording every record it writes
 * under its stored key. Transactions only put and append; nothing deletes.
 */
function recordingWrites(state: AnsweringTransaction, written: Map<string, JsonValue>): AnsweringTransaction {
  return {
    ...state,
    putTask: (task) => { state.putTask(task); written.set(recordKey("task", task.taskId), encodeJson(task)); },
    putRevision: (revision) => { state.putRevision(revision); written.set(recordKey("revision", revision.revisionId), encodeJson(revision)); },
    appendEvidence: (taskId, evidence) => {
      // Appending an id that exists keeps the first item.
      if (state.getEvidence(taskId, evidence.id)) return;
      state.appendEvidence(taskId, evidence);
      written.set(recordKey("evidence", taskId, evidence.id), encodeJson(evidence));
    },
    putAttempt: (attempt) => { state.putAttempt(attempt); written.set(recordKey("attempt", attempt.taskId, attempt.attemptId), encodeJson(attempt)); },
    putCandidate: (candidate) => { state.putCandidate(candidate); written.set(recordKey("candidate", candidate.candidateId), encodeJson(candidate)); },
    putReceipt: (receipt) => { state.putReceipt(receipt); written.set(recordKey("receipt", receipt.receiptId), encodeJson(receipt)); },
  };
}

/**
 * Pi Session adapter for Answering. The domain module only sees AnsweringStore;
 * Pi namespaces and mutation contexts stop at this adapter boundary.
 *
 * Every record is its own Session Value, and a write commits only the records
 * the transaction changed: one Answer Spec field changes one revision record,
 * instead of rewriting every task, revision, evidence item and candidate of
 * the session (which would grow a session file by tens of megabytes).
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

  private async readRecords(reader: Reader): Promise<Map<string, StoredRecord>> {
    return new Map((await reader.scanValues(ALL_RECORDS, this.piContext)).map((entry) => [entry.address.key, entry.value] as const));
  }

  private async readSnapshot(): Promise<AnsweringStoreSnapshot | undefined> {
    const records = await this.readRecords(this.session);
    return records.size > 0 ? recordsSnapshot(records) : undefined;
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
        const nextDelegate = new InMemoryAnsweringStore(before.size > 0 ? recordsSnapshot(before) : this.delegate.snapshot());
        const written = new Map<string, JsonValue>();
        answer = await nextDelegate.transact((state) => command(recordingWrites(state, written)), context);
        let nextOrder = 0;
        for (const entry of before.values()) if (entry.order >= nextOrder) nextOrder = entry.order + 1;
        const writes: ValueWrite[] = [];
        for (const [key, record] of written) {
          const previous = before.get(key);
          if (previous && JSON.stringify(previous.record) === JSON.stringify(record)) continue;
          writes.push(setValue(recordValue(key), { order: previous?.order ?? nextOrder++, record }));
        }
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
