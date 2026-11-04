import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_ICON_SVG, AGENT_ROW, MESSAGE_COLUMN, USER_ROW, agentIcon } from './chat-styles';
import {
    Loader2,
    Send,
    Square,
    Paperclip,
    Plus,
    X,
    ChevronRight,
} from 'lucide-react';
import { FileIcon } from './FileIcons';
import {
    uploadWorkspaceFile,
    type SSEEvent,
    type WidgetSpec,
    type SessionSnapshotMessage,
    type ClarificationRequest,
    type AgentProgressStage,
    type AgentTerminalReason,
} from '../api/client';
import { answerClarificationViaRuntime, getSessionStateViaRuntime, getTranscriptViaRuntime, steerAgentViaRuntime, stopAgentViaRuntime, type RuntimeConnectionState, type RuntimeResyncReason, type RuntimeSessionState } from '../api/runtime-client';
import { attachRunViaRuntime, sendChatViaRuntime, type ChatStreamOptions, type RuntimeChatHandle } from '../api/chat-events';
import { isModelNotConfiguredError } from './ModelSetupPrompt';
import type { ToolData } from './ToolPanel';
import { useSession, type Session, type Task } from '../hooks/useSession';
import { useLanguage } from '../context/LanguageContext';
import AgentOrbitIcon from './AgentOrbitIcon';
import { IdCard } from 'lucide-react';
import { isAgentMessageEmpty } from '../utils/agent-message';
import { groupIntoTurns } from '../utils/agent-turns';
import AgentTurn from './AgentTurn';
import { SetupChecklist } from './SetupChecklist';
import { useReadiness } from '../hooks/useReadiness';
import { mergeToolResultState, type ToolCallState } from './tool-event-state';

interface SkillActivation {
    name: string;
    description?: string;
    when_to_use?: string;
    location?: string;
    source_scope?: string;
    granted_permissions?: string[];
    model_override?: string | null;
    ui_message?: string;
    source?: string;
    command_text?: string;
    skill_dir?: string;
}

interface AgentMessage {
    id: string;
    role: 'agent';
    content: string;
    transientContent: string;
    reasoningContent: string;
    messageId: string;
    toolCallsById: Record<string, ToolCallState>;
    widgetsById: Record<string, WidgetSpec>;
    skillActivations: SkillActivation[];
    currentStage: AgentProgressStage;
    visitedStages: AgentProgressStage[];
    terminalReason: AgentTerminalReason;
    retryNotice?: string;
    statusNotice?: string;
    timestamp?: number;
}

interface UserMessage {
    id: string;
    role: 'user';
    content: string;
    attachments?: string[];
    timestamp?: number;
}

type ChatMessage = AgentMessage | UserMessage;

interface ChatAreaProps {
    onUpdateTools?: (tools: ToolData[]) => void;
    onOpenToolPanel?: () => void;
    onToggleToolPanel?: () => void;
    isToolPanelOpen?: boolean;
    hasTools?: boolean;
    /** Called when the runtime refuses a turn because no model is configured. */
    onModelNotConfigured?: () => void;
}

/** Starter questions an empty session offers; a click puts one in the input to edit before sending. */
const STARTER_PROMPTS = ['query', 'trend', 'dashboard', 'report'] as const;

const STAGE_ORDER: AgentProgressStage[] = [
    'sent',
    'understanding',
    'selecting_tool',
    'executing_query',
    'generating_answer',
];

const stageIndex = (stage: AgentProgressStage) => STAGE_ORDER.indexOf(stage);

const advanceStage = (message: AgentMessage, stage: AgentProgressStage): AgentMessage => {
    if (stageIndex(stage) <= stageIndex(message.currentStage)) {
        return message;
    }
    const visitedStages = STAGE_ORDER.filter((item) => stageIndex(item) <= stageIndex(stage));
    return {
        ...message,
        currentStage: stage,
        visitedStages,
    };
};

/** A resync reads the session state up to this many times, waiting 1, 2, 4… s between tries. */
const RESYNC_ATTEMPTS = 4;
const RESYNC_RETRY_MS = 1_000;

const setTerminalReason = (message: AgentMessage, reason: AgentTerminalReason): AgentMessage => ({
    ...message,
    terminalReason: reason,
});

const createLocalAgentMessage = (messageId: string): AgentMessage => ({
    id: `local-${messageId}`,
    role: 'agent',
    timestamp: Date.now(),
    content: '',
    transientContent: '',
    reasoningContent: '',
    messageId,
    toolCallsById: {},
    widgetsById: {},
    skillActivations: [],
    currentStage: 'sent',
    visitedStages: ['sent'],
    terminalReason: null,
});

const toSnapshotMessage = (message: ChatMessage): SessionSnapshotMessage => {
    if (message.role === 'user') {
        return {
            id: message.id,
            role: 'user',
            content: message.content,
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        };
    }

    return {
        id: message.id,
        role: 'agent',
        content: message.content,
        reasoningContent: message.reasoningContent,
        messageId: message.messageId,
        toolCallsById: message.toolCallsById,
        widgetsById: message.widgetsById,
        skillActivations: message.skillActivations,
        currentStage: message.currentStage,
        visitedStages: message.visitedStages,
        terminalReason: message.terminalReason,
    };
};

const fromSnapshotMessage = (message: SessionSnapshotMessage): ChatMessage => {
    const { timestamp } = message as { timestamp?: unknown };
    const stamp = typeof timestamp === 'number' && Number.isFinite(timestamp) ? { timestamp } : {};
    if (message.role === 'user') {
        return {
            ...stamp,
            id: message.id,
            role: 'user',
            content: message.content,
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        };
    }

    return {
        ...stamp,
        id: message.id,
        role: 'agent',
        content: message.content,
        transientContent: '',
        reasoningContent: message.reasoningContent || '',
        messageId: message.messageId || message.id,
        toolCallsById: message.toolCallsById || {},
        widgetsById: message.widgetsById || {},
        skillActivations: (message.skillActivations || []) as SkillActivation[],
        currentStage: message.currentStage || 'sent',
        visitedStages: message.visitedStages?.length ? message.visitedStages : ['sent'],
        terminalReason: message.terminalReason ?? null,
    };
};

type RunStreamStarter = (
    onEvent: (event: SSEEvent) => void,
    onError: (err: unknown) => void,
    onFinish: () => void,
    sessionId: string,
    stream: ChatStreamOptions,
) => RuntimeChatHandle;

