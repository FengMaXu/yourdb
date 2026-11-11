import { parseStringMap, type McpConnectionSpec, type McpPreset, type McpPresetValues } from "./presets.js";

/** One plugin as saved under the `mcp.config` metadata key. Secrets are stored as entered. */
export interface StoredMcpServer {
  readonly name: string;
  readonly enabled: boolean;
  /** Set for a preset plugin; its connection comes from the preset and `field_values`. */
  readonly preset?: string;
  readonly field_values?: McpPresetValues;
  readonly transport?: string;
  readonly command?: string;
  readonly script?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly tool_prefix?: string;
  readonly server_type?: string;
  readonly tags?: readonly string[];
}

export interface StoredMcpConfig {
  readonly servers: readonly StoredMcpServer[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? parseStringMap(value, label) : undefined;
  const map = record(value);
  if (!map || Object.values(map).some((item) => typeof item !== "string")) throw new Error(`MCP_CONFIG_INVALID: ${label} 必须是字符串键值对`);
  return map as Record<string, string>;
}

function fieldValues(value: unknown): Record<string, string | string[]> {
  const map = record(value) ?? {};
  const values: Record<string, string | string[]> = {};
  for (const [key, item] of Object.entries(map)) {
    if (typeof item === "string") values[key] = item;
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) values[key] = [...item];
  }
  return values;
}

/** The saved configuration, or an empty one; anything unreadable is dropped rather than connected. */
export function readStoredConfig(value: unknown): StoredMcpConfig {
  const servers = record(value)?.servers;
  if (!Array.isArray(servers)) return { servers: [] };
  return { servers: servers.flatMap((server) => {
    const item = record(server);
    return item && typeof item.name === "string" ? [item as unknown as StoredMcpServer] : [];
  }) };
}

/**
 * Applies a save from the settings page. The page never receives secrets, so a
 * header, env or secret field left out keeps what was stored for that plugin.
 */
export function mergeSavedConfig(previous: StoredMcpConfig, incoming: unknown, presets: readonly McpPreset[]): StoredMcpConfig {
  const servers = record(incoming)?.servers;
  if (!Array.isArray(servers)) throw new Error("MCP_CONFIG_INVALID: servers 必须是数组");
  const seen = new Set<string>();
  const merged = servers.map((raw): StoredMcpServer => {
    const server = record(raw);
    const name = typeof server?.name === "string" ? server.name.trim() : "";
    if (!server || !NAME.test(name)) throw new Error(`MCP_CONFIG_INVALID: 插件名称 "${name}" 只能包含字母、数字、- 和 _，最长 32 个字符`);
    if (seen.has(name)) throw new Error(`MCP_CONFIG_INVALID: 插件名称 "${name}" 重复`);
    seen.add(name);
    const before = previous.servers.find((item) => item.name === name);
    const preset = presets.find((item) => item.id === name);
    if (preset) {
      const incomingValues = fieldValues(server.field_values);
      const values: Record<string, string | readonly string[]> = {};
      for (const field of preset.fields) {
        const next = incomingValues[field.key];
        const kept = before?.field_values?.[field.key];
        const empty = next === undefined || (typeof next === "string" && next.trim() === "");
        const value = empty && field.kind === "secret" ? kept : next ?? kept;
        if (value !== undefined) values[field.key] = value;
      }
      return { name, preset: preset.id, enabled: server.enabled === true, field_values: values };
    }
    const args = Array.isArray(server.args) ? server.args : [];
    if (args.some((item) => typeof item !== "string")) throw new Error(`MCP_CONFIG_INVALID: ${name} 的参数必须是字符串数组`);
    const env = stringMap(server.env, `${name} 的环境变量`) ?? before?.env;
    const headers = stringMap(server.headers, `${name} 的请求头`) ?? before?.headers;
    const optional = (key: string) => typeof server[key] === "string" && (server[key] as string).trim() ? { [key]: (server[key] as string).trim() } : {};
    return {
      name,
      enabled: server.enabled === true,
      transport: typeof server.transport === "string" ? server.transport : "stdio",
      ...optional("command"),
      ...optional("script"),
      args: args as string[],
      ...optional("url"),
      ...(env ? { env } : {}),
      ...(headers ? { headers } : {}),
      ...optional("description"),
      ...optional("tool_prefix"),
      ...optional("server_type"),
      tags: Array.isArray(server.tags) ? server.tags.filter((tag): tag is string => typeof tag === "string") : [],
    };
  });
  return { servers: merged };
}

