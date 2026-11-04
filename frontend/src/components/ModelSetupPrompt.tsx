import React from 'react';
import { KeyRound } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';

/** The runtime refuses to start an agent session without a model profile. */
export function isModelNotConfiguredError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('LLM_NOT_CONFIGURED');
}

export interface SetupPromptProps {
    /** Steps still missing, model and database. */
    remaining: number;
    /** What the first missing step is, so the hint names it. */
    next: 'model' | 'database';
    onConfigure: () => void;
}

/** A thin amber strip above the workspace while setup is unfinished. */
export const SetupPrompt: React.FC<SetupPromptProps> = ({ remaining, next, onConfigure }) => {
    const { t } = useLanguage();
    return (
        <div className="flex min-h-[38px] flex-none items-center justify-between gap-3.5 border-b border-[rgba(180,83,9,0.14)] bg-[rgba(255,251,235,0.9)] px-[18px] py-[7px] text-[0.8rem] text-[#7c2d12] max-[720px]:flex-wrap max-[720px]:items-start max-[720px]:gap-x-2.5 max-[720px]:gap-y-[7px] max-[720px]:px-3" role="status">
            <div className="inline-flex min-w-0 items-center gap-2 overflow-hidden max-[720px]:flex-[1_1_100%] max-[720px]:flex-wrap [&>span]:whitespace-nowrap">
                <KeyRound size={17} aria-hidden="true" />
                <strong>{t('setup.remaining').replace('{count}', String(remaining))}</strong>
                <span className="truncate text-current opacity-72 max-[720px]:max-w-full max-[720px]:basis-full max-[720px]:pl-[25px] max-[720px]:whitespace-normal">{t(`setup.next.${next}`)}</span>
            </div>
            <button type="button" className="inline-flex min-w-0 flex-none cursor-pointer items-center gap-1.5 rounded-[7px] border border-current bg-transparent px-[9px] py-[5px] text-inherit" onClick={onConfigure}>
                <span>{t(`setup.action.${next}`)}</span>
            </button>
        </div>
    );
};
