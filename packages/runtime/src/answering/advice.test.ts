import { describe, expect, it, vi } from "vitest";
import { InMemoryAnswering } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import { UNAVAILABLE_ADVICE_RETRY_MS } from "./advice-execution.js";
import { renderAnsweringText } from "../tools/answering.js";
import type { CompareHypothesesInput, HypothesisChoiceAssessment, HypothesisChoiceRecommendation } from "../judgment/hypothesis-choice.js";

const spec = { "population.entity": "orders", "population.eligibility": "n/a", "population.conditions": "n/a", "population.time": "n/a", "measure.formula": { op: "count", of: "orders" }, "measure.countGrain": { grain: "row", note: "one row per order" }, grouping: "n/a", selection: "n/a", output: { rowMode: "scalar", rowCount: 1 } };
const business = (invocationId: string) => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
const PATH = "population.timeField";
const RATIONALE = "The request counts orders when they are purchased";

/** Probabilities by alternative position, so a test can state the advice before ids exist. */
function assessment(probabilities: readonly number[], recommendation: "first" | "second" | Exclude<HypothesisChoiceRecommendation["kind"], "hypothesis">) {
  return (input: CompareHypothesesInput): HypothesisChoiceAssessment => {
    const ids = input.hypotheses.map((item) => item.id);
    return {
      model: "jev-1.13.0",
      recommendation: recommendation === "first" || recommendation === "second" ? { kind: "hypothesis", hypothesisId: ids[recommendation === "first" ? 0 : 1]! } : { kind: recommendation },
      probabilities: ids.map((id, index) => ({ hypothesisId: id, probability: probabilities[index] ?? 0 })),
      abstentionProbabilities: { insufficientEvidence: 0, multiplePlausible: 0, noneSupported: 0 },
      confidence: 0.5,
    };
  };
}

/** Purchase month first, delivery month second; each probe gives a different count. */
async function setup(compare: (input: CompareHypothesesInput) => Promise<HypothesisChoiceAssessment> | HypothesisChoiceAssessment, options: { path?: string; populationDecisions?: "require_evidence" | "allow_disclosed"; probe?: "both" | "first" } = {}) {
  const path = options.path ?? PATH;
  const outputs: Record<string, { columns: string[]; rows: unknown[][]; truncated: boolean }> = {
    "SELECT purchase": { columns: ["n"], rows: [[265]], truncated: false },
    "SELECT delivered": { columns: ["n"], rows: [[205]], truncated: false },
    "SELECT delivered as purchase": { columns: ["n"], rows: [[265]], truncated: false },
  };
  const advisor = vi.fn(async (input: CompareHypothesesInput) => compare(input));
  const answering = new InMemoryAnswering({
    store: new InMemoryAnsweringStore(),
    resultStore: new InMemoryResultStore(),
    sqlExecutor: { run: async (sql) => outputs[sql]! },
    fieldProbes: true,
    fieldAdvice: { advisor: { compare: advisor }, getOriginalQuestion: async () => "每月已送达订单数" },
    ...(options.populationDecisions ? { populationDecisions: options.populationDecisions } : {}),
  });
  const view = await answering.set({ requestMessageId: "current-message", requestId: "begin", fields: { ...spec, [path]: { open: ["按下单时间", "按送达时间"] } } }, business("begin"));
  const field = view.fields.find((item) => item.path === path)!;
  const [purchase, delivered] = field.alternatives!.map((alternative) => alternative.id as string);
  await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase", probe: { path, alternativeId: purchase! } }, business("probe-1"));
  const last = options.probe === "first" ? undefined : await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT delivered", probe: { path, alternativeId: delivered! } }, business("probe-2"));
  return { answering, advisor, view, last, purchase: purchase!, delivered: delivered! };
}

const decide = (answering: InMemoryAnswering, taskId: string, value: string, extra: Record<string, unknown> = {}, path = PATH) =>
  answering.set({ taskId, requestId: `decide-${value}-${Object.keys(extra).length}`, fields: { [path]: { value, rationale: RATIONALE, ...extra } } }, business(`decide-${value}-${Object.keys(extra).length}`));

