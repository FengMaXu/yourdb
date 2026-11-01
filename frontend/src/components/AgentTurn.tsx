import { useEffect, useRef, useState } from 'react';
import { MARKDOWN_ANSWER, MARKDOWN_DOCUMENT } from './markdown-styles';
import type { WidgetSpec } from '../api/client';
import { useLanguage } from '../context/LanguageContext';
import { formatDuration, splitTurn, type TraceStep, type TurnAgentLike } from '../utils/agent-turns';
import AgentOrbitIcon from './AgentOrbitIcon';
import AgentMarkdown from './AgentMarkdown';
import WidgetRenderer from './widgets/WidgetRenderer';
import SubagentProgressLines from './SubagentProgressLines';
import { ChevronRight } from './icons/Typicons';
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

/**
 * One answer from the agent: the process it went through (thoughts, tool calls,
 * remarks along the way), open while it runs and folded to one line when it is
 * done, followed by the result: its final text and every chart or table it made.
 */
function AgentTurn<A extends TurnAgentMessage>({ agents, running, startedAt, currentSessionId, reconnecting, toolLabel, skillLabel, onOpenToolPanel }: AgentTurnProps<A>) {
    const { t, language } = useLanguage();
    const lang = language === 'en' ? 'en' : 'zh';
    const { steps, result, resultText } = splitTurn(agents);
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
                <li key={step.key} className="trace-step">
                    <details className="trace-thought" open={live || undefined}>
                        <summary className={`trace-row ${live ? 'is-live' : ''}`}>
                            <span className="trace-dot" aria-hidden="true" />
                            <span className="trace-label">{live ? t('trace.thinking') : t('trace.thought')}</span>
                            <ChevronRight size={13} className="trace-chevron" aria-hidden="true" />
                        </summary>
                        <div className="trace-thought-text">{step.text}</div>
                    </details>
                </li>
            );
        }
        if (step.kind === 'note') {
            return (
                <li key={step.key} className="trace-step">
                    <div className={`trace-note ${MARKDOWN_DOCUMENT}`}>
                        <AgentMarkdown currentSessionId={currentSessionId}>{step.text}</AgentMarkdown>
                    </div>
                </li>
            );
        }
        if (step.kind === 'tool') {
            const label = toolLabel(step.tool);
            const toolLive = step.tool.status !== 'done' && step.tool.status !== 'error' && running;
            return (
                <li key={step.key} className="trace-step">
                    <button
                        type="button"
                        className={`trace-row trace-tool agent-hint-line ${step.tool.status === 'error' ? 'is-error' : ''} ${toolLive ? 'is-live' : ''}`}
                        onClick={onOpenToolPanel}
                        disabled={!onOpenToolPanel}
                        aria-label={label}
                    >
                        <span className="trace-dot" aria-hidden="true" />
                        <span className="trace-label">{label}</span>
                        {onOpenToolPanel && <ChevronRight size={13} className="trace-chevron" aria-hidden="true" />}
                    </button>
                    <SubagentProgressLines progress={subagentChildrenOf(step.tool)} />
                </li>
            );
        }
        return (
            <li key={step.key} className="trace-step">
                <div className="trace-row">
                    <span className="trace-dot" aria-hidden="true" />
                    <span className="trace-label">{skillLabel(step.skill)}</span>
                </div>
            </li>
        );
    };

    return (
        <div className="message agent agent-turn">
            <div className={`agent-icon-red ${running ? 'is-running' : 'is-idle'}`}>
                <AgentOrbitIcon size={32} animated={running} className="agent-message-icon" />
            </div>
            <div className="message-content-wrapper">
                {hasProcess && (
                    <div className={`agent-trace ${running ? 'is-running' : 'is-done'} ${failed ? 'has-error' : ''}`}>
                        <button
                            type="button"
                            className="agent-trace-toggle"
                            aria-expanded={open}
                            aria-controls={bodyId}
                            onClick={() => setUserOpen(!open)}
                        >
                            <span className={`agent-trace-headline ${running ? 'is-live' : ''}`}>{headline}</span>
                            {summaryParts.length > 0 && <span className="agent-trace-meta">{summaryParts.join(' · ')}</span>}
                            <ChevronRight size={14} className="agent-trace-chevron" aria-hidden="true" />
                        </button>
                        <div id={bodyId} className="agent-trace-body" data-open={open ? 'true' : 'false'} inert={!open}>
                            <div className="agent-trace-clip">
                                {steps.length > 0 ? (
                                    <ol className="agent-trace-steps">{steps.map(renderStep)}</ol>
                                ) : (
                                    <div className="trace-row is-live"><span className="trace-dot" aria-hidden="true" /><span className="trace-label">{t('trace.thinking')}</span></div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {resultText && (
                    <div className={`message-content agent-message-body agent-turn-result ${MARKDOWN_ANSWER}`}>
                        <AgentMarkdown currentSessionId={currentSessionId}>{resultText}</AgentMarkdown>
                    </div>
                )}

                {widgets.map((widget) => (
                    <WidgetRenderer key={widget.tool_call_id || widget.widget_id} widget={widget} currentSessionId={currentSessionId} />
                ))}

                {lastAgent?.retryNotice && (
                    <div className="agent-thinking-line"><span>{lastAgent.retryNotice}</span></div>
                )}
                {reconnecting && (
                    <div className="agent-thinking-line"><span>{t('chat.streamReconnecting')}</span></div>
                )}
                {result === undefined && !running && !hasProcess && lastAgent?.statusNotice && (
                    <div className="agent-thinking-line"><span>{lastAgent.statusNotice}</span></div>
                )}
            </div>
        </div>
    );
}

export default AgentTurn;
