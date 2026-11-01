import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Loader2,
    Send,
    Square,
    Paperclip,
    Plus,
    X,
    ChevronRight,
} from './icons/Typicons';
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
import { answerClarificationViaRuntime, getSessionStateViaRuntime, getTranscriptViaRuntime, steerAgentViaRuntime, stopAgentViaRuntime } from '../api/runtime-client';
import { attachRunViaRuntime, sendChatViaRuntime, type ChatStreamOptions, type RuntimeChatHandle } from '../api/chat-events';
import { isModelNotConfiguredError } from './ModelSetupPrompt';
import type { ToolData } from './ToolPanel';
import { useSession, type Session, type Task } from '../hooks/useSession';
import { useLanguage } from '../context/LanguageContext';
import WidgetRenderer from './widgets/WidgetRenderer';
import AgentOrbitIcon from './AgentOrbitIcon';
import { RiInfoCard } from './icons/RemixIcons';
import AgentMarkdown from './AgentMarkdown';
import { isAgentMessageEmpty, visibleAgentContent } from '../utils/agent-message';
import { mergeToolResultState, subagentChildrenOf, type ToolCallState } from './tool-event-state';
import SubagentProgressLines from './SubagentProgressLines';

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
}

interface UserMessage {
    id: string;
    role: 'user';
    content: string;
    attachments?: string[];
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

const setTerminalReason = (message: AgentMessage, reason: AgentTerminalReason): AgentMessage => ({
    ...message,
    terminalReason: reason,
});

const createLocalAgentMessage = (messageId: string): AgentMessage => ({
    id: `local-${messageId}`,
    role: 'agent',
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

const THINKING_STATUS_TEXT = '思考中';
const REASONING_DONE_TEXT = '思考内容';

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

    const [inputValue, setInputValue] = useState('');
    const [messages, setMessages] = useState<ChatMessage[]>(() => currentTranscript.map(fromSnapshotMessage));
    const [isStreaming, setIsStreaming] = useState(false);
    const [isStreamReconnecting, setIsStreamReconnecting] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadError, setUploadError] = useState(false);
    const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
    const [runReason, setRunReason] = useState<'completed' | 'stopped' | 'error' | null>(null);
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
        setIsStreamReconnecting(false);
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
                attachRunViaRuntime(runId, state.eventSequence, onEvent, onError, onFinish, streamSessionId, stream)
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
        streamHandleRef.current = start(
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
                setIsStreamReconnecting(false);
                if (streamLostEvents) void resyncFromServer(runSessionId);
            },
            runSessionId,
            {
                onResync: () => {
                    streamLostEvents = true;
                    void resyncFromServer(runSessionId);
                },
                onConnectionChange: (state) => setIsStreamReconnecting(state === 'reconnecting'),
            },
        );
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

    const isAgentMessageAnimating = (messageId: string, terminalReason: AgentTerminalReason | null) => (
        isStreaming &&
        !terminalReason &&
        (messageId === activeAgentMessageIdRef.current || messageId === pendingAgentMessageIdRef.current)
    );

    const shouldShowThinking = (message: AgentMessage) => (
        isAgentMessageAnimating(message.messageId, message.terminalReason) &&
        isAgentMessageEmpty(message)
    );
    const latestAgentMessage = [...messages].reverse().find((message): message is AgentMessage => message.role === 'agent');
    const liveStatus = runReason === 'error'
        ? `${t('chat.requestFailed')} ${t('chat.retryHint')}`
        : (isStreaming && isStreamReconnecting ? t('chat.streamReconnecting') : '') || latestAgentMessage?.statusNotice || latestAgentMessage?.retryNotice;

