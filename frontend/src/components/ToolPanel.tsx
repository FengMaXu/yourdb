import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Code, Copy, Database, FileCode, Hammer, Terminal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WidgetSpec } from '../api/client';
import { useLanguage } from '../context/LanguageContext';

export interface ToolData {
    toolCallId: string;
    messageId: string;
    name: string;
    args: any;
    result?: string;
    details?: any;
    status: 'calling' | 'running' | 'done' | 'error';
    widgetId?: string | null;
    widget?: WidgetSpec;
    skill?: {
        name: string;
        description?: string;
        when_to_use?: string;
        location?: string;
        source_scope?: string;
        granted_permissions?: string[];
        model_override?: string | null;
        ui_message?: string;
    };
}

interface ToolPanelProps {
    tools?: ToolData[];
    onClose?: () => void;
}

const useCopy = () => {
    const [copiedKey, setCopiedKey] = useState<string | null>(null);
    const copy = useCallback((text: string, key: string) => {
        navigator.clipboard.writeText(text).then(() => {
            setCopiedKey(key);
            setTimeout(() => setCopiedKey(null), 2000);
        });
    }, []);
    return { copiedKey, copy };
};

const getToolIcon = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('sql') || n.includes('query') || n.includes('database') || n.includes('mysql')) return <Database className="size-3.5" />;
    if (n.includes('code') || n.includes('execute') || n.includes('python') || n.includes('script')) return <Terminal className="size-3.5" />;
    if (n.includes('file') || n.includes('read') || n.includes('write')) return <FileCode className="size-3.5" />;
    return <Hammer className="size-3.5" />;
};

/** Monospace text on the section's soft surface: JSON, plain results, unparsed arguments. */
const MONO = 'm-0 px-3 py-2.5 font-[family-name:var(--font-code)] text-[0.72rem] leading-[1.65] break-words whitespace-pre-wrap text-primary-hover';
/** A small square icon action in the panel (close, copy). */
const ICON_ACTION = 'flex items-center justify-center rounded-md border-0 bg-transparent transition-[background-color,color,transform] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';

const JsonHighlight: React.FC<{ data: any }> = ({ data }) => {
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return <pre className={MONO}>{jsonStr}</pre>;
};

