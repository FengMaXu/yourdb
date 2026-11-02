import type { Api, AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

/** Models with some methods replaced; every other member is the source's, bound to it. */
export function overrideModels(source: Models, overrides: Partial<Models>): Models {
  return new Proxy(source, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property as keyof Models];
      const member = Reflect.get(target, property);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

/** A failed assistant message for a request that never produced one (no usage, no content). */
export function assistantFailure(model: Model<Api>, errorMessage: string, stopReason: "error" | "aborted" = "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

/** A stream that fails at once, e.g. a request refused before reaching the provider. */
export function failedStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  stream.push({ type: "error", reason: "error", error: assistantFailure(model, errorMessage) });
  return stream;
}
