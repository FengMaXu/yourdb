import { diffProbeSamples, WITNESS_MAX, type WitnessRow } from "./probe-diff.js";
import { contentHash, type FieldAlternative, type FieldProbeRecord, type FieldRecord, type ProbeOutputs, type ProbeView, type ProbeWaiver, type SpecFields } from "./model.js";
import { valueKey, type SpecPath } from "./fields.js";

/** Per-task cap on probe executions; probes do not consume the exploration budget. */
export const MAX_FIELD_PROBES = 24;
/** Probes run to completion up to the executor's exploration cap so the fingerprint covers the whole output. */
export const PROBE_ROW_LIMIT = 10_000;

export interface ProbeSummary {
  readonly probes: readonly ProbeView[];
  readonly outputs: ProbeOutputs;
  /** Every alternative has a probe under the current context or a waiver. */
  readonly covered: boolean;
  /** Alternatives without such a probe or waiver, stale ones included. */
  readonly missing: readonly string[];
  /** Alternatives whose latest probe ran while other fields held different states. */
  readonly stale: readonly string[];
  /** Fingerprint per alternative, only for available probes. */
  readonly fingerprints: ReadonlyMap<string, string>;
  /** Rows telling differing outputs apart, from the probes' samples. */
  readonly witnesses: readonly WitnessRow[];
}

/**
 * What a probe of `path` ran under: the state and value of every other field.
 * A probe computes the whole answer, so its output depends on them too; a
 * probe taken under another context says nothing about the current one.
 * Bases, rationales and alternative ids are left out: they do not change the
 * output.
 */
export function probeContext(fields: SpecFields, path: SpecPath): string {
  const states = (Object.entries(fields) as [SpecPath, FieldRecord][])
    .filter(([other]) => other !== path)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([other, field]) => [other, field.state === "not_applicable" ? "n/a"
      : field.state === "open" ? { open: field.alternatives.map((alternative) => valueKey(alternative.value)) }
        : valueKey(field.value)]);
  return contentHash(states).slice(0, 32);
}

/**
 * Derives what the Runtime knows about an open field's outputs from the
 * latest probe of each alternative and the declared waivers (ADR-0005). With
 * a context, a probe taken under another context is stale and counts as
 * missing; without one (Decision Realization) every latest probe counts.
 */
export function summarizeProbes(path: SpecPath, alternatives: readonly FieldAlternative[], probes: readonly FieldProbeRecord[], waivers: readonly ProbeWaiver[], context: string | undefined): ProbeSummary {
  const latest = new Map<string, FieldProbeRecord>();
  for (const probe of probes) if (probe.path === path) latest.set(probe.alternativeId, probe);
  const waived = new Map(waivers.map((waiver) => [waiver.alternativeId as string, waiver]));
  const fingerprints = new Map<string, string>();
  const missing: string[] = [];
  const stale: string[] = [];
  const views = alternatives.map((alternative): ProbeView => {
    const probe = latest.get(alternative.id);
    if (probe && context !== undefined && probe.context !== context) {
      const waiver = waived.get(alternative.id);
      if (waiver) return { alternativeId: alternative.id, state: "waived", reason: waiver.reason };
      missing.push(alternative.id);
      stale.push(alternative.id);
      return { alternativeId: alternative.id, state: "stale", rowCount: probe.rowCount, reason: "other fields changed since this probe ran; probe it again" };
    }
    if (probe?.outcome.state === "available") {
      fingerprints.set(alternative.id, probe.outcome.fingerprint);
      return { alternativeId: alternative.id, state: "available", rowCount: probe.rowCount, output: probe.outcome.fingerprint.slice(0, 12) };
    }
    if (probe) return { alternativeId: alternative.id, state: "unavailable", rowCount: probe.rowCount, reason: probe.outcome.reason };
    const waiver = waived.get(alternative.id);
    if (waiver) return { alternativeId: alternative.id, state: "waived", reason: waiver.reason };
    missing.push(alternative.id);
    return { alternativeId: alternative.id, state: "missing" };
  });
  const complete = fingerprints.size === alternatives.length;
  const distinct = new Set(fingerprints.values()).size;
  const outputs: ProbeOutputs = !complete ? distinct > 1 ? "distinct" : "incomplete" : distinct === 1 ? "identical" : "distinct";
  return { probes: views, outputs, covered: missing.length === 0, missing, stale, fingerprints, witnesses: witnessesOf(alternatives, latest, fingerprints) };
}

/** Witness rows for pairs of alternatives whose current outputs differ, in alternative order, capped per field. */
function witnessesOf(alternatives: readonly FieldAlternative[], latest: ReadonlyMap<string, FieldProbeRecord>, fingerprints: ReadonlyMap<string, string>): readonly WitnessRow[] {
  const sampled = alternatives.flatMap((alternative) => {
    const sample = latest.get(alternative.id)?.sample;
    return sample && fingerprints.has(alternative.id) ? [{ alternativeId: alternative.id as string, sample }] : [];
  });
  const out: WitnessRow[] = [];
  for (let left = 0; left < sampled.length && out.length < WITNESS_MAX; left++) {
    for (let right = left + 1; right < sampled.length && out.length < WITNESS_MAX; right++) {
      const a = sampled[left]!;
      const b = sampled[right]!;
      if (fingerprints.get(a.alternativeId) === fingerprints.get(b.alternativeId)) continue;
      out.push(...diffProbeSamples(a, b, WITNESS_MAX - out.length));
    }
  }
  return out;
}

/**
 * Open fields whose every alternative produced the same output under the
 * current other fields. The Runtime treats them as handled without a
 * decision: the answer does not depend on them, and the fingerprints are the
 * Runtime's own record. Changing another field makes the probes stale and the
 * field open again.
 */
export function equivalentPaths(fields: SpecFields, probes: readonly FieldProbeRecord[]): ReadonlySet<SpecPath> {
  const paths = new Set<SpecPath>();
  for (const [path, field] of Object.entries(fields) as [SpecPath, FieldRecord][]) {
    if (field.state === "open" && summarizeProbes(path, field.alternatives, probes, field.waivers ?? [], probeContext(fields, path)).outputs === "identical") paths.add(path);
  }
  return paths;
}

export interface RealizationConflict {
  readonly path: SpecPath;
  readonly adoptedAlternativeId: string;
  /** The alternative whose probe output the result reproduces. */
  readonly realizedAlternativeId: string;
}

/**
 * A result realizes a decision unless it reproduces the probe output of an
 * alternative that was not adopted (ADR-0005). Equality with the adopted
 * alternative's output is not required: other fields may have changed since
 * the probes ran, so only a match with a rejected alternative is conclusive.
 */
export function realizationConflicts(fields: SpecFields, probes: readonly FieldProbeRecord[], resultFingerprint: string): readonly RealizationConflict[] {
  const conflicts: RealizationConflict[] = [];
  for (const [path, field] of Object.entries(fields) as [SpecPath, FieldRecord][]) {
    if (field.state !== "decided") continue;
    // Every latest probe counts, whatever the other fields held when it ran: reproducing a rejected alternative's output is the conflict.
    const { fingerprints } = summarizeProbes(path, field.alternatives, probes, field.waivers ?? [], undefined);
    if (fingerprints.get(field.alternativeId) === resultFingerprint) continue;
    for (const [alternativeId, fingerprint] of fingerprints) {
      if (alternativeId === field.alternativeId || fingerprint !== resultFingerprint) continue;
      conflicts.push({ path, adoptedAlternativeId: field.alternativeId, realizedAlternativeId: alternativeId });
      break;
    }
  }
  return conflicts;
}
