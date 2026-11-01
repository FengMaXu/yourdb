import React from 'react';
import { cn } from '@/lib/utils';

interface AgentOrbitIconProps {
    size?: number | string;
    animated?: boolean;
    className?: string;
}

/** One electron: a soft glow and a core, which blink in and out together while the agent works. */
const Electron: React.FC<{ cx: number; cy: number; glow: number; core: number; float: string; phase: string; animated: boolean }> = ({ cx, cy, glow, core, float, phase, animated }) => {
    const part = cn(animated && phase, 'motion-reduce:animate-none');
    const origin = { transformOrigin: `${cx}px ${cy}px` };
    return (
        <g className={cn('origin-[50px_50px]', animated && float, 'motion-reduce:animate-none')}>
            <circle className={cn('fill-current opacity-16', part)} style={origin} cx={cx} cy={cy} r={glow} />
            <circle className={cn('fill-current', part)} style={origin} cx={cx} cy={cy} r={core} />
        </g>
    );
};

/** The agent's mark: a nucleus and three electrons; alive while the agent works. */
const AgentOrbitIcon: React.FC<AgentOrbitIconProps> = ({
    size = 24,
    animated = false,
    className = '',
}) => (
    <svg
        viewBox="0 0 100 100"
        width={size}
        height={size}
        className={cn('block overflow-hidden text-current', animated && 'drop-shadow-[0_0_8px_rgba(240,68,56,0.18)]', className)}
        aria-hidden="true"
        focusable="false"
    >
        <g transform="translate(50 50) scale(1.34) translate(-50 -50)">
            <Electron cx={67} cy={35} glow={7.2} core={4.2} float="animate-electron-float-1" phase="animate-electron-phase-1" animated={animated} />
            <Electron cx={33} cy={66} glow={6.8} core={3.9} float="animate-electron-float-2" phase="animate-electron-phase-2" animated={animated} />
            <Electron cx={74} cy={63} glow={5.9} core={3.2} float="animate-electron-float-3" phase="animate-electron-phase-3" animated={animated} />

            <g className={cn('origin-[50px_50px]', animated && 'animate-orbit-nucleus motion-reduce:animate-none')}>
                <circle className="fill-current opacity-12" cx="50" cy="50" r="18" />
                <circle className="fill-current opacity-96" cx="50" cy="50" r="10.5" />
                <circle className="fill-white/82" cx="46.5" cy="46.5" r="2.8" />
            </g>
        </g>
    </svg>
);

export default AgentOrbitIcon;
