import React from 'react';
import { Check, ExternalLink, Loader2, Plus, PlugZap, Server, Terminal } from '../icons/Typicons';
import type { MCPPreset, MCPPresetField, MCPServerConfig } from '../../api/client';
import './mcp-settings.css';

export interface McpStatusMeta {
    label: string;
    fg: string;
    bg: string;
}

interface McpSettingsProps {
    servers: MCPServerConfig[];
    selected: number | null;
    onSelect: (index: number) => void;
    onAdd: () => void;
    statusOf: (server: MCPServerConfig) => McpStatusMeta | undefined;
    onField: (index: number, field: keyof MCPServerConfig, value: MCPServerConfig[keyof MCPServerConfig]) => void;
    onPresetValue: (index: number, key: string, value: string | string[], secret: boolean) => void;
    onRemove: (index: number) => void;
    onSave: () => void;
    onTest: () => void;
    saving: boolean;
    testing: boolean;
    testResult: { success: boolean; message: string } | null;
    t: (key: string) => string;
}

const TRANSPORTS: Array<{ value: MCPServerConfig['transport']; labelKey: string; captionKey: string }> = [
    { value: 'stdio', labelKey: 'stdio', captionKey: 'plugins.transportStdio' },
    { value: 'http', labelKey: 'HTTP', captionKey: 'plugins.transportHttp' },
    { value: 'sse', labelKey: 'SSE', captionKey: 'plugins.transportSse' },
];

function subtitle(server: MCPServerConfig, t: (key: string) => string): string {
    if (server.preset) return t('plugins.preset');
    return server.transport === 'stdio' ? t('plugins.transportStdio') : server.transport === 'sse' ? t('plugins.transportSse') : t('plugins.transportHttp');
}

