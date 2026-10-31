/** How to reach one MCP server process or endpoint. */
export type McpConnectionSpec =
  | { readonly id: string; readonly transport: "stdio"; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }
  | { readonly id: string; readonly transport: "streamable-http" | "sse"; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export interface McpPresetField {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "secret" | "choices";
  readonly required: boolean;
  readonly placeholder?: string;
  readonly help?: string;
  /** Where the user gets the value, such as an API key page. */
  readonly link?: { readonly label: string; readonly url: string };
  readonly choices?: readonly { readonly value: string; readonly label: string; readonly detail?: string }[];
  /** Used when the user has not chosen; only for choices. */
  readonly defaultValue?: readonly string[];
}

export type McpPresetValues = Readonly<Record<string, string | readonly string[]>>;

/**
 * A plugin yourdb ships ready to configure. The user supplies the fields
 * (keys, paths); the preset owns where and how to connect.
 */
export interface McpPreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly fields: readonly McpPresetField[];
  /** The connections for these values; one plugin may reach several servers. */
  connections(values: McpPresetValues): readonly McpConnectionSpec[];
}

const text = (values: McpPresetValues, key: string): string => {
  const value = values[key];
  return typeof value === "string" ? value.trim() : "";
};

const list = (values: McpPresetValues, key: string, fallback: readonly string[]): readonly string[] => {
  const value = values[key];
  return Array.isArray(value) ? value : fallback;
};

/** 企查查智能体数据平台 (agent.qcc.com/guide): one Streamable HTTP server per data group, Bearer API key. */
const QCC_GROUPS = [
  { value: "company", label: "企业信息", detail: "工商登记、股东、对外投资" },
  { value: "risk", label: "风险信息", detail: "失信、被执行、裁判文书" },
  { value: "operation", label: "经营信息", detail: "招投标、资质、税务" },
  { value: "ipr", label: "知识产权", detail: "专利、商标、著作权" },
  { value: "executive", label: "董监高", detail: "董事、监事、高管的风险与任职" },
  { value: "history", label: "历史工商", detail: "历史登记与股东变更，需企业实名认证" },
  { value: "tender", label: "招标标讯", detail: "招标查查的招投标公告" },
] as const;
const DEFAULT_QCC_GROUPS = ["company", "risk", "operation", "ipr"];

export const QCC_PRESET: McpPreset = {
  id: "qcc",
  title: "企查查",
  description: "查询企业工商、风险、经营与知识产权信息，用于补充数据库中的企业名单。需要企查查智能体数据平台的 API Key。",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      kind: "secret",
      required: true,
      placeholder: "Bearer 开头的 API Key，原样粘贴即可",
      help: "在 agent.qcc.com 注册登录后，于个人中心复制 API Key，带不带 Bearer 前缀都可以。按调用计费，费用由该 Key 所属账户承担。",
      link: { label: "获取 API Key", url: "https://agent.qcc.com/profile/api-key" },
    },
    { key: "groups", label: "数据分组", kind: "choices", required: true, choices: QCC_GROUPS, defaultValue: DEFAULT_QCC_GROUPS },
  ],
  connections(values) {
    // The platform shows the key as a header value: users paste it whole, prefix included, and it is sent once.
    const apiKey = text(values, "apiKey").replace(/^bearer\s+/i, "");
    const known = new Set<string>(QCC_GROUPS.map((group) => group.value));
    return list(values, "groups", DEFAULT_QCC_GROUPS).filter((group) => known.has(group)).map((group) => ({
      id: `qcc_${group}`,
      transport: "streamable-http" as const,
      url: `https://agent.qcc.com/mcp/${group}/stream`,
      headers: { Authorization: `Bearer ${apiKey}` },
    }));
  },
};

export const DEFAULT_MCP_PRESETS: readonly McpPreset[] = [QCC_PRESET];

/**
 * A server the host runs and configures elsewhere, listed with the plugins so
 * the user sees it and its connection; the plugin settings cannot change it.
 */
export interface McpHostServer {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Where the user configures it. */
  readonly settingsHint: string;
  readonly toolCount: number;
  /** Resolves when the server answers; rejects with the reason it does not. */
  check(): Promise<void>;
}

/** The database contract MCP server (execute_query_preview, execute_query_export, explain_query, get_schema). */
export function databaseHostServer(check: () => Promise<void>): McpHostServer {
  return {
    name: "database",
    title: "数据库",
    description: "连接业务数据库（MySQL、PostgreSQL），供数据查询使用。",
    settingsHint: "在「设置 → 数据库」中配置",
    toolCount: 4,
    check,
  };
}

/** A JSON object of strings, as env and headers are written in the settings page. */
export function parseStringMap(raw: string, label: string): Record<string, string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`MCP_CONFIG_INVALID: ${label} 不是合法的 JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`MCP_CONFIG_INVALID: ${label} 必须是字符串键值对`);
  }
  return parsed as Record<string, string>;
}
