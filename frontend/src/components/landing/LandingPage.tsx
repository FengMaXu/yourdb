import React, { useEffect, useState } from 'react';
import {
    ArrowDown, ArrowRight, Check, CircleCheck, Database, Download, FileCode, FileSpreadsheet, FileText, Globe, Languages,
    LayoutDashboard, Library, ListChecks, Monitor, Paperclip, Puzzle, Search, Send, Smartphone, SquareCheck, X,
} from 'lucide-react';
import { BrandMark, BrandWordmark } from '../Brand';
import { SkipLink } from '../SkipLink';
import { InkBackdrop } from '../InkBackdrop';
import AgentOrbitIcon from '../AgentOrbitIcon';
import WidgetRenderer, { type WidgetSpec } from '../widgets/WidgetRenderer';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import { useLanguage } from '../../context/LanguageContext';

/*
 * yourdb is a desktop product, so "get started" always offers the installer; the web build of the
 * app is for development only and is never linked from here. The installer is attached to each
 * GitHub release; a mirror sets VITE_DOWNLOAD_URL and VITE_RELEASES_URL at build time.
 */
const DOWNLOAD_URL = (import.meta.env.VITE_DOWNLOAD_URL as string | undefined)?.trim()
    || 'https://github.com/FengMaXu/yourdb/releases/latest/download/yourdb-setup.exe';
const RELEASES_URL = (import.meta.env.VITE_RELEASES_URL as string | undefined)?.trim()
    || 'https://github.com/FengMaXu/yourdb/releases';
const APP_VERSION = import.meta.env.VITE_APP_VERSION as string;

const WRAP = 'mx-auto w-full max-w-[1200px] px-4 sm:px-6';

const CAPABILITIES = [
    { key: 'query', icon: Search },
    { key: 'export', icon: FileSpreadsheet },
    { key: 'report', icon: FileText },
    { key: 'dashboard', icon: LayoutDashboard },
];
const PERSONAS = ['ops', 'engineer', 'analyst', 'boss'];
const DEVICES = [
    { key: 'desktop', icon: Monitor },
    { key: 'web', icon: Globe },
    { key: 'mobile', icon: Smartphone },
];
const WHERE_POINTS = ['dashboard', 'clarify', 'new', 'access'];
const PROMISES = ['accurate', 'secure', 'easy'];
const PROMISE_POINTS: Record<string, string[]> = {
    accurate: ['acc.verify.title', 'acc.clarify.title', 'acc.disclose.title'],
    secure: ['secure.local.title', 'secure.mcp.title', 'secure.guard.title'],
    easy: DEVICES.map(({ key }) => `where.${key}`),
};
const FORMATS = ['png', 'chart', 'csv', 'md', 'html'];
const TRACKS = [
    { id: 'desktop', steps: ['launch', 'connect', 'ask', 'deliver'] },
    { id: 'mobile', steps: ['scan', 'bind', 'ask', 'receive'] },
];

/** The page's sections in reading order. The SQL keyword is the brand's voice, kept as a quiet tag. */
const SECTIONS = [
    { id: 'what', keyword: 'SELECT' },
    { id: 'who', keyword: 'FROM' },
    { id: 'where', keyword: 'WHERE' },
    { id: 'why', keyword: 'HAVING' },
    { id: 'how', keyword: 'ORDER BY' },
] as const;
type SectionId = typeof SECTIONS[number]['id'];

/*
 * The hero's worked example: one question and the answer the workbench gives it, drawn with the
 * workbench's own widgets. The figures add up: the categories sum to the total, and each change
 * is against last week's figure the total's +6.2% implies.
 */
