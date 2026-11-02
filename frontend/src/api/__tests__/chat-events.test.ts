import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachRunViaRuntime, mapRuntimeEvent, sendChatViaRuntime } from '../chat-events';
import { mergeToolResultState } from '../../components/tool-event-state';

let runtimeListener: ((event: unknown) => void) | undefined;
let runtimeOptions: { onConnected?: () => void; onResync?: () => void; afterSequence?: number } | undefined;
let connectImmediately = true;
let runtimeSequence = 0;
const unsubscribe = vi.fn();
const dispatch = vi.fn(async () => ({
    response: { type: 'agent.prompt.accepted', runId: 'run-1' },
}));

vi.mock('../runtime-client', () => ({
    subscribeRuntimeEvents: vi.fn((listener: (event: unknown) => void, _sessionId?: string, options?: { onConnected?: () => void; onResync?: () => void; afterSequence?: number }) => {
        runtimeOptions = options;
        if (connectImmediately) options?.onConnected?.();
        runtimeListener = (raw) => {
            const value = raw && typeof raw === 'object' ? raw as { sessionId?: unknown; event?: unknown } : {};
            listener({
                protocolVersion: 1,
                sequence: ++runtimeSequence,
                requestId: 'test-request',
                timestamp: Date.now(),
                ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
                event: value.event,
            });
        };
        return unsubscribe;
    }),
    getRuntimeClient: vi.fn(() => ({ dispatch })),
}));

describe('Runtime Widget event replay adapter', () => {
    it('maps the lifecycle vocabulary while keeping the active message', () => {
        const common = { messageId: 'message-1', toolCallId: 'call-1', widgetId: 'widget-call-1', toolName: 'show_widget' } as const;
        const types = ['widget', 'widget_patch', 'widget_done', 'widget_remove', 'widget_error'] as const;
        const events = types.map((type) => {
            const event = type === 'widget'
                ? { type, ...common, widget: { widget_id: common.widgetId, kind: 'kpi', title: 'Revenue' } as const }
                : type === 'widget_patch'
                    ? { type, ...common, patch: { subtitle: 'Today' } }
                    : type === 'widget_error'
                        ? { type, ...common, error: 'failed' }
                        : { type, ...common };
            return mapRuntimeEvent(event, 'message-1')!.event;
        });

        expect(events.map((event) => event.type)).toEqual(types);
        expect(events.every((event) => 'message_id' in event && event.message_id === 'message-1')).toBe(true);
    });

    it('turns a structured tool result into readable legacy fallback text', () => {
        const mapped = mapRuntimeEvent({
            type: 'agent.tool_finished',
            toolCallId: 'call-1',
            toolName: 'show_widget',
            args: {},
            result: {
                content: [{ type: 'text', text: '[widget:kpi] Revenue: 42' }],
                details: { widgetId: 'widget-call-1' },
            },
            isError: false,
        }, 'message-1');

        expect(mapped?.event).toMatchObject({
            type: 'tool_result',
            content: '[widget:kpi] Revenue: 42',
            widget_id: 'widget-call-1',
        });
    });
});

describe('runtime tool argument preservation', () => {
    it('forwards completion args when present and leaves old events optional', () => {
        expect(mapRuntimeEvent({ type: 'agent.tool_started', toolCallId: 'call-1', toolName: 'query', args: { sql: 'select 1' } }, 'msg-1')?.event)
            .toMatchObject({ type: 'tool_call', arguments: { sql: 'select 1' } });
        expect(mapRuntimeEvent({ type: 'agent.tool_finished', toolCallId: 'call-1', toolName: 'query', result: 'ok', isError: false }, 'msg-1')?.event)
            .not.toHaveProperty('arguments');
        expect(mapRuntimeEvent({ type: 'agent.tool_finished', toolCallId: 'call-1', toolName: 'query', args: { sql: 'select 1' }, result: 'ok', isError: false }, 'msg-1')?.event)
            .toMatchObject({ type: 'tool_result', arguments: { sql: 'select 1' } });
    });

    it('preserves start arguments when a completion has no args or an empty object', () => {
        const existing = {
            toolCallId: 'call-1',
            name: 'query',
            arguments: { sql: 'select 1' },
            status: 'calling' as const,
        };
        const oldCompletion = {
            type: 'tool_result' as const,
            message_id: 'msg-1',
            tool_call_id: 'call-1',
            name: 'query',
            content: 'ok',
        };
        const emptyCompletion = { ...oldCompletion, arguments: {} };
        expect(mergeToolResultState(existing, oldCompletion).arguments).toEqual({ sql: 'select 1' });
        expect(mergeToolResultState(existing, emptyCompletion).arguments).toEqual({ sql: 'select 1' });
        expect(mergeToolResultState(existing, { ...oldCompletion, arguments: { sql: 'select 2' } }).arguments)
            .toEqual({ sql: 'select 2' });
    });
});