/** Code with line numbers on a dark ground. */
const CodeBlock: React.FC<{ code: string }> = ({ code }) => {
    const lines = code.split('\n');
    return (
        <div className="overflow-x-auto rounded-b-lg bg-ink-panel [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-white/20">
            <table className="w-full border-collapse font-[family-name:var(--font-code)] text-[0.72rem] leading-[1.6]">
                <tbody>
                    {lines.map((line, i) => (
                        <tr key={i}>
                            <td className="w-10 min-w-10 bg-black/10 pr-2.5 pl-3 text-right align-top text-muted-foreground select-none">{i + 1}</td>
                            <td className="px-3.5 whitespace-pre text-border-strong">{line || ' '}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const ArgsRenderer: React.FC<{ args: any }> = ({ args }) => {
    const argsObj = typeof args === 'string' ? (() => { try { return JSON.parse(args); } catch { return null; } })() : args;

    if (!argsObj || typeof argsObj !== 'object') {
        return <pre className={MONO}>{typeof args === 'string' ? args : JSON.stringify(args, null, 2)}</pre>;
    }

    const { code, query, sql, ...rest } = argsObj;
    const codeContent = code || query || sql;
    const hasOtherFields = Object.keys(rest).length > 0;

    return (
        <div className="text-[0.74rem]">
            {hasOtherFields && (
                <div className="grid grid-cols-[fit-content(40%)_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 px-3 py-2.5">
                    {Object.entries(rest).map(([key, value]) => (
                        <div className="contents" key={key}>
                            <span className="min-w-0 text-[0.72rem] font-medium wrap-anywhere text-warning">{key}</span>
                            <span className="min-w-0 font-[family-name:var(--font-code)] text-[0.72rem] wrap-anywhere text-foreground">
                                {typeof value === 'string' ? value : JSON.stringify(value)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {codeContent && (
                <div className="border-t border-[var(--thread-line)]">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 font-[family-name:var(--font-code)] text-[0.64rem] font-medium tracking-[0.08em] text-[var(--thread-muted)] uppercase">
                        <Code className="size-3" />
                        <span>{code ? 'Code' : query ? 'Query' : 'SQL'}</span>
                    </div>
                    <CodeBlock code={String(codeContent)} />
                </div>
            )}
            {!codeContent && !hasOtherFields && <JsonHighlight data={argsObj} />}
        </div>
    );
};

const ResultRenderer: React.FC<{ result?: string }> = ({ result }) => {
    const { t } = useLanguage();
    if (!result) {
        return (
            <span className="flex items-center gap-2 p-3 font-[family-name:var(--font-code)] text-[0.72rem] text-muted-foreground">
                <span className="size-2 flex-none animate-dot-breathe rounded-full bg-link motion-reduce:animate-none" aria-hidden="true" />
                {t('tools.processing')}
            </span>
        );
    }

    const trimmed = result.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            parsed = null;
        }
        if (parsed !== null) return <JsonHighlight data={parsed} />;
    }

    return <pre className={MONO}>{result}</pre>;
};

type ThreadSectionProps = {
    label: string;
    copyText?: string;
    copyKey: string;
    copiedKey: string | null;
    onCopy: (text: string, key: string) => void;
    scroll?: boolean;
    children: React.ReactNode;
};

const ThreadSection: React.FC<ThreadSectionProps> = ({ label, copyText, copyKey, copiedKey, onCopy, scroll, children }) => {
    const { t } = useLanguage();
    return (
        <section>
            <div className="mb-1 flex min-h-6 items-center gap-1.5 text-[0.64rem] font-medium tracking-[0.08em] text-[var(--thread-muted)] uppercase">
                <span>{label}</span>
                {copyText && (
                    <button
                        type="button"
                        className={cn(ICON_ACTION, 'ml-auto min-h-6 min-w-6 rounded-sm p-1 text-muted-foreground hover:bg-[rgba(120,53,15,0.08)] hover:text-foreground')}
                        onClick={() => onCopy(copyText, copyKey)}
                        title={t('tools.copy')}
                        aria-label={t('tools.copy')}
                    >
                        {copiedKey === copyKey ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
                    </button>
                )}
            </div>
            <div className={cn('overflow-hidden rounded-lg bg-[var(--bubble-bg)]', scroll && 'max-h-[360px] overflow-auto')}>{children}</div>
        </section>
    );
};

type ThreadItemProps = {
    tool: ToolData;
    index: number;
    open: boolean;
    onToggle: () => void;
    copiedKey: string | null;
    onCopy: (text: string, key: string) => void;
};

const ThreadItem: React.FC<ThreadItemProps> = ({ tool, index, open, onToggle, copiedKey, onCopy }) => {
    const { t } = useLanguage();
    const contentId = `tool-thread-content-${tool.toolCallId}`;
    const argsText = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args, null, 2);
    const detailsText = tool.details ? JSON.stringify(tool.details, null, 2) : '';
    const tone = tool.status === 'error' ? 'error' : tool.status === 'done' ? 'success' : 'running';
    const statusLabel = tool.status === 'error' ? t('tools.statusError') : tool.status === 'done' ? t('tools.statusDone') : t('tools.statusRunning');

    return (
        // The thread line runs down the left; it starts at the first node and stops at the last.
        <li className="relative pl-6 before:absolute before:top-0 before:bottom-0 before:left-1.5 before:w-px before:bg-[var(--thread-line)] first:before:top-[19px] last:before:bottom-[calc(100%-19px)]">
            <span
                className={cn(
                    'absolute top-[15px] left-0.5 size-[9px] rounded-full bg-body shadow-[0_0_0_3px_var(--frame-surface)]',
                    tone === 'running' && 'animate-node-pulse border-[1.5px] border-brand bg-white motion-reduce:animate-none',
                    tone === 'error' && 'bg-destructive',
                )}
                aria-hidden="true"
            />
            <button
                type="button"
                className="group/head flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent py-[9px] pr-1 pl-0 text-left font-[family-name:var(--font-code)] text-[0.78rem] text-foreground select-none focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                aria-expanded={open}
                aria-controls={contentId}
                onClick={onToggle}
            >
                <span className="flex-none text-[0.7rem] text-[var(--thread-muted)] tabular-nums">{String(index + 1).padStart(2, '0')}</span>
                <span className="inline-flex flex-none text-muted-foreground" aria-hidden="true">{getToolIcon(tool.name)}</span>
                <span className="min-w-0 flex-auto truncate font-medium transition-colors pointer-fine:group-hover/head:text-brand" title={tool.name}>{tool.name}</span>
                <span className={cn('flex-none text-[0.68rem]', tone === 'running' ? 'text-brand' : tone === 'error' ? 'text-destructive' : 'text-[var(--thread-muted)]')}>{statusLabel}</span>
                <span className="inline-flex flex-none text-[var(--thread-muted)] pointer-fine:group-hover/head:text-body" aria-hidden="true">
                    {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </span>
            </button>

            {open && (
                <div id={contentId} className="flex flex-col gap-3 pt-0.5 pb-4">
                    {tool.args && (
                        <ThreadSection label={t('tools.args')} copyText={argsText} copyKey={`args-${tool.toolCallId}`} copiedKey={copiedKey} onCopy={onCopy}>
                            <ArgsRenderer args={tool.args} />
                        </ThreadSection>
                    )}

                    {tool.widget && (
                        <ThreadSection label="Widget Spec" copyText={JSON.stringify(tool.widget, null, 2)} copyKey={`widget-${tool.toolCallId}`} copiedKey={copiedKey} onCopy={onCopy} scroll>
                            <JsonHighlight data={tool.widget} />
                        </ThreadSection>
                    )}

                    {tool.details && !tool.widget && (
                        <ThreadSection label={t('tools.details')} copyText={detailsText} copyKey={`details-${tool.toolCallId}`} copiedKey={copiedKey} onCopy={onCopy} scroll>
                            <JsonHighlight data={tool.details} />
                        </ThreadSection>
                    )}

                    <ThreadSection label={t('tools.result')} copyText={tool.result || undefined} copyKey={`result-${tool.toolCallId}`} copiedKey={copiedKey} onCopy={onCopy} scroll>
                        <ResultRenderer result={tool.result} />
                    </ThreadSection>
                </div>
            )}
        </li>
    );
};

const ToolPanel: React.FC<ToolPanelProps> = ({ tools = [], onClose }) => {
    const { t } = useLanguage();
    const { copiedKey, copy } = useCopy();
    const contentRef = useRef<HTMLDivElement>(null);
    // Explicit open/closed choices; untouched steps default to open only when latest or failed.
    const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});
    const lastToolId = tools[tools.length - 1]?.toolCallId;

    // The thread reads top-down in call order, so follow it to the newest step.
    useEffect(() => {
        if (!contentRef.current) {
            return;
        }
        contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }, [tools.length]);

    return (
        // Beside the chat on a wide window; over it, from the right, below 1100px; full width below 720px.
        <aside
            className={cn(
                'relative m-0 flex max-w-none min-w-[300px] flex-auto flex-col overflow-hidden border-0 border-l border-border bg-[var(--frame-surface)]',
                'max-[1100px]:absolute max-[1100px]:inset-y-0 max-[1100px]:right-0 max-[1100px]:z-20 max-[1100px]:w-[min(var(--tool-panel-width),calc(100%-12px))] max-[1100px]:min-w-0 max-[1100px]:shadow-[-18px_0_34px_-28px_rgba(28,25,23,0.64)] max-[720px]:w-full',
            )}
        >
            <div className="box-border flex h-14 min-h-14 items-center justify-between border-b border-border bg-[var(--frame-surface)] pr-3.5 pl-[22px]">
                <div className="flex items-center gap-2.5">
                    <span className="text-[0.94rem] font-bold tracking-[-0.01em] text-foreground">{t('tools.details')}</span>
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-[rgba(120,53,15,0.08)] px-2 font-[family-name:var(--font-code)] text-[0.76rem] font-medium text-muted-foreground">{tools.length}</span>
                </div>
                <button type="button" className={cn(ICON_ACTION, 'size-8 min-h-8 min-w-8 p-0 text-muted-foreground hover:text-foreground')} onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
                    <X className="size-4" aria-hidden="true" />
                </button>
            </div>

            <div ref={contentRef} className="scrollable-area flex-1 pt-3.5 pr-3.5 pb-7 pl-4">
                {tools.length === 0 ? (
                    <div className="flex flex-col gap-1.5 px-3 py-6 text-center text-[length:var(--font-size-caption)] leading-[1.45] text-body">
                        <strong className="text-[length:var(--font-size-body-sm)] text-foreground">{t('tools.noCalls')}</strong>
                        <span>{t('tools.noCallsHint')}</span>
                    </div>
                ) : (
                    <ol className="m-0 list-none p-0 font-[family-name:var(--font-code)]">
                        {tools.map((tool, index) => {
                            const open = openOverrides[tool.toolCallId] ?? (tool.toolCallId === lastToolId || tool.status === 'error');
                            return (
                                <ThreadItem
                                    key={tool.toolCallId}
                                    tool={tool}
                                    index={index}
                                    open={open}
                                    onToggle={() => setOpenOverrides((prev) => ({ ...prev, [tool.toolCallId]: !open }))}
                                    copiedKey={copiedKey}
                                    onCopy={copy}
                                />
                            );
                        })}
                    </ol>
                )}
            </div>
        </aside>
    );
};

export default ToolPanel;
