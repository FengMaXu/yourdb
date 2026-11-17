import type { WidgetSpec } from '../api/client';

export interface ToolData {
    toolCallId: string;
    messageId: string;
    turnKey?: string;
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

export type AuditStatus = 'verified' | 'assumed';

export interface AuditSpecRow {
    path: string;
    label: string;
    value: string;
    status: AuditStatus;
    badge: string;
    citation?: string;
}

export interface KnowledgeEvidence {
    toolName: string;
    source: string;
    excerpt: string;
}

export interface PublicationReceiptSummary {
    receiptId: string;
    format: 'inline' | 'csv';
    disclosureSummary?: string;
    unverifiedPaths: string[];
    fanoutStatus?: string;
}

export interface BasisAuditData {
    specItems: AuditSpecRow[];
    knowledgeEvidence: KnowledgeEvidence[];
    sqlText?: string;
    tabularDetails?: { columns: string[]; rows: unknown[][] };
    rowCountText?: string;
    publicationReceipt?: PublicationReceiptSummary;
    fanoutFinding?: string;
}

export function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

export function parseArgsRecord(args: unknown): Record<string, any> | null {
    if (typeof args === 'string') {
        try {
            const parsed = JSON.parse(args);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, any> : null;
}

/** Extract clean `{ columns, rows }` from either direct `{ columns, rows }` or `QueryExecutionView.preview`. */
export function extractTabularDetails(details: unknown): { columns: string[]; rows: unknown[][] } | undefined {
    const record = asRecord(details);
    if (!record) return undefined;
    const candidate = asRecord(record.preview) ?? record;
    if (
        Array.isArray(candidate.columns)
        && candidate.columns.every((col) => typeof col === 'string')
        && Array.isArray(candidate.rows)
        && candidate.rows.every((row) => Array.isArray(row))
    ) {
        return { columns: candidate.columns as string[], rows: candidate.rows as unknown[][] };
    }
    return undefined;
}

/** Fallback parser for pipe-delimited `[RESULT_CANDIDATE]` preview text when structured `details` is absent. */
function parseResultCandidateTable(resultText: string | undefined): { columns: string[]; rows: unknown[][] } | undefined {
    if (!resultText || !resultText.includes('[RESULT_CANDIDATE]')) return undefined;
    const lines = resultText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const bodyLines = lines.filter((line) => !line.startsWith('[') && line !== '(truncated preview)');
    if (bodyLines.length < 2) return undefined;
    const header = bodyLines[0];
    if (!header.includes(' | ')) return undefined;
    const columns = header.split(' | ').map((col) => col.trim());
    const rows = bodyLines
        .slice(1)
        .filter((line) => line.includes(' | ') || columns.length === 1)
        // Keep cells verbatim: the audit snapshot must not turn '00123' into 123 or years into grouped numbers.
        .map((line) => line.split(' | ').map((cell) => {
            const trimmed = cell.trim();
            return trimmed === 'NULL' ? null : trimmed;
        }));
    return rows.length > 0 ? { columns, rows } : undefined;
}

/** Extract clean row count from structured tool output or legacy `"N rows"` strings; never returns raw protocol headers. */
export function extractQueryRowCount(tool: Pick<ToolData, 'result' | 'details'>): { count: number; truncated?: boolean } | undefined {
    const preview = asRecord(asRecord(tool.details)?.preview);
    if (preview) {
        const count = typeof preview.rowCount === 'number'
            ? preview.rowCount
            : Array.isArray(preview.rows)
                ? preview.rows.length
                : undefined;
        if (count !== undefined) {
            return { count, truncated: Boolean(preview.truncated) };
        }
    }
    const direct = asRecord(tool.details);
    if (Array.isArray(direct?.rows)) {
        return { count: direct.rows.length };
    }
    const trimmed = tool.result?.trim() ?? '';
    const legacyMatch = /^(\d+)\s+rows?$/i.exec(trimmed);
    if (legacyMatch) {
        return { count: Number(legacyMatch[1]) };
    }
    const probeMatch = /\[PROBE\][^\n]*\brows=(\d+)/.exec(trimmed);
    if (probeMatch) {
        return { count: Number(probeMatch[1]) };
    }
    const parsedCandidate = parseResultCandidateTable(trimmed);
    if (parsedCandidate) {
        return {
            count: parsedCandidate.rows.length,
            truncated: trimmed.includes('(truncated preview)'),
        };
    }
    return undefined;
}

const SPEC_PATH_ORDER: readonly string[] = [
    'population.entity',
    'population.eligibility',
    'population.conditions',
    'population.source',
    'population.time',
    'population.timeField',
    'population.missing',
    'population.joinMultiplicity',
    'measure.formula',
    'measure.countGrain',
    'measure.denominator',
    'measure.window',
    'grouping',
    'selection',
    'selection.ties',
    'output',
];

const SPEC_PATH_LABELS: Record<string, { zh: string; en: string }> = {
    'population.entity': { zh: '统计对象', en: 'Entity' },
    'population.eligibility': { zh: '纳入资格', en: 'Eligibility' },
    'population.conditions': { zh: '筛选条件', en: 'Conditions' },
    'population.source': { zh: '数据来源', en: 'Source' },
    'population.time': { zh: '时间范围', en: 'Time Window' },
    'population.timeField': { zh: '时间字段', en: 'Time Field' },
    'population.missing': { zh: '缺期处理', en: 'Missing Periods' },
    'population.joinMultiplicity': { zh: '连接去重', en: 'Join Grain' },
    'measure.formula': { zh: '度量公式', en: 'Formula' },
    'measure.countGrain': { zh: '计数粒度', en: 'Count Grain' },
    'measure.denominator': { zh: '分母总体', en: 'Denominator' },
    'measure.window': { zh: '窗口口径', en: 'Window' },
    grouping: { zh: '分组粒度', en: 'Grouping' },
    selection: { zh: '排序选取', en: 'Selection' },
    'selection.ties': { zh: '并列处理', en: 'Ties Policy' },
    output: { zh: '输出形态', en: 'Output' },
};

export function specPathLabel(path: string, isEn: boolean): string {
    const known = SPEC_PATH_LABELS[path];
    if (known) return isEn ? known.en : known.zh;
    if (path.startsWith('measures.')) {
        return isEn ? `Measure · ${path.slice('measures.'.length)}` : `指标定义 · ${path.slice('measures.'.length)}`;
    }
    return path;
}

function formatMeasureFormula(formula: unknown): string {
    if (formula === null || formula === undefined) return '';
    if (typeof formula === 'string' || typeof formula === 'number') return String(formula);
    const rec = asRecord(formula);
    if (!rec) return JSON.stringify(formula);
    if (typeof rec.ref === 'string') return `ref:${rec.ref}`;

    const op = typeof rec.op === 'string' ? rec.op : '';
    const perSuffix = typeof rec.per === 'string' && rec.per ? ` [per ${rec.per}]` : '';
    if (op === 'ratio' || op === 'percentage') {
        const num = formatMeasureFormula(rec.numerator);
        const den = formatMeasureFormula(rec.denominator);
        return `${op === 'percentage' ? '100% · ' : ''}(${num}) / (${den})${perSuffix}`;
    }
    if (op === 'difference' || op === 'change_rate' || op === 'pp_difference') {
        const from = formatMeasureFormula(rec.from);
        const to = formatMeasureFormula(rec.to);
        return `${op}(${from} -> ${to})${perSuffix}`;
    }
    if (op === 'custom' && typeof rec.description === 'string') {
        return `${rec.description}${rec.of !== undefined ? ` (${formatMeasureFormula(rec.of)})` : ''}${perSuffix}`;
    }
    if (op && rec.of !== undefined) {
        return `${op.toUpperCase()}(${formatMeasureFormula(rec.of)})${perSuffix}`;
    }
    return JSON.stringify(rec);
}

function formatSpecFieldValue(path: string, value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (path === 'measure.formula' || path.startsWith('measures.')) {
        const rec = asRecord(value);
        if (rec && 'formula' in rec && path.startsWith('measures.')) {
            return formatMeasureFormula(rec.formula);
        }
        return formatMeasureFormula(value);
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const rec = asRecord(item);
                if (!rec) return String(item);
                if (typeof rec.condition === 'string') {
                    return rec.stage ? `[${rec.stage}] ${rec.condition}` : rec.condition;
                }
                if (typeof rec.key === 'string') {
                    return rec.grain ? `${rec.key} (${rec.grain})` : rec.key;
                }
                return formatSpecFieldValue(path, item);
            })
            .filter(Boolean)
            .join(' · ');
    }
    const rec = asRecord(value);
    if (rec) {
        if (path === 'population.entity' && typeof rec.name === 'string') {
            const keys = Array.isArray(rec.keyColumns) && rec.keyColumns.length > 0
                ? ` (${rec.keyColumns.join(', ')})`
                : '';
            return `${rec.name}${keys}`;
        }
        if (path === 'population.source' && Array.isArray(rec.tables)) {
            return `${rec.tables.join(' ⋈ ')}${typeof rec.note === 'string' && rec.note ? ` · ${rec.note}` : ''}`;
        }
        if (path === 'population.time' && typeof rec.expression === 'string') {
            return rec.boundary ? `${rec.expression} (${rec.boundary})` : rec.expression;
        }
        if (path === 'selection' && rec.n !== undefined) {
            return `Top ${rec.n}${rec.orderBy ? ` · ${typeof rec.orderBy === 'string' ? rec.orderBy : JSON.stringify(rec.orderBy)}` : ''}`;
        }
        if (path === 'output') {
            const parts: string[] = [];
            if (rec.rowMode) parts.push(String(rec.rowMode));
            if (rec.rowCount !== undefined) parts.push(`${rec.rowCount} rows`);
            if (Array.isArray(rec.columns)) parts.push(rec.columns.join(', '));
            return parts.join(' · ') || JSON.stringify(rec);
        }
        if ('value' in rec) {
            return formatSpecFieldValue(path, rec.value);
        }
    }
    return JSON.stringify(value);
}

function formatCitationSource(source: string, isEn: boolean): string {
    if (source.startsWith('knowledge:')) return source.slice('knowledge:'.length);
    if (source.startsWith('schema:')) return isEn ? `schema ${source.slice('schema:'.length)}` : `表结构 ${source.slice('schema:'.length)}`;
    if (source.startsWith('clarification:')) return isEn ? 'User Clarification' : '用户确认';
    if (source === 'message') return isEn ? 'Conversation' : '对话确认';
    return source;
}

function badgeFromEvidenceSource(source: string | undefined, isEn: boolean): string {
    if (!source) return isEn ? 'Verified · Evidence' : '已核实 · 依据';
    if (source.startsWith('knowledge:')) return isEn ? 'Verified · Doc' : '已核实 · 文档';
    if (source.startsWith('clarification:') || source === 'message') return isEn ? 'Verified · User' : '已核实 · 确认';
    if (source.startsWith('schema:')) return isEn ? 'Verified · Schema' : '已核实 · 表结构';
    return isEn ? 'Verified · Evidence' : '已核实 · 依据';
}

function splitTopLevelComma(input: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inSingleQuote = false;
    let start = 0;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (ch === "'" && input[i - 1] !== '\\') {
            inSingleQuote = !inSingleQuote;
            continue;
        }
        if (inSingleQuote) continue;
        if (ch === '(') depth += 1;
        else if (ch === ')' && depth > 0) depth -= 1;
        else if (ch === ',' && depth === 0) {
            const item = input.slice(start, i).trim();
            if (item) parts.push(item);
            start = i + 1;
        }
    }
    const tail = input.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
}

