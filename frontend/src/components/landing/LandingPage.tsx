import React, { useCallback, useEffect, useRef, useState } from 'react';
// The landing page's own faces, self-hosted (fontsource): Google Fonts is often unreachable from mainland China.
import '@fontsource-variable/inter/opsz.css';
import '@fontsource-variable/noto-serif-sc';
import { ArrowRight, Download, Languages, X } from '../icons/Typicons';
import { BrandMark, BrandWordmark } from '../Brand';
import { SkipLink } from '../SkipLink';
import { useLanguage } from '../../context/LanguageContext';
import './landing-entry.css';

/** Where the "enter app" buttons go when there is no download panel: the bundled /app, or VITE_APP_URL. */
const APP_URL = (import.meta.env.VITE_APP_URL as string | undefined)?.trim() || '/app';
/** A landing-only build (.env.landing) has no app to enter, so "get started" offers the desktop installer instead. */
const DOWNLOAD_URL = (import.meta.env.VITE_DOWNLOAD_URL as string | undefined)?.trim();
const RELEASES_URL = (import.meta.env.VITE_RELEASES_URL as string | undefined)?.trim();
const APP_VERSION = import.meta.env.VITE_APP_VERSION as string;

const CAPABILITIES = ['query', 'export', 'report', 'dashboard'];
const PERSONAS = ['ops', 'engineer', 'analyst', 'boss'];
const DEVICES = ['desktop', 'web', 'mobile'];
const WHERE_POINTS = ['dashboard', 'clarify', 'new', 'access'];
const PROMISES = ['accurate', 'secure', 'easy'];
const PROMISE_POINTS: Record<string, string[]> = {
    accurate: ['acc.verify.title', 'acc.clarify.title', 'acc.disclose.title'],
    secure: ['secure.local.title', 'secure.mcp.title', 'secure.guard.title'],
    easy: DEVICES.map((key) => `where.${key}`),
};
const FORMATS = ['png', 'chart', 'csv', 'md', 'html'];
const DESKTOP_STEPS = ['launch', 'connect', 'ask', 'deliver'];
const MOBILE_STEPS = ['scan', 'bind', 'ask', 'receive'];

/**
 * The page is one read-only query: each clause is a section, in SQL clause order.
 * `section` is the clause's copy prefix (landing.<section>.*); `rows` is what the clause returns.
 */
const CLAUSES = [
    { id: 'select', keyword: 'SELECT', section: 'what', rows: CAPABILITIES.length },
    { id: 'from', keyword: 'FROM', section: 'who', rows: PERSONAS.length },
    { id: 'where', keyword: 'WHERE', section: 'where', rows: DEVICES.length },
    { id: 'having', keyword: 'HAVING', section: 'why', rows: PROMISES.length },
    { id: 'order', keyword: 'ORDER BY', section: 'how', rows: DESKTOP_STEPS.length + MOBILE_STEPS.length },
    { id: 'limit', keyword: 'LIMIT', section: 'final', rows: 1 },
];
const TOTAL_ROWS = CLAUSES.reduce((sum, clause) => sum + clause.rows, 0);
const STEP_MS = 650;
const RAN_KEY = 'yourdb.landing.ran';

