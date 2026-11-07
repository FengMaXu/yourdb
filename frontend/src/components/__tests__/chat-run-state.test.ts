import { describe, expect, it } from 'vitest';
import { chatRunReducer, initialChatRunState } from '../chat-run-state';

const clarification = {
    clarification_id: 'clarification-1',
    question: 'Which definition?',
    options: ['A', 'B'],
};

describe('chat run state', () => {
    it('keeps the terminal reason when the followed run finishes', () => {
        const running = chatRunReducer(initialChatRunState, { type: 'run_started' });
        const reported = chatRunReducer(running, { type: 'terminal_reported', reason: 'completed' });
        const ended = chatRunReducer(reported, { type: 'run_ended' });

        expect(ended).toEqual({ run: { status: 'idle', reason: 'completed' }, clarification: null });
    });

    it('cannot retain a clarification after a failed run', () => {
        const requested = chatRunReducer(initialChatRunState, { type: 'clarification_requested', request: clarification });
        const failed = chatRunReducer(requested, { type: 'run_failed' });

        expect(failed).toEqual({ run: { status: 'idle', reason: 'error' }, clarification: null });
    });

    it('ignores a connection update after the run ended', () => {
        const ended = chatRunReducer(
            chatRunReducer(initialChatRunState, { type: 'run_started' }),
            { type: 'run_ended', reason: 'stopped' },
        );

        expect(chatRunReducer(ended, { type: 'connection_changed', connection: 'reconnecting' })).toBe(ended);
    });

    it('settles only the matching clarification', () => {
        const requested = chatRunReducer(initialChatRunState, { type: 'clarification_requested', request: clarification });
        expect(chatRunReducer(requested, { type: 'clarification_settled', clarificationId: 'other' })).toBe(requested);
        expect(chatRunReducer(requested, { type: 'clarification_settled', clarificationId: clarification.clarification_id })).toEqual(initialChatRunState);
    });

    it('resets every run-owned state when the session changes', () => {
        const active = chatRunReducer(
            chatRunReducer(
                chatRunReducer(initialChatRunState, { type: 'run_started' }),
                { type: 'clarification_requested', request: clarification },
            ),
            { type: 'clarification_submitting', submitting: true },
        );

        expect(chatRunReducer(active, { type: 'session_reset' })).toEqual(initialChatRunState);
    });
});
