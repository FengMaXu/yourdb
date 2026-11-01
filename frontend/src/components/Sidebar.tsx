import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    Bot,
    Cable,
    Check,
    Database,
    Edit3,
    FilePen,
    FileText,
    FileUp,
    Folder,
    Languages,
    LibraryBig,
    ListChecks,
    LogOut,
    MessageSquare,
    Monitor,
    PanelLeft,
    Plus,
    Puzzle,
    Save,
    Settings,
    SquareCheck,
    Trash2,
    User,
    Workflow,
    X,
} from 'lucide-react';
import { toast as notify } from 'sonner';
import { BrandWordmark } from './Brand';
import { NAV_EXPANDED, NAV_ITEM, NAV_TEXT, SectionHeader, TREE, TreeAction, TreeGroup, TreeNote, TreeRow } from './SidebarTree';
import { cn } from '@/lib/utils';
import {
    type KnowledgeFile,
} from '../api/client';
import { listKnowledgeViaRuntime, readKnowledgeViaRuntime, saveKnowledgeViaRuntime } from '../api/runtime-client';
import ReactMarkdown from 'react-markdown';
import { useSession } from '../hooks/useSession';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../hooks/useAuth';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { CHAT_VIEW, type WorkspaceView } from './workspace-view';
import type { PluginsTab } from './PluginsPanel';
import type { SettingsSection } from './SettingsPanel';

interface SidebarProps {
    /** The page the main pane shows; sidebar rows that open it render active. */
    activeView: WorkspaceView;
    onNavigate: (view: WorkspaceView) => void;
    /** Collapsed to an icon rail: labels and section contents hide, icons stay. */
    collapsed?: boolean;
    /** Pinned open (true) or collapsed to the rail (false), independent of hover peeking. */
    pinned?: boolean;
    onExpand?: () => void;
    onTogglePinned?: () => void;
}

const SETTINGS_SECTIONS: { id: SettingsSection; icon: React.FC<{ size?: number }> }[] = [
    { id: 'model', icon: Bot },
    { id: 'database', icon: Database },
    { id: 'environment', icon: Monitor },
    { id: 'channels', icon: MessageSquare },
];

interface KnowledgeFileNode {
    item: KnowledgeFile;
    children: KnowledgeFileNode[];
    level: number;
}

/** A knowledge document is named by its catalog name and knowledgeId, as the prompts name it. */
const knowledgeLabel = (file: KnowledgeFile): string => (
    file.knowledgeId ? `${file.title ?? file.name}（${file.knowledgeId}）` : file.name
);

/** Footer entries sit a little tighter than the main ones, and keep their height on the rail. */
const FOOTER_ITEM = 'min-h-9 justify-start rounded-[10px] group-data-[rail=true]/sidebar:h-auto group-data-[rail=true]/sidebar:min-h-9';

