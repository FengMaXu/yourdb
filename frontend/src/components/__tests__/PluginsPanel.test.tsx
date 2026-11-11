import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
    getMcpConfigViaRuntime: vi.fn(),
    getMcpServersViaRuntime: vi.fn(),
    saveMcpConfigViaRuntime: vi.fn(),
    testMcpServerViaRuntime: vi.fn(),
    restartMcpServerViaRuntime: vi.fn(),
    listSkillsViaRuntime: vi.fn(),
}));
vi.mock('../../api/runtime-client', () => api);

import PluginsPanel from '../PluginsPanel';

const qcc = {
    name: 'qcc',
    enabled: false,
    transport: 'streamable-http',
    description: '查询企业工商信息',
    server_type: 'preset',
    preset: {
        id: 'qcc',
        title: '企查查',
        description: '查询企业工商信息',
        fields: [
            { key: 'apiKey', label: 'API Key', kind: 'secret', required: true, configured: true },
            { key: 'groups', label: '数据分组', kind: 'choices', required: true, defaultValue: ['company'], choices: [{ value: 'company', label: '企业信息' }, { value: 'risk', label: '风险信息' }] },
        ],
    },
    field_values: {},
};
const database = {
    name: 'database',
    enabled: true,
    host_managed: true,
    default_enabled: true,
    transport: 'stdio',
    description: '连接业务数据库',
    server_type: 'preset',
    settings_hint: '在「设置 → 数据库」中配置',
    preset: { id: 'database', title: '数据库', description: '连接业务数据库', fields: [] },
};
const custom = { name: 'mine', enabled: true, transport: 'http', url: 'https://x', headers: { configured: true, count: 1 }, env: { configured: false, count: 0 }, args: [] };

describe('PluginsPanel MCP presets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.getMcpConfigViaRuntime.mockResolvedValue({ servers: [database, qcc, custom] });
        api.getMcpServersViaRuntime.mockResolvedValue([
            { name: 'database', enabled: true, connected: true, toolCount: 4, hostManaged: true },
            { name: 'mine', enabled: true, connected: true, toolCount: 2, hostManaged: false },
        ]);
        api.saveMcpConfigViaRuntime.mockResolvedValue(undefined);
        api.listSkillsViaRuntime.mockResolvedValue([]);
    });

    it('lists the database with its status, without controls while it is connected', async () => {
        render(<PluginsPanel tab="MCP" onOpenDatabaseSettings={vi.fn()} />);
        expect(await screen.findByText('数据库')).toBeInTheDocument();
        await waitFor(() => expect(screen.getAllByText('已连接').length).toBeGreaterThan(0));
        expect(screen.queryByRole('button', { name: '前往配置数据库' })).toBeNull();
        // Plugins are edited in the settings tab, not from their cards.
        expect(screen.queryByRole('button', { name: /编辑|Edit/ })).toBeNull();
        fireEvent.click(screen.getAllByRole('tab')[1]!);
        expect(screen.queryByRole('button', { name: '数据库' })).toBeNull();
    });

    it('offers database settings when the database is not connected', async () => {
        api.getMcpServersViaRuntime.mockResolvedValue([{ name: 'database', enabled: true, connected: false, toolCount: 0, hostManaged: true }]);
        const open = vi.fn();
        render(<PluginsPanel tab="MCP" onOpenDatabaseSettings={open} />);
        fireEvent.click(await screen.findByRole('button', { name: '前往配置数据库' }));
        expect(open).toHaveBeenCalledOnce();
    });

    it('keeps the database status while the list reloads after a save', async () => {
        render(<PluginsPanel tab="MCP" onOpenDatabaseSettings={vi.fn()} />);
        await screen.findByText('企查查');
        await waitFor(() => expect(screen.getAllByText('已连接').length).toBeGreaterThan(0));
        api.getMcpServersViaRuntime.mockReturnValue(new Promise(() => {}));
        fireEvent.click(screen.getAllByRole('button', { name: /启用|Enable/ })[0]!);
        await waitFor(() => expect(api.getMcpConfigViaRuntime).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('button', { name: '前往配置数据库' })).toBeNull();
    });

    it('lists presets by title and enables one without sending masked secrets back', async () => {
        render(<PluginsPanel tab="MCP" />);
        expect(await screen.findByText('企查查')).toBeInTheDocument();
        await waitFor(() => expect(api.getMcpServersViaRuntime).toHaveBeenCalled());
        const enable = screen.getAllByRole('button', { name: /启用|Enable/ })[0]!;
        fireEvent.click(enable);
        await waitFor(() => expect(api.saveMcpConfigViaRuntime).toHaveBeenCalled());
        const saved = api.saveMcpConfigViaRuntime.mock.calls[0]![0] as { servers: Array<Record<string, unknown>> };
        // The database is never part of a plugin save.
        expect(saved.servers.map((server) => server.name)).toEqual(['qcc', 'mine']);
        expect(saved.servers[0]).toEqual({ name: 'qcc', enabled: true, transport: 'streamable-http', field_values: {} });
        // The custom plugin keeps its stored headers: the page sends none.
        expect(saved.servers[1]).not.toHaveProperty('headers');
        expect(saved.servers[1]).not.toHaveProperty('env');
    });

    it('saves a typed key and chosen groups from the preset form', async () => {
        render(<PluginsPanel tab="MCP" />);
        await screen.findByText('企查查');
        fireEvent.click(screen.getAllByRole('tab')[1]!);
        const key = await screen.findByLabelText(/API Key/);
        expect(key).toHaveAttribute('type', 'password');
        fireEvent.change(key, { target: { value: 'k-1' } });
        fireEvent.click(screen.getByLabelText('风险信息'));
        fireEvent.click(screen.getByRole('button', { name: /保存|Save/ }));
        await waitFor(() => expect(api.saveMcpConfigViaRuntime).toHaveBeenCalled());
        const saved = api.saveMcpConfigViaRuntime.mock.calls[0]![0] as { servers: Array<Record<string, unknown>> };
        expect(saved.servers[0]).toMatchObject({ name: 'qcc', field_values: { apiKey: 'k-1', groups: ['company', 'risk'] } });
    });
});
