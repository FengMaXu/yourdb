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
