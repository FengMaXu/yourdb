import { parseCsvRows } from "./lib.mjs";

const DEFAULT_MAX_LENGTH = 320;
const DEFAULT_MAX_CLARIFICATIONS = 3;

const UPPERCASE_SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "HAVING",
  "JOIN",
  "UNION",
  "WITH",
  "LIMIT",
  "DISTINCT",
];

const MULTIWORD_SQL_PATTERNS = [
  { label: "GROUP BY", pattern: /\bGROUP\s+BY\b/i },
  { label: "ORDER BY", pattern: /\bORDER\s+BY\b/i },
  { label: "CASE WHEN", pattern: /\bCASE\s+WHEN\b/i },
  { label: "IS NOT NULL", pattern: /\bIS\s+NOT\s+NULL\b/i },
];

const SQL_FUNCTION_CALL_PATTERN = /\b(COUNT|SUM|AVG|MIN|MAX|COALESCE|STRFTIME|CAST)\s*\(/gi;

const LOWERCASE_SQL_IDIOMS = [
  { label: "SELECT...FROM", pattern: /\bselect\b[\s\S]*?\bfrom\b/i },
  { label: "SELECT DISTINCT", pattern: /\bselect\s+(?:distinct\b|\*)/i },
  { label: "JOIN", pattern: /\b(?:left|right|inner|outer|cross|full)\s+join\b/i },
  { label: "UNION", pattern: /\bunion\s+(?:all|distinct|select)\b/i },
  { label: "LIMIT", pattern: /\blimit\s+\d+\b/i },
  { label: "WITH", pattern: /\bwith\s+[a-z_][a-z0-9_]*\s+as\s*\(/i },
  { label: "WHERE/HAVING", pattern: /\b(?:where|having)\s+[a-z_][a-z0-9_.]*\s*(?:=|!=|<>|<|>|<=|>=|\bin\s*\(|\blike\b|\bis\s+(?:not\s+)?null\b)/i },
];

const LITERAL_SQL_TOKENS = ["--", "/*", "<>", "!="];
const BACKTICK_IDENTIFIER_PATTERN = /`[^`]+`/;
const QUALIFIED_REFERENCE_PATTERN = /\b(?!(?:e\.g|i\.e)\b)[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/g;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPhysicalSchemaIdentifier(identifier) {
  if (typeof identifier !== "string") return false;
  const trimmed = identifier.trim();
  if (!trimmed) return false;
  // Require underscore, digit, camelCase, or multi-segment PascalCase so plain
  // single lowercase/capitalized business words (e.g. "orders", "status") are skipped.
  return /[_0-9]|[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(trimmed);
}

/**
 * Validates that an oracle clarifier response is a concise plain business
 * sentence with zero SQL syntax, qualified table.column references, or physical
 * schema identifiers.
 */
export function validateClarifierResponse(text, { schemaIdentifiers = [], maxLength = DEFAULT_MAX_LENGTH } = {}) {
  const violations = [];
  const addViolation = (code) => {
    if (!violations.includes(code)) violations.push(code);
  };

  if (typeof text !== "string" || !text.trim()) {
    addViolation("empty_response");
    return { ok: false, violations };
  }

  const trimmed = text.trim();
  if (trimmed.length > maxLength) {
    addViolation("exceeds_max_length");
  }

  for (const keyword of UPPERCASE_SQL_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`);
    if (pattern.test(trimmed)) addViolation(`sql_keyword:${keyword}`);
  }

  for (const { label, pattern } of MULTIWORD_SQL_PATTERNS) {
    if (pattern.test(trimmed)) addViolation(`sql_keyword:${label}`);
  }

  for (const match of trimmed.matchAll(SQL_FUNCTION_CALL_PATTERN)) {
    addViolation(`sql_function:${match[1].toUpperCase()}(`);
  }

  for (const { label, pattern } of LOWERCASE_SQL_IDIOMS) {
    if (pattern.test(trimmed)) addViolation(`sql_keyword:${label}`);
  }

  for (const token of LITERAL_SQL_TOKENS) {
    if (trimmed.includes(token)) addViolation(`sql_token:${token}`);
  }

  if (BACKTICK_IDENTIFIER_PATTERN.test(trimmed)) {
    addViolation("backtick_identifier");
  }

  for (const match of trimmed.matchAll(QUALIFIED_REFERENCE_PATTERN)) {
    addViolation(`qualified_identifier:${match[0]}`);
  }

  for (const identifier of schemaIdentifiers) {
    if (!isPhysicalSchemaIdentifier(identifier)) continue;
    const trimmedId = identifier.trim();
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(trimmedId)}(?![A-Za-z0-9_])`, "i");
    if (pattern.test(trimmed)) {
      addViolation(`schema_identifier:${trimmedId}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