    return (
        <main id="main-content" className="chat-area" aria-labelledby="chat-page-title">
            <header className="breadcrumb-header">
                <h1 id="chat-page-title" className="sr-only">{t('chat.pageTitle')}</h1>
                <div className="breadcrumb-main">
                    <span className="breadcrumb-mark" aria-hidden="true">
                        <AgentOrbitIcon
                            size={32}
                            className={`breadcrumb-icon ${isStreaming ? 'is-running' : 'is-idle'}`}
                            animated={isStreaming}
                        />
                    </span>
                    <span className="breadcrumb-title">{t('chat.breadcrumbRoot')}</span>
                    <span className="breadcrumb-separator">/</span>
                    <span className="breadcrumb-task">{currentTask.name}</span>
                    <span className="breadcrumb-separator">/</span>
                    <span className="breadcrumb-session">{currentSession.name}</span>
                </div>

                <div className="breadcrumb-actions">
                    <button
                        type="button"
                        className={`tool-panel-header-btn ${isToolPanelOpen ? 'is-active' : ''}`}
                        onClick={onToggleToolPanel}
                        aria-pressed={isToolPanelOpen}
                        disabled={!hasTools && !isToolPanelOpen}
                        aria-label={isToolPanelOpen ? t('chat.closeDetails') : t('chat.openDetails')}
                    >
                        <RiInfoCard size={17} aria-hidden="true" />
                        <span className="header-icon-label" aria-hidden="true">{t('chat.details')}</span>
                    </button>
                </div>
            </header>
            <div className="chat-live-region" role={runReason === 'error' ? 'alert' : 'status'} aria-live={runReason === 'error' ? 'assertive' : 'polite'} aria-atomic="true">
                {liveStatus}
            </div>

            <div
                ref={chatContainerRef}
                onScroll={handleScroll}
                className="chat-message-list scrollable-area flex flex-col gap-6 p-6"
            >
                {messages.length === 0 && (
                    <div className="chat-starter">
                        <span className="chat-starter-caption" aria-hidden="true">-- {t('chat.starterCaption')}</span>
                        <h2 className="chat-starter-title">{t('chat.starterTitle')}</h2>
                        <p className="chat-starter-hint">{t('chat.starterHint')}</p>
                        <div className="chat-starter-grid">
                            {STARTER_PROMPTS.map((kind, index) => (
                                <button
                                    key={kind}
                                    type="button"
                                    className="chat-starter-card"
                                    style={{ '--i': index } as React.CSSProperties}
                                    onClick={() => {
                                        // Examples are generic; the user adapts one to their own data before sending.
                                        setInputValue(t(`chat.starter.${kind}.prompt`));
                                        textareaRef.current?.focus();
                                    }}
                                >
                                    <span className="chat-starter-kind">
                                        <span className="chat-starter-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                                        {t(`chat.starter.${kind}.label`)}
                                    </span>
                                    <span className="chat-starter-prompt">{t(`chat.starter.${kind}.prompt`)}</span>
                                    <ChevronRight size={16} className="chat-starter-arrow" aria-hidden="true" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.filter((msg) => msg.role === 'user' || !isAgentMessageEmpty(msg)).map((msg) => (
                    <React.Fragment key={msg.id}>
                        {msg.role === 'user' ? (
                            <div className="message user">
                                <div className="user-message-stack">
                                    <div className="message-content user-message-body">
                                        {msg.content}
                                    </div>
                                    {msg.attachments && msg.attachments.length > 0 && (
                                        <ul className="message-attachments" aria-label={t('chat.attachedFiles')}>
                                            {msg.attachments.map((file) => (
                                                <li key={file} className="attachment-chip" title={file}>
                                                    <FileIcon filename={file} size={14} />
                                                    <span>{file}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                <div className="message-avatar user-avatar">U</div>
                            </div>
                        ) : (
                            <div className="message agent">
                                <div className={`agent-icon-red flex-shrink-0 flex items-center justify-center ${isAgentMessageAnimating(msg.messageId, msg.terminalReason) ? 'is-running' : 'is-idle'}`}>
                                    <AgentOrbitIcon
                                        size={32}
                                        animated={isAgentMessageAnimating(msg.messageId, msg.terminalReason)}
                                        className="agent-message-icon"
                                    />
                                </div>
                                <div className="message-content-wrapper">
                                    {(msg.reasoningContent.trim().length > 0 || shouldShowThinking(msg)) && (
                                        <details
                                            className={`agent-reasoning-block ${isAgentMessageAnimating(msg.messageId, msg.terminalReason) ? 'is-streaming' : ''}`}
                                            open={isAgentMessageAnimating(msg.messageId, msg.terminalReason)}
                                        >
                                            <summary className="agent-reasoning-title">
                                                {isAgentMessageAnimating(msg.messageId, msg.terminalReason) ? THINKING_STATUS_TEXT : REASONING_DONE_TEXT}
                                            </summary>
                                            <div className="agent-reasoning-content">
                                                {msg.reasoningContent || t('tools.processing')}
                                            </div>
                                        </details>
                                    )}

                                    {visibleAgentContent(msg) && (
                                        <div className="message-content prose prose-sm max-w-none agent-message-body markdown-content">
                                            <AgentMarkdown currentSessionId={currentSession.id}>
                                                {visibleAgentContent(msg)}
                                            </AgentMarkdown>
                                        </div>
                                    )}

                                    {msg.retryNotice && (
                                        <div className="agent-thinking-line">
                                            <span>{msg.retryNotice}</span>
                                        </div>
                                    )}

                                    {isStreaming && isStreamReconnecting && msg === latestAgentMessage && (
                                        <div className="agent-thinking-line">
                                            <span>{t('chat.streamReconnecting')}</span>
                                        </div>
                                    )}

                                    {Object.values(msg.widgetsById).map((widget) => (
                                        <WidgetRenderer
                                            key={widget.tool_call_id || widget.widget_id}
                                            widget={widget}
                                            currentSessionId={currentSession.id}
                                        />
                                    ))}

                                    {(Object.values(msg.toolCallsById).length > 0 || msg.skillActivations.length > 0) && (
                                        <div className="agent-hint-list">
                                            {Object.values(msg.toolCallsById).map((tool) => (
                                                <React.Fragment key={tool.toolCallId}>
                                                    <button
                                                        type="button"
                                                        className={`agent-hint-line ${tool.status === 'error' ? 'is-error' : ''}`}
                                                        onClick={onOpenToolPanel}
                                                        disabled={!onOpenToolPanel}
                                                        aria-label={getToolHintLabel(tool, t)}
                                                        style={{ cursor: onOpenToolPanel ? 'pointer' : 'default', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
                                                    >
                                                        <span className="agent-hint-dot" aria-hidden="true" />
                                                        <span>{getToolHintLabel(tool, t)}</span>
                                                    </button>
                                                    <SubagentProgressLines progress={subagentChildrenOf(tool)} />
                                                </React.Fragment>
                                            ))}
                                            {msg.skillActivations.map((skill) => (
                                                <div
                                                    key={[skill.name, skill.source, skill.command_text, skill.location].join('|')}
                                                    className="agent-hint-line"
                                                >
                                                    <span className="agent-hint-dot" aria-hidden="true" />
                                                    <span>{getSkillHintLabel(skill, t)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </React.Fragment>
                ))}

                {pendingClarification && (
                    <div className="message agent clarification-message" role="alert" aria-live="assertive">
                        <div className="agent-icon-red is-idle flex-shrink-0 flex items-center justify-center">
                            <AgentOrbitIcon size={32} animated={false} className="agent-message-icon" />
                        </div>
                        <div className="message-content-wrapper">
                            <div className="clarification-card">
                                <div className="clarification-title">{t('chat.clarificationTitle')}</div>
                                <div className="clarification-question">{pendingClarification.question}</div>
                                {pendingClarification.options.length > 0 && (
                                    <div className="clarification-options" role="radiogroup" aria-label={t('chat.clarificationOptions')}>
                                        {pendingClarification.options.map((option) => {
                                            const isSelected = clarificationInput === option;
                                            return (
                                                <button
                                                    key={option}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={isSelected}
                                                    className={`clarification-option ${isSelected ? 'is-selected' : ''}`}
                                                    onClick={() => {
                                                        setClarificationInput(option);
                                                        clarificationInputRef.current?.focus();
                                                    }}
                                                    disabled={isSubmittingClarification}
                                                >
                                                    <span className="clarification-option-mark" aria-hidden="true" />
                                                    <span>{option}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                <div className="clarification-answer">
                                    <textarea
                                        ref={clarificationInputRef}
                                        className="clarification-input"
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
                                        className={`chat-send-btn ${clarificationInput.trim() ? 'is-ready' : ''}`}
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

            <div className="chat-input-container p-4 border-t border-gray-100 bg-white">
                {attachedFiles.length > 0 && (
                    <ul className="chat-attachments" aria-label={t('chat.attachedFiles')}>
                        {attachedFiles.map((file) => (
                            <li key={file} className="attachment-chip" title={file}>
                                <FileIcon filename={file} size={14} />
                                <span>{file}</span>
                                <button
                                    type="button"
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
                <div className="chat-input-meta">
                    {uploadError
                        ? <span className="chat-input-error" role="alert">{t('chat.uploadFailed')}</span>
                        : <span>{isStreaming ? t('chat.steerHint') : null}</span>}
                    {runReason && <span>{t('chat.status') || '状态'}：{runReason === 'completed' ? t('tools.statusDone') : runReason === 'stopped' ? t('chat.stopped') || '已停止' : t('tools.statusError')}</span>}
                </div>
                <div className="chat-input-wrapper shadow-sm">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        onChange={handleUploadChange}
                    />
                    <button
                        type="button"
                        className="chat-icon-btn"
                        onClick={handleUploadClick}
                        disabled={isUploading || isStreaming}
                        title={t('chat.uploadTooltip')}
                        aria-label={t('chat.uploadTooltip')}
                    >
                        {isUploading ? <Loader2 size={18} className="animate-spin" /> : <Paperclip size={18} />}
                    </button>
                    <textarea
                        ref={textareaRef}
                        className="chat-input flex-1"
                        placeholder={isStreaming ? (t('chat.steerPlaceholder') || '执行中补充说明...') : t('chat.placeholder')}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        rows={1}
                        style={{
                            border: 'none',
                            outline: 'none',
                            padding: '8px 4px',
                            fontSize: '15px',
                            lineHeight: 1.5,
                            resize: 'none',
                            minHeight: '40px',
                            maxHeight: '160px',
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                        }}
                    />
                    <button
                        type="button"
                        className={`chat-send-btn ${isStreaming && !inputValue.trim() ? 'is-stop' : inputValue.trim() ? 'is-ready' : ''}`}
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

const ChatArea: React.FC<ChatAreaProps> = (props) => {
    const { currentTask, currentSession, createSession } = useSession();
    const { t } = useLanguage();

    if (currentTask && currentSession) {
        return <ActiveChatArea {...props} activeTask={currentTask} activeSession={currentSession} />;
    }

    return (
        <main id="main-content" className="chat-area" aria-labelledby="chat-page-title">
            <header className="breadcrumb-header">
                <h1 id="chat-page-title" className="sr-only">{t('chat.pageTitle')}</h1>
                <div className="breadcrumb-main">
                    <span className="breadcrumb-mark" aria-hidden="true">
                        <AgentOrbitIcon size={32} className="breadcrumb-icon is-idle" animated={false} />
                    </span>
                    <span className="breadcrumb-title">{t('chat.breadcrumbRoot')}</span>
                    {currentTask && (
                        <>
                            <span className="breadcrumb-separator">/</span>
                            <span className="breadcrumb-task">{currentTask.name}</span>
                        </>
                    )}
                </div>
            </header>
            <div className="empty-chat-state task-chat-empty-state">
                <div>{currentTask ? t('session.emptyPrompt') : t('task.emptyPrompt')}</div>
                {currentTask && (
                    <button type="button" className="create-session-empty-btn" onClick={() => createSession(currentTask.id)}>
                        <Plus size={14} />
                        <span>{t('session.create')}</span>
                    </button>
                )}
            </div>
        </main>
    );
};

export default ChatArea;
