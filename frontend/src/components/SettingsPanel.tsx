import React, { useEffect, useState } from 'react';
import { UI } from './workspace-ui';
import { cn } from '@/lib/utils';
import ChannelsSettings from './ChannelsSettings';
import {
    Settings as SettingsIcon,
    User, Link, Eye, ExternalLink, Loader2, Terminal, Database
} from 'lucide-react';
import { Cloud, KeyRound, Usb } from 'lucide-react';
import {
    type AIConfig,
    type DatabaseDriver,
    type PythonRuntimeConfig,
    type PythonRuntimeUpdate,
} from '../api/client';
import { getConfigViaRuntime, saveConfigViaRuntime, testDbViaRuntime, testPythonRuntimeViaRuntime } from '../api/runtime-client';
import { useLanguage } from '../context/LanguageContext';

/** Server databases; SQLite is a file and has no host, port or user. */
type ServerDatabaseDriver = Exclude<DatabaseDriver, 'sqlite'>;

const DB_DRIVER_DEFAULTS: Record<ServerDatabaseDriver, { port: number; user: string }> = {
    mysql: { port: 3306, user: 'root' },
    postgres: { port: 5432, user: 'postgres' },
};

const DB_DRIVERS: readonly DatabaseDriver[] = ['mysql', 'postgres', 'sqlite'];

export type SettingsSection = 'model' | 'database' | 'environment' | 'channels';

const SECTION_MENU: Record<SettingsSection, string> = {
    model: '模型',
    database: '数据库',
    environment: '环境',
    channels: '消息渠道',
};

interface SettingsPanelProps {
    section: SettingsSection;
}

/** Settings shown in the main pane; the sidebar picks the section. */
/** A settings sub-page (database, environment): no card around it, one centred column. */
const SUB_PAGE = 'mx-auto w-full max-w-[640px] pt-2';

