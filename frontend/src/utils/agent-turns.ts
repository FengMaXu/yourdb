import { isAgentMessageEmpty, visibleAgentContent, type AgentMessageLike } from './agent-message';

/**
 * A conversation shows one agent *turn* per user message: every model step the
 * agent took to answer it. The steps (thoughts, tool calls, remarks along the
 * way) are the process; the text of the step that ended it is the result.
 */

interface UserLike {
    role: 'user';
    id: string;
    timestamp?: number;
}

export interface TurnAgentLike extends AgentMessageLike {
    role: 'agent';
    id: string;
    timestamp?: number;
}

export type ChatItem<U extends UserLike, A extends TurnAgentLike> =
    | { kind: 'user'; message: U }
    | { kind: 'turn'; key: string; startedAt?: number; agents: A[] };

/** Group a flat message list into user messages and the agent turns that answer them. Empty agent steps are dropped. */
export function groupIntoTurns<U extends UserLike, A extends TurnAgentLike>(messages: ReadonlyArray<U | A>): ChatItem<U, A>[] {
    const items: ChatItem<U, A>[] = [];
    let lastUser: U | undefined;
    let turn: Extract<ChatItem<U, A>, { kind: 'turn' }> | undefined;
    for (const message of messages) {
        if (message.role === 'user') {
            lastUser = message as U;
            turn = undefined;
            items.push({ kind: 'user', message: message as U });
            continue;
        }
        if (isAgentMessageEmpty(message)) continue;
        if (!turn) {
            turn = {
                kind: 'turn',
                key: `turn-${lastUser?.id ?? message.id}`,
                ...(lastUser?.timestamp !== undefined ? { startedAt: lastUser.timestamp } : message.timestamp !== undefined ? { startedAt: message.timestamp } : {}),
                agents: [],
            };
            items.push(turn);
        }
        turn.agents.push(message as A);
    }
    return items;
}

export type TraceStep<A extends TurnAgentLike> =
    | { kind: 'thought'; key: string; text: string; agent: A }
    | { kind: 'note'; key: string; text: string; agent: A }
    | { kind: 'tool'; key: string; tool: A['toolCallsById'][string]; agent: A }
    | { kind: 'skill'; key: string; skill: A['skillActivations'][number]; agent: A };

export interface TurnView<A extends TurnAgentLike> {
    steps: TraceStep<A>[];
    /** The step whose text is the answer, if any text has been written. */
    result?: A;
    resultText: string;
}

const actsOnTools = (agent: TurnAgentLike): boolean => Object.keys(agent.toolCallsById).length > 0 || agent.skillActivations.length > 0;

/**
 * Split a turn into its process steps and its result. The result is the last
 * text, but only when nothing was done after it: text written alongside a tool
 * call, or before one, is a remark along the way (e.g. the lead-in to a
 * clarification question), so it stays in the process.
 */
export function splitTurn<A extends TurnAgentLike>(agents: readonly A[]): TurnView<A> {
    let resultIndex = -1;
    for (let index = agents.length - 1; index >= 0; index -= 1) {
        if (actsOnTools(agents[index])) break;
        if (visibleAgentContent(agents[index]).trim()) {
            resultIndex = index;
            break;
        }
    }
    const steps: TraceStep<A>[] = [];
    agents.forEach((agent, index) => {
        if (agent.reasoningContent.trim()) {
            steps.push({ kind: 'thought', key: `${agent.id}:thought`, text: agent.reasoningContent, agent });
        }
        const text = visibleAgentContent(agent).trim();
        if (text && index !== resultIndex) {
            steps.push({ kind: 'note', key: `${agent.id}:note`, text, agent });
        }
        for (const [id, tool] of Object.entries(agent.toolCallsById)) {
            steps.push({ kind: 'tool', key: `${agent.id}:tool:${id}`, tool: tool as A['toolCallsById'][string], agent });
        }
        agent.skillActivations.forEach((skill, skillIndex) => {
            steps.push({ kind: 'skill', key: `${agent.id}:skill:${skillIndex}`, skill: skill as A['skillActivations'][number], agent });
        });
    });
    const result = resultIndex >= 0 ? agents[resultIndex] : undefined;
    return { steps, result, resultText: result ? visibleAgentContent(result) : '' };
}

/** "42 秒" / "1 分 12 秒" (or "42s" / "1m 12s"). */
export function formatDuration(ms: number, language: 'zh' | 'en'): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (language === 'en') return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
