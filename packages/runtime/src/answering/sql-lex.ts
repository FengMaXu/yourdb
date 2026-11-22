/**
 * Shared SQL lexical masking. Structural checks read SQL text with string
 * literals, quoted identifiers and comments blanked so a keyword inside
 * `'delete'`, `"update"` or `-- drop` is never read as SQL. Masking keeps the
 * text length, so offsets in the masked text map to the original SQL.
 */
export interface SqlMaskOptions {
  /** Blank single-quoted string literals (default true). */
  readonly strings?: boolean;
  /** Blank double-quoted, backtick and bracket identifiers (default true). */
  readonly identifiers?: boolean;
  /** Treat a backslash inside a string literal as an escape, as MySQL does (default false). */
  readonly backslashEscapes?: boolean;
}

function blank(chars: string[], from: number, to: number): void {
  for (let index = from; index < to && index < chars.length; index++) {
    if (chars[index] !== "\n") chars[index] = " ";
  }
}

/** Index just past a quoted run starting at `start` whose closing quote is `close`; a doubled quote is an escape. */
function quotedEnd(sql: string, start: number, close: string, backslashEscapes: boolean): number {
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index]!;
    if (backslashEscapes && char === "\\") {
      index += 2;
      continue;
    }
    if (char === close) {
      if (sql[index + 1] === close) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

export function maskSql(sql: string, options: SqlMaskOptions = {}): string {
  const strings = options.strings !== false;
  const identifiers = options.identifiers !== false;
  const backslashEscapes = options.backslashEscapes === true;
  // Code units, so offsets in the masked text match `sql`.
  const chars = sql.split("");
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      const end = quotedEnd(sql, index, "'", backslashEscapes);
      if (strings) blank(chars, index, end);
      index = end;
      continue;
    }
    if (char === "\"" || char === "`") {
      const end = quotedEnd(sql, index, char, backslashEscapes && char === "\"");
      if (identifiers) blank(chars, index, end);
      index = end;
      continue;
    }
    if (char === "[" && identifiers) {
      // T-SQL bracket identifier; only when it closes on the same line, so array subscripts stay readable.
      const close = sql.indexOf("]", index + 1);
      const newline = sql.indexOf("\n", index + 1);
      if (close > index && (newline < 0 || close < newline) && /^\[[A-Za-z_][\w $-]*\]$/.test(sql.slice(index, close + 1))) {
        blank(chars, index, close + 1);
        index = close + 1;
        continue;
      }
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index);
      const end = newline < 0 ? sql.length : newline;
      blank(chars, index, end);
      index = end;
      continue;
    }
    if (char === "#" && backslashEscapes) {
      // MySQL line comment.
      const newline = sql.indexOf("\n", index);
      const end = newline < 0 ? sql.length : newline;
      blank(chars, index, end);
      index = end;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const close = sql.indexOf("*/", index + 2);
      const end = close < 0 ? sql.length : close + 2;
      blank(chars, index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return chars.join("");
}

const WRITE_KEYWORDS = /\b(?:insert|update|delete|drop|alter|create|truncate|merge|grant|revoke|call|vacuum)\b|\breplace\b(?!\s*\()/i;

/** One statement, after masking, with trailing semicolons dropped; undefined when more than one statement remains. */
function singleStatement(masked: string): string | undefined {
  const statement = masked.trim().replace(/[;\s]+$/, "").trim();
  if (!statement || statement.includes(";")) return undefined;
  return statement.replace(/\s+/g, " ");
}

/**
 * Read-only preflight on lexically masked SQL. Both string-escape
 * conventions must agree, so a backslash cannot hide a second statement
 * from either reading.
 */
export function readOnlyStatement(sql: string, extraForbidden?: RegExp): string | undefined {
  let first: string | undefined;
  for (const backslashEscapes of [false, true]) {
    const statement = singleStatement(maskSql(sql, { backslashEscapes }));
    if (!statement) return undefined;
    if (!/^(?:select|with|explain|show|describe|pragma)\b/i.test(statement)) return undefined;
    if (WRITE_KEYWORDS.test(statement)) return undefined;
    if (extraForbidden?.test(statement)) return undefined;
    first ??= statement;
  }
  return first;
}
