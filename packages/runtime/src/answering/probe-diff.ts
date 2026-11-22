/**
 * Differential witness rows (plan T4.1). When two alternatives of an open
 * field produce different outputs, a few concrete rows that differ say more
 * to the decider than row counts: a row only one alternative returns, or the
 * same key with a different value. Probes keep a small normalized sample of
 * their output; witnesses are computed from two samples, deterministically
 * (row order and column order do not matter) and within fixed size bounds.
 */

/** Rows kept per probe sample; a larger output is sampled and marked partial. */
export const PROBE_SAMPLE_MAX_ROWS = 200;
/** Serialized bytes kept per probe sample. */
export const PROBE_SAMPLE_MAX_BYTES = 16_384;
/** Witnesses reported per field. */
export const WITNESS_MAX = 3;
/** Characters kept per witness cell. */
export const WITNESS_CELL_CHARS = 80;

export interface ProbeSample {
  readonly columns: readonly string[];
  /** Normalized cells, rows in canonical order. */
  readonly rows: readonly (readonly string[])[];
  /** Rows of the whole output. */
  readonly totalRows: number;
  /** False when the sample holds fewer rows than the output. */
  readonly complete: boolean;
}

export interface WitnessRow {
  /** only_in: a row one alternative returns and the other does not; changed: same key, different values; shape: columns differ. */
  readonly kind: "only_in" | "changed" | "shape";
  readonly alternativeId: string;
  readonly otherAlternativeId: string;
  readonly columns: readonly string[];
  readonly row: readonly string[];
  /** changed / shape: the other alternative's row (or columns, for shape). */
  readonly otherRow?: readonly string[];
  /** True when a sample was partial, so "only in" may hold a row the other output has beyond its sample. */
  readonly partial?: boolean;
}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function roundTwo(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
}

/** One cell as the comparison sees it: numbers at two decimals, strings trimmed, NULL spelled out. */
export function normalizeCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "bigint") return `${value.toString()}.00`;
  if (typeof value === "number") return Number.isFinite(value) ? roundTwo(value) : String(value);
  if (typeof value === "boolean") return value ? "1.00" : "0.00";
  if (typeof value === "string") {
    const text = value.trim();
    return NUMERIC.test(text) ? roundTwo(Number(text)) : text;
  }
  return JSON.stringify(value);
}

function truncate(cell: string): string {
  return cell.length > WITNESS_CELL_CHARS ? `${cell.slice(0, WITNESS_CELL_CHARS - 1)}…` : cell;
}

/** A bounded, canonical sample of one probe's output. */
export function sampleProbeOutput(columns: readonly string[], rows: readonly (readonly unknown[])[]): ProbeSample {
  const normalized = rows.map((row) => columns.map((_, index) => truncate(normalizeCell(row[index]))));
  normalized.sort((left, right) => compareRows(left, right));
  const kept: string[][] = [];
  let bytes = JSON.stringify(columns).length;
  for (const row of normalized) {
    if (kept.length >= PROBE_SAMPLE_MAX_ROWS) break;
    const size = JSON.stringify(row).length + 1;
    if (bytes + size > PROBE_SAMPLE_MAX_BYTES) break;
    kept.push(row);
    bytes += size;
  }
  return { columns: [...columns], rows: kept, totalRows: rows.length, complete: kept.length === rows.length };
}

