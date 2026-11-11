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
const hello = (instanceId: string, latestSequence: number) => `event: hello\ndata: ${JSON.stringify({ instanceId, latestSequence })}\n\n`;
const urlOf = (call: number) => apiFetch.mock.calls[call]![0] as URL;

describe("runtime event stream subscription", () => {
  afterEach(() => { apiFetch.mockReset(); });

  it("reports the connection, forwards data and turns a resync event into a snapshot request", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([": connected\n\n", hello("i-1", 9), "event: resync\ndata: {\"afterSequence\":3}\n\n", `id: 9\ndata: ${envelope(9)}\n\n`]));
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
    expect(states[0]).toBe("reconnecting");
    expect(errors).toHaveBeenCalledWith("[runtime-events] event listener failed", expect.any(Error));
    errors.mockRestore();
    unsubscribe();
  });

  it("resumes after the server's latest event once told to resync for evicted events", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([hello("i-1", 300), "event: resync\ndata: {\"afterSequence\":3,\"latestSequence\":300,\"reason\":\"evicted\"}\n\n"]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const onResync = vi.fn();
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { afterSequence: 3, onResync });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(urlOf(0).searchParams.get("after_sequence")).toBe("3");
    expect(urlOf(1).searchParams.get("after_sequence")).toBe("300");
    expect(urlOf(1).searchParams.get("instance")).toBe("i-1");
    expect(onResync).toHaveBeenCalledWith("evicted");
    unsubscribe();
  });

  it("sends its cursor with the instance that issued it, and resyncs when the server reports a restart", async () => {
    // The snapshot's cursor 120 came from instance "old"; the server is now "new", already past 120.
    apiFetch.mockResolvedValueOnce(streamOf([hello("new", 200), "event: resync\ndata: {\"afterSequence\":120,\"latestSequence\":200,\"reason\":\"restarted\"}\n\n"]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const onResync = vi.fn();
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { afterSequence: 120, afterInstance: "old", onResync });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(urlOf(0).searchParams.get("after_sequence")).toBe("120");
    expect(urlOf(0).searchParams.get("instance")).toBe("old");
    expect(onResync).toHaveBeenCalledWith("restarted");
    expect(urlOf(1).searchParams.get("after_sequence")).toBe("200");
    expect(urlOf(1).searchParams.get("instance")).toBe("new");
    unsubscribe();
  });

  it("keeps the old instance with its cursor when the connection drops between hello and resync", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([hello("new", 3)]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const onResync = vi.fn();
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { afterSequence: 5000, afterInstance: "old", onResync });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    // The cursor still belongs to "old", so the server will still see the restart.
    expect(urlOf(1).searchParams.get("after_sequence")).toBe("5000");
    expect(urlOf(1).searchParams.get("instance")).toBe("old");
    expect(onResync).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("retries a 404, which a proxy may answer while the server restarts", async () => {
    apiFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const states: string[] = [];
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { onConnectionChange: (state) => states.push(state) });
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(states).toEqual(["reconnecting"]);
    unsubscribe();
  });

  it("stops and reports rejected when the server refuses the subscription", async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 403 }));
    const states: string[] = [];
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1", { onConnectionChange: (state) => states.push(state) });
    await vi.waitFor(() => expect(states).toEqual(["rejected"]));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("starts a fresh subscription from the server's latest event, with a cursor of 0 kept explicit", async () => {
    apiFetch.mockResolvedValueOnce(streamOf([hello("i-1", 0)]));
    apiFetch.mockImplementation(() => new Promise(() => undefined));
    const unsubscribe = subscribeRuntimeEvents(() => undefined, "session-1");
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(urlOf(0).searchParams.has("after_sequence")).toBe(false);
    expect(urlOf(1).searchParams.get("after_sequence")).toBe("0");
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

      // A server that answers and drops at once, without its first event, is still down.
      apiFetch.mockReset();
      apiFetch.mockImplementation(() => Promise.resolve(streamOf([": connected\n\n"])));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(states).not.toContain("connected");
      expect(states.at(-1)).toBe("disconnected");

      // The server is back: its first event reports connected and the delay starts over.
      apiFetch.mockImplementation(() => Promise.resolve(streamOf([": connected\n\n", hello("i-2", 0)])));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states.at(-2)).toBe("connected");
      const calls = apiFetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(apiFetch.mock.calls.length).toBe(calls + 1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
