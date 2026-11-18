import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/runtime-client', () => ({
    answerClarificationViaRuntime: vi.fn(),
    getRuntimeClient: vi.fn(() => ({ dispatch: vi.fn() })),
    renameSessionViaRuntime: vi.fn(),
    steerAgentViaRuntime: vi.fn(),
    stopAgentViaRuntime: vi.fn(),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
}));

import { getToolHintLabel } from '../ChatArea';
import { isAgentMessageEmpty, type AgentMessageLike } from '../../utils/agent-message';

const emptyAgent = (): AgentMessageLike => ({
    content: '',
    transientContent: '',
    reasoningContent: '',
    toolCallsById: {},
    widgetsById: {},
    skillActivations: [],
    terminalReason: null,
});

describe('ChatArea agent message buffering', () => {
    it('shows the loaded skill name after a successful load_skill result', () => {
        const translate = (key: string) => key === 'chat.skillLoaded' ? '已加载：{name}' : key;
        expect(getToolHintLabel({
            toolCallId: 'load-1',
            name: 'load_skill',
            arguments: { name: 'dashboard' },
            details: { nativeSkill: 'dashboard' },
            status: 'done',
        }, translate)).toBe('已加载：dashboard');
    });

    it('does not claim a skill loaded when load_skill failed', () => {
        const translate = (key: string) => key === 'chat.skillLoaded' ? '已加载：“{name}”' : '完成工具：{name}';
        expect(getToolHintLabel({
            toolCallId: 'load-2',
            name: 'load_skill',
            arguments: { name: 'dashboard' },
            details: { nativeSkill: 'dashboard' },
            isError: true,
            status: 'error',
        }, translate)).toBe('完成工具：load_skill');
    });

    it('formats business-readable trace labels for knowledge, database, and widget tools', () => {
        const translate = (key: string) => key === 'chat.toolCompleted' ? '完成工具：{name}' : key;

        expect(getToolHintLabel({
            toolCallId: 't1',
            name: 'search_knowledge',
            arguments: { query: '累计销售额' },
            status: 'done',
        }, translate)).toBe('检索知识库：累计销售额');

        expect(getToolHintLabel({
            toolCallId: 't2',
            name: 'read_knowledge',
            arguments: { path: 'doc/db_schema.md' },
            status: 'done',
        }, translate)).toBe('读取知识文档：doc/db_schema.md');

        expect(getToolHintLabel({
            toolCallId: 't3',
            name: 'query_database',
            arguments: { sql: 'SELECT 1' },
            result: '3 rows',
            status: 'done',
        }, translate)).toBe('执行数据查询（返回 3 行）');

        expect(getToolHintLabel({
            toolCallId: 't4',
            name: 'show_widget',
            arguments: { kind: 'table' },
            details: { widget: { kind: 'table', title: '分行业明细' } },
            status: 'done',
        }, translate)).toBe('生成数据表：分行业明细');

        expect(getToolHintLabel({
            toolCallId: 't5',
            name: 'subagent',
            arguments: { tasks: [{ key: 'region', role: 'explorer', task: '查口径' }] },
            status: 'done',
        }, translate)).toBe('并行查阅文档与库表结构（region）');

        expect(getToolHintLabel({
            toolCallId: 't6',
            name: 'set_answer_spec',
            arguments: { fields: { 'population.entity': '订单', 'measure.formula': { op: 'sum', of: 'amount' } } },
            details: {
                open: [],
                undeclared: [],
                fields: [
                    { path: 'population.entity', status: 'request', value: '订单' },
                    { path: 'measure.formula', status: 'evidence', value: { op: 'sum', of: 'amount' } },
                    { path: 'selection', status: 'not_applicable' },
                ],
            },
            status: 'done',
        }, translate)).toBe('锁定统计口径与指标公式（2 项已就绪）');

        expect(getToolHintLabel({
            toolCallId: 't7',
            name: 'query_database',
            arguments: { kind: 'result', sql: 'SELECT 1' },
            result: '[RESULT_CANDIDATE] candidateId=c1 revisionId=r1\n大区 | 销售额\n华东 | 100\n华南 | 200',
            details: {
                kind: 'result',
                preview: { columns: ['大区', '销售额'], rows: [['华东', 100], ['华南', 200]], rowCount: 2, truncated: false },
            },
            status: 'done',
        }, translate)).toBe('执行数据查询（返回 2 行）');

        expect(getToolHintLabel({
            toolCallId: 't8',
            name: 'publish_query_result',
            arguments: { candidateId: 'c1', format: 'inline' },
            details: { receiptId: 'rec-1', format: 'inline' },
            status: 'done',
        }, translate)).toBe('核验口径并发布查询结果');
    });

    it('recognizes only a completely empty agent message as empty', () => {
        expect(isAgentMessageEmpty(emptyAgent())).toBe(true);

        const updates: Array<Partial<AgentMessageLike>> = [
            { content: 'diagnostic' },
            { reasoningContent: 'thinking' },
            { toolCallsById: { tool: { toolCallId: 'tool', name: 'query', arguments: {}, status: 'done' } } },
            { widgetsById: { widget: { widget_id: 'widget', kind: 'table', title: 'Total' } } },
            { retryNotice: 'retrying' },
            { terminalReason: 'error' },
        ];
        for (const update of updates) {
            expect(isAgentMessageEmpty({ ...emptyAgent(), ...update })).toBe(false);
        }
    });
});
