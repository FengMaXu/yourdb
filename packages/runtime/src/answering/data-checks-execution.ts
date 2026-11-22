import { clone, type AnswerRevisionView, type BusinessContext, type RevisionId, type TaskId } from "./model.js";
import { assertTaskAccess } from "./answering-store.js";
import type { AnsweringDeps } from "./deps.js";
import {
  ENTITY_IDENTITY_MAX_ROWS,
  
  evaluateEntityIdentity,
  identityQueries,
  identityTargets,
  type EntityIdentityReport,
  type IdentityTarget,
  type TableIdentityObservation,
} from "./entity-identity.js";
import {
  CALENDAR_COVERAGE_MAX_PERIODS,
  CALENDAR_COVERAGE_RULE_VERSION,
  calendarQuery,
  calendarRequiredPaths,
  calendarTarget,
  evaluateCalendarCoverage,
  type CalendarCoverageReport,
  type CalendarTarget,
} from "./calendar-coverage.js";
import { isSettled } from "./support.js";

function sameTarget(observation: TableIdentityObservation, target: IdentityTarget): boolean {
  return observation.table === target.table && JSON.stringify(observation.keyColumns ?? []) === JSON.stringify(target.keyColumns ?? []);
}

async function observe(deps: AnsweringDeps, target: IdentityTarget, context: BusinessContext): Promise<TableIdentityObservation> {
  const queries = identityQueries(target, deps.sqlExecutor.dialect);
  const maxRows = deps.entityIdentity?.maxRows ?? ENTITY_IDENTITY_MAX_ROWS;
  const base = { table: target.table, ...(target.keyColumns ? { keyColumns: target.keyColumns } : {}) };
  // Read through the session's Schema Profile: a count another task already read is not read again.
  const rows = await deps.schemaProfile.count(queries.rows, context, "entity-identity");
  if (rows === undefined) return { ...base, limitation: "the table could not be counted" };
  if (rows > maxRows) return { ...base, rows, limitation: `more than ${maxRows} rows; distinct counts skipped` };
  let distinctRows: number | undefined;
  let distinctKeys: number | undefined;
  const limitations: string[] = [];
  distinctRows = await deps.schemaProfile.count(queries.distinctRows, context, "entity-identity");
  if (distinctRows === undefined) limitations.push("distinct rows could not be counted");
  // A key the table does not have is normal for a multi-table source; it is left out.
  if (queries.distinctKeys) distinctKeys = await deps.schemaProfile.count(queries.distinctKeys, context, "entity-identity");
  return {
    ...base,
    rows,
    ...(distinctRows !== undefined ? { distinctRows } : {}),
    ...(distinctKeys !== undefined ? { distinctKeys } : {}),
    ...(limitations.length > 0 ? { limitation: limitations.join("; ") } : {}),
  };
}