const DEMO = {
    zh: {
        crumbs: ['任务', '经营分析', '华东区周报'],
        ask: '华东区本周销售额怎么样？按品类拆开看',
        running: '正在查询 sales_weekly',
        done: '查询了 sales_weekly，核对了口径',
        took: '8.2 秒',
        answer: '华东区本周销售额 1,284 万元，环比 +6.2%。电子产品贡献了约四分之三的增长，家居是唯一下滑的品类。',
        metricsTitle: '核心指标',
        metrics: [
            { label: '本周销售额', value: '1,284 万元', change: '环比 +6.2%' },
            { label: '增长最快', value: '电子产品', change: '环比 +13.4%' },
            { label: '唯一下滑', value: '家居', change: '环比 -1.2%' },
        ],
        tableTitle: '分品类明细',
        columns: ['品类', '销售额（万元）', '环比'],
        rows: [['电子产品', '486', '+13.4%'], ['服装', '312', '+4.0%'], ['食品饮料', '268', '+3.1%'], ['家居', '218', '-1.2%']],
        basis: '口径：sales_weekly.amount，含税，按下单时间统计。',
    },
    en: {
        crumbs: ['Tasks', 'Business review', 'East region weekly'],
        ask: 'How did the East region sell this week? Break it down by category',
        running: 'Querying sales_weekly',
        done: 'Queried sales_weekly and checked the definition',
        took: '8.2 s',
        answer: 'East region sales this week were ¥12.84M, up 6.2% on last week. Electronics drove about three quarters of the growth; home goods was the only category that fell.',
        metricsTitle: 'Key figures',
        metrics: [
            { label: 'Sales this week', value: '¥12.84M', change: '+6.2% week on week' },
            { label: 'Fastest growing', value: 'Electronics', change: '+13.4% week on week' },
            { label: 'Only decline', value: 'Home goods', change: '-1.2% week on week' },
        ],
        tableTitle: 'By category',
        columns: ['Category', 'Sales (¥10k)', 'Change'],
        rows: [['Electronics', '486', '+13.4%'], ['Apparel', '312', '+4.0%'], ['Food & drink', '268', '+3.1%'], ['Home goods', '218', '-1.2%']],
        basis: 'Definition: sales_weekly.amount, tax included, by order date.',
    },
};

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The answer builds up as it does in the workbench: question, working, answer, figures, table. */
const DEMO_STAGES = [0, 600, 2000, 2500, 3000];
const FINAL_STAGE = DEMO_STAGES.length - 1;

function useDemoStage(): number {
    const [stage, setStage] = useState(() => (prefersReducedMotion() ? FINAL_STAGE : 0));
    // The stages are scheduled once, from mount.
    useEffect(() => {
        if (prefersReducedMotion()) return;
        const timers = DEMO_STAGES.slice(1).map((at, index) => window.setTimeout(() => setStage(index + 1), at));
        return () => timers.forEach((timer) => window.clearTimeout(timer));
    }, []);
    return stage;
}

const RISE = 'animate-rise-sm motion-reduce:animate-none';