const dedupeSkillActivations = (skills: SkillActivation[]) => {
    const seen = new Set<string>();
    return skills.filter((skill) => {
        const key = [skill.name, skill.source, skill.command_text, skill.location].join('|');
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

export const getToolHintLabel = (tool: ToolCallState, t: (key: string) => string) => {
    if (tool.progressText) {
        return tool.progressText;
    }
    if (tool.name === 'load_skill' && tool.status === 'done' && tool.isError !== true) {
        const details = tool.details && typeof tool.details === 'object' && !Array.isArray(tool.details)
            ? tool.details as { nativeSkill?: unknown }
            : undefined;
        if (typeof details?.nativeSkill === 'string' && details.nativeSkill.trim()) {
            return t('chat.skillLoaded').replace('{name}', details.nativeSkill);
        }
    }
    const key = tool.status === 'done' ? 'chat.toolCompleted' : tool.status === 'error' ? 'chat.toolFailed' : 'chat.toolCalling';
    return t(key).replace('{name}', tool.name);
};

const getSkillHintLabel = (skill: SkillActivation, t: (key: string) => string) => t('chat.skillActivated').replace('{name}', skill.name);


interface ActiveChatAreaProps extends ChatAreaProps {
    activeTask: Task;
    activeSession: Session;
}

const ActiveChatArea: React.FC<ActiveChatAreaProps> = ({
    activeTask: currentTask,
    activeSession: currentSession,
    onUpdateTools,
    onOpenToolPanel,
    onToggleToolPanel,
    isToolPanelOpen = false,
    hasTools = false,
    onModelNotConfigured,
}) => {
    const {
        currentTranscript,
        attachedFiles,
        setAttachedFiles,
        clearAttachedFiles,
        setCurrentTranscript,
    } = useSession();

    const { t } = useLanguage();
    // Until a model and a database are both set up, the empty page walks the user through them first.
    const { ready: setupDone } = useReadiness();

    const [inputValue, setInputValue] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>(() => currentTranscript.map(fromSnapshotMessage));
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamConnection, setStreamConnection] = useState<RuntimeConnectionState>('connected');
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState(false);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    // interrupted: the run ended with a server that went away; nothing reported how.
    // rejected: the server refused to stream the session's events (signed out, no access).
    const [runReason, setRunReason] = useState<'completed' | 'stopped' | 'error' | 'interrupted' | 'rejected' | null>(null);
    const [pendingClarification, setPendingClarification] = useState<ClarificationRequest | null>(null);
    const [clarificationInput, setClarificationInput] = useState('');
    const [isSubmittingClarification, setIsSubmittingClarification] = useState(false);

    const currentSessionIdRef = useRef(currentSession.id);
    const activeAgentMessageIdRef = useRef<string | null>(null);
    const pendingAgentMessageIdRef = useRef<string | null>(null);
    const agentBufferRef = useRef<Record<string, AgentMessage>>({});
    const onUpdateToolsRef = useRef(onUpdateTools);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const chatContainerRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const clarificationInputRef = useRef<HTMLTextAreaElement>(null);
    const streamHandleRef = useRef<RuntimeChatHandle | null>(null);
    const isRestoringRef = useRef(false);

    useEffect(() => {
        onUpdateToolsRef.current = onUpdateTools;
    }, [onUpdateTools]);

    /** Replace the rendered conversation with a server snapshot and rebuild the live buffers from it. */
    const replaceWithSnapshot = useCallback((snapshot: SessionSnapshotMessage[]) => {
        const restoredMessages = snapshot.map(fromSnapshotMessage);
        setMessages(restoredMessages);
        activeAgentMessageIdRef.current = null;
        pendingAgentMessageIdRef.current = null;
        agentBufferRef.current = {};
        restoredMessages.forEach((message) => {
            if (message.role === 'agent') {
                agentBufferRef.current[message.messageId] = {
                    ...message,
                    toolCallsById: { ...message.toolCallsById },
                    widgetsById: { ...message.widgetsById },
                    skillActivations: [...message.skillActivations],
                    visitedStages: [...message.visitedStages],
                };
            }
        });
    }, []);

    /**
     * Live events were lost (the stream fell behind the server's buffer). Reload
     * what the server has committed; the message still streaming is only
     * complete once committed, so the caller reloads again when the run ends.
     */
    const resyncFromServer = useCallback(async (sessionId: string) => {
        try {
            const snapshot = await getTranscriptViaRuntime(sessionId);
            if (currentSessionIdRef.current === sessionId) replaceWithSnapshot(snapshot);
        } catch (error) {
            console.error('Failed to resynchronize the session transcript', error);
        }
    }, [replaceWithSnapshot]);

    useEffect(() => {
        // Stop following the previous session's run; it keeps running on the server.
        streamHandleRef.current?.detach();
        streamHandleRef.current = null;
        isRestoringRef.current = true;
        currentSessionIdRef.current = currentSession.id;
        replaceWithSnapshot(currentTranscript);
        setIsStreaming(false);
        setStreamConnection('connected');
        setRunReason(null);
        setPendingClarification(null);
        setClarificationInput('');
        setIsSubmittingClarification(false);
        onUpdateToolsRef.current?.([]);

        // A run may still be going (or waiting on a clarification): resume following it.
        const sessionId = currentSession.id;
        let superseded = false;
        void getSessionStateViaRuntime(sessionId).then((state) => {
            if (superseded || currentSessionIdRef.current !== sessionId || streamHandleRef.current) return;
            if (state.pendingClarification) {
                setPendingClarification({
                    clarification_id: state.pendingClarification.clarificationId,
                    question: state.pendingClarification.question,
                    options: state.pendingClarification.options,
                });
            }
            if (!state.inProgressRun) return;
            const runId = state.inProgressRun.runId;
            replaceWithSnapshot(state.messages);
            setIsStreaming(true);
            followRun(sessionId, (onEvent, onError, onFinish, streamSessionId, stream) => (
                attachRunViaRuntime(runId, { sequence: state.eventSequence, ...(state.eventInstance ? { instance: state.eventInstance } : {}) }, onEvent, onError, onFinish, streamSessionId, stream)
            ), true);
        }).catch((error) => console.error('Failed to read the session state', error));
        return () => { superseded = true; };
    }, [currentSession.id, replaceWithSnapshot]);

    useEffect(() => {
        if (isRestoringRef.current) {
            isRestoringRef.current = false;
            return;
        }
        setCurrentTranscript(currentSessionIdRef.current, messages.map(toSnapshotMessage));
    }, [messages, setCurrentTranscript]);

    useEffect(() => {
        const allTools = messages.flatMap((message) => {
            if (message.role !== 'agent') return [];
            return Object.values(message.toolCallsById).map((tool) => ({
                toolCallId: tool.toolCallId,
                messageId: message.messageId,
                name: tool.name,
                args: tool.arguments,
                result: tool.result,
                details: tool.details,
                status: tool.status,
                widgetId: tool.widgetId,
                widget: tool.widgetId ? message.widgetsById[tool.widgetId] : undefined,
            }));
        });
        onUpdateToolsRef.current?.(allTools);
    }, [messages]);

    useEffect(() => {
        if (shouldAutoScroll) {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, shouldAutoScroll, pendingClarification]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.style.height = '0px';
        const nextHeight = Math.min(textarea.scrollHeight, 160);
        textarea.style.height = `${Math.max(nextHeight, 40)}px`;
    }, [inputValue]);

    // 监听 iframe 的 postMessage 事件（用于 HTML 看板下钻）
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const { type, dimension, value, chartTitle, targetLevel } = event.data;

            if (type === 'drill_down') {
                // 自动发送下钻查询
                const drillMessage = `请下钻分析"${chartTitle}"中【${value}】的明细数据，按 ${dimension} 维度展开`;
                setInputValue(drillMessage);
                // 自动发送
                setTimeout(() => {
                    void handleSend(drillMessage);
                }, 100);
            } else if (type === 'navigate_back') {
                // 自动发送回退查询
                const backMessage = `返回查看"${targetLevel}"层级的数据概览`;
                setInputValue(backMessage);
                // 自动发送
                setTimeout(() => {
                    void handleSend(backMessage);
                }, 100);
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    const handleScroll = () => {
        if (!chatContainerRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
        setShouldAutoScroll(scrollHeight - scrollTop - clientHeight < 100);
    };

    const ensureBufferedAgentMessage = (messageId: string) => {
        if (!agentBufferRef.current[messageId]) {
            agentBufferRef.current[messageId] = createLocalAgentMessage(messageId);
        }
        return agentBufferRef.current[messageId];
    };

    const flushBufferedMessage = (messageId: string) => {
        const buffered = agentBufferRef.current[messageId];
        if (!buffered) return;
        const snapshot: AgentMessage = {
            ...buffered,
            toolCallsById: { ...buffered.toolCallsById },
            widgetsById: { ...buffered.widgetsById },
            skillActivations: [...buffered.skillActivations],
            visitedStages: [...buffered.visitedStages],
        };
        setMessages((prev) => {
            const index = prev.findIndex((msg) => msg.role === 'agent' && msg.messageId === messageId);
            const empty = isAgentMessageEmpty(snapshot);
            if (index === -1) {
                return empty ? prev : [...prev, snapshot];
            }
            if (empty) {
                return prev.filter((msg) => !(msg.role === 'agent' && msg.messageId === messageId));
            }
            const next = [...prev];
            next[index] = snapshot;
            return next;
        });
    };

    const flushAllBuffers = () => {
        Object.keys(agentBufferRef.current).forEach(flushBufferedMessage);
    };

    const markTerminalReason = (reason: Exclude<AgentTerminalReason, null>) => {
        const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current;
        if (!targetId) {
            return;
        }
        const message = ensureBufferedAgentMessage(targetId);
        agentBufferRef.current[targetId] = setTerminalReason(message, reason);
        flushBufferedMessage(targetId);
    };

    const promoteStage = (messageId: string, stage: AgentProgressStage) => {
        const message = ensureBufferedAgentMessage(messageId);
        agentBufferRef.current[messageId] = advanceStage(message, stage);
    };

    const handleStop = async () => {
        if (!isStreaming) return;
        try {
            await stopAgentViaRuntime(currentSession.id);
        } catch (err) {
            console.error('Failed to stop agent:', err);
        }
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    const handleUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;

        setIsUploading(true);
        setUploadError(false);
        const uploadedPaths: string[] = [];
        try {
            for (const file of Array.from(files)) {
                const uploaded = await uploadWorkspaceFile(file, currentSession.id);
                uploadedPaths.push(uploaded.relative_path);
            }
        } catch (err) {
            console.error('Failed to upload files:', err);
            setUploadError(true);
        } finally {
            // Keep whatever did upload attached, even when a later file failed.
            if (uploadedPaths.length > 0) setAttachedFiles([...attachedFiles, ...uploadedPaths]);
            setIsUploading(false);
            event.target.value = '';
        }
    };

    const handleSend = async (overrideContent?: string) => {
        const content = (overrideContent ?? inputValue).trim();
        if (!content) return;

        void currentSession.id;
        // Attachments go with a new prompt; a steer while running carries text only.
        const attachments = isStreaming ? [] : [...attachedFiles];
        const userMsg: UserMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            timestamp: Date.now(),
            content,
            ...(attachments.length > 0 ? { attachments } : {}),
        };

        setMessages((prev) => [...prev, userMsg]);
        setInputValue('');
        setShouldAutoScroll(true);

        if (isStreaming) {
            flushAllBuffers();
            try {
                await steerAgentViaRuntime(content, currentSession.id);
            } catch (err) {
                console.error('Failed to steer agent:', err);
            }
            return;
        }

        setIsStreaming(true);
        setRunReason(null);
        setPendingClarification(null);
        setClarificationInput('');
        activeAgentMessageIdRef.current = null;
        pendingAgentMessageIdRef.current = `pending-${Date.now()}`;
        promoteStage(pendingAgentMessageIdRef.current, 'sent');
        flushBufferedMessage(pendingAgentMessageIdRef.current);

        if (attachments.length > 0) clearAttachedFiles();
        followRun(currentSession.id, (onEvent, onError, onFinish, sessionId, stream) => sendChatViaRuntime(content, onEvent, onError, onFinish, sessionId, stream, attachments));
    };

    /**
     * Streams one run into the conversation: a new prompt, or a run that was
     * already running when the session was opened. `lostEvents` means the
     * live view starts incomplete, so the transcript is reloaded when it ends.
     */
    const followRun = (runSessionId: string, start: RunStreamStarter, lostEvents = false) => {
        let lastUpdateTime = Date.now();
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const scheduleFlush = (messageId?: string, immediate = false) => {
            if (!messageId) return;
            const now = Date.now();
            if (immediate || now - lastUpdateTime > 60) {
                flushBufferedMessage(messageId);
                lastUpdateTime = now;
                if (flushTimer) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
                return;
            }
            if (!flushTimer) {
                flushTimer = setTimeout(() => {
                    flushBufferedMessage(messageId);
                    lastUpdateTime = Date.now();
                    flushTimer = null;
                }, 60);
            }
        };

        let streamLostEvents = lostEvents;
        const handle: RuntimeChatHandle = start(
            (event: SSEEvent) => {
                if (event.session_id && event.session_id !== currentSessionIdRef.current) {
                    return;
                }

                if (event.type === 'workspace_updated') {
                    window.dispatchEvent(new CustomEvent('workspace_updated'));
                    return;
                }

                if (event.type === 'clarification_request') {
                    setPendingClarification({
                        clarification_id: event.clarification_id,
                        question: event.question,
                        options: event.options || [],
                    });
                    setClarificationInput('');
                    setShouldAutoScroll(true);
                    return;
                }

                if (event.type === 'clarification_settled') {
                    setPendingClarification((current) => (
                        current?.clarification_id === event.clarification_id ? null : current
                    ));
                    setClarificationInput('');
                    return;
                }

                if (event.type === 'status') {
                    const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current;
                    if (!targetId) {
                        return;
                    }
                    const targetMessage = ensureBufferedAgentMessage(targetId);
                    targetMessage.statusNotice = event.message || event.phase;
                    scheduleFlush(targetId, true);
                    return;
                }

                if (event.type === 'auto_retry') {
                    const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current;
                    if (!targetId) {
                        return;
                    }
                    const targetMessage = ensureBufferedAgentMessage(targetId);
                    targetMessage.retryNotice = t('chat.retryNotice')
                        .replace('{operation}', event.operation)
                        .replace('{attempt}', String(event.attempt))
                        .replace('{max}', String(event.max_attempts))
                        .replace('{delay}', String(event.delay_seconds));
                    scheduleFlush(targetId, true);
                    return;
                }

                if (event.type === 'done') {
                    setRunReason(event.reason);
                    setPendingClarification(null);
                    setClarificationInput('');
                    markTerminalReason(event.reason);
                    flushAllBuffers();
                    return;
                }

                if (event.type === 'error') {
                    setRunReason('error');
                    const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current ?? `error-${Date.now()}`;
                    activeAgentMessageIdRef.current = targetId;
                    const message = ensureBufferedAgentMessage(targetId);
                    const advanced = setTerminalReason(advanceStage(message, 'generating_answer'), 'error');
                    advanced.content += `${advanced.content ? '\n\n' : ''}**${t('chat.requestFailed')}**\n\n${t('chat.retryHint')}`;
                    agentBufferRef.current[targetId] = advanced;
                    scheduleFlush(targetId, true);
                    return;
                }

                if (event.type === 'progress') {
                    const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current;
                    if (!targetId) {
                        return;
                    }
                    promoteStage(targetId, event.stage);
                    scheduleFlush(targetId, true);
                    return;
                }

                if (event.type === 'message_start') {
                    const pendingId = pendingAgentMessageIdRef.current;
                    if (pendingId && pendingId !== event.message_id && agentBufferRef.current[pendingId]) {
                        const pendingBuffer = agentBufferRef.current[pendingId];
                        const renamedBuffer: AgentMessage = {
                            ...pendingBuffer,
                            id: `local-${event.message_id}`,
                            messageId: event.message_id,
                            visitedStages: [...pendingBuffer.visitedStages],
                        };
                        delete agentBufferRef.current[pendingId];
                        agentBufferRef.current[event.message_id] = renamedBuffer;
                        setMessages((prev) => prev.map((item) => (
                            item.role === 'agent' && item.messageId === pendingId
                                ? renamedBuffer
                                : item
                        )));
                    }
                    activeAgentMessageIdRef.current = event.message_id;
                    pendingAgentMessageIdRef.current = null;
                    ensureBufferedAgentMessage(event.message_id);
                    scheduleFlush(event.message_id, true);
                    return;
                }

                const targetMessageId = ('message_id' in event && event.message_id)
                    ? event.message_id
                    : (activeAgentMessageIdRef.current || pendingAgentMessageIdRef.current);
                if (!targetMessageId) return;

                const message = ensureBufferedAgentMessage(targetMessageId);

                if (event.type === 'text_delta') {
                    const advanced = advanceStage(message, 'generating_answer');
                    if (event.ephemeral) {
                        advanced.transientContent += event.content;
                    } else {
                        advanced.content += event.content;
                        advanced.transientContent = '';
                    }
                    agentBufferRef.current[targetMessageId] = advanced;
                    scheduleFlush(targetMessageId, false);
                    return;
                }

                if (event.type === 'reasoning_delta') {
                    const advanced = advanceStage(message, 'understanding');
                    advanced.reasoningContent += event.content;
                    agentBufferRef.current[targetMessageId] = advanced;
                    scheduleFlush(targetMessageId, false);
                    return;
                }

                if (event.type === 'tool_call') {
                    agentBufferRef.current[targetMessageId] = advanceStage(message, 'executing_query');
                    agentBufferRef.current[targetMessageId].toolCallsById[event.tool_call_id] = {
                        toolCallId: event.tool_call_id,
                        name: event.name,
                        arguments: event.arguments,
                        widgetId: event.widget_id ?? null,
                        status: 'calling',
                    };
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'tool_progress') {
                    const existing = message.toolCallsById[event.tool_call_id] || {
                        toolCallId: event.tool_call_id,
                        name: event.name,
                        arguments: {},
                        status: 'running' as const,
                    };
                    const phaseText: Record<typeof event.phase, string> = {
                        validating_sql: t('chat.phaseValidatingSql'),
                        running_query: t('chat.phaseRunningQuery'),
                        running: t('chat.phaseRunningTool'),
                        done: t('chat.phaseDoneTool'),
                        error: t('chat.phaseErrorTool'),
                    };
                    message.toolCallsById[event.tool_call_id] = {
                        ...existing,
                        name: event.name,
                        status: event.phase === 'done' ? 'done' : event.phase === 'error' ? 'error' : 'running',
                        progressText: `${phaseText[event.phase]}: ${event.name}`,
                    };
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'subagent_progress') {
                    const existing = message.toolCallsById[event.tool_call_id] || {
                        toolCallId: event.tool_call_id,
                        name: event.name,
                        arguments: {},
                        status: 'running' as const,
                    };
                    message.toolCallsById[event.tool_call_id] = { ...existing, subagentChildren: event.children };
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'widget_patch') {
                    const activeMessage = agentBufferRef.current[targetMessageId] || message;
                    const existing = activeMessage.widgetsById[event.widget_id] || {
                        widget_id: event.widget_id,
                        title: '组件预览',
                        kind: 'rich_text',
                    };
                    activeMessage.widgetsById[event.widget_id] = {
                        ...existing,
                        ...event.patch,
                        widget_id: event.widget_id,
                        status: 'previewing',
                    } as WidgetSpec;
                    const tool = activeMessage.toolCallsById[event.tool_call_id];
                    if (tool) {
                        tool.status = 'running';
                        tool.widgetId = event.widget_id;
                    }
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'widget') {
                    message.widgetsById[event.widget_id] = {
                        ...event.widget,
                        widget_id: event.widget_id,
                        status: 'ready',
                    };
                    const tool = message.toolCallsById[event.tool_call_id];
                    if (tool) {
                        tool.status = 'running';
                        tool.widgetId = event.widget_id;
                    }
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'widget_done') {
                    const tool = message.toolCallsById[event.tool_call_id];
                    if (tool) {
                        tool.status = 'done';
                    }
                    const widget = message.widgetsById[event.widget_id];
                    if (widget) {
                        widget.status = 'ready';
                    }
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'widget_remove') {
                    delete message.widgetsById[event.widget_id];
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'widget_error') {
                    const existing = message.widgetsById[event.widget_id] || {
                        widget_id: event.widget_id,
                        title: '组件错误',
                        kind: 'rich_text',
                    };
                    message.widgetsById[event.widget_id] = {
                        ...existing,
                        status: 'error',
                        error: event.error,
                    } as WidgetSpec;
                    const tool = message.toolCallsById[event.tool_call_id];
                    if (tool) {
                        tool.status = 'error';
                        tool.widgetId = event.widget_id;
                    }
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'tool_result') {
                    message.toolCallsById[event.tool_call_id] = mergeToolResultState(
                        message.toolCallsById[event.tool_call_id],
                        event,
                    );
                    scheduleFlush(targetMessageId, true);
                    return;
                }

                if (event.type === 'skill_activated') {
                    const targetId = activeAgentMessageIdRef.current ?? pendingAgentMessageIdRef.current;
                    if (!targetId) return;
                    const targetMessage = ensureBufferedAgentMessage(targetId);
                    targetMessage.skillActivations = dedupeSkillActivations([
                        ...targetMessage.skillActivations,
                        {
                            name: event.skill.name,
                            description: event.skill.description,
                            when_to_use: event.skill.when_to_use,
                            location: event.skill.location,
                            source_scope: event.skill.source_scope,
                            granted_permissions: event.skill.granted_permissions,
                            model_override: event.skill.model_override,
                            ui_message: event.skill.ui_message,
                            source: event.skill.source,
                            command_text: event.skill.command_text,
                            skill_dir: event.skill.skill_dir,
                        },
                    ]);
                    scheduleFlush(targetId, true);
                }
            },
            (err) => {
                console.error('Chat error:', err);
                if (isModelNotConfiguredError(err)) onModelNotConfigured?.();
                setRunReason('error');
                setPendingClarification(null);
                setIsStreaming(false);
            },
            () => {
                endRun();
                if (streamLostEvents) void resyncFromServer(runSessionId);
            },
            runSessionId,
            {
                // Callbacks run after start() returned (the stream connects asynchronously), so `handle` is set.
                onResync: (reason) => {
                    streamLostEvents = true;
                    void resyncRun(runSessionId, handle, reason, endRun);
                },
                onConnectionChange: (state) => {
                    if (state !== 'rejected') {
                        setStreamConnection(state);
                        return;
                    }
                    // Retrying cannot help: stop following, and say why.
                    if (streamHandleRef.current !== handle) return;
                    handle.detach();
                    endRun();
                    setRunReason('rejected');
                },
            },
        );
        /** Every way a followed run ends locally: flush what was buffered and stop following. */
        function endRun() {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            flushAllBuffers();
            setIsStreaming(false);
            setIsSubmittingClarification(false);
            activeAgentMessageIdRef.current = null;
            pendingAgentMessageIdRef.current = null;
            streamHandleRef.current = null;
            setStreamConnection('connected');
        }
        streamHandleRef.current = handle;
    };

    /**
     * After a resync, one session state read tells what became of the run
     * being followed. Still in progress: reload the conversation from that
     * state and follow on. Over (no run, or another one): the run ended while
     * its events were not followed, so the conversation is reloaded from the
     * server and the turn closes. Only a server restart makes that ending an
     * interruption; evicted events mean it finished normally. A run whose id
     * is not known yet (its prompt is still being dispatched) is left to the
     * dispatch.
     */
    const resyncRun = async (sessionId: string, handle: RuntimeChatHandle, reason: RuntimeResyncReason, endRun: () => void) => {
        const current = () => streamHandleRef.current === handle && currentSessionIdRef.current === sessionId;
        let state: RuntimeSessionState | undefined;
        for (let attempt = 0; attempt < RESYNC_ATTEMPTS && current(); attempt += 1) {
            try {
                state = await getSessionStateViaRuntime(sessionId);
                break;
            } catch (error) {
                console.error('Failed to read the session state for a resync', error);
                if (attempt < RESYNC_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, RESYNC_RETRY_MS * 2 ** attempt));
            }
        }
        if (!current()) return;
        const followed = handle.runId();
        if (state) {
            if (followed === undefined) return;
            if (state.inProgressRun?.runId === followed) {
                replaceWithSnapshot(state.messages);
                return;
            }
        } else if (reason !== 'restarted') {
            // Unreadable after every attempt: only a restart is reason enough to stop following.
            return;
        }
        handle.detach();
        endRun();
        setPendingClarification(null);
        if (state) replaceWithSnapshot(state.messages);
        // After a restart the run was cut off. Otherwise it ended unseen: the server's
        // transcript tells a failure; how else it ended is not known, so no status is claimed.
        const lastAgent = state?.messages.filter((message) => message.role === 'agent').at(-1);
        setRunReason(reason === 'restarted' ? 'interrupted' : lastAgent?.terminalReason === 'error' ? 'error' : null);
    };

    const handlePrimaryAction = async () => {
        if (isStreaming && !inputValue.trim()) {
            await handleStop();
            return;
        }
        await handleSend();
    };

    const handleSubmitClarification = async (answerText?: string) => {
        if (!pendingClarification || isSubmittingClarification) return;
        const answer = (answerText ?? clarificationInput).trim();
        if (!answer) return;

        setIsSubmittingClarification(true);
        try {
            // The answer reaches the agent as the tool result; it is not a chat turn.
            await answerClarificationViaRuntime(pendingClarification.clarification_id, answer, currentSession.id);
            setPendingClarification((current) => (
                current?.clarification_id === pendingClarification.clarification_id ? null : current
            ));
            setClarificationInput('');
        } catch (err) {
            console.error('Failed to answer clarification:', err);
        } finally {
            setIsSubmittingClarification(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Enter that confirms an IME candidate (pinyin and the like) is not a send.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (inputValue.trim()) {
                void handleSend();
            }
        }
    };

    const handleClarificationKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void handleSubmitClarification();
        }
    };


    const latestAgentMessage = [...messages].reverse().find((message): message is AgentMessage => message.role === 'agent');
    const chatItems = (() => {
        const items = groupIntoTurns<UserMessage, AgentMessage>(messages);
        // A run that has not produced a step yet still shows that it is working.
        const last = items[items.length - 1];
        if ((isStreaming || runReason === 'interrupted' || runReason === 'rejected') && last?.kind === 'user') {
            items.push({ kind: 'turn', key: `turn-${last.message.id}`, ...(last.message.timestamp !== undefined ? { startedAt: last.message.timestamp } : {}), agents: [] });
        }
        return items;
    })();
    // One notice for the latest turn: the run was interrupted, or its event stream is down.
    const turnNotice = runReason === 'interrupted'
        ? t('chat.runInterrupted')
        : runReason === 'rejected'
            ? t('chat.streamRejected')
            : !isStreaming || streamConnection === 'connected'
                ? ''
                : t(streamConnection === 'disconnected' ? 'chat.streamDisconnected' : 'chat.streamReconnecting');
    const liveStatus = runReason === 'error'
        ? `${t('chat.requestFailed')} ${t('chat.retryHint')}`
        : turnNotice || latestAgentMessage?.statusNotice || latestAgentMessage?.retryNotice;

    return (
        <main id="main-content" className="relative flex h-full min-w-0 flex-auto flex-col overflow-hidden bg-transparent" aria-labelledby="chat-page-title">
            <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--frame-surface)] px-6 text-[0.85rem] font-medium text-[var(--text-secondary)] max-[720px]:px-3">
                <h1 id="chat-page-title" className="sr-only">{t('chat.pageTitle')}</h1>
                <div className="flex min-w-0 flex-auto items-center gap-2 overflow-hidden max-[480px]:gap-[5px]">
                    <span className="-ml-1 inline-flex items-center justify-center p-1 text-[var(--text-secondary)]" aria-hidden="true">
                        <AgentOrbitIcon
                            size={32}
                            className={`shrink-0 transition-colors ${isStreaming ? 'text-[var(--accent-color)]' : 'text-[#9ca3af]'}`}
                            animated={isStreaming}
                        />
                    </span>
                    <span className="shrink-0 font-bold tracking-[-0.02em] whitespace-nowrap text-[#1f2937]">{t('chat.breadcrumbRoot')}</span>
                    <span className="mx-1 shrink-0 text-[var(--border-medium)]">/</span>
                    <span className="max-w-[180px] truncate text-[#475569] max-[480px]:max-w-[76px]">{currentTask.name}</span>
                    <span className="mx-1 shrink-0 text-[var(--border-medium)]">/</span>
                    <span className="max-w-[340px] min-w-0 shrink truncate font-medium max-[480px]:max-w-[76px]">{currentSession.name}</span>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        className={`group/details inline-flex h-[34px] shrink-0 cursor-pointer items-center gap-0 rounded-none border-0 bg-transparent px-2 whitespace-nowrap transition-[background-color,border-color,color,transform] focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-strong)] disabled:cursor-not-allowed disabled:opacity-45 enabled:active:scale-[0.97] motion-reduce:transition-none motion-reduce:enabled:active:scale-100 ${isToolPanelOpen ? 'text-[var(--accent-strong)]' : 'text-[#78716c] pointer-fine:enabled:hover:text-[#1f2937]'}`}
                        onClick={onToggleToolPanel}
                        aria-pressed={isToolPanelOpen}
                        disabled={!hasTools && !isToolPanelOpen}
                        aria-label={isToolPanelOpen ? t('chat.closeDetails') : t('chat.openDetails')}
                    >
                        <IdCard size={17} aria-hidden="true" />
                        <span className="inline-block max-w-0 overflow-hidden text-[0.82rem] whitespace-nowrap opacity-0 transition-[max-width,opacity,margin] group-focus-visible/details:ml-1.5 group-focus-visible/details:max-w-[8em] group-focus-visible/details:opacity-100 group-enabled/details:group-hover/details:ml-1.5 group-enabled/details:group-hover/details:max-w-[8em] group-enabled/details:group-hover/details:opacity-100 motion-reduce:transition-none max-[720px]:hidden" aria-hidden="true">{t('chat.details')}</span>
                    </button>
                </div>
            </header>
            <div className="sr-only" role={runReason === 'error' ? 'alert' : 'status'} aria-live={runReason === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
                {liveStatus}
            </div>

            <div
                ref={chatContainerRef}
                onScroll={handleScroll}
                className="scrollable-area flex min-h-0 flex-1 flex-col gap-8 bg-[var(--frame-surface)] py-6 pr-7 pl-6 [scrollbar-gutter:stable] max-[720px]:gap-5 max-[720px]:py-4 max-[720px]:pr-4 max-[720px]:pl-3"
            >
                {messages.length === 0 && (
                    <div className={`${setupDone ? 'mt-[clamp(40px,9vh,96px)]' : 'mt-[clamp(8px,3vh,32px)]'} flex w-[min(720px,100%)] flex-col gap-2.5 self-center`}>
                        {setupDone ? (<>
                        <span className="animate-rise-sm font-mono text-[0.75rem] text-[#a8a29e] motion-reduce:animate-none" aria-hidden="true">-- {t('chat.starterCaption')}</span>
                        <h2 className="m-0 animate-rise-sm text-[clamp(1.5rem,2.4vw,1.95rem)] leading-[1.2] font-[650] tracking-[-0.02em] text-balance text-[#1c1917] [animation-delay:40ms] [animation-duration:480ms] motion-reduce:animate-none">{t('chat.starterTitle')}</h2>
                        <p className="m-0 animate-rise-sm text-[length:var(--font-size-body-sm)] leading-[1.65] text-pretty text-[#78716c] [animation-delay:80ms] [animation-duration:480ms] motion-reduce:animate-none">{t('chat.starterHint')}</p>
                        </>) : (<>
                        <SetupChecklist />
                        <p className="m-0 mt-5 text-[0.8rem] text-[#a8a29e]">{t('setup.examplesLocked')}</p>
                        </>)}
                        <div className={`grid grid-cols-2 gap-2.5 max-[720px]:grid-cols-1 ${setupDone ? 'mt-[22px]' : 'opacity-50'}`}>
                            {STARTER_PROMPTS.map((kind, index) => (
                                <button
                                    key={kind}
                                    type="button"
                                    className="group/starter relative flex min-h-[92px] [font:inherit] animate-rise-sm cursor-pointer flex-col disabled:pointer-events-none items-start gap-2 rounded-[14px] border border-[var(--hairline)] bg-white py-4 pr-11 pl-[18px] text-left text-[#1c1917] transition-[border-color,box-shadow,transform,background-color] [animation-delay:calc(140ms+var(--i)*60ms)] [animation-duration:480ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-strong)] active:scale-[0.985] motion-reduce:animate-none motion-reduce:transition-none max-[720px]:min-h-0 pointer-fine:hover:-translate-y-0.5 pointer-fine:hover:border-[#e2e0dc] pointer-fine:hover:bg-[#fffdfb] pointer-fine:hover:shadow-[0_1px_2px_rgba(28,25,23,0.04),0_12px_32px_-20px_rgba(28,25,23,0.28)]"
                                    style={{ '--i': index } as React.CSSProperties}
                                    disabled={!setupDone}
                                    onClick={() => {
                                        // Examples are generic; the user adapts one to their own data before sending.
                                        setInputValue(t(`chat.starter.${kind}.prompt`));
                                        textareaRef.current?.focus();
                                    }}
                                >
                                    <span className="inline-flex items-baseline gap-2 text-[0.75rem] font-semibold text-[#78716c]">
                                        <span className="font-mono text-[0.7rem] font-medium text-[#c2410c]" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                                        {t(`chat.starter.${kind}.label`)}
                                    </span>
                                    <span className="text-[0.925rem] leading-[1.55] text-[#1c1917]">{t(`chat.starter.${kind}.prompt`)}</span>
                                    <ChevronRight size={16} className="absolute right-4 bottom-4 -translate-x-1.5 text-[#a8a29e] opacity-0 transition-[opacity,transform,color] group-focus-visible/starter:translate-x-0 group-focus-visible/starter:opacity-100 motion-reduce:transition-none max-[720px]:top-1/2 max-[720px]:bottom-auto max-[720px]:-mt-[7px] max-[720px]:translate-x-0 max-[720px]:opacity-100 pointer-fine:group-hover/starter:translate-x-0 pointer-fine:group-hover/starter:text-[#c2410c] pointer-fine:group-hover/starter:opacity-100" aria-hidden="true" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {chatItems.map((item, index) => (
                    item.kind === 'user' ? (
                        <div key={item.message.id} className={USER_ROW} data-message-role="user">
                            <div className="flex min-w-0 flex-col items-end gap-1.5">
                                <div className="rounded-[var(--bubble-radius)] border-0 bg-[var(--bubble-bg)] px-4 py-3 text-[0.95rem] leading-[1.6] wrap-anywhere whitespace-pre-wrap text-[#1f2937] shadow-none in-[:lang(zh-CN)]:leading-[1.75]">
                                    {item.message.content}
                                </div>
                                {item.message.attachments && item.message.attachments.length > 0 && (
                                    <ul className="m-0 flex list-none flex-wrap justify-end gap-1.5 p-0" aria-label={t('chat.attachedFiles')}>
                                        {item.message.attachments.map((file) => (
                                            <li key={file} className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-[var(--border-light)] bg-white py-1 pr-2 pl-2.5 text-[0.8rem] text-[var(--text-secondary)] [&>span]:min-w-0 [&>span]:truncate" title={file}>
                                                <FileIcon filename={file} size={14} />
                                                <span>{file}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <div className="mt-[7.5px] flex size-8 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(145deg,#111827,#374151)] text-sm font-semibold text-white shadow-[0_12px_24px_-18px_rgba(17,24,39,0.9)]">U</div>
                        </div>
                    ) : (
                        <AgentTurn
                            key={item.key}
                            agents={item.agents}
                            running={isStreaming && index === chatItems.length - 1}
                            startedAt={item.startedAt}
                            currentSessionId={currentSession.id}
                            connectionNotice={index === chatItems.length - 1 ? turnNotice : ''}
                            toolLabel={(tool) => getToolHintLabel(tool, t)}
                            skillLabel={(skill) => getSkillHintLabel(skill as SkillActivation, t)}
                            onOpenToolPanel={onOpenToolPanel}
                        />
                    )
                ))}

                {pendingClarification && (
                    <div className={AGENT_ROW} role="alert" aria-live="assertive">
                        <div className={agentIcon(false)}>
                            <AgentOrbitIcon size={32} animated={false} className={AGENT_ICON_SVG} />
                        </div>
                        <div className={MESSAGE_COLUMN}>
                            <div className="rounded-[var(--bubble-radius)] bg-[var(--bubble-bg)] px-3.5 py-3">
                                <div className="mb-1 text-[length:var(--font-size-caption)] font-semibold text-[var(--accent-strong)]">{t('chat.clarificationTitle')}</div>
                                <div className="text-[0.95rem] leading-[1.6] wrap-anywhere whitespace-pre-wrap text-[var(--text-primary)]">{pendingClarification.question}</div>
                                {pendingClarification.options.length > 0 && (
                                    <div className="mt-2.5 flex flex-col gap-1.5" role="radiogroup" aria-label={t('chat.clarificationOptions')}>
                                        {pendingClarification.options.map((option) => {
                                            const isSelected = clarificationInput === option;
                                            return (
                                                <button
                                                    key={option}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={isSelected}
                                                    className={`group/option flex w-full cursor-pointer items-start gap-2.5 rounded-[var(--radius-sm)] border bg-[var(--frame-surface)] px-3 py-2 text-left text-[length:var(--font-size-body-sm)] leading-normal text-[var(--text-primary)] transition-[border-color,background-color] disabled:cursor-not-allowed disabled:opacity-58 motion-reduce:transition-none ${isSelected ? 'border-[rgba(194,65,12,0.36)]' : 'border-[var(--hairline)] enabled:hover:border-[var(--border-medium)]'}`}
                                                    onClick={() => {
                                                        setClarificationInput(option);
                                                        clarificationInputRef.current?.focus();
                                                    }}
                                                    disabled={isSubmittingClarification}
                                                >
                                                    <span className={`mt-[3px] size-3.5 shrink-0 rounded-full transition-[border-color,border-width] motion-reduce:transition-none ${isSelected ? 'border-4 border-[var(--accent-strong)]' : 'border-[1.5px] border-[var(--border-medium)]'}`} aria-hidden="true" />
                                                    <span>{option}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                <div className="mt-2.5 flex items-end gap-2 rounded-[var(--radius-md)] border border-[var(--hairline)] bg-[var(--frame-surface)] py-1.5 pr-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-[rgba(194,65,12,0.36)] focus-within:shadow-[var(--shadow-ring)] motion-reduce:transition-none">
                                    <textarea
                                        ref={clarificationInputRef}
                                        className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent py-[7px] text-[length:var(--font-size-body-sm)] leading-normal text-[var(--text-primary)] outline-none [field-sizing:content] placeholder:text-[var(--text-placeholder)]"
                                        rows={1}
                                        value={clarificationInput}
                                        onChange={(e) => setClarificationInput(e.target.value)}
                                        onKeyDown={handleClarificationKeyDown}
                                        aria-label={t('chat.inputAnswer')}
                                        placeholder={pendingClarification.options.length > 0 ? t('chat.clarificationEditHint') : t('chat.inputAnswer')}
                                        disabled={isSubmittingClarification}
                                    />
                                    <button
                                        type="button"
                                        className={sendButton(clarificationInput.trim() ? 'ready' : 'idle', 'size-8 rounded-[10px]')}
                                        onClick={() => void handleSubmitClarification()}
                                        disabled={isSubmittingClarification || !clarificationInput.trim()}
                                        aria-label={isSubmittingClarification ? t('chat.submitting') : t('chat.submit')}
                                    >
                                        <Send size={16} aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            <div className="bg-[var(--frame-surface)] px-11 pt-5 pb-7 max-[1100px]:px-7 max-[1100px]:pt-6 max-[1100px]:pb-8 max-[720px]:p-3">
                {attachedFiles.length > 0 && (
                    <ul className="m-0 mb-2 flex list-none flex-wrap gap-1.5 p-0" aria-label={t('chat.attachedFiles')}>
                        {attachedFiles.map((file) => (
                            <li key={file} className="inline-flex max-w-[260px] items-center gap-1.5 rounded-lg border border-[var(--border-light)] bg-white py-1 pr-2 pl-2.5 text-[0.8rem] text-[var(--text-secondary)] [&>span]:min-w-0 [&>span]:truncate" title={file}>
                                <FileIcon filename={file} size={14} />
                                <span>{file}</span>
                                <button
                                    type="button"
                                    className="grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-[5px] border-0 bg-transparent text-[var(--text-tertiary)] transition-colors hover:bg-[#f3f4f6] hover:text-[var(--text-primary)]"
                                    onClick={() => setAttachedFiles(attachedFiles.filter((item) => item !== file))}
                                    aria-label={t('chat.removeAttachment').replace('{name}', file)}
                                    title={t('chat.removeAttachment').replace('{name}', file)}
                                >
                                    <X size={12} />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="mb-2 flex items-center justify-between gap-4 text-[0.75rem] text-[#7c6b5e] max-[480px]:flex-col max-[480px]:items-start max-[480px]:gap-1">
                    {uploadError
                        ? <span className="text-[var(--status-error)]" role="alert">{t('chat.uploadFailed')}</span>
                        : <span>{isStreaming ? t('chat.steerHint') : null}</span>}
                    {runReason && <span>{t('chat.status') || '状态'}：{runReason === 'completed' ? t('tools.statusDone') : runReason === 'stopped' ? t('chat.stopped') || '已停止' : runReason === 'interrupted' || runReason === 'rejected' ? t('chat.interrupted') : t('tools.statusError')}</span>}
                </div>
                <div className="relative flex min-h-14 items-end gap-2 rounded-[20px] border border-[var(--hairline)] bg-[var(--surface-bg)] px-3 py-2 shadow-none transition-[border-color,box-shadow,transform] focus-within:border-[rgba(194,65,12,0.36)] focus-within:shadow-[var(--shadow-ring)] motion-reduce:transition-none">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={handleUploadChange}
                    />
                    <button
                        type="button"
                        className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border-0 bg-transparent text-[#6b7280] transition-[background-color,color,box-shadow,transform] disabled:cursor-not-allowed disabled:opacity-58 enabled:active:scale-[0.97] motion-reduce:transition-none motion-reduce:enabled:active:scale-100 pointer-fine:enabled:hover:bg-[rgba(120,53,15,0.07)] pointer-fine:enabled:hover:text-[#1f2937]"
                        onClick={handleUploadClick}
                        disabled={isUploading || isStreaming}
                        title={t('chat.uploadTooltip')}
                        aria-label={t('chat.uploadTooltip')}
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                    </button>
                    <textarea
                        ref={textareaRef}
                        className="max-h-40 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-[15px] leading-normal wrap-anywhere whitespace-pre-wrap text-[var(--text-primary)] outline-none placeholder:text-[var(--text-placeholder)]"
                        placeholder={isStreaming ? (t('chat.steerPlaceholder') || '执行中补充说明...') : t('chat.placeholder')}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={1}
                    />
                    <button
                        type="button"
                        className={sendButton(isStreaming && !inputValue.trim() ? 'stop' : inputValue.trim() ? 'ready' : 'idle')}
                        onClick={() => void handlePrimaryAction()}
                        disabled={isUploading || (!isStreaming && !inputValue.trim())}
                        title={isStreaming && !inputValue.trim() ? t('chat.stop') : t('chat.send')}
                        aria-label={isStreaming && !inputValue.trim() ? t('chat.stop') : t('chat.send')}
                    >
                        {isStreaming && !inputValue.trim() ? <Square size={18} /> : <Send size={18} />}
                    </button>
                </div>
            </div>
        </main>
    );
};

/** The send / stop button: grey while empty, ink when there is something to send, red while a run can be stopped. */
function sendButton(state: 'idle' | 'ready' | 'stop', size = 'size-9 rounded-xl'): string {
    const tone = state === 'ready'
        ? 'bg-[#1f2937] text-white shadow-[0_12px_26px_-16px_rgba(17,24,39,0.8)] pointer-fine:enabled:hover:-translate-y-px pointer-fine:enabled:hover:bg-[#111827]'
        : state === 'stop'
            ? 'bg-[#fee2e2] text-[#b91c1c] pointer-fine:enabled:hover:bg-[#fecaca]'
            : 'bg-[#f3f4f6] text-[#d1d5db]';
    return `inline-flex ${size} shrink-0 cursor-pointer items-center justify-center border-0 transition-[background-color,color,box-shadow,transform] disabled:cursor-not-allowed disabled:opacity-58 enabled:active:scale-[0.97] motion-reduce:transition-none motion-reduce:enabled:active:scale-100 ${tone}`;
}

const ChatArea: React.FC<ChatAreaProps> = (props) => {
    const { currentTask, currentSession, createSession, createTask } = useSession();
    const { t } = useLanguage();

    if (currentTask && currentSession) {
        return <ActiveChatArea {...props} activeTask={currentTask} activeSession={currentSession} />;
    }

    return (
        <main id="main-content" className="relative flex h-full min-w-0 flex-auto flex-col overflow-hidden bg-transparent" aria-labelledby="chat-page-title">
            <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--hairline)] bg-[var(--frame-surface)] px-6 text-[0.85rem] font-medium text-[var(--text-secondary)] max-[720px]:px-3">
                <h1 id="chat-page-title" className="sr-only">{t('chat.pageTitle')}</h1>
                <div className="flex min-w-0 flex-auto items-center gap-2 overflow-hidden max-[480px]:gap-[5px]">
                    <span className="-ml-1 inline-flex items-center justify-center p-1 text-[var(--text-secondary)]" aria-hidden="true">
                        <AgentOrbitIcon size={32} className="shrink-0 text-[#9ca3af]" animated={false} />
                    </span>
                    <span className="shrink-0 font-bold tracking-[-0.02em] whitespace-nowrap text-[#1f2937]">{t('chat.breadcrumbRoot')}</span>
                    {currentTask && (
                        <>
                            <span className="mx-1 shrink-0 text-[var(--border-medium)]">/</span>
                            <span className="max-w-[180px] truncate text-[#475569] max-[480px]:max-w-[76px]">{currentTask.name}</span>
                        </>
                    )}
                </div>
            </header>
            <div className="mt-[88px] flex w-[min(520px,100%)] flex-col items-center gap-3.5 self-center rounded-3xl border border-[rgba(120,53,15,0.1)] bg-white/58 px-[26px] py-[22px] text-center text-[#8a7a6d] shadow-[inset_0_1px_0_rgba(255,255,255,0.72)]">
                <div>{currentTask ? t('session.emptyPrompt') : t('task.emptyPrompt')}</div>
                <button type="button" className="inline-flex cursor-pointer items-center gap-[7px] rounded-[9px] [font:inherit] border border-[rgba(120,53,15,0.14)] bg-white px-[13px] py-2 text-[#475569] hover:border-[rgba(120,53,15,0.28)] hover:text-[#1f2937]" onClick={() => (currentTask ? createSession(currentTask.id) : createTask())}>
                    <Plus size={14} />
                    <span>{currentTask ? t('session.create') : t('task.startAsking')}</span>
                </button>
            </div>
        </main>
    );
};

export default ChatArea;
