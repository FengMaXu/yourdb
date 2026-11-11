import { randomUUID } from "node:crypto";
import {
  contentHash,
  type AnswerRevisionRecord,
  type AnswerRevisionView,
  type BusinessContext,
  type Evidence,
  type FieldOutcome,
  type FieldRecord,
  type ParentBinding,
  type QueryTaskRecord,
  type RevisionId,
  type SetAnswerFields,
  type SpecFields,
  type TaskId,
  type UntrustedEvidenceInput,
} from "./model.js";
import type { SpecPath } from "./fields.js";
import { assertTaskAccess, type AnsweringTransaction } from "./answering-store.js";
import { AnsweringError } from "./errors.js";
import { makeInternalId } from "./internal-ids.js";
import { newBudget, obstacleDetails, reserveAttempt } from "./budget.js";
import {
  EvidenceAdmissionError,
  admitEvidence,
  type AdmissionScope,
  type AdmittedEvidence,
} from "./evidence-admission.js";
import {
  FieldWriteError,
  applyFieldWrite,
  applyMeasureRef,
  overlayInherited,
  parseFieldWrite,
  type DecisionGovernance,
  type EvidenceResolver,
  type FieldBody,
  type InheritedFields,
  type ParsedField,
} from "./field-transition.js";
import { inheritedFields } from "./report.js";
import { attachDataChecks } from "./data-checks-execution.js";
import { localId, now } from "./support.js";
import { probeContextFor, viewFromRevision } from "./views.js";
import { ensureAdvice } from "./advice-execution.js";
import { adviceView, type FieldAdvisory } from "./advice.js";
import type { AnsweringDeps } from "./deps.js";

function requestEvidenceId(requestMessageId: string): string {
  return `request_${contentHash(requestMessageId).slice(0, 24)}`;
}

/**
 * The auto-registered request handle gives reviewers the
 * original message identity. It has no quote or verification and therefore
 * never settles a field.
 */
function requestHandleEvidence(requestMessageId: string, observedAt: string): Evidence {
  return { id: requestEvidenceId(requestMessageId) as Evidence["id"], kind: "request_wording", authority: "request_wording", sourceRef: requestMessageId, observedAt };
}

const EVIDENCE_AUTHORITY = {
  user_confirmation: "user",
  reviewed_definition: "reviewed_business_definition",
  task_document: "task_document",
  request_wording: "request_wording",
  schema_fact: "schema",
} as const;

function evidenceFromAdmission(item: AdmittedEvidence, observedAt: string): Evidence {
  if (item.kind === "query_observation") throw new AnsweringError("EVIDENCE_REJECTED", "query_observation is registered only by exploration queries");
  return {
    id: `evidence_${randomUUID()}` as Evidence["id"],
    kind: item.kind,
    authority: EVIDENCE_AUTHORITY[item.kind],
    sourceRef: item.sourceRef,
    ...(item.contentHash ? { contentHash: item.contentHash } : {}),
    ...(item.quote ? { quote: item.quote } : {}),
    ...(item.verification ? { verification: item.verification } : {}),
    observedAt,
  } as Evidence;
}

/** A write's own cite handles are checked first, then task Evidence ids. */
function evidenceResolver(registered: readonly Evidence[], added: readonly { readonly localId?: string; readonly evidence: Evidence }[]): EvidenceResolver {
  const byLocal = new Map(added.flatMap((item) => item.localId ? [[item.localId, item.evidence] as const] : []));
  const byId = new Map([...registered, ...added.map((item) => item.evidence)].map((item) => [item.id as string, item]));
  return Object.assign((ref: string) => byLocal.get(ref) ?? byId.get(ref), { localIds: [...byLocal.keys()] });
}

async function admit(inputs: readonly UntrustedEvidenceInput[], scope: AdmissionScope): Promise<readonly AdmittedEvidence[]> {
  if (inputs.length === 0) return [];
  try {
    return await admitEvidence(inputs, scope);
  } catch (error) {
    if (error instanceof EvidenceAdmissionError) throw new AnsweringError("EVIDENCE_REJECTED", error.message);
    throw error;
  }
}

