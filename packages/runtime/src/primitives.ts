export function now(): string { return new Date().toISOString(); }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** The trimmed string, or undefined when the value is not a non-blank string. */
export function trimmedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** JSON text in which a bigint survives as `{ __type: "bigint", value }`. */
export function bigintSafeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? { __type: "bigint", value: item.toString() } : item);
}

/** Whitespace collapsed to single spaces; cut with an ellipsis past `max` characters. */
export function oneLine(value: string, max = Infinity): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
