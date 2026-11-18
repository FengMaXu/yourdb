import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ToolPanel, { type ToolData } from '../ToolPanel';
import { LanguageProvider } from '../../context/LanguageContext';

const realSessionTools: ToolData[] = [
    {
        toolCallId: 'sub-1',
        messageId: 'm1',
        turnKey: 'turn-2',
        name: 'subagent',
        args: { tasks: [{ key: 'region', role: 'explorer', task: '查询华东华南定义与订单折扣口径' }] },
        details: [{ key: 'region', role: 'explorer', status: 'completed', report: { markdown: '# 口径说明\n已确认仅已完成订单计入销售额。' } }],
        status: 'done',
    },
    {
        toolCallId: 'spec-1',
        messageId: 'm2',
        turnKey: 'turn-2',
        name: 'set_answer_spec',
        args: {
            fields: {
                'population.entity': { value: '订单明细', basis: 'request', quote: '销售额' },
                'population.conditions': {
                    value: ["o.status = '已完成'", "c.region IN ('华东', '华南')"],
                    cite: [{ source: 'knowledge:business-definitions', quote: '仅「已完成」订单计入销售统计' }],
                },
            },
        },
        details: {
            taskId: 'task-1',
            revisionId: 'rev-1',
            fields: [
                { path: 'population.entity', status: 'request', value: '订单明细' },
                { path: 'population.conditions', status: 'evidence', value: ["o.status = '已完成'", "c.region IN ('华东', '华南')"] },
            ],
            open: ['measure.formula'],
            undeclared: [],
            unverified: [],
        },
        status: 'done',
    },
    {
        toolCallId: 'spec-2',
        messageId: 'm3',
        turnKey: 'turn-2',
        name: 'set_answer_spec',
        args: {
            taskId: 'task-1',
            fields: {
                'measure.formula': {
                    op: 'sum',
                    of: 'oi.quantity * oi.unit_price * (1 - oi.discount)',
                },
                grouping: { value: 'c.region', basis: 'request', quote: '各分大区' },
            },
        },
        details: {
            taskId: 'task-1',
            revisionId: 'rev-2',
            fields: [
                { path: 'population.entity', status: 'request', value: '订单明细' },
                { path: 'population.conditions', status: 'evidence', value: ["o.status = '已完成'", "c.region IN ('华东', '华南')"] },
                { path: 'population.time', status: 'assumed', value: '全部数据期间' },
                { path: 'measure.formula', status: 'evidence', value: { op: 'sum', of: 'oi.quantity * oi.unit_price * (1 - oi.discount)' } },
                { path: 'grouping', status: 'request', value: 'c.region' },
                { path: 'selection', status: 'not_applicable' },
            ],
            open: [],
            undeclared: [],
            unverified: ['population.time'],
        },
        status: 'done',
    },
    {
        toolCallId: 'query-1',
        messageId: 'm4',
        turnKey: 'turn-2',
        name: 'query_database',
        args: {
            kind: 'result',
            taskId: 'task-1',
            revisionId: 'rev-2',
            sql: "SELECT c.region AS 大区, ROUND(SUM(oi.quantity*oi.unit_price*(1-oi.discount)), 2) AS 销售额\nFROM order_items oi\nJOIN orders o ON oi.order_id = o.order_id\nGROUP BY c.region",
        },
        result: "[RESULT_CANDIDATE] candidateId=candidate_d00af50b revisionId=revision_3aade1dc\n大区 | 销售额\n华东 | 8121674.21\n华南 | 7919583.05",
        details: {
            kind: 'result',
            artifact: { kind: 'candidate', candidateId: 'candidate_d00af50b', revisionId: 'revision_3aade1dc', resultRef: 'ref-1' },
            preview: {
                columns: ['大区', '销售额'],
                rows: [['华东', 8121674.21], ['华南', 7919583.05]],
                columnTypes: ['text', 'decimal'],
                rowCount: 2,
                truncated: false,
            },
            findings: [],
        },
        status: 'done',
    },
    {
        toolCallId: 'pub-1',
        messageId: 'm5',
        turnKey: 'turn-2',
        name: 'publish_query_result',
        args: { candidateId: 'candidate_d00af50b', format: 'inline' },
        result: '[PUBLISHED] inline [download](/api/runtime/publications/pub_123456) receiptId=pub_123456',
        details: {
            receiptId: 'pub_123456',
            taskId: 'task-1',
            format: 'inline',
            disclosure: {
                required: true,
                unverifiedFields: [{ path: 'population.time', kind: 'assumed' }],
                summary: '以下字段为假定，未被合格证据证实：population.time。 SQL 与已封存口径可能不一致……',
                items: [
                    { kind: 'assumed', paths: ['population.time'] },
                    { kind: 'realization_conflict', paths: ['measure.formula'], detail: 'measure.formula declares x, but the SQL never reads it.' },
                    { kind: 'calendar_coverage', paths: ['population.time'], detail: 'population.time spans 26 month periods', periods: ['2016-11'] },
                    { kind: 'realization_conflict', paths: ['population.source'], detail: 'population.source declares y, but the SQL never reads it.' },
                ],
            },
        },
        status: 'done',
    },
];

describe('ToolPanel Basis & Audit Drawer', () => {
    it('extracts multi-call AnswerRevisionView clauses, clean row count, preview table, and disclosure on real Answer Spec sessions', () => {
        render(
            <LanguageProvider>
                <ToolPanel tools={realSessionTools} />
            </LanguageProvider>,
        );

        // Default tab shows structured Answer Spec Tree clauses across set_answer_spec revisions.
        expect(screen.getByText('Answer Spec 口径树')).toBeInTheDocument();
        expect(screen.getByText('population.entity')).toBeInTheDocument();
        expect(screen.getByText('population.conditions')).toBeInTheDocument();
        expect(screen.getByText('measure.formula')).toBeInTheDocument();
        expect(screen.getByText('已核实 · 文档')).toBeInTheDocument();
        expect(screen.getByText('模型假设')).toBeInTheDocument();
        expect(screen.getByText(/business-definitions：仅「已完成」订单计入销售统计/)).toBeInTheDocument();

        // Disclosure items sit on the clause they concern, in business language; the model-facing
        // summary and check wording are not shown here.
        expect(screen.queryByText(/以下字段为假定/)).not.toBeInTheDocument();
        expect(screen.queryByText(/never reads/)).not.toBeInTheDocument();
        expect(screen.getByText('SQL 可能没有按这条口径执行')).toBeInTheDocument();
        expect(screen.getByText('2016-11 没有数据')).toBeInTheDocument();
        // A clause missing from the tree is named in the top card instead.
        expect(within(screen.getByTestId('basis-disclosure-card')).getByText('数据来源：SQL 可能没有按这条口径执行')).toBeInTheDocument();

        // Never prints raw `[RESULT_CANDIDATE] ...` string in the SQL row count slot.
        expect(screen.queryByText(/\[RESULT_CANDIDATE\]/)).not.toBeInTheDocument();
        expect(screen.getByText('返回 2 行')).toBeInTheDocument();

        // Renders SQL CodeBlock & formatted Query Output Snapshot table.
        expect(screen.getByText(/SELECT c\.region AS 大区/)).toBeInTheDocument();
        expect(screen.getByText('8121674.21')).toBeInTheDocument();

        // Developer trace tab stays accessible with full raw tool records.
        fireEvent.click(screen.getByRole('tab', { name: /调用链路/ }));
        expect(screen.getByRole('button', { name: /subagent/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /publish_query_result/ })).toBeInTheDocument();
    });
});
