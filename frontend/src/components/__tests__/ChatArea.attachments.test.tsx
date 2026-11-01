import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const calls = vi.hoisted(() => ({ sent: [] as { prompt: string; attachments: readonly string[] | undefined }[] }));

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

const renderChat = () => render(<LanguageProvider><PreviewProvider><ChatArea /></PreviewProvider></LanguageProvider>);
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const upload = (container: HTMLElement, ...names: string[]) => fireEvent.change(fileInput(container), {
    target: { files: names.map((name) => new File(['a,b\n1,2\n'], name, { type: 'text/csv' })) },
});

describe('ChatArea attachments', () => {
    beforeEach(() => {
        calls.sent = [];
        Element.prototype.scrollTo = vi.fn();
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('lists uploaded files, sends them with the prompt, and shows them on the sent message', async () => {
        const { container } = renderChat();
        upload(container, 'sales.csv', 'notes.txt');
        const pending = await screen.findByRole('list', { name: '已附加的文件' });
        expect(pending.textContent).toContain('sales.csv');
        expect(pending.textContent).toContain('notes.txt');

        fireEvent.click(screen.getByRole('button', { name: '移除 notes.txt' }));
        await waitFor(() => expect(pending.textContent).not.toContain('notes.txt'));

        fireEvent.change(screen.getByRole('textbox'), { target: { value: '按区域汇总' } });
        fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

        await waitFor(() => expect(calls.sent).toEqual([{ prompt: '按区域汇总', attachments: ['sales.csv'] }]));
        const lists = screen.getAllByRole('list', { name: '已附加的文件' });
        expect(lists).toHaveLength(1);
        expect(lists[0].closest('[data-message-role="user"]')?.textContent).toContain('按区域汇总');
        expect(lists[0].textContent).toContain('sales.csv');
    });

    it('says so when an upload fails and keeps the files that did upload', async () => {
        const { container } = renderChat();
        upload(container, 'sales.csv', 'broken.csv');
        expect(await screen.findByRole('alert')).toHaveTextContent('文件上传失败');
        expect(screen.getByRole('list', { name: '已附加的文件' }).textContent).toContain('sales.csv');
    });
});
