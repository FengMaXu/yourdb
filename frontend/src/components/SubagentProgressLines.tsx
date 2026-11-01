import React, { useEffect, useState } from 'react';
import type { SubagentChildProgress } from '@data-agent/contracts';
import { useLanguage } from '../context/LanguageContext';
import { formatSubagentLine } from './subagent-progress';

/** One line per delegated child under the `subagent` tool hint; running rows tick every second. */
const SubagentProgressLines: React.FC<{ progress: SubagentChildProgress[] }> = ({ progress }) => {
    const { t } = useLanguage();
    const [now, setNow] = useState(() => Date.now());
    const running = progress.some((child) => child.endedAt === undefined);

    useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);

    if (progress.length === 0) return null;
    return (
        <>
            {progress.map((child) => {
                const line = formatSubagentLine(child, now, t);
                return (
                    <div
                        key={child.key}
                        className={`flex min-w-0 items-center gap-2 border-0 bg-transparent p-0 pl-[21px] text-left text-[length:var(--agent-detail-font-size)] leading-[1.58] [font-family:inherit] ${child.output === 'none' ? 'text-[var(--status-error)]' : 'text-[var(--text-tertiary)]'}`}
                        title={line}
                    >
                        <span className={`size-[5px] shrink-0 rounded-full bg-current ${child.output === 'none' ? 'opacity-100' : 'opacity-60'}`} aria-hidden="true" />
                        <span className="min-w-0 truncate whitespace-pre">{line}</span>
                    </div>
                );
            })}
        </>
    );
};

export default SubagentProgressLines;
