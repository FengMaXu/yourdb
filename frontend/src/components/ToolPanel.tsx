import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronUp, Code, Copy, Database, FileCode, Hammer, ShieldCheck, Terminal, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
    CodeBlock,
    CodeBlockActions,
    CodeBlockContent,
    CodeBlockCopyButton,
    CodeBlockHeader,
    CodeBlockTitle,
} from '@/components/ui/code-block';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLanguage } from '../context/LanguageContext';
import {
    asRecord,
    extractBasisAudit,
    extractQueryRowCount,
    extractTabularDetails,
    isTurnAuditVerified,
    parseArgsRecord,
    type AuditSpecRow,
    type AuditStatus,
    type BasisAuditData,
    type KnowledgeEvidence,
    type PublicationReceiptSummary,
    type ToolData,
} from './tool-audit';

export {
    extractBasisAudit,
    isTurnAuditVerified,
    type AuditSpecRow,
    type AuditStatus,
    type BasisAuditData,
    type KnowledgeEvidence,
    type PublicationReceiptSummary,
    type ToolData,
};

export interface ToolPanelFocusTarget {
    turnKey?: string;
    messageId?: string;
    toolCallId?: string;
    tab?: 'basis' | 'trace';
    seq?: number;
}

interface ToolPanelProps {
    tools?: ToolData[];
    focusTarget?: ToolPanelFocusTarget | null;
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
    if (n.includes('sql') || n.includes('query') || n.includes('database') || n.includes('mysql') || n.includes('answer_spec')) {
        return <Database className="size-3.5" />;
    }
    if (n.includes('code') || n.includes('execute') || n.includes('python') || n.includes('script')) return <Terminal className="size-3.5" />;
    if (n.includes('file') || n.includes('read') || n.includes('write') || n.includes('publish') || n.includes('export')) {
        return <FileCode className="size-3.5" />;
    }
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
const DarkCodeBlock: React.FC<{ code: string }> = ({ code }) => {
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
    const argsObj = parseArgsRecord(args);

    if (!argsObj) {
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
                    <DarkCodeBlock code={String(codeContent)} />
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

const getToolSummary = (tool: ToolData): string | undefined => {
    const argsObj = parseArgsRecord(tool.args);
    if (tool.name === 'search_knowledge') {
        return typeof argsObj?.query === 'string' && argsObj.query.trim() ? argsObj.query.trim() : undefined;
    }
    if (tool.name === 'read_knowledge') {
        return typeof argsObj?.path === 'string' && argsObj.path.trim() ? argsObj.path.trim() : undefined;
    }
    if (tool.name === 'subagent') {
        const tasks = Array.isArray(argsObj?.tasks) ? argsObj.tasks : [];
        const keys = tasks.map((item: any) => item?.key).filter((k: unknown) => typeof k === 'string' && k);
        return keys.length > 0 ? keys.join(', ') : undefined;
    }
    if (tool.name === 'set_answer_spec' || tool.name === 'inspect_answer') {
        const detailsRec = asRecord(tool.details);
        const openCount = Array.isArray(detailsRec?.open) ? detailsRec.open.length : 0;
        const undeclaredCount = Array.isArray(detailsRec?.undeclared) ? detailsRec.undeclared.length : 0;
        if (openCount > 0) return `${openCount} open`;
        if (undeclaredCount > 0) return `${undeclaredCount} undeclared`;
        const fields = asRecord(argsObj?.fields);
        if (fields) return `${Object.keys(fields).length} fields`;
        return undefined;
    }
    if (tool.name === 'query_database') {
        const rows = extractQueryRowCount(tool);
        const kind = typeof argsObj?.kind === 'string' ? argsObj.kind : undefined;
        const countLabel = rows ? `${rows.count}${rows.truncated ? '+' : ''} rows` : undefined;
        return [kind, countLabel].filter(Boolean).join(' · ') || undefined;
    }
    if (tool.name === 'publish_query_result' || tool.name === 'export_query') {
        const detailsRec = asRecord(tool.details);
        const format = typeof detailsRec?.format === 'string' ? detailsRec.format : argsObj?.format;
        return typeof format === 'string' ? format : undefined;
    }
    if (tool.name === 'show_widget') {
        const candidate = tool.widget?.title ?? tool.details?.widget?.title ?? argsObj?.title ?? argsObj?.kind ?? argsObj?.type;
        return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
    }
    return undefined;
};

const formatTabularCell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const TabularDetailsPreview: React.FC<{ columns: string[]; rows: unknown[][] }> = ({ columns, rows }) => (
    <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.72rem]">
            <thead className="bg-paper font-semibold text-muted-foreground">
                <tr>
                    {columns.map((column, index) => (
                        <th key={index} className="px-2.5 py-1.5 text-left whitespace-nowrap">
                            {column}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                        {columns.map((_, colIndex) => (
                            <td key={colIndex} className="border-t border-border px-2.5 py-1.5 font-mono whitespace-nowrap tabular-nums text-foreground">
                                {formatTabularCell(row[colIndex])}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    </div>
);

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
    const summary = getToolSummary(tool);
    const tabularDetails = extractTabularDetails(tool.details);
    const suppressResult = (Boolean(tool.widget) && tool.result?.trim() === 'widget shown')
        || (Boolean(tabularDetails) && (
            /^\d+\s+rows?$/i.test(tool.result?.trim() ?? '')
            || (tool.result?.includes('[RESULT_CANDIDATE]') ?? false)
        ));

    return (
        // The thread line runs down the left; it starts at the first node and stops at the last.
        <li
            id={`tool-thread-item-${tool.toolCallId}`}
            className="relative pl-6 before:absolute before:top-0 before:bottom-0 before:left-1.5 before:w-px before:bg-[var(--thread-line)] first:before:top-[19px] last:before:bottom-[calc(100%-19px)]"
        >
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
                <span className="min-w-0 flex-auto truncate font-medium transition-colors pointer-fine:group-hover/head:text-brand" title={summary ? `${tool.name} · ${summary}` : tool.name}>
                    {tool.name}
                    {summary && <span className="ml-1.5 font-sans text-[0.72rem] font-normal text-muted-foreground">· {summary}</span>}
                </span>
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
                            {tabularDetails ? (
                                <TabularDetailsPreview columns={tabularDetails.columns} rows={tabularDetails.rows} />
                            ) : (
                                <JsonHighlight data={tool.details} />
                            )}
                        </ThreadSection>
                    )}

                    {!suppressResult && (
                        <ThreadSection label={t('tools.result')} copyText={tool.result || undefined} copyKey={`result-${tool.toolCallId}`} copiedKey={copiedKey} onCopy={onCopy} scroll>
                            <ResultRenderer result={tool.result} />
                        </ThreadSection>
                    )}
                </div>
            )}
        </li>
    );
};

interface TurnBucket {
    turnKey: string;
    tools: ToolData[];
}

function groupToolsByTurn(tools: ToolData[]): TurnBucket[] {
    const buckets: TurnBucket[] = [];
    const byKey = new Map<string, TurnBucket>();
    for (const tool of tools) {
        const key = tool.turnKey ?? 'turn-default';
        let bucket = byKey.get(key);
        if (!bucket) {
            bucket = { turnKey: key, tools: [] };
            byKey.set(key, bucket);
            buckets.push(bucket);
        }
        bucket.tools.push(tool);
    }
    return buckets;
}

const BasisAuditView: React.FC<{
    tools: ToolData[];
    turns: TurnBucket[];
    activeTurnKey: string;
    onSelectTurn: (turnKey: string) => void;
    onSwitchToTrace: () => void;
}> = ({ tools, turns, activeTurnKey, onSelectTurn, onSwitchToTrace }) => {
    const { t, language } = useLanguage();
    const isEn = language === 'en';
    const audit = useMemo(() => extractBasisAudit(tools, isEn), [tools, isEn]);

    const turnSelector = turns.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pb-1" role="group" aria-label={t('tools.allTurns')}>
            {turns.map((turn, idx) => {
                const selected = turn.turnKey === activeTurnKey;
                return (
                    <button
                        key={turn.turnKey}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onSelectTurn(turn.turnKey)}
                        className={cn(
                            'cursor-pointer rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
                            selected
                                ? 'border-brand/40 bg-brand-soft text-brand'
                                : 'border-border bg-paper text-muted-foreground hover:border-border-strong hover:text-foreground',
                        )}
                    >
                        {t('tools.turnLabel').replace('{n}', String(idx + 1))}
                    </button>
                );
            })}
        </div>
    );

    if (audit.specItems.length === 0 && !audit.sqlText && audit.knowledgeEvidence.length === 0 && !audit.publicationReceipt) {
        return (
            <div className="flex flex-col gap-3">
                {turnSelector}
                <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-paper/70 px-4 py-6 text-center text-[12.5px] text-muted-foreground">
                    <div>{isEn ? 'No SQL or Answer Spec captured for this turn yet.' : '本轮对话未产生数据库查询或结构化口径记录。'}</div>
                    <button
                        type="button"
                        onClick={onSwitchToTrace}
                        className="cursor-pointer rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-hover"
                    >
                        {isEn ? 'Inspect Tool Trace' : '查看调用链路详情'}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {turnSelector}

            {(audit.publicationReceipt || audit.fanoutFinding) && (() => {
                const flagged = Boolean(audit.publicationReceipt?.disclosed || audit.fanoutFinding);
                const generalLines = [...audit.generalNotes, ...(audit.fanoutFinding ? [audit.fanoutFinding] : [])];
                const notedRows = audit.specItems.filter((item) => (item.notes?.length ?? 0) > 0 || item.status === 'assumed').length;
                return (
                    <div
                        data-testid="basis-disclosure-card"
                        className={cn(
                            'flex flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-[12px]',
                            flagged
                                ? 'border-warning-border bg-warning-soft/55 text-foreground'
                                : 'border-success-border bg-success-soft/50 text-foreground',
                        )}
                    >
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold">
                            {flagged ? (
                                <AlertTriangle className="size-3.5 text-warning" aria-hidden="true" />
                            ) : (
                                <ShieldCheck className="size-3.5 text-success" aria-hidden="true" />
                            )}
                            {flagged
                                ? (isEn ? 'Points to check' : '需要留意')
                                : (isEn ? 'All clauses verified' : '口径均已核实')}
                        </span>
                        {generalLines.length > 0 && (
                            <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4 leading-[1.5] text-body">
                                {generalLines.map((line, index) => <li key={index}>{line}</li>)}
                            </ul>
                        )}
                        {flagged && notedRows > 0 && (
                            <div className="leading-[1.5] text-muted-foreground">
                                {isEn
                                    ? `${notedRows} clause${notedRows === 1 ? '' : 's'} below ${notedRows === 1 ? 'is' : 'are'} marked where they apply.`
                                    : `下方口径树中有 ${notedRows} 项已就地标注。`}
                            </div>
                        )}
                    </div>
                );
            })()}

            {audit.specItems.length > 0 && (
                <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                            {isEn ? 'Answer Spec Tree' : 'Answer Spec 口径树'}
                        </span>
                        <span className="font-mono text-[11px] text-faint">
                            {isEn ? `${audit.specItems.length} clauses` : `${audit.specItems.length} 项口径`}
                        </span>
                    </div>
                    <div className="overflow-hidden rounded-xl border border-border bg-white">
                        {audit.specItems.map((item, index) => (
                            <div
                                key={item.path}
                                className={cn(
                                    'flex flex-col gap-1 px-3 py-2',
                                    index > 0 && 'border-t border-border',
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <div className="flex min-w-0 items-baseline gap-2">
                                        <span className="shrink-0 font-mono text-[11px] font-semibold text-brand">{item.path}</span>
                                        <span className="truncate text-[12px] font-medium text-muted-foreground">{item.label}</span>
                                    </div>
                                    <span
                                        className={cn(
                                            'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium whitespace-nowrap',
                                            item.status === 'verified'
                                                ? 'border-success-border bg-success-soft text-success'
                                                : 'border-warning-border bg-warning-soft text-warning',
                                        )}
                                    >
                                        {item.status === 'verified' ? (
                                            <ShieldCheck className="size-3" aria-hidden="true" />
                                        ) : (
                                            <AlertTriangle className="size-3" aria-hidden="true" />
                                        )}
                                        {item.badge}
                                    </span>
                                </div>
                                <div className="font-mono text-[12px] leading-[1.55] break-words whitespace-pre-wrap text-foreground">
                                    {item.value}
                                </div>
                                {item.notes?.map((note, noteIndex) => (
                                    <div key={noteIndex} className="flex items-start gap-1.5 text-[11.5px] leading-[1.45] text-warning">
                                        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                                        <span className="min-w-0 break-words">{note}</span>
                                    </div>
                                ))}
                                {item.citation && (
                                    <div className="flex items-start gap-1.5 rounded-md bg-paper px-2 py-1 text-[11px] leading-[1.45] text-body">
                                        <BookOpen className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        <span className="min-w-0 break-words">{item.citation}</span>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {audit.knowledgeEvidence.length > 0 && audit.specItems.length === 0 && (
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                        {isEn ? 'Knowledge Evidence' : '参考文档依据'}
                    </span>
                    <div className="flex flex-col gap-2">
                        {audit.knowledgeEvidence.map((item, idx) => (
                            <div key={idx} className="rounded-xl border border-border bg-paper px-3.5 py-2.5 text-[12px]">
                                <div className="font-mono text-[11px] font-semibold text-muted-foreground">{item.source}</div>
                                <div className="mt-1 text-body">{item.excerpt}</div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {audit.sqlText && (
                <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                            {isEn ? 'Executed SQL' : '执行 SQL 语句'}
                        </span>
                        {audit.rowCountText && (
                            <span className="font-mono text-[11px] text-muted-foreground">{audit.rowCountText}</span>
                        )}
                    </div>
                    <CodeBlock size="sm" className="border-border bg-paper">
                        <CodeBlockHeader className="border-b border-border bg-white/70 pb-2">
                            <Database className="size-3.5 text-muted-foreground" aria-hidden="true" />
                            <CodeBlockTitle className="font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                                SQL
                            </CodeBlockTitle>
                            <CodeBlockActions className="opacity-100">
                                <CodeBlockCopyButton value={audit.sqlText} />
                            </CodeBlockActions>
                        </CodeBlockHeader>
                        <CodeBlockContent lineNumbers wrap className="text-[11.5px] leading-[1.6]">
                            {audit.sqlText}
                        </CodeBlockContent>
                    </CodeBlock>
                </section>
            )}

            {audit.tabularDetails && (
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                        {isEn ? 'Query Output Snapshot' : '查询结果快照'}
                    </span>
                    <div className="overflow-hidden rounded-xl border border-border bg-white">
                        <TabularDetailsPreview columns={audit.tabularDetails.columns} rows={audit.tabularDetails.rows} />
                    </div>
                </section>
            )}
        </div>
    );
};

const ToolPanel: React.FC<ToolPanelProps> = ({ tools = [], focusTarget, onClose }) => {
    const { t, language } = useLanguage();
    const isEn = language === 'en';
    const { copiedKey, copy } = useCopy();
    const contentRef = useRef<HTMLDivElement>(null);
    const [activeTab, setActiveTab] = useState<'basis' | 'trace'>('basis');
    const [selectedTurnKey, setSelectedTurnKey] = useState<string | null>(null);
    // Explicit open/closed choices; untouched steps default to open only when latest/substantive or failed.
    const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});

    const turns = useMemo(() => groupToolsByTurn(tools), [tools]);
    const latestTurnKey = turns[turns.length - 1]?.turnKey ?? 'turn-default';
    const activeTurnKey = selectedTurnKey && turns.some((item) => item.turnKey === selectedTurnKey)
        ? selectedTurnKey
        : latestTurnKey;
    const activeTurnTools = useMemo(
        () => turns.find((item) => item.turnKey === activeTurnKey)?.tools ?? tools,
        [turns, activeTurnKey, tools],
    );

    const defaultOpenToolId = (() => {
        const last = tools[tools.length - 1];
        if (!last) return undefined;
        if (last.status === 'calling' || last.status === 'running' || last.status === 'error') {
            return last.toolCallId;
        }
        const lastSubstantive = [...tools].reverse().find((item) => item.name !== 'show_widget');
        return (lastSubstantive ?? last).toolCallId;
    })();

    // A deep-linked tool step stays pinned (no auto-follow) until the user navigates themselves.
    const [pinnedToolCallId, setPinnedToolCallId] = useState<string | null>(null);
    const appliedFocusRef = useRef<ToolPanelFocusTarget | null>(null);

    // Respond to explicit deep-link requests from chat turns or tool steps — once per request,
    // so streaming tool updates never re-apply a stale target over the user's own tab/turn choice.
    useEffect(() => {
        if (!focusTarget || appliedFocusRef.current === focusTarget) return;

        const matchedTurn = focusTarget.turnKey
            ? turns.find((item) => item.turnKey === focusTarget.turnKey)
            : focusTarget.toolCallId
                ? turns.find((item) => item.tools.some((tool) => tool.toolCallId === focusTarget.toolCallId))
                : focusTarget.messageId
                    ? turns.find((item) => item.tools.some((tool) => tool.messageId === focusTarget.messageId))
                    : undefined;
        const needsTurn = Boolean(focusTarget.turnKey || focusTarget.toolCallId || focusTarget.messageId);
        // Target turn not streamed in yet: wait for a later tools update instead of consuming the request.
        if (needsTurn && !matchedTurn) return;
        appliedFocusRef.current = focusTarget;

        setActiveTab(focusTarget.tab ?? (focusTarget.toolCallId ? 'trace' : 'basis'));
        if (matchedTurn) {
            setSelectedTurnKey(matchedTurn.turnKey);
        }

        if (focusTarget.toolCallId) {
            const targetId = focusTarget.toolCallId;
            setPinnedToolCallId(targetId);
            setOpenOverrides((prev) => ({ ...prev, [targetId]: true }));
            requestAnimationFrame(() => {
                document.getElementById(`tool-thread-item-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        } else {
            setPinnedToolCallId(null);
        }
    }, [focusTarget, turns]);

    const selectTab = useCallback((next: 'basis' | 'trace') => {
        setPinnedToolCallId(null);
        setActiveTab(next);
    }, []);
    const selectTurn = useCallback((turnKey: string) => {
        setPinnedToolCallId(null);
        setSelectedTurnKey(turnKey);
    }, []);

    // In trace mode follow newest step when no specific tool is pinned; in basis mode keep the top Answer Spec summary in view.
    useEffect(() => {
        if (!contentRef.current || pinnedToolCallId) {
            return;
        }
        contentRef.current.scrollTop = activeTab === 'trace' ? contentRef.current.scrollHeight : 0;
    }, [activeTab, tools.length, activeTurnKey, pinnedToolCallId]);

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

            {tools.length > 0 && (
                <div className="border-b border-border bg-[var(--frame-surface)] px-[22px]">
                    <Tabs value={activeTab} onValueChange={(next) => selectTab(next === 'trace' ? 'trace' : 'basis')} className="gap-0">
                        <TabsList variant="line" className="h-auto w-full justify-start gap-6 rounded-none p-0">
                            <TabsTrigger
                                value="basis"
                                className="h-auto flex-none rounded-none border-0 px-0 py-2.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground data-active:font-semibold data-active:text-foreground group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5"
                            >
                                {isEn ? 'Basis & Audit' : '口径与依据'}
                            </TabsTrigger>
                            <TabsTrigger
                                value="trace"
                                className="h-auto flex-none rounded-none border-0 px-0 py-2.5 text-[12.5px] font-medium text-muted-foreground hover:text-foreground data-active:font-semibold data-active:text-foreground group-data-horizontal/tabs:after:bottom-0 group-data-horizontal/tabs:after:h-0.5"
                            >
                                {isEn ? `Tool Trace (${tools.length})` : `调用链路 (${tools.length})`}
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                </div>
            )}

            <div ref={contentRef} className="scrollable-area flex-1 pt-4 pr-4 pb-7 pl-[22px]">
                {tools.length === 0 ? (
                    <div className="flex flex-col gap-1.5 px-3 py-6 text-center text-[length:var(--font-size-caption)] leading-[1.45] text-body">
                        <strong className="text-[length:var(--font-size-body-sm)] text-foreground">{t('tools.noCalls')}</strong>
                        <span>{t('tools.noCallsHint')}</span>
                    </div>
                ) : activeTab === 'basis' ? (
                    <BasisAuditView
                        tools={activeTurnTools}
                        turns={turns}
                        activeTurnKey={activeTurnKey}
                        onSelectTurn={selectTurn}
                        onSwitchToTrace={() => selectTab('trace')}
                    />
                ) : (
                    <ol className="m-0 list-none p-0 font-[family-name:var(--font-code)]">
                        {tools.map((tool, index) => {
                            const open = openOverrides[tool.toolCallId] ?? (tool.toolCallId === defaultOpenToolId || tool.status === 'error');
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
