/**
 * HTTP client for the Web Host: authentication, uploads, publications and the
 * chat event stream, plus the wire types the renderer shares with them.
 */

import type { SubagentChildProgress } from '@data-agent/contracts';

const ENV_API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();

function resolveApiBaseUrl(): string {
    if (ENV_API_BASE_URL) {
        return ENV_API_BASE_URL.replace(/\/$/, '');
    }

    if (typeof window !== 'undefined') {
        const injectedPort = window.__PORT__ ?? window.dataAgent?.backendPort;
        if (injectedPort) {
            return `http://127.0.0.1:${injectedPort}`;
        }

        // Served by the Web Host itself (or any same-origin reverse proxy):
        // use same-origin relative URLs so the app works on any port.
        const { origin, hostname } = window.location;
        if (origin && origin !== 'null' && hostname) {
            return origin;
        }
    }

    return '';
}

export const API_BASE_URL = resolveApiBaseUrl();
const AUTH_TOKEN_STORAGE_KEY = 'data-agent:auth-token';
const nativeFetch = globalThis.fetch.bind(globalThis);

export function getAuthToken(): string {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '';
}

export function setAuthToken(token: string) {
    if (typeof window === 'undefined') return;
    if (token) {
        window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
        window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = getAuthToken();
    const headers = new Headers(init.headers || {});
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    return nativeFetch(input, { ...init, headers });
}

if (typeof window !== 'undefined') {
    window.fetch = apiFetch;
}

export interface AuthUser {
    id: string;
    username: string;
    display_name: string;
}

export interface AuthStatus {
    authenticated: boolean;
    registration_open: boolean;
    user: AuthUser | null;
}

export interface AuthResponse {
    token: string;
    expires_at: number;
    user: AuthUser;
}

export async function getAuthStatus(): Promise<AuthStatus> {
    const res = await apiFetch(`${API_BASE_URL}/auth/status`);
    if (!res.ok) throw new Error('Failed to fetch auth status');
    return res.json();
}

export async function login(username: string, password: string): Promise<AuthResponse> {
    const res = await apiFetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.detail || 'Login failed');
    }
    const payload = await res.json();
    setAuthToken(payload.token);
    return payload;
}

export async function register(username: string, password: string, displayName?: string): Promise<AuthResponse> {
    const res = await apiFetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, display_name: displayName }),
    });
    if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.detail || 'Registration failed');
    }
    const payload = await res.json();
    setAuthToken(payload.token);
    return payload;
}

export async function logout(): Promise<void> {
    await apiFetch(`${API_BASE_URL}/auth/logout`, { method: 'POST' });
    setAuthToken('');
}

/** Databases the product connects to; each runs through its own contract MCP server. */
export type DatabaseDriver = 'mysql' | 'postgres' | 'sqlite';

export interface AIConfig {
    provider?: 'openai' | 'anthropic';
    llm_enabled?: boolean;
    model?: string;
    api_key?: string;
    base_url?: string;
    driver?: DatabaseDriver;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connections?: DatabaseConnectionRegistry;
    python_runtime?: PythonRuntimeConfig;
    llm_profiles?: LLMProfilesResponse;
}

export interface PythonRuntimeConfig {
    mode: 'bundled' | 'external';
    executable?: string;
    label?: string;
}

export type PythonRuntimeUpdate = {
    mode: 'bundled' | 'external';
    executable?: string;
};

export interface LLMProfile {
    id: string;
    name: string;
    provider: 'openai' | 'anthropic';
    model: string;
    base_url?: string;
    api_key_ref?: string;
    enabled: boolean;
    is_default: boolean;
    api_key_configured?: boolean;
}

export interface LLMProfilesResponse {
    default_profile_id: string;
    profiles: LLMProfile[];
}

export type DBConfigUpdate = {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
};

export interface DatabaseConnection {
    id: string;
    name: string;
    driver: 'mysql';
    host: string;
    port: number;
    user: string;
    database: string;
    password_configured: boolean;
}

export interface DatabaseConnectionRegistry {
    default_connection_id: string | null;
    connections: DatabaseConnection[];
}

export interface MCPMappingSummary {
    configured: boolean;
    count: number;
    safe_keys?: string[];
}

export interface MCPPresetField {
    key: string;
    label: string;
    kind: 'text' | 'secret' | 'choices';
    required: boolean;
    placeholder?: string;
    help?: string;
    /** Where the user gets the value, such as an API key page. */
    link?: { label: string; url: string };
    choices?: { value: string; label: string; detail?: string }[];
    defaultValue?: string[];
    /** Whether a value is saved; secret values themselves are never sent to the page. */
    configured?: boolean;
}

