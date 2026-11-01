import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Plus, Loader2, Database, PlugZap, Server } from './icons/Typicons';
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

export type PluginsTab = 'MCP' | 'Skills';

interface PluginsPanelProps {
    tab: PluginsTab;
    /** Opens Settings → Database, where the database server is configured. */
    onOpenDatabaseSettings?: () => void;
}

/** MCP and Skills management shown in the main pane; the sidebar picks the tab. */
const PluginsPanel: React.FC<PluginsPanelProps> = ({ tab, onOpenDatabaseSettings }) => {
    const { t } = useLanguage();
    // States for sub-tabs
    const [mcpTab, setMcpTab] = useState('已安装');
    const [skillsTab, setSkillsTab] = useState('已安装');

    // MCP states
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
    
    // Skills states
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
            return { label: t('plugins.notConfigured'), fg: '#6b7280', bg: '#f3f4f6' };
        }
        const status = !server.enabled ? 'disabled' : (server.status || (server.connected ? 'connected' : 'disconnected'));
        if (status === 'connected') {
            return { label: t('plugins.connected'), fg: '#047857', bg: '#ecfdf5', live: true };
        }
        if (status === 'connecting') {
            return { label: t('plugins.connecting'), fg: '#1d4ed8', bg: '#eff6ff' };
        }
        if (status === 'error') {
            return { label: t('plugins.error'), fg: '#b91c1c', bg: '#fef2f2' };
        }
        if (status === 'disabled') {
            return { label: t('plugins.disabled'), fg: '#6b7280', bg: '#f3f4f6' };
        }
        return { label: t('plugins.disconnected'), fg: '#b45309', bg: '#fffbeb' };
    };

    return (
        <section className="workspace-page plugins-page" aria-labelledby="plugins-page-title">
            <header className="workspace-page-header">
                <h1 id="plugins-page-title">{tab === 'MCP' ? t('plugins.mcp') : t('plugins.skills')}</h1>
            </header>

            <div className="workspace-page-body plugins-page-body scrollable-area">
                {/* MCP */}
                {tab === 'MCP' && (
                    <div style={{ display: 'flex', flex: 1, flexDirection: 'column' }}>
                        <div className="plugins-tab-list" role="tablist" aria-label={t('plugins.mcp')}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mcpTab === '已安装'}
                                className="plugins-tab"
                                onClick={() => setMcpTab('已安装')}
                            >
                                {t('plugins.installed')}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={mcpTab === '设置'}
                                className="plugins-tab"
                                onClick={() => setMcpTab('设置')}
                            >
                                {t('plugins.settings')}
                            </button>
                        </div>

                        <div className="plugins-mcp-toolbar">
                            <p className="plugins-lead">{t('plugins.mcpDesc')}</p>
                            <div className="plugins-toolbar-actions">
                                <button
                                    type="button"
                                    className="icon-reveal-btn"
                                    onClick={() => void loadMCPData()}
                                    disabled={isLoadingMCP}
                                    aria-label={t('plugins.refresh')}
                                >
                                    {isLoadingMCP ? <Loader2 size={17} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={17} aria-hidden="true" />}
                                    <span className="header-icon-label" aria-hidden="true">{t('plugins.refresh')}</span>
                                </button>
                                {/* The settings tab's plugin list has its own add button. */}
                                {mcpTab === '已安装' && (
                                    <button type="button" className="icon-reveal-btn" onClick={addMcpServer} aria-label={t('plugins.add')}>
                                        <Plus size={17} aria-hidden="true" />
                                        <span className="header-icon-label" aria-hidden="true">{t('plugins.add')}</span>
                                    </button>
                                )}
                            </div>
                        </div>

                        {mcpError && (
                            <div role="alert" aria-live="assertive" style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '10px', border: '1px solid #fecaca', background: '#fff1f2', color: '#b91c1c', fontSize: '0.85rem' }}>
                                {mcpError}
                            </div>
                        )}

                        {mcpTab === '已安装' && (
                            <ul className="mcp-cards">
                                {displayedMcpServers.length === 0 && (
                                    <li role="status" className="mcp-cards-empty">{t('plugins.noServers')}</li>
                                )}
                                {displayedMcpServers.map((server, index) => {
                                    const isToggling = pendingToggleServer === server.name;
                                    const isRestarting = pendingRestartServer === server.name;
                                    const statusMeta = !statusesLoaded && server.enabled
                                        ? { label: t('plugins.connecting'), fg: '#1d4ed8', bg: '#eff6ff' }
                                        : getServerStatusMeta(server);
                                    const live = statusesLoaded && server.connected;
                                    const CardIcon = isHostManaged(server) ? Database : server.preset ? PlugZap : Server;
                                    return (
                                        <li key={server.key} className="mcp-card" data-off={server.enabled ? undefined : 'true'} style={{ '--i': index } as React.CSSProperties}>
                                            <span className="mcp-card-icon" aria-hidden="true"><CardIcon size={18} /></span>
                                            <div className="mcp-card-main">
                                                <div className="mcp-card-title">
                                                    <span>{server.preset?.title ?? server.name}</span>
                                                    <span className="mcp-status" data-live={live ? 'true' : undefined} style={{ color: statusMeta.fg, background: statusMeta.bg }}>{statusMeta.label}</span>
                                                    {live && server.tool_count > 0 && (
                                                        <span className="mcp-card-count">{t('plugins.toolCount').replace('{count}', String(server.tool_count))}</span>
                                                    )}
                                                </div>
                                                <p className="mcp-card-desc">{server.description || t('plugins.noDesc')}</p>
                                            </div>
                                            <div className="mcp-card-actions">
                                                {isHostManaged(server) ? (
                                                    statusesLoaded && !server.connected && onOpenDatabaseSettings && (
                                                        <button type="button" className="mcp-btn" onClick={onOpenDatabaseSettings}>
                                                            {t('plugins.configureDatabase')}
                                                        </button>
                                                    )
                                                ) : (
                                                    <>
                                                        {server.enabled && (
                                                            <button type="button" className="mcp-btn" onClick={() => void handleRestartMCPServer(server.name)} disabled={isRestarting || isToggling}>
                                                                {isRestarting && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                                                                {t('plugins.reconnect')}
                                                            </button>
                                                        )}
                                                        <button type="button" className="mcp-btn" onClick={() => void handleToggleMCPEnabled(server.name, !server.enabled)} disabled={isToggling || isRestarting}>
                                                            {isToggling && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                                                            {server.enabled ? t('plugins.disable') : t('plugins.enable')}
                                                        </button>
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
                    <div style={{ display: 'flex', flex: 1, flexDirection: 'column' }}>
                        <div className="plugins-tab-list" role="tablist" aria-label={t('plugins.skills')}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={skillsTab === '已安装'}
                                className="plugins-tab"
                                onClick={() => setSkillsTab('已安装')}
                            >
                                {t('plugins.installed')}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={skillsTab === '设置'}
                                className="plugins-tab"
                                onClick={() => setSkillsTab('设置')}
                            >
                                {t('plugins.settings')}
                            </button>
                        </div>

                        <div className="plugins-skills-toolbar">
                            <div className="plugins-search-box" style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px 16px', display: 'flex', alignItems: 'center', width: '300px' }}>
                                <Search size={16} color="#9ca3af" style={{ marginRight: '8px' }} />
                                <input placeholder={t('plugins.searchSkill') || "搜索 Skill"} value={skillQuery} onChange={e => setSkillQuery(e.target.value)} aria-label={t('plugins.searchSkill') || '搜索 Skill'} style={{ border: 'none', background: 'transparent', outline: 'none', width: '100%', fontSize: '0.85rem' }} />
                            </div>
                            <button type="button" className="icon-reveal-btn" onClick={loadSkills} aria-label={t('plugins.refresh')}>
                                <RefreshCw size={17} aria-hidden="true" />
                                <span className="header-icon-label" aria-hidden="true">{t('plugins.refresh')}</span>
                            </button>
                        </div>

                        {skillsError ? (
                            <div role="alert" aria-live="assertive" style={{ marginBottom: '16px', padding: '10px 12px', borderRadius: '10px', border: '1px solid #fecaca', background: '#fff1f2', color: '#b91c1c', fontSize: '0.85rem' }}>{skillsError}</div>
                        ) : null}
                        {isLoadingSkills ? (
                            <div role="status" style={{ textAlign: 'center', color: '#6b7280', marginTop: '64px' }}>{t('plugins.loadingSkills')}</div>
                        ) : skills.length === 0 ? (
                            <div role="status" style={{ textAlign: 'center', color: '#6b7280', marginTop: '64px' }}>
                                {t('plugins.noSkills')}
                            </div>
                        ) : filteredSkills.length === 0 ? (
                            <div role="status" style={{ textAlign: 'center', color: '#6b7280', marginTop: '64px' }}>
                                {t('plugins.noSearchResults')}
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {filteredSkills.map(skill => (
                                    <div key={skill.name} style={{ border: '1px solid #e5e7eb', borderRadius: '12px', padding: '16px', background: '#fff' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                                            <div>
                                                <div style={{ fontWeight: 700, color: '#1f2937' }}>{skill.name}</div>
                                                <div style={{ fontSize: '0.9rem', color: '#6b7280', marginTop: '4px' }}>{skill.description}</div>
                                            </div>
                                            <div style={{ fontSize: '0.8rem', color: '#6b7280' }}>{skill.source_scope}</div>
                                        </div>
                                        {skill.when_to_use && (
                                            <div style={{ fontSize: '0.85rem', color: '#374151', marginTop: '10px' }}>{t('plugins.whenToUse')}：{skill.when_to_use}</div>
                                        )}
                                        {/* The runtime's skill list carries no file location; show the row only when one is known. */}
                                        {skill.location && (
                                            <div style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '10px', wordBreak: 'break-all' }}>{t('plugins.path')}：{skill.location}</div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
};

export default PluginsPanel;
