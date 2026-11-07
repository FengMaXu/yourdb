import type { AgentTerminalReason, ClarificationRequest } from '../api/client';
import type { RuntimeConnectionState } from '../api/runtime-client';

export type ChatRunReason = Exclude<AgentTerminalReason, null> | 'interrupted' | 'rejected';

type IdleRun = {
    readonly status: 'idle';
    readonly reason: ChatRunReason | null;
};

type ActiveRun = {
    readonly status: 'running';
    readonly connection: RuntimeConnectionState;
    readonly reason: Exclude<AgentTerminalReason, null> | null;
};

export interface ChatRunState {
    readonly run: IdleRun | ActiveRun;
    readonly clarification: {
        readonly request: ClarificationRequest;
        readonly submitting: boolean;
    } | null;
}

export type ChatRunAction =
    | { readonly type: 'session_reset' }
    | { readonly type: 'run_started' }
    | { readonly type: 'connection_changed'; readonly connection: RuntimeConnectionState }
    | { readonly type: 'terminal_reported'; readonly reason: Exclude<AgentTerminalReason, null> }
    | { readonly type: 'run_ended'; readonly reason?: ChatRunReason | null; readonly clearClarification?: boolean }
    | { readonly type: 'run_failed' }
    | { readonly type: 'clarification_requested'; readonly request: ClarificationRequest }
    | { readonly type: 'clarification_settled'; readonly clarificationId: string }
    | { readonly type: 'clarification_submitting'; readonly submitting: boolean }
    | { readonly type: 'clarification_answered'; readonly clarificationId: string };

export const initialChatRunState: ChatRunState = {
    run: { status: 'idle', reason: null },
    clarification: null,
};

export function chatRunReducer(state: ChatRunState, action: ChatRunAction): ChatRunState {
    switch (action.type) {
        case 'session_reset':
            return initialChatRunState;
        case 'run_started':
            return { run: { status: 'running', connection: 'connected', reason: null }, clarification: null };
        case 'connection_changed':
            return state.run.status === 'running'
                ? { ...state, run: { ...state.run, connection: action.connection } }
                : state;
        case 'terminal_reported':
            return {
                run: state.run.status === 'running'
                    ? { ...state.run, reason: action.reason }
                    : { status: 'idle', reason: action.reason },
                clarification: null,
            };
        case 'run_ended': {
            const previousReason = state.run.reason;
            return {
                run: { status: 'idle', reason: action.reason === undefined ? previousReason : action.reason },
                clarification: action.clearClarification ? null : state.clarification
                    ? { ...state.clarification, submitting: false }
                    : null,
            };
        }
        case 'run_failed':
            return { run: { status: 'idle', reason: 'error' }, clarification: null };
        case 'clarification_requested':
            return { ...state, clarification: { request: action.request, submitting: false } };
        case 'clarification_settled':
            return state.clarification?.request.clarification_id === action.clarificationId
                ? { ...state, clarification: null }
                : state;
        case 'clarification_submitting':
            return state.clarification
                ? { ...state, clarification: { ...state.clarification, submitting: action.submitting } }
                : state;
        case 'clarification_answered':
            return state.clarification?.request.clarification_id === action.clarificationId
                ? { ...state, clarification: null }
                : state;
    }
}

export const isRunActive = (state: ChatRunState): boolean => state.run.status === 'running';
export const runReason = (state: ChatRunState): ChatRunReason | null => state.run.reason;
export const runConnection = (state: ChatRunState): RuntimeConnectionState => state.run.status === 'running' ? state.run.connection : 'connected';
