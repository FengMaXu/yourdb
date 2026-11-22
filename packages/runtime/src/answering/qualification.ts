import { possibleValues } from "./support.js";
import { randomUUID } from "node:crypto";
import {
  type AnswerRevisionRecord,
  type Evidence,
  type FieldRecord,
  type ReadyRevision,
  type SpecFields,
  type UnverifiedField,
  isTextEvidenceKind,
} from "./model.js";
import {
  REPORT_REQUIRED,
  isSharedPath,
  requiredPaths,
  type FieldPath,
  type SpecPath,
} from "./fields.js";
import { calendarRequiredPaths } from "./calendar-coverage.js";

/**
 * Text evidence carries authority only through a quote that Runtime found in a
 * trusted source. Auto-registered text evidence without that record remains
 * readable context but never settles a field.
 */
export function isAdmissibleProof(evidence: Evidence): boolean {
  if (!isTextEvidenceKind(evidence.kind)) return true;
  return Boolean(evidence.verification && evidence.quote?.trim());
}

/** Fields the necessity rules require for these fields (ADR-0007). */
export function requiredFor(fields: SpecFields): readonly FieldPath[] {
  return requiredPaths({
    formulas: possibleValues(fields, "measure.formula"),
    sources: possibleValues(fields, "population.source"),
    selection: Boolean(fields.selection) && fields.selection!.state !== "not_applicable",
  });
}

/**
 * Required fields without a state. A Report Task answers only for its shared
 * population. `dataRequired` adds paths the data made necessary (calendar coverage).
 */
export function undeclaredPaths(fields: SpecFields, report = false, dataRequired: readonly FieldPath[] = []): readonly SpecPath[] {
  const required = report ? [...REPORT_REQUIRED, ...requiredFor(fields).filter(isSharedPath)] : [...requiredFor(fields), ...dataRequired];
  return [...new Set(required)].filter((path) => !fields[path]);
}

/**
 * Open fields not shown equivalent by their probes. A chart query's inherited
 * open field is the Report Task's to settle, and blocks through it (ADR-0009).
 */
export function openPaths(fields: SpecFields, equivalent: ReadonlySet<SpecPath> = new Set()): readonly SpecPath[] {
  return (Object.entries(fields) as [SpecPath, FieldRecord][])
    .filter(([path, field]) => field.state === "open" && !field.inherited && !equivalent.has(path))
    .map(([path]) => path);
}

/** Fields disclosed at publication: values and decisions no qualifying evidence settles (ADR-0006). */
export function unverifiedFields(fields: SpecFields): readonly UnverifiedField[] {
  return (Object.entries(fields) as [SpecPath, FieldRecord][]).flatMap(([path, field]): UnverifiedField[] => {
    if (field.state === "specified" && field.basis.kind === "assumed") return [{ path, kind: "assumed" }];
    if (field.state === "decided" && field.basis.kind === "assumed") return [{ path, kind: "decided" }];
    return [];
  });
}

/** Seal only after every required field has a state and no field is left open; equivalent fields count as handled. */
export function sealForResult(revision: AnswerRevisionRecord, equivalent: ReadonlySet<SpecPath> = new Set()):
  | { readonly ok: true; readonly revision: ReadyRevision }
  | { readonly ok: false; readonly undeclared: readonly SpecPath[]; readonly open: readonly SpecPath[] } {
  const undeclared = undeclaredPaths(revision.fields, false, calendarRequiredPaths(revision.calendarCoverage));
  const open = openPaths(revision.fields, equivalent);
  if (undeclared.length > 0 || open.length > 0) return { ok: false, undeclared, open };
  return {
    ok: true,
    revision: {
      state: "ready",
      revisionId: revision.revisionId,
      ready: `ready_${randomUUID()}` as ReadyRevision["ready"],
    },
  };
}