describe("field advice asked by the Runtime (ADR-0005)", () => {
  it("asks once the last probe shows the outputs differ, and returns the advice with that probe", async () => {
    const { answering, advisor, view, last, purchase, delivered } = await setup(assessment([0, 0.25], "insufficient_evidence"));
    expect(advisor).toHaveBeenCalledTimes(1);
    expect(advisor.mock.calls[0]![0]).toMatchObject({
      originalQuestion: "每月已送达订单数",
      hypotheses: [{ id: purchase, statement: `${PATH}: 按下单时间` }, { id: delivered, statement: `${PATH}: 按送达时间` }],
      evidence: [
        { id: "request", kind: "request_wording", content: "每月已送达订单数" },
        { id: "probe_outputs", content: expect.stringContaining("alternative 1: 1 output rows") },
      ],
    });
    expect(last?.probe).toMatchObject({ path: PATH, advice: { recommendation: "insufficient_evidence", lean: { alternativeId: delivered, probability: 0.25 } } });
    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    expect(inspected.task.fieldAdvice).toEqual([expect.objectContaining({ path: PATH, lean: { alternativeId: delivered, probability: 0.25 } })]);

    // A decision reads the recorded advice; it does not ask again.
    await decide(answering, view.taskId, "按送达时间");
    expect(advisor).toHaveBeenCalledTimes(1);
  });

  it("does not ask when every alternative gives the same output", async () => {
    const advisor = vi.fn();
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: { run: async () => ({ columns: ["n"], rows: [[265]], truncated: false }) },
      fieldProbes: true,
      fieldAdvice: { advisor: { compare: advisor }, getOriginalQuestion: async () => "q" },
    });
    const view = await answering.set({ requestMessageId: "m", requestId: "begin", fields: { ...spec, [PATH]: { open: ["按下单时间", "按送达时间"] } } }, business("begin"));
    const [first, second] = view.fields.find((item) => item.path === PATH)!.alternatives!.map((item) => item.id as string);
    await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT a", probe: { path: PATH, alternativeId: first! } }, business("p1"));
    await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT b", probe: { path: PATH, alternativeId: second! } }, business("p2"));
    expect(advisor).not.toHaveBeenCalled();
    expect((await answering.inspect({ taskId: view.taskId }, business("inspect"))).open).toEqual([]);
  });

  it("asks when a waiver completes the outputs, and shows the advice in the set view", async () => {
    const { answering, advisor, view, delivered } = await setup(assessment([0.1, 0.7], "second"), { probe: "first" });
    expect(advisor).not.toHaveBeenCalled();
    const waived = await answering.set({ taskId: view.taskId, requestId: "waive", fields: { [PATH]: { notProbeable: { [delivered]: "the delivery date exists only after a join that needs the chosen month" } } } }, business("waive"));
    expect(advisor).toHaveBeenCalledTimes(1);
    expect(waived.fields.find((item) => item.path === PATH)).toMatchObject({ advice: { lean: { alternativeId: delivered } } });
  });

  it("asks again when the probe outputs it compared change", async () => {
    const { answering, advisor, view, purchase } = await setup(assessment([0.1, 0.7], "second"));
    expect(advisor).toHaveBeenCalledTimes(1);
    await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT delivered as purchase", probe: { path: PATH, alternativeId: purchase } }, business("reprobe"));
    // The outputs are now identical: no advice needed.
    expect(advisor).toHaveBeenCalledTimes(1);
    const back = await answering.execute({ kind: "exploration", taskId: view.taskId, sql: "SELECT purchase", probe: { path: PATH, alternativeId: purchase } }, business("reprobe-2"));
    // Back to the outputs it compared: the recorded advice applies again and comes with the probe.
    expect(advisor).toHaveBeenCalledTimes(1);
    expect(back.probe).toMatchObject({ advice: { recommendation: "alternative" } });
  });

  it("retries a provider failure once, then records the advice as unavailable", async () => {
    const outage = Object.assign(new Error("Jev HTTP 451"), { code: "HTTP_ERROR" });
    const { answering, advisor, view, last, purchase, delivered } = await setup(() => { throw outage; });
    expect(advisor).toHaveBeenCalledTimes(2);
    expect(last?.probe).toMatchObject({ advice: { recommendation: "unavailable" } });
    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    expect(inspected.task.fieldAdvice?.[0]).toMatchObject({ recommendation: "unavailable", failure: "Jev HTTP 451", alternativeIds: [purchase, delivered] });

    // A decision soon after does not wait on the provider again.
    await decide(answering, view.taskId, "按下单时间");
    expect(advisor).toHaveBeenCalledTimes(2);
  });

  it("asks again after an outage once the retry interval has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const outage = Object.assign(new Error("Jev HTTP 451"), { code: "HTTP_ERROR" });
      let down = true;
      const { answering, advisor, view, delivered } = await setup((input) => {
        if (down) throw outage;
        return assessment([0.1, 0.7], "second")(input);
      });
      down = false;
      vi.setSystemTime(Date.now() + UNAVAILABLE_ADVICE_RETRY_MS + 1);
      const decided = await decide(answering, view.taskId, "按下单时间");
      expect(advisor).toHaveBeenCalledTimes(3);
      expect(decided.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining(`leaned to alternative ${delivered}`) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a malformed input and records the advice as unavailable", async () => {
    const { answering, advisor, view } = await setup(() => { throw Object.assign(new Error("bad"), { code: "INVALID_INPUT" }); });
    expect(advisor).toHaveBeenCalledTimes(1);
    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    expect(inspected.task.fieldAdvice?.[0]).toMatchObject({ recommendation: "unavailable", failure: "bad" });
  });
});

