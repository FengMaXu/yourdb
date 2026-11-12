import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const runtime = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    getConfigViaRuntime: vi.fn(),
    testDbViaRuntime: vi.fn(),
    testLlmViaRuntime: vi.fn(),
    createSampleDatabaseViaRuntime: vi.fn(),
}));

vi.mock('../../api/runtime-client', () => runtime);

import { SampleDatabaseIntro } from '../SampleDatabaseIntro';
import { ReadinessProvider, useReadiness } from '../../hooks/useReadiness';
import { LanguageProvider } from '../../context/LanguageContext';

const Probe = () => {
    const readiness = useReadiness();
    return <span data-testid="probe">{readiness.database}:{String(readiness.usingSample)}</span>;
};

function renderProbe(config: Record<string, unknown>) {
    runtime.config = config;
    render(<LanguageProvider><ReadinessProvider onOpenSettings={vi.fn()}><Probe /></ReadinessProvider></LanguageProvider>);
}

describe('SampleDatabaseIntro', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.getConfigViaRuntime.mockImplementation(async () => runtime.config);
        runtime.testDbViaRuntime.mockResolvedValue({ success: true, message: '' });
    });

    it('describes the sample and puts a picked question in the composer', () => {
        const onPick = vi.fn();
        render(<LanguageProvider><SampleDatabaseIntro onPick={onPick} /></LanguageProvider>);
        const questions = screen.getAllByRole('button');
        expect(questions).toHaveLength(2);
        fireEvent.click(questions[1]!);
        expect(onPick).toHaveBeenCalledWith(questions[1]!.textContent?.replace(/^02/, ''));
    });

    it('is offered when the connected database is the sample file, on any path style', async () => {
        renderProbe({ api_key: 'k', driver: 'sqlite', database: 'C:\\Users\\u\\AppData\\Roaming\\yourdb\\samples\\sample-sales.sqlite' });
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('ready:true'));
    });

    it('is not offered for another SQLite file', async () => {
        renderProbe({ api_key: 'k', driver: 'sqlite', database: '/data/sales.sqlite' });
        await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('ready:false'));
    });
});