/** A plugin yourdb ships ready to configure; the user fills in its fields. */
export interface MCPPreset {
    id: string;
    title: string;
    description: string;
    fields: MCPPresetField[];
}

export interface MCPServerConfig {
    name: string;
    transport: 'stdio' | 'http' | 'sse' | 'streamable-http';
    enabled: boolean;
    command?: string;
    script?: string;
    args?: string[];
    args_input?: string;
    url?: string;
    headers?: MCPMappingSummary;
    env?: MCPMappingSummary;
    env_input?: string;
    headers_input?: string;
    description?: string;
    tool_prefix?: string;
    server_type?: string;
    tags?: string[];
    preset?: MCPPreset;
    /** Run and configured by yourdb elsewhere, such as the database; listed but not edited here. */
    host_managed?: boolean;
    default_enabled?: boolean;
    /** Where a host-managed server is configured. */
    settings_hint?: string;
    field_values?: Record<string, string | string[]>;
    /** Secrets typed on this page and not yet saved. */
    field_inputs?: Record<string, string>;
}

export interface MCPConfig {
    servers: MCPServerConfig[];
}

export type MCPServerRequest = Omit<MCPServerConfig, 'headers' | 'env' | 'args_input'> & {
    headers?: Record<string, string>;
    env?: Record<string, string>;
};

export interface MCPServerStatus extends MCPServerConfig {
    status?: 'disabled' | 'disconnected' | 'connected' | 'connecting' | 'error' | 'stopped';
    connected?: boolean;
    tool_count?: number;
    generation?: number;
    tool_prefix?: string;
    host_managed?: boolean;
}

export interface MCPToolInfo {
    server: string;
    server_type: string;
    name: string;
    remote_name: string;
    description: string;
    parameters: any;
}

export interface MCPTestResult {
    success: boolean;
    message: string;
    tools?: MCPToolInfo[];
    server?: MCPServerConfig;
}

export interface SkillInfo {
    name: string;
    description: string;
    when_to_use?: string;
    location: string;
    skill_dir: string;
    source_scope: 'project' | 'global' | string;
    allowed_tools?: string[];
    model?: string | null;
}

export interface WidgetSpec {
    widget_id: string;
    kind: 'kpi' | 'metric_cards' | 'table' | 'chart' | 'steps' | 'rich_text' | 'echarts' | 'file_link';
    title: string;
    subtitle?: string;
    data?: any[];
    value?: string | number;
    label?: string;
    series?: any[];
    columns?: any[];
    actions?: any[];
    metadata?: Record<string, any>;
    raw_html?: string;
    raw_svg?: string;
    config?: Record<string, any>;
    drill_context?: {
        dimension: string;
        value: string | number;
        path: string[];
    };
    file_path?: string;
    download_url?: string;
    file_type?: string;
    status?: 'ready' | 'error';
    error?: string;
    tool_call_id?: string;
    message_id?: string;
    session_id?: string;
}

export interface SessionSnapshotSkillActivation {
    name: string;
    description?: string;
    when_to_use?: string;
    location?: string;
    skill_dir?: string;
    source_scope?: string;
    granted_permissions?: string[];
    model_override?: string | null;
    ui_message?: string;
    source?: string;
    command_text?: string;
}

export type AgentProgressStage =
    | 'sent'
    | 'understanding'
    | 'selecting_tool'
    | 'executing_query'
    | 'generating_answer';

export type AgentTerminalReason = 'completed' | 'stopped' | 'error' | null;

export interface SessionSnapshotAgentToolCall {
    toolCallId: string;
    name: string;
    arguments: any;
    partialArguments?: string;
    result?: string;
    details?: any;
    isError?: boolean;
    widgetId?: string | null;
    status: 'calling' | 'running' | 'done' | 'error';
}

export interface SessionSnapshotMessage {
    id: string;
    role: 'user' | 'agent';
    content: string;
    /** Workspace paths attached to a user message. */
    attachments?: string[];
    reasoningContent?: string;
    messageId?: string;
    toolCallsById?: Record<string, SessionSnapshotAgentToolCall>;
    widgetsById?: Record<string, WidgetSpec>;
    skillActivations?: SessionSnapshotSkillActivation[];
    currentStage?: AgentProgressStage;
    visitedStages?: AgentProgressStage[];
    terminalReason?: AgentTerminalReason;
}

export interface ChatSession {
    id: string;
    task_id: string;
    name: string;
    started_at?: number | null;
    created_at: number;
    updated_at: number;
    attached_files: string[];
    conversation_version: number;
    messages?: SessionSnapshotMessage[];
    status?: 'success' | 'ignored';
    reason?: string;
}

export interface ChatTask {
    id: string;
    name: string;
    created_at: number;
    updated_at: number;
    sessions?: ChatSession[];
}

