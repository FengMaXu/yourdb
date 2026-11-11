import React from 'react';
import { cn } from '@/lib/utils';

/** "Skip to content": off screen until it takes keyboard focus. */
export function SkipLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
    return (
        <a
            className={cn(
                'fixed top-2 left-2 z-[5000] -translate-y-[160%] rounded-lg bg-foreground px-3.5 py-2.5 font-bold text-white no-underline shadow-[0_8px_20px_rgba(28,25,23,0.24)] focus-visible:translate-y-0 focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-brand-bright',
                className,
            )}
            href={href}
        >
            {children}
        </a>
    );
}
