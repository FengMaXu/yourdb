import { describe, expect, it } from 'vitest';
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
});
