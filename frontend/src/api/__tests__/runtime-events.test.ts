import { afterEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("../client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { subscribeRuntimeEvents } from "../runtime-client";

function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const envelope = (sequence: number) => JSON.stringify({ protocolVersion: 1, sequence, requestId: "r", timestamp: 1, event: { type: "agent.completed" } });

describe("runtime event stream subscription", () => {
  afterEach(() => { apiFetch.mockReset(); });

  it("reports the connection, forwards data and turns a resync event into a snapshot request", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([": connected\n\n", "event: resync\ndata: {\"afterSequence\":3}\n\n", `id: 9\ndata: ${envelope(9)}\n\n`]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const received: unknown[] = [];
    const onConnected = vi.fn();
    const onResync = vi.fn();
    const unsubscribe = subscribeRuntimeEvents((payload) => received.push(payload), "session-1", { onConnected, onResync });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(received[0]).toMatchObject({ sequence: 9 });
    unsubscribe();
  });

  it("does not move the cursor past an event the listener failed on, and reports reconnects", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([`id: 4\ndata: ${envelope(4)}\n\n`, "data: {not json\n\n", `id: 5\ndata: ${envelope(5)}\n\n`]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const states: string[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unsubscribe = subscribeRuntimeEvents((payload) => {
      if ((payload as { sequence: number }).sequence === 5) throw new Error("render failed");
    }, "session-1", { onConnectionChange: (state) => states.push(state) });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    const reconnectUrl = apiFetch.mock.calls[1]![0] as URL;
    expect(reconnectUrl.searchParams.get("after_sequence")).toBe("4");
    expect(states.slice(0, 2)).toEqual(["connected", "reconnecting"]);
    expect(errors).toHaveBeenCalledWith("[runtime-events] event listener failed", expect.any(Error));
    errors.mockRestore();
    unsubscribe();
  });

  it("resumes after the server's latest event once told to resync, e.g. after a server restart", async () => {
    apiFetch.mockResolvedValueOnce(streamOf(["event: resync\ndata: {\"afterSequence\":5000,\"latestSequence\":3}\n\n"]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const onResync = vi.fn();
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { afterSequence: 5000, onResync });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect((apiFetch.mock.calls[0]![0] as URL).searchParams.get("after_sequence")).toBe("5000");
    expect((apiFetch.mock.calls[1]![0] as URL).searchParams.get("after_sequence")).toBe("3");
    expect(onResync).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("backs off between reconnects and reports a long outage as disconnected", async () => {
    vi.useFakeTimers();
    try {
      apiFetch.mockRejectedValue(new TypeError("Failed to fetch"));
      const states: string[] = [];
      const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { onConnectionChange: (state) => states.push(state) });
      const callsAfter = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); return apiFetch.mock.calls.length; };
      expect(await callsAfter(0)).toBe(1);
      expect(await callsAfter(500)).toBe(2); // 0.5 s
      expect(await callsAfter(999)).toBe(2); // then 1 s
      expect(await callsAfter(1)).toBe(3);
      expect(await callsAfter(2_000)).toBe(4); // 2 s
      expect(await callsAfter(4_000)).toBe(5); // 4 s
      expect(await callsAfter(5_000)).toBe(6); // capped at 5 s
      expect(states.every((state) => state === "reconnecting")).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(states.at(-1)).toBe("disconnected");

      // The server is back: the stream reports connected and the delay starts over.
      apiFetch.mockReset();
      apiFetch.mockImplementation(() => Promise.resolve(streamOf([": connected\n\n"])));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states).toContain("connected");
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
