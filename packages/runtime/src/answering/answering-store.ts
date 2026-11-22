import {
  clone,
  type AnswerRevisionRecord,
  type BusinessContext,
  type CandidateId,
  type QueryAttemptRecord,
  type Evidence,
  type EvidenceId,
  type PublicationId,
  type PublicationReceipt,
  type QueryTaskRecord,
  type ResultCandidateRecord,
  type RevisionId,
  type TaskId,
} from "./model.js";
import { AnsweringError } from "./errors.js";
import { assertContext } from "./support.js";

export interface AnsweringTransaction {
  getTask(taskId: TaskId): QueryTaskRecord | undefined;
  findTaskByRequest(sessionId: string, requestId: string): QueryTaskRecord | undefined;
  /** The chart queries created under a Report Task (read-only records, not copies). */
  listChartQueries(parentTaskId: TaskId): readonly QueryTaskRecord[];
  putTask(task: QueryTaskRecord): void;
  getRevision(revisionId: RevisionId): AnswerRevisionRecord | undefined;
  getCurrentRevision(taskId: TaskId): AnswerRevisionRecord | undefined;
  putRevision(revision: AnswerRevisionRecord): void;
  getEvidence(taskId: TaskId, evidenceId: EvidenceId): Evidence | undefined;
  listEvidence(taskId: TaskId): readonly Evidence[];
  appendEvidence(taskId: TaskId, evidence: Evidence): void;
  findObservationByInvocation(taskId: TaskId, invocationId: string): Evidence | undefined;
  findAttemptByInvocation(taskId: TaskId, invocationId: string, kind?: QueryAttemptRecord["kind"]): QueryAttemptRecord | undefined;
  findAttemptByQuery(taskId: TaskId, revisionId: RevisionId, queryHash: string, kind: QueryAttemptRecord["kind"]): QueryAttemptRecord | undefined;
  listAttempts(taskId: TaskId): readonly QueryAttemptRecord[];
  putAttempt(attempt: QueryAttemptRecord): void;
  getCandidate(candidateId: CandidateId): ResultCandidateRecord | undefined;
  findCandidateByInvocation(taskId: TaskId, invocationId: string): ResultCandidateRecord | undefined;
  findCandidateByQuery(taskId: TaskId, revisionId: RevisionId, queryHash: string): ResultCandidateRecord | undefined;
  putCandidate(candidate: ResultCandidateRecord): void;
  getReceipt(publicationId: PublicationId): PublicationReceipt | undefined;
  findReceiptByRequest(taskId: TaskId, requestId: string): PublicationReceipt | undefined;
  findReceiptByCandidate(taskId: TaskId, candidateId: CandidateId): PublicationReceipt | undefined;
  putReceipt(receipt: PublicationReceipt): void;
}

/** The stored records of one task, as stored; projections such as open or undeclared paths belong to the domain. */
export interface TaskBundle {
  readonly task: QueryTaskRecord;
  readonly currentRevision: AnswerRevisionRecord;
  readonly attempts: readonly QueryAttemptRecord[];
  readonly candidate?: ResultCandidateRecord;
  readonly publication?: PublicationReceipt;
}

export interface AnsweringStore {
  transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T>;
  /** A read-only copy of one visible task's records, or undefined when the task is not visible. */
  readTaskBundle(taskId: TaskId, context: BusinessContext): Promise<TaskBundle | undefined>;
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

/**
 * Version of the persisted records. Version 2 holds Answer Spec fields
 * (ADR-0007); a snapshot of any other version is not read.
 */
export const ANSWERING_SNAPSHOT_VERSION = 2;

export interface AnsweringStoreSnapshot {
  readonly version: typeof ANSWERING_SNAPSHOT_VERSION;
  readonly tasks: readonly QueryTaskRecord[];
  readonly revisions: readonly AnswerRevisionRecord[];
  readonly evidence: readonly { readonly taskId: TaskId; readonly items: readonly Evidence[] }[];
  readonly attempts?: readonly { readonly taskId: TaskId; readonly items: readonly QueryAttemptRecord[] }[];
  readonly candidates: readonly ResultCandidateRecord[];
  readonly receipts: readonly PublicationReceipt[];
}

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

/** The Map operations a transaction uses; a transaction sees an Overlay, the store holds plain Maps. */
interface MapView<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
  values(): IterableIterator<V>;
}

type StateView = { [Kind in keyof StoreState]: StoreState[Kind] extends Map<infer K, infer V> ? MapView<K, V> : never };

/**
 * Copy-on-write view over one committed Map: writes stay in the overlay until
 * commit, so a failed transaction leaves the store untouched without copying
 * every record first. Iteration follows Map order: an updated key keeps its
 * place, a new key comes last.
 */
class Overlay<K, V> implements MapView<K, V> {
  private readonly writes = new Map<K, V>();
  constructor(private readonly base: Map<K, V>) {}
  get(key: K): V | undefined { return this.writes.has(key) ? this.writes.get(key) : this.base.get(key); }
  set(key: K, value: V): this { this.writes.set(key, value); return this; }
  *values(): IterableIterator<V> {
    for (const [key, value] of this.base) yield this.writes.has(key) ? this.writes.get(key)! : value;
    for (const [key, value] of this.writes) if (!this.base.has(key)) yield value;
  }
  commit(): void { for (const [key, value] of this.writes) this.base.set(key, value); }
}