const DDL_CONSTRAINT_KEYWORDS = new Set([
  "PRIMARY",
  "FOREIGN",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
  "INDEX",
  "KEY",
  "REFERENCES",
]);

/**
 * Extracts table names and column names from Spider2 DDL.csv text for use in
 * oracle clarifier leakage checks.
 */
export function extractSchemaIdentifiersFromDdlCsv(ddlCsvText) {
  if (typeof ddlCsvText !== "string" || !ddlCsvText.trim()) return [];
  let rows;
  try {
    rows = parseCsvRows(ddlCsvText);
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const tableIdx = header.indexOf("table_name");
  const ddlIdx = header.indexOf("ddl");
  const identifiers = new Set();

  for (const row of rows.slice(1)) {
    const tableName = tableIdx >= 0 ? row[tableIdx]?.trim() : "";
    if (tableName) identifiers.add(tableName);
    const ddl = ddlIdx >= 0 ? row[ddlIdx] ?? "" : "";
    if (!ddl) continue;

    const openParen = ddl.indexOf("(");
    const closeParen = ddl.lastIndexOf(")");
    if (openParen < 0 || closeParen <= openParen) continue;
    const body = ddl
      .slice(openParen + 1, closeParen)
      .replace(/--[^\r\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^,\s*/, "");
      if (!line) continue;
      const match = /^(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s+/.exec(line);
      if (!match) continue;
      const col = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").trim();
      if (!col || DDL_CONSTRAINT_KEYWORDS.has(col.toUpperCase())) continue;
      identifiers.add(col);
    }
  }

  return [...identifiers];
}

function formatGoldContext(goldContext) {
  if (typeof goldContext === "string") return goldContext;
  if (goldContext == null) return "";
  return JSON.stringify(goldContext, null, 2);
}

function normalizeModelOutput(output) {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    if (typeof output.content === "string") return output.content;
    if (typeof output.text === "string") return output.text;
  }
  return "";
}

function formatProbeOutputLines(text, maxPerAlternativeChars) {
  const lines = String(text ?? "").split(/\r?\n/);
  const kept = [];
  let dataLines = 0;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[EXPLORATION_EVIDENCE]") || trimmed.startsWith("Cite this evidenceId")) continue;
    if (trimmed.startsWith("Alternatives of the same field with equal output ids")) continue;
    if (trimmed.startsWith("[PROBE]") || trimmed.startsWith("[WITNESS]")) {
      kept.push(trimmed);
      continue;
    }
    if (dataLines < 8) {
      kept.push(trimmed);
      dataLines += 1;
    }
  }
  const joined = kept.join("\n").trim();
  if (joined.length <= maxPerAlternativeChars) return joined;
  return `${joined.slice(0, Math.max(0, maxPerAlternativeChars - 3))}...`;
}

function extractCallText(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.text === "string") return result.text;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/**
 * Summarize latest successful candidate probe outputs alongside candidate
 * definitions from tool calls, for confidential evaluator-side Oracle Clarifier use.
 */
