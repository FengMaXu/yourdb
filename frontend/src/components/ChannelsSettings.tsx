import React, { useCallback, useEffect, useState } from 'react';
import { UI } from './workspace-ui';
import { cn } from '@/lib/utils';
import { Loader2, Plus, QrCode, Trash2 } from 'lucide-react';
import QRCode from 'qrcode';
import {
    configureChannelViaRuntime,
    createChannelBindCodeViaRuntime,
    decideChannelAccessViaRuntime,
    disconnectChannelViaRuntime,
    listChannelAccessViaRuntime,
    listChannelsViaRuntime,
    provisionChannelViaRuntime,
    revokeChannelAccessViaRuntime,
    type ChannelAccessView,
    type ChannelStatusView,
    type ReplyDetailView,
} from '../api/runtime-client';

/** How often the page asks for news while someone is scanning. */
const POLL_MS = 2000;

/** What each platform is, as the picker and the bot header describe it. */
const PLATFORM: Record<string, { name: string; color: string; glyph: string; pitch: string; running: string; scan: string }> = {
    weixin: {
        name: '微信',
        // eslint-disable-next-line no-restricted-syntax -- WeChat's own brand colour, not ours.
        color: '#07C160',
        glyph: '微',
        pitch: '扫码登录，自动绑定。在微信里和机器人私聊提问。',
        running: '微信长轮询运行中。',
        scan: '用手机微信扫码并确认连接。连接后，在微信里和机器人私聊即可提问。',
    },
    feishu: {
        name: '飞书',
        // eslint-disable-next-line no-restricted-syntax -- Feishu's own brand colour, not ours.
        color: '#3370FF',
        glyph: '飞',
        pitch: '扫码创建飞书应用。私聊提问，或在群里 @ 机器人。',
        running: '飞书长连接运行中。',
        scan: '用手机飞书扫码，按页面提示创建机器人并确认授权。',
    },
};
const platformOf = (channel: Pick<ChannelStatusView, 'id' | 'label'>) => PLATFORM[channel.id] ?? { name: channel.label, color: 'var(--muted-foreground)', glyph: channel.label.slice(0, 1), pitch: `扫码接入${channel.label}。`, running: '运行中。', scan: `用手机${channel.label}扫码接入。` };

const DOT: Record<ChannelStatusView['state'], string> = {
    connected: 'bg-success',
    paused: 'bg-faint',
    provisioning: 'bg-warning',
    failed: 'bg-destructive',
    unconfigured: 'bg-border-strong',
};
const STATE_TEXT: Record<ChannelStatusView['state'], string> = {
    connected: '运行中',
    paused: '已停用',
    provisioning: '等待扫码',
    failed: '连接失败',
    unconfigured: '未接入',
};

const REPLY_DETAIL: Array<{ value: ReplyDetailView; label: string; hint: string }> = [
    { value: 'summary', label: '摘要', hint: '只在完成后发最终答案，消息最少。' },
    { value: 'standard', label: '标准', hint: '边写边发，并显示正在做的步骤。' },
    { value: 'full', label: '完整', hint: '标准之外，在答案下列出做过的步骤，便于核对。' },
];

const COMMANDS: Array<[string, string]> = [
    ['/new', '开始新对话'],
    ['/status', '查看机器人和你的状态'],
    ['/detail 摘要|标准|完整', '调整回复详细度（账号成员）'],
    ['/help', '查看可用命令'],
];

/** A set-up bot shows in the list; a platform that was never connected is only offered under 新建机器人. */
const isBot = (channel: ChannelStatusView) => channel.state !== 'unconfigured';

const Mark: React.FC<{ channel: Pick<ChannelStatusView, 'id' | 'label'>; size?: number }> = ({ channel, size = 36 }) => {
    const platform = platformOf(channel);
    return (
        <span aria-hidden="true" className="grid flex-none place-items-center rounded-lg font-semibold text-white" style={{ width: size, height: size, background: platform.color, fontSize: size * 0.42 }}>
            {platform.glyph}
        </span>
    );
};

