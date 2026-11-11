import { describe, expect, it } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { NativeDelegation } from "./delegation.js";
import { InMemoryDelegationLedger } from "./ledger.js";
import { BoundedConcurrencyLimiter, BoundedKeyedConcurrencyLimiter } from "./concurrency.js";
import type { ChildExecutor, ChildProgressEvent, ChildRecovery, DelegationLedger, DelegationLedgerRecord, DelegationTaskResolver, RawChildExecution, TrustedDelegationContext } from "./index.js";

const report = (summary: string) => `## 结论\n\n${summary}`;

const context = (operation = "parent-op"): TrustedDelegationContext => ({
  principalId: "user-1",
  ownerSessionId: "session-1",
  parentOperationId: operation,
  parentInvocationId: `invocation-${operation}`,
  context: TODO_CONTEXT,
});

const task = (key: string, role: "explorer" | "reviewer" = "explorer") => ({ key, role, task: `do ${key}`, taskId: "task-1" });

function resolver(state: { current?: boolean } = {}): DelegationTaskResolver {
  return {
    async resolve(item) {
      return {
        targetRef: `subagent:${item.key}`,
        prompt: item.task,
        systemPrompt: item.role,
        toolDefinitions: [],
        checkTarget: async () => state.current === false ? { state: "stale", reasons: ["revision changed"] } : { state: "current", reasons: [] },
      };
    },
  };
}

class FailingTerminalLedger implements DelegationLedger {
  private readonly inner = new InMemoryDelegationLedger();
  async reconcile(recovery: readonly ChildRecovery[] = []): Promise<void> { await this.inner.reconcile(recovery); }
  async reserve(parentOperationId: string, records: readonly DelegationLedgerRecord[], maximum: number): Promise<void> { await this.inner.reserve(parentOperationId, records, maximum); }
  async append(record: DelegationLedgerRecord): Promise<void> {
    if (record.state === "settled") throw new Error("LEDGER_TERMINAL_WRITE_FAILED");
    await this.inner.append(record);
  }
  async list(): Promise<readonly DelegationLedgerRecord[]> { return this.inner.list(); }
}

class StallingLedger implements DelegationLedger {
  private readonly inner = new InMemoryDelegationLedger();
  readonly reached: Promise<void>;
  private markReached!: () => void;
  constructor(private readonly stage: "list" | "reserve" | "terminal") {
    this.reached = new Promise<void>((resolve) => { this.markReached = resolve; });
  }
  async reconcile(recovery: readonly ChildRecovery[] = []): Promise<void> { await this.inner.reconcile(recovery); }
  async reserve(parentOperationId: string, records: readonly DelegationLedgerRecord[], maximum: number): Promise<void> {
    if (this.stage === "reserve") {
      this.markReached();
      return new Promise<never>(() => undefined);
    }
    await this.inner.reserve(parentOperationId, records, maximum);
  }
  async append(record: DelegationLedgerRecord): Promise<void> {
    if (this.stage === "terminal" && record.state === "settled") {
      this.markReached();
      return new Promise<never>(() => undefined);
    }
    await this.inner.append(record);
  }
  async list(): Promise<readonly DelegationLedgerRecord[]> {
    if (this.stage === "list") {
      this.markReached();
      return new Promise<never>(() => undefined);
    }
    return this.inner.list();
  }
}

class FakeExecutor implements ChildExecutor {
  readonly calls: string[] = [];
  closed = false;
  constructor(private readonly executeOne: (key: string) => RawChildExecution | Promise<RawChildExecution> = (key) => ({ status: "completed", terminalConfirmed: true, operationId: `op-${key}`, text: report(key), usage: { inputTokens: 1, outputTokens: 2, cost: null } })) {}
  async execute(request: any): Promise<RawChildExecution> {
    this.calls.push(request.runId);
    await request.onAccepted?.(`op-${request.runId}`);
    return this.executeOne(request.prompt.replace("do ", ""));
  }
  async close(): Promise<void> { this.closed = true; }
}

class StallingReconcileExecutor extends FakeExecutor {
  readonly reached: Promise<void>;
  private markReached!: () => void;
  constructor() {
    super();
    this.reached = new Promise<void>((resolve) => { this.markReached = resolve; });
  }
  async reconcile(): Promise<readonly ChildRecovery[]> {
    this.markReached();
    return new Promise<never>(() => undefined);
  }
}

