import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import QRCode from 'qrcode';
import { createChannelBindCodeViaRuntime, decideChannelAccessViaRuntime, disconnectChannelViaRuntime, listChannelAccessViaRuntime, listChannelsViaRuntime, provisionChannelViaRuntime, revokeChannelAccessViaRuntime, type ChannelAccessView, type ChannelStatusView } from '../api/runtime-client';

const STATE_LABEL: Record<ChannelStatusView['state'], { text: string; tone: 'idle' | 'warn' | 'ok' | 'error' }> = {
    unconfigured: { text: '未接入', tone: 'idle' },
    provisioning: { text: '等待扫码', tone: 'warn' },
    connected: { text: '已连接', tone: 'ok' },
    failed: { text: '连接失败', tone: 'error' },
};

/** How often the page asks for news while someone is scanning. */
const POLL_MS = 2000;

const QrLink: React.FC<{ url: string; expiresAt: number }> = ({ url, expiresAt }) => {
    const [image, setImage] = useState<string>();
    const [now, setNow] = useState(() => Date.now());
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
        <div className="channel-qr">
            {image ? <img src={image} width={168} height={168} alt="用飞书扫码接入" /> : <Loader2 size={24} className="legacy-animate-spin" />}
            <div className="channel-qr-text">
                <div>用手机飞书扫码，按页面提示创建机器人并确认授权。</div>
                <div>也可以 <a href={url} target="_blank" rel="noreferrer">在本机飞书中打开</a>。</div>
                <div className="channel-meta">{seconds > 0 ? `二维码 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒后过期` : '二维码已过期，请重新扫码'}</div>
            </div>
        </div>
    );
};

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
        <section aria-label="绑定我的 IM 账号" className="ui-card ui-stack">
            <div className="ui-card-head">
                <div>
                    <h3 className="ui-card-title">绑定我的 IM 账号</h3>
                    <p className="ui-card-desc">机器人只回应已绑定账号的人。绑定后，你在 IM 里的对话会出现在这个账号下；查询用的是本应用配置的数据库，绑定任何人都等于让他能查询这些数据。</p>
                </div>
                <button type="button" className={link ? 'ui-btn' : 'ui-btn ui-btn-primary'} onClick={() => { void issue(); }}>{link ? '重新获取' : '获取绑定码'}</button>
            </div>
            {link && seconds > 0 && (
                <div className="channel-bind">
                    <div>在与机器人的<strong>私聊</strong>中发送：<code className="ui-code">/bind {link.code}</code></div>
                    <div className="channel-meta">绑定码只能用一次，{Math.floor(seconds / 60)} 分 {seconds % 60} 秒后过期。不要发到群里。</div>
                </div>
            )}
            {link && seconds === 0 && <p className="ui-empty">绑定码已过期，请重新获取。</p>}
            {failed && <div role="alert" className="ui-alert" data-tone="error">无法获取绑定码，请稍后重试。</div>}
        </section>
    );
};

