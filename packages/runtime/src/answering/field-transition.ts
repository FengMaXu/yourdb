import type {
  AdviceOverride,
  AlternativeId,
  Deviation,
  Evidence,
  EvidenceId,
  FieldAlternative,
  FieldBasis,
  FieldProbeRecord,
  FieldRecord,
  FieldRewrite,
  NonEmpty,
  ParentBinding,
  ProbeWaiver,
  SpecFields,
  UntrustedEvidenceInput,
} from "./model.js";
import {
  FIELD_PATHS,
  FieldValueError,
  MEASURE_DEFINITION,
  POPULATION_PATHS,
  isSharedPath,
  isSpecPath,
  layerOf,
  needsAdvice,
  parseFieldValue,
  valueKey,
  type FieldValue,
  type MeasureDefinitionValue,
  type SpecPath,
} from "./fields.js";
import { makeInternalId } from "./internal-ids.js";
import { isAdmissibleProof } from "./qualification.js";
import { probeContext, summarizeProbes } from "./probes.js";
import { applicableAdvice, type FieldAdvisory } from "./advice.js";
import { asRecord, trimmedText } from "../primitives.js";

/**
 * Runtime-owned field transitions (ADR-0004, ADR-0007). The model writes a
 * field by path; these pure functions decide the next field record. A field
 * that already has a state changes only with a reason, and nothing leaves a
 * Revision by omission.
 */

/** A rationale must argue, not label. */
export const MIN_RATIONALE_LENGTH = 20;

/** Resolves an evidence reference: a cite's handle from this call first, then a registered Evidence id. */
export type EvidenceResolver = ((ref: string) => Evidence | undefined) & { readonly localIds?: readonly string[] };

/**
 * require_evidence: a clarification path exists, so an unverified material population decision, or a
 * decision the advice could not separate, needs qualifying evidence; allow_disclosed: none does, so disclose instead.
 */
export type PopulationDecisions = "require_evidence" | "allow_disclosed";

/** Probes, advice and policy the Runtime applies when an open field is decided (ADR-0005, ADR-0006). */
export interface DecisionGovernance {
  /** Absent: probes are not tracked and a decision needs only a rationale. */
  readonly probes?: readonly FieldProbeRecord[];
  /** Latest advice the Runtime recorded for a field. */
  readonly advice?: (path: string) => FieldAdvisory | undefined;
  /** An advisor is configured: decisive open fields need advice before a decision. */
  readonly adviceRequired?: boolean;
  readonly populationDecisions: PopulationDecisions;
}

/** A parsed, still unchecked write of one path. */
export type FieldWrite =
  | { readonly kind: "not_applicable"; readonly reason?: string }
  | {
      readonly kind: "value";
      readonly value: FieldValue;
      /** Evidence handles or ids the value cites; their qualification decides the basis. */
      readonly refs: readonly string[];
      readonly rationale?: string;
      readonly reason?: string;
    }
  | { readonly kind: "open"; readonly alternatives: NonEmpty<FieldValue>; readonly reason?: string }
  /** A value with a rationale: decides the open field it names, or is an assumption when the field is not open. */
  | {
      readonly kind: "decide";
      readonly value: FieldValue;
      readonly rationale: string;
      readonly refs: readonly string[];
      readonly adviceOverride?: { readonly reason: string; readonly evidenceIds: readonly string[] };
      readonly reason?: string;
    }
  | { readonly kind: "waive"; readonly waivers: readonly { readonly alternativeId: string; readonly reason: string }[] }
  /** Chart query: take a Report Task measure definition (ADR-0009). */
  | { readonly kind: "ref"; readonly name: string; readonly reason?: string };

export interface ParsedField {
  readonly path: SpecPath;
  readonly write: FieldWrite;
  /** Text evidence the write cites; admitted before the Store transaction. */
  readonly evidence: readonly UntrustedEvidenceInput[];
}

export const FIELD_FORMS = 'one of: "n/a"; a bare value (an assumption, disclosed); {value, basis:"request", quote}; {value, cite:[{source, quote}]}; {value, evidenceIds}; {value, basis:"assumed", rationale}; {open:[value, ...]}; to decide an open field {value:<alternative>, rationale, evidenceIds?}; {notProbeable:{<alternativeId>: reason}}';

