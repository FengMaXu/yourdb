import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ClarificationManager } from "@data-agent/runtime/testing";
import {
  attachOracleClarifier,
  createOracleClarifier,
  extractSchemaIdentifiersFromDdlCsv,
  summarizeProbeOutcomesFromCalls,
  validateClarifierResponse,
} from "./oracle-clarifier.mjs";

const execFileAsync = promisify(execFile);

test("validateClarifierResponse accepts clean business sentences with decimals and plain prose", () => {
  const schemaIdentifiers = ["orders", "status", "amount", "order_id", "customerName", "OrderStatus", "col1"];
  assert.deepEqual(
    validateClarifierResponse(
      "Count only completed orders from last year where the ratio exceeds 1.5, e.g. active retail accounts.",
      { schemaIdentifiers },
    ),
    { ok: true, violations: [] },
  );
  assert.deepEqual(
    validateClarifierResponse("Include pending status rows when computing total amount.", { schemaIdentifiers }),
    { ok: true, violations: [] },
  );
});

test("validateClarifierResponse rejects empty, overlong, SQL keywords/functions/tokens, backticks, qualified refs, and physical schema identifiers", () => {
  assert.equal(validateClarifierResponse("   \n\t ").ok, false);
  assert.equal(validateClarifierResponse("a".repeat(321)).ok, false);
  assert.equal(validateClarifierResponse("Use SELECT to pick rows.").ok, false);
  assert.equal(validateClarifierResponse("Filter FROM the table.").ok, false);
  assert.equal(validateClarifierResponse("Filter WHERE active is true.").ok, false);
  assert.equal(validateClarifierResponse("Use group by region.").ok, false);
  assert.equal(validateClarifierResponse("Use order by date.").ok, false);
  assert.equal(validateClarifierResponse("Filter HAVING count above one.").ok, false);
  assert.equal(validateClarifierResponse("Use JOIN on customers.").ok, false);
  assert.equal(validateClarifierResponse("Combine with UNION.").ok, false);
  assert.equal(validateClarifierResponse("Start WITH a CTE.").ok, false);
  assert.equal(validateClarifierResponse("Apply LIMIT 10.").ok, false);
  assert.equal(validateClarifierResponse("Use DISTINCT values.").ok, false);
  assert.equal(validateClarifierResponse("Use case when active.").ok, false);
  assert.equal(validateClarifierResponse("Keep rows that are is not null.").ok, false);
  assert.equal(validateClarifierResponse("Compute COUNT(id) per user.").ok, false);
  assert.equal(validateClarifierResponse("Compute sum(total) per user.").ok, false);
  assert.equal(validateClarifierResponse("Compute AVG(price).").ok, false);
  assert.equal(validateClarifierResponse("Compute MIN(price) and MAX(price).").ok, false);
  assert.equal(validateClarifierResponse("Use COALESCE(x, 0).").ok, false);
  assert.equal(validateClarifierResponse("Use strftime('%Y', dt).").ok, false);
  assert.equal(validateClarifierResponse("Use CAST(x AS REAL).").ok, false);
  assert.equal(validateClarifierResponse("Ignore -- comments.").ok, false);
  assert.equal(validateClarifierResponse("Ignore /* comments */.").ok, false);
  assert.equal(validateClarifierResponse("Exclude status <> zero.").ok, false);
  assert.equal(validateClarifierResponse("Exclude status != zero.").ok, false);
  assert.equal(validateClarifierResponse("Use `order_id` for grouping.").ok, false);
  assert.equal(validateClarifierResponse("Filter on orders.order_id.").ok, false);

  const schemaIdentifiers = ["order_id", "customerName", "OrderStatus", "col1"];
  assert.equal(validateClarifierResponse("Group by ORDER_ID.", { schemaIdentifiers }).ok, false);
  assert.equal(validateClarifierResponse("Match customername exactly.", { schemaIdentifiers }).ok, false);
  assert.equal(validateClarifierResponse("Filter on orderstatus.", { schemaIdentifiers }).ok, false);
  assert.equal(validateClarifierResponse("Use COL1 as the key.", { schemaIdentifiers }).ok, false);
});

test("extractSchemaIdentifiersFromDdlCsv parses table names and column names", () => {
  const ddlCsv = [
    "table_name,DDL",
    'orders,"CREATE TABLE orders (\n  order_id INTEGER PRIMARY KEY,\n  customerName TEXT,\n  col1 REAL\n);"',
  ].join("\n");
  const ids = extractSchemaIdentifiersFromDdlCsv(ddlCsv);
  assert.equal(ids.includes("orders"), true);
  assert.equal(ids.includes("order_id"), true);
  assert.equal(ids.includes("customerName"), true);
  assert.equal(ids.includes("col1"), true);
});

