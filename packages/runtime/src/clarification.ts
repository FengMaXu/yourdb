import { randomUUID } from "node:crypto";

export interface PendingClarification {
  clarificationId: string;
  sessionId: string;
  question: string;
  options: string[];
  resolve: (answer: string) => void;
  timer?: ReturnType<typeof setTimeout>;
}

type ClarificationOutcome = "answered" | "expired" | "cancelled";

export interface ClarificationListener {
  asked?(request: { clarificationId: string; sessionId: string; question: string; options: string[] }): void;
  settled?(clarificationId: string, outcome: ClarificationOutcome, context: { sessionId: string }): void;
}

/**
 * One pending clarification per session: a new question cancels the previous
 * one. Waits live in the runtime (surviving renderer disconnects), expire on
 * timeout, are cancelled by stop/abort, and end with the process. Answers are
 * not kept here: the asking Session records them (ClarificationDialogs' ledger).
 */
export class ClarificationManager {
  private readonly pending = new Map<string, PendingClarification>();
  private readonly listeners = new Set<ClarificationListener>();

  constructor(private readonly defaultTimeoutMs = 10 * 60 * 1000) {}

  ask(sessionId: string, question: string, options: string[], timeoutMs?: number): { clarificationId: string; promise: Promise<string> } {
    this.cancel(sessionId, "cancelled");
    const clarificationId = randomUUID();
    let resolve!: (answer: string) => void;
    const promise = new Promise<string>((res) => { resolve = res; });
    const entry: PendingClarification = { clarificationId, sessionId, question, options, resolve };
    entry.timer = setTimeout(() => {
      if (this.pending.get(clarificationId) !== entry) return;
      this.pending.delete(clarificationId);
      resolve("");
      this.notifySettled(clarificationId, "expired", { sessionId: entry.sessionId });
    }, timeoutMs ?? this.defaultTimeoutMs);
    this.pending.set(clarificationId, entry);
    for (const listener of this.listeners) listener.asked?.({ clarificationId, sessionId, question, options });
    return { clarificationId, promise };
  }

  /**
   * The manager is shared by every Session of an application, so observers
   * register instead of assigning a single hook one Session could overwrite.
   */
  subscribe(listener: ClarificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The clarification a Session is currently waiting on, if any. */
  pendingFor(sessionId: string): { readonly clarificationId: string; readonly question: string; readonly options: readonly string[] } | undefined {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return { clarificationId: entry.clarificationId, question: entry.question, options: [...entry.options] };
    }
    return undefined;
  }

  private notifySettled(clarificationId: string, outcome: ClarificationOutcome, context: { sessionId: string }): void {
    for (const listener of this.listeners) listener.settled?.(clarificationId, outcome, context);
  }

  answer(clarificationId: string, answer: string): boolean {
    const entry = this.pending.get(clarificationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(clarificationId);
    entry.resolve(answer);
    this.notifySettled(clarificationId, "answered", { sessionId: entry.sessionId });
    return true;
  }

  cancelById(clarificationId: string, outcome: "cancelled" | "expired" = "cancelled"): boolean {
    const entry = this.pending.get(clarificationId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(clarificationId);
    entry.resolve("");
    this.notifySettled(clarificationId, outcome, { sessionId: entry.sessionId });
    return true;
  }

  cancel(sessionId: string, outcome: "cancelled" | "expired" = "cancelled"): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.sessionId === sessionId) this.cancelById(id, outcome);
    }
  }
}