function governanceFor(deps: AnsweringDeps, task: Pick<QueryTaskRecord, "taskId" | "fieldProbes">): DecisionGovernance {
  const context = probeContextFor(deps, task);
  return {
    ...(context?.tracked ? { probes: context.probes } : {}),
    ...(context?.advice ? { advice: context.advice } : {}),
    adviceRequired: deps.adviceRequired,
    populationDecisions: deps.populationDecisions,
  };
}

function rejection(path: string, error: unknown): FieldOutcome | undefined {
  if (error instanceof FieldWriteError) return { path, status: "rejected", code: error.code, message: error.message };
  if (error instanceof AnsweringError && ["SPEC_TRANSITION_INVALID", "INVALID_REQUEST", "EVIDENCE_REJECTED"].includes(error.code)) {
    return { path, status: "rejected", code: error.code, message: error.message };
  }
  return undefined;
}

interface PreparedWrite {
  readonly path: string;
  readonly parsed?: ParsedField;
  readonly admitted: readonly AdmittedEvidence[];
  /** Set when parsing or trusted-source checks already rejected the write. */
  readonly rejected?: FieldOutcome;
}

/** Parsing and Evidence Admission happen per path, before the Store transaction (ADR-0004). */
async function prepareWrites(deps: AnsweringDeps, input: SetAnswerFields, taskRequestMessageId: string, context: BusinessContext): Promise<readonly PreparedWrite[]> {
  const prepared: PreparedWrite[] = [];
  const scope: AdmissionScope = {
    sessionId: context.sessionId,
    taskRequestMessageId,
    ...(deps.evidenceSource ? { source: deps.evidenceSource } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  };
  for (const [rawPath, value] of Object.entries(input.fields)) {
    const path = rawPath.trim();
    try {
      const parsed = parseFieldWrite(path, value, input.currentMessageId);
      prepared.push({ path, parsed, admitted: await admit(parsed.evidence, scope) });
    } catch (error) {
      const rejected = rejection(path, error);
      if (!rejected) throw error;
      prepared.push({ path, admitted: [], rejected });
    }
  }
  return prepared;
}

interface TaskShape {
  readonly report: boolean;
  readonly inherited?: InheritedFields;
}

/**
 * Applies each write to the state the earlier applied writes left. A rejected
 * write changes nothing, and its Evidence is not registered.
 */
function applyWrites(base: FieldBody, writes: readonly PreparedWrite[], registered: readonly Evidence[], governance: DecisionGovernance, shape: TaskShape, createdAt: string) {
  let body = base;
  const outcomes: FieldOutcome[] = [];
  const added: Evidence[] = [];
  for (const write of writes) {
    if (write.rejected || !write.parsed) {
      outcomes.push(write.rejected ?? { path: write.path, status: "rejected", message: "not parsed" });
      continue;
    }
    const own = write.admitted.map((item) => ({ ...(item.localId ? { localId: item.localId } : {}), evidence: evidenceFromAdmission(item, createdAt) }));
    try {
      body = applyFieldWrite(body, write.parsed, {
        resolve: evidenceResolver([...registered, ...added], own),
        governance,
        report: shape.report,
        ...(shape.inherited ? { inherited: shape.inherited } : {}),
      });
      added.push(...own.map((item) => item.evidence));
      outcomes.push({ path: write.parsed.path, status: "applied" });
    } catch (error) {
      const rejected = rejection(write.parsed.path, error);
      if (!rejected) throw error;
      outcomes.push(rejected);
    }
  }
  return { body, outcomes, added, applied: outcomes.some((outcome) => outcome.status === "applied") };
}

/** What the view adds about the call and the task rather than the Revision. */
function taskExtras(tx: Pick<AnsweringTransaction, "getTask" | "listChartQueries">, task: Pick<QueryTaskRecord, "taskId" | "currentRevisionId" | "role" | "parent">, outcomes?: readonly FieldOutcome[]): Partial<AnswerRevisionView> {
  // A changed Report Task leaves its open chart queries bound to the Revision they copied: say so before they
  // are queried. Published and closed ones keep what they delivered; rebinding would reopen them.
  const stale = task.role === "report"
    ? tx.listChartQueries(task.taskId).filter((chart) => chart.lifecycle === "open" && chart.parent?.revisionId !== task.currentRevisionId).map((chart) => chart.taskId)
    : [];
  return {
    ...(outcomes ? { outcomes } : {}),
    ...(task.role ? { role: task.role } : {}),
    ...(task.parent ? { parent: { ...task.parent, current: tx.getTask(task.parent.taskId)?.currentRevisionId === task.parent.revisionId } } : {}),
    ...(stale.length > 0 ? { staleChartQueries: stale } : {}),
  };
}

/** Shows advice recorded after the view was built on the fields it is about. */
function withAdvice(view: AnswerRevisionView, advice: readonly FieldAdvisory[]): AnswerRevisionView {
  if (advice.length === 0) return view;
  const byPath = new Map(advice.map((item) => [item.path, item]));
  return { ...view, fields: view.fields.map((field) => byPath.has(field.path) ? { ...field, advice: adviceView(byPath.get(field.path)!) } : field) };
}

/** The Report Task a chart query is bound to, and the fields it copies from it. */
function bindParent(tx: AnsweringTransaction, parentTaskId: string, context: BusinessContext) {
  const parent = tx.getTask(parentTaskId as TaskId);
  assertTaskAccess(parent, context);
  if (parent.role !== "report") throw new AnsweringError("INVALID_REQUEST", `Task ${parentTaskId} is not a Report Task; start one with report: true`);
  const revision = tx.getRevision(parent.currentRevisionId);
  if (!revision) throw new AnsweringError("REVISION_NOT_FOUND", `Report Task Revision ${parent.currentRevisionId} was not found`);
  const binding: ParentBinding = { taskId: parent.taskId, revisionId: parent.currentRevisionId };
  return { binding, inherited: inheritedFields(revision, binding), evidence: tx.listEvidence(parent.taskId) };
}

function bodyOf(revision: AnswerRevisionRecord): FieldBody {
  return { fields: revision.fields, rewrites: [], deviations: revision.deviations ?? [], ...(revision.measureRef ? { measureRef: revision.measureRef } : {}) };
}

function revisionRecord(base: Pick<AnswerRevisionRecord, "taskId" | "revisionId" | "requestId" | "createdAt"> & { readonly parentRevisionId?: RevisionId; readonly parentBinding?: ParentBinding }, body: FieldBody): AnswerRevisionRecord {
  return {
    ...base,
    fields: body.fields,
    state: { state: "draft", revisionId: base.revisionId },
    ...(body.rewrites.length > 0 ? { rewrites: body.rewrites } : {}),
    ...(body.deviations.length > 0 ? { deviations: body.deviations } : {}),
    ...(body.measureRef ? { measureRef: body.measureRef } : {}),
  };
}

/** Rebinding drops a measure copied from a definition the Report Task no longer has. */
function dropMeasureRef(body: FieldBody): FieldBody {
  const fields: Partial<Record<SpecPath, FieldRecord>> = {};
  for (const [path, field] of Object.entries(body.fields) as [SpecPath, FieldRecord][]) {
    if (!(path.startsWith("measure.") && field.inherited)) fields[path] = field;
  }
  const { measureRef: _ref, ...rest } = body;
  return { ...rest, fields: fields as SpecFields };
}

/**
 * The single Answer Spec write (ADR-0007). Each path is checked and applied
 * on its own; the applied ones land as one Revision, charged once to the
 * revision budget. Starting a task is not charged.
 */
export async function setAnswerFields(deps: AnsweringDeps, input: SetAnswerFields, context: BusinessContext): Promise<AnswerRevisionView> {
  if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) throw new AnsweringError("INVALID_REQUEST", "fields must map field paths to field writes");
  if (input.taskId) {
    if (input.report || input.parent) throw new AnsweringError("INVALID_REQUEST", "report and parent only start a task; omit taskId");
    return reviseFields(deps, input, context);
  }
  if (input.rebind) throw new AnsweringError("INVALID_REQUEST", "rebind needs the chart query's taskId");
  return startTask(deps, input, context);
}

