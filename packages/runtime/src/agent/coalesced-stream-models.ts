import type { AssistantMessage, AssistantMessageEvent, Models } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** How long consecutive text or thinking deltas are gathered into one event. */
export const DELTA_COALESCE_MS = 80;

type CoalescibleDelta = Extract<AssistantMessageEvent, { type: "text_delta" | "thinking_delta" }>;

const coalescible = (event: AssistantMessageEvent): event is CoalescibleDelta => event.type === "text_delta" || event.type === "thinking_delta";

/**
 * Gathers runs of text and thinking deltas of one content block into a single
 * delta, for up to `windowMs`. Pi stores every streamed event as its own
 * durable frame in the session file (to recover a response after a crash), so
 * a provider that streams a token per event wrote about a thousand frames per
 * reply: 20 MB of the 84 MB session in the Olist test. A gathered delta is
 * the concatenation of its parts, so the frames and the final message are the
 * same, only fewer.
 *
 * Tool-call deltas pass through as they come: Pi checks the arguments parsed
 * after each of them while it catches up, and joining them could change that.
 *
 * `failed` builds the error message for a source that throws instead of
 * ending with an error event, so the stream's result still settles.
 */
export function coalesceDeltas(
  source: AsyncIterable<AssistantMessageEvent>,
  failed: (message: string, partial: AssistantMessage | undefined) => AssistantMessage,
  windowMs = DELTA_COALESCE_MS,
): AssistantMessageEventStream {
  const out = new AssistantMessageEventStream();
  let pending: CoalescibleDelta | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let partial: AssistantMessage | undefined;
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (pending) out.push(pending);
    pending = undefined;
  };
  void (async () => {
    try {
      for await (const event of source) {
        if ("partial" in event) partial = event.partial;
        if (coalescible(event)) {
          if (pending && pending.type === event.type && pending.contentIndex === event.contentIndex) {
            pending = { ...pending, delta: pending.delta + event.delta, partial: event.partial };
            continue;
          }
          flush();
          pending = event;
          timer = setTimeout(flush, windowMs);
          continue;
        }
        flush();
        out.push(event);
      }
      flush();
      out.end();
    } catch (error) {
      flush();
      out.push({ type: "error", reason: "error", error: failed(error instanceof Error ? error.message : String(error), partial) });
    }
  })();
  return out;
}

/** Models whose streamed replies arrive with their text and thinking deltas gathered (see coalesceDeltas). */
export function withCoalescedDeltas(source: Models, windowMs = DELTA_COALESCE_MS): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => coalesceDeltas(
    source.streamSimple(model, context, options),
    (message, partial) => ({
      ...(partial ?? {
        role: "assistant" as const,
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      }),
      stopReason: "error",
      errorMessage: message,
    }),
    windowMs,
  );
  return new Proxy(source, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
