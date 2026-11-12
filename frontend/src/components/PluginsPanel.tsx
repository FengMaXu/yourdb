import React, { useState, useEffect } from 'react';
import { UI } from './workspace-ui';
import { Search, RefreshCw, Plus, Loader2, Database, PlugZap, Server, Sparkles } from 'lucide-react';
import {
    type MCPConfig,
    type MCPServerConfig,
    type MCPServerRequest,
    type MCPServerStatus,
    type MCPTestResult,
    type SkillInfo,
} from '../api/client';
import { getMcpConfigViaRuntime, getMcpServersViaRuntime, listSkillsViaRuntime, restartMcpServerViaRuntime, saveMcpConfigViaRuntime, testMcpServerViaRuntime } from '../api/runtime-client';
import { useLanguage } from '../context/LanguageContext';
import McpSettings from './plugins/McpSettings';
import { McpButton, McpIconTile, McpStatus, REDUCED_MOTION } from './plugins/parts';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

export type PluginsTab = 'MCP' | 'Skills';

interface PluginsPanelProps {
    tab: PluginsTab;
    /** Opens Settings → Database, where the database server is configured. */
    onOpenDatabaseSettings?: () => void;
}

/** The installed / settings switch above each pane: text tabs over a hairline, the current one underlined in ink. */
function PaneTabs({ label, value, onChange, items }: { label: string; value: string; onChange: (value: string) => void; items: Array<{ value: string; label: string }> }) {
    return (
        <Tabs value={value} onValueChange={(next) => onChange(String(next))} className="mb-5 gap-0">
            <TabsList
                variant="line"
                aria-label={label}
                className="h-auto w-full flex-wrap justify-start gap-x-3 gap-y-3 rounded-none min-[721px]:gap-x-7 border-b border-border p-0"
            >
                {items.map((item) => (
                    <TabsTrigger
                        key={item.value}
                        value={item.value}
                        className="h-auto flex-none rounded-none border-0 px-0 pt-0 pb-3 text-[0.9rem] font-medium text-muted-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand data-active:font-semibold data-active:text-foreground group-data-horizontal/tabs:after:-bottom-px group-data-horizontal/tabs:after:rounded-t-[2px]"
                    >
                        {item.label}
                    </TabsTrigger>
                ))}
            </TabsList>
        </Tabs>
    );
}

/** A frameless icon action whose label slides out on hover or keyboard focus. */
function RevealButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button
            type="button"
            className="group/reveal inline-flex h-[34px] cursor-pointer items-center border-0 bg-transparent px-2 whitespace-nowrap text-muted-foreground [font:inherit] transition-colors enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
        >
            {children}
            <span
                className="inline-block max-w-0 overflow-hidden text-[0.82rem] whitespace-nowrap opacity-0 transition-[max-width,opacity,margin] group-focus-visible/reveal:ml-1.5 group-focus-visible/reveal:max-w-[8em] group-focus-visible/reveal:opacity-100 group-enabled/reveal:group-hover/reveal:ml-1.5 group-enabled/reveal:group-hover/reveal:max-w-[8em] group-enabled/reveal:group-hover/reveal:opacity-100 motion-reduce:transition-none"
                aria-hidden="true"
            >
                {label}
            </span>
        </button>
    );
}

