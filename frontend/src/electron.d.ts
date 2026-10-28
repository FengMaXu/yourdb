export interface StoredLLMSecrets {
    openai_api_key?: string;
    anthropic_api_key?: string;
    default_model?: string;
    openai_base_url?: string;
}

export interface DataAgentRuntimeBridge {
    invokeRuntimeCommand: (envelope: unknown) => Promise<unknown>;
    subscribeRuntimeEvents: (listener: (event: unknown) => void, sessionId?: string) => () => void;
}

export interface DataAgentDesktopBridge {
    backendPort?: number;
    getBackendPort: () => Promise<number | null>;
    getStoredSecrets: () => Promise<StoredLLMSecrets>;
    saveSecrets: (secrets: StoredLLMSecrets) => Promise<{ ok: boolean }>;
    checkForUpdates: () => Promise<unknown>;
    downloadUpdate: () => Promise<unknown>;
    quitAndInstallUpdate: () => Promise<unknown>;
    selectPythonExecutable: () => Promise<string | null>;
    uploadWorkspaceFile: (payload: { fileName: string; bytes: Uint8Array; sessionId?: string }) => Promise<{ filename: string; session_id: string; relative_path: string; size: number }>;
    onUpdateEvent: (callback: (event: unknown) => void) => () => void;
}

declare global {
    interface Window {
        __PORT__?: number;
        dataAgent?: DataAgentDesktopBridge;
        dataAgentRuntime?: DataAgentRuntimeBridge;
    }
}

export {};