const QrLink: React.FC<{ channel: ChannelStatusView; url: string; expiresAt: number }> = ({ channel, url, expiresAt }) => {
    const [image, setImage] = useState<string>();
    const [now, setNow] = useState(() => Date.now());
    const platform = platformOf(channel);
    useEffect(() => {
        let cancelled = false;
        QRCode.toDataURL(url, { margin: 1, width: 200 }).then((data) => { if (!cancelled) setImage(data); }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [url]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
    return (
        <div className="flex items-center gap-6 rounded-xl bg-paper p-4 max-[720px]:flex-col max-[720px]:items-start [&_img]:flex-none [&_img]:rounded-lg [&_img]:bg-white [&_img]:shadow-[0_0_0_1px_var(--border),0_8px_24px_-16px_rgba(28,25,23,0.3)]">
            {image ? <img src={image} width={168} height={168} alt={`用${platform.name}扫码接入`} /> : <Loader2 size={24} className="animate-spin" />}
            <div className="grid gap-1 text-[0.875rem] leading-[1.7] text-body-strong [&_a]:text-brand">
                <div>{platform.scan}</div>
                {channel.id === 'feishu' && <div>也可以 <a href={url} target="_blank" rel="noreferrer">在本机飞书中打开</a>。</div>}
                <div className="text-[0.8rem] text-muted-foreground">{seconds > 0 ? `二维码 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后过期` : '二维码已过期，请重新扫码'}</div>
            </div>
        </div>
    );
};

/** One labelled row of a settings card: what it is on the left, the control on the right. */
const Row: React.FC<{ title: string; desc: React.ReactNode; children?: React.ReactNode }> = ({ title, desc, children }) => (
    <div className="flex items-center gap-4 px-5 py-4 max-[720px]:flex-col max-[720px]:items-stretch [&+&]:border-t [&+&]:border-border">
        <div className="min-w-0 flex-1">
            <div className="text-[0.9rem] font-semibold text-foreground">{title}</div>
            <div className="mt-1 text-[0.82rem] leading-[1.6] text-muted-foreground">{desc}</div>
        </div>
        {children}
    </div>
);

const Panel: React.FC<{ label: string; children: React.ReactNode; className?: string }> = ({ label, children, className }) => (
    <section aria-label={label} className={cn('overflow-hidden rounded-xl border border-border bg-white', className)}>{children}</section>
);

/**
 * Only IM identities linked to an account may use a bot. The code links whoever
 * sends it, in a private chat with the bot, to the account signed in here.
 */
const LinkAccount: React.FC = () => {
    const [link, setLink] = useState<{ code: string; expiresAt: number }>();
    const [failed, setFailed] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!link) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [link]);
    const issue = async () => {
        setFailed(false);
        try {
            setLink(await createChannelBindCodeViaRuntime());
            setNow(Date.now());
        } catch {
            setFailed(true);
        }
    };
    const seconds = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
    return (
        <Row title="用另一个 IM 账号使用" desc="扫码的人已自动绑定，不需要这一步。想用另一个账号使用时，在与机器人的私聊里发送绑定码。绑定任何人都等于让他能查询本应用的数据。">
            <button type="button" className={UI.btn} onClick={() => { void issue(); }}>{link ? '重新获取' : '获取绑定码'}</button>
            {(link || failed) && (
                <div className="basis-full max-[720px]:basis-auto">
                    {link && seconds > 0 && (
                        <div className="grid gap-1.5 rounded-xl bg-paper px-4 py-3.5 text-[0.9rem] leading-[1.7] text-body-strong">
                            <div>在与机器人的<strong>私聊</strong>中发送：<code className={cn(UI.code, 'text-[1.05rem] font-semibold tracking-[0.02em]')}>/bind {link.code}</code></div>
                            <div className="text-[0.8rem] text-muted-foreground">绑定码只能用一次，{Math.floor(seconds / 60)} 分 {seconds % 60} 秒后过期。不要发到群里。</div>
                        </div>
                    )}
                    {link && seconds === 0 && <p className={UI.empty}>绑定码已过期，请重新获取。</p>}
                    {failed && <div role="alert" className={UI.alert} data-tone="error">无法获取绑定码，请稍后重试。</div>}
                </div>
            )}
        </Row>
    );
};

/** IM ids are long and opaque; a short form is enough to tell people apart. */
const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Who may use this bot, and who is waiting. Deciding here is the same as tapping the card in the IM. */
const AccessList: React.FC<{ channelId: string; access: ChannelAccessView | undefined; failed: boolean; apply: (action: () => Promise<ChannelAccessView>) => Promise<void> }> = ({ channelId, access, failed, apply }) => {
    if (failed && !access) return null;
    const requests = access?.requests.filter((request) => request.requester.channel === channelId) ?? [];
    const members = access?.members.filter((member) => member.actor.channel === channelId) ?? [];
    return (
        <Panel label="授权名单">
            <Row title="授权名单" desc="扫码的人可以直接使用。其他人给机器人发消息时，会向账号成员申请；账号成员可以审批，访客只能使用。重新扫码或删除机器人后，名单会清空。">
                <button type="button" className={UI.btn} onClick={() => { void apply(listChannelAccessViaRuntime); }}>刷新</button>
            </Row>
            <div className="grid gap-4 border-t border-border px-5 py-4">
                {!access ? <Loader2 size={20} className="animate-spin" /> : (
                    <>
                        <div>
                            <h4 className={UI.subhead}>待处理的申请</h4>
                            {requests.length === 0 ? <p className={UI.empty}>没有待处理的申请。</p> : (
                                <div className="grid gap-2">
                                    {requests.map((request) => (
                                        <div key={request.id} role="group" aria-label={`申请 ${shortId(request.requester.externalUserId)}`} className="flex items-center gap-2.5 rounded-xl border border-warning-border bg-warning-soft px-3.5 py-3 max-[720px]:flex-wrap">
                                            <div className="min-w-0 flex-1 text-[0.85rem] text-body-strong">
                                                <div>{shortId(request.requester.externalUserId)} · {request.audience === 'group' ? '群聊' : '私聊'} · {when(request.at)}</div>
                                                {request.text && <div className="mt-1 break-all text-muted-foreground">“{request.text}”</div>}
                                            </div>
                                            <button type="button" className={cn(UI.btn, UI.btnPrimary, UI.btnSm)} onClick={() => { if (window.confirm('允许后，对方能查询本应用可以访问的全部数据。确定允许？')) void apply(() => decideChannelAccessViaRuntime(request.id, 'allow')); }}>允许</button>
                                            <button type="button" className={cn(UI.btn, UI.btnSm)} onClick={() => { void apply(() => decideChannelAccessViaRuntime(request.id, 'deny')); }}>拒绝</button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div>
                            <h4 className={UI.subhead}>可以使用的人</h4>
                            {members.length === 0 ? <p className={UI.empty}>还没有人。给机器人发第一条消息后就会出现在这里。</p> : (
                                <table className={UI.table}>
                                    <thead><tr><th>IM 账号</th><th>身份</th><th>开始时间</th><th aria-label="操作" /></tr></thead>
                                    <tbody>
                                        {members.map((member) => (
                                            <tr key={`${member.actor.tenant}|${member.actor.externalUserId}`}>
                                                <td className={UI.mono} title={member.actor.externalUserId}>{shortId(member.actor.externalUserId)}</td>
                                                <td><span className={UI.pill}>{member.role === 'account' ? '账号成员' : '访客'}</span></td>
                                                <td>{when(member.since)}</td>
                                                <td className={UI.tableAction}>
                                                    <button type="button" className={cn(UI.btn, UI.btnQuiet, UI.btnDanger, UI.btnSm)} onClick={() => { if (window.confirm('撤销后，对方再发消息需要重新申请。确定撤销？')) void apply(() => revokeChannelAccessViaRuntime(member.actor)); }}>撤销</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                        {failed && <div role="alert" className={UI.alert} data-tone="error">操作没有成功，请刷新后重试。</div>}
                    </>
                )}
            </div>
        </Panel>
    );
};

/** Under 新建机器人: one card per platform; a platform that already has a bot says so. */
const Picker: React.FC<{ channels: ChannelStatusView[]; busy: string | undefined; onPick: (channelId: string) => void }> = ({ channels, busy, onPick }) => (
    <div className={UI.stack}>
        <div>
            <h3 className="m-0 text-[1.05rem] font-[650] text-foreground">新建机器人</h3>
            <p className={cn(UI.cardDesc, 'mt-1')}>选择聊天工具，扫码后即可在手机上向数据智能体提问、接收结果和看板。每个聊天工具接入一个机器人。</p>
        </div>
        <div className="grid gap-3">
            {channels.filter((channel) => channel.provisionable).map((channel) => {
                const platform = platformOf(channel);
                const exists = isBot(channel);
                return (
                    <button
                        key={channel.id}
                        type="button"
                        disabled={exists || busy === channel.id}
                        onClick={() => onPick(channel.id)}
                        className="flex cursor-pointer items-center gap-4 rounded-xl border border-border bg-white px-5 py-4 text-left [font:inherit] transition-[border-color,box-shadow] enabled:hover:border-border-strong enabled:hover:shadow-[0_8px_24px_-18px_rgba(28,25,23,0.35)] disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    >
                        <Mark channel={channel} size={40} />
                        <span className="min-w-0 flex-1">
                            <span className="block text-[0.95rem] font-semibold text-foreground">{platform.name}</span>
                            <span className="mt-0.5 block text-[0.82rem] leading-[1.6] text-muted-foreground">{platform.pitch}</span>
                        </span>
                        <span className="flex-none text-[0.82rem] font-semibold text-brand">
                            {busy === channel.id ? <Loader2 size={16} className="animate-spin" /> : exists ? <span className="text-muted-foreground">已添加</span> : '扫码接入'}
                        </span>
                    </button>
                );
            })}
        </div>
    </div>
);

const BotDetail: React.FC<{
    channel: ChannelStatusView;
    busy: boolean;
    access: ChannelAccessView | undefined;
    accessFailed: boolean;
    applyAccess: (action: () => Promise<ChannelAccessView>) => Promise<void>;
    onRescan: () => void;
    onDelete: () => void;
    onConfigure: (settings: { enabled?: boolean; replyDetail?: ReplyDetailView }) => void;
}> = ({ channel, busy, access, accessFailed, applyAccess, onRescan, onDelete, onConfigure }) => {
    const platform = platformOf(channel);
    const settings = channel.settings;
    const statusLine = channel.state === 'connected' ? platform.running
        : channel.state === 'paused' ? '已停用：不再接收消息，凭据和授权名单都保留。'
            : channel.state === 'provisioning' ? '等待扫码。'
                : channel.state === 'failed' ? '连接失败。' : '未接入。';
    const detail = REPLY_DETAIL.find((item) => item.value === settings?.replyDetail) ?? REPLY_DETAIL[1]!;
    return (
        <div className={cn(UI.stack, UI.enter)}>
            <div className="flex items-center gap-4 px-1">
                <Mark channel={channel} size={44} />
                <div className="min-w-0 flex-1">
                    <h3 className="m-0 text-[1.05rem] font-[650] text-foreground">{platform.name}机器人</h3>
                    <p className="m-0 mt-1 flex items-center gap-2 text-[0.84rem] text-muted-foreground">
                        <span className={cn('size-[7px] flex-none rounded-full', DOT[channel.state])} aria-hidden="true" />
                        {statusLine}
                    </p>
                </div>
                {settings && (
                    <button
                        type="button"
                        role="switch"
                        aria-checked={settings.enabled}
                        aria-label={settings.enabled ? '停用机器人' : '启用机器人'}
                        title={settings.enabled ? '停用机器人' : '启用机器人'}
                        className={UI.switch}
                        disabled={busy}
                        onClick={() => onConfigure({ enabled: !settings.enabled })}
                    />
                )}
            </div>

            <Panel label="关联机器人">
                <Row title="关联机器人" desc="扫码后自动保存凭据；重新扫码会换成新的机器人。">
                    <div className="flex items-center gap-2.5">
                        {channel.state === 'connected' && <span className={UI.pill} data-tone="ok">已连通</span>}
                        {channel.state === 'paused' && <span className={UI.pill} data-tone="idle">已停用</span>}
                        {channel.state === 'failed' && <span className={UI.pill} data-tone="error">连接失败</span>}
                        {channel.provisionable && (
                            <button type="button" className={UI.btn} disabled={busy} onClick={onRescan}>
                                {busy ? <Loader2 size={15} className="animate-spin" /> : <QrCode size={15} aria-hidden="true" />}
                                重新扫码
                            </button>
                        )}
                    </div>
                </Row>
                <div className="grid gap-2.5 border-t border-border px-5 py-4">
                    {channel.provisioning && channel.state === 'provisioning' && <QrLink channel={channel} url={channel.provisioning.url} expiresAt={channel.provisioning.expiresAt} />}
                    {channel.state !== 'provisioning' && (
                        <div className="rounded-xl bg-paper px-4 py-3 text-[0.85rem] leading-[1.7] text-body-strong">
                            请在{platform.name}里向机器人发送任意消息；第一条消息会收到欢迎和命令说明。
                        </div>
                    )}
                    {channel.message && <div role="alert" className={UI.alert} data-tone="error">{channel.message}</div>}
                    {channel.warnings?.map((warning) => (
                        <div key={warning} role="status" className={UI.alert} data-tone="warn">还差一步：{warning}</div>
                    ))}
                </div>
            </Panel>

            {settings && (
                <Panel label="回复设置">
                    <Row title="回复详细度" desc={detail.hint}>
                        <select
                            aria-label="回复详细度"
                            className={cn(UI.input, UI.select, 'w-[180px] max-[720px]:w-full')}
                            value={settings.replyDetail}
                            disabled={busy}
                            onChange={(event) => onConfigure({ replyDetail: event.target.value as ReplyDetailView })}
                        >
                            {REPLY_DETAIL.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                    </Row>
                    <Row title="聊天里可用的命令" desc={(
                        <span className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                            {COMMANDS.map(([command, meaning]) => (
                                <React.Fragment key={command}>
                                    <code className={cn(UI.code, 'w-fit')}>{command}</code>
                                    <span>{meaning}</span>
                                </React.Fragment>
                            ))}
                        </span>
                    )} />
                    <LinkAccount />
                </Panel>
            )}

            {settings && <AccessList channelId={channel.id} access={access} failed={accessFailed} apply={applyAccess} />}

            <Panel label="删除机器人">
                <Row title="删除机器人" desc="删除凭据并清空授权名单。之后要用，需要重新扫码。">
                    <button type="button" className={cn(UI.btn, 'border-destructive-border bg-destructive-soft text-destructive enabled:hover:border-destructive-border enabled:hover:bg-destructive-soft')} disabled={busy} onClick={onDelete}>
                        <Trash2 size={15} aria-hidden="true" />
                        删除机器人
                    </button>
                </Row>
            </Panel>
        </div>
    );
};

/** Settings page for chat bots: a list of bots, one bot's details beside it, and 新建机器人 for the platforms not yet connected. Credentials never reach the page. */
const ChannelsSettings: React.FC = () => {
    const [channels, setChannels] = useState<ChannelStatusView[]>();
    const [unavailable, setUnavailable] = useState(false);
    const [busy, setBusy] = useState<string>();
    const [failure, setFailure] = useState<string>();
    /** The bot shown on the right, or 'new' for the platform picker; undefined follows the list. */
    const [selected, setSelected] = useState<string>();
    const [access, setAccess] = useState<ChannelAccessView>();
    const [accessFailed, setAccessFailed] = useState(false);

    const refresh = useCallback(async () => {
        try {
            setChannels(await listChannelsViaRuntime());
            setUnavailable(false);
        } catch {
            setUnavailable(true);
        }
    }, []);

    const applyAccess = useCallback(async (action: () => Promise<ChannelAccessView>) => {
        try {
            setAccess(await action());
            setAccessFailed(false);
        } catch {
            setAccessFailed(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => { void applyAccess(listChannelAccessViaRuntime); }, [applyAccess]);

    const scanning = channels?.some((channel) => channel.state === 'provisioning') ?? false;
    useEffect(() => {
        if (!scanning) return;
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [scanning, refresh]);

    const run = async (channelId: string, action: () => Promise<ChannelStatusView[]>) => {
        setBusy(channelId);
        setFailure(undefined);
        try {
            setChannels(await action());
        } catch {
            setFailure('操作没有成功，请稍后重试。');
            await refresh();
        } finally {
            setBusy(undefined);
        }
    };

    if (unavailable) {
        return <p className={UI.lead}>当前运行方式没有启用消息渠道，或暂时无法读取渠道状态。</p>;
    }
    if (!channels) return <Loader2 size={20} className="animate-spin" />;

    const bots = channels.filter(isBot);
    const current = selected === 'new' ? undefined : bots.find((bot) => bot.id === selected) ?? bots[0];

    return (
        <div className="flex max-w-[1040px] flex-col gap-4">
            <p className={UI.lead}>把飞书、微信接入数据智能体：在手机上直接提问，接收查询结果和看板。</p>
            <div className="grid grid-cols-[248px_minmax(0,1fr)] items-start gap-4 max-[900px]:grid-cols-1">
                <nav aria-label="机器人列表" className="grid gap-1.5 rounded-xl border border-border bg-paper p-2">
                    <button
                        type="button"
                        className={cn(UI.btn, 'w-full justify-start', !current && 'border-border-strong bg-white')}
                        aria-current={!current ? 'page' : undefined}
                        onClick={() => setSelected('new')}
                    >
                        <Plus size={15} aria-hidden="true" />
                        新建机器人
                    </button>
                    {bots.length === 0 && <p className="m-0 px-2.5 py-3 text-[0.8rem] leading-[1.6] text-muted-foreground">还没有机器人。</p>}
                    {bots.map((bot) => {
                        const active = current?.id === bot.id;
                        return (
                            <button
                                key={bot.id}
                                type="button"
                                aria-current={active ? 'page' : undefined}
                                onClick={() => setSelected(bot.id)}
                                className={cn(
                                    'flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent bg-transparent px-2.5 py-2.5 text-left [font:inherit] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand',
                                    active && 'border-border bg-white shadow-[0_1px_2px_rgba(28,25,23,0.05)]',
                                )}
                            >
                                <Mark channel={bot} size={32} />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[0.875rem] font-semibold text-foreground">{platformOf(bot).name}机器人</span>
                                    <span className="block text-[0.76rem] text-muted-foreground">{STATE_TEXT[bot.state]}</span>
                                </span>
                                <span className={cn('size-2 flex-none rounded-full', DOT[bot.state])} aria-hidden="true" />
                            </button>
                        );
                    })}
                </nav>

                <div className="min-w-0">
                    {failure && <div role="alert" className={cn(UI.alert, 'mb-4')} data-tone="error">{failure}</div>}
                    {current ? (
                        <BotDetail
                            key={current.id}
                            channel={current}
                            busy={busy === current.id}
                            access={access}
                            accessFailed={accessFailed}
                            applyAccess={applyAccess}
                            onRescan={() => { void run(current.id, () => provisionChannelViaRuntime(current.id)); }}
                            onDelete={() => {
                                if (!window.confirm(`删除${platformOf(current).name}机器人？已保存的凭据和授权名单会被清除。`)) return;
                                setSelected(undefined);
                                void run(current.id, async () => {
                                    const next = await disconnectChannelViaRuntime(current.id);
                                    await applyAccess(listChannelAccessViaRuntime);
                                    return next;
                                });
                            }}
                            onConfigure={(settings) => { void run(current.id, () => configureChannelViaRuntime(current.id, settings)); }}
                        />
                    ) : (
                        <Picker
                            channels={channels}
                            busy={busy}
                            onPick={(channelId) => {
                                setSelected(channelId);
                                void run(channelId, () => provisionChannelViaRuntime(channelId));
                            }}
                        />
                    )}
                </div>
            </div>
        </div>
    );
};

export default ChannelsSettings;