const FORM_KEYS = ["value", "open", "basis", "quote", "cite", "evidenceIds", "rationale", "reason", "adviceOverride", "notProbeable", "ref"] as const;

export class FieldWriteError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "SPEC_TRANSITION_INVALID" | "EVIDENCE_REJECTED", message: string) {
    super(message);
    this.name = "FieldWriteError";
  }
}

function invalid(message: string): never {
  throw new FieldWriteError("INVALID_REQUEST", message);
}

function transitionInvalid(message: string): never {
  throw new FieldWriteError("SPEC_TRANSITION_INVALID", message);
}

function evidenceRejected(message: string): never {
  throw new FieldWriteError("EVIDENCE_REJECTED", message);
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !trimmedText(item))) invalid(`${label} must be a non-empty list of non-empty strings`);
  return (value as string[]).map((item) => item.trim());
}

function fieldValue(path: SpecPath, value: unknown): FieldValue {
  try {
    return parseFieldValue(path, value);
  } catch (error) {
    if (error instanceof FieldValueError) invalid(error.message);
    throw error;
  }
}

/** Text evidence for a cite; quotes are verified by Evidence Admission before the transaction. */
function citeEvidence(path: string, cite: unknown, currentMessageId: string | undefined): UntrustedEvidenceInput[] {
  if (!Array.isArray(cite) || cite.length === 0) invalid(`${path}.cite must list at least one {source, quote}`);
  return cite.map((item, index) => {
    const entry = asRecord(item) ?? invalid(`${path}.cite[${index}] must be {source, quote}`);
    const source = trimmedText(entry.source) ?? invalid(`${path}.cite[${index}].source is required`);
    const quote = trimmedText(entry.quote);
    const localId = `${path}#cite${index + 1}`;
    const [scheme, ...rest] = source.split(":");
    const ref = rest.join(":").trim();
    const quoted = (label: string) => quote ?? invalid(`${path}.cite[${index}] from ${label} needs a verbatim quote`);
    if (source === "message") {
      if (!currentMessageId) invalid(`${path}.cite[${index}]: the current user message is not available in this call`);
      return { localId, kind: "user_confirmation", sourceRef: currentMessageId, quote: quoted("message") };
    }
    if (scheme === "clarification" && ref) return { localId, kind: "user_confirmation", sourceRef: `clarification:${ref}`, quote: quoted("a clarification") };
    if (scheme === "knowledge" && ref) return { localId, kind: "document", sourceRef: ref, quote: quoted("a document") };
    if (scheme === "schema" && ref) return { localId, kind: "schema_fact", sourceRef: ref, ...(quote ? { quote } : {}) };
    return invalid(`${path}.cite[${index}].source ${JSON.stringify(source)} must be knowledge:<id>, schema:<table.column>, clarification:<id> or message`);
  });
}

