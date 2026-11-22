import type { BusinessContext, FieldRecord, RevisionId, TaskId } from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import { needsAdvice, valueKey, type SpecPath } from "./fields.js";
import { probeContext, summarizeProbes, type ProbeSummary } from "./probes.js";
import { adviceBasis, applicableAdvice, latestAdvice, leanOf, type FieldAdvisory } from "./advice.js";
import { now } from "./support.js";
import { witnessText } from "./probe-diff.js";
import type { HypothesisChoiceAdvisor, HypothesisChoiceAssessment, HypothesisChoiceEvidence } from "../judgment/hypothesis-choice.js";
import type { AnsweringDeps } from "./deps.js";

/** The comparison advisor and the original request it reads; configured by the composition root. */
export interface FieldAdviceOptions {
  readonly advisor: HypothesisChoiceAdvisor;
  readonly getOriginalQuestion: (requestMessageId: string, options?: { readonly signal?: AbortSignal }) => Promise<string | undefined>;
}

type OpenField = Extract<FieldRecord, { state: "open" }>;

interface Pending {
  readonly path: SpecPath;
  readonly field: OpenField;
  readonly summary: ProbeSummary;
}

/** Probe outputs the Runtime holds, stated so the advisor can see which alternatives actually differ. */
/**
 * Exported for offline replay (evaluations/spider2/jev-witness-replay.mjs):
 * `witnesses: false` rebuilds the same evidence without the witness rows, so
 * the two conditions differ only in them (plan T4.1).
 */
export function probeEvidence(field: OpenField, summary: ProbeSummary, options: { readonly witnesses?: boolean } = {}): HypothesisChoiceEvidence {
  const labels = new Map(field.alternatives.map((alternative, index) => [alternative.id as string, `alternative ${index + 1}`]));
  const label = (id: string) => labels.get(id) ?? id;
  const lines = summary.probes.map((probe) => probe.state === "available"
    ? `${label(probe.alternativeId)}: ${probe.rowCount} output rows`
    : probe.state === "waived" ? `${label(probe.alternativeId)}: not probed (${probe.reason})`
      : `${label(probe.alternativeId)}: ${probe.rowCount ?? 0} output rows (output not comparable: ${probe.reason ?? probe.state})`);
  const groups = new Map<string, string[]>();
  for (const [id, fingerprint] of summary.fingerprints) groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), label(id)]);
  const same = [...groups.values()].filter((group) => group.length > 1).map((group) => `${group.join(" and ")} produce identical output`);
  // Concrete rows where the outputs differ, so the comparison can weigh what each reading returns, not only how much.
  const witnesses = options.witnesses === false ? [] : summary.witnesses.map((witness) => `difference: ${witnessText(witness, label)}`);
  return { id: "probe_outputs", kind: "observation", authority: "observation", authorityRank: 5, sourceRef: "field_probes", content: [...lines, ...same, ...witnesses].join("\n") };
}

/** Unavailable advice is asked again after this long, so a brief outage need not leave the decision uncompared. */
export const UNAVAILABLE_ADVICE_RETRY_MS = 60_000;

function retryable(error: unknown): boolean {
  return (error as { readonly code?: unknown } | undefined)?.code !== "INVALID_INPUT";
}

function advisory(item: Pending, assessment: HypothesisChoiceAssessment): FieldAdvisory {
  const probabilities = assessment.probabilities.map((entry) => ({ alternativeId: entry.hypothesisId, probability: entry.probability }));
  const recommendedAlternativeId = assessment.recommendation.kind === "hypothesis" ? assessment.recommendation.hypothesisId : undefined;
  const lean = leanOf(probabilities, recommendedAlternativeId);
  return {
    path: item.path,
    alternativeIds: item.field.alternatives.map((alternative) => alternative.id as string),
    basis: adviceBasis(item.summary),
    model: assessment.model,
    probabilities,
    recommendation: assessment.recommendation.kind === "hypothesis" ? "alternative" : assessment.recommendation.kind,
    ...(recommendedAlternativeId ? { recommendedAlternativeId } : {}),
    ...(lean ? { lean } : {}),
    recordedAt: now(),
  };
}

