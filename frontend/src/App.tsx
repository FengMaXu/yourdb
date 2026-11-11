import React, { useEffect, useState, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import ToolPanel, { type ToolData } from './components/ToolPanel';
import SettingsPanel from './components/SettingsPanel';
import PluginsPanel from './components/PluginsPanel';
import { CHAT_VIEW, type WorkspaceView } from './components/workspace-view';
import { SetupPrompt } from './components/ModelSetupPrompt';
import { ReadinessProvider, useReadiness } from './hooks/useReadiness';
import type { SettingsSection } from './components/SettingsPanel';
import { SessionProvider } from './hooks/useSession';
import { NARROW_QUERY, useMediaQuery } from './hooks/useMediaQuery';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { useLanguage } from './context/LanguageContext';
import { PreviewProvider } from './context/PreviewContext';
import { getConfigViaRuntime } from './api/runtime-client';
import LoginView from './components/LoginView';
import GlobalPreviewModal from './components/common/GlobalPreviewModal';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { SkipLink } from './components/SkipLink';

type StartupState = 'checking' | 'ready' | 'error';

interface AppShellProps {
  startupState: StartupState;
  onRetryStartup: () => void;
  /** Bumped when a chat is refused for lack of a model. */
  modelMissingSignal: number;
  onModelMissing: () => void;
}

const DESKTOP_MENU_ITEMS = [
  { id: 'file', labelKey: 'desktop.file' },
  { id: 'edit', labelKey: 'desktop.edit' },
  { id: 'view', labelKey: 'desktop.view' },
  { id: 'window', labelKey: 'desktop.window' },
  { id: 'help', labelKey: 'desktop.help' },
];

const TOOL_PANEL_MIN_WIDTH = 300;
const DEFAULT_CHAT_RATIO = 0.64;
const CHAT_PANEL_MIN_WIDTH = 560;
// Hovering the collapsed rail peeks the full sidebar, pushing the page right; short delays keep a passing pointer from flickering it.
const SIDEBAR_PEEK_OPEN_DELAY = 80;
const SIDEBAR_PEEK_CLOSE_DELAY = 180;

/** The full-window screen shown while the app starts or when it could not. */
const APP_LOADING = 'grid min-h-screen place-items-center bg-paper font-semibold tracking-[0.02em] text-body';

/** The "N steps left" strip; it also re-checks setup on the way back from settings, which save without notifying the shell. */
const SetupBanner: React.FC<{ isChatView: boolean; hidden: boolean }> = ({ isChatView, hidden }) => {
  const readiness = useReadiness();
  const readyRef = useRef(readiness.ready);
  readyRef.current = readiness.ready;
  const { recheck } = readiness;
  useEffect(() => {
    if (isChatView && !readyRef.current) recheck();
  }, [isChatView, recheck]);
  if (hidden || readiness.remaining === 0) return null;
  const next = readiness.model === 'missing' ? 'model' : 'database';
  return <SetupPrompt remaining={readiness.remaining} next={next} onConfigure={() => readiness.openSettings(next)} />;
};

const AppShell: React.FC<AppShellProps> = ({ startupState, onRetryStartup, modelMissingSignal, onModelMissing }) => {
  const { t } = useLanguage();
  const [tools, setTools] = useState<ToolData[]>([]);
  const [isToolPanelOpen, setIsToolPanelOpen] = useState(false);
  // The sidebar follows the tool panel (closed while it is open, open otherwise).
  // A manual toggle overrides that only until the tool panel next opens or closes.
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  // On a narrow window the full sidebar would squeeze the page, so it starts as the rail.
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const isSidebarOpen = sidebarOverride ?? (!isToolPanelOpen && !isNarrow);
  const [isSidebarPeeking, setIsSidebarPeeking] = useState(false);
  const [activeView, setActiveView] = useState<WorkspaceView>(CHAT_VIEW);
  const sidebarPeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const previousToolsRef = useRef<ToolData[]>([]);
  const chatPanelShellRef = useRef<HTMLDivElement>(null);
  const chatMainPaneRef = useRef<HTMLDivElement>(null);
  const chatResizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const chatPaneRatioRef = useRef<number | null>(null);
  // While the chat pane is resized, a full-window layer carries the cursor and keeps text from being selected.
  const [isResizingChat, setIsResizingChat] = useState(false);
  const [chatPaneWidth, setChatPaneWidth] = useState<number | null>(null);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.dataAgent);

  const scheduleSidebarPeek = useCallback((peek: boolean) => {
    if (sidebarPeekTimerRef.current) clearTimeout(sidebarPeekTimerRef.current);
    sidebarPeekTimerRef.current = setTimeout(() => {
      sidebarPeekTimerRef.current = null;
      setIsSidebarPeeking(peek);
    }, peek ? SIDEBAR_PEEK_OPEN_DELAY : SIDEBAR_PEEK_CLOSE_DELAY);
  }, []);

  const toggleSidebarPinned = useCallback(() => {
    if (sidebarPeekTimerRef.current) clearTimeout(sidebarPeekTimerRef.current);
    sidebarPeekTimerRef.current = null;
    setIsSidebarPeeking(false);
    setSidebarOverride(!isSidebarOpen);
  }, [isSidebarOpen]);

  useEffect(() => () => {
    if (sidebarPeekTimerRef.current) clearTimeout(sidebarPeekTimerRef.current);
  }, []);

  const openSettings = useCallback((section: SettingsSection) => setActiveView({ kind: 'settings', section }), []);

  const handleUpdateTools = useCallback((newTools: ToolData[]) => {
    setTools(newTools);
    previousToolsRef.current = newTools;
  }, []);

  const getAvailablePaneWidth = useCallback(() => {
    // Read the width the sidebar is settling to, not its mid-transition box.
    const sidebarWidth = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(isSidebarOpen ? '--sidebar-width' : '--sidebar-rail-width'),
    ) || (isSidebarOpen ? 184 : 64);
    const chromeAllowance = 40;
    return Math.max(
      CHAT_PANEL_MIN_WIDTH + TOOL_PANEL_MIN_WIDTH,
      window.innerWidth - sidebarWidth - chromeAllowance,
    );
  }, [isSidebarOpen]);

  const getMaxChatPaneWidth = useCallback(() => (
    Math.max(CHAT_PANEL_MIN_WIDTH, getAvailablePaneWidth() - TOOL_PANEL_MIN_WIDTH)
  ), [getAvailablePaneWidth]);

  const recordChatPaneWidth = useCallback((nextWidth: number) => {
    const available = Math.max(CHAT_PANEL_MIN_WIDTH, getMaxChatPaneWidth());
    const clamped = Math.min(available, Math.max(CHAT_PANEL_MIN_WIDTH, nextWidth));
    chatPaneRatioRef.current = clamped / available;
    setChatPaneWidth(clamped);
  }, [getMaxChatPaneWidth]);

  const openToolPanel = useCallback(() => {
    // Clicking a tool row while the panel is already open must not undo a manual sidebar toggle.
    if (isToolPanelOpen) return;
    recordChatPaneWidth(getAvailablePaneWidth() * DEFAULT_CHAT_RATIO);
    setSidebarOverride(null);
    setIsToolPanelOpen(true);
  }, [getAvailablePaneWidth, isToolPanelOpen, recordChatPaneWidth]);

  const closeToolPanel = useCallback(() => {
    setSidebarOverride(null);
    setIsToolPanelOpen(false);
  }, []);

  const toggleToolPanel = useCallback(() => {
    if (isToolPanelOpen) {
      closeToolPanel();
      return;
    }
    openToolPanel();
  }, [closeToolPanel, isToolPanelOpen, openToolPanel]);

  const handleChatResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const currentWidth = chatMainPaneRef.current?.getBoundingClientRect().width ?? CHAT_PANEL_MIN_WIDTH;
    chatResizeStartRef.current = {
      startX: event.clientX,
      startWidth: currentWidth,
    };
    setIsResizingChat(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!chatResizeStartRef.current) return;
      const { startX, startWidth } = chatResizeStartRef.current;
      const maxWidth = getMaxChatPaneWidth();
      const nextWidth = Math.min(
        maxWidth,
        Math.max(CHAT_PANEL_MIN_WIDTH, startWidth + (moveEvent.clientX - startX)),
      );
      recordChatPaneWidth(nextWidth);
    };

    const handleMouseUp = () => {
      chatResizeStartRef.current = null;
      setIsResizingChat(false);
      window.removeEventListener('mousemove', handleMouseMove);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp, { once: true });
  }, [getMaxChatPaneWidth, recordChatPaneWidth]);

  const handleChatResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const maxWidth = getMaxChatPaneWidth();
    setChatPaneWidth((current) => {
      const width = current ?? chatMainPaneRef.current?.getBoundingClientRect().width ?? CHAT_PANEL_MIN_WIDTH;
      let next: number;
      if (event.key === 'Home') next = CHAT_PANEL_MIN_WIDTH;
      else if (event.key === 'End') next = maxWidth;
      else {
        const delta = event.key === 'ArrowRight' ? 40 : -40;
        next = Math.min(maxWidth, Math.max(CHAT_PANEL_MIN_WIDTH, width + delta));
      }
      chatPaneRatioRef.current = next / Math.max(CHAT_PANEL_MIN_WIDTH, maxWidth);
      return next;
    });
  }, [getMaxChatPaneWidth]);

  useEffect(() => {
    if (chatPaneWidth == null) {
      return;
    }

    const handleResize = () => {
      const available = Math.max(CHAT_PANEL_MIN_WIDTH, getMaxChatPaneWidth());
      setChatPaneWidth((current) => {
        if (current == null) return current;
        const ratio = chatPaneRatioRef.current ?? current / available;
        const next = Math.min(available, Math.max(CHAT_PANEL_MIN_WIDTH, ratio * available));
        chatPaneRatioRef.current = next / available;
        return next;
      });
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [chatPaneWidth, getMaxChatPaneWidth, isSidebarOpen]);

  if (startupState === 'checking') {
    return <div className={APP_LOADING}>{t('app.preparing')}</div>;
  }

  if (startupState === 'error') {
    return (
      <div className={APP_LOADING} role="alert">
        <p>{t('app.startupError')}</p>
        <button type="button" onClick={onRetryStartup}>{t('app.retry')}</button>
      </div>
    );
  }

  return (
    <ReadinessProvider onOpenSettings={openSettings} modelMissingSignal={modelMissingSignal}>
    <SessionProvider>
      <div className="flex h-full min-h-0 w-full flex-col bg-transparent">
        <SkipLink href="#main-content">{t('accessibility.skipToContent')}</SkipLink>
        {isDesktop && (
          <div className="flex h-[34px] shrink-0 items-center gap-0.5 border-b border-[rgba(120,53,15,0.08)] bg-[rgba(255,250,242,0.66)] px-2.5 text-foreground backdrop-blur-[18px] max-[720px]:hidden" role="menubar" aria-label={t('desktop.menu')}>
            {DESKTOP_MENU_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="h-7 cursor-pointer rounded-md border-0 bg-transparent px-2.5 text-[0.86rem] text-inherit transition-[background-color,transform] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 pointer-fine:hover:bg-white/64"
                role="menuitem"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  void window.dataAgent?.showMenu(item.id, {
                    x: Math.round(rect.left),
                    y: Math.round(rect.bottom),
                  });
                }}
              >
                {t(item.labelKey)}
              </button>
            ))}
          </div>
        )}

        <SetupBanner isChatView={activeView.kind === 'chat'} hidden={activeView.kind === 'settings'} />

        {/* The framed workspace: inset on a wide window, edge to edge on a phone. */}
        <div className="relative m-3.5 flex min-h-0 flex-1 overflow-hidden rounded-[20px] border border-border bg-[var(--frame-surface)] p-0 shadow-[0_1px_2px_rgba(28,25,23,0.04),0_24px_48px_-32px_rgba(28,25,23,0.18)] max-[1100px]:m-2 max-[720px]:m-0 max-[720px]:min-h-dvh max-[720px]:rounded-none max-[720px]:border-0">
          <div
            className={cn(
              'relative z-20 flex min-w-0 flex-none self-stretch border-r border-border bg-[var(--frame-rail)] transition-[width] motion-reduce:transition-none',
              isSidebarOpen || isSidebarPeeking ? 'w-[var(--sidebar-width)]' : 'w-[var(--sidebar-rail-width)]',
              isSidebarOpen && 'max-[720px]:w-[112px]',
            )}
            // Tracked while open too, so the hover state is never stale when the sidebar auto-collapses.
            onMouseEnter={() => scheduleSidebarPeek(true)}
            onMouseLeave={() => scheduleSidebarPeek(false)}
          >
            <Sidebar
              activeView={activeView}
              onNavigate={setActiveView}
              collapsed={!isSidebarOpen && !isSidebarPeeking}
              pinned={isSidebarOpen}
              onExpand={() => setSidebarOverride(true)}
              onTogglePinned={toggleSidebarPinned}
            />
          </div>

          {/* The chat stays mounted behind settings pages so a running turn keeps streaming. */}
          <div
            ref={chatPanelShellRef}
            className="relative flex h-auto w-auto min-w-0 flex-auto items-stretch overflow-hidden rounded-none border-0 bg-[var(--frame-surface)] [&[hidden]]:hidden"
            hidden={activeView.kind !== 'chat'}
          >
            <div
              ref={chatMainPaneRef}
              className="relative flex min-h-0 min-w-[560px] flex-auto overflow-hidden max-[1100px]:min-w-0"
              style={isToolPanelOpen && chatPaneWidth ? { flex: `0 0 ${chatPaneWidth}px`, width: chatPaneWidth } : undefined}
            >
              {isToolPanelOpen && (
                <div
                  className={cn(
                    'group/resize absolute top-[18px] right-0 z-[12] flex h-[calc(100%-36px)] w-4 cursor-ew-resize items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand',
                    'after:h-14 after:w-[3px] after:rounded-full after:bg-[rgba(120,53,15,0.18)] after:opacity-0 after:transition-[opacity,background-color,transform] motion-reduce:after:transition-none',
                    'hover:after:scale-y-[1.08] hover:after:bg-[rgba(194,65,12,0.42)] hover:after:opacity-100',
                    isResizingChat && 'after:scale-y-[1.08] after:bg-[rgba(194,65,12,0.42)] after:opacity-100',
                  )}
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={CHAT_PANEL_MIN_WIDTH}
                  aria-valuemax={typeof window !== 'undefined' ? getMaxChatPaneWidth() : CHAT_PANEL_MIN_WIDTH}
                  aria-valuenow={Math.round(chatPaneWidth ?? CHAT_PANEL_MIN_WIDTH)}
                  aria-label={t('chat.resizeWidth')}
                  title={t('chat.resizeWidth')}
                  tabIndex={0}
                  onMouseDown={handleChatResizeStart}
                  onKeyDown={handleChatResizeKeyDown}
                />
              )}

              <ChatArea
                onUpdateTools={handleUpdateTools}
                onOpenToolPanel={openToolPanel}
                onToggleToolPanel={toggleToolPanel}
                isToolPanelOpen={isToolPanelOpen}
                hasTools={tools.length > 0}
                onModelNotConfigured={onModelMissing}
              />
            </div>

            {isToolPanelOpen && <ToolPanel tools={tools} onClose={closeToolPanel} />}
          </div>
          {isResizingChat && <div className="fixed inset-0 z-[3000] cursor-ew-resize select-none" aria-hidden="true" />}

          {activeView.kind !== 'chat' && (
            <div className="flex min-w-0 flex-auto overflow-hidden bg-[var(--frame-surface)]">
              {activeView.kind === 'plugins'
                ? <PluginsPanel tab={activeView.tab} onOpenDatabaseSettings={() => setActiveView({ kind: 'settings', section: 'database' })} />
                : <SettingsPanel section={activeView.section} />}
            </div>
          )}
        </div>
      </div>
    </SessionProvider>
    </ReadinessProvider>
  );
};