/** Parses one path's untrusted write. Pure and synchronous: nothing is checked against state yet. */
export function parseFieldWrite(rawPath: string, input: unknown, currentMessageId?: string): ParsedField {
  const path = rawPath.trim();
  if (!isSpecPath(path)) {
    // Mistakes seen in practice get their own answer: a form key written as a path, or appended to one,
    // and measures without a name.
    const segments = path.split(".");
    const key = segments.at(-1) ?? "";
    if ((FORM_KEYS as readonly string[]).includes(key)) {
      const owner = segments.length > 1 && isSpecPath(segments.slice(0, -1).join(".")) ? segments.slice(0, -1).join(".") : key === "ref" ? "measure.formula" : "<field path>";
      invalid(`${path} is not a field path: "${key}" goes inside the field it belongs to, {"${owner}": {${key === "ref" ? "" : `"value": …, `}"${key}": …}}${key === "ref" ? " (only on a chart query)" : ""}`);
    }
    if (path === "measures") invalid(`measures is written one measure per path, "measures.<name>": {formula, countGrain?, denominator?, window?}, and only on a Report Task; a chart query takes a measure with "measure.formula": {"ref": "<name>"}`);
    invalid(`unknown field path ${path}; use one of ${FIELD_PATHS.join(", ")}, or measures.<name> on a Report Task`);
  }
  if (input === "n/a") return { path, write: { kind: "not_applicable" }, evidence: [] };
  const body = asRecord(input);
  // A value can itself be an object ({rowMode}, {op}, {name}); without any form key it is a bare value.
  if (!body || !FORM_KEYS.some((key) => key in body)) {
    return { path, write: { kind: "value", value: fieldValue(path, input), refs: [] }, evidence: [] };
  }
  const reason = trimmedText(body.reason);
  const withReason = <T extends object>(write: T) => (reason ? { ...write, reason } : write) as T & { readonly reason?: string };
  if (body.notProbeable !== undefined) {
    const entries = asRecord(body.notProbeable) ?? invalid(`${path}.notProbeable must map alternative ids to reasons`);
    const waivers = Object.entries(entries).map(([alternativeId, why]) => ({ alternativeId: alternativeId.trim(), reason: trimmedText(why) ?? invalid(`${path}.notProbeable.${alternativeId} needs a reason`) }));
    if (waivers.length === 0) invalid(`${path}.notProbeable must name at least one alternative`);
    return { path, write: { kind: "waive", waivers }, evidence: [] };
  }
  if (body.ref !== undefined) {
    if (path !== "measure.formula") invalid(`${path} cannot take a ref; only measure.formula references a Report Task measure definition`);
    return { path, write: withReason({ kind: "ref" as const, name: trimmedText(body.ref) ?? invalid("measure.formula.ref must name a Report Task measure definition") }), evidence: [] };
  }
  if (body.open !== undefined) {
    if (!Array.isArray(body.open) || body.open.length < 2) invalid(`${path}.open needs at least two alternatives`);
    const alternatives = body.open.map((item) => fieldValue(path, item));
    if (new Set(alternatives.map(valueKey)).size !== alternatives.length) invalid(`${path}.open repeats an alternative`);
    return { path, write: withReason({ kind: "open" as const, alternatives: alternatives as unknown as NonEmpty<FieldValue> }), evidence: [] };
  }
  if (!("value" in body)) invalid(`${path} has no value; write ${FIELD_FORMS}`);
  if (body.value === "n/a") return { path, write: withReason({ kind: "not_applicable" as const }), evidence: [] };
  if (body.value === null || body.value === undefined || body.value === "") invalid(`${path}.value must not be empty`);
  const value = fieldValue(path, body.value);
  const rationale = trimmedText(body.rationale);
  if (body.basis === "assumed") {
    if (!rationale) invalid(`${path} with basis "assumed" needs a rationale`);
    return { path, write: withReason({ kind: "value" as const, value, refs: [], rationale }), evidence: [] };
  }
  if (body.basis !== undefined && body.basis !== "request") invalid(`${path}.basis must be "request" or "assumed"; cite sources with cite, observations with evidenceIds`);
  const evidence: UntrustedEvidenceInput[] = [];
  if (body.basis === "request") {
    const quote = trimmedText(body.quote) ?? invalid(`${path} with basis "request" needs the verbatim request text in quote`);
    evidence.push({ localId: `${path}#request`, kind: "request_wording", quote });
  }
  if (body.cite !== undefined) evidence.push(...citeEvidence(path, body.cite, currentMessageId));
  const evidenceIds = body.evidenceIds === undefined ? [] : strings(body.evidenceIds, `${path}.evidenceIds`);
  const refs = [...evidence.map((item) => item.localId!), ...evidenceIds];
  if (rationale) {
    // Decides the open field it names; on a field that is not open it is a value with its reasoning.
    const override = body.adviceOverride === undefined ? undefined : asRecord(body.adviceOverride) ?? invalid(`${path}.adviceOverride must be {reason, evidenceIds}`);
    const adviceOverride = override ? { reason: trimmedText(override.reason) ?? invalid(`${path}.adviceOverride.reason is required`), evidenceIds: strings(override.evidenceIds, `${path}.adviceOverride.evidenceIds`) } : undefined;
    return { path, write: withReason({ kind: "decide" as const, value, rationale, refs, ...(adviceOverride ? { adviceOverride } : {}) }), evidence };
  }
  // Without cited evidence the value is an assumption, disclosed at publication.
  return { path, write: withReason({ kind: "value" as const, value, refs }), evidence };
}

const ALLOWED_EVIDENCE: Readonly<Record<"semantic" | "physical", readonly Evidence["kind"][]>> = {
  semantic: ["user_confirmation", "reviewed_definition", "task_document", "request_wording"],
  physical: ["reviewed_definition", "schema_fact", "query_observation"],
};

