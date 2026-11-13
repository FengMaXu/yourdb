import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../context/LanguageContext';
import { SessionProvider, useSession } from '../useSession';

const runtime = vi.hoisted(() => ({
    createSessionViaRuntime: vi.fn(),
    createTaskWithIdViaRuntime: vi.fn(),
    deleteSessionViaRuntime: vi.fn(),
    deleteTaskViaRuntime: vi.fn(),
    getTranscriptViaRuntime: vi.fn(),
    listSessionsViaRuntime: vi.fn(),
    listTasksViaRuntime: vi.fn(),
    prepareSessionViaRuntime: vi.fn(),
    renameSessionViaRuntime: vi.fn(),
    renameTaskViaRuntime: vi.fn(),
    subscribeRuntimeEvents: vi.fn(),
    /** The listener SessionProvider subscribed with, so a test can deliver events to it. */
    listener: undefined as ((envelope: unknown) => void) | undefined,
}));

vi.mock('../../api/runtime-client', () => runtime);

const wrapper = ({ children }: { children: ReactNode }) => (
    <LanguageProvider>
        <SessionProvider>{children}</SessionProvider>
    </LanguageProvider>
);

const firstPrompt = {
    id: 'user-1',
    role: 'user' as const,
    content: '## **Quarterly sales**\nreport',
};

beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    runtime.listTasksViaRuntime.mockResolvedValue([
        { id: 'task-1', name: 'Sales', createdAt: 0, updatedAt: 0 },
    ]);
    runtime.listSessionsViaRuntime.mockResolvedValue([
        { id: 'session-1', taskId: 'task-1', name: 'New session' },
    ]);
    runtime.getTranscriptViaRuntime.mockResolvedValue([]);
    runtime.createTaskWithIdViaRuntime.mockResolvedValue({ id: 'task-runtime', name: 'New task' });
    runtime.createSessionViaRuntime.mockResolvedValue({ id: 'session-runtime', taskId: 'task-runtime', name: 'New session', createdAt: 1 });
    runtime.prepareSessionViaRuntime.mockResolvedValue(undefined);
    runtime.renameSessionViaRuntime.mockResolvedValue(undefined);
    runtime.listener = undefined;
    runtime.subscribeRuntimeEvents.mockImplementation((listener: (envelope: unknown) => void) => {
        runtime.listener = listener;
        return () => { runtime.listener = undefined; };
    });
});

describe('SessionProvider conversations from elsewhere', () => {
    it('lists a session a phone started, without a reload', async () => {
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(runtime.listener).toBeDefined());
        runtime.listSessionsViaRuntime.mockResolvedValue([
            { id: 'session-1', taskId: 'task-1', name: 'New session' },
            { id: 'session-phone', taskId: 'task-1', name: 'From Feishu' },
        ]);

        act(() => runtime.listener!({ sessionId: 'session-phone', event: { type: 'agent.message_started', messageId: 'm1' } }));

        await waitFor(() => expect(result.current.sessions.map((session) => session.id)).toContain('session-phone'));
        expect(result.current.runActivity).toMatchObject({ sessionId: 'session-phone', phase: 'started' });
    });

    it('reports a run that finished in the open session and ignores streamed text', async () => {
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current.currentSession?.id).toBe('session-1'));
        await waitFor(() => expect(runtime.listener).toBeDefined());

        act(() => runtime.listener!({ sessionId: 'session-1', event: { type: 'agent.text_delta', delta: 'x' } }));
        expect(result.current.runActivity).toBeNull();

        act(() => runtime.listener!({ sessionId: 'session-1', event: { type: 'agent.completed', outcome: 'completed' } }));
        expect(result.current.runActivity).toMatchObject({ sessionId: 'session-1', phase: 'finished' });
        expect(runtime.listSessionsViaRuntime).toHaveBeenCalledTimes(1);
    });
});

describe('SessionProvider runtime identities', () => {
    it('uses the IDs returned by the Runtime for newly created tasks and sessions', async () => {
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current.currentTask?.id).toBe('task-1'));

        act(() => result.current.createTask());
        await waitFor(() => expect(result.current.currentTask?.id).toBe('task-runtime'));
        expect(window.localStorage.getItem('data-agent:current-task')).toBe('task-runtime');
        // A new task opens straight into a session.
        await waitFor(() => expect(result.current.currentSession?.id).toBe('session-runtime'));
        expect(runtime.createSessionViaRuntime).toHaveBeenCalledWith('task-runtime', expect.any(String));

        act(() => result.current.createSession('task-runtime'));
        await waitFor(() => expect(result.current.currentSession?.id).toBe('session-runtime'));
        expect(result.current.currentSession?.taskId).toBe('task-runtime');
        expect(window.localStorage.getItem('data-agent:current-session')).toBe('session-runtime');
    });
});

describe('SessionProvider first use', () => {
    it('opens one task and one session when there is nothing yet', async () => {
        runtime.listTasksViaRuntime.mockResolvedValue([]);
        runtime.listSessionsViaRuntime.mockResolvedValue([]);
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current?.currentSession?.id).toBe('session-runtime'));
        expect(result.current.currentTask?.id).toBe('task-runtime');
        expect(runtime.createTaskWithIdViaRuntime).toHaveBeenCalledTimes(1);
        expect(runtime.createSessionViaRuntime).toHaveBeenCalledTimes(1);
    });

    it('creates nothing when the task list could not be read', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        runtime.listTasksViaRuntime.mockRejectedValue(new Error('offline'));
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current).not.toBeNull());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(runtime.createTaskWithIdViaRuntime).not.toHaveBeenCalled();
    });

    it('leaves existing work alone', async () => {
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current?.currentSession?.id).toBe('session-1'));
        expect(runtime.createTaskWithIdViaRuntime).not.toHaveBeenCalled();
    });
});

describe('SessionProvider automatic session titles', () => {
    it('renames from the first user message once, across later turns', async () => {
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current.currentSession?.id).toBe('session-1'));

        act(() => {
            result.current.setCurrentTranscript('session-1', [firstPrompt]);
        });
        await waitFor(() => expect(runtime.renameSessionViaRuntime).toHaveBeenCalledWith(
            'session-1',
            'Quarterly sales report',
        ));

        act(() => {
            result.current.setCurrentTranscript('session-1', [
                firstPrompt,
                { id: 'user-2', role: 'user', content: 'A later question' },
            ]);
        });
        expect(runtime.renameSessionViaRuntime).toHaveBeenCalledTimes(1);
    });

    it('keeps the local title and transcript flow when rename fails', async () => {
        runtime.renameSessionViaRuntime.mockRejectedValueOnce(new Error('metadata unavailable'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { result } = renderHook(() => useSession(), { wrapper });
        await waitFor(() => expect(result.current.currentSession?.id).toBe('session-1'));

        expect(() => act(() => {
            result.current.setCurrentTranscript('session-1', [firstPrompt]);
        })).not.toThrow();
        await waitFor(() => expect(warn).toHaveBeenCalledWith(
            'Failed to rename session:',
            expect.any(Error),
        ));
        expect(result.current.currentSession?.name).toBe('Quarterly sales report');
        expect(result.current.currentTranscript).toEqual([firstPrompt]);
        warn.mockRestore();
    });
});
