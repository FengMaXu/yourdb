import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const calls = vi.hoisted(() => ({ sent: [] as { prompt: string; attachments: readonly string[] | undefined }[] }));

// Mocks as in ChatArea.attachments.test.tsx: one empty session, nothing sent.

vi.mock('../../api/runtime-client', () => ({
    answerClarificationViaRuntime: vi.fn(),
    steerAgentViaRuntime: vi.fn(),
    stopAgentViaRuntime: vi.fn(),
    getTranscriptViaRuntime: vi.fn(async () => []),
    getSessionStateViaRuntime: vi.fn(async () => ({ messages: [], inProgressRun: null, pendingClarification: null, eventSequence: 0 })),
}));

vi.mock('../../api/chat-events', () => ({
    attachRunViaRuntime: vi.fn(),
    sendChatViaRuntime: vi.fn((prompt: string, _onEvent: unknown, _onError: unknown, _onFinish: unknown, _sessionId: unknown, _stream: unknown, attachments?: readonly string[]) => {
        calls.sent.push({ prompt, attachments });
        return { cancel: vi.fn(), detach: vi.fn(), finished: new Promise<void>(() => undefined) };
    }),
}));

vi.mock('../../api/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../api/client')>()),
    uploadWorkspaceFile: vi.fn(async (file: File) => {
        if (file.name === 'broken.csv') throw new Error('Failed to upload file');
        return { filename: file.name, session_id: 'session-1', relative_path: file.name, size: file.size };
    }),
}));

vi.mock('../../hooks/useSession', () => ({
    useSession: () => {
        const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
        return {
            currentTask: { id: 'task-1', name: 'Task' },
            currentSession: { id: 'session-1', taskId: 'task-1', name: 'Session' },
            currentTranscript: [],
            attachedFiles,
            setAttachedFiles,
            clearAttachedFiles: () => setAttachedFiles([]),
            setCurrentTranscript: vi.fn(),
            createSession: vi.fn(),
        };
    },
}));

import ChatArea from '../ChatArea';
import { LanguageProvider } from '../../context/LanguageContext';
import { PreviewProvider } from '../../context/PreviewContext';
import { ReadinessProvider } from '../../hooks/useReadiness';

describe('ChatArea empty session', () => {
    beforeEach(() => {
        calls.sent = [];
        Element.prototype.scrollTo = vi.fn();
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('offers starter questions that fill the input without sending', async () => {
        render(<LanguageProvider><PreviewProvider><ChatArea /></PreviewProvider></LanguageProvider>);
        expect(screen.getByRole('heading', { name: '想从数据里了解什么？' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /生成一张本月经营概况看板/ }));
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('生成一张本月经营概况看板'));
        expect(screen.getByRole('textbox')).toHaveFocus();
        expect(calls.sent).toEqual([]);
    });

    it('shows the setup checklist first and keeps the examples locked until it is done', async () => {
        // The runtime mock cannot read settings, so both steps stay unticked.
        render(<LanguageProvider><PreviewProvider><ReadinessProvider onOpenSettings={vi.fn()}><ChatArea /></ReadinessProvider></PreviewProvider></LanguageProvider>);
        expect(await screen.findByRole('heading', { name: '提问前还需要两样东西' })).toBeInTheDocument();
        expect(screen.getByText('示例问题（完成上面两步后可用）')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /生成一张本月经营概况看板/ })).toBeDisabled();
    });
});
