/**
 * Answering storage entry point for the composition root and storage
 * adapters only (application/, adapters/). Domain callers go through
 * public.ts; the architecture gate enforces both boundaries.
 */
export {
  ANSWERING_SNAPSHOT_VERSION,
  InMemoryAnsweringStore,
  assertTaskAccess,
  type AnsweringStore,
  type AnsweringStoreSnapshot,
  type AnsweringTransaction,
  type TaskBundle,
} from "./answering-store.js";
export { FileResultStore, InMemoryResultStore, type ReconcileOptions, type ResultStore } from "./result-store.js";
export type { BusinessContext, PublicationId, QueryTaskRecord, ResultCandidateRecord, TaskId } from "./model.js";
