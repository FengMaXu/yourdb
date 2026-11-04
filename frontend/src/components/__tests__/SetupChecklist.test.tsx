import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const runtime = vi.hoisted(() => ({
    config: {} as Record<string, unknown>,
    getConfigViaRuntime: vi.fn(),
    testDbViaRuntime: vi.fn(),
    testLlmViaRuntime: vi.fn(),
    createSampleDatabaseViaRuntime: vi.fn(),
}));

vi.mock('../../api/runtime-client', () => runtime);

import { SetupChecklist } from '../SetupChecklist';
import { ReadinessProvider } from '../../hooks/useReadiness';
import { LanguageProvider } from '../../context/LanguageContext';

function renderChecklist(onOpenSettings = vi.fn()) {
    render(
        <LanguageProvider>
            <ReadinessProvider onOpenSettings={onOpenSettings}><SetupChecklist /></ReadinessProvider>
        </LanguageProvider>,
    );
    return onOpenSettings;
}

describe('SetupChecklist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runtime.config = {};
        runtime.getConfigViaRuntime.mockImplementation(async () => runtime.config);
        runtime.testDbViaRuntime.mockResolvedValue({ success: true, message: 'ok' });
    });

    it('offers both setup actions on a fresh install, without testing an empty database form', async () => {
        const open = renderChecklist();
        fireEvent.click(await screen.findByRole('button', { name: '配置' }));
        expect(open).toHaveBeenCalledWith('model');
        fireEvent.click(screen.getByRole('button', { name: '连接数据库' }));
        expect(open).toHaveBeenCalledWith('database');
        expect(runtime.testDbViaRuntime).not.toHaveBeenCalled();
    });

    it('ticks the database only when the saved connection answers, and says why it did not', async () => {
        runtime.config = { api_key: 'k', driver: 'mysql', host: 'db', database: 'sales' };
        runtime.testDbViaRuntime.mockResolvedValue({ success: false, message: 'MySQL 连接失败: refused' });
        renderChecklist();
        expect(await screen.findByText('MySQL 连接失败: refused')).toBeInTheDocument();
        expect(screen.getByText('已保存的数据库连不上：')).toBeInTheDocument();
        expect(runtime.testDbViaRuntime).toHaveBeenCalledWith(expect.objectContaining({ driver: 'mysql', host: 'db', database: 'sales' }));
        expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
    });

    it('connects the sample database and ticks the step', async () => {
        runtime.config = { api_key: 'k' };
        runtime.createSampleDatabaseViaRuntime.mockImplementation(async () => {
            runtime.config = { api_key: 'k', driver: 'sqlite', database: '/data/samples/sample-sales.sqlite' };
            return { success: true, message: '已连接示例销售库' };
        });
        renderChecklist();
        fireEvent.click(await screen.findByRole('button', { name: '用示例 SQLite 先试试' }));
        expect(await screen.findByText('数据库已连通。')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '用示例 SQLite 先试试' })).not.toBeInTheDocument();
    });

    it('tests the saved model through the runtime and shows the answer', async () => {
        runtime.config = { api_key: 'k' };
        runtime.testLlmViaRuntime.mockResolvedValue({ success: false, message: 'OpenAI 兼容接口校验失败 (HTTP 401)' });
        renderChecklist();
        fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 401');
        expect(runtime.testLlmViaRuntime).toHaveBeenCalledWith({});
    });
});
