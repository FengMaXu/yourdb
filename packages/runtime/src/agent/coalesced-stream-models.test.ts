import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { AssistantMessageFrameEncoder, reduceAssistantMessageFrames, type AssistantMessageFrame } from "@earendil-works/pi-ai/utils/assistant-message-frame";
import { coalesceDeltas } from "./coalesced-stream-models.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "test", model: "m", usage, stopReason: "stop", timestamp: 1,
} as AssistantMessage);

/** A streamed reply: thinking, then text, each one token per event, then a tool call, then done. */
function reply(): AssistantMessageEvent[] {
  const thinking = ["Look", " at", " the", " data"];
  const text = ["Revenue", " grew", " 12", "%."];
  const events: AssistantMessageEvent[] = [{ type: "start", partial: message([]) }];
  let thought = "";
  events.push({ type: "thinking_start", contentIndex: 0, partial: message([{ type: "thinking", thinking: "" }]) });
  for (const delta of thinking) {
    thought += delta;
    events.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message([{ type: "thinking", thinking: thought }]) });
  }
  events.push({ type: "thinking_end", contentIndex: 0, content: thought, partial: message([{ type: "thinking", thinking: thought }]) });
  let said = "";
  const base = [{ type: "thinking" as const, thinking: thought }];
  events.push({ type: "text_start", contentIndex: 1, partial: message([...base, { type: "text", text: "" }]) });
  for (const delta of text) {
    said += delta;
    events.push({ type: "text_delta", contentIndex: 1, delta, partial: message([...base, { type: "text", text: said }]) });
  }
  const final = message([...base, { type: "text", text: said }]);
  events.push({ type: "text_end", contentIndex: 1, content: said, partial: final });
  events.push({ type: "done", reason: "stop", message: final });
  return events;
}

async function* stream(events: readonly AssistantMessageEvent[]): AsyncGenerator<AssistantMessageEvent> {
  for (const event of events) yield event;
}

async function collect(source: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const failed = (errorMessage: string, partial: AssistantMessage | undefined): AssistantMessage => ({ ...(partial ?? message([])), stopReason: "error", errorMessage });

function frames(events: readonly AssistantMessageEvent[]): AssistantMessageFrame[] {
  const encoder = new AssistantMessageFrameEncoder();
  return events.flatMap((event) => { const frame = encoder.encode(event); return frame ? [frame] : []; });
}

describe("coalesceDeltas", () => {
  it("joins each run of deltas into one, so far fewer frames rebuild the same message", async () => {
    const original = reply();
    const out = coalesceDeltas(stream(original), failed);
    const gathered = await collect(out);

    expect(gathered.map((event) => event.type)).toEqual(["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"]);
    expect(gathered.find((event) => event.type === "text_delta")).toMatchObject({ delta: "Revenue grew 12%." });
    expect(frames(gathered).length).toBeLessThan(frames(original).length);
    expect(reduceAssistantMessageFrames(frames(gathered))).toEqual(reduceAssistantMessageFrames(frames(original)));
    expect(await out.result()).toEqual(original.at(-1)!.type === "done" ? (original.at(-1) as { message: AssistantMessage }).message : undefined);
  });

  it("lets a gathered delta go after the window, without waiting for the next event", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const events = reply();
      const firstText = events.findIndex((event) => event.type === "text_delta");
      async function* slow(): AsyncGenerator<AssistantMessageEvent> {
        for (const [index, event] of events.entries()) {
          yield event;
          if (index === firstText) await held;
        }
      }
      const out = coalesceDeltas(slow(), failed, 80);
      const seen: AssistantMessageEvent[] = [];
      void (async () => { for await (const event of out) seen.push(event); })();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen.some((event) => event.type === "text_delta")).toBe(false);
      await vi.advanceTimersByTimeAsync(80);
      expect(seen.filter((event) => event.type === "text_delta")).toEqual([expect.objectContaining({ delta: "Revenue" })]);
      release();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes tool-call deltas through one by one", async () => {
    const call = { type: "toolCall" as const, id: "c1", name: "query_database", arguments: {} };
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: message([]) },
      { type: "toolcall_start", contentIndex: 0, partial: message([call]) },
      { type: "toolcall_delta", contentIndex: 0, delta: "{\"sql\":", partial: message([call]) },
      { type: "toolcall_delta", contentIndex: 0, delta: "\"SELECT 1\"}", partial: message([call]) },
    ];
    const gathered = await collect(coalesceDeltas(stream(events), failed));
    expect(gathered.filter((event) => event.type === "toolcall_delta")).toHaveLength(2);
  });

  it("settles with an error when the source throws instead of ending", async () => {
    async function* broken(): AsyncGenerator<AssistantMessageEvent> {
      yield { type: "start", partial: message([]) };
      yield { type: "text_delta", contentIndex: 0, delta: "Half", partial: message([{ type: "text", text: "Half" }]) };
      throw new Error("socket closed");
    }
    const out = coalesceDeltas(broken(), failed);
    const gathered = await collect(out);
    expect(gathered.map((event) => event.type)).toEqual(["start", "text_delta", "error"]);
    expect(await out.result()).toMatchObject({ stopReason: "error", errorMessage: "socket closed", content: [{ type: "text", text: "Half" }] });
  });
});