async function readCalendar(deps: AnsweringDeps, target: CalendarTarget, context: BusinessContext): Promise<CalendarCoverageReport> {
  const sql = calendarQuery(target, deps.sqlExecutor.dialect);
  if (!sql) return { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", target, limitations: [`dialect ${deps.sqlExecutor.dialect} is not read`] };
  // The profile records how the column is stored; a column that is not ISO text is not read by prefix.
  const profile = await deps.schemaProfile.profile(target.table, context);
  const stored = profile.timeColumns.find((item) => item.column.toLowerCase() === target.column.toLowerCase());
  if (stored && (stored.format === "integer" || stored.format === "other")) {
    return { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", target, limitations: [`${target.table}.${target.column} is stored as ${stored.format === "integer" ? "integers" : "non-ISO text"} (e.g. ${stored.min ?? "?"}), not ISO dates`] };
  }
  const limit = CALENDAR_COVERAGE_MAX_PERIODS * 31;
  const rows = await deps.schemaProfile.read(sql, limit + 1, context, "calendar-coverage");
  if (!rows) return { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", target, limitations: [`${target.table}.${target.column} could not be read`] };
  if (rows.length > limit) return { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", target, limitations: ["the period list was truncated"] };
  return evaluateCalendarCoverage(target, rows.map((row) => row[0]));
}

function sameCalendar(left: CalendarTarget | undefined, right: CalendarTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** A field the checks can read: it has a value that is not one of several open alternatives. */
interface DataCheckReports {
  readonly entityIdentity?: EntityIdentityReport;
  readonly calendarCoverage?: CalendarCoverageReport;
}

/**
 * Entity identity counts and calendar coverage of one Revision, read once and
 * recorded on it. Readings for the same target carry over from the parent
 * Revision, so a Revision that changes neither target runs no query. A failed
 * read is a limitation, never a failure. Returns what the Revision holds
 * afterwards, or undefined when neither check applies.
 */
export async function recordDataChecks(deps: AnsweringDeps, taskId: TaskId, revisionId: RevisionId, context: BusinessContext): Promise<DataCheckReports | undefined> {
  const snapshot = await deps.store.transact((tx) => {
    assertTaskAccess(tx.getTask(taskId), context);
    const revision = tx.getRevision(revisionId);
    const parent = revision?.parentRevisionId ? tx.getRevision(revision.parentRevisionId) : undefined;
    return { revision, parent };
  }, context);
  const revision = snapshot.revision;
  if (!revision) return undefined;
  if (revision.entityIdentity || revision.calendarCoverage) return revision;
  const identityApplies = isSettled(revision.fields["population.entity"]) && isSettled(revision.fields["population.source"]);
  const calendarApplies = isSettled(revision.fields["population.time"]) && (isSettled(revision.fields["grouping"]) || isSettled(revision.fields["measure.formula"]));
  if (!identityApplies && !calendarApplies) return undefined;

  let entityIdentity: EntityIdentityReport | undefined;
  if (identityApplies) {
    const { targets, limitations } = identityTargets(revision.fields);
    const carried = snapshot.parent?.entityIdentity?.observations ?? [];
    const observations: TableIdentityObservation[] = [];
    for (const target of targets) observations.push(carried.find((item) => sameTarget(item, target)) ?? await observe(deps, target, context));
    entityIdentity = evaluateEntityIdentity(revision.fields, observations, limitations);
  }
  let calendarCoverage: CalendarCoverageReport | undefined;
  if (calendarApplies) {
    const { target, limitation } = calendarTarget(revision.fields);
    const carried = snapshot.parent?.calendarCoverage;
    calendarCoverage = target
      ? carried && sameCalendar(carried.target, target) ? carried : await readCalendar(deps, target, context)
      : limitation ? { ruleVersion: CALENDAR_COVERAGE_RULE_VERSION, status: "unknown", limitations: [limitation] } : undefined;
  }
  if (!entityIdentity && !calendarCoverage) return undefined;
  try {
    // A concurrent reader of the same Revision may have recorded first; its reports stand.
    return await deps.store.transact((tx) => {
      const current = tx.getRevision(revisionId);
      if (!current) return undefined;
      if (current.entityIdentity || current.calendarCoverage) return current;
      tx.putRevision({ ...current, ...(entityIdentity ? { entityIdentity } : {}), ...(calendarCoverage ? { calendarCoverage } : {}) });
      return { ...(entityIdentity ? { entityIdentity } : {}), ...(calendarCoverage ? { calendarCoverage } : {}) };
    }, context);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return undefined;
  }
}

/**
 * Post-commit data checks for the Revision a set call returns: the reports
 * and any field calendar coverage made required are added to the view.
 */
export async function attachDataChecks(
  deps: AnsweringDeps,
  view: AnswerRevisionView,
  context: BusinessContext,
): Promise<AnswerRevisionView> {
  const reports = await recordDataChecks(deps, view.taskId as TaskId, view.revisionId as RevisionId, context);
  if (!reports) return view;
  const declared = new Set(view.fields.map((field) => field.path as string));
  const missingRequired = calendarRequiredPaths(reports.calendarCoverage).filter((path) => !declared.has(path));
  return {
    ...view,
    ...(reports.entityIdentity ? { entityIdentity: clone(reports.entityIdentity) } : {}),
    ...(reports.calendarCoverage ? { calendarCoverage: clone(reports.calendarCoverage) } : {}),
    ...(missingRequired.length > 0 ? { undeclared: [...new Set([...view.undeclared, ...missingRequired])] } : {}),
  };
}