function splitTopLevelAnd(input: string): string[] {
    const tokens: string[] = [];
    let depth = 0;
    let inSingleQuote = false;
    let start = 0;
    // `x BETWEEN a AND b` owns the next top-level AND; it is not a conjunction.
    let pendingBetween = false;

    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (ch === "'" && input[i - 1] !== '\\') {
            inSingleQuote = !inSingleQuote;
            continue;
        }
        if (inSingleQuote) continue;
        if (ch === '(') depth += 1;
        else if (ch === ')' && depth > 0) depth -= 1;
        else if (depth === 0 && /^\s+BETWEEN\s+/i.test(input.slice(i))) {
            pendingBetween = true;
        }
        else if (depth === 0 && /^\s+AND\s+/i.test(input.slice(i))) {
            const match = /^\s+AND\s+/i.exec(input.slice(i));
            if (match && pendingBetween) {
                pendingBetween = false;
                i += match[0].length - 1;
            } else if (match) {
                const segment = input.slice(start, i).trim();
                if (segment) tokens.push(segment);
                i += match[0].length - 1;
                start = i + 1;
            }
        }
    }
    const tail = input.slice(start).trim();
    if (tail) tokens.push(tail);
    return tokens;
}

function parseSqlAudit(sql: string) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    const tables: string[] = [];
    // A FROM whose operand closes a paren is a function argument (EXTRACT(YEAR FROM col)), not a table.
    const tablePattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)\b(?!\s*\))/gi;
    let tableMatch = tablePattern.exec(compact);
    while (tableMatch) {
        if (!tables.includes(tableMatch[1])) {
            tables.push(tableMatch[1]);
        }
        tableMatch = tablePattern.exec(compact);
    }

    const selectMatch = /^\s*SELECT\b(?:\s+DISTINCT\b)?\s+([\s\S]*?)\s+\bFROM\b/i.exec(compact);
    const selectExpressions = selectMatch ? splitTopLevelComma(selectMatch[1]) : [];
    const measureExpressions = selectExpressions.filter((expr) => (
        /\b(?:SUM|COUNT|AVG|MIN|MAX|ROUND|COALESCE|CASE)\s*\(/i.test(expr) || /[+\-*/]/.test(expr)
    ));

    const whereMatch = /\bWHERE\b\s+([\s\S]*?)(?=\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b|;|$)/i.exec(compact);
    const whereConditions = whereMatch ? splitTopLevelAnd(whereMatch[1]) : [];
    const timeFilters = whereConditions.filter((cond) => /\b\w*(?:month|date|time|year|quarter|day|snapshot|period)\w*\b/i.test(cond));
    const entityFilters = whereConditions.filter((cond) => !timeFilters.includes(cond));

    const groupByMatch = /\bGROUP\s+BY\b\s+([\s\S]*?)(?=\b(?:ORDER\s+BY|HAVING|LIMIT)\b|;|$)/i.exec(compact);
    const groupBy = groupByMatch ? groupByMatch[1].trim() : undefined;

    return {
        tables,
        measureExpressions: measureExpressions.length > 0 ? measureExpressions : selectExpressions,
        timeFilters,
        entityFilters,
        groupBy,
    };
}