describe("NativeDelegation", () => {
  it("reports each child's start, tool starts and settlement, and ignores a throwing listener", async () => {
    const executor = new FakeExecutor();
    const original = executor.execute.bind(executor);
    executor.execute = async (request: any) => {
      request.onToolStarted?.("describe_table");
      request.onToolStarted?.("query_database");
      return original(request);
    };
    const events: ChildProgressEvent[] = [];
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger() });
    const outcomes = await delegation.run({ tasks: [task("a"), task("bad")] }, {
      ...context(),
      onProgress: (event) => {
        events.push(event);
        throw new Error("listener failure");
      },
    });
    expect(outcomes.map((item) => item.status)).toEqual(["completed", "completed"]);
    const forA = events.filter((event) => event.key === "a").map((event) => event.type === "tool_started" ? event.toolName : event.type);
    expect(forA).toEqual(["started", "describe_table", "query_database", "settled"]);
    expect(events.find((event) => event.key === "a" && event.type === "settled")).toMatchObject({ status: "completed", reported: true });
  });

  it("runs two isolated child requests and returns bounded structured outcomes", async () => {
    const executor = new FakeExecutor();
    const ledger = new InMemoryDelegationLedger();
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger });
    const outcomes = await delegation.run({ tasks: [task("a"), task("b", "reviewer")] }, context());
    expect(outcomes.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(outcomes.map((item) => item.report?.markdown)).toEqual(["## 结论\n\na", "## 结论\n\nb"]);
    expect(new Set(outcomes.map((item) => item.childSessionId)).size).toBe(2);
    expect((await ledger.list()).filter((item) => item.state === "settled")).toHaveLength(2);
  });

  it("contains terminal ledger failure without abandoning a sibling child", async () => {
    const executor = new FakeExecutor(async (key) => {
      await new Promise((resolve) => setTimeout(resolve, key === "slow" ? 10 : 0));
      return { status: "completed", terminalConfirmed: true, operationId: `op-${key}`, text: report(key), usage: { inputTokens: 1, outputTokens: 1, cost: null } };
    });
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new FailingTerminalLedger() });
    const outcomes = await delegation.run({ tasks: [task("slow"), task("fast")] }, context("ledger-failure"));
    expect(outcomes).toMatchObject([
      { key: "slow", status: "failed", terminalConfirmed: false },
      { key: "fast", status: "failed", terminalConfirmed: false },
    ]);
    await delegation.close();
    expect(executor.closed).toBe(true);
  });

  it("keeps partial failure and stale target truth instead of reporting a batch success", async () => {
    const executor = new FakeExecutor((key) => key === "bad"
      ? { status: "failed", terminalConfirmed: true, operationId: "bad-op", usage: { inputTokens: 1, outputTokens: 0, cost: null }, error: "provider failed" }
      : { status: "completed", terminalConfirmed: true, operationId: "ok-op", text: report("ok"), usage: { inputTokens: 1, outputTokens: 2, cost: null } });
    const delegation = new NativeDelegation({ executor, resolver: resolver({ current: false }), ledger: new InMemoryDelegationLedger() });
    const outcomes = await delegation.run({ tasks: [task("ok"), task("bad")] }, context());
    expect(outcomes[0]).toMatchObject({ status: "completed", targetState: "stale", staleReasons: ["revision changed"] });
    expect(outcomes[1]).toMatchObject({ status: "failed", error: "provider failed" });
  });

  it("atomically enforces the per-operation child budget before external execution", async () => {
    const executor = new FakeExecutor();
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger(), maxChildrenPerOperation: 4 });
    await delegation.run({ tasks: [task("1"), task("2")] }, context());
    await delegation.run({ tasks: [task("3"), task("4")] }, context());
    const rejected = await delegation.run({ tasks: [task("5")] }, context());
    expect(rejected).toMatchObject([{ status: "budget_exhausted" }]);
    expect(executor.calls).toHaveLength(4);
  });

  it("enforces a shared child execution concurrency limit", async () => {
    let active = 0;
    let maximum = 0;
    const executor = new FakeExecutor(async (key) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { status: "completed", terminalConfirmed: true, operationId: `op-${key}`, text: report(key), usage: { inputTokens: 1, outputTokens: 2, cost: null } };
    });
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger(), concurrency: new BoundedConcurrencyLimiter(1) });
    await delegation.run({ tasks: [task("a"), task("b")] }, context());
    expect(maximum).toBe(1);
  });

  it.each(["list", "reserve", "memo"] as const)("applies the deadline before child admission when %s persistence stalls", async (stage) => {
    const executor = new FakeExecutor();
    const ledger = stage === "memo" ? new InMemoryDelegationLedger() : new StallingLedger(stage);
    let reachedMemo!: () => void;
    const memoReached = new Promise<void>((resolve) => { reachedMemo = resolve; });
    const runContext: TrustedDelegationContext = stage === "memo"
      ? { ...context(`stalled-${stage}`), memo: { get: async () => undefined, set: async () => { reachedMemo(); return new Promise<never>(() => undefined); } } }
      : context(`stalled-${stage}`);
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger, timeoutMs: 20 });
    const started = Date.now();
    const run = delegation.run({ tasks: [task(`stalled-${stage}`)] }, runContext);
    await (stage === "memo" ? memoReached : (ledger as StallingLedger).reached);
    await expect(run).resolves.toMatchObject([{ status: "timed_out", terminalConfirmed: true }]);
    expect(Date.now() - started).toBeLessThan(90);
    expect(executor.calls).toHaveLength(0);
    await delegation.close();
  });

  it("close cancels a run whose reservation persistence never returns", async () => {
    const executor = new FakeExecutor();
    const ledger = new StallingLedger("reserve");
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger, timeoutMs: 10_000 });
    const run = delegation.run({ tasks: [task("close-reserve")] }, context("close-reserve"));
    await ledger.reached;
    const started = Date.now();
    await delegation.close();
    expect(Date.now() - started).toBeLessThan(90);
    await expect(run).resolves.toMatchObject([{ status: "interrupted", terminalConfirmed: true }]);
    expect(executor.calls).toHaveLength(0);
  });

  it("close cancels a run whose terminal persistence never returns", async () => {
    const executor = new FakeExecutor();
    const ledger = new StallingLedger("terminal");
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger, timeoutMs: 10_000 });
    const run = delegation.run({ tasks: [task("close-terminal")] }, context("close-terminal"));
    await ledger.reached;
    const started = Date.now();
    await delegation.close();
    expect(Date.now() - started).toBeLessThan(90);
    await expect(run).resolves.toMatchObject([{ status: "interrupted", terminalConfirmed: true }]);
  });

  it("bounds startup recovery that ignores its cancellation signal", async () => {
    const executor = new StallingReconcileExecutor();
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger(), timeoutMs: 20 });
    const run = delegation.run({ tasks: [task("stalled-recovery")] }, context("stalled-recovery"));
    await executor.reached;
    const started = Date.now();
    await expect(run).resolves.toMatchObject([{ status: "timed_out", terminalConfirmed: true }]);
    expect(Date.now() - started).toBeLessThan(90);
    expect(executor.calls).toHaveLength(0);
    await delegation.close();
  });

  it("applies the child deadline while waiting for resolution", async () => {
    const slowResolver: DelegationTaskResolver = {
      async resolve(item) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          targetRef: `subagent:${item.key}`,
          prompt: item.task,
          systemPrompt: item.role,
          toolDefinitions: [],
          checkTarget: async () => ({ state: "current" as const, reasons: [] }),
        };
      },
    };
    const executor = new FakeExecutor();
    const delegation = new NativeDelegation({ executor, resolver: slowResolver, ledger: new InMemoryDelegationLedger(), timeoutMs: 20 });
    const started = Date.now();
    const outcomes = await delegation.run({ tasks: [task("slow-resolution")] }, context("slow-resolution"));
    expect(Date.now() - started).toBeLessThan(90);
    expect(outcomes).toMatchObject([{ status: "timed_out", terminalConfirmed: true }]);
    expect(executor.calls).toHaveLength(0);
  });

  it("times out a stalled final target check without blocking close", async () => {
    let reachedCheck!: () => void;
    const checking = new Promise<void>((resolve) => { reachedCheck = resolve; });
    const stalledResolver: DelegationTaskResolver = {
      async resolve(item) {
        return {
          targetRef: `subagent:${item.key}`,
          prompt: item.task,
          systemPrompt: item.role,
          toolDefinitions: [],
          checkTarget: async () => {
            reachedCheck();
            return new Promise<never>(() => undefined);
          },
        };
      },
    };
    const delegation = new NativeDelegation({ executor: new FakeExecutor(), resolver: stalledResolver, ledger: new InMemoryDelegationLedger(), timeoutMs: 20 });
    const started = Date.now();
    const run = delegation.run({ tasks: [task("stalled-check")] }, context("stalled-check"));
    await checking;
    const outcomes = await run;
    expect(Date.now() - started).toBeLessThan(90);
    expect(outcomes).toMatchObject([{ status: "timed_out", targetState: "unavailable", terminalConfirmed: true }]);
    const closing = Date.now();
    await delegation.close();
    expect(Date.now() - closing).toBeLessThan(90);
  });

  it("caps simultaneous children across concurrent invocations of one parent operation", async () => {
    let active = 0;
    let maximum = 0;
    const executor = new FakeExecutor(async (key) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { status: "completed", terminalConfirmed: true, operationId: `op-${key}`, text: report(key), usage: { inputTokens: 1, outputTokens: 1, cost: null } };
    });
    const delegation = new NativeDelegation({
      executor,
      resolver: resolver(),
      ledger: new InMemoryDelegationLedger(),
      parentConcurrency: new BoundedKeyedConcurrencyLimiter(2),
    });
    await Promise.all([
      delegation.run({ tasks: [task("a")] }, context("same-parent")),
      delegation.run({ tasks: [task("b")] }, context("same-parent")),
      delegation.run({ tasks: [task("c")] }, context("same-parent")),
    ]);
    expect(maximum).toBe(2);
  });

  it("close cancels resolution and waits for the parent run to finish", async () => {
    const slowResolver: DelegationTaskResolver = {
      async resolve() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { targetRef: "target", prompt: "slow", systemPrompt: "slow", toolDefinitions: [], checkTarget: async () => ({ state: "current" as const, reasons: [] }) };
      },
    };
    const delegation = new NativeDelegation({ executor: new FakeExecutor(), resolver: slowResolver, ledger: new InMemoryDelegationLedger(), timeoutMs: 10_000 });
    const run = delegation.run({ tasks: [task("close-resolution")] }, context("close-resolution"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await delegation.close();
    expect(Date.now() - started).toBeLessThan(90);
    await expect(run).resolves.toMatchObject([{ status: "interrupted", terminalConfirmed: true }]);
  });

  it("durably settles a reserved child cancelled before admission", async () => {
    let markResolving!: () => void;
    const resolving = new Promise<void>((resolve) => { markResolving = resolve; });
    const blockedResolver: DelegationTaskResolver = {
      resolve: async (_task, _run, _context, signal) => {
        markResolving();
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("RESOLUTION_CANCELLED")), { once: true });
        });
      },
    };
    const executor = new FakeExecutor();
    const ledger = new InMemoryDelegationLedger();
    const delegation = new NativeDelegation({ executor, resolver: blockedResolver, ledger });
    const abort = new AbortController();
    const run = delegation.run({ tasks: [task("cancel-after-reserve")] }, context("cancel-after-reserve"), abort.signal);
    await resolving;
    abort.abort();
    await expect(run).resolves.toMatchObject([{ status: "cancelled", terminalConfirmed: true }]);
    expect((await ledger.list()).map((record) => record.state)).toEqual(["reserved", "settled"]);
    expect(executor.calls).toHaveLength(0);
    await delegation.close();
  });

  it("does not create a child when cancellation is already requested", async () => {
    const executor = new FakeExecutor();
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger() });
    const abort = new AbortController();
    abort.abort();
    const outcomes = await delegation.run({ tasks: [task("cancel")] }, context(), abort.signal);
    expect(outcomes).toMatchObject([{ status: "cancelled", terminalConfirmed: true }]);
    expect(executor.calls).toHaveLength(0);
  });

  it("rejects duplicate keys and closes its child executor", async () => {
    const executor = new FakeExecutor();
    const delegation = new NativeDelegation({ executor, resolver: resolver(), ledger: new InMemoryDelegationLedger() });
    await expect(delegation.run({ tasks: [task("same"), task("same")] }, context())).rejects.toThrow("SUBAGENT_TASK_KEY_INVALID");
    await delegation.close();
    expect(executor.closed).toBe(true);
    await expect(delegation.run({ tasks: [task("later")] }, context())).rejects.toThrow("SUBAGENT_DELEGATION_CLOSED");
  });
});
