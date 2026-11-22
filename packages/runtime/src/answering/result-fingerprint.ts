import { createHash } from "node:crypto";

/**
 * Output identity used to compare Choice probes with each other and with the
 * final result (ADR-0005). It follows how an answer is judged: column names,
 * column order and row order do not matter; numbers compare at two decimals;
 * strings compare after trimming.
 */
export function resultFingerprint(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  // A loop, not Math.max(...spread): 100,000 rows overflow the argument stack.
  let width = columns.length;
  for (const row of rows) if (row.length > width) width = row.length;
  const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => normalizeValue(row[index])));
  // Canonical column order: by each column's sorted value multiset, then original position.
  const signatures = Array.from({ length: width }, (_, index) => JSON.stringify(normalized.map((row) => row[index]).sort()));
  const order = Array.from({ length: width }, (_, index) => index)
    .sort((left, right) => signatures[left]! < signatures[right]! ? -1 : signatures[left]! > signatures[right]! ? 1 : left - right);
  const canonicalRows = normalized.map((row) => JSON.stringify(order.map((index) => row[index]))).sort();
  return createHash("sha256").update(JSON.stringify({ width, rows: canonicalRows })).digest("hex");
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "bigint") return `n:${value.toString()}.00`;
  if (typeof value === "number") return Number.isFinite(value) ? `n:${roundTwo(value)}` : `n:${String(value)}`;
  if (typeof value === "boolean") return `n:${value ? "1.00" : "0.00"}`;
  if (typeof value === "string") {
    const text = value.trim();
    // Numeric text (e.g. a CAST in one alternative) compares with numeric values.
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return `n:${roundTwo(Number(text))}`;
    return `s:${text}`;
  }
  return `j:${JSON.stringify(value)}`;
}

function roundTwo(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(2);
}
