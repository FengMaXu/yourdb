import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AgentTurn, { type TurnAgentMessage } from '../AgentTurn';
import { LanguageProvider } from '../../context/LanguageContext';
import { PreviewProvider } from '../../context/PreviewContext';

const step = (id: string, patch: Partial<TurnAgentMessage> = {}): TurnAgentMessage => ({
    role: 'agent',
    id,
    messageId: id,
    content: '',
    transientContent: '',
    reasoningContent: '',
    toolCallsById: {},
    widgetsById: {},
    skillActivations: [],
    terminalReason: null,
    ...patch,
});

const agents = [
    step('a1', { reasoningContent: '先看表结构', toolCallsById: { c1: { toolCallId: 'c1', name: 'list_tables', arguments: {}, status: 'done' } } }),
    step('a2', { content: '最终答案：共 3 张表。' }),
];

const renderTurn = (running: boolean) => (
    <LanguageProvider><PreviewProvider><AgentTurn
        agents={agents}
        running={running}
        startedAt={0}
        currentSessionId="s1"
        toolLabel={(tool) => `完成工具：${tool.name}`}
        skillLabel={(skill) => skill.name}
    /></PreviewProvider></LanguageProvider>
);

describe('AgentTurn', () => {
    it('offers retry only when a failed tool left the turn without an answer', () => {
        const failedTool = { c1: { toolCallId: 'c1', name: 'query_database', arguments: {}, status: 'error' as const, isError: true } };
        const turn = (withAnswer: boolean) => (
            <LanguageProvider><PreviewProvider><AgentTurn
                agents={[step('a1', { toolCallsById: failedTool }), ...(withAnswer ? [step('a2', { content: '换了个查询，结果如下。' })] : [])]}
                running={false}
                startedAt={0}
                currentSessionId="s1"
                toolLabel={(tool) => tool.name}
                skillLabel={(skill) => skill.name}
                onRetry={() => undefined}
            /></PreviewProvider></LanguageProvider>
        );
        const { rerender } = render(turn(true));
        expect(screen.queryByRole('button', { name: /重试/ })).not.toBeInTheDocument();
        rerender(turn(false));
        expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
    });

    it('shows the process while running and folds it once done, keeping the answer in view', () => {
        const { rerender } = render(renderTurn(true));
        const toggle = screen.getByRole('button', { expanded: true });
        expect(toggle).toHaveTextContent('处理中');
        expect(screen.getByText('最终答案：共 3 张表。')).toBeInTheDocument();

        rerender(renderTurn(false));
        expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('思考 1 次 · 调用工具 1 次');
        expect(screen.getByText('最终答案：共 3 张表。')).toBeInTheDocument();
    });

    it('keeps the user’s choice to open a finished turn', () => {
        const { rerender } = render(renderTurn(false));
        fireEvent.click(screen.getByRole('button', { expanded: false }));
        expect(screen.getByRole('button', { name: /完成工具：list_tables/ })).toBeInTheDocument();
        rerender(renderTurn(false));
        expect(screen.getAllByRole('button', { expanded: true })).toHaveLength(1);
    });

    it('keeps a model-written basis line in the answer and shows no footer without query evidence', () => {
        render(
            <LanguageProvider><PreviewProvider><AgentTurn
                agents={[step('a-basis', { content: '结论如下。\n\n口径：`fact_sales_monthly.sales_ytd`，按行业汇总。' })]}
                running={false}
                startedAt={0}
                currentSessionId="s1"
                toolLabel={(tool) => tool.name}
                skillLabel={(skill) => skill.name}
                onOpenToolPanel={() => undefined}
            /></PreviewProvider></LanguageProvider>,
        );

        expect(screen.getByText(/口径：/)).toBeInTheDocument();
        expect(screen.queryByText('-- BASIS')).not.toBeInTheDocument();
    });

    it('marks unverified SQL turns as assumed and deep-links trace & basis targets', () => {
        const onOpenToolPanel = vi.fn();
        render(
            <LanguageProvider><PreviewProvider><AgentTurn
                turnKey="turn-1"
                agents={[
                    step('a1', {
                        toolCallsById: {
                            q1: {
                                toolCallId: 'q1',
                                name: 'query_database',
                                arguments: { sql: 'SELECT SUM(sales_ytd) FROM fact_sales_monthly' },
                                status: 'done',
                            },
                        },
                    }),
                    step('a2', { content: '销售额结果如下。\n\n口径：`fact_sales_monthly.sales_ytd`' }),
                ]}
                running={false}
                startedAt={0}
                currentSessionId="s1"
                toolLabel={(tool) => `完成工具：${tool.name}`}
                skillLabel={(skill) => skill.name}
                onOpenToolPanel={onOpenToolPanel}
            /></PreviewProvider></LanguageProvider>,
        );

        expect(screen.getByText(/含 \d+ 项模型假设/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /口径与 SQL 依据/ }));
        expect(onOpenToolPanel).toHaveBeenCalledWith({ turnKey: 'turn-1', messageId: 'a2', tab: 'basis' });

        fireEvent.click(screen.getByRole('button', { expanded: false }));
        fireEvent.click(screen.getByRole('button', { name: /完成工具：query_database/ }));
        expect(onOpenToolPanel).toHaveBeenCalledWith({ turnKey: 'turn-1', messageId: 'a1', toolCallId: 'q1', tab: 'trace' });
    });

    it('hides completed show_widget plumbing in the trace and renders BasisDisclosureFooter from Answer Spec & Receipt even without trailing markdown basis', () => {
        render(
            <LanguageProvider><PreviewProvider><AgentTurn
                turnKey="turn-spec"
                agents={[
                    step('s1', {
                        toolCallsById: {
                            spec1: {
                                toolCallId: 'spec1',
                                name: 'set_answer_spec',
                                arguments: {
                                    fields: {
                                        'population.conditions': {
                                            value: ["o.status = '已完成'"],
                                            cite: [{ source: 'knowledge:business-definitions', quote: '仅统计已完成订单' }],
                                        },
                                    },
                                },
                                details: {
                                    taskId: 'task-1',
                                    revisionId: 'rev-1',
                                    fields: [
                                        { path: 'population.entity', status: 'request', value: '订单' },
                                        { path: 'population.conditions', status: 'evidence', value: ["o.status = '已完成'"] },
                                        { path: 'grouping', status: 'request', value: 'c.region' },
                                    ],
                                    open: [],
                                    undeclared: [],
                                    unverified: [],
                                },
                                status: 'done',
                            },
                            pub1: {
                                toolCallId: 'pub1',
                                name: 'publish_query_result',
                                arguments: { candidateId: 'cand-1', format: 'inline' },
                                details: { receiptId: 'pub-1', format: 'inline' },
                                status: 'done',
                            },
                            wid1: {
                                toolCallId: 'wid1',
                                name: 'show_widget',
                                arguments: { kind: 'table' },
                                status: 'done',
                            },
                        },
                    }),
                    step('s2', { content: '各分大区销售额已统计完毕。' }),
                ]}
                running={false}
                startedAt={0}
                currentSessionId="s1"
                toolLabel={(tool) => `步骤:${tool.name}`}
                skillLabel={(skill) => skill.name}
                onOpenToolPanel={() => undefined}
            /></PreviewProvider></LanguageProvider>,
        );

        expect(screen.getByRole('button', { expanded: false })).toHaveTextContent('调用工具 2 次');
        fireEvent.click(screen.getByRole('button', { expanded: false }));
        expect(screen.queryByRole('button', { name: /show_widget/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /步骤:set_answer_spec/ })).toBeInTheDocument();

        // The footer states trust only; the definition itself lives in the Basis panel.
        expect(screen.getByText('-- BASIS')).toBeInTheDocument();
        expect(screen.getByText('已核实')).toBeInTheDocument();
        expect(screen.queryByText(/已核实 3 项口径/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /口径与 SQL 依据/ })).toBeInTheDocument();
    });
});
