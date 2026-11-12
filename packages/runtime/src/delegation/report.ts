import type { ChildReport } from "./index.js";
import { truncateUtf8 } from "../bounded-read.js";

/** Upper bound for one child report entering the parent context (~10K tokens of output). */
export const MAX_CHILD_REPORT_BYTES = 32 * 1024;

function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }

function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/** Drop a conversational preamble ("Let me write the report.") before the first Markdown heading. */
function fromFirstHeading(text: string): string {
  if (/^#{1,6}\s/.test(text)) return text;
  const heading = /\n#{1,6}\s/.exec(text);
  return heading ? text.slice(heading.index + 1) : text;
}

/** A child reports a Markdown document. Empty output is invalid; oversized output is truncated, not rejected. */
export function parseChildReport(text: string): ChildReport {
  const markdown = fromFirstHeading(stripOuterFence(text));
  if (!markdown) throw new Error("SUBAGENT_REPORT_EMPTY");
  if (bytes(markdown) <= MAX_CHILD_REPORT_BYTES) return { markdown, truncated: false };
  return { markdown: `${truncateUtf8(markdown, MAX_CHILD_REPORT_BYTES).content}\n\n[报告超出长度上限，已截断]`, truncated: true };
}
