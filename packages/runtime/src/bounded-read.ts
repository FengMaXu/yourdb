import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** The maximum UTF-8 payload returned by any bounded text read. */
export const MAX_TEXT_BYTES = 50 * 1024;
export interface LineRange {
  startLine?: number;
  endLine?: number;
}

export interface BoundedReadResult {
  content: string;
  truncated: boolean;
}

function validateLineRange({ startLine, endLine }: LineRange): void {
  for (const [name, value] of [["startLine", startLine], ["endLine", endLine]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`INVALID_LINE_RANGE:${name}`);
    }
  }
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error("INVALID_LINE_RANGE:START_AFTER_END");
  }
}

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a code point. */
export function truncateUtf8(content: string, maxBytes: number): BoundedReadResult {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= maxBytes) return { content, truncated: false };

  // The next excluded byte being a continuation byte means the final included
  // code point is incomplete.
  let end = maxBytes;
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { content: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export function boundTextByLines(content: string, range: LineRange = {}): BoundedReadResult {
  validateLineRange(range);
  // Preserve exact text and line endings when no line range is requested.
  if (range.startLine === undefined && range.endLine === undefined) return truncateUtf8(content, MAX_TEXT_BYTES);
  const lines = content.split(/\r?\n/);
  const start = range.startLine ?? 1;
  const end = range.endLine ?? lines.length;
  return truncateUtf8(lines.slice(start - 1, end).join("\n"), MAX_TEXT_BYTES);
}

/** Read a file beneath root while checking both lexical and symlink escapes. */
export async function readBoundedFile(root: string, relativePath: string, range: LineRange = {}): Promise<BoundedReadResult> {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("PATH_ESCAPE");
  const [realRoot, realTarget] = await Promise.all([realpath(resolvedRoot), realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error("SYMLINK_ESCAPE");
  return boundTextByLines(await readFile(realTarget, "utf8"), range);
}
