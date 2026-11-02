import type {
  AgentHarness,
  AgentLane,
  DriveOutcome,
  LaneExecutionInfo,
  LaneSnapshot,
  OperationAdmission,
  WatchHandle,
} from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { driveUntilSettled } from "../agent/drive-until-settled.js";

export interface AgentControllerContext {
  readonly pi: Context;
}

export interface PromptRequest {
  readonly prompt: string;
  readonly operationId?: string;
}

export interface QueueRequest {
  readonly message: string;
}

export interface OperationResponse {
  readonly operationId: string;
  readonly status: "accepted" | "resumed";
}

export interface QueueResponse {
  readonly entryId: string;
}

export interface AgentController {
  prompt(request: PromptRequest, context: AgentControllerContext): Promise<OperationResponse>;
  requestAbort(operationId: string, context: AgentControllerContext): Promise<void>;
  steer(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse>;
  followUp(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse>;
  nextRun(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse>;
  cancelQueued(entryId: string, context: AgentControllerContext): Promise<"cancelled" | "already_consumed" | "not_found">;
  resume(context: AgentControllerContext): Promise<OperationResponse>;
  inspect(context: AgentControllerContext): Promise<LaneExecutionInfo>;
  watch(context: AgentControllerContext): Promise<WatchHandle<LaneSnapshot>>;
}

export class AgentControllerError extends Error {
  readonly code: "ADMISSION_REJECTED" | "DRIVE_REJECTED" | "ABORT_REJECTED" | "QUEUE_REJECTED" | "RESUME_REJECTED";
  /** Admission was refused only because the lane already runs an operation. */
  readonly busy: boolean;

  constructor(code: AgentControllerError["code"], message: string, options: { readonly busy?: boolean } = {}) {
    super(message);
    this.name = "AgentControllerError";
    this.code = code;
    this.busy = options.busy ?? false;
  }
}

function resultError(result: { readonly error?: { readonly message?: string } }): string {
  return result.error?.message ?? "Pi operation failed";
}

/**
 * Native Pi 0.85 adapter. It deliberately keeps no active-run/status mirror:
 * Pi's AgentLane is the only authority for admission, drive, cancellation,
 * recovery, and watch snapshots.
 */
export class PiAgentController implements AgentController {
  private readonly lanePromise: Promise<AgentLane>;

  constructor(
    harness: AgentHarness<any>,
    laneName: string,
    private readonly baseActiveToolNames: readonly string[],
    private readonly onDriveError?: (error: unknown) => void,
    private readonly onAccepted?: (admission: OperationAdmission, context: AgentControllerContext) => void | Promise<void>,
  ) {
    this.lanePromise = harness.lane(laneName, this.contextForConstruction());
  }

  private contextForConstruction(): Context {
    // The caller-provided Context is used for every operation. This context is
    // only needed to resolve the configured lane and is intentionally
    // cancellation-free.
    return { abortSignal: undefined, value: () => undefined, toString: () => "data-agent-controller" };
  }

  private async lane(): Promise<AgentLane> { return this.lanePromise; }

  async prompt(request: PromptRequest, context: AgentControllerContext): Promise<OperationResponse> {
    const lane = await this.lane();
    await lane.setActiveTools([...this.baseActiveToolNames], context.pi);
    const admission = await lane.accept({ kind: "prompt", prompt: request.prompt, ...(request.operationId ? { operationId: request.operationId } : {}) }, context.pi);
    if (!admission.ok) throw new AgentControllerError("ADMISSION_REJECTED", resultError(admission), { busy: (admission.error as { readonly _tag?: string } | undefined)?._tag === "LaneBusy" });
    try {
      await this.onAccepted?.(admission.value, context);
    } catch (error) {
      await lane.requestAbort(admission.value.operationId, context.pi).catch(() => undefined);
      await this.drive(admission.value, context).catch(() => undefined);
      throw error;
    }
    void this.drive(admission.value, context);
    return { operationId: admission.value.operationId, status: "accepted" };
  }

  /**
   * Continues an operation restored from the Session (recovery after a stop of
   * the host): binds it as an accepted one, then drives it until it settles,
   * like a prompt's operation. An operation that is no prompted run (e.g. a
   * compaction) has no request message to bind and is driven as it is.
   */
  async recover(operationId: string, context: AgentControllerContext, stop?: AbortSignal): Promise<DriveOutcome | undefined> {
    const admission = { operationId } as OperationAdmission;
    try {
      await this.onAccepted?.(admission, context);
    } catch {
      // Nothing to bind: the operation keeps the request it already had.
    }
    return this.drive(admission, context, stop);
  }

  /** Drives the operation to a terminal result (see driveUntilSettled). */
  private async drive(admission: OperationAdmission, context: AgentControllerContext, stop?: AbortSignal): Promise<DriveOutcome | undefined> {
    const lane = await this.lane();
    const driven = await driveUntilSettled(lane, admission.operationId, context.pi, stop ? { stop } : {});
    if (stop?.aborted) return undefined;
    if (!driven.ok) {
      const error = new AgentControllerError("DRIVE_REJECTED", resultError(driven));
      this.onDriveError?.(error);
      return undefined;
    }
    return driven.value;
  }

  async requestAbort(operationId: string, context: AgentControllerContext): Promise<void> {
    const result = await (await this.lane()).requestAbort(operationId, context.pi);
    if (!result.ok) throw new AgentControllerError("ABORT_REJECTED", resultError(result));
  }

  async steer(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse> {
    const result = await (await this.lane()).steer(request.message, undefined, context.pi);
    if (!result.ok) throw new AgentControllerError("QUEUE_REJECTED", resultError(result));
    return result.value;
  }

  async followUp(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse> {
    const result = await (await this.lane()).followUp(request.message, undefined, context.pi);
    if (!result.ok) throw new AgentControllerError("QUEUE_REJECTED", resultError(result));
    return result.value;
  }

  async nextRun(request: QueueRequest, context: AgentControllerContext): Promise<QueueResponse> {
    const result = await (await this.lane()).nextRun(request.message, undefined, context.pi);
    if (!result.ok) throw new AgentControllerError("QUEUE_REJECTED", resultError(result));
    return result.value;
  }

  async cancelQueued(entryId: string, context: AgentControllerContext): Promise<"cancelled" | "already_consumed" | "not_found"> {
    const result = await (await this.lane()).cancelQueued(entryId, context.pi);
    if (!result.ok) throw new AgentControllerError("QUEUE_REJECTED", resultError(result));
    return result.value.kind;
  }

  async resume(context: AgentControllerContext): Promise<OperationResponse> {
    const result = await (await this.lane()).resume(context.pi);
    if (!result.ok) throw new AgentControllerError("RESUME_REJECTED", resultError(result));
    return { operationId: result.value.operationId, status: "resumed" };
  }

  async inspect(context: AgentControllerContext): Promise<LaneExecutionInfo> {
    return (await this.lane()).inspectExecution(context.pi);
  }

  async watch(context: AgentControllerContext): Promise<WatchHandle<LaneSnapshot>> {
    return (await this.lane()).watch(context.pi);
  }
}

export async function createPiAgentController(
  harness: AgentHarness<any>,
  context: AgentControllerContext,
  laneName = "main",
  baseActiveToolNames: readonly string[] = [],
  onDriveError?: (error: unknown) => void,
  onAccepted?: (admission: OperationAdmission, context: AgentControllerContext) => void | Promise<void>,
): Promise<PiAgentController> {
  const controller = new PiAgentController(harness, laneName, baseActiveToolNames, onDriveError, onAccepted);
  await controller.inspect(context);
  return controller;
}
