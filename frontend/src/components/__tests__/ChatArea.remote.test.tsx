import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

type Listener = (raw: unknown) => void;
const runtime = vi.hoisted(() => ({
    listener: undefined as Listener | undefined,
    state: undefined as unknown,
    stateReads: 0,
    transcriptReloads: 0,
    sequence: 100,
    /** What the mocked useSession reports as the latest run start or finish. */
    runActivity: null as { sessionId: string; phase: 'started' | 'finished'; seq: number } | null,
}));

vi.mock('../../api/runtime-client', () => ({
    answerClarificationViaRuntime: vi.fn(),
    clearSessionViaRuntime: vi.fn(),
    steerAgentViaRuntime: vi.fn(),
    stopAgentViaRuntime: vi.fn(),
    getRuntimeClient: vi.fn(() => ({ dispatch: vi.fn() })),
    getSessionStateViaRuntime: vi.fn(async () => {
        runtime.stateReads += 1;
        return runtime.state;
    }),
    getTranscriptViaRuntime: vi.fn(async () => {
        runtime.transcriptReloads += 1;
        return [
            { id: 'u1', role: 'user', content: '华东区本周销售额' },
            { id: 'a1', role: 'agent', content: '手机上问到的完整回答', messageId: 'a1', toolCallsById: {}, widgetsById: {}, skillActivations: [], currentStage: 'generating_answer', visitedStages: ['sent'], terminalReason: 'completed' },
        ];
    }),
    subscribeRuntimeEvents: vi.fn((listener: Listener, _sessionId?: string, options?: { onConnected?: () => void }) => {
        runtime.listener = listener;
        options?.onConnected?.();
        return () => { runtime.listener = undefined; };
    }),
}));

vi.mock('../../hooks/useSession', () => ({
    useSession: () => ({
        currentTask: { id: 'task-1', name: 'Task' },
        currentSession: { id: 'session-1', taskId: 'task-1', name: 'Session' },
        currentTranscript: [],
        attachedFiles: [],
        setAttachedFiles: vi.fn(),
        setCurrentTranscript: vi.fn(),
        clearCurrentTranscript: vi.fn(),
        clearAttachedFiles: vi.fn(),
        createSession: vi.fn(),
        runActivity: runtime.runActivity,
    }),
}));

import ChatArea from '../ChatArea';
import { LanguageProvider } from '../../context/LanguageContext';
import { PreviewProvider } from '../../context/PreviewContext';

const chat = () => <LanguageProvider><PreviewProvider><ChatArea /></PreviewProvider></LanguageProvider>;
const idle = { messages: [], inProgressRun: null, pendingClarification: null, eventSequence: 0 };
const running = { messages: [{ id: 'u1', role: 'user', content: '华东区本周销售额' }], inProgressRun: { runId: 'run-1', startedAt: 1 }, pendingClarification: null, eventSequence: 41 };

function emit(event: unknown) {
    act(() => {
        runtime.listener?.({ protocolVersion: 1, sequence: ++runtime.sequence, requestId: 'r', sessionId: 'session-1', runId: 'run-1', timestamp: 1, event });
    });
}

describe('ChatArea and runs it did not start', () => {
    beforeEach(() => {
        runtime.listener = undefined;
        runtime.state = idle;
        runtime.stateReads = 0;
        runtime.transcriptReloads = 0;
        runtime.runActivity = null;
        Element.prototype.scrollTo = vi.fn();
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('follows a run a phone started in the open session', async () => {
        const view = render(chat());
        await waitFor(() => expect(runtime.stateReads).toBe(1));
        expect(runtime.listener).toBeUndefined();

        runtime.state = running;
        runtime.runActivity = { sessionId: 'session-1', phase: 'started', seq: 1 };
        view.rerender(chat());

        await waitFor(() => expect(runtime.listener).toBeDefined());
        emit({ type: 'agent.message_started', messageId: 'm-phone' });
        emit({ type: 'agent.text_delta', delta: '正在查询华东区' });
        await waitFor(() => expect(screen.getByText(/正在查询华东区/)).toBeTruthy());
    });

    it('loads what a run committed when it finished elsewhere', async () => {
        const view = render(chat());
        await waitFor(() => expect(runtime.stateReads).toBe(1));

        runtime.runActivity = { sessionId: 'session-1', phase: 'finished', seq: 1 };
        view.rerender(chat());

        await waitFor(() => expect(runtime.transcriptReloads).toBe(1));
        await waitFor(() => expect(screen.getByText(/手机上问到的完整回答/)).toBeTruthy());
    });

    it('does not reload again for the end of a run it followed itself', async () => {
        runtime.state = running;
        const view = render(chat());
        await waitFor(() => expect(runtime.listener).toBeDefined());
        emit({ type: 'agent.message_started', messageId: 'm-live' });
        emit({ type: 'agent.completed' });
        // Attached mid-run, the followed stream reloads once at its end by itself.
        await waitFor(() => expect(runtime.transcriptReloads).toBe(1));

        runtime.runActivity = { sessionId: 'session-1', phase: 'finished', seq: 1 };
        view.rerender(chat());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        expect(runtime.transcriptReloads).toBe(1);
    });

    it('ignores runs in other sessions', async () => {
        const view = render(chat());
        await waitFor(() => expect(runtime.stateReads).toBe(1));

        runtime.runActivity = { sessionId: 'session-other', phase: 'finished', seq: 1 };
        view.rerender(chat());
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
        expect(runtime.transcriptReloads).toBe(0);
        expect(runtime.stateReads).toBe(1);
    });
});
