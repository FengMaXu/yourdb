import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
    listChannelsViaRuntime: vi.fn(),
    provisionChannelViaRuntime: vi.fn(),
    disconnectChannelViaRuntime: vi.fn(),
    createChannelBindCodeViaRuntime: vi.fn(),
    listChannelAccessViaRuntime: vi.fn(),
    decideChannelAccessViaRuntime: vi.fn(),
    revokeChannelAccessViaRuntime: vi.fn(),
}));
vi.mock('../../api/runtime-client', () => api);
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (url: string) => `data:image/png;base64,${btoa(url)}`) } }));

import ChannelsSettings from '../ChannelsSettings';

const feishu = { id: 'feishu', label: '飞书', provisionable: true };

describe('ChannelsSettings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.listChannelAccessViaRuntime.mockResolvedValue({ members: [], requests: [] });
    });

    it('scans to connect: shows the QR code, then the connected state with any step left', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'unconfigured' }]);
        api.provisionChannelViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'provisioning', provisioning: { url: 'https://accounts.feishu.cn/x', expiresAt: Date.now() + 600_000 } }]);
        render(<ChannelsSettings />);
        fireEvent.click(await screen.findByRole('button', { name: '扫码接入' }));
        expect(api.provisionChannelViaRuntime).toHaveBeenCalledWith('feishu');
        expect(await screen.findByRole('img', { name: '用飞书扫码接入' })).toHaveAttribute('src', `data:image/png;base64,${btoa('https://accounts.feishu.cn/x')}`);
        expect(screen.getByText('等待扫码')).toBeInTheDocument();

        api.listChannelsViaRuntime.mockResolvedValue([{ ...feishu, state: 'connected', warnings: ['把订阅方式改为长连接'] }]);
        await waitFor(() => expect(screen.getByText('已连接')).toBeInTheDocument(), { timeout: 4000 });
        expect(screen.getByText(/还差一步：把订阅方式改为长连接/)).toBeInTheDocument();
        expect(screen.queryByRole('img', { name: '用飞书扫码接入' })).toBeNull();
    });

    it('tells a WeChat scan apart from a Feishu one', async () => {
        const weixin = { id: 'weixin', label: '微信', provisionable: true };
        api.listChannelsViaRuntime.mockResolvedValue([{ ...weixin, state: 'provisioning', provisioning: { url: 'https://liteapp.weixin.qq.com/q/x', expiresAt: Date.now() + 300_000 } }]);
        render(<ChannelsSettings />);
        expect(await screen.findByRole('img', { name: '用微信扫码接入' })).toBeInTheDocument();
        expect(screen.getByText(/用手机微信扫码并确认连接/)).toBeInTheDocument();
        expect(screen.queryByText(/在本机飞书中打开/)).toBeNull();
    });

    it('disconnects only after confirmation', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected' }]);
        api.disconnectChannelViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'unconfigured' }]);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<ChannelsSettings />);
        const button = await screen.findByRole('button', { name: '断开' });
        fireEvent.click(button);
        expect(api.disconnectChannelViaRuntime).not.toHaveBeenCalled();
        await act(async () => { fireEvent.click(button); });
        expect(api.disconnectChannelViaRuntime).toHaveBeenCalledWith('feishu');
        expect(await screen.findByText('未接入')).toBeInTheDocument();
        confirm.mockRestore();
    });

    it('shows a one-time code to send privately to the bot', async () => {
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected' }]);
        api.createChannelBindCodeViaRuntime.mockResolvedValueOnce({ code: '042195', expiresAt: Date.now() + 600_000 });
        render(<ChannelsSettings />);
        fireEvent.click(await screen.findByRole('button', { name: '获取绑定码' }));
        expect(await screen.findByText('/bind 042195')).toBeInTheDocument();
        expect(screen.getByText(/不要发到群里/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '重新获取' })).toBeInTheDocument();
    });

    it('lets a signed-in user decide waiting requests and revoke members', async () => {
        const carol = { channel: 'feishu', tenant: 't1', externalUserId: 'ou_ca23d94d08c1f8dd0cd860ecb98e1747' };
        api.listChannelsViaRuntime.mockResolvedValueOnce([{ ...feishu, state: 'connected' }]);
        api.listChannelAccessViaRuntime.mockResolvedValue({
            members: [{ actor: { channel: 'feishu', tenant: 't1', externalUserId: 'ou_admin' }, role: 'account', since: 1 }],
            requests: [{ id: 'req-1', requester: carol, audience: 'group', text: '上月销售额', at: 2 }],
        });
        api.decideChannelAccessViaRuntime.mockResolvedValueOnce({ members: [{ actor: carol, role: 'guest', since: 3 }], requests: [] });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render(<ChannelsSettings />);
        expect(await screen.findByText('“上月销售额”')).toBeInTheDocument();
        expect(screen.getByText('账号成员')).toBeInTheDocument();
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