test("createOracleClarifier is stateless per request, retries once on leakage, fails closed, enforces cap, and records audit log", async () => {
  const seenPrompts = [];
  let mode = "retry_recover";
  const clarifier = createOracleClarifier({
    originalQuestion: "How many active customers placed completed orders?",
    goldContext: "Gold SQL: SELECT COUNT(DISTINCT customer_id) FROM orders WHERE status = 'completed';",
    schemaIdentifiers: ["orders", "customer_id", "status"],
    maxClarifications: 3,
    callModel: async (payload) => {
      seenPrompts.push(payload);
      if (mode === "retry_recover") {
        if (payload.attempt === 1) return "Use COUNT(customer_id) on orders.customer_id.";
        return "Count unique customers who have at least one completed purchase.";
      }
      if (mode === "persistent_leak") {
        return "Always filter by customer_id with SELECT.";
      }
      return "Include only completed purchases.";
    },
  });

  // 1. Retry-once recovery
  const first = await clarifier.answer({
    clarificationId: "c1",
    question: "Should cancelled orders be included?",
    options: ["Completed only", "All orders"],
  });
  assert.equal(first.ok, true);
  assert.equal(first.answer, "Count unique customers who have at least one completed purchase.");
  assert.equal(seenPrompts.length, 2);
  assert.match(seenPrompts[1].userPrompt, /sql_function:COUNT\(/);
  assert.match(seenPrompts[1].userPrompt, /qualified_identifier:orders\.customer_id/);

  // 2. Stateless: second request prompt does not carry first request text
  mode = "clean";
  const second = await clarifier.answer({
    clarificationId: "c2",
    question: "Include refunded purchases?",
    options: ["Exclude refunds", "Include refunds"],
  });
  assert.equal(second.ok, true);
  assert.equal(seenPrompts[2].userPrompt.includes("Should cancelled orders be included?"), false);

  // 3. Persistent leakage fails closed after at most 1 retry
  mode = "persistent_leak";
  const third = await clarifier.answer({
    clarificationId: "c3",
    question: "Which customer scope?",
    options: [],
  });
  assert.equal(third.ok, false);
  assert.equal(third.blockedReason, "LEAKAGE_DETECTED");
  assert.equal(third.answer, "");
  assert.ok(third.violations.includes("schema_identifier:customer_id"));
  assert.equal(seenPrompts.length, 5);

  // 4. Max clarifications cap enforced without calling model
  const fourth = await clarifier.answer({
    clarificationId: "c4",
    question: "One more question?",
    options: [],
  });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.blockedReason, "MAX_CLARIFICATIONS_EXCEEDED");
  assert.equal(fourth.answer, "");
  assert.equal(seenPrompts.length, 5);

  const audit = clarifier.getAuditLog();
  assert.equal(audit.length, 4);
  assert.equal(audit[0].status, "answered");
  assert.equal(audit[0].attempts.length, 2);
  assert.equal(audit[1].status, "answered");
  assert.equal(audit[2].status, "blocked");
  assert.equal(audit[2].blockedReason, "LEAKAGE_DETECTED");
  assert.equal(audit[3].status, "blocked");
  assert.equal(audit[3].blockedReason, "MAX_CLARIFICATIONS_EXCEEDED");
});

test("attachOracleClarifier filters foreign sessions, answers matching session, and settles fail-closed without hanging", async () => {
  const manager = new ClarificationManager(5_000);
  let leakMode = false;
  const clarifier = createOracleClarifier({
    originalQuestion: "Compute net revenue.",
    goldContext: "Exclude cancelled orders.",
    schemaIdentifiers: ["order_id"],
    callModel: async () => (leakMode ? "Filter by order_id using SELECT." : "Exclude cancelled orders from net revenue."),
  });

  const detach = attachOracleClarifier({
    clarificationManager: manager,
    clarifier,
    sessionId: "target-session",
  });

  try {
    // Foreign session should be ignored by attachOracleClarifier
    const foreign = manager.ask("foreign-session", "Foreign question?", ["A", "B"], 50);
    assert.equal(await foreign.promise, "");
    assert.equal(clarifier.getAuditLog().length, 0);

    // Target session gets answered
    const matching = manager.ask("target-session", "Should cancelled orders be excluded?", ["Exclude", "Include"]);
    assert.equal(await matching.promise, "Exclude cancelled orders from net revenue.");

    // Fail-closed violation settles with "" immediately without hanging
    leakMode = true;
    const leaked = manager.ask("target-session", "Which identifier?", ["A", "B"], 5_000);
    assert.equal(await leaked.promise, "");
    assert.equal(clarifier.getAuditLog().length, 2);
    assert.equal(clarifier.getAuditLog()[1].blockedReason, "LEAKAGE_DETECTED");
  } finally {
    detach();
  }
});

