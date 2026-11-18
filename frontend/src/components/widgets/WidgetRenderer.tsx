import React, { Suspense, lazy, useMemo, useState } from 'react';
import { FILE_ACTION_BUTTON, FILE_ACTIONS } from '../file-actions';
import { formatFieldValue, type ChartDataset, type SemanticsCheck } from '@data-agent/charts';
import type { FieldMeta } from '@data-agent/contracts';
import { useLanguage } from '../../context/LanguageContext';
import { usePreview } from '../../context/PreviewContext';
import { resolveWorkspaceDownloadUrl, resolveWorkspacePreviewUrl } from '../../utils/resolveInternalUrl';
import type { DisclosureNote } from '../tool-audit';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Copy, Download, Eye, File, FileCode, FileSpreadsheet, FileText, Image } from 'lucide-react';

export type WidgetKind = 'kpi' | 'metric_cards' | 'table' | 'chart' | 'steps' | 'rich_text' | 'echarts' | 'file_link';

/** ECharts is large: it downloads only when a chart is first drawn, not with every page that shows widgets. */
const ChartSpecWidget = lazy(() => import('./ChartSpecWidget'));

const PREVIEWABLE_FILE_TYPES = new Set(['csv', 'gif', 'htm', 'html', 'jpeg', 'jpg', 'json', 'md', 'markdown', 'png', 'svg', 'txt', 'webp']);

export interface WidgetSpec {
    widget_id: string;
    kind: WidgetKind;
    title: string;
    subtitle?: string;
    data?: any[];
    value?: string | number;
    label?: string;
    series?: any[];
    columns?: any[];
    actions?: any[];
    metadata?: Record<string, any>;
    raw_html?: string;
    raw_svg?: string;
    config?: Record<string, any>;
    xAxis?: { data?: unknown[]; [key: string]: unknown };
    file_path?: string;
    download_url?: string;
    file_type?: string;
    status?: 'ready' | 'error';
    error?: string;
    /** Set on every widget the Runtime builds; a transcript widget without it is drawn from its data rows. */
    contractVersion?: number;
    chartSpec?: unknown;
    dataset?: ChartDataset;
    disclosure?: string;
    disclosureItems?: DisclosureNote[];
    declaredFields?: string[];
    semanticChecks?: SemanticsCheck[];
    derivedFrom?: string;
    /** Declared semantics of table columns, keyed by column. */
    fields?: Record<string, FieldMeta>;
}

/** Mirrors CHART_WIDGET_CONTRACT_VERSION in the Runtime's widget contract. */
const CURRENT_WIDGET_CONTRACT = 2;

interface WidgetRendererProps {
    widget: WidgetSpec;
    currentSessionId?: string;
}

const getColumnKey = (column: any, index: number) => (
    column?.key ?? column?.field ?? column?.accessor ?? column?.id ?? `column_${index}`
);

const getColumnLabel = (column: any, key: string) => (
    column?.label ?? column?.headerName ?? column?.title ?? key
);

const toDisplayText = (value: unknown, fallback = ''): string => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (Array.isArray(value)) return value.map((item) => toDisplayText(item)).filter(Boolean).join(', ');
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of ['text', 'name', 'label', 'title', 'value']) {
            const candidate = record[key];
            if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
        }
        try {
            return JSON.stringify(value);
        } catch {
            return fallback;
        }
    }
    return fallback;
};

const normalizeColumns = (widget: WidgetSpec, rows: any[]) => {
    if (Array.isArray(widget.columns) && widget.columns.length > 0) {
        return widget.columns.map((column: any, index: number) => {
            const key = getColumnKey(column, index);
            const label = getColumnLabel(column, key);
            return { ...column, key, label };
        });
    }

    return rows[0] ? Object.keys(rows[0]).map((key) => ({ key, label: key })) : [];
};

