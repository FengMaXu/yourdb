import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
    type SessionSnapshotMessage,
} from '../api/client';
import { createTaskWithIdViaRuntime, getTranscriptViaRuntime, prepareSessionViaRuntime } from '../api/runtime-client';
import { createSessionViaRuntime, deleteSessionViaRuntime, deleteTaskViaRuntime, listSessionsViaRuntime, listTasksViaRuntime, renameSessionViaRuntime, renameTaskViaRuntime } from '../api/runtime-client';
import { useLanguage } from '../context/LanguageContext';
import { cleanSessionTitle } from '../utils/session-title';

export interface Task {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
}

export interface Session {
    id: string;
    taskId: string;
    name: string;
    createdAt: string;
    conversationVersion: number;
}

const CURRENT_TASK_STORAGE_KEY = 'data-agent:current-task';
const CURRENT_SESSION_STORAGE_KEY = 'data-agent:current-session';
const TRANSCRIPT_SAVE_DEBOUNCE_MS = 800;
const DEFAULT_TASK_NAMES = new Set(['New task', 'New Task', '新任务']);
const DEFAULT_SESSION_NAMES = new Set(['New session', 'New Session', '新会话']);

type SessionTranscriptStore = Record<string, SessionSnapshotMessage[]>;
type SessionAttachedFilesStore = Record<string, string[]>;

interface SessionContextType {
    tasks: Task[];
    sessions: Session[];
    currentTask: Task | null;
    currentSession: Session | null;
    currentTranscript: SessionSnapshotMessage[];
    attachedFiles: string[];
    createTask: () => void;
    createSession: (taskId?: string) => void;
    switchTask: (taskId: string) => void;
    switchSession: (sessionId: string) => void;
    deleteTask: (taskId: string) => void;
    deleteSession: (sessionId: string) => void;
    updateTaskName: (taskId: string, name: string) => void;
    setCurrentTranscript: (sessionId: string, messages: SessionSnapshotMessage[]) => void;
    clearCurrentTranscript: (sessionId: string, options?: { persist?: boolean; conversationVersion?: number }) => void;
    setAttachedFiles: (files: string[]) => void;
    toggleAttachedFile: (filePath: string) => void;
    clearAttachedFiles: (options?: { persist?: boolean }) => void;
    isFileAttached: (filePath: string) => boolean;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

function readCurrentTaskId(): string {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(CURRENT_TASK_STORAGE_KEY) || '';
}

function writeCurrentTaskId(taskId: string) {
    if (typeof window === 'undefined') return;
    if (taskId) window.localStorage.setItem(CURRENT_TASK_STORAGE_KEY, taskId);
    else window.localStorage.removeItem(CURRENT_TASK_STORAGE_KEY);
}

function readCurrentSessionId(): string {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY) || '';
}

function writeCurrentSessionId(sessionId: string) {
    if (typeof window === 'undefined') return;
    if (sessionId) window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId);
    else window.localStorage.removeItem(CURRENT_SESSION_STORAGE_KEY);
}

