import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

type Listener = (raw: unknown) => void;
const runtime = vi.hoisted(() => ({
    listener: undefined as Listener | undefined,
    options: undefined as { afterSequence?: number; onConnected?: () => void } | undefined,
    state: undefined as unknown,
    subscribeCalls: 0,
    transcriptReloads: 0,
    sequence: 100,
}));

vi.mock('../../api/runtime-client', () => ({
    answerClarificationViaRuntime: vi.fn(),
    clearSessionViaRuntime: vi.fn(),
    steerAgentViaRuntime: vi.fn(),
    stopAgentViaRuntime: vi.fn(),
    getRuntimeClient: vi.fn(() => ({ dispatch: vi.fn() })),
    getSessionStateViaRuntime: vi.fn(async () => runtime.state),
    getTranscriptViaRuntime: vi.fn(async () => {
        runtime.transcriptReloads += 1;
        return [
            { id: 'u1', role: 'user', content: '三行业指标' },
            { id: 'a1', role: 'agent', content: '完整的最终回答', messageId: 'a1', toolCallsById: {}, widgetsById: {}, skillActivations: [], currentStage: 'generating_answer', visitedStages: ['sent'], terminalReason: 'completed' },
        ];
    }),
    subscribeRuntimeEvents: vi.fn((listener: Listener, _sessionId?: string, options?: { afterSequence?: number; onConnected?: () => void }) => {
        runtime.subscribeCalls += 1;
        runtime.listener = listener;
        runtime.options = options;
        options?.onConnected?.();
        return () => { runtime.listener = undefined; };
    }),
}));

vi.mock('../../hooks/useSession', () => ({
    useSession: () => ({
        currentTask: { id: 'task-1', name: 'Task' },
        currentSession: { id: 'session-1', taskId: 'task-1', name: 'Session' },
        currentTranscript: [{ id: 'u1', role: 'user', content: '三行业指标' }],
        attachedFiles: [],
        setAttachedFiles: vi.fn(),
        setCurrentTranscript: vi.fn(),
        clearCurrentTranscript: vi.fn(),
        clearAttachedFiles: vi.fn(),
        createSession: vi.fn(),
    }),
}));

import ChatArea from '../ChatArea';
import { answerClarificationViaRuntime } from '../../api/runtime-client';
import { LanguageProvider } from '../../context/LanguageContext';
import { PreviewProvider } from '../../context/PreviewContext';

const renderChat = () => render(<LanguageProvider><PreviewProvider><ChatArea /></PreviewProvider></LanguageProvider>);

function emit(event: unknown) {
    act(() => {
        runtime.listener?.({ protocolVersion: 1, sequence: ++runtime.sequence, requestId: 'r', sessionId: 'session-1', runId: 'run-1', timestamp: 1, event });
    });
}