const App: React.FC = () => {
  const [startupState, setStartupState] = useState<StartupState>('checking');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [modelMissingSignal, setModelMissingSignal] = useState(0);
  const { status } = useAuth();
  const { t } = useLanguage();

  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }

    let cancelled = false;
    setStartupState('checking');

    const completeStartupCheck = async () => {
      try {
        // Reading the settings proves the runtime answers; what is set up is the checklist's business.
        await getConfigViaRuntime();
        if (cancelled) return;
        setStartupState('ready');
      } catch (error) {
        console.error('Startup config check failed:', error);
        if (!cancelled) setStartupState('error');
      }
    };

    void completeStartupCheck();
    return () => {
      cancelled = true;
    };
  }, [status, startupAttempt]);

  const markModelMissing = useCallback(() => setModelMissingSignal((signal) => signal + 1), []);

  if (status === 'checking') {
    return <div className={APP_LOADING}>{t('app.preparing')}</div>;
  }

  if (status === 'anonymous') {
    return <LoginView />;
  }

  return (
    <PreviewProvider>
      <AppShell
        startupState={startupState}
        onRetryStartup={() => setStartupAttempt((attempt) => attempt + 1)}
        modelMissingSignal={modelMissingSignal}
        onModelMissing={markModelMissing}
      />
      <GlobalPreviewModal />
      {/* Short confirmations and errors from the sidebar; it used to draw its own toast at the same spot. */}
      <Toaster position="bottom-center" offset={112} />
    </PreviewProvider>
  );
};

/** The workspace app, loaded lazily by Root for /app and the desktop runtime. */
const AppRoot: React.FC = () => (
  <AuthProvider>
    <App />
  </AuthProvider>
);

export default AppRoot;
