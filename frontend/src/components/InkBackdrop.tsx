import React from 'react';
import { cn } from '@/lib/utils';

/**
 * The ink panel's backdrop: a faint grid, like ruled paper for numbers, and a warm glow in a corner.
 * Shared by the sign-in panel and the landing page's dark bands; the parent sets bg-ink-panel and `relative isolate overflow-hidden`.
 */
export const InkBackdrop: React.FC<{ glow?: 'bottom-right' | 'top-left'; className?: string }> = ({ glow = 'bottom-right', className }) => (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 -z-10', className)}>
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] bg-size-[32px_32px] mask-[radial-gradient(ellipse_at_30%_40%,black_20%,transparent_75%)]" />
        <div
            className={cn(
                'absolute size-[520px] rounded-full bg-[radial-gradient(circle,rgba(234,88,12,0.32),transparent_65%)] blur-[10px]',
                glow === 'bottom-right' ? '-right-[180px] -bottom-[220px]' : '-top-[260px] -left-[200px]',
            )}
        />
    </div>
);