function extractRevisionSpecRows(
    revisionFields: readonly Record<string, any>[],
    submittedByPath: Record<string, unknown>,
    isEn: boolean,
): AuditSpecRow[] {
    const byPath = new Map<string, Record<string, any>>();
    for (const field of revisionFields) {
        if (typeof field?.path === 'string') {
            byPath.set(field.path, field);
        }
    }
    const orderedPaths = [
        ...SPEC_PATH_ORDER.filter((path) => byPath.has(path)),
        ...[...byPath.keys()].filter((path) => !SPEC_PATH_ORDER.includes(path)),
    ];

    const rows: AuditSpecRow[] = [];
    for (const path of orderedPaths) {
        const field = byPath.get(path)!;
        if (field.status === 'not_applicable') continue;

        const submitted = asRecord(submittedByPath[path]);
        const cites = Array.isArray(submitted?.cite) ? submitted.cite : [];
        const firstCite = asRecord(cites[0]);
        const citeSource = typeof firstCite?.source === 'string' ? firstCite.source : undefined;
        const citeQuote = typeof firstCite?.quote === 'string' ? firstCite.quote : undefined;
        const requestQuote = typeof submitted?.quote === 'string' ? submitted.quote : undefined;

        let value = formatSpecFieldValue(path, field.value);
        if (!value && Array.isArray(field.alternatives) && field.alternatives.length > 0) {
            value = field.alternatives
                .map((alt: any) => `${alt.id}: ${formatSpecFieldValue(path, alt.value)}`)
                .join(' / ');
        }
        if (!value) continue;

        let status: AuditStatus = 'assumed';
        let badge = isEn ? 'Assumed' : '模型假设';
        if (field.status === 'request') {
            status = 'verified';
            badge = isEn ? 'Verified · Request' : '已核实 · 题面';
        } else if (field.status === 'evidence') {
            status = 'verified';
            badge = badgeFromEvidenceSource(citeSource, isEn);
        } else if (field.status === 'equivalent') {
            status = 'verified';
            badge = isEn ? 'Verified · Equivalent' : '已核实 · 探针等价';
        } else if (field.status === 'decided') {
            if (field.verified === true) {
                status = 'verified';
                badge = citeSource
                    ? badgeFromEvidenceSource(citeSource, isEn)
                    : (isEn ? 'Verified' : '已核实');
            } else {
                status = 'assumed';
                badge = isEn ? 'Assumed Decision' : '模型假设';
            }
        } else if (field.status === 'open') {
            status = 'assumed';
            badge = isEn ? 'Pending' : '待确认';
        }

        const citation = citeSource
            ? `${formatCitationSource(citeSource, isEn)}${citeQuote ? `：${citeQuote}` : ''}`
            : requestQuote
                ? `${isEn ? 'Request' : '题面'}：“${requestQuote}”`
                : typeof field.rationale === 'string' && field.rationale.trim()
                    ? field.rationale.trim()
                    : undefined;

        rows.push({
            path,
            label: specPathLabel(path, isEn),
            value,
            status,
            badge,
            ...(citation ? { citation } : {}),
        });
    }
    return rows;
}

