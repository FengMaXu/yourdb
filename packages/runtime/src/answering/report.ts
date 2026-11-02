import type { AnswerRevisionRecord, FieldProbeRecord, FieldRecord, ParentBinding, QueryTaskRecord, SpecFields } from "./model.js";
import { isSharedPath, type SpecPath } from "./fields.js";
import { AnsweringError } from "./errors.js";
import { openPaths, undeclaredPaths } from "./qualification.js";
import { equivalentPaths } from "./probes.js";
import type { AnsweringTransaction } from "./answering-store.js";
import type { InheritedFields } from "./field-transition.js";

/**
 * Report Task (ADR-0009): a parent task owns the population and the named
 * measure definitions every chart query of a report shares; each chart query
 * copies them from one bound parent Revision and declares only what differs.
 */
export function inheritedFields(parent: Pick<AnswerRevisionRecord, "fields">, binding: ParentBinding): InheritedFields {
  const fields: Partial<Record<SpecPath, FieldRecord>> = {};
  for (const [path, field] of Object.entries(parent.fields) as [SpecPath, FieldRecord][]) {
    if (isSharedPath(path)) fields[path] = field;
  }
  return { binding, fields };
}

/** Shared fields the Report Task has not handled: they block every chart query's result (ADR-0009 decision 6). */
export function reportUnresolved(fields: SpecFields, probes: readonly FieldProbeRecord[] = []): readonly string[] {
  const open = openPaths(fields, equivalentPaths(fields, probes));
  // A measure definition left open blocks only the chart queries that reference it.
  return [...undeclaredPaths(fields, true), ...open.filter((path) => path.startsWith("population."))];
}

/**
 * A Report Task never delivers; a chart query delivers only while its bound
 * parent Revision is current and handled. Exploration is never gated here.
 */
export function assertDeliverable(tx: Pick<AnsweringTransaction, "getTask" | "getRevision">, task: QueryTaskRecord): void {
  if (task.role === "report") throw new AnsweringError("REPORT_TASK_NOT_PUBLISHABLE", "A Report Task holds shared fields only; run result queries and publish in its chart queries");
  if (!task.parent) return;
  const parent = tx.getTask(task.parent.taskId);
  if (!parent) throw new AnsweringError("TASK_NOT_FOUND", `Report Task ${task.parent.taskId} was not found`);
  if (parent.currentRevisionId !== task.parent.revisionId) {
    throw new AnsweringError("PARENT_REVISION_STALE", `The Report Task changed since this chart query copied its shared fields; rebind it first with set_answer_spec({"taskId": "${task.taskId}", "rebind": true, "fields": {}}) and query the Revision that returns`, { currentRevisionId: parent.currentRevisionId });
  }
  const revision = tx.getRevision(parent.currentRevisionId);
  if (!revision) throw new AnsweringError("REVISION_NOT_FOUND", `Report Task Revision ${parent.currentRevisionId} was not found`);
  const unresolved = reportUnresolved(revision.fields, parent.fieldProbes ?? []);
  if (unresolved.length > 0) {
    throw new AnsweringError("PARENT_UNRESOLVED", `The Report Task still has unhandled shared fields: ${unresolved.join(", ")}; handle them on the Report Task first`, { unresolved });
  }
}
