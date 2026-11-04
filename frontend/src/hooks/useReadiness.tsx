import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createSampleDatabaseViaRuntime, getConfigViaRuntime, testDbViaRuntime, testLlmViaRuntime } from '../api/runtime-client';
import type { SettingsSection } from '../components/SettingsPanel';

/** One setup step: unknown while it is being checked, then done or not. */
export type StepState = 'checking' | 'ready' | 'missing';

export interface ProbeResult {
    readonly success: boolean;
    readonly message: string;
}

export interface Readiness {
    readonly model: StepState;
    readonly database: StepState;
    /** Why the saved database did not connect; absent when none is configured yet. */
    readonly databaseProblem?: string;
    /** How many steps are still missing. */
    readonly remaining: number;
    /** True once both steps are done; the chat page then offers its example questions. */
    readonly ready: boolean;
    recheck(): void;
    /** Sends a one-token request through the model a chat would use now. */
    testModel(): Promise<ProbeResult>;
    /** Creates the demo sales database and connects to it. */
    connectSampleDatabase(): Promise<ProbeResult>;
    openSettings(section: SettingsSection): void;
}

/** Outside a provider (tests, embedded views) everything counts as set up, so nothing is gated. */
const ASSUME_READY: Readiness = {
    model: 'ready',
    database: 'ready',
    remaining: 0,
    ready: true,
    recheck: () => undefined,
    testModel: async () => ({ success: true, message: '' }),
    connectSampleDatabase: async () => ({ success: true, message: '' }),
    openSettings: () => undefined,
};

const ReadinessContext = createContext<Readiness>(ASSUME_READY);

/** Whether a usable model key is stored; the runtime makes the final call when a chat starts. */
export async function readModelConfigured(config: Record<string, unknown>): Promise<boolean> {
    const storedSecrets = await window.dataAgent?.getStoredSecrets();
    return config.llm_enabled !== false && [
        config.api_key,
        config.openai_api_key,
        config.anthropic_api_key,
        storedSecrets?.openai_api_key,
        storedSecrets?.anthropic_api_key,
    ].some((value) => typeof value === 'string' && value.trim().length > 0);
}

/** A saved connection counts only when it actually answers; an untouched form is not one. */
async function readDatabase(config: Record<string, unknown>): Promise<{ state: StepState; problem?: string }> {
    const filled = (value: unknown) => typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
    if (!filled(config.driver) && !filled(config.database) && !filled(config.host)) return { state: 'missing' };
    const result = await testDbViaRuntime({
        driver: config.driver ?? 'mysql',
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
    });
    return result.success ? { state: 'ready' } : { state: 'missing', problem: result.message };
}

export function ReadinessProvider({ children, onOpenSettings, modelMissingSignal }: {
    children: ReactNode;
    onOpenSettings: (section: SettingsSection) => void;
    /** Bumped when a chat is refused for lack of a model, so the step un-ticks at once. */
    modelMissingSignal?: number;
}) {
    const [model, setModel] = useState<StepState>('checking');
    const [database, setDatabase] = useState<{ state: StepState; problem?: string }>({ state: 'checking' });
    const generation = useRef(0);

    const recheck = useCallback(() => {
        const current = ++generation.current;
        void (async () => {
            try {
                const config = await getConfigViaRuntime();
                const configured = await readModelConfigured(config);
                if (current === generation.current) setModel(configured ? 'ready' : 'missing');
                const db = await readDatabase(config);
                if (current === generation.current) setDatabase(db);
            } catch (error) {
                console.error('Setup check failed:', error);
                if (current === generation.current) {
                    setModel((state) => state === 'checking' ? 'missing' : state);
                    setDatabase((state) => state.state === 'checking' ? { state: 'missing' } : state);
                }
            }
        })();
    }, []);

    useEffect(() => { recheck(); }, [recheck]);
    useEffect(() => {
        if (modelMissingSignal) setModel('missing');
    }, [modelMissingSignal]);

    const testModel = useCallback(async (): Promise<ProbeResult> => {
        try {
            const result = await testLlmViaRuntime({});
            return { success: result.success, message: result.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }, []);

    const connectSampleDatabase = useCallback(async (): Promise<ProbeResult> => {
        try {
            const result = await createSampleDatabaseViaRuntime();
            recheck();
            return result;
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }
    }, [recheck]);

    const value = useMemo<Readiness>(() => {
        const remaining = [model, database.state].filter((state) => state === 'missing').length;
        return {
            model,
            database: database.state,
            ...(database.problem ? { databaseProblem: database.problem } : {}),
            remaining,
            ready: model === 'ready' && database.state === 'ready',
            recheck,
            testModel,
            connectSampleDatabase,
            openSettings: onOpenSettings,
        };
    }, [database, model, onOpenSettings, recheck, testModel, connectSampleDatabase]);

    return <ReadinessContext.Provider value={value}>{children}</ReadinessContext.Provider>;
}

export function useReadiness(): Readiness {
    return useContext(ReadinessContext);
}
