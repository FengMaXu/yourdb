import { useEffect, useRef, useState } from 'react';
import { AGENT_BODY, AGENT_ICON_SVG, AGENT_ROW, MESSAGE_COLUMN, agentIcon } from './chat-styles';
import { MARKDOWN_ANSWER, MARKDOWN_DOCUMENT } from './markdown-styles';
import type { WidgetSpec } from '../api/client';
import { useLanguage } from '../context/LanguageContext';
import { formatDuration, splitTurn, type TraceStep, type TurnAgentLike } from '../utils/agent-turns';
import AgentOrbitIcon from './AgentOrbitIcon';
import AgentMarkdown from './AgentMarkdown';
import WidgetRenderer from './widgets/WidgetRenderer';
import SubagentProgressLines from './SubagentProgressLines';
import { ChevronRight } from 'lucide-react';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceTitle } from '@/components/ui/trace';
import { cn } from '@/lib/utils';
import { subagentChildrenOf, type ToolCallState } from './tool-event-state';

export interface TurnAgentMessage extends TurnAgentLike {
    messageId: string;
    toolCallsById: Record<string, ToolCallState>;
    widgetsById: Record<string, WidgetSpec>;
    skillActivations: Array<{ name: string; source?: string; command_text?: string; location?: string }>;
}

interface AgentTurnProps<A extends TurnAgentMessage> {
    agents: A[];
    /** The run answering this turn is still going. */
    running: boolean;
    startedAt?: number;
    currentSessionId: string;
    reconnecting?: boolean;
    toolLabel: (tool: ToolCallState) => string;
    skillLabel: (skill: A['skillActivations'][number]) => string;
    onOpenToolPanel?: () => void;
}

/** A step of the process: a small dot, a label, sometimes a chevron. */
const ROW = 'group/row flex w-fit max-w-full cursor-default list-none items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-[3px] text-left text-[0.84rem] leading-[1.5] text-[#78716c] [font-family:inherit] transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-strong)] motion-reduce:transition-none [&::-webkit-details-marker]:hidden';
/** A step that opens something: a pointer and a hover ground. */
const ROW_ACTION = 'cursor-pointer hover:bg-[#f5f5f4] hover:text-[#1c1917]';
const LABEL = 'min-w-0 truncate';
const ROW_CHEVRON = 'flex-none text-[#a8a29e] opacity-0 transition-[opacity,transform] group-hover/row:opacity-100 group-focus-visible/row:opacity-100 motion-reduce:transition-none';
const STEP = 'min-w-0 animate-trace-in motion-reduce:animate-none';
/** Live text: a light sweeps across it; plain under reduced motion. */
const SHIMMER = 'animate-trace-shimmer bg-[linear-gradient(90deg,#78716c_0%,#78716c_40%,#d6d3d1_50%,#78716c_60%,#78716c_100%)] bg-[length:250%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-[#78716c]';

/** A step's dot; a live one is accent and sends out a ring. */
function Dot({ live }: { live: boolean }) {
    return (
        <span
            className={cn(
                'relative size-[5px] flex-none rounded-full bg-current',
                live ? "bg-[var(--accent-strong)] opacity-100 after:absolute after:inset-0 after:animate-trace-pulse after:rounded-[inherit] after:bg-inherit after:content-[''] motion-reduce:after:animate-none" : 'opacity-55',
            )}
            aria-hidden="true"
        />
    );
}

/**
 * One answer from the agent: the process it went through (thoughts, tool calls,
 * remarks along the way), open while it runs and folded to one line when it is
 * done, followed by the result: its final text and every chart or table it made.
 */
