import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Inputs on the MCP pages: 40px, the stone hairline, the brand focus ring. */
export const MCP_INPUT = 'h-10 rounded-[10px] border-input bg-white px-3 text-sm text-foreground md:text-sm placeholder:text-[#a8a29e] hover:border-[#d6d3d1] focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15';
export const MCP_CODE = 'font-mono text-[0.8rem] md:text-[0.8rem]';
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand focus-visible:ring-0 focus-visible:border-transparent';

/** A footer or card action: outlined, or ink for the primary one; shows a spinner while busy. */
export function McpButton({ primary = false, busy = false, className, children, ...props }: React.ComponentProps<typeof Button> & { primary?: boolean; busy?: boolean }) {
    return (
        <Button
            variant={primary ? 'default' : 'outline'}
            className={cn(
                'h-[34px] gap-1.5 rounded-[9px] px-4 text-[0.85rem] font-semibold active:not-disabled:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-55',
                primary
                    ? 'border-foreground bg-foreground text-white shadow-[0_1px_2px_rgba(28,25,23,0.2),inset_0_1px_0_rgba(255,255,255,0.08)] hover:border-[#292524] hover:bg-[#292524]'
                    : 'border-input bg-white text-foreground shadow-[0_1px_1px_rgba(28,25,23,0.03)] hover:border-[#d6d3d1] hover:bg-[#fafaf9]',
                FOCUS,
                className,
            )}
            {...props}
        >
            {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
            {children}
        </Button>
    );
}

/** A status pill: a dot and a label in the status colours; a live one's dot breathes. */
export function McpStatus({ label, fg, bg, live }: { label: string; fg: string; bg: string; live?: boolean }) {
    return (
        <span className="inline-flex h-5 items-center gap-[5px] rounded-full px-2 text-[0.72rem] leading-none font-[550] whitespace-nowrap" style={{ color: fg, background: bg }}>
            <span className={cn('size-[5px] flex-none rounded-full bg-current', live && 'animate-ring-pulse')} aria-hidden="true" />
            {label}
        </span>
    );
}

/** A neutral pill, such as "preset". */
export function McpBadge({ children }: { children: React.ReactNode }) {
    return <span className="inline-flex h-5 items-center rounded-full bg-[#f5f5f4] px-2 text-[0.72rem] leading-none font-[550] whitespace-nowrap text-body">{children}</span>;
}

/** A small coloured dot; a live one sends out a fading copy of itself. */
export function McpDot({ color, live }: { color: string; live?: boolean }) {
    return (
        <span className="relative size-[7px] flex-none rounded-full bg-current" style={{ color }} aria-hidden="true">
            {live && <span className="absolute inset-0 animate-dot-pulse rounded-[inherit] bg-current" />}
        </span>
    );
}

/** The square brand-tinted icon tile beside a plugin's name; grey when the plugin is off. */
export function McpIconTile({ off = false, children }: { off?: boolean; children: React.ReactNode }) {
    return (
        <span
            className={cn(
                'grid size-10 flex-none place-items-center rounded-[11px] transition-colors [&_svg]:size-[18px]',
                off ? 'bg-[#f5f5f4] text-[#a8a29e] shadow-[inset_0_0_0_1px_var(--border)]' : 'bg-brand-soft text-brand shadow-[inset_0_0_0_1px_rgba(194,65,12,0.08)]',
            )}
            aria-hidden="true"
        >
            {children}
        </span>
    );
}

/** Turns off every animation and transition below this element when the reader asks for less motion. */
export const REDUCED_MOTION = 'motion-reduce:**:animate-none motion-reduce:**:transition-none';