function overlayState(state: StoreState): { readonly view: StateView; readonly commit: () => void } {
  const layers = {
    tasks: new Overlay(state.tasks),
    revisions: new Overlay(state.revisions),
    evidence: new Overlay(state.evidence),
    attempts: new Overlay(state.attempts),
    candidates: new Overlay(state.candidates),
    receipts: new Overlay(state.receipts),
  };
  return { view: layers, commit: () => { for (const layer of Object.values(layers)) layer.commit(); } };
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

function createTransaction(state: StateView): AnsweringTransaction {
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
      const current = state.evidence.get(taskId);
      if (current?.has(evidence.id)) return;
      // The committed inner Map is never written; the task's items are copied once per write.
      const values = new Map<EvidenceId, Evidence>(current ?? []);
      values.set(evidence.id, clone(evidence));
      state.evidence.set(taskId, values);
    },
    findObservationByInvocation: (taskId, invocationId) => [...(state.evidence.get(taskId)?.values() ?? [])].find((evidence) => evidence.kind === "query_observation" && evidence.sourceRef === invocationId),
    findAttemptByInvocation: (taskId, invocationId, kind) => [...(state.attempts.get(taskId)?.values() ?? [])].find((attempt) => attempt.invocationId === invocationId && (kind === undefined || attempt.kind === kind)),
    findAttemptByQuery: (taskId, revisionId, queryHash, kind) => [...(state.attempts.get(taskId)?.values() ?? [])].reverse().find((attempt) => attempt.revisionId === revisionId && attempt.queryHash === queryHash && attempt.kind === kind),
    listAttempts: (taskId) => [...(state.attempts.get(taskId)?.values() ?? [])].map(clone),
    putAttempt: (attempt) => {
      const values = new Map<string, QueryAttemptRecord>(state.attempts.get(attempt.taskId) ?? []);
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

/**
 * In-memory Answering store used by isolated composition and focused tests. A
 * transaction writes into a copy-on-write overlay that becomes visible only
 * after the callback succeeds, so failed multi-record commands cannot leave
 * half a task. Records are cloned on write and on the way out of the store.
 */
export class InMemoryAnsweringStore implements AnsweringStore {
  private state: StoreState;
  private tail: Promise<void> = Promise.resolve();

  /** A store that takes ownership of freshly decoded records instead of cloning them. */
  static adopt(snapshot: AnsweringStoreSnapshot): InMemoryAnsweringStore {
    return new InMemoryAnsweringStore(snapshot, true);
  }

  constructor(snapshot?: AnsweringStoreSnapshot, owned = false) {
    this.state = emptyState();
    const copy = owned ? <T>(value: T): T => value : clone;
    if (snapshot) {
      for (const task of snapshot.tasks) this.state.tasks.set(task.taskId, copy(task));
      for (const revision of snapshot.revisions) this.state.revisions.set(revision.revisionId, copy(revision));
      for (const group of snapshot.evidence) this.state.evidence.set(group.taskId, new Map(group.items.map((item) => [item.id, copy(item)])));
      for (const group of snapshot.attempts ?? []) this.state.attempts.set(group.taskId, new Map(group.items.map((item) => [item.attemptId, copy(item)])));
      for (const candidate of snapshot.candidates) this.state.candidates.set(candidate.candidateId, copy(candidate));
      for (const receipt of snapshot.receipts) this.state.receipts.set(receipt.receiptId, copy(receipt));
    }
  }

  async transact<T>(command: (state: AnsweringTransaction) => T | Promise<T>, context: BusinessContext): Promise<T> {
    assertContext(context);
    const run = async (): Promise<T> => {
      assertContext(context);
      const next = overlayState(this.state);
      const result = await command(createTransaction(next.view));
      assertContext(context);
      next.commit();
      return result;
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async readTaskBundle(taskId: TaskId, context: BusinessContext): Promise<TaskBundle | undefined> {
    assertContext(context);
    await this.tail;
    const task = this.state.tasks.get(taskId);
    if (!task || !taskVisible(task, context)) return undefined;
    const currentRevision = this.state.revisions.get(task.currentRevisionId);
    if (!currentRevision) throw new Error("ANSWERING_REVISION_MISSING");
    const attempts = [...(this.state.attempts.get(taskId)?.values() ?? [])];
    const candidate = task.latestCandidateId ? this.state.candidates.get(task.latestCandidateId) : undefined;
    const publication = task.publicationId ? this.state.receipts.get(task.publicationId) : undefined;
    return clone({ task, currentRevision, attempts, ...(candidate ? { candidate } : {}), ...(publication ? { publication } : {}) });
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

export function assertTaskAccess(task: QueryTaskRecord | undefined, context: BusinessContext): asserts task is QueryTaskRecord {
  assertContext(context);
  if (!task || !taskVisible(task, context)) throw new AnsweringError("TASK_NOT_FOUND", "ANSWERING_TASK_NOT_FOUND");
}