function unavailable(item: Pending, failure: string): FieldAdvisory {
  return {
    path: item.path,
    alternativeIds: item.field.alternatives.map((alternative) => alternative.id as string),
    basis: adviceBasis(item.summary),
    model: "unavailable",
    probabilities: [],
    recommendation: "unavailable",
    failure,
    recordedAt: now(),
  };
}

async function compare(options: FieldAdviceOptions, question: string, item: Pending, context: BusinessContext): Promise<FieldAdvisory> {
  const input = {
    originalQuestion: question,
    hypotheses: item.field.alternatives.map((alternative) => ({ id: alternative.id as string, statement: `${item.path}: ${valueKey(alternative.value)}` })),
    evidence: [
      { id: "request", kind: "request_wording", authority: "request_wording", authorityRank: 3, sourceRef: "user_request", content: question },
      probeEvidence(item.field, item.summary),
    ],
  };
  const ask = () => options.advisor.compare(input, context.signal ? { signal: context.signal } : undefined);
  try {
    // One retry for a provider failure; a malformed input would fail the same way again.
    return advisory(item, await ask().catch((error: unknown) => {
      if (context.signal?.aborted || !retryable(error)) throw error;
      return ask();
    }));
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return unavailable(item, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Asks the advisor about every open field that needs advice and has none that
 * applies (ADR-0005): every alternative's output is known under the current
 * other fields, the outputs are not all identical, and the path is one advice
 * governs. Advice is recorded on the Query Task for the Revision it was asked
 * about; an advisor failure is recorded as unavailable, so the decision can
 * proceed and is disclosed. Returns the advice that applies to those fields
 * now: what was already recorded and what this call recorded.
 */
export async function ensureAdvice(deps: AnsweringDeps, taskId: TaskId, context: BusinessContext, paths?: readonly string[]): Promise<readonly FieldAdvisory[]> {
  const options = deps.fieldAdvice;
  if (!options || !deps.adviceRequired) return [];
  const loaded = await deps.store.transact((tx) => {
    const task = tx.getTask(taskId);
    assertTaskAccess(task, context);
    const revision = tx.getRevision(task.currentRevisionId);
    if (!revision) return undefined;
    const pending: Pending[] = [];
    const held: FieldAdvisory[] = [];
    for (const [path, field] of Object.entries(revision.fields) as [SpecPath, FieldRecord][]) {
      // An inherited open field is the Report Task's to settle.
      if (field.state !== "open" || field.inherited || !needsAdvice(path) || (paths && !paths.includes(path))) continue;
      const summary = summarizeProbes(path, field.alternatives, task.fieldProbes ?? [], field.waivers ?? [], probeContext(revision.fields, path));
      if (!summary.covered || summary.outputs === "identical") continue;
      const advice = applicableAdvice(latestAdvice(task, path), field.alternatives, summary);
      if (advice && (advice.recommendation !== "unavailable" || Date.now() - Date.parse(advice.recordedAt) < UNAVAILABLE_ADVICE_RETRY_MS)) held.push(advice);
      else pending.push({ path, field, summary });
    }
    return { pending, held, revisionId: revision.revisionId, requestMessageId: task.requestMessageId };
  }, context);
  if (!loaded) return [];
  if (loaded.pending.length === 0) return loaded.held;

  let question: string | undefined;
  let failure: string | undefined;
  try {
    question = await options.getOriginalQuestion(loaded.requestMessageId, context.signal ? { signal: context.signal } : undefined);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    failure = error instanceof Error ? error.message : String(error);
  }
  const advice = question
    ? await Promise.all(loaded.pending.map((item) => compare(options, question!, item, context)))
    : loaded.pending.map((item) => unavailable(item, failure ?? "the original request is unavailable"));

  return deps.store.transact((tx) => {
    const task = tx.getTask(taskId);
    assertTaskAccess(task, context);
    // A field write that landed meanwhile asks again on its own Revision.
    if (task.currentRevisionId !== (loaded.revisionId as RevisionId)) return loaded.held;
    const recorded = new Set(advice.map((item) => item.path));
    tx.putTask({ ...task, fieldAdvice: [...(task.fieldAdvice ?? []).filter((item) => !recorded.has(item.path)), ...advice], updatedAt: now() });
    return [...loaded.held, ...advice];
  }, context);
}
