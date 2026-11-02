import { describe, expect, it } from "vitest";
import { createRuntimeServer } from "./index.js";
import { DataAgentRuntime } from "@data-agent/runtime/testing";

const trustedWebContext = { contextFactory: () => ({ userId: "web-dev", host: "web" as const }) };

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("runtime event stream", () => {
  it("replays events after a sequence cursor with SSE ids", async () => {
    const runtime = new DataAgentRuntime();
    await runtime.dispatch({ protocolVersion: 1, requestId: "probe-1", command: { type: "runtime.probe" } }, { userId: "web-dev", host: "web" });
    await runtime.dispatch({ protocolVersion: 1, requestId: "probe-2", command: { type: "runtime.probe" } }, { userId: "web-dev", host: "web" });
    const app = await createRuntimeServer(runtime, trustedWebContext);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/api/runtime/events?after_sequence=1`);
      const reader = response.body!.getReader();
      const chunk = await readUntil(reader, (text) => text.includes("id: 2"));
      expect(chunk).toContain("id: 2");
      expect(chunk).toContain('"requestId":"probe-2"');
      expect(chunk).not.toContain('"requestId":"probe-1"');
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it("answers at once so the client knows its subscription exists before any event", async () => {
    const runtime = new DataAgentRuntime();
    const app = await createRuntimeServer(runtime, trustedWebContext);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/api/runtime/events`);
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();
      await runtime.dispatch({ protocolVersion: 1, requestId: "after-connect", command: { type: "runtime.probe" } }, { userId: "web-dev", host: "web" });
      expect(await readUntil(reader, (text) => text.includes("after-connect"))).toContain('"requestId":"after-connect"');
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it("asks the client to resynchronize instead of replaying past evicted events", async () => {
    const runtime = new DataAgentRuntime();
    for (let index = 0; index < 300; index += 1) {
      await runtime.dispatch({ protocolVersion: 1, requestId: `probe-${index}`, command: { type: "runtime.probe" } }, { userId: "web-dev", host: "web" });
    }
    const app = await createRuntimeServer(runtime, trustedWebContext);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/api/runtime/events?after_sequence=3`);
      const reader = response.body!.getReader();
      const text = await readUntil(reader, (value) => value.includes("event: resync"));
      expect(text).toContain('event: resync\ndata: {"afterSequence":3,"latestSequence":300}');
      expect(text).not.toContain("id: ");
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it("asks a client whose cursor predates a server restart to resynchronize", async () => {
    const runtime = new DataAgentRuntime();
    const app = await createRuntimeServer(runtime, trustedWebContext);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/api/runtime/events?after_sequence=5000`);
      const reader = response.body!.getReader();
      const text = await readUntil(reader, (value) => value.includes("event: resync"));
      expect(text).toContain('event: resync\ndata: {"afterSequence":5000,"latestSequence":0}');
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it("keeps an idle stream alive with comment heartbeats", async () => {
    const runtime = new DataAgentRuntime();
    const app = await createRuntimeServer(runtime, { ...trustedWebContext, eventHeartbeatMs: 20 });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const response = await fetch(`${address}/api/runtime/events`);
      const reader = response.body!.getReader();
      const text = await readUntil(reader, (value) => value.split(": heartbeat").length > 2);
      expect(text.split(": heartbeat").length).toBeGreaterThan(2);
      await reader.cancel();
    } finally {
      await app.close();
    }
  });

  it("broadcasts emitted events to SSE subscribers", async () => {
    const runtime = new DataAgentRuntime();
    const app = await createRuntimeServer(runtime, trustedWebContext);
    await app.ready();

    const received: unknown[] = [];
    const unsubscribe = runtime.subscribe((envelope) => received.push(envelope), { userId: "web-dev" });
    await runtime.dispatch({ protocolVersion: 1, requestId: "broadcast", command: { type: "runtime.probe" } }, { userId: "web-dev", host: "web" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ requestId: "broadcast", event: { type: "runtime.probe.completed" } });
    unsubscribe();
    await app.close();
  });
});
