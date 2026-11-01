/**
 * Data Agent API Client
 * 用于连接后端 FastAPI 服务，处理 REST API 和 SSE 流
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
export type DatabaseDriver = 'mysql' | 'postgres';

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

export type LLMConfigUpdate = {
    provider?: 'openai' | 'anthropic';
    api_key?: string;
    openai_api_key?: string;
    anthropic_api_key?: string;
    base_url?: string;
    openai_base_url?: string;
    model?: string;
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

export type LLMProfileUpdate = {
    id?: string;
    name?: string;
    provider: 'openai' | 'anthropic';
    model: string;
    base_url?: string;
    api_key_ref?: string;
    enabled?: boolean;
    is_default?: boolean;
};

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

export type DatabaseConnectionUpdate = DBConfigUpdate & {
    id?: string;
    name?: string;
    driver?: 'mysql';
};

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

export interface MCPConfigRequest {
    servers: MCPServerRequest[];
}

export interface MCPServerStatus extends MCPServerConfig {
    status?: 'disabled' | 'disconnected' | 'connected' | 'connecting' | 'error' | 'stopped';
    connected?: boolean;
    tool_count?: number;
    generation?: number;
    tool_prefix?: string;
    host_managed?: boolean;
}

export interface MCPEnabledUpdateResponse {
    status: string;
    server: MCPServerStatus;
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

export interface SkillListResponse {
    status: string;
    skills: SkillInfo[];
    total: number;
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
    status?: 'previewing' | 'ready' | 'error';
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

export async function listTasks(): Promise<{ tasks: ChatTask[] }> {
    const res = await apiFetch(`${API_BASE_URL}/tasks`);
    if (!res.ok) throw new Error('Failed to fetch tasks');
    return res.json();
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

export async function createTaskSession(taskId: string, session: { id: string; name?: string }): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/tasks/${encodeURIComponent(taskId)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
}

export async function listChatSessions(): Promise<{ sessions: ChatSession[] }> {
    const res = await apiFetch(`${API_BASE_URL}/sessions`);
    if (!res.ok) throw new Error('Failed to fetch sessions');
    return res.json();
}

export async function createChatSession(session: { id: string; name: string }): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
    });
    if (!res.ok) throw new Error('Failed to create session');
    return res.json();
}

export async function getChatSession(sessionId: string): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error('Failed to fetch session');
    return res.json();
}

export async function updateChatSessionName(sessionId: string, name: string): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error('Failed to update session');
    return res.json();
}

export async function saveChatTranscript(
    sessionId: string,
    messages: SessionSnapshotMessage[],
    attachedFiles?: string[],
    conversationVersion?: number,
): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/transcript`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            messages,
            attached_files: attachedFiles,
            conversation_version: conversationVersion,
        }),
    });
    if (!res.ok) throw new Error('Failed to save transcript');
    return res.json();
}

export async function saveSessionAttachedFiles(
    sessionId: string,
    attachedFiles: string[],
    conversationVersion?: number,
): Promise<void> {
    const res = await apiFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}/attached-files`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            attached_files: attachedFiles,
            conversation_version: conversationVersion,
        }),
    });
    if (!res.ok) throw new Error('Failed to save attached files');
}

export async function deleteChatSession(sessionId: string): Promise<void> {
    const res = await apiFetch(`${API_BASE_URL}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete session');
}

export async function prepareAgentSession(sessionId: string): Promise<void> {
    const res = await apiFetch(`${API_BASE_URL}/agent/sessions/${encodeURIComponent(sessionId)}/prepare`, {
        method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to prepare session');
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
    | { type: 'widget_patch'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string; tool_name: string; patch: Partial<WidgetSpec> }
    | { type: 'widget'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string; tool_name: string; widget: WidgetSpec }
    | { type: 'widget_done'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string }
    | { type: 'widget_remove'; session_id?: string; message_id: string; tool_call_id?: string; widget_id: string }
    | { type: 'widget_error'; session_id?: string; message_id: string; tool_call_id: string; widget_id: string; error: string }
    | { type: 'tool_result'; session_id?: string; message_id: string; tool_call_id: string; widget_id?: string | null; name: string; arguments?: unknown; content: string; details?: unknown; is_error?: boolean }
    | { type: 'clarification_request'; session_id?: string; clarification_id: string; question: string; options: string[] }
    | { type: 'clarification_settled'; session_id?: string; clarification_id: string; outcome: 'answered' | 'expired' | 'cancelled' }
    | { type: 'skill_activated'; session_id?: string; skill: SkillInfo & { source?: string; command_text?: string; granted_permissions?: string[]; model_override?: string | null; ui_message?: string } }
    | { type: 'workspace_updated'; session_id?: string; tool: string }
    | { type: 'error'; session_id?: string; error: string }
    | { type: 'done'; session_id?: string; run_id?: string; reason: 'completed' | 'stopped' | 'error' };

export async function clearSession(sessionId: string = 'default'): Promise<ChatSession> {
    const res = await apiFetch(`${API_BASE_URL}/agent/clear?session_id=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to clear session');
    return res.json();
}

export interface ChatStreamHandle {
    cancel: () => void;
    finished: Promise<void>;
}

export async function sendChatMessage(
    prompt: string,
    onEvent: (event: SSEEvent) => void,
    onError: (err: any) => void,
    onFinish: () => void,
    sessionId: string = 'default',
    attachedFiles: string[] = [],
): Promise<ChatStreamHandle> {
    const controller = new AbortController();

    const finished = (async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/agent/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ prompt, session_id: sessionId, attached_files: attachedFiles }),
                signal: controller.signal,
            });

            if (!response.ok) {
                let detail = `API error: ${response.status}`;
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

            if (!response.body) {
                throw new Error('No response body');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6).trim();
                    if (!dataStr) continue;

                    try {
                        const event = JSON.parse(dataStr) as SSEEvent;
                        onEvent(event);
                        if (event.type === 'done') {
                            onFinish();
                            return;
                        }
                    } catch (e) {
                        console.error('Failed to parse SSE event:', dataStr, e);
                    }
                }
            }

            onFinish();
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') {
                onFinish();
                return;
            }
            console.error('Chat error:', err);
            onError(err);
            onFinish();
        }
    })();

    return {
        cancel: () => controller.abort(),
        finished,
    };
}

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

export async function stopAgent(sessionId: string = 'default') {
    const response = await fetch(`${API_BASE_URL}/agent/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
    });
    if (!response.ok) {
        throw new Error('Failed to stop agent');
    }
    return response.json();
}

export async function steerAgent(prompt: string, sessionId: string = 'default') {
    const response = await fetch(`${API_BASE_URL}/agent/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, session_id: sessionId }),
    });
    if (!response.ok) {
        throw new Error('Failed to steer agent');
    }
    return response.json();
}


export async function getConfig(): Promise<AIConfig> {
    const res = await fetch(`${API_BASE_URL}/settings/config`);
    if (!res.ok) throw new Error('Failed to fetch config');
    return res.json();
}

export async function updateLLMConfig(data: LLMConfigUpdate) {
    const res = await fetch(`${API_BASE_URL}/settings/llm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update LLM config');
    return res.json();
}

export async function getLLMProfiles(): Promise<LLMProfilesResponse> {
    const res = await fetch(`${API_BASE_URL}/settings/llm/profiles`);
    if (!res.ok) throw new Error('Failed to fetch LLM profiles');
    return res.json();
}

export async function saveLLMProfile(data: LLMProfileUpdate): Promise<LLMProfile> {
    const res = await fetch(`${API_BASE_URL}/settings/llm/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to save LLM profile');
    return res.json();
}

export async function setDefaultLLMProfile(profileId: string): Promise<LLMProfile> {
    const res = await fetch(`${API_BASE_URL}/settings/llm/profiles/${encodeURIComponent(profileId)}/default`, {
        method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to set default LLM profile');
    return res.json();
}

export async function testLLMConfig(data: LLMConfigUpdate): Promise<{ success: boolean; message: string; details?: any }> {
    const res = await fetch(`${API_BASE_URL}/settings/llm/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to test LLM config');
    return res.json();
}

export async function updateDBConfig(data: DBConfigUpdate) {
    return saveDatabaseConnection('default-mysql', {
        name: 'Default MySQL',
        driver: 'mysql',
        ...data,
    });
}

export async function getDatabaseConnections(): Promise<DatabaseConnectionRegistry> {
    const res = await fetch(`${API_BASE_URL}/settings/connections`);
    if (!res.ok) throw new Error('Failed to fetch database connections');
    return res.json();
}

export async function saveDatabaseConnection(
    connectionId: string,
    data: DatabaseConnectionUpdate,
): Promise<DatabaseConnectionRegistry> {
    const res = await fetch(`${API_BASE_URL}/settings/connections/${encodeURIComponent(connectionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to save database connection');
    return result;
}

export async function deleteDatabaseConnection(connectionId: string): Promise<DatabaseConnectionRegistry> {
    const res = await fetch(`${API_BASE_URL}/settings/connections/${encodeURIComponent(connectionId)}`, {
        method: 'DELETE',
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to delete database connection');
    return result;
}

export async function setDefaultDatabaseConnection(connectionId: string): Promise<DatabaseConnectionRegistry> {
    const res = await fetch(`${API_BASE_URL}/settings/connections/${encodeURIComponent(connectionId)}/default`, {
        method: 'POST',
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to set default database connection');
    return result;
}

export async function testDBConnection(data: DatabaseConnectionUpdate) {
    const res = await fetch(`${API_BASE_URL}/settings/connections/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.detail || 'Failed to test database connection');
    return result;
}

export async function updatePythonRuntime(data: PythonRuntimeUpdate): Promise<{ status: string; runtime?: PythonRuntimeConfig; message?: string }> {
    const res = await fetch(`${API_BASE_URL}/settings/python-runtime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await res.json();
    if (result.status === 'error') throw new Error(result.message);
    return result;
}

export async function testPythonRuntime(data: PythonRuntimeUpdate): Promise<{ success: boolean; message: string; details?: any }> {
    const res = await fetch(`${API_BASE_URL}/settings/python-runtime/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to test Python runtime');
    return res.json();
}

export async function getMCPConfig(): Promise<MCPConfig> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/config`);
    if (!res.ok) throw new Error('Failed to fetch MCP config');
    return res.json();
}

export async function saveMCPConfig(data: MCPConfigRequest) {
    const res = await apiFetch(`${API_BASE_URL}/mcp/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to save MCP config');
    return res.json();
}

export async function getMCPServers(): Promise<{ status: string; servers: MCPServerStatus[] }> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/servers`);
    if (!res.ok) throw new Error('Failed to fetch MCP servers');
    return res.json();
}

export async function updateMCPServerEnabled(name: string, enabled: boolean): Promise<MCPEnabledUpdateResponse> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/servers/${encodeURIComponent(name)}/enabled`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
        let detail = 'Failed to update MCP server status';
        try {
            const payload = await res.json();
            if (payload?.detail) {
                detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail);
            }
        } catch {
            // ignore
        }
        throw new Error(detail);
    }
    return res.json();
}

export async function restartMCPServer(name: string): Promise<MCPEnabledUpdateResponse> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/servers/${encodeURIComponent(name)}/restart`, {
        method: 'POST',
    });
    if (!res.ok) {
        let detail = 'Failed to restart MCP server';
        try {
            const payload = await res.json();
            if (payload?.detail) {
                detail = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail);
            }
        } catch {
            // ignore
        }
        throw new Error(detail);
    }
    return res.json();
}

export async function getMCPTools(): Promise<{ status: string; tools: MCPToolInfo[] }> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/tools`);
    if (!res.ok) throw new Error('Failed to fetch MCP tools');
    return res.json();
}

export async function testMCPServer(data: MCPServerRequest): Promise<MCPTestResult> {
    const res = await apiFetch(`${API_BASE_URL}/mcp/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to test MCP server');
    return res.json();
}

export async function getSkills(): Promise<SkillListResponse> {
    const res = await fetch(`${API_BASE_URL}/agent/skills`);
    if (!res.ok) throw new Error('Failed to fetch skills');
    return res.json();
}

export interface WorkspaceFile {
    name: string;
    relative_path: string;
    size: number;
    modified_at: string;
}

export interface WorkspaceFilesResponse {
    files: WorkspaceFile[];
}

export async function getWorkspaceFiles(sessionId: string = ''): Promise<WorkspaceFilesResponse> {
    const url = sessionId
        ? `${API_BASE_URL}/workspace/files?session_id=${encodeURIComponent(sessionId)}`
        : `${API_BASE_URL}/workspace/files`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch workspace files');
    return res.json();
}

export function getWorkspaceFileDownloadUrl(relativePath: string): string {
    const token = getAuthToken();
    const authSuffix = token ? `&access_token=${encodeURIComponent(token)}` : '';
    return `${API_BASE_URL}/workspace/files/download?path=${encodeURIComponent(relativePath)}${authSuffix}`;
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

export async function deleteWorkspaceFile(relativePath: string): Promise<void> {
    const res = await fetch(`${API_BASE_URL}/workspace/files?path=${encodeURIComponent(relativePath)}`, {
        method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to delete file');
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

export interface KnowledgeListResponse {
    status: string;
    files: KnowledgeFile[];
    total: number;
}

export interface KnowledgeContentResponse {
    status: string;
    content: string;
    path: string;
    name: string;
}

export async function getKnowledgeFiles(): Promise<KnowledgeListResponse> {
    const res = await fetch(`${API_BASE_URL}/knowledge/files`);
    if (!res.ok) throw new Error('Failed to fetch knowledge files');
    return res.json();
}

export async function getKnowledgeContent(path: string): Promise<KnowledgeContentResponse> {
    const res = await fetch(`${API_BASE_URL}/knowledge/content?path=${encodeURIComponent(path)}`);
    if (!res.ok) throw new Error('Failed to fetch knowledge content');
    return res.json();
}

export async function saveKnowledgeContent(path: string, content: string): Promise<{ status: string; message: string }> {
    const res = await fetch(`${API_BASE_URL}/knowledge/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
    });
    if (!res.ok) throw new Error('Failed to save knowledge content');
    return res.json();
}

export interface DashboardRuntimeEvaluateRequest {
    requestId: string;
    dashboard: string;
    parameters: Record<string, unknown>;
    changed: string[] | null;
}

export interface DashboardRuntimeEvaluateResponse {
    requestId: string;
    parameters: Record<string, unknown>;
    data: Record<string, { rows: Array<Record<string, unknown>>; totalRows: number; fingerprint?: string }>;
    errors: Record<string, { code: string; message: string }>;
}

export async function evaluateDashboardRuntime(
    payload: DashboardRuntimeEvaluateRequest,
    signal?: AbortSignal,
): Promise<DashboardRuntimeEvaluateResponse> {
    const res = await apiFetch(`${API_BASE_URL}/dashboard-runtime/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = body?.detail;
        const message = typeof detail === 'string'
            ? detail
            : detail?.message || detail?.error?.message || 'Dashboard refresh failed';
        throw new Error(message);
    }
    return body as DashboardRuntimeEvaluateResponse;
}
