import type {
  ChildOutcome,
  ChildOutcomeStatus,
  ChildRecovery,
  DelegationLedgerRecord,
} from "./index.js";

export type StopReason = "timeout" | "cancel" | "close";

export type StopState =
  | { readonly phase: "active" }
  | { readonly phase: "stopping"; readonly reasons: readonly StopReason[] };

export type ChildExecutionState = StopState & { readonly abortRequested: boolean };

export function activeStopState(): StopState {
  return { phase: "active" };
}

export function runningChildExecution(): ChildExecutionState {
  return { phase: "active", abortRequested: false };
}

export function requestStop(state: StopState, reason: StopReason): StopState {
  if (state.phase === "active") return { phase: "stopping", reasons: [reason] };
  return state.reasons.includes(reason) ? state : { phase: "stopping", reasons: [...state.reasons, reason] };
}

export function requestChildStop(state: ChildExecutionState, reason: StopReason): ChildExecutionState {
  const stopped = requestStop(state, reason);
  return { ...stopped, abortRequested: state.abortRequested };
}

export function markAbortRequested(state: ChildExecutionState): ChildExecutionState {
  return state.abortRequested ? state : { ...state, abortRequested: true };
}

export function isStopping(state: StopState): state is Extract<StopState, { readonly phase: "stopping" }> {
  return state.phase === "stopping";
}

export function hasStopReason(state: StopState, reason: StopReason): boolean {
  return state.phase === "stopping" && state.reasons.includes(reason);
}

export function firstStopReason(state: StopState, precedence: readonly StopReason[]): StopReason | undefined {
  return precedence.find((reason) => hasStopReason(state, reason));
}

export type StopOutcomeStatus = Extract<ChildOutcomeStatus, "timed_out" | "cancelled" | "interrupted">;

export function stoppedOutcomeStatus(state: StopState, precedence: readonly StopReason[]): StopOutcomeStatus | undefined {
  const reason = firstStopReason(state, precedence);
  return reason === "timeout" ? "timed_out" : reason === "cancel" ? "cancelled" : reason === "close" ? "interrupted" : undefined;
}

export type DelegationServiceState = "initializing" | "open" | "closing" | "closed";
export type DelegationServiceEvent = "initialized" | "close_started" | "close_finished";

export function transitionDelegationService(state: DelegationServiceState, event: DelegationServiceEvent): DelegationServiceState {
  if (event === "close_started") return state === "closed" ? "closed" : "closing";
  if (event === "close_finished") return "closed";
  return state === "initializing" ? "open" : state;
}

export function isTerminalLedgerRecord(record: DelegationLedgerRecord): boolean {
  return record.state === "settled" || record.state === "interrupted";
}

export function unfinishedLedgerRecords(records: readonly DelegationLedgerRecord[]): readonly DelegationLedgerRecord[] {
  const terminal = new Set(records.filter(isTerminalLedgerRecord).map((record) => record.runId));
  const latest = new Map<string, DelegationLedgerRecord>();
  for (const record of records) latest.set(record.runId, record);
  return [...latest.values()].filter((record) => !terminal.has(record.runId) && (record.state === "reserved" || record.state === "accepted"));
}

export function acceptedLedgerRecord(base: DelegationLedgerRecord, operationId: string, recordedAt: string): DelegationLedgerRecord {
  return { ...base, state: "accepted", operationId, recordedAt };
}

export function terminalLedgerRecord(base: DelegationLedgerRecord, outcome: ChildOutcome, recordedAt: string): DelegationLedgerRecord {
  return {
    ...base,
    state: "settled",
    ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
    status: outcome.status,
    terminalConfirmed: outcome.terminalConfirmed,
    ...(outcome.error ? { error: outcome.error } : {}),
    recordedAt,
  };
}

export function interruptedLedgerRecord(base: DelegationLedgerRecord, recovery: ChildRecovery | undefined, recordedAt: string): DelegationLedgerRecord {
  return {
    ...base,
    state: "interrupted",
    ...(recovery?.operationId ? { operationId: recovery.operationId } : {}),
    status: recovery?.status ?? "interrupted",
    terminalConfirmed: recovery?.terminalConfirmed ?? true,
    ...(recovery?.error ? { error: recovery.error } : {}),
    recordedAt,
  };
}
