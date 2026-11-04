import type { PublicationDelivered } from "@data-agent/contracts";

/** WeChat shows text as is, so results and answers are written as plain text. */

/** Rows of a result shown in the chat; the rest is on the computer. */
export const PREVIEW_ROWS = 10;
/** WeChat takes longer texts, but pieces this size stay readable and under its limit. */
export const TEXT_LIMIT = 2_000;

/** RFC 4180 rows: quoted fields, doubled quotes, CRLF or LF, an optional BOM. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = input.startsWith("﻿") ? input.slice(1) : input;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === "\"" && source[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

/** Rows of a Markdown table, or undefined when the text is not one. */
function markdownTable(text: string): string[][] | undefined {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim());
  if (lines.length < 2 || !lines.every((line) => line.startsWith("|"))) return undefined;
  return lines
    .filter((line) => !/^\|?[\s:|-]+\|?$/.test(line))
    .map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
}

/** A table as lines a phone can read: the header once, then one line per row. */
export function tableText(rows: readonly (readonly string[])[], limit = PREVIEW_ROWS): string {
  const [header, ...body] = rows;
  if (!header) return "";
  const lines = [header.join(" | "), ...body.slice(0, limit).map((cells) => cells.join(" | "))];
  if (body.length > limit) lines.push(`……共 ${body.length} 行，这里显示前 ${limit} 行。`);
  return lines.join("\n");
}

/** Inline results come as CSV or as a Markdown table. */
export function resultRows(content: string): string[][] {
  return markdownTable(content) ?? parseCsv(content);
}

/**
 * Markdown the model writes, made plain: emphasis and code marks go, links
 * keep their text (and their address when a phone can open it), and a
 * workspace file link becomes its name, since only the Web app opens it.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]*)\)/g, (_link, image: string, label: string, url: string) => image ? "" : /^https?:\/\//i.test(url) ? `${label}（${url}）` : label || url)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\|?[\s:|-]+\|?$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function publicationText(publication: PublicationDelivered, csv: string | undefined): string {
  const parts = ["【查询结果】"];
  const rows = csv ? resultRows(csv) : undefined;
  if (rows && rows.length > 0) parts.push(tableText(rows));
  if (!rows || rows.length - 1 > PREVIEW_ROWS) parts.push("完整结果请在电脑上的 yourdb 中查看或下载。");
  if (publication.disclosure) parts.push(`口径说明：${publication.disclosure}`);
  parts.push(`发布记录：${publication.receiptId}`);
  return parts.join("\n\n");
}

export function questionText(question: string, options: readonly string[]): string {
  if (options.length === 0) return `${question}\n\n直接回复你的答案即可。`;
  const choices = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  return `${question}\n\n${choices}\n\n回复序号，或直接输入你的答案。`;
}

/** A reply to an open question: a number picks that option, anything else is the answer itself. */
export function answerText(reply: string, options: readonly string[]): string {
  const index = /^\d{1,2}$/.test(reply) ? Number(reply) - 1 : -1;
  return options[index] ?? reply;
}

export function accessRequestText(requesterId: string, text: string): string {
  return `有人申请使用数据助手。\n\n对方：${requesterId}\n消息：“${text}”\n\n允许后，对方能查询本应用可以访问的全部数据。请在电脑上的 yourdb「设置 → 消息渠道」中允许或拒绝。`;
}

export function dashboardText(dashboardPath: string): string {
  const name = dashboardPath.slice(dashboardPath.lastIndexOf("/") + 1);
  return `看板已生成：${name}\n\n微信里暂时不能发送看板文件，请在电脑上的 yourdb 中打开。`;
}

/** Long text in pieces, cut at line ends where possible. */
export function pieces(text: string, limit = TEXT_LIMIT): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const at = cut > limit / 2 ? cut : limit;
    result.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.trim()) result.push(rest);
  return result;
}
