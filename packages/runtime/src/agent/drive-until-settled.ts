import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";

type DriveResult = Awaited<ReturnType<AgentLane["drive"]>>;

/**
 * Drives an operation until it settles. Pi reports a scheduled retry (or
 * deferred work) as `waiting`, and the work only resumes when the caller
 * drives again; a cancellation also takes effect only inside a drive. So a
 * caller that drives once and stops at `waiting` strands the operation: no
 * retry ever runs, and Stop can never settle it.
 */
export async function driveUntilSettled(
  lane: Pick<AgentLane, "drive">,
  operationId: string,
  context: Context,
  first?: DriveResult,
): Promise<DriveResult> {
  let driven = first ?? await lane.drive({ operationId }, context);
  while (driven.ok && driven.value.kind === "waiting") {
    const delay = driven.value.reason === "retry"
      ? Math.max(0, driven.value.notBefore - Date.now())
      : Math.max(10, driven.value.deferred.pollAfterMs ?? 250);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 1_000)));
    driven = await lane.drive({ operationId }, context);
  }
  return driven;
}