/** Why a piece of evidence cannot settle a field, or undefined when it can. */
export function disqualification(path: SpecPath, evidence: Evidence): string | undefined {
  const layer = layerOf(path);
  if (!ALLOWED_EVIDENCE[layer].includes(evidence.kind)) return `${evidence.kind} cannot settle the ${layer} field ${path}; it accepts ${ALLOWED_EVIDENCE[layer].join(", ")}`;
  if (!isAdmissibleProof(evidence)) return `${evidence.id} has no Runtime-verified quote`;
  return undefined;
}

function resolveRefs(refs: readonly string[], resolve: EvidenceResolver, label: string): Evidence[] {
  return refs.map((ref) => {
    const evidence = resolve(ref);
    if (!evidence) evidenceRejected(`${label} references unknown evidence ${ref}; cite it again or use an evidenceId returned by query_database`);
    return evidence;
  });
}

/**
 * ADR-0006: the Runtime decides whether cited evidence settles the value.
 * Evidence that exists but does not qualify only makes it an assumption.
 */
function basisFor(path: SpecPath, cited: readonly Evidence[], rationale: string | undefined): FieldBasis {
  const qualifying = cited.filter((evidence) => !disqualification(path, evidence));
  if (qualifying.length > 0) return { kind: "evidence", evidenceIds: qualifying.map((evidence) => evidence.id) as unknown as NonEmpty<EvidenceId> };
  return { kind: "assumed", ...(rationale ? { rationale } : {}), ...(cited.length > 0 ? { citedEvidenceIds: cited.map((evidence) => evidence.id) } : {}) };
}

/**
 * The material population is not settled by an unverified decision while the
 * user can still be asked (ADR-0006); population.eligibility is not settled by
 * an assumption either.
 */
function guardPopulation(path: SpecPath, basis: FieldBasis, kind: "assumed" | "decided", cited: readonly Evidence[], policy: PopulationDecisions): void {
  if (policy !== "require_evidence" || basis.kind === "evidence") return;
  const governed = kind === "decided" ? POPULATION_PATHS.has(path) : path === "population.eligibility";
  if (!governed) return;
  const reasons = cited.map((evidence) => disqualification(path, evidence)).filter(Boolean);
  transitionInvalid(`${path} settles the material population and nothing cited qualifies it${reasons.length > 0 ? ` (${reasons.join("; ")})` : ""}; cite the request verbatim, a business document or the user's confirmation, or ask the user`);
}

function rationaleOf(value: string | undefined, label: string): string {
  const rationale = value?.trim() ?? "";
  if (rationale.length < MIN_RATIONALE_LENGTH) transitionInvalid(`${label} needs a rationale: why this alternative fits the request best and what excludes the others`);
  return rationale;
}

/** The open field is one the advice must weigh: an advisor is configured and its alternatives' outputs are not known to agree. */
function adviceGoverned(path: SpecPath, current: Extract<FieldRecord, { state: "open" }>, governance: DecisionGovernance, fields: SpecFields): boolean {
  if (!governance.probes || !governance.adviceRequired || !needsAdvice(path)) return false;
  return summarizeProbes(path, current.alternatives, governance.probes, current.waivers ?? [], probeContext(fields, path)).outputs !== "identical";
}

/** How a decision settled its advice requirement. */
interface DecisionAdvice {
  readonly adviceOverride?: AdviceOverride;
  readonly adviceUnavailable?: string;
  readonly adviceUndecided?: string;
}

/**
 * Evidence that can settle a meaning the advisor could not separate: the user's
 * answer or a business definition. Request wording is not enough here; the
 * advisor already read the request and found more than one reading plausible.
 */
const SETTLES_UNDECIDED: readonly Evidence["kind"][] = ["user_confirmation", "reviewed_definition", "task_document"];

/**
 * ADR-0005 rules for deciding an open field: every alternative's output is
 * known, decisive fields were compared, and departing from a clear lean needs
 * a reason plus evidence. When the advisor failed, the decision proceeds
 * without advice and records the failure for disclosure. When the advisor
 * answered but favours no alternative, the field is undecidable from the
 * request: while the user can be asked, the decision must cite the user's
 * answer or a business document; otherwise it is recorded for disclosure.
 */
