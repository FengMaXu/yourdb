import React, { useState } from 'react';
import { Check, ChevronRight, ExternalLink, Plus, PlugZap, Server, Terminal } from 'lucide-react';
import type { MCPPreset, MCPPresetField, MCPServerConfig } from '../../api/client';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { MCP_CODE, MCP_INPUT, McpBadge, McpButton, McpDot, McpIconTile, McpStatus, REDUCED_MOTION } from './parts';

export interface McpStatusMeta {
    label: string;
    fg: string;
    bg: string;
    /** Connected and serving tools; drawn with a soft pulse. */
    live?: boolean;
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

const BRAND_FOCUS = 'focus-visible:outline-2 focus-visible:outline-brand';
const FIELD = 'm-0 flex min-w-0 flex-col gap-2 border-0 p-0';
const FIELD_HEAD = 'flex w-full flex-wrap items-center gap-x-2 gap-y-1 p-0 text-[0.85rem] font-semibold text-foreground';
const HELP = 'm-0 text-[0.78rem] leading-relaxed text-muted-foreground';
const GROUP = 'flex flex-col gap-[18px]';
const ROW = 'grid grid-cols-1 gap-3.5 min-[761px]:grid-cols-2';

function subtitle(server: MCPServerConfig, t: (key: string) => string): string {
    if (server.preset) return t('plugins.preset');
    return server.transport === 'stdio' ? t('plugins.transportStdio') : server.transport === 'sse' ? t('plugins.transportSse') : t('plugins.transportHttp');
}

function Required() {
    return <span className="ml-[3px] text-brand" aria-hidden="true">*</span>;
}

function Configured({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex h-5 items-center gap-[3px] rounded-full bg-success-soft pr-[7px] pl-[5px] text-[0.72rem] font-[550] whitespace-nowrap text-success">
            <Check className="size-3" aria-hidden="true" />{children}
        </span>
    );
}

/** The MCP settings tab: plugins on the left, the selected one's form on the right. */
const McpSettings: React.FC<McpSettingsProps> = (props) => {
    const { servers, selected, onSelect, onAdd, statusOf, t } = props;
    const server = selected === null ? undefined : servers[selected];
    return (
        // overflow-clip, not hidden: the footer below must stick to the page's scroller.
        <div className={cn('grid min-h-0 flex-1 grid-cols-1 overflow-clip rounded-2xl border border-border bg-white min-[761px]:grid-cols-[232px_minmax(0,1fr)]', REDUCED_MOTION)}>
            <aside className="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-b border-border bg-paper px-2.5 py-3 min-[761px]:border-r min-[761px]:border-b-0" aria-label={t('plugins.listTitle')}>
                <div className="flex items-center justify-between pt-0.5 pr-1 pb-2 pl-2 text-xs font-semibold text-muted-foreground">
                    <span>{t('plugins.listTitle')}</span>
                    <button
                        type="button"
                        className={cn('inline-grid size-[26px] place-items-center rounded-md text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.92] focus-visible:outline-offset-1', BRAND_FOCUS)}
                        onClick={onAdd}
                        aria-label={t('plugins.add')}
                        title={t('plugins.add')}
                    >
                        <Plus className="size-[15px]" aria-hidden="true" />
                    </button>
                </div>
                {servers.length === 0 && <p className="m-2 text-[0.8rem] leading-[1.55] text-muted-foreground">{t('plugins.noSrvHint')}</p>}
                <ul className="m-0 grid list-none auto-cols-[minmax(160px,max-content)] grid-flow-col gap-0.5 overflow-x-auto p-0 pb-0.5 min-[761px]:auto-cols-auto min-[761px]:grid-flow-row min-[761px]:grid-cols-1 min-[761px]:overflow-x-visible min-[761px]:pb-0">
                    {servers.map((item, index) => {
                        const status = statusOf(item);
                        return (
                            <li key={`${item.name || 'new'}-${index}`}>
                                <button
                                    type="button"
                                    className={cn(
                                        'relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-[9px] text-left transition-[background-color,box-shadow] hover:bg-hover focus-visible:outline-offset-1',
                                        'aria-[current=true]:bg-white aria-[current=true]:shadow-[0_0_0_1px_var(--border),0_1px_2px_rgba(28,25,23,0.05),0_4px_12px_-8px_rgba(28,25,23,0.16)]',
                                        BRAND_FOCUS,
                                    )}
                                    aria-current={selected === index ? 'true' : undefined}
                                    onClick={() => onSelect(index)}
                                >
                                    <McpDot color={item.enabled ? (status?.fg ?? 'var(--faint)') : 'var(--border-strong)'} live={item.enabled && status?.live} />
                                    <span className="grid min-w-0 gap-px">
                                        <span className="truncate text-sm font-semibold text-foreground">{item.preset?.title ?? (item.name || t('plugins.unnamedSrv'))}</span>
                                        <span className="text-xs text-muted-foreground">{subtitle(item, t)}</span>
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </aside>

            <section className="flex min-h-0 min-w-0 flex-col">
                {!server || selected === null ? (
                    <div className="m-auto px-6 py-12 text-sm text-muted-foreground">{t('plugins.selectHint')}</div>
                ) : (
                    <Editor key={selected} {...props} server={server} index={selected} />
                )}
            </section>
        </div>
    );
};

const Editor: React.FC<McpSettingsProps & { server: MCPServerConfig; index: number }> = ({ server, index, statusOf, onField, onRemove, onSave, onTest, saving, testing, testResult, t, onPresetValue }) => {
    const status = statusOf(server);
    const Icon = server.preset ? PlugZap : server.transport === 'stdio' ? Terminal : Server;
    const switchId = `mcp-enabled-${index}`;
    return (
        <>
            <header className="flex animate-fade flex-wrap items-center gap-3.5 border-b border-border px-4 py-5 min-[761px]:flex-nowrap min-[761px]:px-7">
                <McpIconTile><Icon /></McpIconTile>
                <div className="min-w-0 flex-1">
                    <h4 className="mb-1.5 text-[1.1rem] leading-tight font-[650] tracking-[-0.005em] text-foreground">{server.preset?.title ?? (server.name || t('plugins.unnamedSrv'))}</h4>
                    <div className="flex flex-wrap gap-1.5">
                        {server.preset && <McpBadge>{t('plugins.preset')}</McpBadge>}
                        {status && <McpStatus {...status} />}
                    </div>
                </div>
                <div className="flex basis-full items-center gap-2.5 min-[761px]:basis-auto">
                    <Switch
                        id={switchId}
                        checked={server.enabled}
                        onCheckedChange={(checked) => onField(index, 'enabled', checked)}
                        className="data-[size=default]:h-5 data-[size=default]:w-9 data-checked:bg-brand data-unchecked:bg-border-strong hover:data-unchecked:bg-border-strong focus-visible:border-transparent focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    />
                    <label htmlFor={switchId} className="cursor-pointer text-[0.85rem] text-foreground select-none">{t('plugins.enableServer')}</label>
                </div>
            </header>

            <div className="flex flex-1 animate-rise-sm flex-col gap-7 overflow-y-auto px-4 pt-6 pb-8 [animation-duration:320ms] min-[761px]:px-7 [&>*]:max-w-[680px]">
                {server.preset
                    ? <PresetForm preset={server.preset} server={server} index={index} onPresetValue={onPresetValue} t={t} />
                    : <CustomForm server={server} index={index} onField={onField} onRemove={onRemove} t={t} />}
            </div>

            {/* Flush with the page scroller's edge, past its bottom padding (32px, 16px on a narrow screen). */}
            <footer className="sticky -bottom-4 z-[1] flex flex-wrap items-center gap-2.5 border-t border-border bg-paper/92 px-4 py-3.5 backdrop-blur-[8px] min-[721px]:-bottom-8 min-[761px]:flex-nowrap min-[761px]:px-7">
                <div className="min-w-0 flex-1 basis-full text-[0.82rem] min-[761px]:basis-auto" role={testResult ? (testResult.success ? 'status' : 'alert') : undefined} aria-live="polite">
                    {testResult && (
                        <span className={cn('inline-flex animate-rise-sm items-center gap-[5px] break-words [animation-duration:260ms]', testResult.success ? 'text-success' : 'text-destructive')}>
                            {testResult.success ? <Check className="size-3.5" aria-hidden="true" /> : null}
                            {testResult.message}
                        </span>
                    )}
                </div>
                <McpButton onClick={onTest} disabled={testing} busy={testing}>{t('plugins.test')}</McpButton>
                <McpButton primary onClick={onSave} disabled={saving} busy={saving}>{t('plugins.saveConfig')}</McpButton>
            </footer>
        </>
    );
};

const PresetForm: React.FC<{ preset: MCPPreset; server: MCPServerConfig; index: number; onPresetValue: McpSettingsProps['onPresetValue']; t: McpSettingsProps['t'] }> = ({ preset, server, index, onPresetValue, t }) => (
    <>
        <p className="m-0 text-sm leading-[1.7] text-body">{preset.description}</p>
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
        <div className={FIELD}>
            <div className={FIELD_HEAD}>
                <label htmlFor={id} className="cursor-pointer whitespace-nowrap">{field.label}{field.required && <Required />}</label>
                {secret && field.configured && <Configured>{t('plugins.secretConfigured')}</Configured>}
                {field.link && (
                    <a
                        className={cn('group/link ml-auto inline-flex items-center gap-1 rounded-sm text-[0.8rem] font-medium whitespace-nowrap text-brand no-underline hover:underline hover:underline-offset-[3px] focus-visible:outline-offset-2', BRAND_FOCUS)}
                        href={field.link.url}
                        target="_blank"
                        rel="noreferrer"
                    >
                        {field.link.label}<ExternalLink className="size-3 transition-transform group-hover/link:translate-x-px group-hover/link:-translate-y-px" aria-hidden="true" />
                    </a>
                )}
            </div>
            <Input
                id={id}
                className={MCP_INPUT}
                type={secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => onPresetValue(index, field.key, e.target.value, secret)}
                placeholder={secret && field.configured ? t('plugins.secretKeep') : (field.placeholder || '')}
            />
            {field.help && <p className={HELP}>{field.help}</p>}
        </div>
    );
};

const ChoiceField: React.FC<{ field: MCPPresetField; server: MCPServerConfig; index: number; onPresetValue: McpSettingsProps['onPresetValue'] }> = ({ field, server, index, onPresetValue }) => {
    const saved = server.field_values?.[field.key];
    const chosen = Array.isArray(saved) ? saved : (field.defaultValue || []);
    return (
        <fieldset className={FIELD}>
            <legend className={cn(FIELD_HEAD, 'mb-2')}>
                <span>{field.label}{field.required && <Required />}</span>
                {field.choices && <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums">{field.choices.filter((choice) => chosen.includes(choice.value)).length} / {field.choices.length}</span>}
            </legend>
            <div className="grid auto-rows-fr grid-cols-[repeat(auto-fill,minmax(196px,1fr))] gap-2">
                {(field.choices || []).map((choice) => {
                    const on = chosen.includes(choice.value);
                    return (
                        <label
                            key={choice.value}
                            data-checked={on ? 'true' : undefined}
                            className={cn(
                                'group/choice relative flex cursor-pointer items-start gap-2.5 rounded-lg border border-input bg-white p-3 transition-[border-color,background-color,box-shadow,transform] hover:border-border-strong hover:bg-paper active:scale-[0.985]',
                                'data-[checked=true]:border-brand/50 data-[checked=true]:bg-brand-soft data-[checked=true]:shadow-[inset_0_0_0_0.5px_rgba(194,65,12,0.5)]',
                            )}
                        >
                            <input
                                type="checkbox"
                                className="peer absolute size-px opacity-0"
                                checked={on}
                                onChange={(e) => onPresetValue(index, field.key, e.target.checked ? [...chosen, choice.value] : chosen.filter((value) => value !== choice.value), false)}
                            />
                            <span
                                className="mt-px grid size-4 flex-none place-items-center rounded-[5px] border-[1.5px] border-border-strong bg-white text-transparent transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand group-data-[checked=true]/choice:animate-pop group-data-[checked=true]/choice:border-brand group-data-[checked=true]/choice:bg-brand group-data-[checked=true]/choice:text-white"
                                aria-hidden="true"
                            >
                                <Check className="size-[11px]" />
                            </span>
                            <span className="grid min-w-0 content-start gap-[3px]">
                                <span className="text-[0.85rem] font-semibold text-foreground">{choice.label}</span>
                                {choice.detail && <span className="text-xs leading-normal text-muted-foreground">{choice.detail}</span>}
                            </span>
                        </label>
                    );
                })}
            </div>
            {field.help && <p className={cn(HELP, 'mt-2')}>{field.help}</p>}
        </fieldset>
    );
};

const CustomForm: React.FC<{ server: MCPServerConfig; index: number; onField: McpSettingsProps['onField']; onRemove: McpSettingsProps['onRemove']; t: McpSettingsProps['t'] }> = ({ server, index, onField, onRemove, t }) => {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const stdio = server.transport === 'stdio';
    const text = (id: string, label: string, field: keyof MCPServerConfig, placeholder: string, required = false) => (
        <div className={FIELD}>
            <div className={FIELD_HEAD}><label htmlFor={id} className="cursor-pointer whitespace-nowrap">{label}{required && <Required />}</label></div>
            <Input id={id} className={MCP_INPUT} value={String(server[field] ?? '')} onChange={(e) => onField(index, field, e.target.value)} placeholder={placeholder} spellCheck={false} />
        </div>
    );
    const mapping = (id: string, label: string, field: 'env_input' | 'headers_input', summary: MCPServerConfig['env'], placeholder: string) => (
        <div className={FIELD}>
            <div className={FIELD_HEAD}>
                <label htmlFor={id} className="cursor-pointer whitespace-nowrap">{label}</label>
                {summary?.configured && <Configured>{t('plugins.configured').replace('{count}', String(summary.count))}</Configured>}
            </div>
            <Textarea
                id={id}
                className={cn(MCP_INPUT, MCP_CODE, 'h-auto min-h-[76px] resize-y py-2.5 leading-[1.55]')}
                rows={3}
                value={server[field] ?? ''}
                onChange={(e) => onField(index, field, e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
            />
        </div>
    );
    return (
        <>
            <div className={GROUP}>
                {text('mcp-server-name', t('plugins.name'), 'name', 'my-server', true)}
                <div className={FIELD}>
                    <div className={FIELD_HEAD}><span id="mcp-transport-label">{t('plugins.transport')}</span></div>
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1" role="radiogroup" aria-labelledby="mcp-transport-label">
                        {TRANSPORTS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={server.transport === option.value || (option.value === 'http' && server.transport === 'streamable-http')}
                                className={cn(
                                    'grid gap-0.5 rounded-md p-2 text-center transition-[background-color,box-shadow] focus-visible:outline-offset-1',
                                    'not-aria-checked:hover:bg-white/55 aria-checked:bg-white aria-checked:shadow-[0_1px_2px_rgba(28,25,23,0.08),0_0_0_1px_var(--border)]',
                                    BRAND_FOCUS,
                                )}
                                onClick={() => onField(index, 'transport', option.value)}
                            >
                                <span className="text-[0.85rem] font-semibold text-foreground">{option.labelKey}</span>
                                <small className="text-[0.72rem] text-muted-foreground">{t(option.captionKey)}</small>
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className={GROUP}>
                <h5 className="m-0 text-xs font-semibold text-muted-foreground">{t('plugins.sectionConnection')}</h5>
                {stdio ? (
                    <>
                        <div className={ROW}>
                            {text('mcp-server-command', t('plugins.command'), 'command', 'npx / python')}
                            {text('mcp-server-script', t('plugins.scriptArgs'), 'script', 'server.py')}
                        </div>
                        <div className={FIELD}>
                            <div className={FIELD_HEAD}><label htmlFor="mcp-server-args" className="cursor-pointer whitespace-nowrap">{t('plugins.arguments')}</label></div>
                            <Input
                                id="mcp-server-args"
                                className={cn(MCP_INPUT, MCP_CODE)}
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

            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="border-t border-border pt-[18px]">
                <CollapsibleTrigger
                    className={cn('group/adv inline-flex w-fit items-center gap-1.5 rounded-sm text-[0.85rem] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-offset-[3px]', BRAND_FOCUS)}
                >
                    <ChevronRight className="size-3.5 transition-transform group-data-panel-open/adv:rotate-90" aria-hidden="true" />
                    {t('plugins.sectionAdvanced')}
                </CollapsibleTrigger>
                <CollapsibleContent>
                    <div className={cn(GROUP, 'mt-[18px] animate-rise-sm [animation-duration:260ms]')}>
                        {text('mcp-server-description', t('plugins.description'), 'description', t('plugins.descriptionPlaceholder'))}
                        <div className={ROW}>
                            {text('mcp-server-tool-prefix', t('plugins.toolPrefix'), 'tool_prefix', 'db')}
                            {text('mcp-server-type', t('plugins.serverType'), 'server_type', 'service')}
                        </div>
                        <button
                            type="button"
                            className="self-start rounded-sm border-0 bg-transparent p-0 text-[0.82rem] font-medium text-destructive hover:underline hover:underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
                            onClick={() => onRemove(index)}
                        >
                            {t('plugins.deleteConfig')}
                        </button>
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </>
    );
};

export default McpSettings;
