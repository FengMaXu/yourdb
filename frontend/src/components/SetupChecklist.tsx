import React, { useState } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useReadiness, type ProbeResult, type StepState } from '../hooks/useReadiness';
import { cn } from '@/lib/utils';

const ACTION = 'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border [font:inherit] px-3 py-[7px] text-[0.82rem] transition-[background-color,border-color,color] disabled:cursor-not-allowed disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none';
const PRIMARY = `${ACTION} border-foreground bg-foreground text-white pointer-fine:enabled:hover:bg-foreground`;
const SECONDARY = `${ACTION} border-[rgba(120,53,15,0.14)] bg-white text-body pointer-fine:enabled:hover:border-[rgba(120,53,15,0.28)] pointer-fine:enabled:hover:text-foreground`;

function Mark({ state, index }: { state: StepState; index: number }) {
    if (state === 'ready') {
        return <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-success text-white"><Check size={14} strokeWidth={3} /></span>;
    }
    if (state === 'checking') {
        return <span className="inline-flex size-6 shrink-0 items-center justify-center text-faint"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /></span>;
    }
    return <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[rgba(120,53,15,0.24)] font-mono text-[0.72rem] text-brand">{index}</span>;
}

function Result({ result }: { result: ProbeResult | null }) {
    if (!result) return null;
    return (
        <p className={cn('m-0 text-[0.8rem] leading-[1.5] break-words', result.success ? 'text-success' : 'text-destructive')} role={result.success ? 'status' : 'alert'}>
            {result.message}
        </p>
    );
}

/** The two things a first question needs, each with the one action that completes it. */
export const SetupChecklist: React.FC = () => {
    const { t } = useLanguage();
    const readiness = useReadiness();
    const [modelResult, setModelResult] = useState<ProbeResult | null>(null);
    const [sampleResult, setSampleResult] = useState<ProbeResult | null>(null);
    const [busy, setBusy] = useState<'model' | 'sample' | null>(null);

    const testModel = async () => {
        setBusy('model');
        setModelResult(null);
        setModelResult(await readiness.testModel());
        setBusy(null);
    };
    const trySample = async () => {
        setBusy('sample');
        setSampleResult(null);
        const result = await readiness.connectSampleDatabase();
        // Success shows as the ticked step; only a failure needs words.
        setSampleResult(result.success ? null : result);
        setBusy(null);
    };

    const rows: Array<{ key: string; state: StepState; title: string; detail: string; body: React.ReactNode }> = [
        {
            key: 'model',
            state: readiness.model,
            title: t('setup.model.title'),
            detail: readiness.model === 'ready' ? t('setup.model.ready') : t('setup.model.missing'),
            body: (
                <>
                    <div className="flex flex-wrap gap-2">
                        {readiness.model === 'ready' ? (
                            <button type="button" className={SECONDARY} disabled={busy === 'model'} onClick={() => void testModel()}>
                                {busy === 'model' && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                                {t('setup.model.test')}
                            </button>
                        ) : readiness.model === 'missing' && (
                            <button type="button" className={PRIMARY} onClick={() => readiness.openSettings('model')}>{t('setup.model.configure')}</button>
                        )}
                    </div>
                    <Result result={modelResult} />
                </>
            ),
        },
        {
            key: 'database',
            state: readiness.database,
            title: t('setup.database.title'),
            detail: readiness.database === 'ready'
                ? t('setup.database.ready')
                : readiness.databaseProblem ? t('setup.database.failed') : t('setup.database.missing'),
            body: readiness.database === 'missing' && (
                <>
                    {readiness.databaseProblem && <p className="m-0 text-[0.8rem] leading-[1.5] break-words text-destructive">{readiness.databaseProblem}</p>}
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={PRIMARY} onClick={() => readiness.openSettings('database')}>{t('setup.database.connect')}</button>
                        <button type="button" className={SECONDARY} disabled={busy === 'sample'} onClick={() => void trySample()}>
                            {busy === 'sample' && <LoaderCircle size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                            {t('setup.database.sample')}
                        </button>
                    </div>
                    <Result result={sampleResult} />
                </>
            ),
        },
    ];

    return (
        <section className="flex flex-col gap-2.5" aria-labelledby="setup-checklist-title">
            <span className="font-mono text-[0.75rem] text-faint" aria-hidden="true">-- {t('setup.caption')}</span>
            <h2 id="setup-checklist-title" className="m-0 text-[clamp(1.5rem,2.4vw,1.95rem)] leading-[1.2] font-[650] tracking-[-0.02em] text-balance text-foreground">{t('setup.title')}</h2>
            <p className="m-0 text-[length:var(--font-size-body-sm)] leading-[1.65] text-pretty text-muted-foreground">{t('setup.hint')}</p>
            <ol className="m-0 mt-3 flex list-none flex-col gap-2.5 p-0">
                {rows.map((row, index) => (
                    <li key={row.key} className="flex items-start gap-3.5 rounded-xl border border-border bg-white px-[18px] py-4">
                        <Mark state={row.state} index={index + 1} />
                        <div className="flex min-w-0 flex-auto flex-col gap-2">
                            <div className="flex flex-col gap-0.5">
                                <span className="text-[0.925rem] font-semibold text-foreground">{row.title}</span>
                                <span className="text-[0.82rem] leading-[1.5] text-muted-foreground">{row.detail}</span>
                            </div>
                            {row.body}
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
};