/** The MCP settings tab: plugins on the left, the selected one's form on the right. */
const McpSettings: React.FC<McpSettingsProps> = (props) => {
    const { servers, selected, onSelect, onAdd, statusOf, t } = props;
    const server = selected === null ? undefined : servers[selected];
    return (
        <div className="mcp-settings">
            <aside className="mcp-list" aria-label={t('plugins.listTitle')}>
                <div className="mcp-list-head">
                    <span>{t('plugins.listTitle')}</span>
                    <button type="button" className="mcp-icon-btn" onClick={onAdd} aria-label={t('plugins.add')} title={t('plugins.add')}>
                        <Plus size={15} aria-hidden="true" />
                    </button>
                </div>
                {servers.length === 0 && <p className="mcp-list-empty">{t('plugins.noSrvHint')}</p>}
                <ul>
                    {servers.map((item, index) => {
                        const status = statusOf(item);
                        return (
                            <li key={`${item.name || 'new'}-${index}`}>
                                <button type="button" className="mcp-list-item" aria-current={selected === index ? 'true' : undefined} onClick={() => onSelect(index)}>
                                    <span className="mcp-dot" style={{ background: item.enabled ? (status?.fg ?? '#a8a29e') : '#d6d3d1' }} aria-hidden="true" />
                                    <span className="mcp-list-text">
                                        <span className="mcp-list-title">{item.preset?.title ?? (item.name || t('plugins.unnamedSrv'))}</span>
                                        <span className="mcp-list-sub">{subtitle(item, t)}</span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </aside>

            <section className="mcp-editor">
                {!server || selected === null ? (
                    <div className="mcp-editor-empty">{t('plugins.selectHint')}</div>
                ) : (
                    <Editor {...props} server={server} index={selected} />
                )}
            </section>
        </div>
    );
};

const Editor: React.FC<McpSettingsProps & { server: MCPServerConfig; index: number }> = ({ server, index, statusOf, onField, onRemove, onSave, onTest, saving, testing, testResult, t, onPresetValue }) => {
    const status = statusOf(server);
    const Icon = server.preset ? PlugZap : server.transport === 'stdio' ? Terminal : Server;
    return (
        <>
            <header className="mcp-editor-head">
                <span className="mcp-editor-icon" aria-hidden="true"><Icon size={18} /></span>
                <div className="mcp-editor-title">
                    <h4>{server.preset?.title ?? (server.name || t('plugins.unnamedSrv'))}</h4>
                    <div className="mcp-editor-meta">
                        {server.preset && <span className="mcp-badge">{t('plugins.preset')}</span>}
                        {status && <span className="mcp-status" style={{ color: status.fg, background: status.bg }}>{status.label}</span>}
                    </div>
                </div>
                <label className="mcp-switch">
                    <input type="checkbox" role="switch" checked={server.enabled} onChange={(e) => onField(index, 'enabled', e.target.checked)} />
                    <span className="mcp-switch-track" aria-hidden="true"><span className="mcp-switch-thumb" /></span>
                    <span className="mcp-switch-label">{t('plugins.enableServer')}</span>
                </label>
            </header>

            <div className="mcp-editor-body">
                {server.preset
                    ? <PresetForm preset={server.preset} server={server} index={index} onPresetValue={onPresetValue} t={t} />
                    : <CustomForm server={server} index={index} onField={onField} onRemove={onRemove} t={t} />}
            </div>

            <footer className="mcp-editor-foot">
                <div className="mcp-test-result" role={testResult ? (testResult.success ? 'status' : 'alert') : undefined} aria-live="polite">
                    {testResult && (
                        <span className={testResult.success ? 'is-ok' : 'is-error'}>
                            {testResult.success ? <Check size={14} aria-hidden="true" /> : null}
                            {testResult.message}
                        </span>
                    )}
                </div>
                <button type="button" className="mcp-btn" onClick={onTest} disabled={testing}>
                    {testing && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                    {t('plugins.test')}
                </button>
                <button type="button" className="mcp-btn mcp-btn-primary" onClick={onSave} disabled={saving}>
                    {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                    {t('plugins.saveConfig')}
                </button>
            </footer>
        </>
    );
};

const PresetForm: React.FC<{ preset: MCPPreset; server: MCPServerConfig; index: number; onPresetValue: McpSettingsProps['onPresetValue']; t: McpSettingsProps['t'] }> = ({ preset, server, index, onPresetValue, t }) => (
    <>
        <p className="mcp-lead">{preset.description}</p>
        {preset.fields.map((field) => field.kind === 'choices'
            ? <ChoiceField key={field.key} field={field} server={server} index={index} onPresetValue={onPresetValue} />
            : <TextField key={field.key} presetId={preset.id} field={field} server={server} index={index} onPresetValue={onPresetValue} t={t} />)}
    </>
);

const TextField: React.FC<{ presetId: string; field: MCPPresetField; server: MCPServerConfig; index: number; onPresetValue: McpSettingsProps['onPresetValue']; t: McpSettingsProps['t'] }> = ({ presetId, field, server, index, onPresetValue, t }) => {
    const id = `mcp-preset-${presetId}-${field.key}`;
    const secret = field.kind === 'secret';
    const value = secret ? (server.field_inputs?.[field.key] ?? '') : String(server.field_values?.[field.key] ?? '');
    return (
        <div className="mcp-field">
            <div className="mcp-field-head">
                <label htmlFor={id}>{field.label}{field.required && <span className="mcp-required" aria-hidden="true">*</span>}</label>
                {secret && field.configured && <span className="mcp-configured"><Check size={12} aria-hidden="true" />{t('plugins.secretConfigured')}</span>}
                {field.link && (
                    <a className="mcp-link" href={field.link.url} target="_blank" rel="noreferrer">
                        {field.link.label}<ExternalLink size={12} aria-hidden="true" />
                    </a>
                )}
            </div>
            <input
                id={id}
                className="mcp-input"
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => onPresetValue(index, field.key, e.target.value, secret)}
                placeholder={secret && field.configured ? t('plugins.secretKeep') : (field.placeholder || '')}
            />
            {field.help && <p className="mcp-help">{field.help}</p>}
        </div>
    );
};

const ChoiceField: React.FC<{ field: MCPPresetField; server: MCPServerConfig; index: number; onPresetValue: McpSettingsProps['onPresetValue'] }> = ({ field, server, index, onPresetValue }) => {
    const saved = server.field_values?.[field.key];
    const chosen = Array.isArray(saved) ? saved : (field.defaultValue || []);
    return (
        <fieldset className="mcp-field">
            <legend className="mcp-field-head">{field.label}{field.required && <span className="mcp-required" aria-hidden="true">*</span>}</legend>
            <div className="mcp-choices">
                {(field.choices || []).map((choice) => {
                    const on = chosen.includes(choice.value);
                    return (
                        <label key={choice.value} className="mcp-choice" data-checked={on ? 'true' : undefined}>
                            <input
                                type="checkbox"
                                checked={on}
                                onChange={(e) => onPresetValue(index, field.key, e.target.checked ? [...chosen, choice.value] : chosen.filter((value) => value !== choice.value), false)}
                            />
                            <span className="mcp-choice-box" aria-hidden="true"><Check size={11} /></span>
                            <span className="mcp-choice-text">
                                <span className="mcp-choice-label">{choice.label}</span>
                                {choice.detail && <span className="mcp-choice-detail">{choice.detail}</span>}
                            </span>
                        </label>
                    );
                })}
            </div>
            {field.help && <p className="mcp-help">{field.help}</p>}
        </fieldset>
    );
};

const CustomForm: React.FC<{ server: MCPServerConfig; index: number; onField: McpSettingsProps['onField']; onRemove: McpSettingsProps['onRemove']; t: McpSettingsProps['t'] }> = ({ server, index, onField, onRemove, t }) => {
    const stdio = server.transport === 'stdio';
    const text = (id: string, label: string, field: keyof MCPServerConfig, placeholder: string, required = false) => (
        <div className="mcp-field">
            <div className="mcp-field-head"><label htmlFor={id}>{label}{required && <span className="mcp-required" aria-hidden="true">*</span>}</label></div>
            <input id={id} className="mcp-input" value={String(server[field] ?? '')} onChange={(e) => onField(index, field, e.target.value)} placeholder={placeholder} spellCheck={false} />
        </div>
    );
    const mapping = (id: string, label: string, field: 'env_input' | 'headers_input', summary: MCPServerConfig['env'], placeholder: string) => (
        <div className="mcp-field">
            <div className="mcp-field-head">
                <label htmlFor={id}>{label}</label>
                {summary?.configured && <span className="mcp-configured"><Check size={12} aria-hidden="true" />{t('plugins.configured').replace('{count}', String(summary.count))}</span>}
            </div>
            <textarea id={id} className="mcp-input mcp-code" rows={3} value={server[field] ?? ''} onChange={(e) => onField(index, field, e.target.value)} placeholder={placeholder} spellCheck={false} />
        </div>
    );
    return (
        <>
            <div className="mcp-group">
                {text('mcp-server-name', t('plugins.name'), 'name', 'my-server', true)}
                <div className="mcp-field">
                    <div className="mcp-field-head"><span id="mcp-transport-label">{t('plugins.transport')}</span></div>
                    <div className="mcp-segmented" role="radiogroup" aria-labelledby="mcp-transport-label">
                        {TRANSPORTS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={server.transport === option.value || (option.value === 'http' && server.transport === 'streamable-http')}
                                onClick={() => onField(index, 'transport', option.value)}
                            >
                                <span>{option.labelKey}</span>
                                <small>{t(option.captionKey)}</small>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="mcp-group">
                <h5 className="mcp-group-title">{t('plugins.sectionConnection')}</h5>
                {stdio ? (
                    <>
                        <div className="mcp-row">
                            {text('mcp-server-command', t('plugins.command'), 'command', 'npx / python')}
                            {text('mcp-server-script', t('plugins.scriptArgs'), 'script', 'server.py')}
                        </div>
                        <div className="mcp-field">
                            <div className="mcp-field-head"><label htmlFor="mcp-server-args">{t('plugins.arguments')}</label></div>
                            <input
                                id="mcp-server-args"
                                className="mcp-input mcp-code"
                                value={server.args_input ?? JSON.stringify(server.args || [])}
                                onChange={(e) => onField(index, 'args_input', e.target.value)}
                                placeholder='["-y", "some-mcp-server"]'
                                spellCheck={false}
                            />
                        </div>
                        {mapping('mcp-server-env', t('plugins.environment'), 'env_input', server.env, '{"API_KEY": "..."}')}
                    </>
                ) : (
                    <>
                        {text('mcp-server-url', t('plugins.url'), 'url', 'https://example.com/mcp', true)}
                        {mapping('mcp-server-headers', t('plugins.headers'), 'headers_input', server.headers, '{"Authorization": "Bearer ..."}')}
                    </>
                )}
            </div>

            <details className="mcp-advanced">
                <summary>{t('plugins.sectionAdvanced')}</summary>
                <div className="mcp-group">
                    {text('mcp-server-description', t('plugins.description'), 'description', t('plugins.descriptionPlaceholder'))}
                    <div className="mcp-row">
                        {text('mcp-server-tool-prefix', t('plugins.toolPrefix'), 'tool_prefix', 'db')}
                        {text('mcp-server-type', t('plugins.serverType'), 'server_type', 'service')}
                    </div>
                    <button type="button" className="mcp-danger" onClick={() => onRemove(index)}>{t('plugins.deleteConfig')}</button>
                </div>
            </details>
        </>
    );
};

export default McpSettings;