function governDecision(
  path: SpecPath,
  current: Extract<FieldRecord, { state: "open" }>,
  alternativeId: string,
  override: { readonly reason: string; readonly evidenceIds: readonly string[] } | undefined,
  governance: DecisionGovernance,
  resolve: EvidenceResolver,
  decisionCites: readonly Evidence[],
  fields: SpecFields,
): DecisionAdvice {
  if (!governance.probes) return {};
  const summary = summarizeProbes(path, current.alternatives, governance.probes, current.waivers ?? [], probeContext(fields, path));
  if (!summary.covered) {
    const stale = summary.stale.length > 0 ? ` (${summary.stale.join(", ")} were probed before other fields changed)` : "";
    transitionInvalid(`${path} needs the output of every alternative under the current other fields before a decision: run query_database kind=exploration with probe {path: "${path}", alternativeId} for ${summary.missing.join(", ")}${stale}, or write {notProbeable: {<alternativeId>: reason}}`);
  }
  // Advice applies only to the alternatives and probe outputs it was asked about.
  const advice = applicableAdvice(governance.advice?.(path), current.alternatives, summary);
  const governed = adviceGoverned(path, current, governance, fields);
  if (!advice && governed) {
    transitionInvalid(`${path}: the alternatives produce different or unknown outputs and the Runtime holds no comparison of them yet; send the decision again`);
  }
  if (advice?.recommendation === "unavailable") return governed ? { adviceUnavailable: advice.failure ?? "the advisor did not answer" } : {};
  if (governed && advice && !advice.lean) {
    const settled = decisionCites.some((evidence) => SETTLES_UNDECIDED.includes(evidence.kind) && isAdmissibleProof(evidence));
    if (settled) return {};
    if (governance.populationDecisions === "require_evidence") {
      transitionInvalid(`${path}: the advice favoured no alternative (${advice.recommendation}), so the request does not settle it; ask the user with ask_user_clarification and cite the answer (cite source "clarification:<id>"), or cite a business document that settles it`);
    }
    return { adviceUndecided: advice.recommendation };
  }
  const lean = advice?.lean;
  if (!lean || lean.alternativeId === alternativeId) return {};
  if (!override || override.reason.length < MIN_RATIONALE_LENGTH || override.evidenceIds.length === 0) {
    transitionInvalid(`${path}: the advice leaned to alternative ${lean.alternativeId} (p=${lean.probability}); choosing ${alternativeId} requires adviceOverride with a reason and at least one evidence id showing why the lean is wrong`);
  }
  const cited = override.evidenceIds.map((ref) => {
    const evidence = resolve(ref);
    if (!evidence) evidenceRejected(`${path}: adviceOverride references unknown evidence ${ref}`);
    return evidence;
  });
  // Outweighing the lean takes evidence that could settle the field itself: observations never settle meaning.
  if (cited.every((evidence) => disqualification(path, evidence))) {
    const reasons = cited.map((evidence) => disqualification(path, evidence)).join("; ");
    transitionInvalid(`${path}: adviceOverride needs evidence that qualifies for this field to outweigh the lean to ${lean.alternativeId} (${reasons}); cite the request verbatim, a business document or the user's confirmation, or decide the leaned alternative`);
  }
  return { adviceOverride: { reason: override.reason, evidenceIds: cited.map((evidence) => evidence.id) as unknown as NonEmpty<EvidenceId> } };
}

/** What one Revision is made of while a set call is applied. */
export interface FieldBody {
  readonly fields: SpecFields;
  readonly rewrites: readonly FieldRewrite[];
  readonly deviations: readonly Deviation[];
  readonly measureRef?: string;
}

export interface WriteContext {
  readonly resolve: EvidenceResolver;
  readonly governance: DecisionGovernance;
  /** The task is a Report Task: only shared paths may be written. */
  readonly report: boolean;
  /** The task is a chart query: shared paths are inherited from its Report Task. */
  readonly inherited?: InheritedFields;
}

/** The shared fields of one Report Task Revision, as a chart query bound to it receives them (ADR-0009). */
export interface InheritedFields {
  readonly binding: ParentBinding;
  readonly fields: SpecFields;
}

function setField(body: FieldBody, path: SpecPath, next: FieldRecord | undefined): FieldBody {
  const fields: Partial<Record<SpecPath, FieldRecord>> = { ...body.fields };
  if (next) fields[path] = next;
  else delete fields[path];
  return { ...body, fields };
}