describe('runtime chat event replay', () => {
    beforeEach(() => {
        runtimeListener = undefined;
        runtimeSequence = 0;
        connectImmediately = true;
        unsubscribe.mockReset();
        dispatch.mockClear();
    });

    it('sends the prompt only after the event stream is subscribed', async () => {
        connectImmediately = false;
        const handle = sendChatViaRuntime('hello', vi.fn(), vi.fn(), vi.fn());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(dispatch).not.toHaveBeenCalled();
        runtimeOptions?.onConnected?.();
        await handle.finished;
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('does not send the prompt when cancelled before the stream connects', async () => {
        connectImmediately = false;
        const handle = sendChatViaRuntime('hello', vi.fn(), vi.fn(), vi.fn());
        handle.cancel();
        runtimeOptions?.onConnected?.();
        await handle.finished;
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('follows an already running run from the snapshot cursor without sending a prompt', async () => {
        const events: unknown[] = [];
        const onFinish = vi.fn();
        const handle = attachRunViaRuntime('run-7', { sequence: 41 }, (event) => events.push(event), vi.fn(), onFinish, 'session-1');
        await handle.finished;
        expect(runtimeOptions?.afterSequence).toBe(41);
        expect(dispatch).not.toHaveBeenCalled();
        runtimeListener?.({ sessionId: 'session-1', event: { type: 'agent.text_delta', delta: 'tail' } });
        runtimeListener?.({ sessionId: 'session-1', event: { type: 'agent.completed' } });
        expect(events).toContainEqual({ type: 'done', reason: 'completed', session_id: 'session-1' });
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('stops a followed run by its id, and detaching leaves it running', async () => {
        const stopped = attachRunViaRuntime('run-7', { sequence: 0 }, vi.fn(), vi.fn(), vi.fn(), 'session-1');
        await stopped.finished;
        stopped.cancel();
        expect(dispatch).toHaveBeenCalledWith({ type: 'agent.stop', operationId: 'run-7' }, 'session-1');

        dispatch.mockClear();
        const onFinish = vi.fn();
        const detached = attachRunViaRuntime('run-8', { sequence: 0 }, vi.fn(), vi.fn(), onFinish, 'session-1');
        await detached.finished;
        detached.detach();
        expect(dispatch).not.toHaveBeenCalled();
        expect(onFinish).not.toHaveBeenCalled();
        expect(unsubscribe).toHaveBeenCalled();
    });

    it('forwards a resync request to the chat', () => {
        const onResync = vi.fn();
        sendChatViaRuntime('hello', vi.fn(), vi.fn(), vi.fn(), 'session-1', { onResync });
        runtimeOptions?.onResync?.();
        expect(onResync).toHaveBeenCalledTimes(1);
    });

    it('replays message and tool events with session identity and original arguments', async () => {
        const events: unknown[] = [];
        const onFinish = vi.fn();
        const handle = sendChatViaRuntime('show sales', (event) => events.push(event), vi.fn(), onFinish);
        await handle.finished;

        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.message_started', messageId: 'message-1' },
        });
        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.tool_started', toolCallId: 'tool-1', toolName: 'query_database', args: { sql: 'SELECT 1' } },
        });
        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.tool_finished', toolCallId: 'tool-1', toolName: 'query_database', result: [{ value: 1 }], isError: false },
        });

        expect(events).toEqual([
            { type: 'message_start', message_id: 'message-1', session_id: 'session-1' },
            { type: 'tool_call', message_id: 'message-1', tool_call_id: 'tool-1', name: 'query_database', arguments: { sql: 'SELECT 1' }, session_id: 'session-1' },
            { type: 'tool_result', message_id: 'message-1', tool_call_id: 'tool-1', name: 'query_database', arguments: { sql: 'SELECT 1' }, content: '[{"value":1}]', is_error: false, session_id: 'session-1' },
        ]);
    });

    it('keeps replayed error results and follows message ids across turns', async () => {
        const events: unknown[] = [];
        const handle = sendChatViaRuntime('show sales', (event) => events.push(event), vi.fn(), vi.fn());
        await handle.finished;

        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.message_started', messageId: 'message-1' },
        });
        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.text_delta', delta: 'The first answer' },
        });
        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.message_started', messageId: 'message-2' },
        });
        runtimeListener?.({
            sessionId: 'session-1',
            event: { type: 'agent.tool_finished', toolCallId: 'tool-2', toolName: 'query_database', result: 'database unavailable', isError: true },
        });

        expect(events).toEqual([
            { type: 'message_start', message_id: 'message-1', session_id: 'session-1' },
            { type: 'text_delta', message_id: 'message-1', content: 'The first answer', session_id: 'session-1' },
            { type: 'message_start', message_id: 'message-2', session_id: 'session-1' },
            { type: 'tool_result', message_id: 'message-2', tool_call_id: 'tool-2', name: 'query_database', arguments: {}, content: 'database unavailable', is_error: true, session_id: 'session-1' },
        ]);
    });

    it('finishes once when a replay contains duplicate completion events', () => {
        const onFinish = vi.fn();
        sendChatViaRuntime('hello', vi.fn(), vi.fn(), onFinish);
        runtimeListener?.({ event: { type: 'agent.completed' } });
        runtimeListener?.({ event: { type: 'agent.completed' } });
        expect(onFinish).toHaveBeenCalledTimes(1);
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('ignores malformed runtime payloads at the frontend boundary', () => {
        const events: unknown[] = [];
        sendChatViaRuntime('hello', (event) => events.push(event), vi.fn(), vi.fn());
        runtimeListener?.({ event: { type: 'agent.text_delta', delta: 42 } });
        expect(events).toEqual([]);
    });
});

describe('runtime run outcome', () => {
    it('maps the terminal outcome to the chat status', () => {
        const reason = (outcome?: 'completed' | 'stopped' | 'failed') =>
            (mapRuntimeEvent({ type: 'agent.completed', ...(outcome ? { outcome } : {}) }, 'm')?.event as { reason?: string } | undefined)?.reason;
        expect(reason()).toBe('completed');
        expect(reason('completed')).toBe('completed');
        expect(reason('stopped')).toBe('stopped');
        expect(reason('failed')).toBe('error');
    });
});