export async function createTask(task: { id: string; name: string }): Promise<ChatTask> {
    const res = await apiFetch(`${API_BASE_URL}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(task),
    });
    if (!res.ok) throw new Error('Failed to create task');
    return res.json();
}

export async function updateTaskName(taskId: string, name: string): Promise<ChatTask> {
    const res = await apiFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to update task');
    return res.json();
}

export async function deleteTask(taskId: string): Promise<void> {
    const res = await apiFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete task');
}

export interface ClarificationRequest {
    clarification_id: string;
    question: string;
    options: string[];
}
export type SSEEvent =
    | { type: 'run_start'; session_id?: string; run_id: string }
    | { type: 'status'; session_id?: string; run_id?: string; phase: 'preparing' | 'calling_model' | 'running_tool' | 'generating_answer'; message?: string }
    | { type: 'message_start'; session_id?: string; message_id: string }
    | { type: 'progress'; session_id?: string; stage: Exclude<AgentProgressStage, 'sent'> }
    | { type: 'auto_retry'; session_id?: string; operation: string; attempt: number; max_attempts: number; delay_seconds: number; reason: string }
    | { type: 'text_delta'; session_id?: string; message_id?: string; content: string; ephemeral?: boolean }
    | { type: 'reasoning_delta'; session_id?: string; message_id: string; content: string }
    | { type: 'tool_call'; session_id?: string; message_id: string; tool_call_id: string; widget_id?: string | null; name: string; arguments: unknown }
    | { type: 'tool_progress'; session_id?: string; message_id: string; tool_call_id: string; name: string; phase: 'validating_sql' | 'running_query' | 'running' | 'done' | 'error'; elapsed_ms?: number | null }
    | { type: 'subagent_progress'; session_id?: string; message_id: string; tool_call_id: string; name: string; children: SubagentChildProgress[] }
    | { type: 'widget'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string; tool_name: string; widget: WidgetSpec }
    | { type: 'widget_done'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string }
    | { type: 'widget_error'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string; error: string }
    | { type: 'tool_result'; session_id?: string; message_id: string; tool_call_id: string; widget_id?: string | null; name: string; arguments?: unknown; content: string; details?: unknown; is_error?: boolean }
    | { type: 'clarification_request'; session_id?: string; clarification_id: string; question: string; options: string[] }
    | { type: 'clarification_settled'; session_id?: string; clarification_id: string; outcome: 'answered' | 'expired' | 'cancelled' }
    | { type: 'skill_activated'; session_id?: string; skill: SkillInfo & { source?: string; command_text?: string; granted_permissions?: string[]; model_override?: string | null; ui_message?: string } }
    | { type: 'workspace_updated'; session_id?: string; tool: string }
    | { type: 'error'; session_id?: string; error: string }
    | { type: 'done'; session_id?: string; run_id?: string; reason: 'completed' | 'stopped' | 'error' };

export async function answerClarification(
    clarificationId: string,
    answer: string,
    sessionId: string = 'default',
) {
    const response = await fetch(`${API_BASE_URL}/agent/clarification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clarification_id: clarificationId, answer, session_id: sessionId }),
    });
    if (!response.ok) {
        let detail = 'Failed to submit clarification answer';
        try {
            const payload = await response.json();
            if (payload?.detail) {
                detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail);
            }
        } catch {
            // ignore
        }
        throw new Error(detail);
    }
    return response.json();
}

export async function getConfig(): Promise<AIConfig> {
    const res = await fetch(`${API_BASE_URL}/settings/config`);
    if (!res.ok) throw new Error('Failed to fetch config');
    return res.json();
}

export interface WorkspaceUploadResponse {
    filename: string;
    session_id: string;
    relative_path: string;
    size: number;
}

export async function uploadWorkspaceFile(file: File, sessionId: string = ''): Promise<WorkspaceUploadResponse> {
    if (window.dataAgent?.uploadWorkspaceFile) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        return window.dataAgent.uploadWorkspaceFile({ fileName: file.name, bytes, sessionId });
    }

    const formData = new FormData();
    formData.append('file', file);
    const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
    const res = await apiFetch(`${API_BASE_URL}/api/workspace/upload${query}`, {
        method: 'POST',
        body: formData,
    });
    if (!res.ok) throw new Error('Failed to upload file');
    return res.json();
}

export interface KnowledgeFile {
    name: string;
    path: string;
    size: number;
    modified_at: string;
    type: 'file' | 'directory';
    /** Catalog name and description from the document's frontmatter. */
    title?: string;
    description?: string;
    knowledgeId?: string;
    /** Built-in document shipped with the application; it cannot be edited. */
    readOnly?: boolean;
    /** False for a placeholder with frontmatter but no content yet. */
    hasContent?: boolean;
}