function extractFlatSubmittedSpecRows(
    submittedByPath: Record<string, unknown>,
    isEn: boolean,
): AuditSpecRow[] {
    const entries = Object.entries(submittedByPath);
    const rows: AuditSpecRow[] = [];
    for (const [path, raw] of entries) {
        if (raw === null || raw === undefined || raw === 'n/a') continue;
        const rec = asRecord(raw);
        if (!rec) {
            rows.push({
                path,
                label: specPathLabel(path, isEn),
                value: formatSpecFieldValue(path, raw),
                status: 'assumed',
                badge: isEn ? 'Assumed' : '模型假设',
            });
            continue;
        }
        const cites = Array.isArray(rec.cite) ? rec.cite : [];
        const firstCite = asRecord(cites[0]);
        const citeSource = typeof firstCite?.source === 'string' ? firstCite.source : undefined;
        const citeQuote = typeof firstCite?.quote === 'string' ? firstCite.quote : undefined;
        const hasEvidence = cites.length > 0
            || rec.basis === 'request'
            || (Array.isArray(rec.evidenceIds) && rec.evidenceIds.length > 0);
        const value = formatSpecFieldValue(path, 'value' in rec ? rec.value : rec);
        if (!value) continue;

        const status: AuditStatus = hasEvidence ? 'verified' : 'assumed';
        const badge = hasEvidence
            ? (rec.basis === 'request' ? (isEn ? 'Verified · Request' : '已核实 · 题面') : badgeFromEvidenceSource(citeSource, isEn))
            : (isEn ? 'Assumed' : '模型假设');
        const citation = citeSource
            ? `${formatCitationSource(citeSource, isEn)}${citeQuote ? `：${citeQuote}` : ''}`
            : typeof rec.quote === 'string'
                ? `“${rec.quote}”`
                : typeof rec.rationale === 'string'
                    ? rec.rationale
                    : undefined;

        rows.push({
            path,
            label: specPathLabel(path, isEn),
            value,
            status,
            badge,
            ...(citation ? { citation } : {}),
        });
    }
    return rows;
}

