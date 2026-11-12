import React from 'react';
import { ChevronRight, Database } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

/** The questions the sample answers well: both read its whole time range and every table it has. */
export const SAMPLE_QUESTIONS = ['trend', 'top'] as const;

/**
 * Shown on an empty chat while the built-in sample database is connected: what the data is, then
 * questions it can answer. Picking one puts it in the composer, as the general starters do.
 */
export const SampleDatabaseIntro: React.FC<{ onPick: (question: string) => void }> = ({ onPick }) => {
    const { t } = useLanguage();
    return (
        <section className="mt-[22px] flex animate-rise-sm flex-col gap-4 rounded-xl border border-border bg-white p-5 motion-reduce:animate-none" aria-labelledby="sample-intro-title">
            <div className="flex items-start gap-3">
                <span className="grid size-9 flex-none place-items-center rounded-lg bg-brand-soft text-brand" aria-hidden="true"><Database size={18} /></span>
                <div className="grid min-w-0 gap-1">
                    <h3 id="sample-intro-title" className="m-0 text-[0.975rem] font-[650] text-foreground">{t('sample.title')}</h3>
                    <p className="m-0 text-[0.875rem] leading-[1.65] text-body">{t('sample.description')}</p>
                </div>
            </div>
            <div className="grid gap-2 border-t border-border pt-4">
                <span className="text-[0.75rem] font-semibold text-muted-foreground">{t('sample.tryAsking')}</span>
                {SAMPLE_QUESTIONS.map((key, index) => (
                    <button
                        key={key}
                        type="button"
                        className="group/sample flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-paper px-3.5 py-3 text-left [font:inherit] transition-[border-color,background-color] hover:border-border-strong hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                        onClick={() => onPick(t(`sample.question.${key}`))}
                    >
                        <span className="font-mono text-[0.7rem] text-brand" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                        <span className="flex-1 text-[0.925rem] leading-[1.55] text-foreground">{t(`sample.question.${key}`)}</span>
                        <ChevronRight size={16} className="flex-none text-faint transition-colors group-hover/sample:text-foreground" aria-hidden="true" />
                    </button>
                ))}
            </div>
        </section>
    );
};