describe('ChatArea restoring a session', () => {
    beforeEach(() => {
        runtime.listener = undefined;
        runtime.options = undefined;
        runtime.subscribeCalls = 0;
        runtime.transcriptReloads = 0;
        Element.prototype.scrollTo = vi.fn();
        Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => { vi.clearAllTimers(); });

    it('keeps following a run that is still going and reloads the transcript when it ends', async () => {
        runtime.state = {
            messages: [{ id: 'u1', role: 'user', content: '三行业指标' }],
            inProgressRun: { runId: 'run-1', startedAt: 1 },
            pendingClarification: null,
            eventSequence: 41,
        };
        renderChat();
        await waitFor(() => expect(runtime.listener).toBeDefined());
        expect(runtime.options?.afterSequence).toBe(41);
        emit({ type: 'agent.message_started', messageId: 'm-live' });
        emit({ type: 'agent.text_delta', delta: '实时的尾部内容' });
        await waitFor(() => expect(screen.getByText(/实时的尾部内容/)).toBeTruthy());
        emit({ type: 'agent.completed' });
        await waitFor(() => expect(runtime.transcriptReloads).toBe(1));
        await waitFor(() => expect(screen.getByText(/完整的最终回答/)).toBeTruthy());
    });

    it('shows the clarification the run is waiting on', async () => {
        runtime.state = {
            messages: [{ id: 'u1', role: 'user', content: '三行业指标' }],
            inProgressRun: { runId: 'run-1', startedAt: 1 },
            pendingClarification: { clarificationId: 'c-1', question: '按哪个口径统计？', options: ['累计', '当月'] },
            eventSequence: 7,
        };
        renderChat();
        await waitFor(() => expect(screen.getByText('按哪个口径统计？')).toBeTruthy());
    });

    it('does not subscribe for a session whose run already ended', async () => {
        runtime.state = { messages: [], inProgressRun: null, pendingClarification: null, eventSequence: 3 };
        renderChat();
        await waitFor(() => expect(screen.getByText('三行业指标')).toBeTruthy());
        await act(async () => { await Promise.resolve(); });
        expect(runtime.subscribeCalls).toBe(0);
    });
});

describe('ChatArea clarification', () => {
    beforeEach(() => {
        runtime.listener = undefined;
        runtime.state = {
            messages: [{ id: 'u1', role: 'user', content: '三行业指标' }],
            inProgressRun: { runId: 'run-1', startedAt: 1 },
            pendingClarification: { clarificationId: 'c-1', question: '按哪个口径统计？', options: ['累计', '当月'] },
            eventSequence: 7,
        };
        vi.mocked(answerClarificationViaRuntime).mockReset().mockResolvedValue(undefined);
        Element.prototype.scrollTo = vi.fn();
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('puts a chosen option in the answer box for editing instead of sending it', async () => {
        renderChat();
        fireEvent.click(await screen.findByRole('radio', { name: '累计' }));
        expect(answerClarificationViaRuntime).not.toHaveBeenCalled();
        const input = screen.getByRole('textbox', { name: '输入你的回答...' });
        expect((input as HTMLTextAreaElement).value).toBe('累计');

        fireEvent.change(input, { target: { value: '累计，含退款' } });
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        await waitFor(() => expect(answerClarificationViaRuntime).toHaveBeenCalledWith('c-1', '累计，含退款', 'session-1'));
    });

    it('sends the answer without adding it to the conversation', async () => {
        renderChat();
        fireEvent.click(await screen.findByRole('radio', { name: '当月' }));
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        await waitFor(() => expect(answerClarificationViaRuntime).toHaveBeenCalledWith('c-1', '当月', 'session-1'));
        expect(document.querySelectorAll('[data-message-role="user"]')).toHaveLength(1);
    });

    it('closes the card once the answer is sent, while the run goes on', async () => {
        renderChat();
        fireEvent.click(await screen.findByRole('radio', { name: '累计' }));
        fireEvent.click(screen.getByRole('button', { name: '提交' }));
        await waitFor(() => expect(screen.queryByText('按哪个口径统计？')).toBeNull());
        emit({ type: 'agent.message_started', messageId: 'm-after' });
        emit({ type: 'agent.text_delta', delta: '按累计口径继续' });
        await waitFor(() => expect(screen.getByText(/按累计口径继续/)).toBeTruthy());
        expect(screen.queryByText('按哪个口径统计？')).toBeNull();
    });

    it('closes the card when the runtime settles the clarification', async () => {
        renderChat();
        await screen.findByText('按哪个口径统计？');
        await waitFor(() => expect(runtime.listener).toBeDefined());
        emit({ type: 'clarification.settled', clarificationId: 'c-1', outcome: 'expired' });
        await waitFor(() => expect(screen.queryByText('按哪个口径统计？')).toBeNull());
    });

    it('does not send while an IME is composing, and sends on a plain Enter', async () => {
        renderChat();
        const input = await screen.findByRole('textbox', { name: '输入你的回答...' });
        fireEvent.change(input, { target: { value: '当月' } });
        fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
        expect(answerClarificationViaRuntime).not.toHaveBeenCalled();
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(answerClarificationViaRuntime).toHaveBeenCalledWith('c-1', '当月', 'session-1'));
    });
});