/** The workbench, answering one question: its rail, breadcrumb, the turn and the composer. */
const WorkbenchDemo: React.FC = () => {
    const { t, language } = useLanguage();
    const demo = DEMO[language === 'en' ? 'en' : 'zh'];
    const stage = useDemoStage();

    const metrics: WidgetSpec = { widget_id: 'demo-metrics', kind: 'metric_cards', title: demo.metricsTitle, data: demo.metrics };
    const table: WidgetSpec = {
        widget_id: 'demo-table',
        kind: 'table',
        title: demo.tableTitle,
        columns: demo.columns.map((label, index) => ({ key: `c${index}`, label })),
        data: demo.rows.map((row) => Object.fromEntries(row.map((cell, index) => [`c${index}`, cell]))),
    };
    const rail = [
        { label: t('sidebar.newTask'), icon: SquareCheck },
        { label: t('sidebar.currentTask'), icon: ListChecks, active: true },
        { label: t('sidebar.knowledge'), icon: Library },
        { label: t('sidebar.plugins'), icon: Puzzle },
    ];

    return (
        <figure className="m-0 rounded-[20px] bg-[var(--frame-backdrop)] p-1.5 shadow-[0_30px_80px_-40px_rgba(28,25,23,0.45)] sm:p-2.5">
            <figcaption className="sr-only">{t('landing.hero.demoLabel')}</figcaption>
            <div className="grid overflow-hidden rounded-xl bg-white ring-1 ring-foreground/5 md:grid-cols-[184px_minmax(0,1fr)]" aria-hidden="true">
                <aside className="hidden flex-col gap-1 border-r border-border bg-paper px-3 py-4 md:flex">
                    <span className="mb-4 px-2 text-[1.35rem] leading-none text-foreground"><BrandWordmark /></span>
                    {rail.map(({ label, icon: Icon, active }) => (
                        <span key={label} className={cn('flex items-center gap-2.5 rounded-md px-2 py-2 text-[0.85rem]', active ? 'font-semibold text-brand' : 'text-body')}>
                            <Icon size={16} />{label}
                        </span>
                    ))}
                </aside>
                <div className="flex min-w-0 flex-col">
                    <div className="flex h-12 items-center gap-2 border-b border-border px-4 text-[0.8rem] text-muted-foreground sm:px-5">
                        {demo.crumbs.map((crumb, index) => (
                            <React.Fragment key={crumb}>
                                {index > 0 && <span className="text-faint">/</span>}
                                <span className={cn('truncate', index === 0 && 'font-semibold text-foreground')}>{crumb}</span>
                            </React.Fragment>
                        ))}
                    </div>

                    <div className="mx-auto flex w-full max-w-[760px] min-h-[540px] flex-col gap-4 px-4 py-6 text-left sm:px-6">
                        <div className={cn('ml-auto max-w-[85%] rounded-[var(--bubble-radius)] bg-[var(--bubble-bg)] px-4 py-3 text-[0.95rem] leading-[1.6] text-foreground', RISE)}>
                            {demo.ask}
                        </div>

                        {stage >= 1 && (
                            <div className={cn('flex gap-3', RISE)}>
                                <AgentOrbitIcon size={28} animated={stage < 2} className="mt-0.5 flex-none" />
                                <div className="flex min-w-0 flex-1 flex-col gap-3">
                                    <Trace>
                                        <TraceLine status={stage < 2 ? 'running' : undefined}>
                                            <TraceIcon>{stage < 2 ? <Database /> : <CircleCheck className="text-success" />}</TraceIcon>
                                            <TraceTitle>{stage < 2 ? demo.running : demo.done}</TraceTitle>
                                            {stage >= 2 && <TraceDescription>{demo.took}</TraceDescription>}
                                        </TraceLine>
                                    </Trace>
                                    {stage >= 2 && <p className={cn('text-[0.95rem] leading-[1.75] text-foreground', RISE)}>{demo.answer}</p>}
                                    {stage >= 3 && <div className={RISE}><WidgetRenderer widget={metrics} /></div>}
                                    {stage >= 4 && (
                                        <div className={RISE}>
                                            <WidgetRenderer widget={table} />
                                            <p className="mt-2 text-xs text-muted-foreground">{demo.basis}</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="mx-3 mb-3 flex items-center gap-3 rounded-xl border border-border px-4 py-3 text-[0.85rem] text-muted-foreground sm:mx-5 sm:mb-5">
                        <Paperclip size={16} />
                        <span className="flex-1 truncate">{t('chat.placeholder')}</span>
                        <span className="grid size-8 place-items-center rounded-lg bg-muted text-faint"><Send size={15} /></span>
                    </div>
                </div>
            </div>
        </figure>
    );
};

/** A section's head: number and tag in mono (as the workbench's empty state does), then title and lead. */
const SectionHead: React.FC<{ id: SectionId; dark?: boolean; children?: React.ReactNode }> = ({ id, dark, children }) => {
    const { t } = useLanguage();
    const index = SECTIONS.findIndex((section) => section.id === id);
    return (
        <div className="max-w-[640px]">
            <p className="flex items-center gap-2 font-mono text-xs">
                <span className={dark ? 'text-brand-bright' : 'text-brand'}>0{index + 1}</span>
                <span className={dark ? 'text-muted-foreground' : 'text-faint'}>-- {SECTIONS[index].keyword} · {t(`landing.${id}.kicker`)}</span>
            </p>
            <h2 className={cn('mt-4 text-[clamp(1.9rem,3.6vw,2.75rem)] leading-[1.15] font-[650] tracking-[-0.02em] [font-feature-settings:"halt"]', dark ? 'text-white' : 'text-foreground')}>
                {children ?? t(`landing.${id}.title`)}
            </h2>
            <p className={cn('mt-4 text-[1.05rem] leading-relaxed', dark ? 'text-faint' : 'text-body')}>{t(`landing.${id}.desc`)}</p>
        </div>
    );
};

const Section: React.FC<{ id: SectionId; dark?: boolean; children: React.ReactNode }> = ({ id, dark, children }) => (
    <section
        id={id}
        className={cn('scroll-mt-16', dark ? 'relative isolate overflow-hidden bg-ink-panel text-ink-panel-foreground' : 'border-t border-border')}
    >
        {dark && <InkBackdrop glow="top-left" />}
        <div className={cn(WRAP, 'py-20 md:py-28')}>{children}</div>
    </section>
);

const Capabilities: React.FC = () => {
    const { t } = useLanguage();
    return (
        <Section id="what">
            <SectionHead id="what" />
            <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {CAPABILITIES.map(({ key, icon: Icon }) => (
                    <article key={key} className="flex flex-col gap-3 rounded-xl border border-border bg-white p-5 transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-[0_8px_24px_-18px_rgba(28,25,23,0.35)]">
                        <span className="grid size-9 place-items-center rounded-lg bg-brand-soft text-brand"><Icon size={18} /></span>
                        <h3 className="mt-1 text-lg font-semibold text-foreground">{t(`landing.cap.${key}.title`)}</h3>
                        <p className="text-sm leading-relaxed text-body">{t(`landing.cap.${key}.desc`)}</p>
                        <div className="mt-auto grid gap-2 pt-3">
                            <q className="rounded-[var(--bubble-radius)] bg-[var(--bubble-bg)] px-3 py-2 text-sm text-foreground before:content-none after:content-none">{t(`landing.cap.${key}.ask`)}</q>
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                <ArrowRight size={13} aria-hidden="true" />{t(`landing.cap.${key}.output`)}
                            </span>
                        </div>
                    </article>
                ))}
            </div>
        </Section>
    );
};

const Personas: React.FC = () => {
    const { t } = useLanguage();
    return (
        <Section id="who">
            <SectionHead id="who" />
            <div className="mt-12 overflow-hidden rounded-xl border border-border bg-white">
                <Table className="min-w-[560px]">
                    <TableHeader className="bg-paper">
                        <TableRow>
                            <TableHead className="w-[22%] px-5 font-mono text-xs font-normal text-muted-foreground">{t('landing.who.col.role')}</TableHead>
                            <TableHead className="w-[39%] px-5 font-mono text-xs font-normal text-muted-foreground">{t('landing.who.col.before')}</TableHead>
                            <TableHead className="px-5 font-mono text-xs font-normal text-muted-foreground">{t('landing.who.col.after')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {PERSONAS.map((key) => (
                            <TableRow key={key} className="hover:bg-transparent">
                                <TableHead scope="row" className="h-auto px-5 py-5 align-top text-base font-semibold whitespace-normal text-foreground">{t(`landing.who.${key}.name`)}</TableHead>
                                <TableCell className="px-5 py-5 align-top text-[0.95rem] leading-relaxed whitespace-normal text-faint line-through decoration-border-strong">{t(`landing.who.${key}.pain`)}</TableCell>
                                <TableCell className="px-5 py-5 align-top text-[0.95rem] leading-relaxed font-medium whitespace-normal text-foreground">{t(`landing.who.${key}.fix`)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </Section>
    );
};

const PHONE_BARS = [46, 70, 58, 84, 66, 100];

const Phone: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="mx-auto w-[300px] max-w-full flex-none rounded-[40px] border border-white/15 bg-white/5 p-2.5" role="img" aria-label={t('landing.phone.label')}>
            <div className="flex min-h-[560px] flex-col overflow-hidden rounded-[32px] bg-white text-foreground" aria-hidden="true">
                <div className="flex items-center gap-2 border-b border-border px-[18px] pt-5 pb-3.5">
                    <BrandMark className="h-5" />
                    <BrandWordmark className="h-3" />
                    <small className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="size-1.5 rounded-full bg-success" />{t('landing.phone.status')}
                    </small>
                </div>
                <div className="flex flex-1 flex-col gap-2.5 px-3.5 py-4 text-[13px] leading-relaxed">
                    <p className="max-w-[80%] self-end rounded-[var(--bubble-radius)] bg-[var(--bubble-bg)] px-3 py-2">{t('landing.phone.q1')}</p>
                    <p className="max-w-[90%]">{t('landing.phone.a1')}</p>
                    <div className="rounded-lg border border-border p-3">
                        <small className="mb-2 block text-[11px] text-muted-foreground">{t('landing.phone.chartTitle')}</small>
                        <span className="flex h-14 items-end gap-1">
                            {PHONE_BARS.map((height, index) => (
                                <i key={height} className={cn('flex-1 rounded-t-sm', index === PHONE_BARS.length - 1 ? 'bg-chart-1' : 'bg-border-strong')} style={{ height: `${height}%` }} />
                            ))}
                        </span>
                    </div>
                    <p className="flex items-center gap-2 self-start rounded-lg border border-border bg-paper px-3 py-2 font-mono text-[11px] text-body">
                        <FileCode size={14} className="text-brand" />east_weekly_sales.html
                    </p>
                    <p className="max-w-[80%] self-end rounded-[var(--bubble-radius)] bg-[var(--bubble-bg)] px-3 py-2">{t('landing.phone.q2')}</p>
                    <p className="max-w-[90%]">{t('landing.phone.a2')}</p>
                </div>
                <div className="mx-3 mb-3.5 rounded-full border border-border px-4 py-2.5 text-xs text-muted-foreground">{t('landing.phone.input')}</div>
            </div>
        </div>
    );
};

const Devices: React.FC = () => {
    const { t } = useLanguage();
    return (
        <Section id="where" dark>
            <div className="flex flex-wrap items-center gap-12">
                <div className="min-w-0 flex-[1_1_380px]">
                    <SectionHead id="where" dark />
                    <ul className="mt-8 flex flex-wrap gap-2">
                        {DEVICES.map(({ key, icon: Icon }) => (
                            <li key={key} className="flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-sm text-white">
                                <Icon size={15} className="text-brand-bright" />{t(`landing.where.${key}`)}
                            </li>
                        ))}
                    </ul>
                    <ul className="mt-8 grid gap-3 border-t border-white/10 pt-6">
                        {WHERE_POINTS.map((key) => (
                            <li key={key} className="flex gap-3 text-[0.95rem] leading-relaxed">
                                <Check size={17} className="mt-[3px] flex-none text-brand-bright" aria-hidden="true" />{t(`landing.where.point.${key}`)}
                            </li>
                        ))}
                    </ul>
                </div>
                <Phone />
            </div>
        </Section>
    );
};

const GUARD_LINES = [
    { sql: 'DROP TABLE orders;', ok: false },
    { sql: 'UPDATE users SET role = \'admin\';', ok: false },
    { sql: 'SELECT region, SUM(amount) FROM sales GROUP BY region;', ok: true },
];

const DEMO_ROW = 'flex items-baseline justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0';
const TAG = 'flex-none rounded-full px-2 py-0.5 font-sans text-[11px] font-medium whitespace-nowrap';

/** Each promise ends in a small console showing its mechanism at work. */
const PromiseDemo: React.FC<{ promise: string }> = ({ promise }) => {
    const { t } = useLanguage();
    const head = (text: string) => <div className={cn(DEMO_ROW, 'bg-white text-muted-foreground')}><code>{text}</code></div>;
    let rows: React.ReactNode;
    if (promise === 'accurate') {
        rows = (
            <>
                {head(`› ${t('landing.clarify.ask')}`)}
                <div className={DEMO_ROW}><span className="text-body">? {t('landing.clarify.question')}</span></div>
                <div className={cn(DEMO_ROW, 'bg-brand-soft text-foreground')}>
                    <span>● {t('landing.clarify.order')}</span>
                    <span className={cn(TAG, 'bg-white text-brand')}>✓ {t('landing.clarify.chosen')}</span>
                </div>
                <div className={cn(DEMO_ROW, 'text-faint')}><span>○ {t('landing.clarify.login')}</span></div>
            </>
        );
    } else if (promise === 'secure') {
        rows = (
            <>
                {head(`-- ${t('landing.secure.guard.title')}`)}
                {GUARD_LINES.map(({ sql, ok }) => (
                    <div key={sql} className={DEMO_ROW}>
                        <code className={cn('wrap-anywhere', ok ? 'text-foreground' : 'text-faint line-through')}>{sql}</code>
                        <span className={cn(TAG, ok ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive')}>
                            {ok ? `✓ ${t('landing.guard.allowed')}` : `✕ ${t('landing.guard.blocked')}`}
                        </span>
                    </div>
                ))}
            </>
        );
    } else {
        rows = (
            <>
                {head(`› ${t('landing.easy.ask')}`)}
                {FORMATS.map((format) => (
                    <div key={format} className={DEMO_ROW}>
                        <code className="font-semibold text-foreground">{format === 'chart' ? 'chart' : `.${format}`}</code>
                        <span className="font-sans text-muted-foreground">{t(`landing.easy.${format}`)}</span>
                    </div>
                ))}
            </>
        );
    }
    return <div className="mt-6 self-start overflow-hidden rounded-lg border border-border bg-paper font-mono text-xs" aria-hidden="true">{rows}</div>;
};

const Promises: React.FC = () => {
    const { t } = useLanguage();
    return (
        <Section id="why">
            <SectionHead id="why" />
            {/* Each promise spans four shared rows (title, text, points, console), so the three cards line up row by row. */}
            <div className="mt-12 grid gap-4 lg:grid-cols-3">
                {PROMISES.map((key, index) => (
                    <article key={key} className="grid content-start rounded-xl border border-border bg-white p-6 lg:row-span-4 lg:grid-rows-subgrid lg:gap-0">
                        <h3 className="flex items-baseline gap-3 text-2xl font-[650] text-foreground">
                            <span className="font-mono text-xs font-normal text-brand">0{index + 1}</span>{t(`landing.why.${key}.title`)}
                        </h3>
                        <p className="mt-3 text-sm leading-relaxed text-body">{t(`landing.why.${key}.desc`)}</p>
                        <ul className="mt-5 grid content-start gap-2.5">
                            {PROMISE_POINTS[key].map((point) => (
                                <li key={point} className="flex items-center gap-2.5 text-[0.95rem] font-medium text-foreground">
                                    <CircleCheck size={16} className="flex-none text-brand" aria-hidden="true" />{t(`landing.${point}`)}
                                </li>
                            ))}
                        </ul>
                        <PromiseDemo promise={key} />
                    </article>
                ))}
            </div>
        </Section>
    );
};

const Steps: React.FC = () => {
    const { t } = useLanguage();
    return (
        <Section id="how">
            <SectionHead id="how" />
            <div className="mt-12 grid gap-4 md:grid-cols-2">
                {TRACKS.map(({ id, steps }) => (
                    <div key={id} className="rounded-xl border border-border bg-white p-6">
                        <div className="flex items-baseline justify-between gap-3 border-b border-border pb-4">
                            <h3 className="text-lg font-semibold text-foreground">{t(`landing.how.${id}.title`)}</h3>
                            <span className="font-mono text-xs text-faint">-- {t(`landing.how.${id}.note`)}</span>
                        </div>
                        <ol className="mt-2 grid">
                            {steps.map((step, index) => (
                                <li key={step} className="flex gap-4 py-4">
                                    <span className="grid size-7 flex-none place-items-center rounded-full bg-brand-soft font-mono text-xs text-brand">{index + 1}</span>
                                    <div>
                                        <strong className="font-semibold text-foreground">{t(`landing.how.${id}.${step}.title`)}</strong>
                                        <p className="mt-1 text-sm leading-relaxed text-body">{t(`landing.how.${id}.${step}.desc`)}</p>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </div>
                ))}
            </div>
        </Section>
    );
};

const DownloadDialog: React.FC<{ open: boolean; onOpenChange: (open: boolean) => void }> = ({ open, onOpenChange }) => {
    const { t } = useLanguage();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="gap-0 p-6 sm:max-w-[440px]" showCloseButton={false}>
                <div className="flex items-center justify-between">
                    <p className="font-mono text-xs text-faint">-- yourdb v{APP_VERSION}</p>
                    <Button variant="ghost" size="icon-sm" aria-label={t('landing.download.close')} onClick={() => onOpenChange(false)}><X /></Button>
                </div>
                <DialogTitle className="mt-3 text-2xl leading-tight font-[650] text-foreground">{t('landing.download.title')}</DialogTitle>
                <DialogDescription className="mt-2 text-[0.95rem] leading-relaxed text-body">{t('landing.download.desc')}</DialogDescription>
                <ul className="mt-6 grid border-t border-border">
                    <li className="flex items-center justify-between gap-4 border-b border-border py-4">
                        <div className="grid gap-1">
                            <b className="text-base text-foreground">Windows</b>
                            <span className="font-mono text-xs text-muted-foreground">{t('landing.download.windowsReq')}</span>
                        </div>
                        <a className={cn(buttonVariants({ size: 'lg' }), 'h-10 gap-2 px-4')} href={DOWNLOAD_URL}>
                            <Download />{t('landing.download.action')}
                        </a>
                    </li>
                    <li className="flex items-center justify-between gap-4 border-b border-border py-4">
                        <b className="text-base text-foreground">macOS</b>
                        <Button variant="outline" size="lg" className="h-10 px-4" disabled>{t('landing.download.soon')}</Button>
                    </li>
                </ul>
                <a className="mt-5 font-mono text-xs text-muted-foreground hover:text-foreground" href={RELEASES_URL} target="_blank" rel="noreferrer">
                    {t('landing.download.releases')} ↗
                </a>
            </DialogContent>
        </Dialog>
    );
};

const LandingPage: React.FC = () => {
    const { t, language, toggleLanguage } = useLanguage();
    const [downloadOpen, setDownloadOpen] = useState(false);

    const getStarted = (className: string, children: React.ReactNode) => (
        <Button className={className} onClick={() => setDownloadOpen(true)}>{children}</Button>
    );

    return (
        <main className="h-dvh overflow-x-hidden overflow-y-auto scroll-smooth bg-background text-foreground motion-reduce:scroll-auto">
            <SkipLink href="#landing-content" className="not-focus-visible:shadow-none">{t('accessibility.skipToContent')}</SkipLink>

            <header className="sticky top-0 z-40 border-b border-border bg-white/85 backdrop-blur-md">
                <div className={cn(WRAP, 'flex h-16 items-center justify-between gap-4')}>
                    <a className="flex items-center gap-2 text-foreground" href="#landing-content" aria-label="yourdb">
                        <BrandMark className="h-6" />
                        <BrandWordmark className="h-[19px]" />
                    </a>
                    <nav className="hidden items-center gap-1 md:flex" aria-label={t('landing.nav.label')}>
                        {SECTIONS.filter(({ id }) => id !== 'where').map(({ id }) => (
                            <a key={id} href={`#${id}`} className="rounded-md px-3 py-2 text-sm text-body transition-colors hover:bg-muted hover:text-foreground">
                                {t(`landing.${id}.kicker`)}
                            </a>
                        ))}
                    </nav>
                    <div className="flex items-center gap-1.5">
                        <Button variant="ghost" className="h-9 gap-1.5 px-3 text-body" onClick={toggleLanguage}>
                            <Languages />{language === 'zh' ? 'EN' : '中文'}
                        </Button>
                        {getStarted('h-9 px-4', t('landing.enterApp'))}
                    </div>
                </div>
            </header>

            <section id="landing-content" className="relative">
                <div className={cn(WRAP, 'pt-16 pb-20 text-center md:pt-24 md:pb-28')}>
                    <p className="font-mono text-xs text-faint">-- {t('landing.hero.subtitle')}</p>
                    <h1 className="mx-auto mt-5 max-w-[16ch] text-[clamp(2.4rem,6vw,4.5rem)] leading-[1.05] font-bold tracking-[-0.04em] text-foreground">
                        Anytime, anywhere, it&apos;s <span className="text-brand">yourdb</span>.
                    </h1>
                    <p className="mx-auto mt-6 max-w-[640px] text-[1.1rem] leading-relaxed text-balance text-body">{t('landing.hero.lead')}</p>
                    <div className="mt-9 flex flex-wrap justify-center gap-3">
                        {getStarted('h-11 gap-2 px-5 text-[0.95rem]', <>{t('landing.hero.primary')}<ArrowRight /></>)}
                        <a href="#what" className={cn(buttonVariants({ variant: 'outline' }), 'h-11 gap-2 px-5 text-[0.95rem]')}>
                            {t('landing.hero.secondary')}<ArrowDown />
                        </a>
                    </div>
                    <div className="mt-14 md:mt-16"><WorkbenchDemo /></div>
                </div>
            </section>

            <Capabilities />
            <Personas />
            <Devices />
            <Promises />
            <Steps />

            <section className="relative isolate overflow-hidden bg-ink-panel text-ink-panel-foreground">
                <InkBackdrop />
                <div className={cn(WRAP, 'py-24 md:py-32')}>
                    <p className="font-mono text-xs text-muted-foreground">
                        <span className="text-brand-bright">LIMIT</span> 1; -- {t('landing.final.kicker')}
                    </p>
                    <h2 className="mt-6 max-w-[18ch] text-[clamp(2.2rem,5vw,4rem)] leading-[1.1] font-bold tracking-[-0.03em] text-white">{t('landing.final.title')}</h2>
                    <div className="mt-10 flex flex-wrap items-center justify-between gap-6">
                        <p className="text-lg text-faint">{t('landing.final.desc')}</p>
                        {getStarted('h-12 gap-2 bg-white px-6 text-base text-foreground hover:bg-white/90', <>{t('landing.hero.primary')}<ArrowRight /></>)}
                    </div>
                </div>
            </section>

            <footer className="border-t border-border">
                <div className={cn(WRAP, 'flex flex-wrap items-center justify-between gap-3 py-6 font-mono text-xs text-muted-foreground')}>
                    <a className="flex items-center gap-1.5 text-foreground" href="#landing-content" aria-label="yourdb">
                        <BrandMark className="h-[18px]" />
                        <BrandWordmark className="h-3.5" />
                    </a>
                    <span>Anytime, anywhere, it&apos;s yourdb.</span>
                    <span>© 2026</span>
                </div>
            </footer>

            <DownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} />
        </main>
    );
};

export default LandingPage;