const PLATFORM: Record<string, string> = { feishu: '飞书' };
/** IM ids are long and opaque; a short form is enough to tell people apart. */
const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-4)}` : id;
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Who may use the bots, and who is waiting. Deciding here is the same as tapping the card in the IM. */
const AccessList: React.FC = () => {
    const [access, setAccess] = useState<ChannelAccessView>();
    const [failed, setFailed] = useState(false);
    const apply = async (action: () => Promise<ChannelAccessView>) => {
        try {
            setAccess(await action());
            setFailed(false);
        } catch {
            setFailed(true);
        }
    };
    useEffect(() => { void apply(listChannelAccessViaRuntime); }, []);
    if (failed && !access) return null;
    return (
        <section aria-label="授权名单" className="ui-card ui-stack">
            <div className="ui-card-head">
                <div>
                    <h3 className="ui-card-title">授权名单</h3>
                    <p className="ui-card-desc">没有权限的人给机器人发消息时，会向已绑定账号的成员发出使用申请。账号成员可以审批别人；访客只能使用。</p>
                </div>
                <button type="button" className="ui-btn" onClick={() => { void apply(listChannelAccessViaRuntime); }}>刷新</button>
            </div>
            {!access ? <Loader2 size={20} className="legacy-animate-spin" /> : (
                <>
                    <div>
                        <h4 className="ui-subhead">待处理的申请</h4>
                        {access.requests.length === 0 ? <p className="ui-empty">没有待处理的申请。</p> : (
                            <div className="channel-requests">
                                {access.requests.map((request) => (
                                    <div key={request.id} role="group" aria-label={`申请 ${shortId(request.requester.externalUserId)}`} className="channel-request">
                                        <div className="channel-request-text">
                                            <div>{PLATFORM[request.requester.channel] ?? request.requester.channel} · {shortId(request.requester.externalUserId)} · {request.audience === 'group' ? '群聊' : '私聊'} · {when(request.at)}</div>
                                            {request.text && <div className="channel-request-quote">“{request.text}”</div>}
                                        </div>
                                        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => { if (window.confirm('允许后，对方能查询本应用可以访问的全部数据。确定允许？')) void apply(() => decideChannelAccessViaRuntime(request.id, 'allow')); }}>允许</button>
                                        <button type="button" className="ui-btn ui-btn-sm" onClick={() => { void apply(() => decideChannelAccessViaRuntime(request.id, 'deny')); }}>拒绝</button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                    <div>
                        <h4 className="ui-subhead">可以使用的人</h4>
                        {access.members.length === 0 ? <p className="ui-empty">还没有人。先用上面的绑定码绑定你自己的 IM 账号。</p> : (
                            <table className="ui-table">
                                <thead><tr><th>平台</th><th>IM 账号</th><th>身份</th><th>开始时间</th><th aria-label="操作" /></tr></thead>
                                <tbody>
                                    {access.members.map((member) => (
                                        <tr key={`${member.actor.channel}|${member.actor.tenant}|${member.actor.externalUserId}`}>
                                            <td>{PLATFORM[member.actor.channel] ?? member.actor.channel}</td>
                                            <td className="ui-mono" title={member.actor.externalUserId}>{shortId(member.actor.externalUserId)}</td>
                                            <td><span className="ui-pill">{member.role === 'account' ? '账号成员' : '访客'}</span></td>
                                            <td>{when(member.since)}</td>
                                            <td className="ui-table-action">
                                                <button type="button" className="ui-btn ui-btn-quiet ui-btn-danger ui-btn-sm" onClick={() => { if (window.confirm('撤销后，对方再发消息需要重新申请。确定撤销？')) void apply(() => revokeChannelAccessViaRuntime(member.actor)); }}>撤销</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                    {failed && <div role="alert" className="ui-alert" data-tone="error">操作没有成功，请刷新后重试。</div>}
                </>
            )}
        </section>
    );
};

/** Settings page section for IM channels: scan to connect, see state, disconnect, link an account, decide who may use them. Credentials never reach the page. */
const ChannelsSettings: React.FC = () => {
    const [channels, setChannels] = useState<ChannelStatusView[]>();
    const [unavailable, setUnavailable] = useState(false);
    const [busy, setBusy] = useState<string>();

    const refresh = useCallback(async () => {
        try {
            setChannels(await listChannelsViaRuntime());
            setUnavailable(false);
        } catch {
            setUnavailable(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    const scanning = channels?.some((channel) => channel.state === 'provisioning') ?? false;
    useEffect(() => {
        if (!scanning) return;
        const timer = setInterval(() => { void refresh(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [scanning, refresh]);

    const run = async (channelId: string, action: (id: string) => Promise<ChannelStatusView[]>) => {
        setBusy(channelId);
        try {
            setChannels(await action(channelId));
        } catch {
            await refresh();
        } finally {
            setBusy(undefined);
        }
    };

    if (unavailable) {
        return <p className="ui-lead">当前运行方式没有启用消息渠道，或暂时无法读取渠道状态。</p>;
    }
    if (!channels) return <Loader2 size={20} className="legacy-animate-spin" />;

    return (
        <div className="settings-tab-content ui-stack ui-enter">
            <p className="ui-lead">接入后，可以在 IM 里直接向数据智能体提问、接收查询结果和看板。发送 <code className="ui-code">/new</code> 可随时开始新对话。</p>
            <LinkAccount />
            <AccessList />
            {channels.map((channel) => {
                const state = STATE_LABEL[channel.state];
                const working = busy === channel.id;
                return (
                    <section key={channel.id} aria-label={channel.label} className="ui-card ui-stack">
                        <div className="ui-card-head">
                            <h3 className="ui-card-title">{channel.label}<span className="ui-pill" data-tone={state.tone}>{state.text}</span></h3>
                            {channel.provisionable && (
                                <button type="button" className={channel.state === 'unconfigured' ? 'ui-btn ui-btn-primary' : 'ui-btn'} disabled={working} onClick={() => run(channel.id, provisionChannelViaRuntime)}>
                                    {working ? <Loader2 size={16} className="legacy-animate-spin" /> : null}
                                    {channel.state === 'unconfigured' ? '扫码接入' : '重新扫码'}
                                </button>
                            )}
                            {(channel.state === 'connected' || channel.state === 'failed') && (
                                <button type="button" className="ui-btn ui-btn-danger" disabled={working} onClick={() => { if (window.confirm(`断开${channel.label}？已保存的接入凭证会被删除。`)) void run(channel.id, disconnectChannelViaRuntime); }}>断开</button>
                            )}
                        </div>
                        {channel.provisioning && channel.state === 'provisioning' && <QrLink url={channel.provisioning.url} expiresAt={channel.provisioning.expiresAt} />}
                        {channel.message && <div role="alert" className="ui-alert" data-tone="error">{channel.message}</div>}
                        {channel.warnings?.map((warning) => (
                            <div key={warning} role="status" className="ui-alert" data-tone="warn">还差一步：{warning}</div>
                        ))}
                    </section>
                );
            })}
        </div>
    );
};

export default ChannelsSettings;
