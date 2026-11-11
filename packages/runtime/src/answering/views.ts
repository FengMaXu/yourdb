import {
  clone,
  type AnswerRevisionRecord,
  type AnswerRevisionView,
  type Evidence,
  type FieldProbeRecord,
  type FieldRecord,
  type FieldView,
  type QueryTaskRecord,
  type TaskId,
} from "./model.js";
import { FIELD_PATHS, type SpecPath } from "./fields.js";
import { openPaths, undeclaredPaths, unverifiedFields } from "./qualification.js";
import { calendarRequiredPaths } from "./calendar-coverage.js";
import { equivalentPaths, probeContext, summarizeProbes } from "./probes.js";
import { adviceView, applicableAdvice, latestAdvice, type FieldAdvisory } from "./advice.js";
import type { AnsweringDeps } from "./deps.js";

/** What the Runtime knows about open fields beyond the Revision: probes and advice. */
export interface ProbeContext {
  /** Probes are tracked: views show per-alternative probe state and decisions need every output. */
  readonly tracked: boolean;
  readonly probes: readonly FieldProbeRecord[];
  readonly advice?: (path: string) => FieldAdvisory | undefined;
  /** Registered evidence, to tell a request quote from other evidence. */
  readonly evidence?: (id: string) => Evidence | undefined;
}

/** Tree order first, then measure definitions by name. */
function ordered(fields: AnswerRevisionRecord["fields"]): readonly [SpecPath, FieldRecord][] {
  const rank = (path: string) => {
    const index = (FIELD_PATHS as readonly string[]).indexOf(path);
    return index < 0 ? FIELD_PATHS.length : index;
  };
  return (Object.entries(fields) as [SpecPath, FieldRecord][]).sort(([left], [right]) => rank(left) - rank(right) || left.localeCompare(right));
}

function fieldView(path: SpecPath, field: FieldRecord, fields: AnswerRevisionRecord["fields"], equivalent: ReadonlySet<SpecPath>, context: ProbeContext | undefined): FieldView {
  const inherited = field.inherited ? { inherited: field.inherited } : {};
  if (field.state === "not_applicable") return { path, status: "not_applicable", ...inherited };
  if (field.state === "specified") {
    if (field.basis.kind === "assumed") return { path, status: "assumed", value: field.value, ...(field.basis.rationale ? { rationale: field.basis.rationale } : {}), ...inherited };
    const ids = field.basis.evidenceIds;
    const request = context?.evidence ? ids.every((id) => context.evidence!(id)?.kind === "request_wording") : false;
    return { path, status: request ? "request" : "evidence", value: field.value, evidenceIds: ids, ...inherited };
  }
  const summary = context?.tracked ? summarizeProbes(path, field.alternatives, context.probes, field.waivers ?? [], probeContext(fields, path)) : undefined;
  const probes = new Map((summary?.probes ?? []).map((probe) => [probe.alternativeId as string, probe]));
  const alternatives = field.alternatives.map((alternative) => ({ id: alternative.id, value: alternative.value, ...(probes.has(alternative.id) ? { probe: probes.get(alternative.id)! } : {}) }));
  const advice = summary ? applicableAdvice(context?.advice?.(path), field.alternatives, summary) : undefined;
  const shared = {
    alternatives,
    ...(summary ? { outputs: summary.outputs } : {}),
    ...(advice ? { advice: adviceView(advice) } : {}),
    ...inherited,
  };
  if (field.state === "open") return { path, status: equivalent.has(path) ? "equivalent" : "open", ...shared };
  return {
    path,
    status: "decided",
    value: field.value,
    verified: field.basis.kind === "evidence",
    rationale: field.rationale,
    ...(field.basis.kind === "evidence" ? { evidenceIds: field.basis.evidenceIds } : {}),
    ...(field.adviceOverride ? { adviceOverride: field.adviceOverride } : {}),
    ...(field.adviceUnavailable ? { adviceUnavailable: field.adviceUnavailable } : {}),
    ...(field.adviceUndecided ? { adviceUndecided: field.adviceUndecided } : {}),
    ...shared,
  };
}

/** Probes and advice the Runtime holds for a task; probes are tracked only when Choice governance is on. */
export function probeContextFor(deps: AnsweringDeps, task: Pick<QueryTaskRecord, "taskId" | "fieldProbes" | "fieldAdvice">, evidence?: readonly Evidence[]): ProbeContext | undefined {
  if (!deps.fieldProbes) return evidence ? { tracked: false, probes: [], evidence: lookup(evidence) } : undefined;
  return {
    tracked: true,
    probes: task.fieldProbes ?? [],
    ...(deps.fieldAdvice ? { advice: (path: string) => latestAdvice(task, path) } : {}),
    ...(evidence ? { evidence: lookup(evidence) } : {}),
  };
}

function lookup(evidence: readonly Evidence[]): (id: string) => Evidence | undefined {
  const byId = new Map(evidence.map((item) => [item.id as string, item]));
  return (id) => byId.get(id);
}

/** Model-facing Revision projection: field states and what still blocks the result. */
export function viewFromRevision(taskId: TaskId, revision: AnswerRevisionRecord, context?: ProbeContext, report = false): AnswerRevisionView {
  const equivalent = equivalentPaths(revision.fields, context?.probes ?? []);
  return {
    taskId,
    revisionId: revision.revisionId,
    ...(revision.parentRevisionId ? { parentRevisionId: revision.parentRevisionId } : {}),
    fields: clone(ordered(revision.fields).map(([path, field]) => fieldView(path, field, revision.fields, equivalent, context))),
    undeclared: undeclaredPaths(revision.fields, report, calendarRequiredPaths(revision.calendarCoverage)),
    open: openPaths(revision.fields, equivalent),
    unverified: unverifiedFields(revision.fields).map((item) => item.path),
    ...(revision.entityIdentity ? { entityIdentity: clone(revision.entityIdentity) } : {}),
    ...(revision.calendarCoverage ? { calendarCoverage: clone(revision.calendarCoverage) } : {}),
    ...(revision.deviations && revision.deviations.length > 0 ? { deviations: clone(revision.deviations) } : {}),
    ...(revision.measureRef ? { measureRef: revision.measureRef } : {}),
  };
}