const parseFiniteNumber = (value: unknown): number | null => {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const normalized = value.replace(/,/g, '').trim();
        if (!normalized) {
            return null;
        }
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const pickNumber = (...values: unknown[]) => {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
};

const pickBoolean = (...values: unknown[]) => {
    for (const value of values) {
        if (typeof value === 'boolean') {
            return value;
        }
    }
    return undefined;
};

const pickString = (...values: unknown[]) => {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
};

const inferColumnFormat = (column: any, numericValue: number) => {
    const formatter = column?.valueFormatter;
    const formatterConfig = formatter && typeof formatter === 'object' ? formatter : {};
    const typeParts = [
        column?.type,
        column?.dataType,
        typeof formatter === 'string' ? formatter : undefined,
        formatterConfig?.type,
        formatterConfig?.name,
        formatterConfig?.kind,
        column?.label,
        column?.headerName,
        column?.title,
        column?.field,
        column?.key,
    ].flat().filter(Boolean).map(String);
    const semanticText = typeParts.join(' ').toLowerCase();

    const precision = pickNumber(
        column?.precision,
        column?.decimals,
        column?.fractionDigits,
        column?.minimumFractionDigits,
        column?.maximumFractionDigits,
        formatterConfig?.precision,
        formatterConfig?.decimals,
        formatterConfig?.fractionDigits,
        formatterConfig?.minimumFractionDigits,
        formatterConfig?.maximumFractionDigits,
        (() => {
            const matched = typeof formatter === 'string' ? formatter.match(/(\d+)/) : null;
            return matched ? Number(matched[1]) : undefined;
        })(),
    );

    const useGrouping = pickBoolean(
        column?.useGrouping,
        column?.thousandSeparator,
        column?.thousandsSeparator,
        formatterConfig?.useGrouping,
        formatterConfig?.thousandSeparator,
        formatterConfig?.thousandsSeparator,
    );

    const prefix = pickString(column?.prefix, formatterConfig?.prefix);
    const suffix = pickString(column?.suffix, formatterConfig?.suffix);
    const explicitPercentScale = pickString(column?.percentScale, formatterConfig?.percentScale);

    const isPercent = /(percent|percentage|百分比|占比|同比|环比|增速|rate)/.test(semanticText);
    const isInteger = /(integer|int|count|数量|户数|家数|数量级)/.test(semanticText);
    const isAmount = /(amount|currency|sales|金额|销售额|产值|亿元|万元|元)/.test(semanticText);

    let normalizedValue = numericValue;
    if (isPercent) {
        const shouldScaleFromRatio = explicitPercentScale
            ? explicitPercentScale.toLowerCase() === 'ratio'
            : Math.abs(numericValue) > 0 && Math.abs(numericValue) <= 1;
        if (shouldScaleFromRatio) {
            normalizedValue = numericValue * 100;
        }
    }

    return {
        normalizedValue,
        minimumFractionDigits: precision ?? (isPercent || isAmount ? 2 : isInteger ? 0 : 0),
        maximumFractionDigits: precision ?? (isPercent || isAmount ? 2 : isInteger ? 0 : Number.isInteger(normalizedValue) ? 0 : 4),
        useGrouping: useGrouping ?? true,
        prefix,
        suffix: suffix ?? (isPercent ? '%' : undefined),
    };
};

const formatTableCell = (value: unknown, column: any, t: (key: string) => string) => {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'boolean') {
        return value ? t('widgets.true') : t('widgets.false');
    }

    const numericValue = parseFiniteNumber(value);
    if (numericValue !== null) {
        const format = inferColumnFormat(column, numericValue);
        const formatted = new Intl.NumberFormat('zh-CN', {
            useGrouping: format.useGrouping,
            minimumFractionDigits: format.minimumFractionDigits,
            maximumFractionDigits: format.maximumFractionDigits,
        }).format(format.normalizedValue);
        return `${format.prefix ?? ''}${formatted}${format.suffix ?? ''}`;
    }

    if (Array.isArray(value) || typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
};

/**
 * Cells of a table built by the current Runtime: declared field semantics decide
 * scale, magnitude and unit; nothing is inferred from column names or value ranges.
 * Undeclared numbers get digit grouping only, and text (including DECIMAL text and codes) is shown as written.
 */
const formatVersionedCell = (value: unknown, meta: FieldMeta | undefined, t: (key: string) => string) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? t('widgets.true') : t('widgets.false');
    const declared = formatFieldValue(value, meta);
    if (declared !== undefined) return declared;
    if (typeof value === 'number' && Number.isFinite(value)) return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
    if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const renderMetricCards = (widget: WidgetSpec, t: (key: string) => string) => {
    const items = Array.isArray(widget.data)
        ? widget.data
        : widget.value !== undefined
            ? [{ label: widget.label, value: widget.value }]
            : [];
    return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5">
            {items.map((item, index) => (
                <div key={index} className="rounded-xl border border-border bg-paper/75 px-4 py-3.5">
                    <div className="text-[12px] font-medium text-muted-foreground">{toDisplayText(item.label ?? item.name, `${t('widgets.metric')} ${index + 1}`)}</div>
                    <div className="mt-1.5 text-[22px] font-bold leading-tight tracking-[-0.02em] tabular-nums text-foreground">{toDisplayText(item.value, '--')}</div>
                    {(item.change ?? item.description) && (
                        <div className="mt-2 inline-flex items-center rounded-md border border-border/80 bg-white px-2 py-0.5 font-mono text-[11.5px] font-medium tabular-nums text-body">
                            {toDisplayText(item.change ?? item.description)}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
};

const NUMERIC_CELL_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:,\d{3})*(?:\.\d+)?\s*%?$/;

const isNumericColumn = (column: any, rows: any[], fields?: Record<string, FieldMeta>): boolean => {
    const key = column?.key;
    const declaredType = key ? fields?.[key]?.type : undefined;
    if (declaredType) {
        return declaredType === 'quantitative';
    }
    if (column?.type === 'number' || column?.type === 'quantitative' || column?.align === 'right') {
        return true;
    }
    if (!key || rows.length === 0) {
        return false;
    }
    let hasValue = false;
    for (const row of rows) {
        const value = row?.[key];
        if (value === null || value === undefined || value === '') continue;
        hasValue = true;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) return false;
            continue;
        }
        if (typeof value === 'string' && NUMERIC_CELL_PATTERN.test(value.trim())) {
            continue;
        }
        return false;
    }
    return hasValue;
};

const DEFAULT_TABLE_PREVIEW_ROWS = 10;

const csvEscape = (text: string): string => (
    /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
);

const tsvEscape = (text: string): string => text.replace(/[\t\r\n]+/g, ' ');

const TableWidget: React.FC<{ widget: WidgetSpec; t: (key: string) => string }> = ({ widget, t }) => {
    const rows = useMemo(() => (Array.isArray(widget.data) ? widget.data : []), [widget.data]);
    const columns = useMemo(() => normalizeColumns(widget, rows), [widget, rows]);
    // Tables replayed from earlier sessions keep the inference they were first shown with.
    const versioned = widget.contractVersion === CURRENT_WIDGET_CONTRACT;
    const cell = useMemo(
        () => (value: unknown, column: any) => (versioned ? formatVersionedCell(value, widget.fields?.[column.key], t) : formatTableCell(value, column, t)),
        [t, versioned, widget.fields],
    );
    const numericFlags = useMemo(
        () => columns.map((column: any) => isNumericColumn(column, rows, widget.fields)),
        [columns, rows, widget.fields],
    );

    const [sortState, setSortState] = useState<{ colIndex: number; dir: 'asc' | 'desc' } | null>(null);
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);

    const sortedRows = useMemo(() => {
        if (!sortState) return rows;
        const { colIndex, dir } = sortState;
        const column = columns[colIndex];
        if (!column) return rows;
        const isNumeric = numericFlags[colIndex];
        const factor = dir === 'asc' ? 1 : -1;

        return [...rows].sort((a, b) => {
            const rawA = a?.[column.key];
            const rawB = b?.[column.key];
            const emptyA = rawA === null || rawA === undefined || rawA === '';
            const emptyB = rawB === null || rawB === undefined || rawB === '';
            if (emptyA && emptyB) return 0;
            if (emptyA) return 1;
            if (emptyB) return -1;

            if (isNumeric) {
                const numA = parseFiniteNumber(typeof rawA === 'string' ? rawA.replace(/%$/, '') : rawA);
                const numB = parseFiniteNumber(typeof rawB === 'string' ? rawB.replace(/%$/, '') : rawB);
                if (numA !== null && numB !== null) {
                    return (numA - numB) * factor;
                }
            }
            return String(cell(rawA, column)).localeCompare(String(cell(rawB, column)), 'zh-CN', { numeric: true }) * factor;
        });
    }, [cell, columns, numericFlags, rows, sortState]);

    const canCollapse = sortedRows.length > DEFAULT_TABLE_PREVIEW_ROWS;
    const visibleRows = canCollapse && !expanded ? sortedRows.slice(0, DEFAULT_TABLE_PREVIEW_ROWS) : sortedRows;

    const toggleSort = (colIndex: number) => {
        setSortState((prev) => {
            if (!prev || prev.colIndex !== colIndex) return { colIndex, dir: 'asc' };
            if (prev.dir === 'asc') return { colIndex, dir: 'desc' };
            return null;
        });
    };

    const handleCopyTsv = () => {
        const headers = columns.map((column: any, index: number) => tsvEscape(String(column.label ?? column.key ?? `${t('widgets.column')} ${index + 1}`)));
        const lines = [
            headers.join('\t'),
            ...sortedRows.map((row) => columns.map((column: any) => tsvEscape(cell(row[column.key], column))).join('\t')),
        ];
        void navigator.clipboard.writeText(lines.join('\n')).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const handleExportCsv = () => {
        const headers = columns.map((column: any, index: number) => csvEscape(String(column.label ?? column.key ?? `${t('widgets.column')} ${index + 1}`)));
        const lines = [
            headers.join(','),
            ...sortedRows.map((row) => columns.map((column: any) => csvEscape(cell(row[column.key], column))).join(',')),
        ];
        const blob = new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' });
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `${(widget.title || 'table').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(objectUrl);
    };

    return (
        <div className="flex flex-col gap-2">
            {rows.length > 0 && columns.length > 0 && (
                <div className="flex items-center justify-end gap-1.5">
                    <button
                        type="button"
                        onClick={handleCopyTsv}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 text-[11.5px] font-medium text-body transition-colors hover:border-border-strong hover:bg-white hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand motion-reduce:transition-none"
                    >
                        {copied ? <Check className="size-3 text-success" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
                        <span>{copied ? t('widgets.copied') : t('widgets.copyTable')}</span>
                    </button>
                    <button
                        type="button"
                        onClick={handleExportCsv}
                        className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-paper px-2 py-1 text-[11.5px] font-medium text-body transition-colors hover:border-border-strong hover:bg-white hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand motion-reduce:transition-none"
                    >
                        <Download className="size-3" aria-hidden="true" />
                        <span>{t('widgets.exportCsv')}</span>
                    </button>
                </div>
            )}
            <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-[13px]">
                    <thead className="sticky top-0 z-10 bg-paper">
                        <tr>
                            {columns.map((column: any, index: number) => {
                                const headerText = column.label ?? column.key ?? `${t('widgets.column')} ${index + 1}`;
                                const isSorted = sortState?.colIndex === index;
                                const ariaSort = isSorted ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none';
                                return (
                                    <th
                                        key={index}
                                        aria-sort={ariaSort}
                                        className={`border-b border-border px-3.5 py-2.5 text-[12px] font-semibold whitespace-nowrap text-muted-foreground ${numericFlags[index] ? 'text-right tabular-nums' : 'text-left'}`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => toggleSort(index)}
                                            className={`inline-flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-inherit text-inherit transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${numericFlags[index] ? 'flex-row-reverse' : ''}`}
                                        >
                                            <span>{headerText}</span>
                                            <span aria-hidden="true" className={isSorted ? 'text-brand' : 'text-faint opacity-70'}>
                                                {isSorted ? (
                                                    sortState.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />
                                                ) : (
                                                    <ArrowUpDown className="size-3" />
                                                )}
                                            </span>
                                        </button>
                                    </th>
                                );
                            })}
                        </tr>
                    </thead>
                    <tbody>
                        {visibleRows.map((row, rowIndex) => (
                            <tr key={rowIndex} className="transition-colors hover:bg-paper/60">
                                {columns.map((column: any, colIndex: number) => (
                                    <td
                                        key={colIndex}
                                        className={`border-b border-border px-3.5 py-2.5 whitespace-nowrap text-foreground [tr:last-child_&]:border-b-0 ${numericFlags[colIndex] ? 'text-right font-mono text-[12.5px] tabular-nums' : 'text-left font-medium'}`}
                                    >
                                        {cell(row[column.key], column)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {canCollapse && (
                <button
                    type="button"
                    onClick={() => setExpanded((prev) => !prev)}
                    className="self-center cursor-pointer rounded-md border border-border bg-paper px-3 py-1 text-[12px] font-medium text-body transition-colors hover:border-border-strong hover:bg-white hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand motion-reduce:transition-none"
                >
                    {expanded ? t('widgets.collapseRows') : t('widgets.expandRows').replace('{count}', String(sortedRows.length))}
                </button>
            )}
        </div>
    );
};


const normalizeChartPoints = (widget: WidgetSpec) => {
    const data = Array.isArray(widget.data) ? widget.data : undefined;
    const series = Array.isArray(widget.series) ? widget.series : undefined;
    if (data && data.length > 0) return data;
    if (!series) return [];

    // `chart` widgets may contain ECharts-style series definitions rather than
    // the point-shaped data used by the lightweight renderer. Flatten those
    // definitions so replaying a saved widget cannot put a config object into
    // a React text node (for example label: { show, formatter, position }).
    const xAxis = widget.xAxis;
    const axisData = Array.isArray(xAxis?.data) ? xAxis.data : [];
    if (series.some((item: any) => Array.isArray(item?.data))) {
        return series.flatMap((item: any) => (
            Array.isArray(item?.data) ? item.data.map((value: unknown, index: number) => ({
                label: axisData[index] !== undefined
                    ? `${toDisplayText(item.name, 'Series')} · ${toDisplayText(axisData[index], String(index + 1))}`
                    : toDisplayText(item.name, `Data point ${index + 1}`),
                value: value && typeof value === 'object'
                    ? (value as Record<string, unknown>).value ?? (value as Record<string, unknown>).y ?? value
                    : value,
            })) : []
        ));
    }
    return series;
};

const renderChart = (widget: WidgetSpec, t: (key: string) => string) => {
    const points = normalizeChartPoints(widget);
    const values = points
        .map((point) => Number(point.value ?? point.y ?? 0))
        .filter((value) => Number.isFinite(value));
    const maxValue = values.length > 0 ? Math.max(...values, 1) : 1;

    return (
        <div className="grid gap-2.5">
            {points.map((point, index) => {
                const value = Number(point.value ?? point.y ?? 0);
                const width = `${Math.max(8, (value / maxValue) * 100)}%`;
                return (
                    <div key={index} className="grid gap-1">
                        <div className="flex justify-between text-[12px] text-body">
                            <span>{toDisplayText(point.label ?? point.x ?? point.name, `${t('widgets.dataPoint')} ${index + 1}`)}</span>
                            <span>{Number.isFinite(value) ? value : toDisplayText(point.value ?? point.y, '--')}</span>
                        </div>
                        <div className="h-2.5 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-link" style={{ width }} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

const renderSteps = (widget: WidgetSpec, t: (key: string) => string) => {
    const steps = Array.isArray(widget.data) ? widget.data : [];
    return (
        <ol className="m-0 grid list-decimal gap-2.5 pl-5">
            {steps.map((step, index) => (
                <li key={index} className="text-foreground">
                    <div className="font-semibold">{toDisplayText(step.title ?? step.label, `${t('widgets.step')} ${index + 1}`)}</div>
                    {(step.description ?? step.content) && (
                        <div className="mt-1 text-[13px] text-body">{toDisplayText(step.description ?? step.content)}</div>
                    )}
                </li>
            ))}
        </ol>
    );
};

const renderRichTextBlock = (block: any, t: (key: string) => string) => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type === 'notice') {
        return <div className="text-[12px] text-muted-foreground">{block.text || t('widgets.preview')}</div>;
    }
    if (block.type === 'table' && Array.isArray(block.headers) && Array.isArray(block.rows)) {
        const rows = block.rows.slice(0, 12).map((row: any) => (Array.isArray(row) ? row : Object.values(row || {})));
        return (
            <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                    <thead><tr>{block.headers.map((header: any, index: number) => <th key={index} className="border-b border-border px-[9px] py-[7px] text-left text-muted-foreground">{String(header)}</th>)}</tr></thead>
                    <tbody>{rows.map((row: any[], rowIndex: number) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-muted px-[9px] py-[7px]">{String(cell ?? '')}</td>)}</tr>)}</tbody>
                </table>
            </div>
        );
    }
    if ((block.type === 'ol' || block.type === 'ul' || block.type === 'list') && Array.isArray(block.items)) {
        const List = block.type === 'ul' || block.type === 'list' ? 'ul' : 'ol';
        return <List className={`m-0 pl-5 ${List === 'ul' ? 'list-disc' : 'list-decimal'}`}>{block.items.slice(0, 10).map((item: any, index: number) => <li key={index}>{String(item)}</li>)}</List>;
    }
    return block.text ?? block.content ?? JSON.stringify(block);
};

const renderRichText = (widget: WidgetSpec, t: (key: string) => string) => {
    const blocks = Array.isArray(widget.data) ? widget.data : [];
    const visibleBlocks: any[] = [];
    let charCount = 0;
    for (const block of blocks) {
        const size = typeof block === 'string' ? block.length : JSON.stringify(block).length;
        if (visibleBlocks.length >= 7 || charCount + size > 2600) break;
        visibleBlocks.push(block);
        charCount += size;
    }
    const truncated = visibleBlocks.length < blocks.length;
    return (
        <div className="grid gap-2 text-[14px] leading-[1.6] text-foreground">
            {visibleBlocks.map((block, index) => <div key={index}>{renderRichTextBlock(block, t)}</div>)}
            {truncated && <div className="text-[12px] text-muted-foreground">{t('widgets.richTextTruncated')}</div>}
        </div>
    );
};

// ─── FileLinkWidget ────────────────────────────────────────────────────────────

interface FileLinkWidgetProps {
    widget: WidgetSpec;
    t: (key: string) => string;
    currentSessionId?: string;
}

const FileLinkWidget: React.FC<FileLinkWidgetProps> = ({ widget, t, currentSessionId }) => {
    const { file_path, download_url, file_type, title, subtitle } = widget;
    const { openPreview } = usePreview();

    // Download and preview resolve the same file, whichever way the link names it.
    const fullUrl = resolveWorkspaceDownloadUrl(download_url, currentSessionId);
    const previewUrl = resolveWorkspacePreviewUrl(download_url, currentSessionId);
    const normalizedFileType = (file_type || file_path?.split('.').pop() || '').toLowerCase();
    const canPreview = PREVIEWABLE_FILE_TYPES.has(normalizedFileType);

    const handleDownload = () => {
        if (fullUrl) {
            const link = document.createElement('a');
            link.href = fullUrl;
            link.download = file_path?.split('/').pop() || 'dashboard.html';
            link.click();
        }
    };

    const FileIcon = (() => {
        switch (normalizedFileType) {
            case 'html':
            case 'htm':
                return FileCode;
            case 'pdf':
                return FileText;
            case 'xlsx':
            case 'xls':
            case 'excel':
                return FileSpreadsheet;
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
            case 'webp':
            case 'svg':
                return Image;
            default:
                return File;
        }
    })();

    return (
        <div className="overflow-hidden rounded-lg border border-border bg-white">
            <div className="flex items-center gap-4 bg-paper px-5 py-4">
                <div className="flex items-center text-body"><FileIcon size={30} /></div>
                <div className="flex-1">
                    <div className="mb-1 text-[16px] font-semibold text-foreground">
                        {title}
                    </div>
                    {subtitle && (
                        <div className="text-[13px] text-muted-foreground">
                            {subtitle}
                        </div>
                    )}
                </div>
                <div className={FILE_ACTIONS}>
                    {canPreview && previewUrl && (
                        <button
                            type="button"
                            className={FILE_ACTION_BUTTON}
                            onClick={() => openPreview(previewUrl, title || file_path || 'preview', normalizedFileType)}
                            title={t('widgets.preview') || '查看'}
                            aria-label={t('widgets.preview') || '查看'}
                        >
                            <Eye size={15} strokeWidth={2} />
                        </button>
                    )}
                    <button
                        type="button"
                        className={FILE_ACTION_BUTTON}
                        onClick={handleDownload}
                        title={t('widgets.download') || '下载'}
                        aria-label={t('widgets.download') || '下载'}
                    >
                        <Download size={15} strokeWidth={2} />
                    </button>
                </div>
            </div>
        </div>
    );
};

// ─── WidgetRenderer ────────────────────────────────────────────────────────────

const WidgetRenderer: React.FC<WidgetRendererProps> = ({ widget, currentSessionId }) => {
    const { t } = useLanguage();

    const body = (() => {
        if (widget.status === 'error') {
            return <div className="text-[13px] text-destructive">{widget.error || t('widgets.renderFail')}</div>;
        }

        switch (widget.kind) {
            case 'kpi':
            case 'metric_cards':
                return renderMetricCards(widget, t);
            case 'table':
                return <TableWidget widget={widget} t={t} />;
            case 'chart':
                // A transcript can hold charts without a resolved ChartSpec; those are drawn from their data rows.
                return widget.contractVersion === CURRENT_WIDGET_CONTRACT && widget.chartSpec && widget.dataset
                    ? <Suspense fallback={<div style={{ height: 360 }} />}><ChartSpecWidget widget={{ title: widget.title, chartSpec: widget.chartSpec, dataset: widget.dataset, ...(widget.disclosure ? { disclosure: widget.disclosure } : {}), ...(widget.disclosureItems ? { disclosureItems: widget.disclosureItems } : {}), ...(widget.declaredFields ? { declaredFields: widget.declaredFields } : {}), ...(widget.semanticChecks ? { semanticChecks: widget.semanticChecks } : {}), ...(widget.derivedFrom ? { derivedFrom: widget.derivedFrom } : {}) }} /></Suspense>
                    : renderChart(widget, t);
            case 'steps':
                return renderSteps(widget, t);
            case 'rich_text':
                return renderRichText(widget, t);
            case 'echarts':
                // A raw ECharts option in a transcript was never checked, so it is not drawn (ADR-0008 decision 11).
                return <div role="note" className="text-[13px] text-muted-foreground">{t('widgets.uncheckedEcharts')}</div>;
            case 'file_link':
                return <FileLinkWidget widget={widget} t={t} currentSessionId={currentSessionId} />;
            default:
                return <pre className="m-0 text-[12px] whitespace-pre-wrap">{JSON.stringify(widget, null, 2)}</pre>;
        }
    })();

    return (
        <div className="mt-2.5 rounded-xl border border-border bg-white p-3.5">
            <div className="text-[15px] font-semibold text-foreground">{widget.title}</div>
            {widget.subtitle && <div className="mt-1 text-[12px] text-muted-foreground">{widget.subtitle}</div>}
            <div className="mt-3">{body}</div>
        </div>
    );
};

export default WidgetRenderer;