export function SessionProvider({ children }: { children: ReactNode }) {
    const { t } = useLanguage();
    const [isLoaded, setIsLoaded] = useState(false);
    // Only a successful load that found no tasks is a first use; a failed one must not create anything.
    const [foundNoTasks, setFoundNoTasks] = useState(false);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [sessions, setSessions] = useState<Session[]>([]);
    const [currentTaskId, setCurrentTaskId] = useState('');
    const [currentSessionId, setCurrentSessionId] = useState('');
    const [transcriptsBySession, setTranscriptsBySession] = useState<SessionTranscriptStore>({});
    const [attachedFilesBySession, setAttachedFilesBySession] = useState<SessionAttachedFilesStore>({});
    const attachedFilesRef = useRef<SessionAttachedFilesStore>({});
    const conversationVersionsRef = useRef<Record<string, number>>({});
    const transcriptSaveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
    const titleSaveRequestedRef = useRef<Set<string>>(new Set());
    const sessionNamesRef = useRef<Record<string, string>>({});

    const defaultTaskName = t('task.new') || 'New task';
    const defaultSessionName = t('session.new') || 'New session';

    useEffect(() => {
        attachedFilesRef.current = attachedFilesBySession;
    }, [attachedFilesBySession]);

    useEffect(() => {
        sessionNamesRef.current = Object.fromEntries(sessions.map((session) => [session.id, session.name]));
    }, [sessions]);

    const warmSession = useCallback((sessionId: string) => {
        void prepareSessionViaRuntime(sessionId).catch((error) => {
            console.warn('Failed to prepare session runtime:', error);
        });
    }, []);

    const persistTranscript = useCallback((_sessionId: string, _messages: SessionSnapshotMessage[]) => {
        // Transcripts are owned by the Runtime's Pi JSONL session store.
        // Renderer snapshots are no longer persisted server-side.
    }, []);

    const scheduleTranscriptSave = useCallback((
        sessionId: string,
        messages: SessionSnapshotMessage[],
        immediate = false,
    ) => {
        const existingTimer = transcriptSaveTimersRef.current[sessionId];
        if (existingTimer) {
            clearTimeout(existingTimer);
            delete transcriptSaveTimersRef.current[sessionId];
        }
        if (immediate) {
            persistTranscript(sessionId, messages);
            return;
        }
        transcriptSaveTimersRef.current[sessionId] = setTimeout(() => {
            delete transcriptSaveTimersRef.current[sessionId];
            persistTranscript(sessionId, messages);
        }, TRANSCRIPT_SAVE_DEBOUNCE_MS);
    }, [persistTranscript]);

    useEffect(() => () => {
        Object.values(transcriptSaveTimersRef.current).forEach(clearTimeout);
        transcriptSaveTimersRef.current = {};
    }, []);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            try {
                const [runtimeTasks, runtimeSessions] = await Promise.all([
                    listTasksViaRuntime(),
                    listSessionsViaRuntime(),
                ]);
                if (cancelled) return;

                const loadedTasks: Task[] = runtimeTasks.map((task) => ({
                    id: task.id,
                    name: DEFAULT_TASK_NAMES.has(task.name) ? defaultTaskName : task.name,
                    createdAt: new Date(task.createdAt ?? Date.now()).toISOString(),
                    updatedAt: new Date(task.updatedAt ?? Date.now()).toISOString(),
                }));
                const loadedSessions: Session[] = runtimeSessions.map((session) => ({
                    id: session.id,
                    taskId: session.taskId ?? '',
                    name: DEFAULT_SESSION_NAMES.has(session.name) ? defaultSessionName : session.name,
                    createdAt: new Date().toISOString(),
                    conversationVersion: 1,
                }));

                loadedSessions.forEach((session) => {
                    conversationVersionsRef.current[session.id] = session.conversationVersion;
                });
                const storedSessionId = readCurrentSessionId();
                const storedTaskId = readCurrentTaskId();
                const selectedTask = loadedTasks.find((task) => task.id === storedTaskId)
                    || loadedTasks.find((task) => task.id === loadedSessions.find((session) => session.id === storedSessionId)?.taskId)
                    || loadedTasks[0]
                    || null;
                const selectedSession = selectedTask
                    ? loadedSessions.find((session) => session.id === storedSessionId && session.taskId === selectedTask.id)
                        || loadedSessions.find((session) => session.taskId === selectedTask.id)
                        || null
                    : null;

                let transcripts: SessionTranscriptStore = {};
                const attached: SessionAttachedFilesStore = {};
                if (selectedSession) {
                    const transcriptMessages = await getTranscriptViaRuntime(selectedSession.id);
                    if (cancelled) return;
                    transcripts = { [selectedSession.id]: transcriptMessages.map((message) => ({
                        ...message,
                        role: message.role === 'agent' ? 'agent' : 'user',
                        visitedStages: message.visitedStages || [],
                    })) };
                    warmSession(selectedSession.id);
                }

                setTasks(loadedTasks);
                setFoundNoTasks(loadedTasks.length === 0);
                setSessions(loadedSessions);
                setCurrentTaskId(selectedTask?.id || '');
                setCurrentSessionId(selectedSession?.id || '');
                writeCurrentTaskId(selectedTask?.id || '');
                writeCurrentSessionId(selectedSession?.id || '');
                setTranscriptsBySession(transcripts);
                setAttachedFilesBySession(attached);
            } catch (error) {
                console.error('Failed to load tasks:', error);
            } finally {
                if (!cancelled) setIsLoaded(true);
            }
        };

        void load();
        return () => {
            cancelled = true;
        };
    }, [defaultSessionName, defaultTaskName, warmSession]);

    const currentTask = useMemo(
        () => tasks.find((task) => task.id === currentTaskId) || null,
        [currentTaskId, tasks],
    );
    const currentSession = useMemo(
        () => sessions.find((session) => session.id === currentSessionId && session.taskId === currentTaskId) || null,
        [currentSessionId, currentTaskId, sessions],
    );

    const currentTranscript = useMemo(
        () => currentSession ? transcriptsBySession[currentSession.id] || [] : [],
        [currentSession, transcriptsBySession],
    );
    const attachedFiles = useMemo(
        () => currentSession ? attachedFilesBySession[currentSession.id] || [] : [],
        [attachedFilesBySession, currentSession],
    );

    const selectSession = useCallback((sessionId: string) => {
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) return;
        setCurrentTaskId(session.taskId);
        setCurrentSessionId(session.id);
        writeCurrentTaskId(session.taskId);
        writeCurrentSessionId(session.id);
        warmSession(session.id);
    }, [sessions, warmSession]);

    /** Opens a new empty session in a task and makes it current, ready for the first message. */
    const openSession = useCallback((taskId: string) => {
        void createSessionViaRuntime(taskId, defaultSessionName).then((created) => {
            const session: Session = {
                id: created.id,
                taskId: created.taskId || taskId,
                name: created.name || defaultSessionName,
                createdAt: new Date(created.createdAt ?? Date.now()).toISOString(),
                conversationVersion: 1,
            };
            setSessions((prev) => [session, ...prev.filter((item) => item.id !== session.id)]);
            setTranscriptsBySession((prev) => ({ ...prev, [session.id]: [] }));
            setAttachedFilesBySession((prev) => ({ ...prev, [session.id]: [] }));
            conversationVersionsRef.current[session.id] = 1;
            setCurrentTaskId(session.taskId);
            setCurrentSessionId(session.id);
            writeCurrentTaskId(session.taskId);
            writeCurrentSessionId(session.id);
            warmSession(session.id);
        }).catch((error) => console.warn('Failed to create session:', error));
    }, [defaultSessionName, warmSession]);

    const createSession = useCallback((taskId = currentTask?.id || '') => {
        if (taskId) openSession(taskId);
    }, [currentTask?.id, openSession]);

    const createTask = useCallback(() => {
        void createTaskWithIdViaRuntime(defaultTaskName).then((created) => {
            const now = new Date().toISOString();
            const task: Task = {
                id: created.id,
                name: created.name || defaultTaskName,
                createdAt: now,
                updatedAt: now,
            };
            setTasks((prev) => [task, ...prev.filter((item) => item.id !== task.id)]);
            setCurrentTaskId(task.id);
            setCurrentSessionId('');
            writeCurrentTaskId(task.id);
            writeCurrentSessionId('');
            // A new task opens straight into a session, so the user can type at once.
            openSession(task.id);
        }).catch((error) => console.warn('Failed to create task:', error));
    }, [defaultTaskName, openSession]);

    // First use: there is nothing to pick, so open a task and a session straight away and let the first question be one step.
    const firstTaskCreatedRef = useRef(false);
    useEffect(() => {
        if (!foundNoTasks || firstTaskCreatedRef.current) return;
        firstTaskCreatedRef.current = true;
        createTask();
    }, [createTask, foundNoTasks]);


    const switchSession = useCallback((sessionId: string) => {
        if (!sessions.some((session) => session.id === sessionId)) return;
        if (transcriptsBySession[sessionId] === undefined) {
            void getTranscriptViaRuntime(sessionId).then((transcriptMessages) => {
                setTranscriptsBySession((prev) => ({ ...prev, [sessionId]: transcriptMessages.map((message) => ({
                    ...message,
                    role: message.role === 'agent' ? 'agent' : 'user',
                    visitedStages: message.visitedStages || [],
                })) }));
                selectSession(sessionId);
            }).catch((error: unknown) => console.warn('Failed to load session:', error));
            return;
        }
        selectSession(sessionId);
    }, [selectSession, sessions, transcriptsBySession]);

    const switchTask = useCallback((taskId: string) => {
        if (!tasks.some((task) => task.id === taskId)) return;
        setCurrentTaskId(taskId);
        setCurrentSessionId('');
        writeCurrentTaskId(taskId);
        writeCurrentSessionId('');
    }, [tasks]);

    const deleteSession = useCallback((sessionId: string) => {
        const target = sessions.find((session) => session.id === sessionId);
        if (!target) return;
        const nextSessions = sessions.filter((session) => session.id !== sessionId);
        setSessions(nextSessions);
        setTranscriptsBySession((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
        });
        setAttachedFilesBySession((prev) => {
            const next = { ...prev };
            delete next[sessionId];
            return next;
        });
        void deleteSessionViaRuntime(sessionId);
        if (sessionId === currentSessionId) {
            const next = nextSessions.find((session) => session.taskId === target.taskId);
            if (next) switchSession(next.id);
            else {
                setCurrentSessionId('');
                writeCurrentSessionId('');
            }
        }
    }, [currentSessionId, sessions, switchSession]);

    const deleteTask = useCallback((taskId: string) => {
        const removedSessionIds = new Set(sessions.filter((session) => session.taskId === taskId).map((session) => session.id));
        const nextTasks = tasks.filter((task) => task.id !== taskId);
        const nextSessions = sessions.filter((session) => session.taskId !== taskId);
        setTasks(nextTasks);
        setSessions(nextSessions);
        setTranscriptsBySession((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedSessionIds.has(id))));
        setAttachedFilesBySession((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !removedSessionIds.has(id))));
        void deleteTaskViaRuntime(taskId);
        if (taskId === currentTaskId) {
            const nextTask = nextTasks[0] || null;
            const nextSession = nextTask ? nextSessions.find((session) => session.taskId === nextTask.id) || null : null;
            setCurrentTaskId(nextTask?.id || '');
            setCurrentSessionId(nextSession?.id || '');
            writeCurrentTaskId(nextTask?.id || '');
            writeCurrentSessionId(nextSession?.id || '');
            if (nextSession) warmSession(nextSession.id);
        }
    }, [currentSessionId, currentTaskId, sessions, tasks, warmSession]);

    const updateTaskName = useCallback((taskId: string, name: string) => {
        const nextName = name.trim() || defaultTaskName;
        setTasks((prev) => prev.map((task) => task.id === taskId ? { ...task, name: nextName } : task));
        void renameTaskViaRuntime(taskId, nextName);
    }, [defaultTaskName]);

    const setCurrentTranscript = useCallback((sessionId: string, messages: SessionSnapshotMessage[]) => {
        setTranscriptsBySession((prev) => ({ ...prev, [sessionId]: messages }));
        const sessionName = sessionNamesRef.current[sessionId];
        const isUntitled = DEFAULT_SESSION_NAMES.has(sessionName);
        const firstUserMessage = messages.find((message) => message.role === 'user');
        const title = firstUserMessage ? cleanSessionTitle(firstUserMessage.content) : '';
        const shouldSaveTitleNow = Boolean(isUntitled && title && !titleSaveRequestedRef.current.has(sessionId));
        if (shouldSaveTitleNow) {
            titleSaveRequestedRef.current.add(sessionId);
            // Naming is deliberately local and best-effort. A failed metadata
            // write must never interrupt transcript persistence or the answer.
            sessionNamesRef.current[sessionId] = title;
            setSessions((prev) => prev.map((session) => (
                session.id === sessionId ? { ...session, name: title } : session
            )));
            void renameSessionViaRuntime(sessionId, title).catch((error) => {
                console.warn('Failed to rename session:', error);
            });
        }
        scheduleTranscriptSave(sessionId, messages, shouldSaveTitleNow);
    }, [scheduleTranscriptSave]);

    const clearCurrentTranscript = useCallback((
        sessionId: string,
        options: { persist?: boolean; conversationVersion?: number } = {},
    ) => {
        if (typeof options.conversationVersion === 'number') {
            conversationVersionsRef.current[sessionId] = options.conversationVersion;
            setSessions((prev) => prev.map((session) => (
                session.id === sessionId ? { ...session, conversationVersion: options.conversationVersion as number } : session
            )));
        }
        setTranscriptsBySession((prev) => ({ ...prev, [sessionId]: [] }));
        titleSaveRequestedRef.current.delete(sessionId);
        if (options.persist === false) {
            const existingTimer = transcriptSaveTimersRef.current[sessionId];
            if (existingTimer) {
                clearTimeout(existingTimer);
                delete transcriptSaveTimersRef.current[sessionId];
            }
            return;
        }
        scheduleTranscriptSave(sessionId, [], true);
    }, [scheduleTranscriptSave]);

    const setAttachedFiles = useCallback((files: string[]) => {
        if (!currentSession) return;
        const deduped = Array.from(new Set(files));
        setAttachedFilesBySession((prev) => ({ ...prev, [currentSession.id]: deduped }));
        // Attached files persist with the workspace; no separate snapshot needed.
    }, [currentSession]);

    const toggleAttachedFile = useCallback((filePath: string) => {
        if (!currentSession) return;
        const current = attachedFilesBySession[currentSession.id] || [];
        const next = current.includes(filePath) ? current.filter((item) => item !== filePath) : [...current, filePath];
        setAttachedFilesBySession((prev) => ({ ...prev, [currentSession.id]: next }));
    }, [attachedFilesBySession, currentSession]);

    const clearAttachedFiles = useCallback((options: { persist?: boolean } = {}) => {
        if (!currentSession) return;
        setAttachedFilesBySession((prev) => ({ ...prev, [currentSession.id]: [] }));
        if (options.persist === false) return;
    }, [currentSession]);

    const isFileAttached = useCallback((filePath: string) => attachedFiles.includes(filePath), [attachedFiles]);

    if (!isLoaded) return null;

    return (
        <SessionContext.Provider value={{
            tasks,
            sessions,
            currentTask,
            currentSession,
            currentTranscript,
            attachedFiles,
            createTask,
            createSession,
            switchTask,
            switchSession,
            deleteTask,
            deleteSession,
            updateTaskName,
            setCurrentTranscript,
            clearCurrentTranscript,
            setAttachedFiles,
            toggleAttachedFile,
            clearAttachedFiles,
            isFileAttached,
        }}>
            {children}
        </SessionContext.Provider>
    );
}

export function useSession() {
    const context = useContext(SessionContext);
    if (!context) throw new Error('useSession must be used within a SessionProvider');
    return context;
}
