import type { Api, AssistantMessage, AssistantMessageEvent, Model, Models } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { assistantFailure, overrideModels } from "./models-overrides.js";

/** How long consecutive text or thinking deltas are gathered into one event. */
export const DELTA_COALESCE_MS = 50;

type CoalescibleDelta = Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>;

const coalescible = (event: AssistantMessageEvent): event is CoalescibleDelta => event.type === "text_delta" || event.type === "thinking_delta";

/** A source stream: its events, and (for an AssistantMessageEventStream) the result it settles with. */
type SourceStream = AsyncIterable<AssistantMessageEvent> & { result?: () => Promise<AssistantMessage> };

/**
 * Gathers runs of text and thinking deltas of one content block into a single
 * delta, for up to `windowMs`. Pi stores every streamed event as its own
 * durable frame in the session file (to recover a response after a crash), so
 * a provider that streams a token per event wrote about a thousand frames per
 * reply: 20 MB of the 84 MB session in the Olist test. A gathered delta is
 * the concatenation of its parts, so the frames and the final message are the
 * same, only fewer. Live consumers see the same text up to `windowMs` later,
 * in larger steps.
 *
 * Tool-call deltas pass through as they come: Pi checks the arguments parsed
 * after each of them while it catches up, and joining them could change that.
 *
 * The stream settles as its source does: with the source's terminal event, or
 * with the source's own result when it ends without one. A source that throws
 * settles it with `failed` (aborted when the request was cancelled).
 */
export function coalesceDeltas(
  source: SourceStream,
  failed: (message: string, partial: AssistantMessage | undefined, aborted: boolean) => AssistantMessage,
  options: { readonly windowMs?: number; readonly signal?: AbortSignal } = {},
): AssistantMessageEventStream {
  const windowMs = options.windowMs ?? DELTA_COALESCE_MS;
  const out = new AssistantMessageEventStream();
  let pending: { first: CoalescibleDelta; parts: string[]; partial: AssistantMessage } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let partial: AssistantMessage | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending) out.push({ ...pending.first, delta: pending.parts.join(""), partial: pending.partial });
    pending = undefined;
  };
  void (async () => {
    try {
      for await (const event of source) {
        if ("partial" in event) partial = event.partial;
        if (coalescible(event)) {
          if (pending && pending.first.type === event.type && pending.first.contentIndex === event.contentIndex) {
            pending.parts.push(event.delta);
            pending.partial = event.partial;
            continue;
          }
          flush();
          pending = { first: event, parts: [event.delta], partial: event.partial };
          timer = setTimeout(flush, windowMs);
          continue;
        }
        flush();
        out.push(event);
      }
      flush();
      // A terminal event already settled the result; a source that ended without one settles it with its own.
      out.end(source.result ? await source.result() : undefined);
    } catch (error) {
      flush();
      const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
      const message = error instanceof Error ? error.message : String(error);
      out.push({ type: "error", reason: aborted ? "aborted" : "error", error: failed(message, partial, aborted) });
    }
  })();
  return out;
}

const failure = (model: Model<Api>) => (message: string, partial: AssistantMessage | undefined, aborted: boolean): AssistantMessage => {
  const stopReason = aborted ? "aborted" : "error";
  return partial ? { ...partial, stopReason, errorMessage: message } : assistantFailure(model, message, stopReason);
};

/** Models whose streamed replies arrive with their text and thinking deltas gathered (see coalesceDeltas). */
export function withCoalescedDeltas(source: Models, windowMs = DELTA_COALESCE_MS): Models {
  return overrideModels(source, {
    streamSimple: (model, context, options) => coalesceDeltas(source.streamSimple(model, context, options), failure(model), { windowMs, ...(options?.signal ? { signal: options.signal } : {}) }),
    // A deferred response resumed later streams through Pi the same way.
    streamDeferred: (model, handle, options) => coalesceDeltas(source.streamDeferred(model, handle, options), failure(model), { windowMs, ...(options?.signal ? { signal: options.signal } : {}) }),
  });
}