function withRewrite(body: FieldBody, path: SpecPath, reason: string | undefined): FieldBody {
  return reason ? { ...body, rewrites: [...body.rewrites.filter((item) => item.path !== path), { path, reason }] } : body;
}

/** A chart query changes an inherited field only with a reason, recorded as a deviation and disclosed (ADR-0009 decision 3). */
function withDeviation(body: FieldBody, path: SpecPath, reason: string): FieldBody {
  return { ...body, deviations: [...body.deviations.filter((item) => item.path !== path), { path, reason }] };
}

function newAlternatives(values: readonly FieldValue[]): NonEmpty<FieldAlternative> {
  return values.map((value) => ({ id: makeInternalId("alternative") as unknown as AlternativeId, value })) as unknown as NonEmpty<FieldAlternative>;
}

/** Measure sub-fields a Report Task definition carries into a chart query's measure. */
const DEFINITION_PARTS = [["countGrain", "measure.countGrain"], ["denominator", "measure.denominator"], ["window", "measure.window"]] as const;

/** Copies a Report Task measure definition into the chart query's measure fields (ADR-0009). */
export function applyMeasureRef(body: FieldBody, inherited: InheritedFields, name: string): FieldBody {
  const definition = inherited.fields[`measures.${name}`];
  if (!definition) {
    const names = Object.keys(inherited.fields).flatMap((path) => MEASURE_DEFINITION.exec(path)?.[1] ?? []);
    invalid(`The Report Task defines no measure ${JSON.stringify(name)}; ${names.length > 0 ? `defined measures: ${names.join(", ")}` : "it defines no measures"}`);
  }
  if (definition.state !== "specified" && definition.state !== "decided") {
    transitionInvalid(`The Report Task has not settled measures.${name}; settle it on the Report Task first`);
  }
  const value = definition.value as MeasureDefinitionValue;
  const copy = (part: FieldValue): FieldRecord => ({ state: "specified", value: part, basis: definition.basis, inherited: definition.inherited ?? inherited.binding });
  let next = setField(body, "measure.formula", copy(value.formula));
  for (const [key, path] of DEFINITION_PARTS) {
    const part = value[key];
    if (part) next = setField(next, path, copy(part));
  }
  return { ...next, measureRef: name };
}

/** Puts a Report Task's shared population over a chart query, except the paths it deviates on. */
export function overlayInherited(body: FieldBody, inherited: InheritedFields): FieldBody {
  const kept = new Set<string>(body.deviations.map((item) => item.path));
  const fields: Partial<Record<SpecPath, FieldRecord>> = {};
  for (const [path, field] of Object.entries(body.fields) as [SpecPath, FieldRecord][]) {
    if (!path.startsWith("population.") || kept.has(path)) fields[path] = field;
  }
  for (const [path, field] of Object.entries(inherited.fields) as [SpecPath, FieldRecord][]) {
    if (path.startsWith("population.") && !kept.has(path)) fields[path] = { ...field, inherited: field.inherited ?? inherited.binding };
  }
  return { ...body, fields };
}

/**
 * Applies one parsed write to the body. Throws FieldWriteError when the write
 * is rejected; the caller skips it and the body is unchanged.
 */