const SettingsPanel: React.FC<SettingsPanelProps> = ({ section }) => {
    const { t } = useLanguage();
    const activeMenu = SECTION_MENU[section];

    const [modelProvider, setModelProvider] = useState('模型设置');
    const [showPassword, setShowPassword] = useState(false);

    const PROVIDER_REGISTRY: Record<string, { label: string; letter: string; baseUrl: string; models: string[]; apiKeyUrl: string }> = {
        'DeepSeek':    { letter: 'D', label: 'DeepSeek',               baseUrl: 'https://api.deepseek.com',                   models: ['deepseek-chat', 'deepseek-reasoner'],                                                              apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
        'OpenAI':      { letter: 'O', label: 'OpenAI',                 baseUrl: 'https://api.openai.com/v1',                  models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini', 'o3-mini'],                               apiKeyUrl: 'https://platform.openai.com/api-keys' },
        'Anthropic':   { letter: 'A', label: 'Anthropic',              baseUrl: 'https://api.anthropic.com/v1',               models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022', 'claude-3-opus-20240229'],                   apiKeyUrl: 'https://console.anthropic.com/settings/keys' },
        'Google':      { letter: 'G', label: 'Google',                 baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],                                     apiKeyUrl: 'https://aistudio.google.com/apikey' },
        'Qwen':        { letter: 'Q', label: 'Qwen (阿里巴巴)',        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],                                         apiKeyUrl: 'https://bailian.console.aliyun.com/' },
        'Z-AI':        { letter: 'Z', label: 'Z-AI / GLM (智谱AI)',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',       models: ['glm-4-plus', 'glm-4-flash', 'glm-4-long', 'glm-4'],                                               apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
        'Moonshot AI': { letter: 'M', label: 'Moonshot AI',            baseUrl: 'https://api.moonshot.cn/v1',                 models: ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k'],                                           apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys' },
        'MiniMax':     { letter: 'M', label: 'MiniMax',                baseUrl: 'https://api.minimax.chat/v1',                models: ['MiniMax-M1', 'abab6.5s-chat', 'abab5.5-chat'],                                                     apiKeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
        'xAI':         { letter: 'X', label: 'xAI',                    baseUrl: 'https://api.x.ai/v1',                       models: ['grok-3', 'grok-3-mini', 'grok-2'],                                                                 apiKeyUrl: 'https://console.x.ai/' },
        'SiliconFlow': { letter: 'S', label: 'SiliconFlow (硅基流动)',  baseUrl: 'https://api.siliconflow.cn/v1',              models: ['Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'],                      apiKeyUrl: 'https://cloud.siliconflow.cn/account/ak' },
    };
    const providerIds = Object.keys(PROVIDER_REGISTRY);

    const detectActiveProvider = (baseUrl: string | undefined, provider?: string): string | null => {
        if (provider === 'anthropic') return 'Anthropic';
        if (baseUrl) {
            for (const [id, reg] of Object.entries(PROVIDER_REGISTRY)) {
                if (baseUrl.startsWith(reg.baseUrl) || reg.baseUrl.startsWith(baseUrl)) return id;
            }
        }
        if (provider === 'openai') return 'OpenAI';
        return null;
    };

    const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

    const providers = providerIds.map(id => ({ id, ...PROVIDER_REGISTRY[id] }));

    type ProviderConfig = {
        apiKey: string;
        baseUrl: string;
        models: string[]; // Built-in + custom
        selectedModel: string;
        enabled: boolean;
    };

    const persistProviderPreference = (id: string, providerConfig: ProviderConfig) => {
        const { apiKey, ...safeConfig } = providerConfig;
        void apiKey;
        localStorage.setItem(`provider_config_${id}`, JSON.stringify(safeConfig));
    };

    // Keep independent config for each provider
    const [providerConfigs, setProviderConfigs] = useState<Record<string, ProviderConfig>>(() => {
        const initial: Record<string, ProviderConfig> = {};
        for (const [id, reg] of Object.entries(PROVIDER_REGISTRY)) {
            // Load from localStorage if present to remember user inputs when switching tabs
            const saved = localStorage.getItem(`provider_config_${id}`);
            if (saved) {
                try {
                    initial[id] = { ...JSON.parse(saved), apiKey: '' };
                    // Ensure models array exists
                    if (!initial[id].models) {
                        initial[id].models = [...reg.models];
                    }
                    continue;
                } catch {
                    // Ignore malformed local preferences and use the provider defaults.
                }
            }
            initial[id] = {
                apiKey: '',
                baseUrl: reg.baseUrl,
                models: [...reg.models],
                selectedModel: reg.models[0],
                enabled: false
            };
        }
        return initial;
    });

    // Save individual provider config to localStorage when it changes
    const updateProviderConfig = (id: string, updates: Partial<ProviderConfig>) => {
        setProviderConfigs(prev => {
            const next = { ...prev, [id]: { ...prev[id], ...updates } };
            persistProviderPreference(id, next[id]);
            return next;
        });
    };

    // Config states
    const [config, setConfig] = useState<AIConfig | null>(null);
    const [isSavingLLM, setIsSavingLLM] = useState(false);

    // DB states
    const [dbDriver, setDbDriver] = useState<DatabaseDriver>('mysql');
    // The network fields keep the last server driver's defaults while SQLite is chosen.
    const [serverDriver, setServerDriver] = useState<ServerDatabaseDriver>('mysql');
    const [dbHost, setDbHost] = useState('localhost');
    const [dbPort, setDbPort] = useState(DB_DRIVER_DEFAULTS.mysql.port);
    const [dbUser, setDbUser] = useState(DB_DRIVER_DEFAULTS.mysql.user);
    const [dbPassword, setDbPassword] = useState('');
    const [dbName, setDbName] = useState('');
    // A SQLite file is not a database name: each keeps its own value while the other driver is chosen.
    const [dbFile, setDbFile] = useState('');
    const [isTestingDB, setIsTestingDB] = useState(false);
    const [isSavingDB, setIsSavingDB] = useState(false);
    const [dbTestResult, setDbTestResult] = useState<{ success: boolean, message: string } | null>(null);

    const [pythonRuntime, setPythonRuntime] = useState<PythonRuntimeConfig>({ mode: 'bundled' });
    const [pythonExecutable, setPythonExecutable] = useState('');
    const [isTestingPython, setIsTestingPython] = useState(false);
    const [isSavingPython, setIsSavingPython] = useState(false);
    const [pythonTestResult, setPythonTestResult] = useState<{ success: boolean, message: string } | null>(null);


    useEffect(() => {
        const loadInitialData = async () => {
            try {
                const initialConfig: AIConfig = await getConfigViaRuntime() as unknown as AIConfig;
                setConfig(initialConfig);
                const driver: DatabaseDriver = DB_DRIVERS.includes(initialConfig.driver as DatabaseDriver) ? initialConfig.driver as DatabaseDriver : 'mysql';
                // Under SQLite the saved port tells which server driver the network fields were last filled for.
                const server: ServerDatabaseDriver = driver !== 'sqlite' ? driver : initialConfig.port === DB_DRIVER_DEFAULTS.postgres.port ? 'postgres' : 'mysql';
                setDbDriver(driver);
                setServerDriver(server);
                setDbHost(initialConfig.host || 'localhost');
                setDbPort(initialConfig.port || DB_DRIVER_DEFAULTS[server].port);
                setDbUser(initialConfig.user || DB_DRIVER_DEFAULTS[server].user);
                setDbPassword(initialConfig.password || '');
                if (driver === 'sqlite') setDbFile(initialConfig.database || '');
                else setDbName(initialConfig.database || '');
                const runtime = initialConfig.python_runtime || { mode: 'bundled' as const };
                setPythonRuntime(runtime);
                setPythonExecutable(runtime.executable || '');
                const desktopSecrets = await window.dataAgent?.getStoredSecrets();

                // Determine active provider
                const activeId = detectActiveProvider(initialConfig.base_url, initialConfig.provider);
                if (activeId && initialConfig.llm_enabled !== false) {
                    setProviderConfigs(prev => {
                        const next = { ...prev };
                        const pConfig = { ...next[activeId] };
                        pConfig.enabled = true;
                        pConfig.baseUrl = initialConfig.base_url || pConfig.baseUrl;
                        
                        if (initialConfig.api_key) {
                            pConfig.apiKey = initialConfig.api_key;
                        }
                        if ((activeId === 'Anthropic' && desktopSecrets?.anthropic_api_key)
                            || (activeId !== 'Anthropic' && desktopSecrets?.openai_api_key)) {
                            pConfig.apiKey = '[configured_in_desktop]';
                        }
                        
                        // Handle custom model if it's not in the list
                        if (initialConfig.model) {
                            pConfig.selectedModel = initialConfig.model;
                            if (!pConfig.models.includes(initialConfig.model)) {
                                pConfig.models = [...pConfig.models, initialConfig.model];
                            }
                        }
                        next[activeId] = pConfig;
                        persistProviderPreference(activeId, pConfig);
                        return next;
                    });
                }

            } catch (err) {
                console.error('Failed to load settings config:', err);
            }
        };

        void loadInitialData();
    }, []);



    const toggleProvider = async (providerId: string) => {
        const configToSave = providerConfigs[providerId];
        const isTurningOn = !configToSave.enabled;

        // Optimistically update UI
        setProviderConfigs(prev => {
            const next = { ...prev };
            // Turn off all others
            for (const id of Object.keys(next)) {
                if (id === providerId) {
                    next[id] = { ...next[id], enabled: isTurningOn };
                } else {
                    next[id] = { ...next[id], enabled: false };
                }
            }
            return next;
        });

        if (isTurningOn) {
            setIsSavingLLM(true);
            setSaveFeedback(null);
            try {
                // If API key is the placeholder, send empty string to not overwrite with literal '[configured]'
                // The backend ignores empty API keys during update
                const apikeyToSend = (configToSave.apiKey && !configToSave.apiKey.startsWith('[')) 
                    ? configToSave.apiKey : '';

                const provider = providerId === 'Anthropic' ? 'anthropic' : 'openai';
                if (window.dataAgent && apikeyToSend) {
                    const stored = await window.dataAgent.saveSecrets({
                        openai_api_key: provider === 'openai' ? apikeyToSend : undefined,
                        anthropic_api_key: provider === 'anthropic' ? apikeyToSend : undefined,
                        default_model: configToSave.selectedModel,
                        openai_base_url: provider === 'openai' ? configToSave.baseUrl : undefined,
                    });
                    if (!stored.ok) throw new Error(t('settings.saveFailed'));
                }

                await saveConfigViaRuntime({
                    provider,
                    llm_enabled: true,
                    api_key: apikeyToSend,
                    base_url: configToSave.baseUrl,
                    model: configToSave.selectedModel
                });
                
                // Update top-level config to reflect changes
                setConfig(prev => prev ? { 
                    ...prev, 
                    provider,
                    llm_enabled: true,
                    base_url: configToSave.baseUrl, 
                    model: configToSave.selectedModel,
                    api_key: apikeyToSend || prev.api_key
                } : null);
                
                setSaveFeedback(`✓ ${t('settings.saveSuccess')}`);
                setTimeout(() => setSaveFeedback(null), 2000);
            } catch (e: unknown) {
                console.error('Failed to save provider settings:', e);
                setSaveFeedback(`✗ ${t('settings.saveFailed')}`);
                // Revert toggle on failure
                setProviderConfigs(prev => ({
                    ...prev,
                    [providerId]: { ...prev[providerId], enabled: false }
                }));
            } finally {
                setIsSavingLLM(false);
            }
            return;
        }

        setIsSavingLLM(true);
        setSaveFeedback(null);
        try {
            await saveConfigViaRuntime({ llm_enabled: false });
            setConfig(prev => prev ? { ...prev, llm_enabled: false } : null);
            setSaveFeedback(`✓ ${t('settings.saveSuccess')}`);
            setTimeout(() => setSaveFeedback(null), 2000);
        } catch (e: unknown) {
            console.error('Failed to disable provider:', e);
            setSaveFeedback(`✗ ${t('settings.saveFailed')}`);
            setProviderConfigs(prev => ({
                ...prev,
                [providerId]: { ...prev[providerId], enabled: true }
            }));
        } finally {
            setIsSavingLLM(false);
        }
    };



    // Switching between server databases moves the port and user along only while they still hold the previous defaults.
    const changeDbDriver = (driver: DatabaseDriver) => {
        if (driver !== 'sqlite') {
            const previous = DB_DRIVER_DEFAULTS[serverDriver];
            if (dbPort === previous.port) setDbPort(DB_DRIVER_DEFAULTS[driver].port);
            if (dbUser === previous.user) setDbUser(DB_DRIVER_DEFAULTS[driver].user);
            setServerDriver(driver);
        }
        setDbDriver(driver);
        setDbTestResult(null);
    };

    const handleTestDB = async () => {
        setIsTestingDB(true);
        setDbTestResult(null);
        try {
            const res = await testDbViaRuntime({
                driver: dbDriver,
                host: dbHost,
                port: dbPort,
                user: dbUser,
                password: dbPassword,
                database: dbDriver === 'sqlite' ? dbFile : dbName
            });
            setDbTestResult(res);
        } catch (e: unknown) {
            console.error('Database connection test failed:', e);
            setDbTestResult({ success: false, message: t('settings.dbTestFailed') });
        } finally {
            setIsTestingDB(false);
        }
    };

    // Nothing saved means no database, whatever defaults the form shows (the same rule as useReadiness).
    const dbSaved = [config?.driver, config?.host, config?.database].some((value) => value !== undefined && value !== null && String(value).trim() !== '');

    const handleSaveDB = async () => {
        setIsSavingDB(true);
        try {
            await saveConfigViaRuntime({
                driver: dbDriver,
                host: dbHost,
                port: dbPort,
                user: dbUser,
                password: dbPassword,
                database: dbDriver === 'sqlite' ? dbFile : dbName
            });
            setConfig(prev => prev ? { ...prev, driver: dbDriver, host: dbHost, port: dbPort, user: dbUser, database: dbDriver === 'sqlite' ? dbFile : dbName } : prev);
            setDbTestResult({ success: true, message: t('settings.dbSaveSuccess') });
        } catch (e: unknown) {
            console.error('Failed to save database configuration:', e);
            setDbTestResult({ success: false, message: t('settings.dbSaveFailed') });
        } finally {
            setIsSavingDB(false);
        }
    };


    const pythonRuntimePayload = (): PythonRuntimeUpdate => ({
        mode: pythonRuntime.mode,
        executable: pythonRuntime.mode === 'external' ? pythonExecutable.trim() : undefined,
    });

    const handleChoosePython = async () => {
        const selected = await window.dataAgent?.selectPythonExecutable();
        if (!selected) return;
        setPythonRuntime({ mode: 'external', executable: selected, label: selected });
        setPythonExecutable(selected);
        setPythonTestResult(null);
    };

    const handleTestPython = async () => {
        setIsTestingPython(true);
        setPythonTestResult(null);
        try {
            const res = await testPythonRuntimeViaRuntime(pythonRuntimePayload().mode, pythonRuntimePayload().executable);
            setPythonTestResult({ success: res.success, message: res.message });
        } catch (e: unknown) {
            console.error('Python runtime test failed:', e);
            setPythonTestResult({ success: false, message: t('settings.saveFailed') });
        } finally {
            setIsTestingPython(false);
        }
    };

    const handleSavePython = async () => {
        setIsSavingPython(true);
        try {
            const payload = pythonRuntimePayload();
            await saveConfigViaRuntime({ python_runtime: payload });
            setPythonRuntime(payload.mode === 'bundled' ? { mode: 'bundled' } : { mode: 'external', executable: payload.executable });
            setPythonExecutable(payload.executable || '');
            setPythonTestResult({ success: true, message: t('settings.saveSuccess') });
        } catch (e: unknown) {
            console.error('Failed to save Python runtime:', e);
            setPythonTestResult({ success: false, message: t('settings.saveFailed') });
        } finally {
            setIsSavingPython(false);
        }
    };

    return (
        <section className="flex min-w-0 flex-auto flex-col" aria-labelledby="settings-page-title">
            <header className="flex h-14 flex-none items-center border-b border-border px-8 max-[720px]:px-4 [&_h1]:m-0 [&_h1]:text-[1rem] [&_h1]:font-semibold [&_h1]:text-foreground">
                <h1 id="settings-page-title">{t(`settings.${section}`)}</h1>
            </header>

            <div className={cn('scrollable-area flex min-h-0 flex-auto flex-col overflow-y-auto', activeMenu === '模型' ? 'overflow-hidden p-0' : 'p-8 max-[720px]:p-4 [&>*]:w-full')}>
                {/* 模型 (Model) */}
                {activeMenu === '模型' && (
                    <div className="flex min-h-0 flex-1 max-[720px]:flex-col">
                        {/* Internal Sidebar for Model */}
                        <nav className="flex w-[216px] flex-[0_0_216px] flex-col gap-px overflow-y-auto border-r border-border bg-paper px-3 py-4 max-[720px]:max-h-40 max-[720px]:w-full max-[720px]:flex-none max-[720px]:flex-row max-[720px]:gap-1 max-[720px]:overflow-x-auto max-[720px]:border-r-0 max-[720px]:border-b max-[720px]:p-2" aria-label={t('settings.providers')}>
                            <button
                                type="button"
                                className={cn('relative flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[0.85rem] font-medium text-body transition-[background-color,color,box-shadow] hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand max-[720px]:inline-flex max-[720px]:w-auto max-[720px]:flex-none max-[720px]:whitespace-nowrap mb-3.5 max-[720px]:mb-0', modelProvider === '模型设置' && 'bg-white font-semibold text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgba(28,25,23,0.05),0_4px_12px_-8px_rgba(28,25,23,0.16)] hover:bg-white')}
                                aria-current={modelProvider === '模型设置' ? 'page' : undefined}
                                onClick={() => setModelProvider('模型设置')}
                            >
                                <SettingsIcon size={16} />
                                <span>{t('settings.modelSettings')}</span>
                            </button>

                            <div className="px-2.5 pb-1.5 font-mono text-[0.7rem] text-faint before:content-['--_'] max-[720px]:hidden">{t('settings.providers')}</div>
                            {providers.map(p => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={cn('relative flex w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 py-2 text-left text-[0.85rem] font-medium text-body transition-[background-color,color,box-shadow] hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand max-[720px]:inline-flex max-[720px]:w-auto max-[720px]:flex-none max-[720px]:whitespace-nowrap', modelProvider === p.id && 'bg-white font-semibold text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgba(28,25,23,0.05),0_4px_12px_-8px_rgba(28,25,23,0.16)] hover:bg-white')}
                                    aria-current={modelProvider === p.id ? 'page' : undefined}
                                    onClick={() => setModelProvider(p.id)}
                                >
                                    <span className="size-1.5 flex-none rounded-full bg-border-strong transition-colors data-[on=true]:bg-success data-[on=true]:shadow-[0_0_0_3px_rgba(4,120,87,0.12)]" data-on={providerConfigs[p.id]?.enabled ? 'true' : undefined} aria-hidden="true" />
                                    <span>{p.label}</span>
                                </button>
                            ))}
                        </nav>

                        {/* Model Content */}
                        <div className="min-w-0 flex-1 overflow-y-auto px-9 pt-7 pb-10 max-[720px]:p-4 [&>*]:max-w-[720px]">
                            {modelProvider === '模型设置' ? (
                                <div key="overview" className={cn(UI.stack, UI.enter, 'max-w-[640px] gap-6')}>
                                    <p className={UI.lead}>{t('settings.defaultModelTitle')}</p>

                                    <div className={UI.field}>
                                        <label className={UI.label} htmlFor="settings-default-model">{t('settings.defaultModelSubtitle')}</label>
                                        <input
                                            id="settings-default-model"
                                            className={cn(UI.input, UI.mono)}
                                            value={config?.model || ''}
                                            readOnly
                                            placeholder={t('settings.notSet')}
                                        />
                                        <p className={UI.hint}>{t('settings.defaultModelHint')}</p>
                                    </div>

                                    <div className={cn(UI.stack, 'gap-3.5 border-t border-border pt-6')}>
                                        <h4 className={UI.subhead}>{t('settings.historyLimitTitle')}</h4>
                                        <div className={UI.grid2}>
                                            <div className={UI.field}>
                                                <label className={UI.label} htmlFor="settings-max-turns">{t('settings.maxTurns')}</label>
                                                <input id="settings-max-turns" className={UI.input} type="number" value="20" readOnly />
                                                <p className={UI.hint}>{t('settings.maxTurnsSubtitle')}</p>
                                            </div>
                                            <div className={UI.field}>
                                                <label className={UI.label} htmlFor="settings-max-tokens">{t('settings.maxTokens')}</label>
                                                <input id="settings-max-tokens" className={UI.input} type="number" value="2000" readOnly />
                                                <p className={UI.hint}>{t('settings.maxTokensSubtitle')}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div key={modelProvider} className={cn(UI.stack, UI.enter, 'max-w-[640px] gap-6')}>
                                    {/* Header */}
                                    <div className={cn(UI.cardHead, 'border-b border-border pb-5')}>
                                        <div>
                                            <h3 className={UI.cardTitle}>
                                                {providers.find(p => p.id === modelProvider)?.label || modelProvider}
                                                <span className={UI.pill} data-tone={providerConfigs[modelProvider]?.enabled ? 'ok' : 'idle'}>
                                                    {providerConfigs[modelProvider]?.enabled ? t('settings.providerEnabled') : t('settings.providerDisabled')}
                                                </span>
                                            </h3>
                                            {saveFeedback && providerConfigs[modelProvider]?.enabled && (
                                                <span role="status" aria-live="polite" className={cn('mt-1.5 block text-[0.8rem]', saveFeedback.startsWith('✗') ? 'text-destructive' : 'text-success')}>
                                                    {saveFeedback}
                                                </span>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            className={UI.switch}
                                            aria-checked={!!providerConfigs[modelProvider]?.enabled}
                                            aria-label={providerConfigs[modelProvider]?.enabled ? '停用提供商' : '启用提供商'}
                                            onClick={() => toggleProvider(modelProvider)}
                                            disabled={isSavingLLM}
                                        />
                                    </div>

                                    {/* API Key */}
                                    <div className={UI.field}>
                                        <label className={UI.label} htmlFor="settings-api-key">{t('settings.apiKeyTitle')}</label>
                                        <div className={UI.inputGroup}>
                                            <input
                                                id="settings-api-key"
                                                className={cn(UI.input, UI.mono)}
                                                type={showPassword ? 'text' : 'password'}
                                                autoComplete="off"
                                                spellCheck={false}
                                                placeholder={t('settings.apiKeyPlaceholder')}
                                                value={providerConfigs[modelProvider]?.apiKey || ''}
                                                onChange={e => updateProviderConfig(modelProvider, { apiKey: e.target.value })}
                                            />
                                            <button
                                                type="button"
                                                data-adorn
                                                className={UI.inputAdorn}
                                                onClick={() => setShowPassword(prev => !prev)}
                                                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                                aria-pressed={showPassword}
                                            >
                                                <Eye size={16} />
                                            </button>
                                        </div>
                                        <a className={UI.link} href={providers.find(p => p.id === modelProvider)?.apiKeyUrl || '#'} target="_blank" rel="noreferrer">
                                            {t('settings.howToGetToken')} <ExternalLink size={13} />
                                        </a>
                                    </div>

                                    {/* API Base URL */}
                                    <div className={UI.field}>
                                        <label className={UI.label} htmlFor="settings-api-base-url">{t('settings.apiBaseUrl')}</label>
                                        <input
                                            id="settings-api-base-url"
                                            className={cn(UI.input, UI.mono)}
                                            type="text"
                                            spellCheck={false}
                                            value={providerConfigs[modelProvider]?.baseUrl || ''}
                                            onChange={e => updateProviderConfig(modelProvider, { baseUrl: e.target.value })}
                                            placeholder="例如: https://api.openai.com/v1"
                                        />
                                    </div>

                                    {/* Model */}
                                    <div className={UI.field}>
                                        <label className={UI.label} htmlFor="settings-model-name">{t('settings.modelName')}</label>
                                        <input
                                            id="settings-model-name"
                                            className={cn(UI.input, UI.mono)}
                                            type="text"
                                            spellCheck={false}
                                            value={providerConfigs[modelProvider]?.selectedModel || ''}
                                            onChange={e => updateProviderConfig(modelProvider, { selectedModel: e.target.value })}
                                            placeholder="例如: deepseek-chat"
                                        />
                                    </div>

                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 数据库 (Database) */}
                {activeMenu === '数据库' && (
                    <div className={cn(UI.stack, UI.enter, SUB_PAGE)}>
                        <section className={cn(UI.stack, 'gap-5')} aria-labelledby="settings-db-heading">
                            <div className={UI.cardHead}>
                                <div className={UI.cardTitle} id="settings-db-heading">
                                    <span className={UI.cardIcon} aria-hidden="true"><Database size={18} /></span>
                                    <div className="grid min-w-0 gap-0.5">
                                        <div>{t('settings.database')}</div>
                                        <div className={cn(UI.caption, 'truncate')}>-- {!dbSaved ? t('settings.dbNotConnected') : dbDriver === 'sqlite' ? `sqlite:///${dbFile}` : `${dbDriver === 'postgres' ? 'postgresql' : 'mysql'}://${dbHost || 'localhost'}:${dbPort}`}</div>
                                    </div>
                                </div>
                            </div>

                            <div className={UI.field}>
                                <label className={UI.label} htmlFor="settings-db-driver">
                                    <Database size={15} aria-hidden="true" />
                                    <span>{t('settings.dbDriver')}</span>
                                </label>
                                <select id="settings-db-driver" className={cn(UI.input, UI.select)} value={dbDriver} onChange={e => changeDbDriver(e.target.value as DatabaseDriver)}>
                                    <option value="mysql">MySQL</option>
                                    <option value="postgres">PostgreSQL</option>
                                    <option value="sqlite">SQLite</option>
                                </select>
                            </div>

                            {dbDriver !== 'sqlite' && (<>
                            <div className={cn(UI.grid2, 'max-[720px]:gap-4')}>
                                <div className={UI.field}>
                                    <label className={UI.label} htmlFor="settings-db-host">
                                        <Cloud size={15} aria-hidden="true" />
                                        <span>{t('settings.dbHost')}</span>
                                    </label>
                                    <input id="settings-db-host" className={cn(UI.input, UI.mono)} type="text" spellCheck={false} placeholder="localhost" value={dbHost} onChange={e => setDbHost(e.target.value)} />
                                </div>
                                <div className={UI.field}>
                                    <label className={UI.label} htmlFor="settings-db-port">
                                        <Usb size={15} aria-hidden="true" />
                                        <span>{t('settings.dbPort')}</span>
                                    </label>
                                    <input id="settings-db-port" className={cn(UI.input, UI.mono)} type="number" placeholder={String(DB_DRIVER_DEFAULTS[serverDriver].port)} value={dbPort} onChange={e => setDbPort(parseInt(e.target.value) || DB_DRIVER_DEFAULTS[serverDriver].port)} />
                                </div>
                            </div>

                            <div className={cn(UI.grid2, 'max-[720px]:gap-4')}>
                                <div className={UI.field}>
                                    <label className={UI.label} htmlFor="settings-db-user">
                                        <User size={15} aria-hidden="true" />
                                        <span>{t('settings.dbUser')}</span>
                                    </label>
                                    <input id="settings-db-user" className={cn(UI.input, UI.mono)} type="text" spellCheck={false} placeholder={DB_DRIVER_DEFAULTS[serverDriver].user} value={dbUser} onChange={e => setDbUser(e.target.value)} />
                                </div>
                                <div className={UI.field}>
                                    <label className={UI.label} htmlFor="settings-db-password">
                                        <KeyRound size={15} aria-hidden="true" />
                                        <span>{t('settings.dbPassword')}</span>
                                    </label>
                                    <input id="settings-db-password" className={cn(UI.input, UI.mono)} type="password" placeholder="••••••••" value={dbPassword} onChange={e => setDbPassword(e.target.value)} />
                                </div>
                            </div>

                            </>)}

                            <div className={UI.field}>
                                <label className={UI.label} htmlFor="settings-db-name">
                                    <Link size={15} aria-hidden="true" />
                                    <span>{t(dbDriver === 'sqlite' ? 'settings.dbFile' : 'settings.dbDatabase')}</span>
                                </label>
                                <input
                                    id="settings-db-name"
                                    className={cn(UI.input, UI.mono)}
                                    type="text"
                                    spellCheck={false}
                                    placeholder={dbDriver === 'sqlite' ? 'C:\\data\\sales.sqlite' : t('settings.dbDatabasePlaceholder')}
                                    aria-describedby={dbDriver === 'sqlite' ? 'settings-db-file-help' : undefined}
                                    value={dbDriver === 'sqlite' ? dbFile : dbName}
                                    onChange={e => (dbDriver === 'sqlite' ? setDbFile : setDbName)(e.target.value)}
                                />
                                {dbDriver === 'sqlite' && <div id="settings-db-file-help" className={UI.caption}>{t('settings.dbFileHelp')}</div>}
                            </div>

                            {dbTestResult && (
                                <div className={UI.alert} data-tone={dbTestResult.success ? 'ok' : 'error'} role={dbTestResult.success ? 'status' : 'alert'} aria-live={dbTestResult.success ? 'polite' : 'assertive'}>
                                    <strong>{dbTestResult.success ? `✓ ${t('settings.dbTestSuccess')}` : `✗ ${t('settings.dbTestFailed')}`}</strong>
                                    <div className={UI.alertDetail}>{dbTestResult.message}</div>
                                </div>
                            )}

                            <div className={cn(UI.actions, 'max-[720px]:flex-wrap max-[720px]:[&>button]:w-[min(180px,100%)] max-[720px]:[&>button]:flex-[1_1_120px]')}>
                                <button type="button" className={UI.btn} onClick={handleTestDB} disabled={isTestingDB}>
                                    {isTestingDB ? <Loader2 size={15} className="animate-spin" /> : null}
                                    {isTestingDB ? t('settings.testing') : t('settings.dbTest')}
                                </button>
                                <button type="button" className={cn(UI.btn, UI.btnPrimary)} onClick={handleSaveDB} disabled={isSavingDB}>
                                    {isSavingDB ? <Loader2 size={15} className="animate-spin" /> : null}
                                    {t('settings.save')}
                                </button>
                            </div>
                        </section>
                    </div>
                )}


                {/* 消息渠道 (Channels) */}
                {activeMenu === '消息渠道' && <ChannelsSettings />}

                {/* 环境 (Environment) */}
                {activeMenu === '环境' && (
                    <div className={cn(UI.stack, UI.enter, SUB_PAGE)}>
                        <section className={cn(UI.stack, 'gap-5')} aria-labelledby="settings-python-heading">
                            <div className={UI.cardHead}>
                                <div>
                                    <h3 className={UI.cardTitle} id="settings-python-heading">
                                        <span className={UI.cardIcon} aria-hidden="true"><Terminal size={18} /></span>
                                        {t('settings.python')}
                                    </h3>
                                    <p className={UI.cardDesc}>{t('settings.pythonHint')}</p>
                                </div>
                            </div>
                            <div className={UI.segmented} role="group" aria-label={t('settings.python')}>
                                <button type="button" aria-pressed={pythonRuntime.mode === 'bundled'} onClick={() => { setPythonRuntime({ mode: 'bundled' }); setPythonTestResult(null); }}>{t('settings.bundledPython')}</button>
                                <button type="button" aria-pressed={pythonRuntime.mode === 'external'} onClick={() => { setPythonRuntime({ mode: 'external', executable: pythonExecutable }); setPythonTestResult(null); }}>{t('settings.externalPython')}</button>
                            </div>
                            <div className={UI.field}>
                                <label className={UI.label} htmlFor="settings-python-executable">{t('settings.pythonExecutable')}</label>
                                <div className={UI.inputGroup}>
                                    <input id="settings-python-executable" className={cn(UI.input, UI.mono)} type="text" spellCheck={false} value={pythonRuntime.mode === 'bundled' ? (pythonRuntime.label || t('settings.bundledPython')) : pythonExecutable} onChange={e => setPythonExecutable(e.target.value)} readOnly={pythonRuntime.mode === 'bundled'} placeholder="例如: D:\\data_agent\\.venv\\Scripts\\python.exe" />
                                    <button type="button" className={UI.btn} onClick={handleChoosePython} disabled={pythonRuntime.mode !== 'external'}>{t('settings.choose')}</button>
                                </div>
                            </div>
                            {pythonTestResult && (
                                <div className={UI.alert} data-tone={pythonTestResult.success ? 'ok' : 'error'} role={pythonTestResult.success ? 'status' : 'alert'} aria-live={pythonTestResult.success ? 'polite' : 'assertive'}>
                                    <strong>{pythonTestResult.success ? `✓ ${t('settings.saveSuccess')}` : `✗ ${t('settings.saveFailed')}`}</strong>
                                    <div className={UI.alertDetail}>{pythonTestResult.message}</div>
                                </div>
                            )}
                            <div className={cn(UI.actions, 'max-[720px]:flex-wrap max-[720px]:[&>button]:w-[min(180px,100%)] max-[720px]:[&>button]:flex-[1_1_120px]')}>
                                <button type="button" onClick={handleTestPython} className={UI.btn} disabled={isTestingPython || (pythonRuntime.mode === 'external' && !pythonExecutable.trim())}>{isTestingPython ? <Loader2 size={15} className="animate-spin" /> : null}{isTestingPython ? t('settings.testingPython') : t('settings.testPython')}</button>
                                <button type="button" onClick={handleSavePython} className={cn(UI.btn, UI.btnPrimary)} disabled={isSavingPython || (pythonRuntime.mode === 'external' && !pythonExecutable.trim())}>{isSavingPython ? <Loader2 size={15} className="animate-spin" /> : null}{t('settings.savePython')}</button>
                            </div>
                        </section>
                    </div>
                )}

            </div>
        </section>
    );
};

export default SettingsPanel;
