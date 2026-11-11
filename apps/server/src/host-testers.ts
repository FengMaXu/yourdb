/**
 * Host-injected tester ports shared by the Web Host.
 * Database probes are routed through the connection's MCP child process; this module
 * never imports a database driver or opens a business-database connection.
 */
import { testDatabaseConnection, type DatabaseServers } from "@data-agent/database";

export interface ProbeResult { success: boolean; message: string; details?: unknown }

export async function testLlmProfile(profile: Record<string, unknown>): Promise<ProbeResult> {
  const provider = String(profile.provider ?? "openai");
  const apiKey = String(profile.api_key ?? profile.openai_api_key ?? profile.anthropic_api_key ?? "").trim();
  const model = String(profile.model ?? (provider === "anthropic" ? "claude-sonnet-4-20250514" : "gpt-4o-mini"));
  if (!apiKey) return { success: false, message: "缺少 API Key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    if (provider === "anthropic") {
      const baseUrl = String(profile.base_url ?? "https://api.anthropic.com").replace(/\/$/, "");
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
        signal: controller.signal,
      });
      if (response.ok) return { success: true, message: `Anthropic 连接成功（${model}）` };
      const text = await response.text().catch(() => "");
      return { success: false, message: `Anthropic 校验失败 (HTTP ${response.status})`, details: text.slice(0, 300) };
    }
    const baseUrl = String(profile.base_url ?? profile.openai_base_url ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: controller.signal,
    });
    if (response.ok) return { success: true, message: `OpenAI 兼容接口连接成功（${model}）` };
    const text = await response.text().catch(() => "");
    return { success: false, message: `OpenAI 兼容接口校验失败 (HTTP ${response.status})`, details: text.slice(0, 300) };
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "AbortError" ? "请求超时（20s）" : error.message) : String(error);
    return { success: false, message: `模型服务连接失败: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

export function createHostTesters(options: { databaseServers: DatabaseServers }) {
  return {
    dbTester: { test: (connection: Record<string, unknown>) => testDatabaseConnection(connection, options.databaseServers) },
    llmTester: { test: testLlmProfile },
  };
}