async function startTask(deps: AnsweringDeps, input: SetAnswerFields, context: BusinessContext): Promise<AnswerRevisionView> {
  if (input.report && input.parent) throw new AnsweringError("INVALID_REQUEST", "A Report Task cannot itself be a chart query of another Report Task");
  const requestMessageId = localId(input.requestMessageId ?? "", "requestMessageId");
  const requestId = localId(input.requestId, "requestId");
  const prepared = await prepareWrites(deps, input, requestMessageId, context);
  let extras: Partial<AnswerRevisionView> = {};
  const outcome = await deps.store.transact(async (tx) => {
    const existing = tx.findTaskByRequest(context.sessionId, requestId);
    if (existing) {
      assertTaskAccess(existing, context);
      const revision = tx.getCurrentRevision(existing.taskId);
      if (!revision) throw new AnsweringError("REVISION_NOT_FOUND", "Existing task has no current revision");
      extras = taskExtras(tx, existing);
      return { view: viewFromRevision(existing.taskId, revision, probeContextFor(deps, existing, tx.listEvidence(existing.taskId)), existing.role === "report") } as const;
    }
    const taskId = makeInternalId("task") as unknown as TaskId;
    const revisionId = makeInternalId("revision") as unknown as RevisionId;
    const createdAt = now();
    const requestEvidence = requestHandleEvidence(requestMessageId, createdAt);
    const parent = input.parent ? bindParent(tx, input.parent.taskId, context) : undefined;
    const empty: FieldBody = { fields: {}, rewrites: [], deviations: [] };
    const start = parent ? overlayInherited(empty, parent.inherited) : empty;
    const shape: TaskShape = { report: input.report === true, ...(parent ? { inherited: parent.inherited } : {}) };
    const applied = applyWrites(start, prepared, [requestEvidence, ...(parent?.evidence ?? [])], governanceFor(deps, { taskId, fieldProbes: [] }), shape, createdAt);
    const evidence = [requestEvidence, ...applied.added];
    for (const item of evidence) tx.appendEvidence(taskId, item);
    const baseRevision = revisionRecord({ taskId, revisionId, requestId, createdAt, ...(parent ? { parentBinding: parent.binding } : {}) }, applied.body);
    const revision: AnswerRevisionRecord = { ...baseRevision, ...(parent ? { parentBinding: parent.binding } : {}) };
    const task: QueryTaskRecord = {
      taskId,
      sessionId: context.sessionId,
      principalId: context.principal.id,
      requestMessageId,
      requestId,
      currentRevisionId: revisionId,
      lifecycle: "open",
      budget: newBudget(deps.budgetPolicy, createdAt),
      ...(input.report ? { role: "report" as const } : {}),
      ...(parent ? { parent: parent.binding } : {}),
      createdAt,
      updatedAt: createdAt,
    };
    tx.putRevision(revision);
    tx.putTask(task);
    extras = taskExtras(tx, task, applied.outcomes);
    return { view: viewFromRevision(taskId, revision, probeContextFor(deps, task, evidence), task.role === "report") } as const;
  }, context);
  const view = await attachDataChecks(deps, outcome.view, context);
  return { ...view, ...extras };
}

