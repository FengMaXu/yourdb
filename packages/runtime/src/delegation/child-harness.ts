import {
  AgentHarness,
  TODO_CONTEXT,
  withAbortSignal,
  type AgentHarness as NativeAgentHarness,
  type AgentLane,
  type Entry,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { ChildExecutionRequest, ChildExecutor, ChildRecovery, ChildUsage, DelegationLedgerRecord, RawChildExecution } from "./index.js";
import { ToolPromptCatalog } from "../agent/tool-prompt-catalog.js";
import { withToolPromptCatalog } from "../agent/tool-prompt-models.js";
import { withCoalescedDeltas } from "../agent/coalesced-stream-models.js";
import { failedStream, overrideModels } from "../agent/models-overrides.js";
import { infrastructureFailureOf } from "../agent/infrastructure-failure.js";
import { awaitWithSignal, errorText } from "./signals.js";
import {
  firstStopReason,
  isStopping,
  markAbortRequested,
  requestChildStop,
  runningChildExecution,
  stoppedOutcomeStatus,
  type ChildExecutionState,
} from "./lifecycle.js";

/** Explorers answer bounded fact questions; fewer turns keep the parent waiting less. */
const MAX_MODEL_REQUESTS = 10;
const MAX_TOOL_CALLS = 30;
const FINAL_REPORT_INSTRUCTION = "Budget reached: do not call tools. Write the final Markdown report now from the information you have gathered, and list what remains unverified.";
/**
 * Time kept for the final report before the deadline: at the wrap-up moment
 * tools stop and the next request writes the report, so a child that ran out
 * of time still returns what it found instead of nothing.
 */
const WRAP_UP_RESERVE_MS = 30_000;

/** Shared by a child's model wrapper and its tool hook: once set, the next request is the report. */
interface ChildBudget {
  wrapUp: boolean;
}
/** Per-response output cap, including reasoning tokens of reasoning models. */
const MAX_OUTPUT_TOKENS = 10_240;

export interface ChildSessionRepository {
  create(input: { readonly id: string; readonly parentSessionId: string; readonly signal?: AbortSignal }): Promise<Session<any>>;
  open(id: string, signal?: AbortSignal): Promise<Session<any> | undefined>;
  removeOrphans(knownChildSessionIds: ReadonlySet<string>, signal?: AbortSignal): Promise<void>;
}

export interface HarnessChildExecutorOptions {
  readonly sessions: ChildSessionRepository;
  readonly models: Models;
  readonly model: Model<any>;
}

interface RunningChild {
  readonly completion: Promise<RawChildExecution>;
  abort(reason: "cancel" | "close" | "timeout"): Promise<void>;
}

/** Entries must be ordered newest first; the latest assistant text is the child's report. */
function finalAssistantText(newestFirst: readonly Entry[]): string | undefined {
  for (const entry of newestFirst) {
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * The child model must declare the same output limit that boundedModels
 * enforces. Otherwise Pi sees a length stop below the declared limit and
 * misclassifies it as a context overflow.
 */
function childModel(model: Model<any>): Model<any> {
  const declared = model.maxTokens > 0 ? model.maxTokens : MAX_OUTPUT_TOKENS;
  return { ...model, maxTokens: Math.min(declared, MAX_OUTPUT_TOKENS) };
}

function boundedModels(source: Models, budget: ChildBudget = { wrapUp: false }): Models {
  let requests = 0;
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    requests += 1;
    if (requests > MAX_MODEL_REQUESTS) return failedStream(model, "SUBAGENT_MODEL_REQUEST_BUDGET_EXHAUSTED");
    const requested = options?.maxTokens ?? model.maxTokens;
    const maxTokens = requested > 0 ? Math.min(requested, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;
    // The last allowed request, or the first after wrap-up, has no tools, so gathered information always becomes a report.
    const finalContext = requests === MAX_MODEL_REQUESTS || budget.wrapUp
      ? { ...context, tools: [], systemPrompt: `${context.systemPrompt ?? ""}\n\n${FINAL_REPORT_INSTRUCTION}` }
      : context;
    return source.streamSimple(model, finalContext, { ...options, maxTokens });
  };
  // Pi resolves the generation model through the registry and derives the
  // intended output limit from it, so the cap must be visible here too.
  const getModel: Models["getModel"] = (provider, modelId) => {
    const model = source.getModel(provider, modelId);
    return model ? childModel(model) : model;
  };
  return overrideModels(source, { streamSimple, getModel });
}

function nullUsage(): ChildUsage {
  return { inputTokens: null, outputTokens: null, cost: null };
}

export class HarnessChildExecutor implements ChildExecutor {
  private readonly running = new Map<string, RunningChild>();
  private readonly active = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly options: HarnessChildExecutorOptions) {}

  async reconcile(records: readonly DelegationLedgerRecord[], signal?: AbortSignal): Promise<readonly ChildRecovery[]> {
    const latest = new Map<string, DelegationLedgerRecord>();
    for (const record of records) latest.set(record.runId, record);
    const recovery: ChildRecovery[] = [];
    for (const record of latest.values()) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error("SUBAGENT_RECOVERY_CANCELLED"));
      if (record.state === "reserved") {
        recovery.push(await this.reconcileReserved(record, signal));
      } else if (record.state === "accepted") {
        const operationId = record.operationId;
        if (operationId) recovery.push(await this.reconcileAccepted({ ...record, operationId }, signal));
        else recovery.push({ runId: record.runId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_ACCEPTED_OPERATION_ID_MISSING" });
      }
    }
    await this.options.sessions.removeOrphans(new Set(records.map((record) => record.childSessionId)), signal);
    return recovery;
  }

  private async reconcileReserved(record: DelegationLedgerRecord, signal?: AbortSignal): Promise<ChildRecovery> {
    const recoveryContext = signal ? withAbortSignal(signal, TODO_CONTEXT) : TODO_CONTEXT;
    const session = await this.options.sessions.open(record.childSessionId, signal);
    if (!session) return { runId: record.runId, status: "interrupted", terminalConfirmed: true };
    let harness: NativeAgentHarness<any> | undefined;
    try {
      const created = await AgentHarness.create({
        session,
        models: boundedModels(this.options.models),
        model: childModel(this.options.model),
        thinkingLevel: "low",
        tools: [],
        activeToolNames: [],
        toolContext: { childSessionId: record.childSessionId, runId: record.runId, role: record.role },
        systemPrompt: "Recovery only: do not resume the child operation.",
        toolExecution: "sequential",
        streamOptions: { maxRetries: 0 },
      }, recoveryContext);
      harness = created.harness;
      const lane = await harness.lane("main", recoveryContext);
      const inspection = await lane.inspectExecution(recoveryContext);
      const operationId = inspection.current?.id;
      if (!operationId) return { runId: record.runId, status: "interrupted", terminalConfirmed: true };
      const requested = await lane.requestAbort(operationId, recoveryContext);
      if (!requested.ok) return { runId: record.runId, operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_RECOVERY_ABORT_REQUEST_FAILED" };
      const driven = await lane.drive({ operationId }, recoveryContext);
      if (driven.ok && driven.value.kind === "settled" && driven.value.outcome.status === "aborted") {
        return { runId: record.runId, operationId, status: "interrupted", terminalConfirmed: true };
      }
      return { runId: record.runId, operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_RECOVERY_ABORT_NOT_SETTLED" };
    } catch (error) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
      return { runId: record.runId, status: "abort_unconfirmed", terminalConfirmed: false, error: errorText(error) };
    } finally {
      if (harness) await harness.close(TODO_CONTEXT).catch(() => undefined);
      else await session.close(TODO_CONTEXT).catch(() => undefined);
    }
  }

  private async reconcileAccepted(record: DelegationLedgerRecord & { readonly operationId: string }, signal?: AbortSignal): Promise<ChildRecovery> {
    const recoveryContext = signal ? withAbortSignal(signal, TODO_CONTEXT) : TODO_CONTEXT;
    const session = await this.options.sessions.open(record.childSessionId, signal);
    if (!session) return { runId: record.runId, operationId: record.operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_CHILD_SESSION_MISSING" };
    let harness: NativeAgentHarness<any> | undefined;
    try {
      const created = await AgentHarness.create({
        session,
        models: boundedModels(this.options.models),
        model: childModel(this.options.model),
        thinkingLevel: "low",
        tools: [],
        activeToolNames: [],
        toolContext: { childSessionId: record.childSessionId, runId: record.runId, role: record.role },
        systemPrompt: "Recovery only: do not resume the child operation.",
        toolExecution: "sequential",
        streamOptions: { maxRetries: 0 },
      }, recoveryContext);
      harness = created.harness;
      const lane = await harness.lane("main", recoveryContext);
      const result = await lane.getResult(record.operationId, recoveryContext);
      if (result?.status === "aborted") return { runId: record.runId, operationId: record.operationId, status: "interrupted", terminalConfirmed: true };
      if (result) return { runId: record.runId, operationId: record.operationId, status: "interrupted", terminalConfirmed: true, error: `SUBAGENT_RECOVERY_RESULT_NOT_DELIVERED:${result.status}` };
      const inspection = await lane.inspectExecution(recoveryContext);
      if (inspection.current?.id === record.operationId) {
        const requested = await lane.requestAbort(record.operationId, recoveryContext);
        if (!requested.ok) return { runId: record.runId, operationId: record.operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_RECOVERY_ABORT_REQUEST_FAILED" };
        const driven = await lane.drive({ operationId: record.operationId }, recoveryContext);
        if (driven.ok && driven.value.kind === "settled" && driven.value.outcome.status === "aborted") {
          return { runId: record.runId, operationId: record.operationId, status: "interrupted", terminalConfirmed: true };
        }
        return { runId: record.runId, operationId: record.operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_RECOVERY_ABORT_NOT_SETTLED" };
      }
      return { runId: record.runId, operationId: record.operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: "SUBAGENT_RECOVERY_OPERATION_NOT_FOUND" };
    } catch (error) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : error);
      return { runId: record.runId, operationId: record.operationId, status: "abort_unconfirmed", terminalConfirmed: false, error: errorText(error) };
    } finally {
      if (harness) await harness.close(TODO_CONTEXT).catch(() => undefined);
      else await session.close(TODO_CONTEXT).catch(() => undefined);
    }
  }

  async execute(request: ChildExecutionRequest): Promise<RawChildExecution> {
    let release!: () => void;
    const tracked = new Promise<void>((resolve) => { release = resolve; });
    this.active.add(tracked);
    try {
      return await this.executeOne(request);
    } finally {
      release();
      this.active.delete(tracked);
    }
  }

  private async executeOne(request: ChildExecutionRequest): Promise<RawChildExecution> {
    if (this.closing) return { status: "interrupted", terminalConfirmed: true, usage: nullUsage(), error: "SUBAGENT_EXECUTOR_CLOSED" };
    if (request.signal?.aborted) return { status: "cancelled", terminalConfirmed: true, usage: nullUsage() };

    let session: Session<any> | undefined;
    let harness: NativeAgentHarness<any> | undefined;
    let operationId: string | undefined;
    let resolveCompletion!: (value: RawChildExecution) => void;
    const completion = new Promise<RawChildExecution>((resolve) => { resolveCompletion = resolve; });
    let outcome: RawChildExecution | undefined;
    let lifecycle: ChildExecutionState = runningChildExecution();
    const executionAbort = new AbortController();
    let lane: AgentLane | undefined;
    let abortPromise: Promise<void> | undefined;
    let infrastructureFailure: string | undefined;

    const abort = (reason: "timeout" | "cancel" | "close"): Promise<void> => {
      lifecycle = requestChildStop(lifecycle, reason);
      executionAbort.abort();
      if (!lane || !operationId) return Promise.resolve();
      if (abortPromise) return abortPromise;
      abortPromise = (async () => {
        const requested = await lane.requestAbort(operationId, TODO_CONTEXT).catch(() => undefined);
        if (requested?.ok === true) lifecycle = markAbortRequested(lifecycle);
      })();
      return abortPromise;
    };
    this.running.set(request.runId, { completion, abort });
    const onAbort = () => { void abort("cancel"); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { void abort("timeout"); }, request.timeoutMs);
    timer.unref?.();
    const budget: ChildBudget = { wrapUp: false };
    const wrapUpAfter = Math.max(0, request.timeoutMs - Math.min(WRAP_UP_RESERVE_MS, Math.floor(request.timeoutMs / 4)));
    const wrapUpAt = Date.now() + wrapUpAfter;
    const wrapUpTimer = setTimeout(() => { budget.wrapUp = true; }, wrapUpAfter);
    wrapUpTimer.unref?.();
    const operationContext = withAbortSignal(executionAbort.signal, TODO_CONTEXT);

    try {
      session = await this.options.sessions.create({ id: request.childSessionId, parentSessionId: request.parentSessionId, signal: executionAbort.signal });
      if (executionAbort.signal.aborted) {
        outcome = { status: stoppedOutcomeStatus(lifecycle, ["timeout", "close", "cancel"]) ?? "cancelled", terminalConfirmed: true, usage: nullUsage() };
        return outcome;
      }
      const tools = request.toolDefinitions.map((definition) => definition.tool);
      const models = withCoalescedDeltas(withToolPromptCatalog(boundedModels(this.options.models, budget), new ToolPromptCatalog(request.toolDefinitions)));
      const created = await AgentHarness.create({
        session,
        models,
        model: childModel(this.options.model),
        // Fact gathering needs tool results, not long reasoning; independent reads run in parallel.
        thinkingLevel: "off",
        tools,
        activeToolNames: tools.map((tool) => tool.name),
        toolContext: { childSessionId: request.childSessionId, runId: request.runId, role: request.role, wrapUpAt },
        systemPrompt: request.systemPrompt,
        toolExecution: "parallel",
        streamOptions: { maxRetries: 0 },
      }, operationContext);
      harness = created.harness;
      let toolCalls = 0;
      harness.hooks.on("before_tool", () => {
        // After wrap-up a call is refused, not run: the model's next request writes the report.
        if (budget.wrapUp) return { block: { reason: "SUBAGENT_TIME_BUDGET_REACHED: write the final report now" } };
        toolCalls += 1;
        return toolCalls > MAX_TOOL_CALLS
          ? { block: { reason: "SUBAGENT_TOOL_CALL_BUDGET_EXHAUSTED", terminate: true } }
          : undefined;
      }, { id: "data-agent-subagent-tool-budget" });
      // A lost database ends the child; its failure text carries the code to the parent.
      harness.hooks.on("after_tool", (event) => {
        const failure = infrastructureFailureOf(event.content);
        if (failure && !infrastructureFailure) {
          infrastructureFailure = failure;
          void abort("cancel");
        }
        return undefined;
      }, { id: "data-agent-subagent-infrastructure-failure" });
      if (request.onToolStarted) {
        const onToolStarted = request.onToolStarted;
        harness.events.on("tool_start", (event) => onToolStarted(event.toolName));
      }
      lane = await harness.lane("main", operationContext);
      if (executionAbort.signal.aborted) {
        outcome = { status: stoppedOutcomeStatus(lifecycle, ["timeout", "close", "cancel"]) ?? "cancelled", terminalConfirmed: true, usage: nullUsage() };
        return outcome;
      }
      const accepted = await lane.accept({ kind: "prompt", prompt: request.prompt }, operationContext);
      if (!accepted.ok) {
        outcome = { status: "failed", terminalConfirmed: true, usage: nullUsage(), error: errorText(accepted.error) };
        return outcome;
      }
      operationId = accepted.value.operationId;
      if (request.onAccepted) {
        try {
          await awaitWithSignal(Promise.resolve(request.onAccepted(operationId, executionAbort.signal)), executionAbort.signal, "SUBAGENT_OPERATION_ABORTED");
        } catch (error) {
          if (!executionAbort.signal.aborted) throw error;
        }
      }
      if (request.signal?.aborted) await abort("cancel");
      if (this.closing) await abort("close");

      let driven = await lane.drive({ operationId }, operationContext).catch((error) => ({ ok: false as const, error }));
      if (!driven.ok && (isStopping(lifecycle) || lifecycle.abortRequested)) {
        await abortPromise?.catch(() => undefined);
        driven = await lane.drive({ operationId }, TODO_CONTEXT).catch((error) => ({ ok: false as const, error }));
      }
      while (driven.ok && driven.value.kind === "waiting" && !isStopping(lifecycle)) {
        const delay = driven.value.reason === "retry"
          ? Math.max(0, driven.value.notBefore - Date.now())
          : Math.max(10, driven.value.deferred.pollAfterMs ?? 250);
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 1_000)));
        driven = await lane.drive({ operationId }, operationContext).catch((error) => ({ ok: false as const, error }));
      }
      if (driven.ok && driven.value.kind === "waiting") {
        await abort(firstStopReason(lifecycle, ["timeout", "cancel", "close"]) ?? "close");
        driven = await lane.drive({ operationId }, TODO_CONTEXT).catch((error) => ({ ok: false as const, error }));
      }

      const stats = await session.getStats(TODO_CONTEXT);
      const usage: ChildUsage = {
        inputTokens: stats.usage.input + stats.usage.cacheRead + stats.usage.cacheWrite,
        outputTokens: stats.usage.output,
        totalTokens: stats.usage.totalTokens,
        cost: null,
      };
      if (!driven.ok) {
        outcome = {
          status: isStopping(lifecycle) || lifecycle.abortRequested ? "abort_unconfirmed" : "failed",
          terminalConfirmed: false,
          operationId,
          usage,
          error: errorText(driven.error),
        };
      } else if (driven.value.kind !== "settled") {
        outcome = { status: "abort_unconfirmed", terminalConfirmed: false, operationId, usage, error: "SUBAGENT_OPERATION_DID_NOT_SETTLE" };
      } else if (driven.value.outcome.status === "aborted") {
        outcome = {
          status: stoppedOutcomeStatus(lifecycle, ["timeout", "cancel", "close"]) ?? "interrupted",
          terminalConfirmed: true,
          operationId,
          usage,
        };
      } else if (driven.value.outcome.status !== "completed") {
        outcome = {
          status: "failed",
          terminalConfirmed: true,
          operationId,
          usage,
          error: driven.value.outcome.error?.message ?? `SUBAGENT_${driven.value.outcome.status.toUpperCase()}`,
        };
      } else {
        // Explicit order: the default scan order is not part of this contract.
        const childText = finalAssistantText(await lane.findEntries({ type: "message", order: "newestFirst" }, TODO_CONTEXT));
        outcome = childText
          ? { status: "completed", terminalConfirmed: true, operationId, text: childText, usage }
          : { status: "failed", terminalConfirmed: true, operationId, usage, error: "SUBAGENT_FINAL_TEXT_MISSING" };
      }
      if (infrastructureFailure) outcome = { status: "failed", terminalConfirmed: outcome.terminalConfirmed, operationId, usage, error: infrastructureFailure };
      return outcome;
    } catch (error) {
      if (operationId) await abort(this.closing ? "close" : request.signal?.aborted ? "cancel" : "close");
      outcome = {
        status: operationId && (isStopping(lifecycle) || lifecycle.abortRequested)
          ? "abort_unconfirmed"
          : stoppedOutcomeStatus(lifecycle, ["timeout", "close", "cancel"]) ?? "failed",
        terminalConfirmed: !operationId,
        ...(operationId ? { operationId } : {}),
        usage: nullUsage(),
        error: errorText(error),
      };
      return outcome;
    } finally {
      clearTimeout(timer);
      clearTimeout(wrapUpTimer);
      request.signal?.removeEventListener("abort", onAbort);
      this.running.delete(request.runId);
      if (harness) await harness.close(TODO_CONTEXT).catch(() => undefined);
      else if (session) await session.close(TODO_CONTEXT).catch(() => undefined);
      resolveCompletion(outcome ?? { status: "failed", terminalConfirmed: false, ...(operationId ? { operationId } : {}), usage: nullUsage(), error: "SUBAGENT_EXECUTION_UNKNOWN" });
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      await Promise.all([...this.active]);
      return;
    }
    this.closing = true;
    const running = [...this.running.values()];
    await Promise.all(running.map((child) => child.abort("close")));
    await Promise.all([...this.active]);
  }
}
