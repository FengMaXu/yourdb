import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";

type DriveResult = Awaited<ReturnType<AgentLane["drive"]>>;

/**
 * Waits between drives: at most a second, so a Stop requested during a long
 * retry wait is reconciled within a second (cancellation takes effect inside
 * a drive); at least 50 ms, so a wait whose time has already passed cannot
 * spin.
 */
const MAX_WAIT_MS = 1_000;
const MIN_WAIT_MS = 50;

/**
 * Drives an operation until it settles. Pi reports a scheduled retry (or
 * deferred work) as `waiting`, and the work only resumes when the caller
 * drives again; a cancellation also takes effect only inside a drive. So a
 * caller that drives once and stops at `waiting` strands the operation: no
 * retry ever runs, and Stop can never settle it.
 *
 * `stop` ends the loop without touching the operation (e.g. its session is
 * closing); the last result is returned.
 */
export async function driveUntilSettled(
  lane: Pick<AgentLane, "drive">,
  operationId: string,
  context: Context,
  options: { readonly first?: DriveResult; readonly stop?: AbortSignal } = {},
): Promise<DriveResult> {
  let driven = options.first ?? await lane.drive({ operationId }, context);
  while (driven.ok && driven.value.kind === "waiting" && !options.stop?.aborted) {
    const due = driven.value.reason === "retry"
      ? driven.value.notBefore - Date.now()
      : driven.value.deferred.pollAfterMs ?? 250;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(Math.max(due, MIN_WAIT_MS), MAX_WAIT_MS)));
    if (options.stop?.aborted) break;
    driven = await lane.drive({ operationId }, context);
  }
  return driven;
}