/** MCP and Skills management shown in the main pane; the sidebar picks the tab. */
const PluginsPanel: React.FC<PluginsPanelProps> = ({ tab, onOpenDatabaseSettings }) => {
    const { t } = useLanguage();
    const [mcpTab, setMcpTab] = useState('已安装');
    const [skillsTab, setSkillsTab] = useState('已安装');

    const [mcpConfig, setMcpConfig] = useState<MCPConfig>({ servers: [] });
    const [mcpServers, setMcpServers] = useState<MCPServerStatus[]>([]);
    const [selectedMcpServer, setSelectedMcpServer] = useState<number | null>(null);
    const [isLoadingMCP, setIsLoadingMCP] = useState(false);
    const [isSavingMCP, setIsSavingMCP] = useState(false);
    const [isTestingMCP, setIsTestingMCP] = useState(false);
    // Until statuses arrive an enabled server shows as connecting, not as down.
    const [statusesLoaded, setStatusesLoaded] = useState(false);
    const [mcpTestResult, setMcpTestResult] = useState<MCPTestResult | null>(null);
    const [mcpError, setMcpError] = useState<string | null>(null);
    const [pendingToggleServer, setPendingToggleServer] = useState<string | null>(null);
    const [pendingRestartServer, setPendingRestartServer] = useState<string | null>(null);
    
    const [skills, setSkills] = useState<SkillInfo[]>([]);
    const [isLoadingSkills, setIsLoadingSkills] = useState(false);
    const [skillsError, setSkillsError] = useState<string | null>(null);
    const [skillQuery, setSkillQuery] = useState('');

    useEffect(() => {
        void loadMCPData();
        void loadSkills();
    }, []);

    const emptyMcpServer = (): MCPServerConfig => ({
        name: '',
        transport: 'stdio',
        enabled: true,
        command: 'python',
        script: '',
        args: [],
        args_input: '',
        url: '',
        description: '',
        tool_prefix: '',
        server_type: 'service',
        tags: [],
        headers: { configured: false, count: 0 },
        env: { configured: false, count: 0 },
        env_input: '',
        headers_input: '',
    });

    const loadMCPData = async ({ silent = false }: { silent?: boolean } = {}) => {
        if (!silent) {
            setIsLoadingMCP(true);
        }
        try {
            const listed = (await getMcpConfigViaRuntime() as unknown as MCPConfig).servers;
            // Host-managed servers are listed with their status but configured elsewhere, so they are not editable here.
            const configRes: MCPConfig = { servers: listed.filter((server) => !server.host_managed) };
            setMcpError(null);
            setMcpConfig(configRes);
            // Keep the last known statuses until fresh ones arrive, so a reload does not flash servers as down.
            setMcpServers((prev) => listed.map((server) => {
                const known = prev.find((item) => item.name === server.name);
                return known ? { ...server, connected: known.connected, tool_count: known.tool_count } : server;
            }));
            // Reading statuses connects the enabled plugins, which can take a while; show them when they arrive.
            void getMcpServersViaRuntime().then((statuses) => {
                setMcpServers(listed.map((server) => {
                    const status = statuses.find((item) => item.name === server.name);
                    return status ? { ...server, connected: status.connected, tool_count: status.toolCount, host_managed: status.hostManaged } : server;
                }));
                setStatusesLoaded(true);
            }).catch((err) => console.error('Failed to load MCP status:', err));
            setSelectedMcpServer(prev => {
                if ((configRes.servers || []).length === 0) return null;
                if (prev === null || prev >= configRes.servers.length) return 0;
                return prev;
            });
        } catch (err) {
            console.error('Failed to load MCP config:', err);
            setMcpError(t('plugins.loadFailed'));
        } finally {
            if (!silent) {
                setIsLoadingMCP(false);
            }
        }
    };

    const updateMcpServerField = (index: number, field: keyof MCPServerConfig, value: MCPServerConfig[keyof MCPServerConfig]) => {
        setMcpConfig(prev => ({
            ...prev,
            servers: prev.servers.map((server, i) => i === index ? { ...server, [field]: value } : server),
        }));
    };

    const addMcpServer = () => {
        setMcpConfig(prev => ({ ...prev, servers: [...prev.servers, emptyMcpServer()] }));
        setSelectedMcpServer(mcpConfig.servers.length);
        setMcpTab('设置');
    };

    const removeMcpServer = (index: number) => {
        setMcpConfig(prev => ({
            ...prev,
            servers: prev.servers.filter((_, i) => i !== index),
        }));
        setSelectedMcpServer(prev => {
            if (prev === null) return null;
            if (prev === index) return null;
            if (prev > index) return prev - 1;
            return prev;
        });
    };

    const parseMcpArgs = (server: MCPServerConfig): string[] => {
        if (!server.args_input?.trim()) {
            return server.args || [];
        }
        const parsed = JSON.parse(server.args_input);
        if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
            throw new Error('MCP 参数必须是字符串数组，例如 ["mcp", "stdio"]');
        }
        return parsed;
    };

    const buildMcpServerPayload = (server: MCPServerConfig): MCPServerRequest => {
        if (server.preset) {
            // A secret left blank keeps the saved one.
            const field_values: Record<string, string | string[]> = { ...(server.field_values || {}) };
            for (const [key, value] of Object.entries(server.field_inputs || {})) {
                if (value.trim()) field_values[key] = value;
            }
            return { name: server.name, enabled: server.enabled, transport: server.transport, field_values } as MCPServerRequest;
        }
        const payload: MCPServerRequest = {
            name: server.name,
            transport: server.transport,
            enabled: server.enabled,
            command: server.command || '',
            script: server.script || '',
            args: parseMcpArgs(server),
            url: server.url || '',
            description: server.description || '',
            tool_prefix: server.tool_prefix || '',
            server_type: server.server_type || 'service',
            tags: server.tags || [],
        };

        if (server.env_input?.trim()) {
            payload.env = JSON.parse(server.env_input);
        }
        if (server.headers_input?.trim()) {
            payload.headers = JSON.parse(server.headers_input);
        }
        return payload;
    };

    const buildMcpPayload = (config: MCPConfig) => ({
        servers: config.servers.map(buildMcpServerPayload),
    });
    const persistMcpConfig = async (config: MCPConfig) => {
        await saveMcpConfigViaRuntime(buildMcpPayload(config) as never);
    };

    const handleToggleMCPEnabled = async (serverName: string, enabled: boolean) => {
        const nextConfig: MCPConfig = {
            ...mcpConfig,
            servers: mcpConfig.servers.map(server =>
                server.name === serverName ? { ...server, enabled } : server
            ),
        };

        setMcpError(null);
        setPendingToggleServer(serverName);
        setMcpConfig(nextConfig);
        try {
            await persistMcpConfig(nextConfig);
            await loadMCPData({ silent: true });
        } catch (e: unknown) {
            console.error('Failed to update MCP status:', e);
            setMcpError(e instanceof SyntaxError ? t('plugins.invalidJson') : t('plugins.updateFailed'));
            await loadMCPData();
        } finally {
            setPendingToggleServer(null);
        }
    };

    const handleRestartMCPServer = async (serverName: string) => {
        setMcpError(null);
        setPendingRestartServer(serverName);
        try {
            await restartMcpServerViaRuntime(serverName);
            const runtimeServers = await getMcpServersViaRuntime();
            const runtimeServer = runtimeServers.find((item) => item.name === serverName);
            const result = { server: (runtimeServer
                ? { ...runtimeServer, tool_count: runtimeServer.toolCount, host_managed: runtimeServer.hostManaged, status: runtimeServer.connected ? 'connected' : 'disconnected' }
                : { name: serverName, enabled: true }) as unknown as MCPServerStatus };
            setMcpConfig(prev => ({
                ...prev,
                servers: prev.servers.map(server =>
                    server.name === serverName ? { ...server, ...result.server, enabled: result.server.enabled } : server
                ),
            }));
            setMcpServers(prev => prev.map(server => server.name === serverName ? result.server : server));
        } catch (e: unknown) {
            console.error('Failed to reconnect MCP server:', e);
            setMcpError(t('plugins.reconnectFailed'));
            await loadMCPData();
        } finally {
            setPendingRestartServer(null);
        }
    };

    const handleSaveMCP = async () => {
        setIsSavingMCP(true);
        setMcpError(null);
        try {
            await persistMcpConfig(mcpConfig);
            void loadMCPData({ silent: true });
        } catch (e: unknown) {
            console.error('Failed to save MCP configuration:', e);
            setMcpError(e instanceof SyntaxError ? t('plugins.invalidJson') : t('plugins.saveFailed'));
        } finally {
            setIsSavingMCP(false);
        }
    };

    const handleTestMCP = async () => {
        if (selectedMcpServer === null) return;
        const server = mcpConfig.servers[selectedMcpServer];
        setIsTestingMCP(true);
        setMcpTestResult(null);
        try {
            const testResult = await testMcpServerViaRuntime(String(server.name ?? ''));
            const result = { success: testResult.ok, message: testResult.message };
            setMcpTestResult(result);
            await loadMCPData();
        } catch (e: unknown) {
            console.error('MCP test failed:', e);
            setMcpTestResult({ success: false, message: t('plugins.testFailed') });
        } finally {
            setIsTestingMCP(false);
        }
    };

    const updatePresetValue = (index: number, key: string, value: string | string[], secret: boolean) => {
        setMcpConfig(prev => ({
            ...prev,
            servers: prev.servers.map((server, i) => i !== index ? server : secret
                ? { ...server, field_inputs: { ...(server.field_inputs || {}), [key]: value as string } }
                : { ...server, field_values: { ...(server.field_values || {}), [key]: value } }),
        }));
    };

    const loadSkills = async () => {
        setIsLoadingSkills(true);
        setSkillsError(null);
        try {
            const runtimeSkills = await listSkillsViaRuntime();
            setSkills(runtimeSkills.map((skill) => ({ name: skill.name, description: skill.description || '', location: '', skill_dir: '', source_scope: 'project', allowed_tools: skill.tools })) as never);
        } catch (err) {
            console.error('Failed to load skills:', err);
            setSkills([]);
            setSkillsError(t('plugins.loadSkillsFailed'));
        } finally {
            setIsLoadingSkills(false);
        }
    };

    const displayedMcpServers = mcpServers.map((server, index) => ({
        ...server,
        key: `${server.name || 'server'}-${index}`,
        connected: server.enabled ? Boolean(server.connected) : false,
        tool_count: server.enabled ? (server.tool_count ?? 0) : 0,
    }));
    const filteredSkills = skills.filter((skill) => !skillQuery || skill.name.toLowerCase().includes(skillQuery.toLowerCase()) || (skill.description || '').toLowerCase().includes(skillQuery.toLowerCase()));

    const isHostManaged = (server: MCPServerStatus) => Boolean(server.host_managed);

    const getServerStatusMeta = (server: MCPServerStatus) => {
        if (isHostManaged(server) && !server.enabled) {
            return { label: t('plugins.notConfigured'), fg: 'var(--muted-foreground)', bg: 'var(--muted)' };
        }
        const status = !server.enabled ? 'disabled' : (server.status || (server.connected ? 'connected' : 'disconnected'));
        if (status === 'connected') {
            return { label: t('plugins.connected'), fg: 'var(--success)', bg: 'var(--success-soft)', live: true };
        }
        if (status === 'connecting') {
            return { label: t('plugins.connecting'), fg: 'var(--link)', bg: 'var(--link-soft)' };
        }
        if (status === 'error') {
            return { label: t('plugins.error'), fg: 'var(--destructive)', bg: 'var(--destructive-soft)' };
        }
        if (status === 'disabled') {
            return { label: t('plugins.disabled'), fg: 'var(--muted-foreground)', bg: 'var(--muted)' };
        }
        return { label: t('plugins.disconnected'), fg: 'var(--warning)', bg: 'var(--warning-soft)' };
    };

    return (
        <section className="flex min-w-0 flex-auto flex-col" aria-labelledby="plugins-page-title">
            <header className="flex h-14 flex-none items-center border-b border-border px-8 max-[720px]:px-4 [&_h1]:m-0 [&_h1]:text-[1rem] [&_h1]:font-semibold [&_h1]:text-foreground">
                <h1 id="plugins-page-title">{tab === 'MCP' ? t('plugins.mcp') : t('plugins.skills')}</h1>
            </header>

            <div className={cn('scrollable-area min-w-0 max-[420px]:p-3 [&_input]:max-w-full [&_select]:max-w-full [&_textarea]:max-w-full', 'flex min-h-0 flex-auto flex-col overflow-y-auto p-8 max-[720px]:p-4 [&>*]:w-full [&>*]:max-w-[960px]')}>
                {/* MCP */}
                {tab === 'MCP' && (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <PaneTabs label={t('plugins.mcp')} value={mcpTab} onChange={setMcpTab} items={[{ value: '已安装', label: t('plugins.installed') }, { value: '设置', label: t('plugins.settings') }]} />

                        <div className="mb-6 flex flex-wrap items-start justify-between gap-3 min-[721px]:flex-nowrap min-[721px]:items-center min-[721px]:gap-4">
                            <p className="m-0 max-w-[64ch] text-sm leading-relaxed text-muted-foreground">{t('plugins.mcpDesc')}</p>
                            <div className="flex gap-1">
                                <RevealButton label={t('plugins.refresh')} onClick={() => void loadMCPData()} disabled={isLoadingMCP}>
                                    {isLoadingMCP ? <Loader2 className="size-[17px] animate-spin" aria-hidden="true" /> : <RefreshCw className="size-[17px]" aria-hidden="true" />}
                                </RevealButton>
                                {/* The settings tab's plugin list has its own add button. */}
                                {mcpTab === '已安装' && (
                                    <RevealButton label={t('plugins.add')} onClick={addMcpServer}>
                                        <Plus className="size-[17px]" aria-hidden="true" />
                                    </RevealButton>
                                )}
                            </div>
                        </div>

                        {mcpError && (
                            <div role="alert" aria-live="assertive" className={cn(UI.alert, 'mb-4')} data-tone="error">
                                {mcpError}
                            </div>
                        )}

                        {mcpTab === '已安装' && (
                            <ul className={cn('m-0 grid list-none gap-2.5 p-0', REDUCED_MOTION)}>
                                {displayedMcpServers.length === 0 && (
                                    <li role="status" className="mt-16 text-center text-sm text-muted-foreground">{t('plugins.noServers')}</li>
                                )}
                                {displayedMcpServers.map((server, index) => {
                                    const isToggling = pendingToggleServer === server.name;
                                    const isRestarting = pendingRestartServer === server.name;
                                    const statusMeta = !statusesLoaded && server.enabled
                                        ? { label: t('plugins.connecting'), fg: 'var(--link)', bg: 'var(--link-soft)' }
                                        : getServerStatusMeta(server);
                                    const live = statusesLoaded && server.connected;
                                    const CardIcon = isHostManaged(server) ? Database : server.preset ? PlugZap : Server;
                                    return (
                                        <li
                                            key={server.key}
                                            className="grid animate-rise-sm grid-cols-[auto_minmax(0,1fr)] items-start gap-4 rounded-xl border border-border bg-white p-4 transition-[border-color,box-shadow] [animation-delay:calc(var(--i)*60ms)] hover:border-input hover:shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_24px_-16px_rgba(28,25,23,0.18)] min-[761px]:grid-cols-[auto_minmax(0,1fr)_auto] min-[761px]:items-center min-[761px]:px-5 min-[761px]:py-[18px]"
                                            style={{ '--i': index } as React.CSSProperties}
                                        >
                                            <McpIconTile off={!server.enabled}><CardIcon /></McpIconTile>
                                            <div className="min-w-0">
                                                <div className="mb-1 flex flex-wrap items-center gap-2 text-[0.95rem] font-semibold text-foreground">
                                                    <span className={server.enabled ? undefined : 'text-muted-foreground'}>{server.preset?.title ?? server.name}</span>
                                                    <McpStatus {...statusMeta} live={live} />
                                                    {live && server.tool_count > 0 && (
                                                        <span className="text-xs font-medium text-muted-foreground tabular-nums">{t('plugins.toolCount').replace('{count}', String(server.tool_count))}</span>
                                                    )}
                                                </div>
                                                <p className="m-0 text-[0.85rem] leading-relaxed text-muted-foreground">{server.description || t('plugins.noDesc')}</p>
                                            </div>
                                            <div className="col-start-2 flex gap-2 min-[761px]:col-start-auto">
                                                {isHostManaged(server) ? (
                                                    statusesLoaded && !server.connected && onOpenDatabaseSettings && (
                                                        <McpButton onClick={onOpenDatabaseSettings}>
                                                            {t('plugins.configureDatabase')}
                                                        </McpButton>
                                                    )
                                                ) : (
                                                    <>
                                                        {server.enabled && (
                                                            <McpButton onClick={() => void handleRestartMCPServer(server.name)} disabled={isRestarting || isToggling} busy={isRestarting}>
                                                                {t('plugins.reconnect')}
                                                            </McpButton>
                                                        )}
                                                        <McpButton onClick={() => void handleToggleMCPEnabled(server.name, !server.enabled)} disabled={isToggling || isRestarting} busy={isToggling}>
                                                            {server.enabled ? t('plugins.disable') : t('plugins.enable')}
                                                        </McpButton>
                                                    </>
                                                )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {mcpTab === '设置' && (
                            <McpSettings
                                servers={mcpConfig.servers}
                                selected={selectedMcpServer}
                                onSelect={setSelectedMcpServer}
                                onAdd={addMcpServer}
                                statusOf={(server) => {
                                    const status = displayedMcpServers.find((item) => item.name === server.name);
                                    return status ? getServerStatusMeta(status) : undefined;
                                }}
                                onField={updateMcpServerField}
                                onPresetValue={updatePresetValue}
                                onRemove={removeMcpServer}
                                onSave={() => void handleSaveMCP()}
                                onTest={() => void handleTestMCP()}
                                saving={isSavingMCP}
                                testing={isTestingMCP}
                                testResult={mcpTestResult}
                                t={t}
                            />
                        )}
                    </div>
                )}

                {/* Skills */}
                {tab === 'Skills' && (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <PaneTabs label={t('plugins.skills')} value={skillsTab} onChange={setSkillsTab} items={[{ value: '已安装', label: t('plugins.installed') }, { value: '设置', label: t('plugins.settings') }]} />

                        <div className="mb-6 flex flex-wrap items-start justify-between gap-3 min-[721px]:flex-nowrap min-[721px]:items-center min-[721px]:gap-4">
                            <div className="relative w-[min(320px,100%)] [&_input]:pl-9 [&_svg]:pointer-events-none [&_svg]:absolute [&_svg]:top-1/2 [&_svg]:left-3 [&_svg]:-translate-y-1/2 [&_svg]:text-faint">
                                <Search className="size-[15px]" aria-hidden="true" />
                                <input className={UI.input} type="search" placeholder={t('plugins.searchSkill') || "搜索 Skill"} value={skillQuery} onChange={e => setSkillQuery(e.target.value)} aria-label={t('plugins.searchSkill') || '搜索 Skill'} />
                            </div>
                            <RevealButton label={t('plugins.refresh')} onClick={loadSkills}>
                                <RefreshCw className="size-[17px]" aria-hidden="true" />
                            </RevealButton>
                        </div>

                        {skillsError ? (
                            <div role="alert" aria-live="assertive" className={cn(UI.alert, 'mb-4')} data-tone="error">{skillsError}</div>
                        ) : null}
                        {isLoadingSkills ? (
                            <div role="status" className="mt-16 text-center text-[0.875rem] text-muted-foreground">{t('plugins.loadingSkills')}</div>
                        ) : skills.length === 0 ? (
                            <div role="status" className="mt-16 text-center text-[0.875rem] text-muted-foreground">
                                {t('plugins.noSkills')}
                            </div>
                        ) : filteredSkills.length === 0 ? (
                            <div role="status" className="mt-16 text-center text-[0.875rem] text-muted-foreground">
                                {t('plugins.noSearchResults')}
                            </div>
                        ) : (
                            <ul className="m-0 grid list-none gap-2.5 p-0">
                                {filteredSkills.map((skill, index) => (
                                    <li key={skill.name} className="grid animate-rise-sm grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4 rounded-xl border border-border bg-white px-5 py-[18px] transition-[border-color,box-shadow] [animation-delay:calc(var(--i)*50ms)] hover:border-input hover:shadow-[0_1px_2px_rgba(28,25,23,0.04),0_8px_24px_-16px_rgba(28,25,23,0.18)] motion-reduce:animate-none motion-reduce:transition-none max-[720px]:grid-cols-[auto_minmax(0,1fr)] max-[720px]:[&>:last-child]:col-start-2" style={{ '--i': index } as React.CSSProperties}>
                                        <span className={UI.cardIcon} aria-hidden="true"><Sparkles className="size-[18px]" /></span>
                                        <div>
                                            <div className="font-mono text-[0.9rem] font-[650] text-foreground">{skill.name}</div>
                                            <p className="mt-1 mb-0 text-[0.85rem] leading-[1.6] text-muted-foreground">{skill.description}</p>
                                            {skill.when_to_use && (
                                                <p className="mt-2.5 mb-0 text-[0.8rem] leading-[1.6] break-all text-body [&_span]:text-muted-foreground"><span>{t('plugins.whenToUse')}：</span>{skill.when_to_use}</p>
                                            )}
                                            {/* The runtime's skill list carries no file location; show the row only when one is known. */}
                                            {skill.location && (
                                                <p className={cn(UI.mono, 'mt-2.5 mb-0 text-[0.8rem] leading-[1.6] break-all text-body [&_span]:text-muted-foreground')}><span>{t('plugins.path')}：</span>{skill.location}</p>
                                            )}
                                        </div>
                                        <span className={UI.pill}>{skill.source_scope}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
};

export default PluginsPanel;
