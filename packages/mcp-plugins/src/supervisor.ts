import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { configView, connectionsOf, mergeSavedConfig, readStoredConfig, withPresets, type StoredMcpConfig } from "./config.js";
import { DEFAULT_MCP_PRESETS, type McpConnectionSpec, type McpHostServer, type McpPreset } from "./presets.js";

/** One tool of a connected plugin, under a name unique across plugins. */
export interface McpPluginTool {
  readonly plugin: string;
  readonly name: string;
  readonly originalName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, options?: { readonly signal?: AbortSignal }): Promise<{ readonly text: string; readonly isError: boolean }>;
}

export interface McpPluginStatus {
  readonly name: string;
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly toolCount: number;
  readonly hostManaged: boolean;
}

export interface McpPluginSupervisorOptions {
  readonly readConfig: () => Promise<unknown>;
  readonly writeConfig: (config: StoredMcpConfig) => Promise<void>;
  readonly presets?: readonly McpPreset[];
  /** Servers the host runs, such as the database; always listed first and always on. */
  readonly hostServers?: readonly McpHostServer[];
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  /** How long a failed connection waits before an ordinary reconcile tries it again; test and restart retry at once. */
  readonly retryAfterMs?: number;
  /** Longest tool result passed on to the model. */
  readonly maxResultChars?: number;
  /** Tests replace the transports. */
  readonly createTransport?: (spec: McpConnectionSpec) => Transport;
}

interface Connection {
  /** `<plugin>/<connection id>`; it survives a change of key or headers, while the Connection object does not. */
  readonly id: string;
  readonly plugin: string;
  readonly spec: McpConnectionSpec;
  readonly key: string;
  client?: Client;
  tools: readonly McpPluginTool[];
  error?: string;
  failedAt?: number;
  closed: boolean;
}

const TOOL_NAME = /[^A-Za-z0-9_-]/g;
const MAX_TOOL_NAME = 64;

function defaultTransport(spec: McpConnectionSpec): Transport {
  if (spec.transport === "stdio") {
    return new StdioClientTransport({ command: spec.command, args: [...spec.args], env: { ...getDefaultEnvironment(), ...spec.env }, stderr: "ignore" });
  }
  const requestInit = { headers: { ...spec.headers } };
  return spec.transport === "sse" ? new SSEClientTransport(new URL(spec.url), { requestInit }) : new StreamableHTTPClientTransport(new URL(spec.url), { requestInit });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒）`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Text the model can read from a tool result; images and other binary parts are named, not inlined. */
function resultText(result: Record<string, unknown>, maxChars: number): string {
  const parts = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  const texts = parts.map((part) => part.type === "text" && typeof part.text === "string" ? part.text : `[${part.type ?? "unknown"} 内容未展示]`);
  let text = texts.join("\n");
  if (!text && result.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[结果过长，已截断，原长 ${text.length} 字符]` : text;
}

/**
 * Connects the enabled MCP plugins saved in settings and serves their tools.
 * Each read of the configuration reconciles the connections: changed or
 * disabled plugins are closed, new or lost ones are connected again.
 */
