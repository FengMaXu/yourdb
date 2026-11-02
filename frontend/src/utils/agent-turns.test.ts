import { describe, expect, it } from 'vitest';
import { formatDuration, groupIntoTurns, splitTurn, type TurnAgentLike } from './agent-turns';

const user = (id: string, timestamp?: number) => ({ role: 'user' as const, id, content: id, ...(timestamp !== undefined ? { timestamp } : {}) });
const agent = (id: string, patch: Partial<TurnAgentLike> = {}): TurnAgentLike => ({
    role: 'agent',
    id,
    content: '',
    transientContent: '',
    reasoningContent: '',
    toolCallsById: {},
    widgetsById: {},
    skillActivations: [],
    terminalReason: null,
    ...patch,
});

describe('groupIntoTurns', () => {
    it('gathers every agent step after a user message into one turn timed from that message', () => {
        const items = groupIntoTurns([
            user('u1', 1_000),
            agent('a1', { reasoningContent: 'plan' }),
            agent('a2', { toolCallsById: { c1: { toolCallId: 'c1' } } }),
            agent('a3', { content: 'answer' }),
            user('u2'),
            agent('a4', { content: 'second' }),
        ]);
        expect(items.map((item) => item.kind)).toEqual(['user', 'turn', 'user', 'turn']);
        const first = items[1];
        expect(first.kind === 'turn' && first.agents.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
        expect(first.kind === 'turn' && first.startedAt).toBe(1_000);
        expect(first.kind === 'turn' && first.key).toBe('turn-u1');
    });

    it('drops empty steps and opens no turn for them alone', () => {
        const items = groupIntoTurns([user('u1'), agent('empty')]);
        expect(items.map((item) => item.kind)).toEqual(['user']);
    });
});

describe('splitTurn', () => {
    it('keeps the last text as the result and every other step in the process', () => {
        const view = splitTurn([
            agent('a1', { reasoningContent: 'look at the schema', content: 'Let me check the tables.', toolCallsById: { c1: { toolCallId: 'c1' } } }),
            agent('a2', { reasoningContent: 'now answer', content: 'Final answer.' }),
        ]);
        expect(view.resultText).toBe('Final answer.');
        expect(view.result?.id).toBe('a2');
        expect(view.steps.map((step) => step.kind)).toEqual(['thought', 'note', 'tool', 'thought']);
    });

    it('keeps tool calls made after the last text inside the process', () => {
        const view = splitTurn([
            agent('a1', { content: 'Working on it.' }),
            agent('a2', { toolCallsById: { c1: { toolCallId: 'c1' } } }),
        ]);
        expect(view.resultText).toBe('Working on it.');
        expect(view.steps.map((step) => step.kind)).toEqual(['tool']);
    });

    it('keeps a failure notice written on a step with tool calls as the result once the turn is over', () => {
        const view = splitTurn([
            agent('a1', { content: '**Request failed** Retry', toolCallsById: { c1: { toolCallId: 'c1' } }, terminalReason: 'error' }),
        ]);
        expect(view.resultText).toBe('**Request failed** Retry');
        expect(view.steps.map((step) => step.kind)).toEqual(['tool']);
    });

    it('has no result while the turn runs: every text is a step of the process', () => {
        const agents = [
            agent('a1', { toolCallsById: { c1: { toolCallId: 'c1' } } }),
            agent('a2', { content: 'Two things to confirm first:', toolCallsById: { c2: { toolCallId: 'c2' } } }),
        ];
        const running = splitTurn(agents, true);
        expect(running.result).toBeUndefined();
        expect(running.resultText).toBe('');
        expect(running.steps.map((step) => step.kind)).toEqual(['tool', 'note', 'tool']);

        const done = splitTurn(agents);
        expect(done.result?.id).toBe('a2');
        expect(done.steps.map((step) => step.kind)).toEqual(['tool', 'tool']);
    });

    it('has no result when the agent wrote no text', () => {
        const view = splitTurn([agent('a1', { toolCallsById: { c1: { toolCallId: 'c1' } } })]);
        expect(view.result).toBeUndefined();
        expect(view.resultText).toBe('');
    });
});

describe('formatDuration', () => {
    it('reads as seconds, then minutes and seconds', () => {
        expect(formatDuration(42_400, 'zh')).toBe('42 秒');
        expect(formatDuration(72_000, 'zh')).toBe('1 分 12 秒');
        expect(formatDuration(72_000, 'en')).toBe('1m 12s');
    });
});