const rowsLabel = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`;

function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function hasRunBefore(): boolean {
    try {
        return window.localStorage.getItem(RAN_KEY) === '1';
    } catch {
        return false;
    }
}

type Phase = 'idle' | 'running' | 'done';

/**
 * Runs the page's query one clause at a time. A returning visitor, or one who prefers
 * reduced motion, gets the finished result straight away.
 */
function useQueryRun() {
    const [state, setState] = useState<{ phase: Phase; step: number }>(() => (
        prefersReducedMotion() || hasRunBefore()
            ? { phase: 'done', step: CLAUSES.length }
            : { phase: 'idle', step: 0 }
    ));

    useEffect(() => {
        if (state.phase !== 'running') return;
        const timer = window.setTimeout(() => {
            setState(({ step }) => (step + 1 >= CLAUSES.length
                ? { phase: 'done', step: CLAUSES.length }
                : { phase: 'running', step: step + 1 }));
        }, STEP_MS);
        return () => window.clearTimeout(timer);
    }, [state]);

    useEffect(() => {
        if (state.phase !== 'done') return;
        try {
            window.localStorage.setItem(RAN_KEY, '1');
        } catch {
            // Storage blocked: the visitor just sees the run again next time.
        }
    }, [state.phase]);

    const run = useCallback(() => {
        setState(prefersReducedMotion()
            ? { phase: 'done', step: CLAUSES.length }
            : { phase: 'running', step: 0 });
    }, []);
    const finish = useCallback(() => setState({ phase: 'done', step: CLAUSES.length }), []);
    return { ...state, run, finish };
}

const ClauseSide: React.FC<{ index: number }> = ({ index }) => {
    const { t } = useLanguage();
    const clause = CLAUSES[index];
    return (
        <div className="lp-clause-side">
            <span className="lp-clause-kw">{clause.keyword}</span>
            <span className="lp-clause-kicker">{t(`landing.${clause.section}.kicker`)}</span>
            <span className="lp-clause-rows">✓ {rowsLabel(clause.rows)}</span>
        </div>
    );
};

const ClauseHead: React.FC<{ section: string }> = ({ section }) => {
    const { t } = useLanguage();
    return (
        <>
            <h2>{t(`landing.${section}.title`)}</h2>
            <p className="lp-lead">{t(`landing.${section}.desc`)}</p>
        </>
    );
};

const SelectBody: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="lp-caps">
            {CAPABILITIES.map((cap, index) => (
                <article key={cap} className="lp-cap">
                    <span className="lp-mono-note">col_{index + 1}</span>
                    <h3>{t(`landing.cap.${cap}.title`)}</h3>
                    <p>{t(`landing.cap.${cap}.desc`)}</p>
                    <div className="lp-cap-io">
                        <q>{t(`landing.cap.${cap}.ask`)}</q>
                        <span><span aria-hidden="true">→ </span>{t(`landing.cap.${cap}.output`)}</span>
                    </div>
                </article>
            ))}
        </div>
    );
};

const FromBody: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="lp-table-wrap">
            <table className="lp-personas">
                <thead>
                    <tr><th scope="col">role</th><th scope="col">before</th><th scope="col">with yourdb</th></tr>
                </thead>
                <tbody>
                    {PERSONAS.map((key) => (
                        <tr key={key}>
                            <th scope="row">{t(`landing.who.${key}.name`)}</th>
                            <td className="lp-before">{t(`landing.who.${key}.pain`)}</td>
                            <td>{t(`landing.who.${key}.fix`)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

const PHONE_BARS = [46, 70, 58, 84, 66, 100];

const Phone: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="lp-phone" role="img" aria-label={t('landing.phone.label')}>
            <div className="lp-phone-screen" aria-hidden="true">
                <div className="lp-phone-head">
                    <BrandMark />
                    <BrandWordmark />
                    <small>{t('landing.phone.status')}</small>
                </div>
                <div className="lp-phone-chat">
                    <p className="is-user">{t('landing.phone.q1')}</p>
                    <p>{t('landing.phone.a1')}</p>
                    <div className="lp-phone-card">
                        <small>{t('landing.phone.chartTitle')}</small>
                        <span className="lp-bars">{PHONE_BARS.map((h) => <i key={h} style={{ height: `${h}%` }} />)}</span>
                    </div>
                    <p className="is-file"><b>HTML</b> east_weekly_sales.html</p>
                    <p className="is-user">{t('landing.phone.q2')}</p>
                    <p>{t('landing.phone.a2')}</p>
                </div>
                <div className="lp-phone-input">{t('landing.phone.input')}</div>
            </div>
        </div>
    );
};

const WhereBody: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="lp-where">
            <div className="lp-where-copy">
                <ClauseHead section="where" />
                <p className="lp-where-in">
                    device <b>IN</b> ({DEVICES.map((key, index) => (
                        <React.Fragment key={key}>{index > 0 && ', '}<u>{t(`landing.where.${key}`)}</u></React.Fragment>
                    ))})
                </p>
                <ul className="lp-and">
                    {WHERE_POINTS.map((key) => (
                        <li key={key}><span aria-hidden="true">AND</span>{t(`landing.where.point.${key}`)}</li>
                    ))}
                </ul>
            </div>
            <Phone />
        </div>
    );
};

const GUARD_LINES = [
    { sql: 'DROP TABLE orders;', ok: false },
    { sql: 'UPDATE users SET role = \'admin\';', ok: false },
    { sql: 'SELECT region, SUM(amount) FROM sales GROUP BY region;', ok: true },
];

/** Each promise ends in a small console showing its mechanism at work; one row is the outcome. */
const PromiseDemo: React.FC<{ promise: string }> = ({ promise }) => {
    const { t } = useLanguage();
    if (promise === 'accurate') {
        return (
            <div className="lp-demo" aria-hidden="true">
                <div className="is-head"><code>› {t('landing.clarify.ask')}</code></div>
                <div><span>? {t('landing.clarify.question')}</span></div>
                <div className="is-ok"><span>● {t('landing.clarify.order')}</span><b>✓ {t('landing.clarify.chosen')}</b></div>
                <div className="is-no"><span>○ {t('landing.clarify.login')}</span></div>
            </div>
        );
    }
    if (promise === 'secure') {
        return (
            <div className="lp-demo" aria-hidden="true">
                <div className="is-head"><code>-- {t('landing.secure.guard.title')}</code></div>
                {GUARD_LINES.map(({ sql, ok }) => (
                    <div key={sql} className={ok ? 'is-ok' : 'is-no is-struck'}>
                        <code>{sql}</code>
                        <b>{ok ? `✓ ${t('landing.guard.allowed')}` : `✕ ${t('landing.guard.blocked')}`}</b>
                    </div>
                ))}
            </div>
        );
    }
    return (
        <div className="lp-demo" aria-hidden="true">
            <div className="is-head"><code>› {t('landing.easy.ask')}</code></div>
            {FORMATS.map((format) => (
                <div key={format}>
                    <code className="lp-demo-tag">{format === 'chart' ? 'chart' : `.${format}`}</code>
                    <span className="lp-muted">{t(`landing.easy.${format}`)}</span>
                </div>
            ))}
        </div>
    );
};

const HavingBody: React.FC = () => {
    const { t } = useLanguage();
    return (
        <>
            <h2>
                {PROMISES.map((key, index) => (
                    <React.Fragment key={key}>
                        {index > 0 && <span className="lp-and-word"> AND </span>}
                        {t(`landing.why.${key}.title`)}
                    </React.Fragment>
                ))}
            </h2>
            <p className="lp-lead">{t('landing.why.desc')}</p>
            <div className="lp-promises">
                {PROMISES.map((key) => (
                    <article key={key} className="lp-promise">
                        <h3>{t(`landing.why.${key}.title`)}</h3>
                        <p>{t(`landing.why.${key}.desc`)}</p>
                        <ul>
                            {PROMISE_POINTS[key].map((point) => <li key={point}>{t(`landing.${point}`)}</li>)}
                        </ul>
                        <PromiseDemo promise={key} />
                    </article>
                ))}
            </div>
        </>
    );
};

const OrderBody: React.FC = () => {
    const { t } = useLanguage();
    return (
        <div className="lp-tracks">
            {[
                { id: 'desktop', steps: DESKTOP_STEPS },
                { id: 'mobile', steps: MOBILE_STEPS },
            ].map(({ id, steps }) => (
                <div key={id} className="lp-track">
                    <div className="lp-track-head">
                        <h3>{t(`landing.how.${id}.title`)}</h3>
                        <span>-- {t(`landing.how.${id}.note`)}</span>
                    </div>
                    <ol>
                        {steps.map((step, index) => (
                            <li key={step}>
                                <span className="lp-mono-note">0{index + 1}</span>
                                <div>
                                    <strong>{t(`landing.how.${id}.${step}.title`)}</strong>
                                    <p>{t(`landing.how.${id}.${step}.desc`)}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </div>
            ))}
        </div>
    );
};

const CLAUSE_BODIES: Record<string, React.ReactNode> = {
    select: <><ClauseHead section="what" /><SelectBody /></>,
    from: <><ClauseHead section="who" /><FromBody /></>,
    where: <WhereBody />,
    having: <HavingBody />,
    order: <><ClauseHead section="how" /><OrderBody /></>,
};

const DownloadDialog: React.FC<{ dialogRef: React.RefObject<HTMLDialogElement | null> }> = ({ dialogRef }) => {
    const { t } = useLanguage();
    return (
        <dialog
            ref={dialogRef}
            className="lp-download"
            aria-labelledby="lp-download-title"
            // The body fills the dialog, so a click landing on the dialog itself is on the backdrop.
            onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}
        >
            <div className="lp-download-body">
                <div className="lp-download-head">
                    <p className="lp-mono-note">-- yourdb v{APP_VERSION}</p>
                    <button className="lp-btn lp-btn-quiet lp-download-close" type="button" aria-label={t('landing.download.close')} onClick={() => dialogRef.current?.close()}>
                        <X size={18} />
                    </button>
                </div>
                <h2 id="lp-download-title">{t('landing.download.title')}</h2>
                <p className="lp-download-desc">{t('landing.download.desc')}</p>
                <ul className="lp-download-list">
                    <li>
                        <div>
                            <b>Windows</b>
                            <span className="lp-mono-note">{t('landing.download.windowsReq')}</span>
                        </div>
                        <a className="lp-btn lp-btn-solid" href={DOWNLOAD_URL}>
                            <Download size={16} />
                            <span>{t('landing.download.action')}</span>
                        </a>
                    </li>
                    <li>
                        <div>
                            <b>macOS</b>
                        </div>
                        <button className="lp-btn lp-btn-line" type="button" disabled>{t('landing.download.soon')}</button>
                    </li>
                </ul>
                {RELEASES_URL && (
                    <a className="lp-download-more" href={RELEASES_URL} target="_blank" rel="noreferrer">{t('landing.download.releases')} ↗</a>
                )}
            </div>
        </dialog>
    );
};

const LandingPage: React.FC = () => {
    const { t, language, toggleLanguage } = useLanguage();
    const { phase, step, run, finish } = useQueryRun();
    const resultRef = useRef<HTMLDivElement>(null);
    const [pendingScroll, setPendingScroll] = useState<string | null>(null);
    const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
    const downloadRef = useRef<HTMLDialogElement>(null);

    const getStarted = (className: string, children: React.ReactNode) => (DOWNLOAD_URL
        ? <button className={className} type="button" onClick={() => downloadRef.current?.showModal()}>{children}</button>
        : <a className={className} href={APP_URL}>{children}</a>);

    // Scrolling down to the results counts as running the query.
    useEffect(() => {
        const node = resultRef.current;
        if (phase !== 'idle' || !node || typeof IntersectionObserver === 'undefined') return;
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) run();
        }, { threshold: 1 });
        observer.observe(node);
        return () => observer.disconnect();
    }, [phase, run]);

    // ⌘/Ctrl + Enter runs it, as in a SQL editor.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && phase !== 'running') {
                event.preventDefault();
                run();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [phase, run]);

    // A folded row opens the whole result, then brings its own section into view.
    useEffect(() => {
        if (!pendingScroll || phase !== 'done') return;
        document.getElementById(pendingScroll)?.scrollIntoView({ block: 'start' });
        setPendingScroll(null);
    }, [pendingScroll, phase]);

    const isOpen = (index: number) => phase === 'done' || (phase === 'running' && index < step);
    const lineStatus = (index: number) => {
        if (phase === 'done' || (phase === 'running' && index < step)) return `✓ ${rowsLabel(CLAUSES[index].rows)}`;
        if (phase === 'running' && index === step) return `▸ ${t('landing.query.executing')}`;
        return '';
    };
    const lineState = (index: number) => (phase !== 'running' ? '' : index === step ? 'is-current' : index > step ? 'is-pending' : '');

    const editorStatus = phase === 'idle' ? t('landing.query.ready')
        : phase === 'running' ? `${t('landing.query.executing')} ${step}/${CLAUSES.length}`
            : `${t('landing.query.done')} · ${rowsLabel(TOTAL_ROWS)}`;
    const resultStatus = phase === 'idle' ? t('landing.result.idle')
        : phase === 'running' ? `${step} / ${CLAUSES.length} clauses`
            : `${CLAUSES.length} clauses · ${rowsLabel(TOTAL_ROWS)}`;

    return (
        <main className="lp">
            <SkipLink href="#landing-content" className="not-focus-visible:shadow-none">{t('accessibility.skipToContent')}</SkipLink>

            <header className="lp-nav">
                <div className="lp-wrap lp-nav-inner">
                    <a className="lp-logo" href="#landing-content" aria-label="yourdb">
                        <BrandMark />
                        <BrandWordmark />
                    </a>
                    <div className="lp-nav-actions">
                        <button className="lp-btn lp-btn-quiet" type="button" onClick={toggleLanguage}>
                            <Languages size={15} />
                            <span>{language === 'zh' ? 'EN' : '中文'}</span>
                        </button>
                        {getStarted('lp-btn lp-btn-solid', t('landing.enterApp'))}
                    </div>
                </div>
            </header>

            <section id="landing-content" className="lp-hero">
                <div className="lp-wrap">
                    <div className="lp-hero-head">
                        <h1>Anytime, anywhere,<br />it&apos;s yourdb.</h1>
                        <p className="lp-hero-sub">{t('landing.hero.subtitle')}</p>
                        <p className="lp-hero-lead">{t('landing.hero.lead')}</p>
                    </div>

                    <div className="lp-editor">
                        <div className="lp-editor-bar">
                            <span>yourdb.sql <span className="lp-muted">· {t('landing.query.readonly')}</span></span>
                            <div className="lp-editor-actions">
                                <span className="lp-muted" aria-live="polite">{editorStatus}</span>
                                {phase === 'idle' && (
                                    <button className="lp-btn lp-btn-solid lp-btn-run" type="button" onClick={run}>
                                        <span aria-hidden="true" className="lp-run-icon">▶</span>
                                        {t('landing.query.run')}
                                        <kbd>{isMac ? '⌘↵' : 'Ctrl ↵'}</kbd>
                                    </button>
                                )}
                                {phase === 'running' && (
                                    <button className="lp-btn lp-btn-line lp-btn-run" type="button" disabled>{t('landing.query.running')}</button>
                                )}
                                {phase === 'done' && (
                                    <button className="lp-btn lp-btn-line lp-btn-run" type="button" onClick={run}>↻ {t('landing.query.rerun')}</button>
                                )}
                            </div>
                        </div>
                        <ol className="lp-editor-lines" aria-label={t('landing.query.label')}>
                            {CLAUSES.map((clause, index) => (
                                <li key={clause.id} className={lineState(index)}>
                                    <span className="lp-line-no" aria-hidden="true">{index + 1}</span>
                                    <a href={`#${clause.id}`} onClick={(event) => {
                                        if (phase === 'done') return;
                                        event.preventDefault();
                                        finish();
                                        setPendingScroll(clause.id);
                                    }}>
                                        <b>{clause.keyword}</b> {t(`landing.query.arg.${clause.id}`)}
                                    </a>
                                    <span className="lp-line-status">{lineStatus(index)}</span>
                                </li>
                            ))}
                        </ol>
                    </div>

                    <div className="lp-hero-foot">
                        <span>-- {t('landing.query.hint')}<i className="lp-caret" aria-hidden="true" /></span>
                        <a href="#select" onClick={(event) => {
                            event.preventDefault();
                            resultRef.current?.scrollIntoView({ block: 'start' });
                        }}>{t('landing.query.browse')} ↓</a>
                    </div>
                </div>
            </section>

            <div className="lp-result-bar" ref={resultRef}>
                <div className="lp-wrap">
                    <span>-- result set</span>
                    <span>{resultStatus}</span>
                </div>
            </div>

            {CLAUSES.map((clause, index) => {
                const open = isOpen(index);
                const dark = open && (clause.id === 'where' || clause.id === 'limit');
                return (
                    <section key={clause.id} id={clause.id} className={`lp-clause${dark ? ' is-dark' : ''}`}>
                        {!open && (
                            <button type="button" className="lp-wrap lp-clause-row" onClick={() => {
                                finish();
                                setPendingScroll(clause.id);
                            }}>
                                <span className="lp-clause-kw">{clause.keyword}{clause.id === 'limit' ? ' 1' : ''}</span>
                                <span className="lp-clause-title">{t(`landing.${clause.section}.title`)}</span>
                                <span className="lp-mono-note">
                                    {phase === 'running' && index === step ? `${t('landing.query.executing')}…` : `-- ${t('landing.query.pending')}`}
                                </span>
                            </button>
                        )}
                        {open && clause.id !== 'limit' && (
                            <div className="lp-wrap lp-clause-body lp-unfold">
                                <ClauseSide index={index} />
                                <div className="lp-clause-main">{CLAUSE_BODIES[clause.id]}</div>
                            </div>
                        )}
                        {open && clause.id === 'limit' && (
                            <div className="lp-wrap lp-final lp-unfold">
                                <p className="lp-mono-note"><b>LIMIT</b> 1;  -- ✓ {rowsLabel(1)} · {t('landing.final.kicker')}</p>
                                <h2>{t('landing.final.title')}</h2>
                                <div className="lp-final-foot">
                                    <p>{t('landing.final.desc')}</p>
                                    {getStarted('lp-btn lp-btn-invert lp-btn-lg', <>
                                        <span>{t('landing.hero.primary')}</span>
                                        <ArrowRight size={16} />
                                    </>)}
                                </div>
                            </div>
                        )}
                    </section>
                );
            })}

            <footer className="lp-footer">
                <div className="lp-wrap">
                    <a className="lp-logo lp-logo-sm" href="#landing-content" aria-label="yourdb">
                        <BrandMark />
                        <BrandWordmark />
                    </a>
                    <span>Anytime, anywhere, it&apos;s yourdb.</span>
                    <span>© 2026</span>
                </div>
            </footer>

            {DOWNLOAD_URL && <DownloadDialog dialogRef={downloadRef} />}
        </main>
    );
};

export default LandingPage;