test("run.mjs rejects conflicting --oracle-clarifier and --disable-clarification flags and redacts blind reports", async () => {
  const runnerPath = path.resolve("evaluations/spider2/run.mjs");
  await assert.rejects(
    execFileAsync(process.execPath, [runnerPath, "preflight", "--oracle-clarifier", "--disable-clarification"], { timeout: 5_000, windowsHide: true }),
    /CONFLICTING_CLARIFICATION_FLAGS/,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), "spider2-blind-report-"));
  try {
    const runsRoot = path.join(root, "runs");
    const runDir = path.join(runsRoot, "blind-test");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      instanceIds: ["local001", "local002"],
      attemptPolicy: { selectedAttemptId: "legacy" },
    }), "utf8");
    await writeFile(path.join(runDir, "cases.jsonl"), [
      JSON.stringify({ instanceId: "local001", db: "demo", backend: "sqlite", status: "error", durationMs: 10, toolCalls: 1, finalSql: { sql: "SELECT secret_col FROM secret_tbl" }, csvGenerated: false, error: { message: "boom" } }),
      JSON.stringify({ instanceId: "local002", db: "demo", backend: "sqlite", status: "completed", durationMs: 20, toolCalls: 2, finalSql: { sql: "SELECT 1" }, csvGenerated: true }),
    ].join("\n"), "utf8");
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ spider2Repo: root, runsRoot }), "utf8");

    const { stdout } = await execFileAsync(process.execPath, [
      runnerPath,
      "report",
      "--config", configPath,
      "--run", "blind-test",
      "--blind",
    ], { timeout: 5_000, windowsHide: true });

    const reportMd = await readFile(path.join(runDir, "report.md"), "utf8");
    assert.match(reportMd, /Blind holdout redaction: active/);
    assert.doesNotMatch(reportMd, /## Cases needing review/);
    assert.doesNotMatch(reportMd, /local001/);
    assert.doesNotMatch(reportMd, /local002/);
    assert.doesNotMatch(reportMd, /secret_col/);
    assert.doesNotMatch(stdout, /local001/);

    // Auto-blind when manifest.instanceIds intersects evaluations/spider2/blind-holdout-ids.txt
    const blindIdsRaw = await readFile(path.resolve("evaluations/spider2/blind-holdout-ids.txt"), "utf8");
    const sampleBlindId = blindIdsRaw.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    assert.ok(sampleBlindId);
    const autoBlindDir = path.join(runsRoot, "auto-blind-test");
    await mkdir(path.join(autoBlindDir, "cases", sampleBlindId), { recursive: true });
    await writeFile(path.join(autoBlindDir, "manifest.json"), JSON.stringify({
      instanceIds: [sampleBlindId],
      attemptPolicy: { selectedAttemptId: "legacy" },
    }), "utf8");
    await writeFile(path.join(autoBlindDir, "cases", sampleBlindId, "result.json"), JSON.stringify({
      instanceId: sampleBlindId,
      db: "demo",
      backend: "sqlite",
      status: "error",
      durationMs: 10,
      toolCalls: 1,
      finalSql: null,
      csvGenerated: false,
      error: { message: "err" },
    }), "utf8");
    await execFileAsync(process.execPath, [
      runnerPath,
      "report",
      "--config", configPath,
      "--run", "auto-blind-test",
    ], { timeout: 5_000, windowsHide: true });
    const autoReportMd = await readFile(path.join(autoBlindDir, "report.md"), "utf8");
    assert.match(autoReportMd, /Blind holdout redaction: active/);
    assert.doesNotMatch(autoReportMd, /## Cases needing review/);
    assert.doesNotMatch(autoReportMd, new RegExp(sampleBlindId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("summarizeProbeOutcomesFromCalls maps alternatives, keeps latest probe outputs, skips errors, and bounds size", () => {
  assert.equal(summarizeProbeOutcomesFromCalls([]), "");

  const calls = [
    {
      toolName: "set_answer_spec",
      isError: false,
      result: {
        details: {
          fields: [
            {
              path: "population.timeField",
              status: "open",
              alternatives: [
                { id: "alt_purchase", value: "orders.purchase_ts" },
                { id: "alt_delivered", value: "orders.delivered_ts" },
              ],
            },
          ],
        },
      },
    },
    {
      toolName: "query_database",
      isError: false,
      args: { kind: "exploration", probe: { path: "population.timeField", alternativeId: "alt_purchase" }, sql: "SELECT 1" },
      result: {
        content: [{
          type: "text",
          text: [
            "[EXPLORATION_EVIDENCE] evidenceId=ev_old",
            "Cite this evidenceId in a field's evidenceIds; do not resubmit the observation body.",
            "[PROBE] path=population.timeField alternativeId=alt_purchase rows=12 output=old111",
            "month | cnt",
            "January | 999",
          ].join("\n"),
        }],
      },
    },
    {
      toolName: "query_database",
      isError: false,
      args: { kind: "exploration", probe: { path: "population.timeField", alternativeId: "alt_purchase" }, sql: "SELECT 2" },
      result: {
        content: [{
          type: "text",
          text: [
            "[EXPLORATION_EVIDENCE] evidenceId=ev_new",
            "[PROBE] path=population.timeField alternativeId=alt_purchase rows=12 output=new222",
            "Alternatives of the same field with equal output ids produce the same answer.",
            "month | cnt",
            "January | 750",
          ].join("\n"),
        }],
      },
    },
    {
      toolName: "query_database",
      isError: true,
      args: { kind: "exploration", probe: { path: "population.timeField", alternativeId: "alt_delivered" }, sql: "BAD" },
      result: { content: [{ type: "text", text: "syntax error" }] },
    },
    {
      toolName: "query_database",
      isError: false,
      args: { kind: "exploration", probe: { path: "population.timeField", alternativeId: "alt_delivered" }, sql: "SELECT 3" },
      result: {
        content: [{
          type: "text",
          text: [
            "[PROBE] path=population.timeField alternativeId=alt_delivered rows=12 output=del333",
            "[WITNESS] only alt_delivered returns (January=283)",
            "month | cnt",
            "January | 283",
          ].join("\n"),
        }],
      },
    },
  ];

  const summary = summarizeProbeOutcomesFromCalls(calls);
  assert.match(summary, /Field: population\.timeField/);
  assert.match(summary, /orders\.purchase_ts \(alt_purchase\)/);
  assert.match(summary, /January \| 750/);
  assert.doesNotMatch(summary, /January \| 999/);
  assert.doesNotMatch(summary, /syntax error/);
  assert.doesNotMatch(summary, /\[EXPLORATION_EVIDENCE\]/);
  assert.match(summary, /January \| 283/);

  const truncated = summarizeProbeOutcomesFromCalls(calls, { maxChars: 120 });
  assert.equal(truncated.length, 120);
  assert.equal(truncated.endsWith("..."), true);
});

test("createOracleClarifier injects dynamic getProbeContext and Gold-CSV precedence while blocking leakage", async () => {
  const seenPrompts = [];
  let dynamicProbe = "";
  let forceLeak = false;
  const clarifier = createOracleClarifier({
    originalQuestion: "Monthly delivered orders?",
    goldContext: "Authoritative Gold CSV Preview (local028.csv):\nMonth,2017\nJanuary,283",
    getProbeContext: () => dynamicProbe,
    schemaIdentifiers: ["order_delivered_customer_date"],
    callModel: async (payload) => {
      seenPrompts.push(payload);
      if (forceLeak) return "Group by order_delivered_customer_date.";
      return "Classify delivered orders by the month they were delivered to the customer.";
    },
  });

  // First call before probes run: no Observed Candidate Probe Outputs block
  await clarifier.answer({ clarificationId: "c1", question: "Which date?", options: ["Purchase date", "Delivery date"] });
  assert.equal(seenPrompts[0].userPrompt.includes("Observed Candidate Probe Outputs"), false);
  assert.match(seenPrompts[0].systemPrompt, /Gold CSV Preview is the authoritative grading truth/);

  // Second call after probes populate: dynamic probe context included
  dynamicProbe = "Field: population.timeField\n- Candidate orders.delivered_ts: January | 283";
  const second = await clarifier.answer({ clarificationId: "c2", question: "Which date?", options: ["Purchase date", "Delivery date"] });
  assert.equal(second.ok, true);
  assert.match(seenPrompts[1].userPrompt, /Observed Candidate Probe Outputs \(CONFIDENTIAL/);
  assert.match(seenPrompts[1].userPrompt, /January \| 283/);

  // Leakage guard still fails closed
  forceLeak = true;
  const third = await clarifier.answer({ clarificationId: "c3", question: "Which date?", options: ["Purchase date", "Delivery date"] });
  assert.equal(third.ok, false);
  assert.equal(third.blockedReason, "LEAKAGE_DETECTED");
});
