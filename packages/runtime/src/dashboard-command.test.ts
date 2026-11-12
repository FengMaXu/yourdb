import { describe, expect, it } from "vitest";
import { DataAgentRuntime } from "./protocol.js";

describe("dashboard.refresh command", () => {
  it("passes only the path, the view ids and the request id to the session", async () => {
    const calls: unknown[] = [];
    const runtime = new DataAgentRuntime({ agent: { prompt: async () => ({}), refreshDashboard: async (request, context) => { calls.push({ request, context }); return { datasets: {}, sources: {}, checks: {}, notices: [] }; } } });
    const response = await runtime.dispatch({ protocolVersion: 1, requestId: "req-9", command: { type: "dashboard.refresh", path: "dashboards/a.html", viewIds: ["bar"] } }, { userId: "u", host: "web", sessionId: "s1" });
    expect(response.response).toMatchObject({ type: "dashboard.refresh.result" });
    expect(calls).toEqual([{ request: { path: "dashboards/a.html", viewIds: ["bar"], requestId: "req-9" }, context: { sessionId: "s1", userId: "u" } }]);
    await expect(runtime.dispatch({ protocolVersion: 1, requestId: "req-10", command: { type: "dashboard.refresh", path: "dashboards/a.html", viewIds: ["bar"] } }, { userId: "u", host: "web" })).rejects.toThrow("DASHBOARD_REFRESH_SESSION_REQUIRED");
  });
});
