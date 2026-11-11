import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
    listChannelsViaRuntime: vi.fn(),
    provisionChannelViaRuntime: vi.fn(),
    disconnectChannelViaRuntime: vi.fn(),
    configureChannelViaRuntime: vi.fn(),
    createChannelBindCodeViaRuntime: vi.fn(),
    listChannelAccessViaRuntime: vi.fn(),
    decideChannelAccessViaRuntime: vi.fn(),
    revokeChannelAccessViaRuntime: vi.fn(),
}));
vi.mock('../../api/runtime-client', () => api);
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`) } }));

import ChannelsSettings from '../ChannelsSettings';

const feishu = { id: 'feishu', label: '飞书', provisionable: true };
const weixin = { id: 'weixin', label: '微信', provisionable: true };
const on = { enabled: true, replyDetail: 'standard' as const };

describe('ChannelsSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listChannelAccessViaRuntime.mockResolvedValue({ members: [], requests: [] });
    });

    it('starts at 新建机器人 when there is no bot, and scans to connect the platform picked', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'unconfigured' }, { ...weixin, state: 'unconfigured' }]);
        api.provisionChannelViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'provisioning', provisioning: { url: 'https://accounts.feishu.cn/x', expiresAt: Date.now() + 600_000 } }, { ...weixin, state: 'unconfigured' }]);
        render(<ChannelsSettings />);
        expect(await screen.findByText('还没有机器人。')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /飞书.*扫码接入/ }));
        expect(api.provisionChannelViaRuntime).toHaveBeenCalledWith('feishu');
        expect(await screen.findByRole('img', { name: '用飞书扫码接入' })).toHaveAttribute('src', `data:image/png;base64,${btoa('https://accounts.feishu.cn/x')}`);
        expect(screen.getByText(/在本机飞书中打开/)).toBeInTheDocument();

        api.listChannelsViaRuntime.mockResolvedValue([{ ...feishu, state: 'connected', settings: on, warnings: ['把订阅方式改为长连接'] }, { ...weixin, state: 'unconfigured' }]);
        await waitFor(() => expect(screen.getByText('飞书长连接运行中。')).toBeInTheDocument(), { timeout: 4000 });
        expect(screen.getByText(/还差一步：把订阅方式改为长连接/)).toBeInTheDocument();
        expect(screen.getByText(/第一条消息会收到欢迎和命令说明/)).toBeInTheDocument();
        expect(within(screen.getByRole('navigation', { name: '机器人列表' })).getByText('飞书机器人')).toBeInTheDocument();
    });

    it('offers only platforms without a bot under 新建机器人', async () => {
        api.listChannelsViaRuntime.mockResolvedValue([{ ...feishu, state: 'connected', settings: on }, { ...weixin, state: 'unconfigured' }]);
        render(<ChannelsSettings />);
        fireEvent.click(await screen.findByRole('button', { name: '新建机器人' }));
        expect(screen.getByRole('button', { name: /飞书.*已添加/ })).toBeDisabled();
        expect(screen.getByRole('button', { name: /微信.*扫码接入/ })).toBeEnabled();
    });

    it('switches a bot off and on, and changes its reply detail', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...weixin, state: 'connected', settings: on }]);
        api.configureChannelViaRuntime.mockResolvedValueOnce([{ ...weixin, state: 'paused', settings: { ...on, enabled: false } }]);
        render(<ChannelsSettings />);
        const toggle = await screen.findByRole('switch', { name: '停用机器人' });
        await act(async () => { fireEvent.click(toggle); });
        expect(api.configureChannelViaRuntime).toHaveBeenCalledWith('weixin', { enabled: false });
        expect(screen.getByText(/已停用：不再接收消息/)).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: '启用机器人' })).toHaveAttribute('aria-checked', 'false');

        api.configureChannelViaRuntime.mockResolvedValueOnce([{ ...weixin, state: 'paused', settings: { enabled: false, replyDetail: 'summary' } }]);
        await act(async () => { fireEvent.change(screen.getByRole('combobox', { name: '回复详细度' }), { target: { value: 'summary' } }); });
        expect(api.configureChannelViaRuntime).toHaveBeenLastCalledWith('weixin', { replyDetail: 'summary' });
        expect(screen.getByText('只在完成后发最终答案，消息最少。')).toBeInTheDocument();
    });

    it('deletes a bot only after confirmation', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected', settings: on }]);
        api.disconnectChannelViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'unconfigured' }]);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<ChannelsSettings />);
        const button = await screen.findByRole('button', { name: '删除机器人' });
        fireEvent.click(button);
        expect(api.disconnectChannelViaRuntime).not.toHaveBeenCalled();
        await act(async () => { fireEvent.click(button); });
        expect(api.disconnectChannelViaRuntime).toHaveBeenCalledWith('feishu');
        expect(await screen.findByText('还没有机器人。')).toBeInTheDocument();
        confirm.mockRestore();
    });

    it('shows a one-time code to send privately to the bot', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected', settings: on }]);
        api.createChannelBindCodeViaRuntime.mockResolvedValueOnce({ code: '042195', expiresAt: Date.now() + 600_000 });
        render(<ChannelsSettings />);
        fireEvent.click(await screen.findByRole('button', { name: '获取绑定码' }));
        expect(await screen.findByText('/bind 042195')).toBeInTheDocument();
        expect(screen.getByText(/不要发到群里/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '重新获取' })).toBeInTheDocument();
    });

    it("lets a signed-in user decide this bot's waiting requests and revoke its members", async () => {
        const carol = { channel: 'feishu', tenant: 't1', externalUserId: 'ou_ca23d94d08c1f8dd0cd860ecb98e1747' };
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected', settings: on }]);
        api.listChannelAccessViaRuntime.mockResolvedValue({
            members: [
                { actor: { channel: 'feishu', tenant: 't1', externalUserId: 'ou_admin' }, role: 'account', since: 1 },
                { actor: { channel: 'weixin', tenant: 'b', externalUserId: 'wx_other' }, role: 'account', since: 1 },
            ],
            requests: [{ id: 'req-1', requester: carol, audience: 'group', text: '上月销售额', at: 2 }],
        });
        api.decideChannelAccessViaRuntime.mockResolvedValueOnce({ members: [{ actor: carol, role: 'guest', since: 3 }], requests: [] });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<ChannelsSettings />);
        expect(await screen.findByText('“上月销售额”')).toBeInTheDocument();
        expect(screen.getAllByText('账号成员')).toHaveLength(1);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '允许' })); });
        expect(api.decideChannelAccessViaRuntime).toHaveBeenCalledWith('req-1', 'allow');
        expect(await screen.findByText('访客')).toBeInTheDocument();
        expect(screen.getByText('没有待处理的申请。')).toBeInTheDocument();

        api.revokeChannelAccessViaRuntime.mockResolvedValueOnce({ members: [], requests: [] });
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: '撤销' })); });
        expect(api.revokeChannelAccessViaRuntime).toHaveBeenCalledWith(carol);
        confirm.mockRestore();
    });

    it('says so when this host has no channels', async () => {
        api.listChannelsViaRuntime.mockRejectedValueOnce(new Error('DataAgent HTTP command failed: 400'));
        render(<ChannelsSettings />);
        expect(await screen.findByText(/没有启用消息渠道/)).toBeInTheDocument();
    });
});