/**
 * Revise: when no write applies, nothing is written or charged and the
 * current Revision is returned. `rebind` moves a chart query to its Report
 * Task's current Revision and copies the shared fields again, keeping the
 * ones it deviates on.
 */
async function reviseFields(deps: AnsweringDeps, input: SetAnswerFields, context: BusinessContext): Promise<AnswerRevisionView> {
  const taskId = input.taskId as TaskId;
  const requestId = localId(input.requestId, "requestId");
  const taskRequestMessageId = await deps.store.transact((tx) => {
    const task = tx.getTask(taskId);
    assertTaskAccess(task, context);
    return task.requestMessageId;
  }, context);
  // A decision is checked against the advice: ask for any the probes already call for (ADR-0005).
  await ensureAdvice(deps, taskId, context);
  const prepared = await prepareWrites(deps, input, taskRequestMessageId, context);
  let extras: Partial<AnswerRevisionView> = {};
  const outcome = await deps.store.transact(async (tx) => {
    const existingTask = tx.getTask(taskId);
    assertTaskAccess(existingTask, context);
    const previous = tx.getRevision(existingTask.currentRevisionId);
    if (!previous) throw new AnsweringError("REVISION_NOT_FOUND", `Revision ${existingTask.currentRevisionId} was not found`);
    if (input.rebind && !existingTask.parent) throw new AnsweringError("INVALID_REQUEST", "Only a chart query of a Report Task can be rebound");
    const parent = existingTask.parent ? bindParent(tx, existingTask.parent.taskId, context) : undefined;
    const rebound = Boolean(input.rebind && parent && parent.binding.revisionId !== existingTask.parent!.revisionId);
    let start = bodyOf(previous);
    if (rebound && parent) {
      start = overlayInherited(start, parent.inherited);
      if (start.measureRef) {
        // A definition the Report Task no longer settles leaves the measure for this chart query to set.
        const definition = parent.inherited.fields[`measures.${start.measureRef}`];
        start = definition && (definition.state === "specified" || definition.state === "decided")
          ? applyMeasureRef(start, parent.inherited, start.measureRef)
          : dropMeasureRef(start);
      }
    }
    const createdAt = now();
    const evidence = tx.listEvidence(taskId);
    // The binding a chart query writes against: the new one on a rebind.
    const inherited = parent ? (rebound ? parent.inherited : { ...parent.inherited, binding: existingTask.parent! }) : undefined;
    const shape: TaskShape = { report: existingTask.role === "report", ...(inherited ? { inherited } : {}) };
    const applied = applyWrites(start, prepared, [...evidence, ...(parent?.evidence ?? [])], governanceFor(deps, existingTask), shape, createdAt);
    if (!applied.applied && !rebound) {
      extras = taskExtras(tx, existingTask, applied.outcomes);
      return { view: viewFromRevision(taskId, previous, probeContextFor(deps, existingTask, evidence), existingTask.role === "report") } as const;
    }
    const reservation = reserveAttempt(tx, existingTask, deps.budgetPolicy, "revision", previous.revisionId, context.invocationId);
    if (reservation.obstacle) return { obstacle: reservation.obstacle } as const;
    const task = reservation.task;
    for (const item of applied.added) tx.appendEvidence(taskId, item);
    const allEvidence = [...evidence, ...applied.added];
    const revisionId = makeInternalId("revision") as unknown as RevisionId;
    const binding = existingTask.parent ? (rebound ? parent!.binding : existingTask.parent) : undefined;
    const baseRevision = revisionRecord({ taskId, revisionId, parentRevisionId: previous.revisionId, requestId, createdAt }, applied.body);
    const revision: AnswerRevisionRecord = { ...baseRevision, ...(binding ? { parentBinding: binding } : {}) };
    tx.putRevision(revision);
    const { latestCandidateId: _latestCandidateId, publicationId: _publicationId, ...taskWithoutResults } = task;
    tx.putAttempt({ ...reservation.attempt!, state: "succeeded", outcome: "succeeded", sqlExecuted: false, updatedAt: createdAt });
    const revisedTask: QueryTaskRecord = { ...taskWithoutResults, currentRevisionId: revisionId, lifecycle: "open", updatedAt: createdAt, ...(rebound ? { parent: parent!.binding } : {}) };
    tx.putTask(revisedTask);
    extras = taskExtras(tx, revisedTask, applied.outcomes);
    return { view: viewFromRevision(taskId, revision, probeContextFor(deps, task, allEvidence), task.role === "report") } as const;
  }, context);
  if ("obstacle" in outcome) {
    throw new AnsweringError("IMPLEMENTATION_BUDGET_EXHAUSTED", outcome.obstacle.message, obstacleDetails(undefined, outcome.obstacle));
  }
  const view = await attachDataChecks(deps, outcome.view, context);
  // A waiver may have completed a field's outputs in this call.
  return { ...withAdvice(view, await ensureAdvice(deps, taskId, context)), ...extras };
}