function AgentTurn<A extends TurnAgentMessage>({ agents, running, startedAt, currentSessionId, reconnecting, toolLabel, skillLabel, onOpenToolPanel }: AgentTurnProps<A>) {
    const { t, language } = useLanguage();
    const lang = language === 'en' ? 'en' : 'zh';
    const { steps, result, resultText } = splitTurn(agents, running);
    const widgets = agents.flatMap((agent) => Object.values(agent.widgetsById));
    const lastAgent = agents[agents.length - 1];

    // Open while running, folded once done; a click by the user wins from then on.
    const [userOpen, setUserOpen] = useState<boolean | null>(null);
    const open = userOpen ?? running;

    // Time the turn: a clock while running, the moment it finished afterwards.
    const [now, setNow] = useState(() => Date.now());
    const [finishedAt, setFinishedAt] = useState<number | undefined>();
    const wasRunning = useRef(running);
    useEffect(() => {
        if (!running) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running]);
    useEffect(() => {
        if (wasRunning.current && !running) setFinishedAt(Date.now());
        wasRunning.current = running;
    }, [running]);

    const lastTimestamp = agents.reduce<number | undefined>((latest, agent) => (
        agent.timestamp !== undefined && (latest === undefined || agent.timestamp > latest) ? agent.timestamp : latest
    ), undefined);
    const endedAt = running ? now : finishedAt ?? lastTimestamp;
    const duration = startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt ? formatDuration(endedAt - startedAt, lang) : undefined;

    const thoughts = steps.filter((step) => step.kind === 'thought').length;
    const tools = steps.filter((step) => step.kind === 'tool').length;
    const failed = steps.some((step) => step.kind === 'tool' && step.tool.status === 'error');
    const summaryParts = [
        thoughts > 0 ? t('trace.thoughtCount').replace('{n}', String(thoughts)) : '',
        tools > 0 ? t('trace.toolCount').replace('{n}', String(tools)) : '',
    ].filter(Boolean);
    const headline = running
        ? (duration ? `${t('trace.working')} · ${duration}` : t('trace.working'))
        : (duration ? t('trace.worked').replace('{duration}', duration) : t('trace.process'));
    const hasProcess = steps.length > 0 || (running && !resultText);
    const bodyId = `trace-${lastAgent?.id ?? 'pending'}`;

    const renderStep = (step: TraceStep<A>, index: number) => {
        const live = running && index === steps.length - 1;
        if (step.kind === 'thought') {
            return (
                <li key={step.key} className={STEP}>
                    <details className="group/thought" open={live || undefined}>
                        <summary className={cn(ROW, ROW_ACTION)}>
                            <Dot live={live} />
                            <span className={cn(LABEL, live && SHIMMER)}>{live ? t('trace.thinking') : t('trace.thought')}</span>
                            <ChevronRight size={13} className={cn(ROW_CHEVRON, 'group-open/thought:rotate-90 group-open/thought:opacity-100')} aria-hidden="true" />
                        </summary>
                        <div className="mt-0.5 mr-0 mb-1.5 ml-[21px] max-h-[260px] overflow-y-auto rounded-[9px] bg-[#fafaf9] px-3 py-2 text-[0.82rem] leading-[1.65] wrap-anywhere whitespace-pre-wrap text-[#57534e]">{step.text}</div>
                    </details>
                </li>
            );
        }
        if (step.kind === 'note') {
            return (
                <li key={step.key} className={STEP}>
                    {/* The note's own tight spacing outranks the document spacing ([&&…] doubles the class). */}
                    <div className={`py-0.5 pr-2 pl-[21px] text-[0.86rem] leading-[1.65] text-[#57534e] [&&_:is(ol,p,ul)]:mt-0 [&&_:is(ol,p,ul)]:mb-1 ${MARKDOWN_DOCUMENT}`}>
                        <AgentMarkdown currentSessionId={currentSessionId}>{step.text}</AgentMarkdown>
                    </div>
                </li>
            );
        }
        if (step.kind === 'tool') {
            const label = toolLabel(step.tool);
            const toolLive = step.tool.status !== 'done' && step.tool.status !== 'error' && running;
            return (
                <li key={step.key} className={STEP}>
                    <button
                        type="button"
                        className={cn(ROW, onOpenToolPanel && ROW_ACTION, step.tool.status === 'error' && 'text-[var(--status-error,#dc2626)]')}
                        onClick={onOpenToolPanel}
                        disabled={!onOpenToolPanel}
                        aria-label={label}
                    >
                        <Dot live={toolLive} />
                        <span className={cn(LABEL, toolLive && SHIMMER)}>{label}</span>
                        {onOpenToolPanel && <ChevronRight size={13} className={ROW_CHEVRON} aria-hidden="true" />}
                    </button>
                    <SubagentProgressLines progress={subagentChildrenOf(step.tool)} />
                </li>
            );
        }
        return (
            <li key={step.key} className={STEP}>
                <div className={ROW}>
                    <Dot live={false} />
                    <span className={LABEL}>{skillLabel(step.skill)}</span>
                </div>
            </li>
        );
    };

    return (
        <div className={AGENT_ROW}>
            <div className={agentIcon(running)}>
                <AgentOrbitIcon size={32} animated={running} className={AGENT_ICON_SVG} />
            </div>
            <div className={MESSAGE_COLUMN}>
                {hasProcess && (
                    <Trace className="mb-1.5 gap-0">
                        <TraceCollapsible open={open} onOpenChange={(next) => setUserOpen(next)}>
                            <TraceCollapsibleTrigger
                                className="-ml-2 gap-2 rounded-lg border-0 bg-transparent px-2 py-[5px] text-[0.85rem] leading-[1.4] text-[#78716c] [font-family:inherit] hover:bg-[#f5f5f4] hover:text-[#1c1917] focus-visible:ring-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-strong)] motion-reduce:transition-none [&_[data-slot=trace-icon]]:ml-0 [&_[data-slot=trace-icon]]:size-3.5 [&_[data-slot=trace-icon]]:text-[#a8a29e] motion-reduce:[&_[data-slot=trace-icon]]:transition-none"
                            >
                                <TraceTitle className={cn('overflow-visible font-[550] whitespace-nowrap', running && SHIMMER)}>{headline}</TraceTitle>
                                {summaryParts.length > 0 && <span className={cn('truncate', failed ? 'text-[#dc2626]' : 'text-[#a8a29e]')}>{summaryParts.join(' · ')}</span>}
                            </TraceCollapsibleTrigger>
                            <TraceCollapsibleContent id={bodyId} className="m-0 border-l-0 p-0 leading-normal text-inherit motion-reduce:transition-none">
                                {steps.length > 0 ? (
                                    <ol className="mt-1 mr-0 mb-1.5 ml-[3px] grid list-none gap-px border-l border-[var(--hairline)] py-0 pr-0 pl-2.5">{steps.map(renderStep)}</ol>
                                ) : (
                                    <div className={ROW}><Dot live /><span className={cn(LABEL, SHIMMER)}>{t('trace.thinking')}</span></div>
                                )}
                            </TraceCollapsibleContent>
                        </TraceCollapsible>
                    </Trace>
                )}

                {resultText && (
                    <div className={`${AGENT_BODY} animate-trace-in [animation-duration:320ms] motion-reduce:animate-none ${MARKDOWN_ANSWER}`}>
                        <AgentMarkdown currentSessionId={currentSessionId}>{resultText}</AgentMarkdown>
                    </div>
                )}

                {widgets.map((widget) => (
                    <WidgetRenderer key={widget.tool_call_id || widget.widget_id} widget={widget} currentSessionId={currentSessionId} />
                ))}

                {lastAgent?.retryNotice && (
                    <div className="mt-1 inline-flex items-center gap-2 text-[0.88rem] leading-[1.5] text-[var(--text-secondary)]"><span>{lastAgent.retryNotice}</span></div>
                )}
                {reconnecting && (
                    <div className="mt-1 inline-flex items-center gap-2 text-[0.88rem] leading-[1.5] text-[var(--text-secondary)]"><span>{t('chat.streamReconnecting')}</span></div>
                )}
                {result === undefined && !running && !hasProcess && lastAgent?.statusNotice && (
                    <div className="mt-1 inline-flex items-center gap-2 text-[0.88rem] leading-[1.5] text-[var(--text-secondary)]"><span>{lastAgent.statusNotice}</span></div>
                )}
            </div>
        </div>
    );
}

export default AgentTurn;