describe("deciding against advice (ADR-0005)", () => {
  const leanSecond = assessment([0.04, 0.53], "second");

  it("requires a reason and evidence to decide against a clear lean", async () => {
    const { answering, view, purchase, delivered } = await setup(leanSecond);
    const against = await decide(answering, view.taskId, "按下单时间");
    expect(against.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining(`leaned to alternative ${delivered} (p=0.53)`) });
    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    const observation = inspected.task.fieldProbes!.find((probe) => probe.alternativeId === purchase)!.evidenceId;
    const overridden = await decide(answering, view.taskId, "按下单时间", { adviceOverride: { reason: "Only the purchase month is defined for every order in 2016", evidenceIds: [observation] } });
    expect(overridden.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided", verified: false, rationale: RATIONALE, advice: { lean: { alternativeId: delivered } }, adviceOverride: { evidenceIds: [observation] } });
  });

  it("does not let observations outweigh a lean on a semantic field", async () => {
    const semantic = "measure.denominator";
    const { answering, view, purchase } = await setup(assessment([0.04, 0.45], "second"), { path: semantic });
    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    const observation = inspected.task.fieldProbes!.find((probe) => probe.alternativeId === purchase)!.evidenceId;
    const overridden = await decide(answering, view.taskId, "按下单时间", { adviceOverride: { reason: "The data has no quantity column for extras", evidenceIds: [observation] } }, semantic);
    expect(overridden.outcomes?.[0]).toMatchObject({ status: "rejected", code: "SPEC_TRANSITION_INVALID", message: expect.stringContaining("needs evidence that qualifies for this field") });
    const followed = await decide(answering, view.taskId, "按送达时间", {}, semantic);
    expect(followed.fields.find((item) => item.path === semantic)).toMatchObject({ status: "decided", value: "按送达时间" });
  });

  it("does not let an assumption replace a field the advice must weigh", async () => {
    const { answering, view, purchase } = await setup(leanSecond);
    const assumed = await answering.set({ taskId: view.taskId, requestId: "assume", fields: { [PATH]: { value: "按下单时间", basis: "assumed", rationale: RATIONALE, reason: "advice failed" } } }, business("assume"));
    expect(assumed.outcomes?.[0]).toMatchObject({ status: "rejected", code: "SPEC_TRANSITION_INVALID", message: expect.stringContaining("an assumption cannot replace it") });
    const bare = await answering.set({ taskId: view.taskId, requestId: "bare", fields: { [PATH]: { value: "按送达时间", reason: "advice failed" } } }, business("bare"));
    expect(bare.outcomes?.[0]).toMatchObject({ status: "rejected", message: expect.stringContaining("an assumption cannot replace it") });

    const inspected = await answering.inspect({ taskId: view.taskId }, business("inspect"));
    const observation = inspected.task.fieldProbes!.find((probe) => probe.alternativeId === purchase)!.evidenceId;
    const settled = await answering.set({ taskId: view.taskId, requestId: "settle", fields: { [PATH]: { value: "按下单时间", evidenceIds: [observation], reason: "the observation settles it" } } }, business("settle"));
    expect(settled.fields.find((item) => item.path === PATH)).toMatchObject({ status: "evidence" });
  });

  it("decides without advice when the advisor was unavailable, and discloses it", async () => {
    const { answering, view } = await setup(() => { throw Object.assign(new Error("Jev HTTP 451"), { code: "HTTP_ERROR" }); });
    const decided = await decide(answering, view.taskId, "按下单时间");
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided", value: "按下单时间", adviceUnavailable: "Jev HTTP 451" });
    const execution = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: decided.revisionId, sql: "SELECT purchase" }, business("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, business("publish"));
    expect(receipt.disclosure?.summary).toContain(`决定未经比较：${PATH}`);
  });

  // local056: Jev answered multiple_plausible with no alternative clearly ahead.
  const noLean = assessment([0.15, 0.1], "multiple_plausible");

  it("sends a decision the advice cannot separate to the user while the user can be asked", async () => {
    const { answering, view } = await setup(noLean);
    const decided = await decide(answering, view.taskId, "按下单时间");
    expect(decided.outcomes?.[0]).toMatchObject({ status: "rejected", code: "SPEC_TRANSITION_INVALID", message: expect.stringContaining("ask the user (") });
    // The domain names the step, not the tool; the tool layer renders it.
    expect(renderAnsweringText(decided.outcomes?.[0]?.message ?? "")).toContain("ask the user (ask_user_clarification)");
  });

  it("decides an inseparable field without a user, and discloses it", async () => {
    const { answering, view } = await setup(noLean, { populationDecisions: "allow_disclosed" });
    const decided = await decide(answering, view.taskId, "按下单时间");
    expect(decided.fields.find((item) => item.path === PATH)).toMatchObject({ status: "decided", value: "按下单时间", adviceUndecided: "multiple_plausible" });
    const execution = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: decided.revisionId, sql: "SELECT purchase" }, business("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, business("publish"));
    expect(receipt.disclosure?.summary).toContain(`决定未经裁决：${PATH}`);
  });

  it("accepts the leaned alternative without an override", async () => {
    const { answering, view } = await setup(assessment([0, 0.25], "insufficient_evidence"));
    const decided = await decide(answering, view.taskId, "按送达时间");
    const field = decided.fields.find((item) => item.path === PATH);
    expect(field).toMatchObject({ status: "decided", value: "按送达时间" });
    expect(field).not.toHaveProperty("adviceOverride");
  });
});