export function applyFieldWrite(body: FieldBody, parsed: ParsedField, context: WriteContext): FieldBody {
  const { path, write } = parsed;
  if (context.report && !isSharedPath(path)) invalid(`A Report Task holds only shared fields (population.* and measures.<name>); set ${path} in each chart query`);
  if (!context.report && MEASURE_DEFINITION.test(path)) invalid(`${path} is a Report Task measure definition; set it on a Report Task (report: true)`);
  if (!context.inherited && write.kind === "ref") invalid("measure.formula.ref references a Report Task measure definition; only a chart query (parentTaskId) can use it");
  const current = body.fields[path];

  if (write.kind === "waive") {
    if (current?.state !== "open") transitionInvalid(`${path} has no open alternatives to mark not probeable`);
    const waivers = new Map((current.waivers ?? []).map((item) => [item.alternativeId as string, item]));
    for (const item of write.waivers) {
      if (!current.alternatives.some((alternative) => alternative.id === item.alternativeId)) transitionInvalid(`${item.alternativeId} is not an alternative of ${path}; use an alternativeId from the state table`);
      if (item.reason.length < MIN_RATIONALE_LENGTH) transitionInvalid(`notProbeable for ${item.alternativeId} needs a reason explaining why the alternative cannot be executed on its own`);
      waivers.set(item.alternativeId, { alternativeId: item.alternativeId as AlternativeId, reason: item.reason });
    }
    return setField(body, path, { ...current, waivers: [...waivers.values()] as ProbeWaiver[] });
  }

  // Deciding an open field is its expected next step; anything else that replaces a state needs a reason.
  const decides = write.kind === "decide" && current?.state === "open";
  const reason = write.reason;
  // When the Report Task defines measures, a chart query's own measure is a deviation too.
  const definesMeasures = Object.keys(context.inherited?.fields ?? {}).some((item) => MEASURE_DEFINITION.test(item));
  const chartShared = Boolean(context.inherited) && (path.startsWith("population.") || (path === "measure.formula" && write.kind !== "ref" && definesMeasures));
  if (chartShared && !reason) {
    transitionInvalid(`${path} is shared through the Report Task; changing it in a chart query needs "reason" (recorded as a deviation and disclosed), or change it on the Report Task`);
  }
  if (current && !decides && !reason && !chartShared) {
    transitionInvalid(`${path} is already set; add "reason" to change it${current.state === "open" ? ", or decide one of its alternatives with {value, rationale}" : ""}`);
  }
  const finish = (next: FieldBody) => {
    const rewritten = current && !decides ? withRewrite(next, path, reason) : next;
    return chartShared ? withDeviation(rewritten, path, reason!) : rewritten;
  };

  if (write.kind === "ref") {
    // A ref replaces the measure fields the definition carries; other measure fields keep their state.
    return finish(applyMeasureRef(body, context.inherited!, write.name));
  }
  // Writing a measure of the chart query's own ends its reference to a definition.
  const own = (next: FieldBody): FieldBody => {
    if (path !== "measure.formula" || !next.measureRef) return next;
    const { measureRef: _ref, ...rest } = next;
    return rest;
  };

  if (write.kind === "not_applicable") return finish(own(setField(body, path, { state: "not_applicable" })));

  if (write.kind === "open") return finish(own(setField(body, path, { state: "open", alternatives: newAlternatives(write.alternatives) })));

  if (decides) {
    const open = current as Extract<FieldRecord, { state: "open" }>;
    const wanted = valueKey(write.value);
    const alternative = open.alternatives.find((item) => valueKey(item.value) === wanted)
      ?? transitionInvalid(`${path}: ${wanted} is not one of its alternatives ${open.alternatives.map((item) => `${item.id}=${valueKey(item.value)}`).join("; ")}`);
    const rationale = rationaleOf(write.rationale, `Deciding ${path}`);
    const cited = resolveRefs(write.refs, context.resolve, path);
    const basis = basisFor(path, cited, rationale);
    guardPopulation(path, basis, "decided", cited, context.governance.populationDecisions);
    const { adviceOverride, adviceUnavailable, adviceUndecided } = governDecision(path, open, alternative.id, write.adviceOverride, context.governance, context.resolve, cited, body.fields);
    return own(setField(body, path, {
      state: "decided",
      alternatives: open.alternatives,
      ...(open.waivers ? { waivers: open.waivers } : {}),
      alternativeId: alternative.id,
      value: alternative.value,
      rationale,
      basis,
      ...(adviceOverride ? { adviceOverride } : {}),
      ...(adviceUnavailable ? { adviceUnavailable } : {}),
      ...(adviceUndecided ? { adviceUndecided } : {}),
    }));
  }

  // A value: its basis is evidence when what it cites qualifies, otherwise a disclosed assumption.
  const cited = resolveRefs(write.refs, context.resolve, path);
  const basis = basisFor(path, cited, write.rationale);
  // An assumption cannot stand in for a decision the advice must weigh; only qualifying evidence settles it directly.
  if (current?.state === "open" && basis.kind !== "evidence" && adviceGoverned(path, current, context.governance, body.fields)) {
    transitionInvalid(`${path} is open and its alternatives' outputs differ or are unknown, so an assumption cannot replace it: decide one of its alternatives with {value, rationale} (probe every alternative first), cite evidence that settles it, or reopen it with {open: [...]}`);
  }
  guardPopulation(path, basis, "assumed", cited, context.governance.populationDecisions);
  return finish(own(setField(body, path, { state: "specified", value: write.value, basis })));
}
