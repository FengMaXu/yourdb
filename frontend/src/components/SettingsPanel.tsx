import React, { useEffect, useState } from 'react';
import ChannelsSettings from './ChannelsSettings';
import {
    Settings as SettingsIcon,
    User, Link, Eye, ExternalLink, Loader2, Terminal, Database
} from './icons/Typicons';
import { RiCloud, RiKey2, RiUsb } from './icons/RemixIcons';
import {
    type AIConfig,
    type DatabaseDriver,
    type PythonRuntimeConfig,
    type PythonRuntimeUpdate,
} from '../api/client';
import { getConfigViaRuntime, saveConfigViaRuntime, testDbViaRuntime, testPythonRuntimeViaRuntime } from '../api/runtime-client';
import { useLanguage } from '../context/LanguageContext';

const DB_DRIVER_DEFAULTS: Record<DatabaseDriver, { port: number; user: string }> = {
    mysql: { port: 3306, user: 'root' },
    postgres: { port: 5432, user: 'postgres' },
};

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
const SettingsPanel: React.FC<SettingsPanelProps> = ({ section }) => {
    const { t } = useLanguage();
    const activeMenu = SECTION_MENU[section];

    // States for sub-tabs
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

    // Detect which provider is active based on current base_url or provider
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

    // Provide an array from the registry for easy mapping
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
    const [dbHost, setDbHost] = useState('localhost');
    const [dbPort, setDbPort] = useState(DB_DRIVER_DEFAULTS.mysql.port);
    const [dbUser, setDbUser] = useState(DB_DRIVER_DEFAULTS.mysql.user);
    const [dbPassword, setDbPassword] = useState('');
    const [dbName, setDbName] = useState('my_database');
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
                const driver: DatabaseDriver = initialConfig.driver === 'postgres' ? 'postgres' : 'mysql';
                setDbDriver(driver);
                setDbHost(initialConfig.host || 'localhost');
                setDbPort(initialConfig.port || DB_DRIVER_DEFAULTS[driver].port);
                setDbUser(initialConfig.user || DB_DRIVER_DEFAULTS[driver].user);
                setDbPassword(initialConfig.password || '');
                setDbName(initialConfig.database || '');
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



    // Switching the database type moves the port and user along only while they still hold the previous defaults.
    const changeDbDriver = (driver: DatabaseDriver) => {
        const previous = DB_DRIVER_DEFAULTS[dbDriver];
        if (dbPort === previous.port) setDbPort(DB_DRIVER_DEFAULTS[driver].port);
        if (dbUser === previous.user) setDbUser(DB_DRIVER_DEFAULTS[driver].user);
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
                database: dbName
            });
            setDbTestResult(res);
        } catch (e: unknown) {
            console.error('Database connection test failed:', e);
            setDbTestResult({ success: false, message: t('settings.dbTestFailed') });
        } finally {
            setIsTestingDB(false);
        }
    };

    const handleSaveDB = async () => {
        setIsSavingDB(true);
        try {
            await saveConfigViaRuntime({
                driver: dbDriver,
                host: dbHost,
                port: dbPort,
                user: dbUser,
                password: dbPassword,
                database: dbName
            });
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
        <section className="workspace-page" aria-labelledby="settings-page-title">
            <header className="workspace-page-header">
                <h1 id="settings-page-title">{t(`settings.${section}`)}</h1>
            </header>

            <div className={`workspace-page-body scrollable-area ${activeMenu === '模型' ? 'is-split' : ''}`}>
                {/* 模型 (Model) */}
                {activeMenu === '模型' && (
                    <div className="settings-model-layout">
                        {/* Internal Sidebar for Model */}
                        <nav className="settings-provider-nav" aria-label={t('settings.providers')}>
                            <button
                                type="button"
                                className={`modal-nav-item settings-provider-overview ${modelProvider === '模型设置' ? 'active' : ''}`}
                                aria-current={modelProvider === '模型设置' ? 'page' : undefined}
                                onClick={() => setModelProvider('模型设置')}
                            >
                                <SettingsIcon size={16} className="modal-nav-icon" />
                                <span>{t('settings.modelSettings')}</span>
                            </button>

                            <div className="settings-provider-label">{t('settings.providers')}</div>
                            {providers.map(p => (
                                <button
                                    key={p.id}
                                    type="button"
                                    className={`modal-nav-item settings-provider-item ${modelProvider === p.id ? 'active' : ''}`}
                                    aria-current={modelProvider === p.id ? 'page' : undefined}
                                    onClick={() => setModelProvider(p.id)}
                                >
                                    <span className="settings-provider-dot" data-on={providerConfigs[p.id]?.enabled ? 'true' : undefined} aria-hidden="true" />
                                    <span>{p.label}</span>
                                </button>
                            ))}
                        </nav>

                        {/* Model Content */}
                        <div className="settings-provider-content">
                            {modelProvider === '模型设置' ? (
                                <div key="overview" className="ui-stack ui-enter settings-pane">
                                    <p className="ui-lead">{t('settings.defaultModelTitle')}</p>

                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="settings-default-model">{t('settings.defaultModelSubtitle')}</label>
                                        <input
                                            id="settings-default-model"
                                            className="ui-input ui-mono"
                                            value={config?.model || ''}
                                            readOnly
                                            placeholder={t('settings.notSet')}
                                        />
                                        <p className="ui-hint">{t('settings.defaultModelHint')}</p>
                                    </div>

                                    <div className="ui-stack settings-subsection">
                                        <h4 className="ui-subhead">{t('settings.historyLimitTitle')}</h4>
                                        <div className="ui-grid-2">
                                            <div className="ui-field">
                                                <label className="ui-label" htmlFor="settings-max-turns">{t('settings.maxTurns')}</label>
                                                <input id="settings-max-turns" className="ui-input" type="number" value="20" readOnly />
                                                <p className="ui-hint">{t('settings.maxTurnsSubtitle')}</p>
                                            </div>
                                            <div className="ui-field">
                                                <label className="ui-label" htmlFor="settings-max-tokens">{t('settings.maxTokens')}</label>
                                                <input id="settings-max-tokens" className="ui-input" type="number" value="2000" readOnly />
                                                <p className="ui-hint">{t('settings.maxTokensSubtitle')}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div key={modelProvider} className="ui-stack ui-enter settings-pane">
                                    {/* Header */}
                                    <div className="ui-card-head settings-provider-head">
                                        <div>
                                            <h3 className="ui-card-title">
                                                {providers.find(p => p.id === modelProvider)?.label || modelProvider}
                                                <span className="ui-pill" data-tone={providerConfigs[modelProvider]?.enabled ? 'ok' : 'idle'}>
                                                    {providerConfigs[modelProvider]?.enabled ? t('settings.providerEnabled') : t('settings.providerDisabled')}
                                                </span>
                                            </h3>
                                            {saveFeedback && providerConfigs[modelProvider]?.enabled && (
                                                <span role="status" aria-live="polite" className={`settings-feedback ${saveFeedback.startsWith('✗') ? 'is-error' : 'is-ok'}`}>
                                                    {saveFeedback}
                                                </span>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            className="ui-switch"
                                            aria-checked={!!providerConfigs[modelProvider]?.enabled}
                                            aria-label={providerConfigs[modelProvider]?.enabled ? '停用提供商' : '启用提供商'}
                                            onClick={() => toggleProvider(modelProvider)}
                                            disabled={isSavingLLM}
                                        />
                                    </div>

                                    {/* API Key */}
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="settings-api-key">{t('settings.apiKeyTitle')}</label>
                                        <div className="ui-input-group">
                                            <input
                                                id="settings-api-key"
                                                className="ui-input ui-mono"
                                                type={showPassword ? 'text' : 'password'}
                                                autoComplete="off"
                                                spellCheck={false}
                                                placeholder={t('settings.apiKeyPlaceholder')}
                                                value={providerConfigs[modelProvider]?.apiKey || ''}
                                                onChange={e => updateProviderConfig(modelProvider, { apiKey: e.target.value })}
                                            />
                                            <button
                                                type="button"
                                                className="ui-input-adorn"
                                                onClick={() => setShowPassword(prev => !prev)}
                                                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                                                aria-pressed={showPassword}
                                            >
                                                <Eye size={16} />
                                            </button>
                                        </div>
                                        <a className="ui-link" href={providers.find(p => p.id === modelProvider)?.apiKeyUrl || '#'} target="_blank" rel="noreferrer">
                                            {t('settings.howToGetToken')} <ExternalLink size={13} />
                                        </a>
                                    </div>

                                    {/* API Base URL */}
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="settings-api-base-url">{t('settings.apiBaseUrl')}</label>
                                        <input
                                            id="settings-api-base-url"
                                            className="ui-input ui-mono"
                                            type="text"
                                            spellCheck={false}
                                            value={providerConfigs[modelProvider]?.baseUrl || ''}
                                            onChange={e => updateProviderConfig(modelProvider, { baseUrl: e.target.value })}
                                            placeholder="例如: https://api.openai.com/v1"
                                        />
                                    </div>

                                    {/* Model */}
                                    <div className="ui-field">
                                        <label className="ui-label" htmlFor="settings-model-name">{t('settings.modelName')}</label>
                                        <input
                                            id="settings-model-name"
                                            className="ui-input ui-mono"
                                            type="text"
                                            spellCheck={false}
                                            value={providerConfigs[modelProvider]?.selectedModel || ''}
                                            onChange={e => updateProviderConfig(modelProvider, { selectedModel: e.target.value })}
                                            placeholder="例如: deepseek-chat"
                                        />
                                    </div>

                                    <div className="ui-alert settings-local-hint">
                                        <span><SettingsIcon size={14} aria-hidden="true" /> {t('settings.configLocalHint')}</span>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* 数据库 (Database) */}
                {activeMenu === '数据库' && (
                    <div className="settings-tab-content ui-stack ui-enter">
                        <section className="ui-card ui-stack settings-form-card" aria-labelledby="settings-db-heading">
                            <div className="ui-card-head">
                                <div className="ui-card-title" id="settings-db-heading">
                                    <span className="ui-card-icon" aria-hidden="true"><Database size={18} /></span>
                                    <div>
                                        <div>{t('settings.database')}</div>
                                        <div className="ui-caption">-- {dbDriver === 'postgres' ? 'postgresql' : 'mysql'}://{dbHost || 'localhost'}:{dbPort}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="ui-field">
                                <label className="ui-label" htmlFor="settings-db-driver">
                                    <Database size={15} aria-hidden="true" />
                                    <span>{t('settings.dbDriver')}</span>
                                </label>
                                <select id="settings-db-driver" className="ui-select" value={dbDriver} onChange={e => changeDbDriver(e.target.value as DatabaseDriver)}>
                                    <option value="mysql">MySQL</option>
                                    <option value="postgres">PostgreSQL</option>
                                </select>
                            </div>

                            <div className="ui-grid-2 settings-form-row">
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="settings-db-host">
                                        <RiCloud size={15} aria-hidden="true" />
                                        <span>{t('settings.dbHost')}</span>
                                    </label>
                                    <input id="settings-db-host" className="ui-input ui-mono" type="text" spellCheck={false} placeholder="localhost" value={dbHost} onChange={e => setDbHost(e.target.value)} />
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="settings-db-port">
                                        <RiUsb size={15} aria-hidden="true" />
                                        <span>{t('settings.dbPort')}</span>
                                    </label>
                                    <input id="settings-db-port" className="ui-input ui-mono" type="number" placeholder={String(DB_DRIVER_DEFAULTS[dbDriver].port)} value={dbPort} onChange={e => setDbPort(parseInt(e.target.value) || DB_DRIVER_DEFAULTS[dbDriver].port)} />
                                </div>
                            </div>

                            <div className="ui-grid-2 settings-form-row">
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="settings-db-user">
                                        <User size={15} aria-hidden="true" />
                                        <span>{t('settings.dbUser')}</span>
                                    </label>
                                    <input id="settings-db-user" className="ui-input ui-mono" type="text" spellCheck={false} placeholder={DB_DRIVER_DEFAULTS[dbDriver].user} value={dbUser} onChange={e => setDbUser(e.target.value)} />
                                </div>
                                <div className="ui-field">
                                    <label className="ui-label" htmlFor="settings-db-password">
                                        <RiKey2 size={15} aria-hidden="true" />
                                        <span>{t('settings.dbPassword')}</span>
                                    </label>
                                    <input id="settings-db-password" className="ui-input ui-mono" type="password" placeholder="••••••••" value={dbPassword} onChange={e => setDbPassword(e.target.value)} />
                                </div>
                            </div>

                            <div className="ui-field">
                                <label className="ui-label" htmlFor="settings-db-name">
                                    <Link size={15} aria-hidden="true" />
                                    <span>{t('settings.dbDatabase')}</span>
                                </label>
                                <input id="settings-db-name" className="ui-input ui-mono" type="text" spellCheck={false} placeholder="my_database" value={dbName} onChange={e => setDbName(e.target.value)} />
                            </div>

                            {/* Test Result Alert */}
                            {dbTestResult && (
                                <div className="ui-alert" data-tone={dbTestResult.success ? 'ok' : 'error'} role={dbTestResult.success ? 'status' : 'alert'} aria-live={dbTestResult.success ? 'polite' : 'assertive'}>
                                    <strong>{dbTestResult.success ? `✓ ${t('settings.dbTestSuccess')}` : `✗ ${t('settings.dbTestFailed')}`}</strong>
                                    <div className="ui-alert-detail">{dbTestResult.message}</div>
                                </div>
                            )}

                            <div className="ui-actions settings-action-row">
                                <button type="button" className="ui-btn" onClick={handleTestDB} disabled={isTestingDB}>
                                    {isTestingDB ? <Loader2 size={15} className="animate-spin" /> : null}
                                    {isTestingDB ? t('settings.testing') : t('settings.dbTest')}
                                </button>
                                <button type="button" className="ui-btn ui-btn-primary" onClick={handleSaveDB} disabled={isSavingDB}>
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
                    <div className="settings-tab-content ui-stack ui-enter">
                        <section className="ui-card ui-stack settings-form-card" aria-labelledby="settings-python-heading">
                            <div className="ui-card-head">
                                <div>
                                    <h3 className="ui-card-title" id="settings-python-heading">
                                        <span className="ui-card-icon" aria-hidden="true"><Terminal size={18} /></span>
                                        {t('settings.python')}
                                    </h3>
                                    <p className="ui-card-desc">{t('settings.pythonHint')}</p>
                                </div>
                            </div>
                            <div className="ui-segmented" role="group" aria-label={t('settings.python')}>
                                <button type="button" aria-pressed={pythonRuntime.mode === 'bundled'} onClick={() => { setPythonRuntime({ mode: 'bundled' }); setPythonTestResult(null); }}>{t('settings.bundledPython')}</button>
                                <button type="button" aria-pressed={pythonRuntime.mode === 'external'} onClick={() => { setPythonRuntime({ mode: 'external', executable: pythonExecutable }); setPythonTestResult(null); }}>{t('settings.externalPython')}</button>
                            </div>
                            <div className="ui-field">
                                <label className="ui-label" htmlFor="settings-python-executable">{t('settings.pythonExecutable')}</label>
                                <div className="ui-input-group">
                                    <input id="settings-python-executable" className="ui-input ui-mono" type="text" spellCheck={false} value={pythonRuntime.mode === 'bundled' ? (pythonRuntime.label || t('settings.bundledPython')) : pythonExecutable} onChange={e => setPythonExecutable(e.target.value)} readOnly={pythonRuntime.mode === 'bundled'} placeholder="例如: D:\\data_agent\\.venv\\Scripts\\python.exe" />
                                    <button type="button" className="ui-btn" onClick={handleChoosePython} disabled={pythonRuntime.mode !== 'external'}>{t('settings.choose')}</button>
                                </div>
                            </div>
                            {pythonTestResult && (
                                <div className="ui-alert" data-tone={pythonTestResult.success ? 'ok' : 'error'} role={pythonTestResult.success ? 'status' : 'alert'} aria-live={pythonTestResult.success ? 'polite' : 'assertive'}>
                                    <strong>{pythonTestResult.success ? `✓ ${t('settings.saveSuccess')}` : `✗ ${t('settings.saveFailed')}`}</strong>
                                    <div className="ui-alert-detail">{pythonTestResult.message}</div>
                                </div>
                            )}
                            <div className="ui-actions settings-action-row">
                                <button type="button" onClick={handleTestPython} className="ui-btn" disabled={isTestingPython || (pythonRuntime.mode === 'external' && !pythonExecutable.trim())}>{isTestingPython ? <Loader2 size={15} className="animate-spin" /> : null}{isTestingPython ? t('settings.testingPython') : t('settings.testPython')}</button>
                                <button type="button" onClick={handleSavePython} className="ui-btn ui-btn-primary" disabled={isSavingPython || (pythonRuntime.mode === 'external' && !pythonExecutable.trim())}>{isSavingPython ? <Loader2 size={15} className="animate-spin" /> : null}{t('settings.savePython')}</button>
                            </div>
                        </section>
                    </div>
                )}

            </div>
        </section>
    );
};

export default SettingsPanel;
