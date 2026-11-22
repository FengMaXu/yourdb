import type { Answering, AnsweringStore, BusinessContext, ResultStore } from "../answering/public.js";

/** An unreferenced result object younger than this may still be on its way to a Candidate. */
export const RESULT_RECLAIM_GRACE_MS = 5 * 60_000;

/**
 * Reclaims private result objects that no Candidate references (a failed
 * check, a lost race, a crash before commit). It runs only while no
 * execute/publish/refresh is in flight, and keeps objects younger than the
 * grace period, so an object an execution just wrote is never removed.
 */
export class ResultReclamation {
  private inFlight = 0;
  private running: Promise<readonly string[]> | undefined;

  constructor(
    private readonly options: {
      readonly answeringStore: AnsweringStore;
      readonly resultStore: ResultStore;
      readonly context: () => BusinessContext;
      readonly graceMs?: number;
    },
  ) {}

  /** The Answering use cases that create or read private objects, counted while they run. */
  track(answering: Answering): Answering {
    const counted = <T>(run: () => Promise<T>): Promise<T> => {
      this.inFlight += 1;
      return run().finally(() => { this.inFlight -= 1; });
    };
    return {
      set: (input, context) => answering.set(input, context),
      inspect: (input, context) => answering.inspect(input, context),
      execute: (input, context) => counted(() => answering.execute(input, context)),
      publish: (input, context) => counted(() => answering.publish(input, context)),
      refresh: (input, context) => counted(() => answering.refresh(input, context)),
    };
  }

  /** Remove expired unreferenced objects; skipped (empty) while any result work is in flight. */
  async reclaim(): Promise<readonly string[]> {
    if (this.inFlight > 0) return [];
    this.running ??= (async () => {
      try {
        const context = this.options.context();
        const referenced = (await this.options.answeringStore.listReferencedResultRefs(context)).map((candidate) => candidate.resultRef);
        // Re-check after the read: work that started meanwhile may have written an object.
        if (this.inFlight > 0) return [];
        return (await this.options.resultStore.reconcile(referenced, context, { olderThanMs: this.options.graceMs ?? RESULT_RECLAIM_GRACE_MS })).map(String);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