function summarizeSubagentReport(markdown: string): string {
    const lines = markdown
        .split(/\r?\n/)
        .map((line) => line.replace(/^#+\s*/, '').trim())
        .filter((line) => Boolean(line) && !line.startsWith('---') && !line.startsWith('>'));
    return lines.slice(0, 3).join(' · ').slice(0, 240);
}

export function extractBasisAudit(tools: ToolData[], isEn: boolean): BasisAuditData {
    const knowledgeEvidence: KnowledgeEvidence[] = [];
    const submittedByPath: Record<string, any> = {};
    let latestRevisionFields: readonly Record<string, any>[] | undefined;

    for (const tool of tools) {
        if (tool.status === 'error') continue;
        const argsObj = parseArgsRecord(tool.args);

        if (tool.name === 'search_knowledge' && tool.status === 'done' && tool.result?.trim()) {
            knowledgeEvidence.push({
                toolName: tool.name,
                source: typeof argsObj?.query === 'string' ? argsObj.query.trim() : tool.name,
                excerpt: tool.result.trim(),
            });
        } else if (tool.name === 'read_knowledge' && tool.status === 'done') {
            knowledgeEvidence.push({
                toolName: tool.name,
                source: typeof argsObj?.path === 'string' ? argsObj.path.trim() : tool.name,
                excerpt: tool.result?.trim() ?? '',
            });
        } else if (tool.name === 'subagent' && tool.status === 'done') {
            const outcomes = Array.isArray(tool.details) ? tool.details : [];
            for (const outcome of outcomes) {
                const rec = asRecord(outcome);
                const markdown = asRecord(rec?.report)?.markdown;
                if (typeof markdown === 'string' && markdown.trim()) {
                    knowledgeEvidence.push({
                        toolName: 'subagent',
                        source: `${String(rec?.key ?? 'explorer')}${rec?.role ? ` (${String(rec.role)})` : ''}`,
                        excerpt: summarizeSubagentReport(markdown),
                    });
                }
            }
        } else if (tool.name === 'set_answer_spec' || tool.name === 'inspect_answer') {
            const fieldsArgs = asRecord(argsObj?.fields);
            if (fieldsArgs) {
                for (const [path, val] of Object.entries(fieldsArgs)) {
                    submittedByPath[path] = val;
                }
            }
            const detailsRec = asRecord(tool.details);
            const revisionCandidate = Array.isArray(detailsRec?.fields)
                ? detailsRec.fields
                : Array.isArray(asRecord(detailsRec?.currentRevision)?.fields)
                    ? asRecord(detailsRec?.currentRevision)?.fields
                    : undefined;
            if (Array.isArray(revisionCandidate)) {
                latestRevisionFields = revisionCandidate as readonly Record<string, any>[];
            }
        }
    }

    const queryTools = tools.filter((item) => item.name === 'query_database');
    const queryTool = [...queryTools].reverse().find((item) => parseArgsRecord(item.args)?.kind === 'result' && item.status !== 'error')
        ?? [...queryTools].reverse().find((item) => item.status !== 'error')
        ?? queryTools[queryTools.length - 1];
    const queryArgs = queryTool ? parseArgsRecord(queryTool.args) : null;
    const rawSql = queryArgs?.sql ?? queryArgs?.query;
    const sqlText = typeof rawSql === 'string' && rawSql.trim() ? rawSql.trim() : undefined;

    const tabularDetails = (queryTool ? extractTabularDetails(queryTool.details) : undefined)
        ?? parseResultCandidateTable(queryTool?.result);
    const rowCountInfo = queryTool ? extractQueryRowCount(queryTool) : undefined;
    const rowCountText = rowCountInfo
        ? (isEn
            ? `${rowCountInfo.count}${rowCountInfo.truncated ? '+' : ''} rows`
            : `返回 ${rowCountInfo.count}${rowCountInfo.truncated ? '+' : ''} 行`)
        : undefined;

    const publishTool = [...tools].reverse().find((item) => (
        (item.name === 'publish_query_result' || item.name === 'export_query') && item.status !== 'error'
    ));
    const publishDetails = publishTool ? asRecord(publishTool.details) : undefined;
    const publicationReceipt: PublicationReceiptSummary | undefined = publishDetails && typeof publishDetails.receiptId === 'string'
        ? {
            receiptId: publishDetails.receiptId,
            format: publishDetails.format === 'csv' || publishTool?.name === 'export_query' ? 'csv' : 'inline',
            ...(typeof asRecord(publishDetails.disclosure)?.summary === 'string'
                ? { disclosureSummary: asRecord(publishDetails.disclosure)!.summary as string }
                : {}),
            unverifiedPaths: Array.isArray(asRecord(publishDetails.disclosure)?.unverifiedFields)
                ? (asRecord(publishDetails.disclosure)!.unverifiedFields as any[])
                    .map((item) => String(item?.path ?? ''))
                    .filter(Boolean)
                : [],
            ...(typeof asRecord(publishDetails.fanout)?.status === 'string'
                ? { fanoutStatus: asRecord(publishDetails.fanout)!.status as string }
                : {}),
        }
        : undefined;

    const queryFanout = asRecord(asRecord(queryTool?.details)?.fanout);
    const fanoutStatus = publicationReceipt?.fanoutStatus ?? (typeof queryFanout?.status === 'string' ? queryFanout.status : undefined);
    const fanoutFinding = fanoutStatus === 'finding'
        ? (isEn ? 'Potential join multiplicity fanout detected on primary source key.' : '检测到表连接存在潜在指标倍增（Fanout），请核对连接基数约束。')
        : undefined;

    let specItems: AuditSpecRow[] = [];
    if (latestRevisionFields && latestRevisionFields.length > 0) {
        specItems = extractRevisionSpecRows(latestRevisionFields, submittedByPath, isEn);
    } else if (Object.keys(submittedByPath).length > 0) {
        specItems = extractFlatSubmittedSpecRows(submittedByPath, isEn);
    } else if (sqlText) {
        const sqlAudit = parseSqlAudit(sqlText);
        const searchDoc = knowledgeEvidence.find((item) => item.toolName === 'search_knowledge' || item.toolName === 'subagent');
        const schemaDoc = knowledgeEvidence.find((item) => item.toolName === 'read_knowledge');

        const popParts: string[] = [];
        if (sqlAudit.tables.length > 0) {
            popParts.push(`${isEn ? 'Source' : '数据来源'}：${sqlAudit.tables.join(' ⋈ ')}`);
        }
        if (sqlAudit.entityFilters.length > 0) {
            popParts.push(`${isEn ? 'Filter' : '资格筛选'}：${sqlAudit.entityFilters.join(' AND ')}`);
        }
        if (popParts.length > 0) {
            specItems.push({
                path: 'population',
                label: isEn ? 'Population' : '统计总体',
                value: popParts.join('\n'),
                status: searchDoc ? 'verified' : 'assumed',
                badge: searchDoc
                    ? (isEn ? 'Verified · Doc' : '已核实 · 文档')
                    : (isEn ? 'Assumed' : '模型假设'),
                citation: searchDoc?.excerpt,
            });
        }

        if (sqlAudit.timeFilters.length > 0) {
            specItems.push({
                path: 'time',
                label: isEn ? 'Time Window' : '时间范围',
                value: sqlAudit.timeFilters.join(' AND '),
                // Read off model-written SQL only — nothing checked it against the request.
                status: 'assumed',
                badge: isEn ? 'Assumed · From SQL' : '模型假设 · 取自 SQL',
            });
        }

        if (sqlAudit.measureExpressions.length > 0) {
            specItems.push({
                path: 'measure',
                label: isEn ? 'Measure' : '度量公式',
                value: sqlAudit.measureExpressions.join('\n'),
                status: schemaDoc ? 'verified' : 'assumed',
                badge: schemaDoc
                    ? (isEn ? 'Verified · Schema' : '已核实 · 表结构')
                    : (isEn ? 'Assumed' : '模型假设'),
                citation: schemaDoc ? `${schemaDoc.source}${schemaDoc.excerpt ? ` · ${schemaDoc.excerpt}` : ''}` : undefined,
            });
        }

        if (sqlAudit.groupBy) {
            specItems.push({
                path: 'grouping',
                label: isEn ? 'Grouping' : '分组粒度',
                value: sqlAudit.groupBy,
                status: searchDoc ? 'verified' : 'assumed',
                badge: searchDoc
                    ? (isEn ? 'Verified · Doc' : '已核实 · 文档')
                    : (isEn ? 'Assumed · From SQL' : '模型假设 · 取自 SQL'),
            });
        }
    }

    return {
        specItems,
        knowledgeEvidence,
        sqlText,
        tabularDetails,
        rowCountText,
        publicationReceipt,
        fanoutFinding,
    };
}

/**
 * Returns true when a turn's extracted Answer Spec / publication has no assumed or unverified items.
 * Turns without any tool calls (e.g., plain text answers) default to true.
 */
export function isTurnAuditVerified(tools: ToolData[], isEn = false): boolean {
    if (tools.length === 0) return true;
    return isBasisAuditVerified(extractBasisAudit(tools, isEn));
}

/** The one verification rule: no disclosure, no unverified publication fields, no assumed spec items. */
export function isBasisAuditVerified(audit: BasisAuditData): boolean {
    if (audit.publicationReceipt?.disclosureSummary || (audit.publicationReceipt?.unverifiedPaths.length ?? 0) > 0) {
        return false;
    }
    if (audit.specItems.length === 0) return true;
    return audit.specItems.every((item) => item.status === 'verified');
}

/** Formats a compact one-line basis summary for BasisDisclosureFooter when no trailing `口径：` text was written. */
export function formatTurnBasisSummary(audit: BasisAuditData, isEn: boolean): string | undefined {
    if (audit.specItems.length === 0 && !audit.publicationReceipt) {
        return undefined;
    }
    const findValue = (prefix: string) => audit.specItems.find((item) => item.path === prefix)?.value;
    const entity = findValue('population.entity') ?? findValue('population');
    const time = findValue('population.time') ?? findValue('time');
    const grouping = findValue('grouping');
    const verifiedCount = audit.specItems.filter((item) => item.status === 'verified').length;
    const assumedCount = audit.specItems.filter((item) => item.status === 'assumed').length;

    const parts: string[] = [];
    if (entity) parts.push(entity.split('\n')[0]);
    if (time) parts.push(time);
    if (grouping) parts.push(isEn ? `by ${grouping}` : `按 ${grouping} 分组`);
    if (audit.specItems.length > 0) {
        if (isEn) {
            parts.push(`${verifiedCount}/${audit.specItems.length} clauses verified`);
        } else {
            parts.push(assumedCount > 0 ? `已核实 ${verifiedCount} 项，含 ${assumedCount} 项假设` : `已核实 ${verifiedCount} 项口径`);
        }
    } else if (audit.publicationReceipt) {
        parts.push(isEn ? `Receipt ${audit.publicationReceipt.receiptId.slice(0, 12)}` : `发布回执 ${audit.publicationReceipt.receiptId.slice(0, 12)}`);
    }
    return parts.join(' · ');
}