export function summarizeProbeOutcomesFromCalls(calls, { maxChars = 4000, maxPerAlternativeChars = 480 } = {}) {
  const candidateValues = new Map();
  const latestProbeByField = new Map();

  for (const call of calls ?? []) {
    if (call?.toolName === "set_answer_spec" && !call.isError) {
      const fields = call.result?.details?.fields;
      if (Array.isArray(fields)) {
        for (const field of fields) {
          const fieldPath = typeof field?.path === "string" ? field.path : undefined;
          if (!fieldPath || !Array.isArray(field.alternatives)) continue;
          for (const alt of field.alternatives) {
            if (!alt?.id) continue;
            const rawVal = typeof alt.value === "string" ? alt.value : JSON.stringify(alt.value);
            candidateValues.set(`${fieldPath}\u0000${alt.id}`, rawVal ?? "");
          }
        }
      }
      continue;
    }

    if (
      call?.toolName === "query_database"
      && !call.isError
      && call.args?.probe?.path
      && call.args?.probe?.alternativeId
    ) {
      const fieldPath = String(call.args.probe.path);
      const alternativeId = String(call.args.probe.alternativeId);
      const snippet = formatProbeOutputLines(extractCallText(call.result), maxPerAlternativeChars);
      if (!snippet) continue;
      let fieldProbes = latestProbeByField.get(fieldPath);
      if (!fieldProbes) {
        fieldProbes = new Map();
        latestProbeByField.set(fieldPath, fieldProbes);
      }
      fieldProbes.set(alternativeId, snippet);
    }
  }

  if (latestProbeByField.size === 0) return "";

  const sections = [];
  for (const [fieldPath, fieldProbes] of latestProbeByField.entries()) {
    const lines = [`Field: ${fieldPath}`];
    for (const [alternativeId, snippet] of fieldProbes.entries()) {
      const value = candidateValues.get(`${fieldPath}\u0000${alternativeId}`);
      const label = value ? `${value} (${alternativeId})` : alternativeId;
      const indented = snippet.split("\n").map((line) => `  ${line}`).join("\n");
      lines.push(`- Candidate ${label}:`, indented);
    }
    sections.push(lines.join("\n"));
  }

  const combined = sections.join("\n\n");
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildClarifierPrompts({ originalQuestion, goldContext, probeContext, question, options, previousDraft, previousViolations }) {
  const systemPrompt = [
    "You are a domain stakeholder answering a clarification question about a data analysis request.",
    "Use ONLY the Original Question, Reference Context, and any Observed Candidate Probe Outputs to answer the Clarification Question in ONE concise plain-language business sentence (<= 320 characters).",
    "PRIORITY RULE: Gold CSV Preview is the authoritative grading truth. If Gold SQL (when present) disagrees with Gold CSV Preview, follow Gold CSV Preview.",
    "When Observed Candidate Probe Outputs is provided, compare each candidate's probe output against Gold CSV Preview to identify which business option reproduces the Gold result.",
    "If options are given, clearly choose or state the matching business meaning.",
    "STRICT RULES:",
    "- Never mention table names, column names, SQL keywords (such as SELECT, FROM, WHERE, JOIN, GROUP BY, COUNT(, SUM(), etc.), SQL operators (--, /*, <>, !=), backticks, qualified table.column names, formulas, or exact reference output values that were not already written in the clarification question or options.",
    "- Use plain business terminology only.",
    "- Output ONLY that single plain business sentence with no markdown, labels, or explanation.",
  ].join("\n");

  const formattedOptions = Array.isArray(options) && options.length > 0
    ? options.map((opt, idx) => `${idx + 1}. ${opt}`).join("\n")
    : "(none provided)";

  const userParts = [
    `Original Question:\n${originalQuestion ?? ""}`,
    `Reference Context:\n${formatGoldContext(goldContext)}`,
    ...(probeContext ? [`Observed Candidate Probe Outputs (CONFIDENTIAL — evaluator reference only):\n${probeContext}`] : []),
    `Clarification Question:\n${question ?? ""}`,
    `Options:\n${formattedOptions}`,
  ];

  if (previousViolations?.length) {
    userParts.push(
      `Your previous draft was rejected due to policy violations (${previousViolations.join(", ")}).`,
      `Rejected Draft:\n${previousDraft ?? ""}`,
      "Rewrite it into ONE concise plain business sentence that obeys all rules above without mentioning any SQL syntax, operators, qualified references, physical schema identifiers, or unmentioned reference output values.",
    );
  }

  const userPrompt = userParts.join("\n\n");
  return {
    systemPrompt,
    userPrompt,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
}

/**
 * Creates a stateless-per-request controlled oracle clarifier backed by an
 * isolated model call and fail-closed leakage validator.
 */
export function createOracleClarifier({
  callModel,
  originalQuestion,
  goldContext,
  getProbeContext,
  schemaIdentifiers = [],
  maxClarifications = DEFAULT_MAX_CLARIFICATIONS,
  maxLength = DEFAULT_MAX_LENGTH,
}) {
  if (typeof callModel !== "function") {
    throw new Error("ORACLE_CLARIFIER_CALL_MODEL_REQUIRED");
  }

  let requestCount = 0;
  const auditLog = [];

  return {
    async answer({ clarificationId, question, options = [] } = {}) {
      requestCount += 1;
      const normalizedOptions = Array.isArray(options) ? options.map(String) : [];
      if (requestCount > maxClarifications) {
        const entry = {
          clarificationId: clarificationId ?? null,
          question: String(question ?? ""),
          options: normalizedOptions,
          status: "blocked",
          blockedReason: "MAX_CLARIFICATIONS_EXCEEDED",
          violations: ["max_clarifications_exceeded"],
          attempts: [],
          answeredAt: new Date().toISOString(),
        };
        auditLog.push(entry);
        return {
          ok: false,
          clarificationId: entry.clarificationId,
          blockedReason: "MAX_CLARIFICATIONS_EXCEEDED",
          violations: ["max_clarifications_exceeded"],
          answer: "",
        };
      }

      const probeContext = typeof getProbeContext === "function"
        ? String((await Promise.resolve().then(() => getProbeContext())) ?? "").trim()
        : "";
      const attempts = [];
      let previousDraft;
      let previousViolations;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const prompt = buildClarifierPrompts({
          originalQuestion,
          goldContext,
          probeContext,
          question,
          options: normalizedOptions,
          previousDraft,
          previousViolations,
        });

        let rawResponse;
        try {
          rawResponse = normalizeModelOutput(await callModel({
            ...prompt,
            attempt,
            previousViolations: previousViolations ?? [],
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          attempts.push({ attempt, ok: false, error: message, violations: ["call_model_error"] });
          const entry = {
            clarificationId: clarificationId ?? null,
            question: String(question ?? ""),
            options: normalizedOptions,
            status: "error",
            blockedReason: "CALL_MODEL_ERROR",
            error: message,
            attempts,
            answeredAt: new Date().toISOString(),
          };
          auditLog.push(entry);
          return {
            ok: false,
            clarificationId: entry.clarificationId,
            blockedReason: "CALL_MODEL_ERROR",
            error: message,
            answer: "",
          };
        }

        const candidate = rawResponse.trim();
        const validation = validateClarifierResponse(candidate, { schemaIdentifiers, maxLength });
        attempts.push({
          attempt,
          rawResponse: candidate,
          ok: validation.ok,
          violations: [...validation.violations],
        });

        if (validation.ok) {
          const entry = {
            clarificationId: clarificationId ?? null,
            question: String(question ?? ""),
            options: normalizedOptions,
            status: "answered",
            answer: candidate,
            attempts,
            answeredAt: new Date().toISOString(),
          };
          auditLog.push(entry);
          return {
            ok: true,
            clarificationId: entry.clarificationId,
            answer: candidate,
            attempts: attempts.map((item) => ({ ...item, violations: [...item.violations] })),
          };
        }

        previousDraft = candidate;
        previousViolations = validation.violations;
      }

      const finalViolations = [...(previousViolations ?? [])];
      const entry = {
        clarificationId: clarificationId ?? null,
        question: String(question ?? ""),
        options: normalizedOptions,
        status: "blocked",
        blockedReason: "LEAKAGE_DETECTED",
        violations: finalViolations,
        attempts,
        answeredAt: new Date().toISOString(),
      };
      auditLog.push(entry);
      return {
        ok: false,
        clarificationId: entry.clarificationId,
        blockedReason: "LEAKAGE_DETECTED",
        violations: finalViolations,
        answer: "",
      };
    },

    getAuditLog() {
      return auditLog.map((entry) => ({
        ...entry,
        options: [...entry.options],
        ...(entry.violations ? { violations: [...entry.violations] } : {}),
        attempts: entry.attempts.map((item) => ({
          ...item,
          ...(item.violations ? { violations: [...item.violations] } : {}),
        })),
      }));
    },
  };
}

/**
 * Attaches an oracle clarifier to a ClarificationManager for one specific
 * sessionId. Fails closed with empty answer "" on violations or errors so the
 * asking session never hangs.
 */
export function attachOracleClarifier({ clarificationManager, clarifier, sessionId }) {
  if (!clarificationManager || typeof clarificationManager.subscribe !== "function" || typeof clarificationManager.answer !== "function") {
    throw new Error("CLARIFICATION_MANAGER_REQUIRED");
  }
  if (!clarifier || typeof clarifier.answer !== "function") {
    throw new Error("ORACLE_CLARIFIER_REQUIRED");
  }

  return clarificationManager.subscribe({
    asked(request) {
      if (!request || request.sessionId !== sessionId) return;
      void (async () => {
        let answer = "";
        try {
          const result = await clarifier.answer(request);
          if (result?.ok && typeof result.answer === "string") {
            answer = result.answer;
          }
        } catch {
          answer = "";
        }
        try {
          clarificationManager.answer(request.clarificationId, answer);
        } catch {
          // Ignore if already expired/cancelled while clarifier was answering.
        }
      })();
    },
  });
}
