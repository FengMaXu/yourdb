import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "../protocol.js";

const command = (body: Record<string, unknown>) => ({ protocolVersion: 1 as const, requestId: "r", command: body }) as never;
const context = { userId: "u", host: "web" as const };

describe("channel commands", () => {
  it("say plainly when this host has no channels", async () => {
    await expect(new DataAgentRuntime().dispatch(command({ type: "channel.list" }), context)).rejects.toThrow("CHANNELS_NOT_CONFIGURED");
  });

  it("route list, provision and disconnect to the host's channel control", async () => {
    const runtime = new DataAgentRuntime();
    const calls: string[] = [];
    const status = [{ id: "feishu", label: "飞书", state: "unconfigured" as const, provisionable: true }];
    runtime.channelControl = {
      list: () => status,
      provision: async (id) => { calls.push(`provision:${id}`); return status; },
      disconnect: async (id) => { calls.push(`disconnect:${id}`); return status; },
      configure: async (id, settings) => { calls.push(`configure:${id}:${JSON.stringify(settings)}`); return status; },
      createLinkCode: async (userId) => { calls.push(`code:${userId}`); return { code: "123456", expiresAt: 9 }; },
      access: async () => ({ members: [], requests: [] }),
      decideAccess: async (requestId, decision, decidedBy) => { calls.push(`decide:${requestId}:${decision}:${decidedBy}`); return "allowed"; },
      revokeAccess: async (actor) => { calls.push(`revoke:${actor.externalUserId}`); },
    };
    for (const body of [{ type: "channel.list" }, { type: "channel.provision", channelId: "feishu" }, { type: "channel.disconnect", channelId: "feishu" }, { type: "channel.configure", channelId: "feishu", enabled: false, replyDetail: "summary" }]) {
      expect((await runtime.dispatch(command(body), context)).response).toEqual({ type: "channel.list.result", channels: status });
    }
    expect((await runtime.dispatch(command({ type: "channel.bind_code" }), context)).response).toEqual({ type: "channel.bind_code.result", code: "123456", expiresAt: 9 });
    const actor = { channel: "feishu", tenant: "t", externalUserId: "ou_x" };
    for (const body of [{ type: "channel.access.list" }, { type: "channel.access.decide", requestId: "req-1", decision: "allow" }, { type: "channel.access.revoke", actor }]) {
      expect((await runtime.dispatch(command(body), context)).response).toEqual({ type: "channel.access.result", access: { members: [], requests: [] } });
    }
    expect(calls).toEqual(["provision:feishu", "disconnect:feishu", 'configure:feishu:{"enabled":false,"replyDetail":"summary"}', "code:u", "decide:req-1:allow:u", "revoke:ou_x"]);
  });
});
