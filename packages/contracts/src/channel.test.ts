import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { DataAgentEventSchema, DeliverableSchema, parseSubmission, RequestContextSchema } from "./index.js";

const address = { channel: "feishu", tenant: "t1", chatId: "oc_1", audience: "group" as const };
const actor = { channel: "feishu", tenant: "t1", externalUserId: "ou_1" };

describe("channel contracts", () => {
  it("accepts input and answer Submissions and nothing else", () => {
    expect(parseSubmission({ requestId: "evt-1", address, actor, body: { kind: "input", text: "上月销售额", whenBusy: "follow_up" } }).body.kind).toBe("input");
    expect(parseSubmission({ requestId: "evt-2", address, actor, body: { kind: "answer", clarificationId: "c1", text: "已支付" } }).body.kind).toBe("answer");
    expect(() => parseSubmission({ requestId: "evt-3", address, actor, body: { kind: "send", text: "x" } })).toThrow(TypeError);
    expect(() => parseSubmission({ requestId: "evt-4", address: { ...address, audience: "public" }, actor, body: { kind: "input", text: "x", whenBusy: "follow_up" } })).toThrow(TypeError);
    // Identity is part of the verified actor, never an extra field a platform payload can smuggle in.
    expect(() => parseSubmission({ requestId: "evt-5", address, actor: { ...actor, userId: "admin" }, body: { kind: "input", text: "x", whenBusy: "follow_up" } })).toThrow(TypeError);
  });

  it("carries publication.delivered on the event stream and as a Deliverable", () => {
    const publication = { type: "publication.delivered" as const, receiptId: "p1", taskId: "t1", format: "csv" as const, publicRef: "/api/runtime/publications/p1?session_id=s" };
    expect(Value.Check(DataAgentEventSchema, publication)).toBe(true);
    expect(Value.Check(DeliverableSchema, { kind: "publication", publication })).toBe(true);
    expect(Value.Check(DataAgentEventSchema, { ...publication, rows: [[1]] })).toBe(false);
  });

  it("lets channel Hosts identify themselves", () => {
    expect(Value.Check(RequestContextSchema, { userId: "u1", host: "channel", sessionId: "s1" })).toBe(true);
  });
});