function compareRows(left: readonly string[], right: readonly string[]): number {
  const a = JSON.stringify(left);
  const b = JSON.stringify(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** B's rows re-ordered to A's columns: by name when both name the same columns, else by position when widths match. */
function align(a: ProbeSample, b: ProbeSample): { readonly rows: readonly (readonly string[])[] } | undefined {
  if (a.columns.length !== b.columns.length) return undefined;
  const lower = (name: string) => name.trim().toLowerCase();
  const names = a.columns.map(lower);
  const other = b.columns.map(lower);
  const sameNames = new Set(names).size === names.length && names.every((name) => other.includes(name)) && new Set(other).size === other.length;
  if (!sameNames) return { rows: b.rows };
  const order = names.map((name) => other.indexOf(name));
  return { rows: b.rows.map((row) => order.map((index) => row[index]!)).sort(compareRows) };
}

/** Columns whose cells are text in every sampled row of both samples: the candidates for a row key. */
function keyColumns(a: readonly (readonly string[])[], b: readonly (readonly string[])[], width: number): readonly number[] {
  const keys: number[] = [];
  for (let index = 0; index < width; index++) {
    const text = (row: readonly string[]) => row[index] !== "NULL" && !NUMERIC.test(row[index] ?? "");
    if ([...a, ...b].every(text)) keys.push(index);
  }
  return keys.length > 0 && keys.length < width ? keys : [];
}

function multiset(rows: readonly (readonly string[])[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Rows of `rows` not matched by `against`, keeping multiplicity. */
function unmatched(rows: readonly (readonly string[])[], against: Map<string, number>): (readonly string[])[] {
  const remaining = new Map(against);
  const out: (readonly string[])[] = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else out.push(row);
  }
  return out;
}

/**
 * Up to WITNESS_MAX rows that tell two outputs apart, most informative first:
 * a key both return with different values, then a row only A returns, then
 * a row only B returns. Equal outputs have no witnesses.
 */
export function diffProbeSamples(a: { readonly alternativeId: string; readonly sample: ProbeSample }, b: { readonly alternativeId: string; readonly sample: ProbeSample }, max = WITNESS_MAX): readonly WitnessRow[] {
  const partial = !a.sample.complete || !b.sample.complete;
  const aligned = align(a.sample, b.sample);
  if (!aligned) {
    return [{ kind: "shape", alternativeId: a.alternativeId, otherAlternativeId: b.alternativeId, columns: a.sample.columns, row: a.sample.columns, otherRow: b.sample.columns }];
  }
  const onlyA = unmatched(a.sample.rows, multiset(aligned.rows));
  const onlyB = unmatched(aligned.rows, multiset(a.sample.rows));
  const keys = keyColumns(a.sample.rows, aligned.rows, a.sample.columns.length);
  const changed: WitnessRow[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  if (keys.length > 0) {
    const keyOf = (row: readonly string[]) => JSON.stringify(keys.map((index) => row[index]));
    const byKey = new Map<string, number>();
    onlyB.forEach((row, index) => { if (!byKey.has(keyOf(row))) byKey.set(keyOf(row), index); });
    onlyA.forEach((row, index) => {
      const match = byKey.get(keyOf(row));
      if (match === undefined || usedB.has(match)) return;
      usedA.add(index);
      usedB.add(match);
      changed.push({ kind: "changed", alternativeId: a.alternativeId, otherAlternativeId: b.alternativeId, columns: a.sample.columns, row, otherRow: onlyB[match]! });
    });
  }
  const only = (rows: readonly (readonly string[])[], used: ReadonlySet<number>, from: string, other: string): WitnessRow[] => rows
    .filter((_, index) => !used.has(index))
    .map((row) => ({ kind: "only_in" as const, alternativeId: from, otherAlternativeId: other, columns: a.sample.columns, row, ...(partial ? { partial: true } : {}) }));
  const restA = only(onlyA, usedA, a.alternativeId, b.alternativeId);
  const restB = only(onlyB, usedB, b.alternativeId, a.alternativeId);
  // Interleave so both directions are represented before the cap.
  const ordered: WitnessRow[] = [...changed];
  for (let index = 0; index < Math.max(restA.length, restB.length); index++) {
    if (restA[index]) ordered.push(restA[index]!);
    if (restB[index]) ordered.push(restB[index]!);
  }
  return ordered.slice(0, max);
}

/** One line per witness, labelled with the caller's alternative names. */
export function witnessText(witness: WitnessRow, label: (alternativeId: string) => string): string {
  const cells = (row: readonly string[]) => `(${witness.columns.map((column, index) => `${column}=${row[index]}`).join(", ")})`;
  if (witness.kind === "shape") return `${label(witness.alternativeId)} returns columns [${witness.row.join(", ")}], ${label(witness.otherAlternativeId)} returns [${(witness.otherRow ?? []).join(", ")}]`;
  if (witness.kind === "changed") return `same key, different values: ${label(witness.alternativeId)} ${cells(witness.row)} vs ${label(witness.otherAlternativeId)} ${cells(witness.otherRow ?? [])}`;
  return `only ${label(witness.alternativeId)} returns ${cells(witness.row)}${witness.partial ? " (sampled output; the other output may hold it beyond its sample)" : ""}`;
}