/** Every preset appears, saved or not; a preset not yet saved is off. */
export function withPresets(config: StoredMcpConfig, presets: readonly McpPreset[]): readonly StoredMcpServer[] {
  const unsaved = presets.filter((preset) => !config.servers.some((server) => server.name === preset.id));
  return [...config.servers, ...unsaved.map((preset) => ({ name: preset.id, preset: preset.id, enabled: false, field_values: {} }))];
}

const masked = (map: Readonly<Record<string, string>> | undefined) => ({ configured: Boolean(map && Object.keys(map).length > 0), count: map ? Object.keys(map).length : 0 });

/** What the settings page may see: no header, env or secret field values. */
export function configView(config: StoredMcpConfig, presets: readonly McpPreset[]): { servers: unknown[] } {
  return {
    servers: withPresets(config, presets).map((server) => {
      const preset = presets.find((item) => item.id === server.preset);
      if (preset) {
        const values = server.field_values ?? {};
        return {
          name: server.name,
          enabled: server.enabled,
          transport: preset.connections({}).at(0)?.transport ?? "streamable-http",
          description: preset.description,
          server_type: "preset",
          preset: {
            id: preset.id,
            title: preset.title,
            description: preset.description,
            fields: preset.fields.map((field) => ({ ...field, configured: isFilled(values[field.key]) })),
          },
          field_values: Object.fromEntries(preset.fields.filter((field) => field.kind !== "secret" && values[field.key] !== undefined).map((field) => [field.key, values[field.key]])),
        };
      }
      const { env, headers, ...rest } = server;
      return { ...rest, env: masked(env), headers: masked(headers) };
    }),
  };
}

function isFilled(value: string | readonly string[] | undefined): boolean {
  return typeof value === "string" ? value.trim() !== "" : Array.isArray(value) && value.length > 0;
}

/** The required fields a preset plugin still lacks, by label. */
export function missingFields(server: StoredMcpServer, preset: McpPreset): string[] {
  return preset.fields.filter((field) => field.required && !isFilled(server.field_values?.[field.key] ?? field.defaultValue)).map((field) => field.label);
}

/**
 * Where an enabled plugin connects. A preset decides from its fields; a custom
 * plugin uses its own command or URL. An `http` transport is Streamable HTTP.
 */
export function connectionsOf(server: StoredMcpServer, presets: readonly McpPreset[]): readonly McpConnectionSpec[] {
  const preset = presets.find((item) => item.id === server.preset);
  if (preset) {
    const missing = missingFields(server, preset);
    if (missing.length > 0) throw new Error(`MCP_PLUGIN_INCOMPLETE: 请先填写 ${missing.join("、")}`);
    return preset.connections(server.field_values ?? {});
  }
  const id = server.tool_prefix?.trim() || server.name;
  if (server.transport === "stdio" || !server.transport) {
    if (!server.command?.trim()) throw new Error("MCP_PLUGIN_INCOMPLETE: 请先填写启动命令");
    return [{ id, transport: "stdio", command: server.command.trim(), args: [...(server.script?.trim() ? [server.script.trim()] : []), ...(server.args ?? [])], env: { ...(server.env ?? {}) } }];
  }
  if (!server.url?.trim()) throw new Error("MCP_PLUGIN_INCOMPLETE: 请先填写 URL");
  return [{ id, transport: server.transport === "sse" ? "sse" : "streamable-http", url: server.url.trim(), headers: { ...(server.headers ?? {}) } }];
}
