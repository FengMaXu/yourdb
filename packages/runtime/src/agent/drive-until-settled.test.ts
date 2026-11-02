import { describe, expect, it, vi } from "vitest";
import { TODO_CONTEXT, type AgentLane } from "@earendil-works/pi-agent-core";
import { driveUntilSettled } from "./drive-until-settled.js";

type DriveResult = Awaited<ReturnType<AgentLane["drive"]>>;

const waitingRetry = (notBefore: number) => ({ ok: true, value: { kind: "waiting", operationId: "op-1", reason: "retry", notBefore } }) as unknown as DriveResult;
const waitingDeferred = () => ({ ok: true, value: { kind: "waiting", operationId: "op-1", reason: "deferred", deferred: { pollAfterMs: 20 } } }) as unknown as DriveResult;
const settled = (status: string) => ({ ok: true, value: { kind: "settled", outcome: { status } } }) as unknown as DriveResult;

function laneReturning(...results: DriveResult[]) {
  const drive = vi.fn(async () => results.shift() ?? settled("completed"));
  return { lane: { drive } as unknown as Pick<AgentLane, "drive">, drive };
}

describe("driveUntilSettled", () => {
  it("drives again after a retry wait and deferred work until the operation settles", async () => {
    const { lane, drive } = laneReturning(waitingRetry(Date.now() + 5), waitingDeferred(), settled("completed"));
    const result = await driveUntilSettled(lane, "op-1", TODO_CONTEXT);
    expect(result).toEqual(settled("completed"));
    expect(drive).toHaveBeenCalledTimes(3);
  });

  it("continues from a first drive the caller already made, e.g. recovery that ended in a retry wait", async () => {
    // A cancellation requested meanwhile settles on the next drive, as aborted.
    const { lane, drive } = laneReturning(settled("aborted"));
    const result = await driveUntilSettled(lane, "op-1", TODO_CONTEXT, { first: waitingRetry(Date.now()) });
    expect(result).toEqual(settled("aborted"));
    expect(drive).toHaveBeenCalledTimes(1);
  });

  it("does not drive again once the first drive settled", async () => {
    const { lane, drive } = laneReturning();
    expect(await driveUntilSettled(lane, "op-1", TODO_CONTEXT, { first: settled("completed") })).toEqual(settled("completed"));
    expect(drive).not.toHaveBeenCalled();
  });

  it("waits at least 50 ms and at most a second between drives", async () => {
    vi.useFakeTimers();
    try {
      // A retry already due, then one a minute away: neither spins nor sleeps past a second.
      const { lane, drive } = laneReturning(waitingRetry(Date.now() - 1_000), waitingRetry(Date.now() + 60_000), settled("completed"));
      const done = driveUntilSettled(lane, "op-1", TODO_CONTEXT);
      await vi.advanceTimersByTimeAsync(0);
      expect(drive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(49);
      expect(drive).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(drive).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(drive).toHaveBeenCalledTimes(3);
      await expect(done).resolves.toEqual(settled("completed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops driving when told to, leaving the operation as it is", async () => {
    const stop = new AbortController();
    const { lane, drive } = laneReturning(waitingRetry(Date.now() + 10), waitingRetry(Date.now() + 10));
    const done = driveUntilSettled(lane, "op-1", TODO_CONTEXT, { stop: stop.signal });
    stop.abort();
    const result = await done;
    expect(result.ok && result.value.kind).toBe("waiting");
    expect(drive).toHaveBeenCalledTimes(1);
  });
});
