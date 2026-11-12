/** An error's message, bounded so a child's failure cannot flood its parent's record. */
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}

/** Settles with the promise, or rejects with the signal's reason (else `abortCode`) once it aborts. */
export async function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal, abortCode: string): Promise<T> {
  const abortError = () => signal.reason instanceof Error ? signal.reason : new Error(abortCode);
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw abortError();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