export function createMcpPluginSupervisor(options: McpPluginSupervisorOptions) {
  const presets = options.presets ?? DEFAULT_MCP_PRESETS;
  const connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
  const callTimeoutMs = options.callTimeoutMs ?? 60_000;
  const maxResultChars = options.maxResultChars ?? 20_000;
  const retryAfterMs = options.retryAfterMs ?? 60_000;
  const createTransport = options.createTransport ?? defaultTransport;
  const hostServers = options.hostServers ?? [];
  const connections = new Map<string, Connection>();
  const configErrors = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };

  const disconnect = async (connection: Connection) => {
    connection.closed = true;
    await connection.client?.close().catch(() => undefined);
  };

  const connect = async (connection: Connection) => {
    const client = new Client({ name: "yourdb", version: "0.1.0" });
    const transport = createTransport(connection.spec);
    try {
      await withTimeout(client.connect(transport), connectTimeoutMs, "连接");
      const listed = await withTimeout(client.listTools(), connectTimeoutMs, "读取工具列表");
      connection.client = client;
      connection.error = undefined;
      connection.failedAt = undefined;
      // A lost process or stream is connected again on the next reconcile.
      // Only this client's own loss counts: a late close of a replaced client must not drop its successor.
      client.onclose = () => {
        if (connection.client !== client) return;
        connection.client = undefined;
        if (!connection.closed) connection.error = "连接已断开";
      };
      connection.tools = listed.tools.map((tool) => ({
        plugin: connection.plugin,
        name: `${connection.spec.id}__${tool.name}`.replace(TOOL_NAME, "_").slice(0, MAX_TOOL_NAME),
        originalName: tool.name,
        description: tool.description ?? tool.title ?? tool.name,
        inputSchema: tool.inputSchema as Record<string, unknown>,
        // Sessions keep their tools for their whole life, so a call goes through whatever connection is current:
        // a new key, a restart or a lost stream must not leave a session holding a closed one.
        call: async (args, callOptions = {}) => {
          const attempt = async () => {
            const client = await liveClient(connection.id);
            try {
              return await client.callTool({ name: tool.name, arguments: args }, undefined, {
                timeout: callTimeoutMs,
                ...(callOptions.signal ? { signal: callOptions.signal } : {}),
              });
            } catch (error) {
              // Closed under us before anything was sent (a key saved just now): the new connection takes it.
              // Only then, since a plugin call may be billed or have effects, and a sent one is never repeated.
              const unsent = error instanceof Error && error.message === "Not connected";
              if (unsent && connections.get(connection.id)?.client !== client && !callOptions.signal?.aborted) return undefined;
              throw error;
            }
          };
          const result = await attempt() ?? await attempt();
          if (!result) throw new Error(`MCP_PLUGIN_DISCONNECTED: ${connection.plugin}（连接刚被替换，请重试）`);
          return { text: resultText(result, maxResultChars), isError: result.isError === true };
        },
      }));
    } catch (error) {
      await client.close().catch(() => undefined);
      connection.client = undefined;
      connection.tools = [];
      connection.error = message(error);
      connection.failedAt = Date.now();
    }
  };

  /** The connected client for a connection id, connecting it again first when it is down. */
  const liveClient = async (id: string): Promise<Client> => {
    // A reconcile already queued (a save just now) decides which connection is current.
    await serialize(async () => undefined);
    let current = connections.get(id);
    if (!current?.client) {
      await reconcile();
      current = connections.get(id);
    }
    if (current?.client) return current.client;
    const plugin = id.slice(0, id.indexOf("/"));
    throw new Error(`MCP_PLUGIN_DISCONNECTED: ${plugin}（${current?.error ?? "插件已停用或已移除"}）`);
  };

  const reconcile = (onlyPlugin?: string, force = false): Promise<ReturnType<typeof readStoredConfig>> => serialize(async () => {
    const config = readStoredConfig(await options.readConfig());
    const desired = new Map<string, Connection>();
    configErrors.clear();
    for (const server of config.servers) {
      if (!server.enabled) continue;
      try {
        for (const spec of connectionsOf(server, presets)) {
          const id = `${server.name}/${spec.id}`;
          desired.set(id, { id, plugin: server.name, spec, key: JSON.stringify(spec), tools: [], closed: false });
        }
      } catch (error) {
        configErrors.set(server.name, message(error));
      }
    }
    for (const [id, existing] of connections) {
      const wanted = desired.get(id);
      const restart = force && (!onlyPlugin || existing.plugin === onlyPlugin);
      if (!wanted || wanted.key !== existing.key || restart) {
        connections.delete(id);
        await disconnect(existing);
      }
    }
    const pending: Promise<void>[] = [];
    for (const [id, wanted] of desired) {
      const existing = connections.get(id);
      if (existing?.client) continue;
      // A plugin that just failed would hold up every new session; it is tried again later or on test.
      if (existing?.failedAt !== undefined && Date.now() - existing.failedAt < retryAfterMs) continue;
      const connection = existing ?? wanted;
      connections.set(id, connection);
      pending.push(connect(connection));
    }
    await Promise.all(pending);
    return config;
  });

  const hostView = (server: McpHostServer) => ({
    name: server.name,
    enabled: true,
    host_managed: true,
    default_enabled: true,
    transport: "stdio",
    description: server.description,
    server_type: "preset",
    settings_hint: server.settingsHint,
    preset: { id: server.name, title: server.title, description: server.description, fields: [] },
  });

  const checkHost = async (server: McpHostServer): Promise<{ ok: boolean; message: string }> => {
    try {
      await withTimeout(server.check(), connectTimeoutMs, "连接");
      return { ok: true, message: `已连接，共 ${server.toolCount} 个工具` };
    } catch (error) {
      return { ok: false, message: message(error) };
    }
  };

  const withHostServers = (view: { servers: unknown[] }) => ({ servers: [...hostServers.map(hostView), ...view.servers] });

  const pluginConnections = (name: string) => [...connections.values()].filter((connection) => connection.plugin === name);

  return {
    /** The settings page's view: presets included, secrets masked. */
    async view(): Promise<unknown> {
      return withHostServers(configView(readStoredConfig(await options.readConfig()), presets));
    },
    async save(incoming: unknown): Promise<unknown> {
      const servers = (incoming as { servers?: unknown } | undefined)?.servers;
      const reserved = Array.isArray(servers)
        ? servers.find((server) => hostServers.some((host) => host.name === (server as { name?: unknown } | undefined)?.name)) as { name: string } | undefined
        : undefined;
      if (reserved) throw new Error(`MCP_CONFIG_INVALID: 名称 "${reserved.name}" 已被预装插件使用`);
      const merged = mergeSavedConfig(readStoredConfig(await options.readConfig()), incoming, presets);
      await options.writeConfig(merged);
      void reconcile().catch(() => undefined);
      return withHostServers(configView(merged, presets));
    },
    async status(): Promise<McpPluginStatus[]> {
      const [config, hosts] = await Promise.all([reconcile(), Promise.all(hostServers.map(checkHost))]);
      const hostStatuses = hostServers.map((server, index) => ({
        name: server.name,
        enabled: true,
        connected: hosts[index]!.ok,
        toolCount: hosts[index]!.ok ? server.toolCount : 0,
        hostManaged: true,
      }));
      return [...hostStatuses, ...withPresets(config, presets).map((server) => {
        const owned = pluginConnections(server.name);
        return {
          name: server.name,
          enabled: server.enabled,
          connected: server.enabled && owned.length > 0 && owned.every((connection) => Boolean(connection.client)),
          toolCount: owned.reduce((sum, connection) => sum + connection.tools.length, 0),
          hostManaged: false,
        };
      })];
    },
    /** Connects the plugin again and says what happened. */
    async test(name: string): Promise<{ ok: boolean; message: string }> {
      const host = hostServers.find((server) => server.name === name);
      if (host) return checkHost(host);
      const config = await reconcile(name, true);
      const server = config.servers.find((item) => item.name === name);
      if (!server?.enabled) return { ok: false, message: "插件未启用，请先启用后再测试" };
      const problem = configErrors.get(name);
      if (problem) return { ok: false, message: problem.replace(/^MCP_PLUGIN_INCOMPLETE: /, "") };
      const owned = pluginConnections(name);
      const failed = owned.filter((connection) => !connection.client);
      if (failed.length > 0) return { ok: false, message: failed.map((connection) => `${connection.spec.id}: ${connection.error ?? "未连接"}`).join("；") };
      return { ok: true, message: `已连接，共 ${owned.reduce((sum, connection) => sum + connection.tools.length, 0)} 个工具` };
    },
    async restart(name: string): Promise<{ ok: boolean }> {
      const host = hostServers.find((server) => server.name === name);
      if (host) return { ok: (await checkHost(host)).ok };
      await reconcile(name, true);
      const owned = pluginConnections(name);
      return { ok: owned.length > 0 && owned.every((connection) => Boolean(connection.client)) };
    },
    /** Tools of every connected plugin; a plugin that cannot connect contributes none. */
    async tools(): Promise<readonly McpPluginTool[]> {
      await reconcile();
      const seen = new Set<string>();
      return [...connections.values()].flatMap((connection) => connection.tools).filter((tool) => !seen.has(tool.name) && Boolean(seen.add(tool.name)));
    },
    async close(): Promise<void> {
      await serialize(async () => {
        const all = [...connections.values()];
        connections.clear();
        await Promise.all(all.map(disconnect));
      });
    },
  };
}

export type McpPluginSupervisor = ReturnType<typeof createMcpPluginSupervisor>;
