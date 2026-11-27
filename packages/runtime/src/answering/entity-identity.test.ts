import { describe, expect, it } from "vitest";
import { evaluateEntityIdentity, identityQueries, identityTargets } from "./entity-identity.js";
import { InMemoryAnswering } from "./service.js";
import { InMemoryAnsweringStore } from "./answering-store.js";
import { InMemoryResultStore } from "./result-store.js";
import type { SpecFields } from "./model.js";

const specified = (value: unknown) => ({ state: "specified", value, basis: { kind: "assumed" } }) as const;
const fieldsOf = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([path, value]) => [path, specified(value)])) as unknown as SpecFields;

describe("entity identity rules", () => {
  const users = fieldsOf({
    "population.entity": { name: "user", keyColumns: ["mst_users.user_id"] },
    "population.source": { tables: ["mst_users"] },
    "measure.formula": { op: "count", of: "user_id" },
  });

  it("targets the declared source tables with the declared key, and only plain identifiers", () => {
    expect(identityTargets(users).targets).toEqual([{ table: "mst_users", keyColumns: ["user_id"] }]);
    const hostile = identityTargets(fieldsOf({ "population.entity": "user", "population.source": { tables: ["users; DROP TABLE users", "main.orders"] } }));
    expect(hostile.targets).toEqual([{ table: "main.orders" }]);
    expect(hostile.limitations[0]).toContain("not a plain table name");
    expect(identityQueries({ table: "mst_users", keyColumns: ["user_id"] }).distinctKeys).toBe("SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id FROM mst_users) AS d");
  });

  it("finds a counted key that is not unique (local358)", () => {
    const report = evaluateEntityIdentity(users, [{ table: "mst_users", keyColumns: ["user_id"], rows: 320, distinctRows: 320, distinctKeys: 30 }]);
    expect(report.status).toBe("finding");
    expect(report.findings).toEqual([expect.objectContaining({ code: "key_not_unique", message: expect.stringContaining("320 rows for 30 distinct user_id") })]);
  });

  it("does not report a non-unique key the formula does not count", () => {
    const perEmployee = fieldsOf({
      "population.entity": { name: "employee", keyColumns: ["employeeid"] },
      "population.source": { tables: ["orders"] },
      "measure.formula": { op: "count", per: "employee", of: "orders shipped late" },
    });
    expect(evaluateEntityIdentity(perEmployee, [{ table: "orders", keyColumns: ["employeeid"], rows: 830, distinctRows: 830, distinctKeys: 9 }]).status).toBe("clear");
  });

  it("finds exact duplicate rows (local040)", () => {
    const trees = fieldsOf({ "population.entity": "tree", "population.source": { tables: ["trees"] }, "measure.formula": { op: "count", of: "trees" } });
    const report = evaluateEntityIdentity(trees, [{ table: "trees", rows: 690626, distinctRows: 683788 }]);
    expect(report.findings).toEqual([expect.objectContaining({ code: "duplicate_rows", message: expect.stringContaining("6838 exact duplicates") })]);
    // local041: the gold counts the rows as stored; the finding must not tell the solver to deduplicate.
    expect(report.findings[0]!.message).toContain("not a reason to deduplicate");
  });

  it("emits only neutral duplicate_rows when whole rows duplicate and distinctRows equals distinctKeys", () => {
    const report = evaluateEntityIdentity(users, [{ table: "mst_users", keyColumns: ["user_id"], rows: 100, distinctRows: 95, distinctKeys: 95 }]);
    expect(report.status).toBe("finding");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ code: "duplicate_rows" });
    expect(report.findings[0]!.message).toContain("not a reason to deduplicate");
    expect(report.findings[0]!.message).not.toContain("count the rows as stored");
  });

  it("emits both key_not_unique and duplicate_rows when key varies across distinct rows alongside exact duplicates", () => {
    const report = evaluateEntityIdentity(users, [{ table: "mst_users", keyColumns: ["user_id"], rows: 100, distinctRows: 95, distinctKeys: 40 }]);
    expect(report.status).toBe("finding");
    expect(report.findings.map((item) => item.code)).toEqual(["key_not_unique", "duplicate_rows"]);
  });

  it("is not applicable without a settled entity and source, and unknown when counts are missing", () => {
    expect(evaluateEntityIdentity(fieldsOf({ "population.entity": "user" }), []).status).toBe("not_applicable");
    expect(evaluateEntityIdentity(users, [{ table: "mst_users", keyColumns: ["user_id"], limitation: "the table could not be counted" }]).status).toBe("unknown");
  });
});

describe("entity identity in Answering", () => {
  const business = (invocationId: string) => ({ principal: { id: "user-1" }, sessionId: "session-1", lane: "main", operationId: "operation-1", invocationId });
  const spec = {
    "population.entity": { name: "user", keyColumns: ["user_id"] },
    "population.eligibility": "n/a",
    "population.conditions": "n/a",
    "population.source": { tables: ["mst_users"] },
    "population.time": "n/a",
    "measure.formula": { op: "count", of: "user_id" },
    "measure.countGrain": { grain: "row", note: "one row per user" },
    grouping: "n/a",
    selection: "n/a",
    output: { rowMode: "scalar", rowCount: 1 },
  };

  it("counts after the Revision commits, carries counts forward, and discloses findings with the result", async () => {
    const queries: string[] = [];
    const counts: Record<string, number> = {
      "SELECT COUNT(*) AS n FROM mst_users": 320,
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT * FROM mst_users) AS d": 320,
      "SELECT COUNT(*) AS n FROM (SELECT DISTINCT user_id FROM mst_users) AS d": 30,
    };
    const answering = new InMemoryAnswering({
      store: new InMemoryAnsweringStore(),
      resultStore: new InMemoryResultStore(),
      sqlExecutor: {
        run: async (sql) => {
          queries.push(sql);
          return sql in counts ? { columns: ["n"], rows: [[counts[sql]]], truncated: false } : { columns: ["n"], rows: [[320]], truncated: false };
        },
      },
    });
    const view = await answering.set({ requestMessageId: "message", requestId: "begin", fields: spec }, business("begin"));
    expect(view.entityIdentity).toMatchObject({ status: "finding", findings: [{ code: "key_not_unique" }] });
    expect(queries).toHaveLength(3);

    const revised = await answering.set({ taskId: view.taskId, requestId: "revise", fields: { "measure.countGrain": { value: { grain: "row", note: "one row per user record" }, reason: "clarify" } } }, business("revise"));
    expect(revised.entityIdentity).toMatchObject({ status: "finding" });
    expect(queries).toHaveLength(3);

    const execution = await answering.execute({ kind: "result", taskId: view.taskId, revisionId: revised.revisionId, sql: "SELECT COUNT(user_id) FROM mst_users" }, business("result"));
    if (execution.artifact.kind !== "candidate") throw new Error("expected a candidate");
    const receipt = await answering.publish({ candidateId: execution.artifact.candidateId, format: "auto", requestId: "publish" }, business("publish"));
    expect(receipt.disclosure?.summary).toContain("来源表的行与实体不一一对应");
  });
});