const Sidebar: React.FC<SidebarProps> = ({ activeView, onNavigate, collapsed = false, pinned = true, onExpand, onTogglePinned }) => {
    const {
        tasks,
        sessions,
        currentTask,
        currentSession,
        createTask,
        createSession,
        switchTask,
        switchSession,
        deleteTask,
        deleteSession,
        updateTaskName,
    } = useSession();
    const { t, toggleLanguage } = useLanguage();
    const { user, logout } = useAuth();
    const displayName = user?.display_name || user?.username || 'User';

    const [tasksExpanded, setTasksExpanded] = useState(true);
    const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());
    const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
    const [editTaskName, setEditTaskName] = useState('');
    const [knowledgeExpanded, setKnowledgeExpanded] = useState(false);
    const [pluginsExpanded, setPluginsExpanded] = useState(false);
    const [settingsExpanded, setSettingsExpanded] = useState(false);
    const [knowledgeFiles, setKnowledgeFiles] = useState<KnowledgeFile[]>([]);
    const [loadingKnowledge, setLoadingKnowledge] = useState(false);
    const [knowledgeExpandedPaths, setKnowledgeExpandedPaths] = useState<Set<string>>(new Set(['doc']));
    const [editorOpen, setEditorOpen] = useState(false);
    const [selectedFile, setSelectedFile] = useState<KnowledgeFile | null>(null);
    const [fileContent, setFileContent] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const knowledgeImportInputRef = useRef<HTMLInputElement>(null);


    // Successes fade on their own; an error stays until it is dismissed.
    const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
        if (type === 'error') notify.error(text, { duration: Infinity, closeButton: true });
        else notify.success(text, { duration: 3000 });
    }, []);

    const loadKnowledgeFiles = useCallback(async () => {
        setLoadingKnowledge(true);
        try {
            const runtimeFiles = await listKnowledgeViaRuntime();
            const response = { files: runtimeFiles.map((f) => ({
                name: f.path.split('/').pop() || f.path,
                path: f.path,
                size: f.size,
                modified_at: new Date(f.modifiedAt).toISOString(),
                type: 'file' as const,
                ...(f.name ? { title: f.name } : {}),
                ...(f.description ? { description: f.description } : {}),
                ...(f.knowledgeId ? { knowledgeId: f.knowledgeId } : {}),
                ...(f.readOnly ? { readOnly: true } : {}),
                ...(f.hasContent === false ? { hasContent: false } : {}),
            })) };
            setKnowledgeFiles(response.files);
        } catch {
            showToast(t('knowledge.loadFailed') || '加载知识库失败', 'error');
        } finally {
            setLoadingKnowledge(false);
        }
    }, [showToast, t]);

    useEffect(() => {
        if (knowledgeExpanded) void loadKnowledgeFiles();
    }, [knowledgeExpanded, loadKnowledgeFiles]);

    useEffect(() => {
        if (!editorOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setEditorOpen(false);
                setSelectedFile(null);
                setFileContent('');
                setIsEditing(false);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [editorOpen]);

    const toggleExclusiveSection = (section: 'tasks' | 'knowledge' | 'plugins') => {
        // From the icon rail, a section icon expands the sidebar straight into that section.
        const open = (current: boolean) => (collapsed ? true : !current);
        if (collapsed) onExpand?.();
        setTasksExpanded(section === 'tasks' ? open(tasksExpanded) : false);
        setKnowledgeExpanded(section === 'knowledge' ? open(knowledgeExpanded) : false);
        setPluginsExpanded(section === 'plugins' ? open(pluginsExpanded) : false);
    };

    const toggleSettings = () => {
        if (collapsed) onExpand?.();
        setSettingsExpanded((current) => (collapsed ? true : !current));
    };

    const isPluginsView = (tab: PluginsTab) => activeView.kind === 'plugins' && activeView.tab === tab;
    const isSettingsView = (section: SettingsSection) => activeView.kind === 'settings' && activeView.section === section;

    const toggleTask = (taskId: string) => {
        setExpandedTaskIds((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId);
            else next.add(taskId);
            return next;
        });
    };

    const commitTaskName = (taskId: string) => {
        updateTaskName(taskId, editTaskName);
        setEditingTaskId(null);
    };

    const openKnowledgeFile = async (file: KnowledgeFile) => {
        if (file.type === 'directory') return;
        setSelectedFile(file);
        setIsEditing(false);
        try {
            const response = await readKnowledgeViaRuntime(file.path);
            setFileContent(response);
            setEditorOpen(true);
        } catch (error) {
            console.error('Failed to load knowledge file:', error);
            showToast(t('editor.loadFailed'), 'error');
        }
    };

    const handleNewKnowledgeFile = () => {
        const suggested = 'doc/';
        const name = window.prompt(t('common.knowledgeNamePrompt'), suggested);
        if (!name || !name.trim()) return;
        const normalized = name.trim().replace(/^\/+/, '');
        const fileName = /\.(md|markdown|txt)$/i.test(normalized) ? normalized : `${normalized}.md`;
        setSelectedFile({ name: fileName.split('/').pop() || fileName, path: fileName, size: 0, modified_at: new Date().toISOString(), type: 'file' });
        setFileContent('');
        setIsEditing(true);
        setEditorOpen(true);
    };

    const handleImportKnowledge = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(event.target.files ?? []);
        event.target.value = '';
        if (files.length === 0) return;
        let imported = 0;
        for (const file of files) {
            try {
                const content = await file.text();
                await saveKnowledgeViaRuntime(`doc/${file.name}`, content);
                imported += 1;
            } catch (error) {
                console.error('Failed to import knowledge file:', error);
            }
        }
        if (imported > 0) {
            await loadKnowledgeFiles();
            showToast(`${t('common.knowledgeImported')} ${imported}`);
        } else {
            showToast(t('editor.saveFailed'), 'error');
        }
    };

    const handleSave = async () => {
        if (!selectedFile) return;
        setSaving(true);
        try {
            await saveKnowledgeViaRuntime(selectedFile.path, fileContent);
            showToast(`${knowledgeLabel(selectedFile)} 已保存`);
            setIsEditing(false);
        } catch (error) {
            console.error('Failed to save knowledge file:', error);
            showToast(t('editor.saveFailed'), 'error');
        } finally {
            setSaving(false);
        }
    };

    const closeEditor = () => {
        setEditorOpen(false);
        setSelectedFile(null);
        setFileContent('');
        setIsEditing(false);
    };

    const toggleKnowledgePath = (path: string) => {
        setKnowledgeExpandedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const buildKnowledgeFileTree = (): KnowledgeFileNode[] => {
        const pathMap = new Map<string, KnowledgeFileNode>();
        knowledgeFiles.forEach((file) => {
            const parts = file.path.split('/');
            let currentPath = '';
            parts.forEach((part, index) => {
                currentPath = index === 0 ? part : `${currentPath}/${part}`;
                if (!pathMap.has(currentPath)) {
                    const isLast = index === parts.length - 1;
                    pathMap.set(currentPath, {
                        item: isLast ? file : {
                            name: part,
                            path: currentPath,
                            size: 0,
                            modified_at: '',
                            type: 'directory' as const,
                        },
                        children: [],
                        level: index,
                    });
                }
            });
        });

        const roots: KnowledgeFileNode[] = [];
        pathMap.forEach((node, path) => {
            const splitAt = path.lastIndexOf('/');
            const parent = splitAt >= 0 ? pathMap.get(path.slice(0, splitAt)) : undefined;
            if (parent) parent.children.push(node);
            else roots.push(node);
        });
        return roots;
    };

    const renderKnowledgeNode = (node: KnowledgeFileNode): React.ReactNode => {
        const { item, children, level } = node;
        const isDirectory = item.type === 'directory';
        const hasChildren = isDirectory || children.length > 0;
        const expanded = knowledgeExpandedPaths.has(item.path);
        return (
            <React.Fragment key={item.path}>
                <TreeRow
                    depth={level}
                    icon={isDirectory ? <Folder size={15} /> : <FileText size={15} />}
                    label={item.knowledgeId ? (item.title ?? item.name) : item.name}
                    secondary={item.readOnly ? `${item.knowledgeId} · ${t('common.knowledgeBuiltin')}` : item.hasContent === false ? `${item.knowledgeId} · ${t('common.knowledgePlaceholder')}` : item.knowledgeId}
                    title={isDirectory ? item.path : [knowledgeLabel(item), item.description, item.path, item.readOnly ? t('common.knowledgeBuiltinHint') : item.hasContent === false ? t('common.knowledgePlaceholderHint') : ''].filter(Boolean).join('\n')}
                    expanded={hasChildren ? expanded : undefined}
                    active={!isDirectory && editorOpen && selectedFile?.path === item.path}
                    onSelect={() => hasChildren ? toggleKnowledgePath(item.path) : void openKnowledgeFile(item)}
                />
                {expanded && children.length > 0 && (
                    <TreeGroup depth={level}>{children.map(renderKnowledgeNode)}</TreeGroup>
                )}
            </React.Fragment>
        );
    };

    const knowledgeFileTree = buildKnowledgeFileTree();
    const isMarkdown = selectedFile?.name.toLowerCase().endsWith('.md');

    return (
        <>
            <nav
                id="workspace-sidebar"
                data-rail={collapsed ? 'true' : undefined}
                className="group/sidebar relative m-0 flex h-full w-full max-w-none min-w-0 shrink-0 flex-col justify-between overflow-hidden rounded-none border-0 bg-transparent p-0 pb-3 shadow-none"
                aria-label={t('sidebar.navigation')}
            >
                <div className={cn('flex h-14 flex-none items-center border-b border-[var(--hairline)]', collapsed ? 'justify-center p-0' : 'justify-between gap-2 pr-3 pl-5')}>
                    {collapsed ? (
                        <div className="flex items-center text-[0.82rem] leading-none font-bold tracking-[-0.02em] text-[#1f2937] [&_.brand-wordmark]:h-[13px]"><BrandWordmark title="yourdb" /></div>
                    ) : (
                        <>
                            <div className="flex items-center text-xl leading-none font-bold tracking-[-0.04em] text-[#1f2937] max-[720px]:text-base max-[480px]:text-[0.95rem] [&_.brand-wordmark]:h-[22px]"><BrandWordmark title="yourdb" /></div>
                            <button
                                type="button"
                                className="inline-flex size-8 flex-none cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#78716c] transition-colors active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-strong)] pointer-fine:hover:bg-[var(--tree-row-hover)] pointer-fine:hover:text-[var(--text-primary)]"
                                onClick={onTogglePinned}
                                aria-expanded={pinned}
                                aria-controls="workspace-sidebar"
                                title={pinned ? t('sidebar.close') : t('sidebar.open')}
                                aria-label={pinned ? t('sidebar.close') : t('sidebar.open')}
                            >
                                <PanelLeft size={18} />
                            </button>
                        </>
                    )}
                </div>
                <div className={cn('scrollable-area min-h-0 flex-1 pt-3.5', collapsed ? 'px-2.5' : 'pr-2 pl-2.5')}>
                    <div className={cn('flex flex-col', collapsed ? 'items-center gap-1.5' : 'gap-1')}>

                        <button type="button" className={cn(NAV_ITEM, 'mb-2')} title={t('sidebar.newTask')} aria-label={t('sidebar.newTask')} onClick={() => {
                            createTask();
                            onNavigate(CHAT_VIEW);
                            showToast(t('task.created') || '新任务创建成功');
                        }}>
                            <SquareCheck className="shrink-0" size={18} />
                            <span className={NAV_TEXT}>{t('sidebar.newTask')}</span>
                        </button>

                        <SectionHeader
                            icon={<ListChecks className="shrink-0" size={18} />}
                            label={t('sidebar.currentTask')}
                            expanded={tasksExpanded}
                            onToggle={() => toggleExclusiveSection('tasks')}
                        />
                        {!collapsed && tasksExpanded && (
                            <div className={TREE}>
                                {tasks.map((task) => {
                                    const expanded = expandedTaskIds.has(task.id);
                                    const editing = editingTaskId === task.id;
                                    const taskSessions = sessions.filter((session) => session.taskId === task.id);
                                    return (
                                        <React.Fragment key={task.id}>
                                            <TreeRow
                                                depth={0}
                                                icon={<Folder size={15} />}
                                                label={task.name}
                                                title={task.name}
                                                expanded={expanded}
                                                active={activeView.kind === 'chat' && currentTask?.id === task.id && !currentSession}
                                                onSelect={() => {
                                                    switchTask(task.id);
                                                    onNavigate(CHAT_VIEW);
                                                    toggleTask(task.id);
                                                }}
                                                editor={editing ? (
                                                    <input
                                                        className="mr-[30px] h-6 min-w-0 flex-auto rounded-md border border-[var(--hairline)] bg-[var(--frame-surface)] px-1.5 text-[0.82rem] text-[var(--text-primary)] outline-none focus:border-[rgba(194,65,12,0.45)]"
                                                        value={editTaskName}
                                                        onChange={(event) => setEditTaskName(event.target.value)}
                                                        onKeyDown={(event) => {
                                                            if (event.key === 'Enter') commitTaskName(task.id);
                                                            if (event.key === 'Escape') setEditingTaskId(null);
                                                        }}
                                                        onBlur={() => commitTaskName(task.id)}
                                                        autoFocus
                                                        aria-label={task.name}
                                                    />
                                                ) : undefined}
                                                actions={editing ? (
                                                    <TreeAction label={t('common.save')} onClick={() => commitTaskName(task.id)} preventBlur>
                                                        <Check size={14} aria-hidden="true" />
                                                    </TreeAction>
                                                ) : (
                                                    <>
                                                        <TreeAction label={t('session.create')} onClick={() => {
                                                            setExpandedTaskIds((prev) => new Set(prev).add(task.id));
                                                            createSession(task.id);
                                                            onNavigate(CHAT_VIEW);
                                                        }}>
                                                            <Plus size={14} aria-hidden="true" />
                                                        </TreeAction>
                                                        <TreeAction label={t('common.edit')} onClick={() => { setEditTaskName(task.name); setEditingTaskId(task.id); }}>
                                                            <Edit3 size={14} aria-hidden="true" />
                                                        </TreeAction>
                                                        <TreeAction label={t('common.delete')} tone="danger" onClick={() => {
                                                            if (window.confirm(t('task.confirmDelete').replace('{name}', task.name))) deleteTask(task.id);
                                                        }}>
                                                            <Trash2 size={14} aria-hidden="true" />
                                                        </TreeAction>
                                                    </>
                                                )}
                                            />
                                            {expanded && (
                                                <TreeGroup depth={0}>
                                                    {taskSessions.length === 0 && <TreeNote depth={1}>{t('session.empty')}</TreeNote>}
                                                    {taskSessions.map((session) => (
                                                        <TreeRow
                                                            key={session.id}
                                                            depth={1}
                                                            icon={<MessageSquare size={15} />}
                                                            label={session.name}
                                                            title={session.name}
                                                            active={activeView.kind === 'chat' && currentSession?.id === session.id}
                                                            onSelect={() => {
                                                                switchSession(session.id);
                                                                onNavigate(CHAT_VIEW);
                                                            }}
                                                            actions={(
                                                                <TreeAction label={t('common.delete')} tone="danger" onClick={() => {
                                                                    if (window.confirm(t('session.confirmDelete').replace('{name}', session.name))) deleteSession(session.id);
                                                                }}>
                                                                    <Trash2 size={14} aria-hidden="true" />
                                                                </TreeAction>
                                                            )}
                                                        />
                                                    ))}
                                                </TreeGroup>
                                            )}
                                        </React.Fragment>
                                    );
                                })}
                            </div>
                        )}

                        <SectionHeader
                            icon={<LibraryBig className="shrink-0" size={18} />}
                            label={t('sidebar.knowledge')}
                            expanded={knowledgeExpanded}
                            onToggle={() => toggleExclusiveSection('knowledge')}
                            actions={!collapsed && (
                                <>
                                    <TreeAction label={t('common.knowledgeNew')} onClick={handleNewKnowledgeFile}>
                                        <FilePen size={15} aria-hidden="true" />
                                    </TreeAction>
                                    <TreeAction label={t('common.knowledgeImport')} onClick={() => knowledgeImportInputRef.current?.click()}>
                                        <FileUp size={15} aria-hidden="true" />
                                    </TreeAction>
                                </>
                            )}
                        />
                        <input
                            ref={knowledgeImportInputRef}
                            type="file"
                            multiple
                            accept=".md,.markdown,.txt"
                            hidden
                            onChange={(event) => { void handleImportKnowledge(event); }}
                        />
                        {!collapsed && knowledgeExpanded && (
                            <div className={TREE}>
                                {loadingKnowledge && knowledgeFiles.length === 0 ? (
                                    <TreeNote depth={0} role="status">{t('common.loading')}</TreeNote>
                                ) : knowledgeFileTree.length === 0 ? (
                                    <TreeNote depth={0}>{t('common.noKnowledgeFiles')}</TreeNote>
                                ) : knowledgeFileTree.map(renderKnowledgeNode)}
                            </div>
                        )}

                        <SectionHeader
                            icon={<Puzzle className="shrink-0" size={18} />}
                            label={t('sidebar.plugins')}
                            expanded={pluginsExpanded}
                            onToggle={() => toggleExclusiveSection('plugins')}
                        />
                        {!collapsed && pluginsExpanded && (
                            <div className={TREE}>
                                <TreeRow depth={0} icon={<Cable size={15} />} label="MCP" title="MCP" active={isPluginsView('MCP')} onSelect={() => onNavigate({ kind: 'plugins', tab: 'MCP' })} />
                                <TreeRow depth={0} icon={<Workflow size={15} />} label="Skills" title="Skills" active={isPluginsView('Skills')} onSelect={() => onNavigate({ kind: 'plugins', tab: 'Skills' })} />
                            </div>
                        )}
                    </div>
                </div>

                <div className={cn('mt-auto flex shrink-0 flex-col gap-1.5 pt-[22px]', collapsed ? 'items-center px-2.5' : 'pr-2 pl-2.5')}>
                    <div className={cn(NAV_ITEM, FOOTER_ITEM, 'cursor-default')} title={user?.username || displayName}>
                        <User className="shrink-0" size={18} />
                        <span className={NAV_TEXT}>{displayName}</span>
                    </div>
                    <button type="button" className={cn(NAV_ITEM, FOOTER_ITEM)} onClick={toggleLanguage} title={t('sidebar.langToggle')} aria-label={t('sidebar.langToggle')}>
                        <Languages className="shrink-0" size={18} />
                        <span className={NAV_TEXT}>{t('sidebar.language')}</span>
                    </button>
                    <button
                        type="button"
                        className={cn(NAV_ITEM, FOOTER_ITEM, settingsExpanded && NAV_EXPANDED)}
                        onClick={toggleSettings}
                        aria-expanded={settingsExpanded}
                        title={t('sidebar.settings')}
                        aria-label={t('sidebar.settings')}
                    >
                        <Settings className="shrink-0" size={18} />
                        <span className={NAV_TEXT}>{t('sidebar.settings')}</span>
                    </button>
                    {!collapsed && settingsExpanded && (
                        <div className={cn(TREE, 'mb-0.5')}>
                            {SETTINGS_SECTIONS.map(({ id, icon: Icon }) => (
                                <TreeRow
                                    key={id}
                                    depth={0}
                                    icon={<Icon size={15} />}
                                    label={t(`settings.${id}`)}
                                    title={t(`settings.${id}`)}
                                    active={isSettingsView(id)}
                                    onSelect={() => onNavigate({ kind: 'settings', section: id })}
                                />
                            ))}
                        </div>
                    )}
                    <button type="button" className={cn(NAV_ITEM, FOOTER_ITEM)} onClick={() => void logout()} title={t('sidebar.logout')} aria-label={t('sidebar.logout')}>
                        <LogOut className="shrink-0" size={18} />
                        <span className={NAV_TEXT}>{t('sidebar.logout')}</span>
                    </button>
                </div>

            </nav>

            <Dialog open={editorOpen && selectedFile !== null} onOpenChange={(open) => { if (!open) closeEditor(); }}>
                {selectedFile && (
                    <DialogContent
                        showCloseButton={false}
                        overlayClassName="z-[2000] bg-[rgba(31,22,12,0.42)] backdrop-blur-[6px] supports-backdrop-filter:backdrop-blur-[6px] motion-reduce:animate-none"
                        className="z-[2000] flex h-full max-h-none w-[calc(100vw-32px)] max-w-none flex-col gap-0 overflow-hidden rounded-2xl bg-[var(--surface-bg)] p-0 text-[length:inherit] shadow-[0_34px_90px_-42px_rgba(17,24,39,0.7)] ring-0 motion-reduce:animate-none sm:max-w-none min-[421px]:h-[calc(100%-16px)] min-[721px]:h-[80vh] min-[721px]:max-h-[90vh] min-[721px]:w-[800px] min-[721px]:max-w-[calc(100vw-32px)] min-[721px]:rounded-3xl"
                    >
                        <div className="flex items-center justify-between border-b border-[var(--border-light)] bg-[#fafafa] px-5 py-4">
                            <DialogTitle className="flex items-center gap-2 text-[0.9rem] font-medium text-foreground"><FileText size={16} aria-hidden="true" /><span>{knowledgeLabel(selectedFile)}</span></DialogTitle>
                            <div className="flex gap-1">
                                {isMarkdown && !isEditing && !selectedFile.readOnly && <button type="button" className="inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-[var(--text-secondary)] transition-colors hover:bg-[#f3f4f6] hover:text-foreground" onClick={() => setIsEditing(true)} title={t('editor.edit')} aria-label={t('editor.edit')}><Edit3 size={14} aria-hidden="true" /></button>}
                                {isEditing && <button type="button" className="inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-[var(--text-secondary)] transition-colors hover:bg-[#ecfdf5] hover:text-[#10b981]" onClick={handleSave} disabled={saving} title={t('editor.save')} aria-label={t('editor.save')}><Save size={14} aria-hidden="true" /></button>}
                                <button type="button" className="inline-flex size-7 items-center justify-center rounded-md border-0 bg-transparent text-[var(--text-secondary)] transition-colors hover:bg-[#f3f4f6] hover:text-foreground" onClick={closeEditor} title={t('editor.close')} aria-label={t('editor.close')}><X size={14} aria-hidden="true" /></button>
                            </div>
                        </div>
                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                            {isMarkdown && !isEditing ? (
                                <div className="min-h-0 flex-1 overflow-auto px-6 py-5"><div className="markdown-content leading-[1.7] text-foreground"><ReactMarkdown>{fileContent}</ReactMarkdown></div></div>
                            ) : !isEditing ? (
                                <div className="min-h-0 flex-1 overflow-auto px-6 py-5"><pre className="m-0 font-mono text-[0.85rem] leading-relaxed break-words whitespace-pre-wrap">{fileContent}</pre></div>
                            ) : (
                                <textarea
                                    aria-label={knowledgeLabel(selectedFile)}
                                    className="min-h-0 w-full flex-1 resize-none overflow-auto border-0 bg-[var(--surface-bg)] p-4 font-mono text-[0.85rem] leading-relaxed text-foreground outline-none"
                                    value={fileContent}
                                    onChange={(event) => setFileContent(event.target.value)}
                                />
                            )}
                        </div>
                    </DialogContent>
                )}
            </Dialog>
        </>
    );
};

export default Sidebar;
