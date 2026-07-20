import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { fetchSessionTree, fetchSession, setSessionEffort, setSessionModel } from '@/api/sessions';
import { SessionTreePanel } from '@/components/sessions/SessionTreePanel';
import { SessionDetailPanel } from '@/components/sessions/SessionDetailPanel';
import { SessionDiffView } from '@/components/sessions/SessionDiffView';
import { SessionFileExplorer } from '@/components/sessions/SessionFileExplorer';
import { SessionTerminal } from '@/components/sessions/SessionTerminal';
import { buildSelectionPrefill } from '@/components/sessions/diffPrefill';
import type { SessionSplitView } from '@/components/sessions/sessionSplitView';
import { ChatInput } from '@/components/chat/ChatInput';
import { ModelPicker } from '@/components/sessions/ModelPicker';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { wsClient } from '@/api/ws';
import { useEvent } from '@/hooks/useWebSocket';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import type { ImageAttachment } from '@/api/chat';
import type { SessionTreeResponse, SessionTreeTask, SessionRecord } from '@/types/session';
import type { SessionEffort } from '@open-walnut/core';
import { useResolvedSessionRecord } from '@/hooks/useSessionStatus';
import { useSessionControls } from '@/hooks/useSessionControls';
import { nextSessionControlValue } from '@/components/sessions/SessionControlPills';

const LS_HIDE_COMPLETED = 'open-walnut-session-tree-hide-completed';
const LS_LIST_WIDTH_KEY = 'open-walnut-session-list-width-v2';
const LIST_WIDTH_MIN = 260;
const LIST_WIDTH_MAX_PCT = 0.45;
const LIST_WIDTH_DEFAULT = 380;
const SESSION_PAGE_SIZE = 100;
const SESSION_PAGE_MAX = 500;

function clampWidth(w: number): number {
  const maxPx = typeof window !== 'undefined' ? window.innerWidth * LIST_WIDTH_MAX_PCT : 800;
  return Math.max(LIST_WIDTH_MIN, Math.min(w, maxPx));
}

function readListWidth(): number {
  try {
    const stored = localStorage.getItem(LS_LIST_WIDTH_KEY);
    if (stored) return clampWidth(Number(stored));
  } catch { /* ignore */ }
  return LIST_WIDTH_DEFAULT;
}

function readHideCompleted(): boolean {
  try {
    return localStorage.getItem(LS_HIDE_COMPLETED) === 'true';
  } catch {
    return false;
  }
}

export function SessionsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [treeData, setTreeData] = useState<SessionTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('id'));
  const [hideCompleted, setHideCompleted] = useState(readHideCompleted);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [limit, setLimit] = useState(SESSION_PAGE_SIZE);
  const [treeRefreshing, setTreeRefreshing] = useState(false);
  const treeRequestRef = useRef(0);
  const directRequestRef = useRef(0);
  const mobileBackSessionRef = useRef<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Fallback session fetched directly when URL has ?id= but the session isn't in the tree
  const [directSession, setDirectSession] = useState<SessionRecord | null>(null);
  const [selectedCache, setSelectedCache] = useState<{
    id: string;
    session: SessionRecord;
    taskTitle?: string;
  } | null>(null);

  const refreshDirectSession = useCallback(async (sessionId: string) => {
    const requestId = ++directRequestRef.current;
    const session = await fetchSession(sessionId);
    if (requestId !== directRequestRef.current || selectedIdRef.current !== sessionId) return;
    if (session?.claudeSessionId === sessionId) setDirectSession(session);
  }, []);

  const sessionSend = useSessionSend(selectedId);
  // isStreaming bubbles up from SessionDetailPanel → SessionChatHistory's single
  // useSessionStream mount. Mounting a second hook here (previous pattern) doubled
  // stream-subscribe RPCs and produced two parallel defensive-clear paths.
  const [isStreaming, setIsStreaming] = useState(false);
  const handleBack = useCallback(() => {
    // location.key === 'default' means no prior in-app navigation (new tab, bookmark, direct URL)
    if (location.key === 'default') {
      navigate('/');
    } else {
      navigate(-1);
    }
  }, [navigate, location.key]);

  // Resizable list pane
  const [listWidth, setListWidth] = useState(readListWidth);
  const isResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const listPaneRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = listWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    listPaneRef.current?.classList.add('resizing');

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = clampWidth(startWidthRef.current + (ev.clientX - startXRef.current));
      setListWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      listPaneRef.current?.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [listWidth]);

  useEffect(() => {
    try { localStorage.setItem(LS_LIST_WIDTH_KEY, String(listWidth)); } catch { /* ignore */ }
  }, [listWidth]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Re-clamp list width when window resizes (e.g. zoom change, small screen)
  useEffect(() => {
    const onResize = () => setListWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadTree = useCallback(() => {
    const requestId = ++treeRequestRef.current;
    setTreeRefreshing(true);
    setError(null);
    fetchSessionTree({ hideCompleted, q: debouncedQuery, limit })
      .then((data) => {
        if (requestId === treeRequestRef.current) setTreeData(data);
      })
      .catch((e: Error) => {
        if (requestId === treeRequestRef.current) setError(e.message);
      })
      .finally(() => {
        if (requestId === treeRequestRef.current) {
          setLoading(false);
          setTreeRefreshing(false);
        }
      });
  }, [hideCompleted, debouncedQuery, limit]);

  useEffect(() => { loadTree(); }, [loadTree]);

  useEvent('session:started', () => { loadTree(); });
  useEvent('session:ended', () => { loadTree(); });
  useEvent('session:result', () => { loadTree(); });
  // Re-fetch tree on WebSocket reconnect — events during disconnect are lost
  useEvent('_ws:reconnected', () => { loadTree(); });
  useEvent('session:error', (data: unknown) => {
    const d = data as { sessionId?: string };
    if (d.sessionId && d.sessionId === selectedId && !treeSession) {
      void refreshDirectSession(d.sessionId);
    }
  });
  useEvent('session:status-changed', (data: unknown) => {
    const d = data as {
      sessionId?: string;
      previousSessionId?: string;
      fromPlanSessionId?: string;
      status?: { sessionId?: string };
    };
    const nextSessionId = d.status?.sessionId ?? d.sessionId;
    const previousSessionId = d.previousSessionId ?? d.fromPlanSessionId;
    if (previousSessionId && nextSessionId && previousSessionId === selectedId) {
      setSelectedId(nextSessionId);
    }
  });

  const handleToggleHideCompleted = () => {
    setHideCompleted((prev) => {
      const next = !prev;
      localStorage.setItem(LS_HIDE_COMPLETED, String(next));
      return next;
    });
    setLimit(SESSION_PAGE_SIZE);
  };

  const handleSearchChange = useCallback((value: string) => {
    setQuery(value);
    setLimit(SESSION_PAGE_SIZE);
  }, []);

  // Keep URL search param in sync with selected session
  useEffect(() => {
    const urlId = searchParams.get('id');
    if (selectedId && selectedId !== urlId) {
      setSearchParams({ id: selectedId }, { replace: true });
    } else if (!selectedId && urlId) {
      setSearchParams({}, { replace: true });
    }
  }, [selectedId, searchParams, setSearchParams]);

  // Find the selected session record and its task title
  const { treeSession, selectedTaskTitle } = useMemo(() => {
    type Result = { treeSession: SessionRecord | null; selectedTaskTitle: string | undefined };
    if (!selectedId || !treeData) return { treeSession: null, selectedTaskTitle: undefined } as Result;

    const checkTask = (t: { taskTitle: string; sessions: SessionRecord[] }): Result | null => {
      for (const s of t.sessions) {
        if (s.claudeSessionId === selectedId) {
          return { treeSession: s, selectedTaskTitle: t.taskTitle };
        }
      }
      return null;
    };

    for (const cat of treeData.tree) {
      for (const t of cat.directTasks) {
        const r = checkTask(t);
        if (r) return r;
      }
      for (const proj of cat.projects) {
        for (const t of proj.tasks) {
          const r = checkTask(t);
          if (r) return r;
        }
      }
    }
    for (const s of treeData.orphanSessions) {
      if (s.claudeSessionId === selectedId) return { treeSession: s, selectedTaskTitle: undefined } as Result;
    }
    return { treeSession: null, selectedTaskTitle: undefined } as Result;
  }, [selectedId, treeData]);

  // When a session ID is in the URL but not found in the tree (e.g. filtered out),
  // fetch it directly so the detail panel still works.
  useEffect(() => {
    if (!selectedId) {
      directRequestRef.current++;
      setDirectSession(null);
      setSelectedCache(null);
      return;
    }
    if (treeSession) {
      directRequestRef.current++;
      setDirectSession(null);
      return;
    }
    // Not in tree — fetch directly
    void refreshDirectSession(selectedId);
  }, [selectedId, treeSession, refreshDirectSession]);

  useEffect(() => {
    const session = treeSession
      ?? (directSession?.claudeSessionId === selectedId ? directSession : null);
    if (!selectedId || !session) return;
    setSelectedCache((previous) => {
      const taskTitle = selectedTaskTitle
        ?? (previous?.id === selectedId ? previous.taskTitle : undefined);
      if (previous?.id === selectedId
        && previous.session === session
        && previous.taskTitle === taskTitle) return previous;
      return { id: selectedId, session, taskTitle };
    });
  }, [selectedId, treeSession, directSession, selectedTaskTitle]);

  const selectedSessionRecord = treeSession
    ?? (directSession?.claudeSessionId === selectedId ? directSession : null)
    ?? (selectedCache?.id === selectedId ? selectedCache.session : null);
  const selectedSession = useResolvedSessionRecord(selectedSessionRecord);
  const { controls: sessionControls, setControl: setSessionControl } = useSessionControls(
    selectedSession?.claudeSessionId,
    selectedSession?.engine,
  );
  const resolvedTaskTitle = selectedTaskTitle
    ?? (selectedCache?.id === selectedId ? selectedCache.taskTitle : undefined);
  const handleMobileDetailBack = useCallback(() => {
    mobileBackSessionRef.current = selectedId;
    setSelectedId(null);
  }, [selectedId]);

  useEffect(() => {
    if (selectedSession && window.matchMedia('(max-width: 768px)').matches) {
      const frame = requestAnimationFrame(() => {
        document.querySelector<HTMLButtonElement>('.sessions-mobile-detail-back')?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!selectedId && mobileBackSessionRef.current) {
      const sessionId = mobileBackSessionRef.current;
      mobileBackSessionRef.current = null;
      const frame = requestAnimationFrame(() => {
        const rows = listPaneRef.current?.querySelectorAll<HTMLButtonElement>('[data-session-id]');
        const row = rows ? [...rows].find((candidate) => candidate.dataset.sessionId === sessionId) : undefined;
        row?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: 'nearest' });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [selectedId, selectedSession]);

  // Slash command autocomplete for session input — pass host so REMOTE sessions
  // get the remote host's skills, not the Mac's local ones.
  const { items: slashCommands, search: searchSlashCommands, refresh: refreshSlashCommands } = useSlashCommands(selectedSession?.cwd, selectedSession?.host);

  // When "Clear Context & Execute" replaces the session, switch to the new session
  const handleSessionReplaced = useCallback((newSessionId: string) => {
    setSelectedId(newSessionId);
    loadTree();
  }, [loadTree]);

  // Wrap edit/delete callbacks to inject selectedId
  const handleEditQueued = useCallback((queueId: string, newText: string) => {
    if (!selectedId) return;
    sessionSend.handleEditQueued(selectedId, queueId, newText);
  }, [selectedId, sessionSend]);

  const handleDeleteQueued = useCallback((queueId: string) => {
    if (!selectedId) return;
    sessionSend.handleDeleteQueued(selectedId, queueId);
  }, [selectedId, sessionSend]);

  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    if (!selectedId) return;
    return sessionSend.send(selectedId, message, images);
  }, [selectedId, sessionSend]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    if (!selectedId) return;
    return sessionSend.interruptSend(selectedId, message, images);
  }, [selectedId, sessionSend]);

  const handleRetryFailed = useCallback((queueId: string) => {
    if (!selectedId) return;
    sessionSend.retryFailed(queueId, selectedId);
  }, [selectedId, sessionSend]);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // Changed / Files / Terminal share ONE full-screen split: [ left panel | chat ].
  // The page owns the ChatInput, so it also owns the left column + prefill driver.
  // CSS-promotion fullscreen (no remount — the chat below stays mounted).
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();
  const [activeView, setActiveView] = useState<SessionSplitView | null>(null);
  const splitOpen = activeView !== null;
  const [prefillText, setPrefillText] = useState<string | undefined>(undefined);
  const [prefillNonce, setPrefillNonce] = useState(0);
  // Chat column in the split: resizable width (% of viewport) + collapse.
  const chatPanel = useResizablePanel('open-walnut-changed-chat-w', 30, 'right');
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const handleSelectCode = useCallback((filePath: string, line: number | undefined, code: string) => {
    setPrefillText(buildSelectionPrefill(filePath, line, code));
    setPrefillNonce((n) => n + 1);
  }, []);
  // A line comment from the diff → send straight to this session's main agent.
  const handleDiffComment = useCallback((message: string) => {
    if (!selectedId) return false;
    void sessionSend.send(selectedId, message);
    return true;
  }, [selectedId, sessionSend]);
  // Toggle a split view: same view → close (exit fullscreen); other/none → open it.
  const selectView = useCallback((view: SessionSplitView) => {
    setActiveView((cur) => {
      const next = cur === view ? null : view;
      if (next) enterFullscreen(); else { exitFullscreen(); setChatCollapsed(false); }
      return next;
    });
  }, [enterFullscreen, exitFullscreen]);
  // ESC / backdrop exits fullscreen → also close the split view.
  useEffect(() => {
    if (!isFullscreen && splitOpen) setActiveView(null);
  }, [isFullscreen, splitOpen]);
  // Switching sessions closes the split view.
  useEffect(() => {
    setActiveView(null);
    setChatCollapsed(false);
    exitFullscreen();
  }, [selectedId, exitFullscreen]);

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      setModelPickerOpen(true);
    }
  }, []);

  const handleModelSwitch = useCallback((model: string) => {
    setModelPickerOpen(false);
    if (!selectedId) return;
    // Live switch via apply_flag_settings (no respawn) — same mechanism as effort.
    setSessionModel(selectedId, model).catch((err: Error) => {
      console.error('Model switch failed:', err);
    });
  }, [selectedId]);

  const handleEffortSwitch = useCallback((effort: import('@open-walnut/core').SessionEffort) => {
    setModelPickerOpen(false);
    if (!selectedId) return;
    // Optimistically reflect the new effort so the header badge updates immediately.
    // The session can live deep in the tree (category → project/directTasks → task →
    // sessions) or as a directly-fetched orphan, so patch both. Backend delivers it
    // live via apply_flag_settings (no respawn) and persists it; revert on failure.
    const applyEffortToTree = (data: SessionTreeResponse, value?: SessionEffort): SessionTreeResponse => {
      const patch = (s: SessionRecord): SessionRecord =>
        s.claudeSessionId === selectedId ? { ...s, effort: value } : s;
      const patchTask = (t: SessionTreeTask): SessionTreeTask => ({ ...t, sessions: t.sessions.map(patch) });
      return {
        ...data,
        tree: data.tree.map((cat) => ({
          ...cat,
          projects: cat.projects.map((p) => ({ ...p, tasks: p.tasks.map(patchTask) })),
          directTasks: cat.directTasks.map(patchTask),
        })),
        orphanSessions: data.orphanSessions.map(patch),
      };
    };
    setTreeData((prev) => prev ? applyEffortToTree(prev, effort) : prev);
    setDirectSession((prev) => prev && prev.claudeSessionId === selectedId ? { ...prev, effort } : prev);
    setSessionEffort(selectedId, effort).catch((err: Error) => {
      console.error('Effort switch failed:', err);
      const prevEffort = selectedSession?.effort;
      setTreeData((prev) => prev ? applyEffortToTree(prev, prevEffort) : prev);
      setDirectSession((prev) => prev && prev.claudeSessionId === selectedId ? { ...prev, effort: prevEffort } : prev);
    });
  }, [selectedId, selectedSession?.effort]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div className={`sessions-split-view${selectedSession ? ' has-selection' : ''}`}>
      <div
        className="sessions-list-pane"
        ref={listPaneRef}
        style={{ width: listWidth, flex: `0 0 ${listWidth}px` }}
      >
        <SessionTreePanel
          tree={treeData?.tree ?? []}
          orphanSessions={treeData?.orphanSessions ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          hideCompleted={hideCompleted}
          onToggleHideCompleted={handleToggleHideCompleted}
          onBack={handleBack}
          query={query}
          onQueryChange={handleSearchChange}
          total={treeData?.total ?? 0}
          remaining={treeData?.remaining ?? 0}
          hasMore={treeData?.hasMore ?? false}
          loadingMore={treeRefreshing && !loading}
          onLoadMore={() => setLimit((current) => Math.min(SESSION_PAGE_MAX, current + SESSION_PAGE_SIZE))}
        />
      </div>
      <div className="sessions-resize-handle" onMouseDown={handleResizeStart} />
      {FullscreenBackdrop}
      <div className={`sessions-detail-pane${fullscreenClass}${splitOpen ? ' is-changed-open' : ''}`}>
        {selectedSession && (
          <button
            type="button"
            className="sessions-mobile-detail-back"
            onClick={handleMobileDetailBack}
            aria-label="Back to sessions"
          >
            &larr; Sessions
          </button>
        )}
        {/* Split: when a view (Changed/Files/Terminal) is open, that panel is the
            left column, the existing detail+chat on the right. Closed →
            display:contents (no layout change). */}
        <div className={`sessions-detail-split${splitOpen ? ' is-changed-open' : ''}${splitOpen && chatCollapsed ? ' is-chat-collapsed' : ''}`}>
          {splitOpen && selectedId && (
            <div className="sessions-detail-diff-col">
              {activeView === 'changed' && (
                <SessionDiffView sessionId={selectedId} sessionCwd={selectedSession?.cwd} sessionHost={selectedSession?.host} onSelectCode={handleSelectCode} onComment={handleDiffComment} />
              )}
              {activeView === 'files' && (
                <SessionFileExplorer cwd={selectedSession?.cwd} host={selectedSession?.host} sessionId={selectedId} />
              )}
              {activeView === 'terminal' && (
                <SessionTerminal
                  sessionId={selectedId}
                  label={selectedSession?.cwd ?? selectedSession?.host ?? 'Terminal'}
                  host={selectedSession?.host}
                  onClose={() => selectView('terminal')}
                  embedded
                />
              )}
            </div>
          )}
          {splitOpen && (
            chatCollapsed ? (
              <button
                className="session-chat-collapsed-rail"
                onClick={() => setChatCollapsed(false)}
                title="Show chat"
              >💬</button>
            ) : (
              <div className="sessions-detail-chat-resize" onMouseDown={chatPanel.handleResizeStart} title="Drag to resize chat" />
            )
          )}
          <div
            className="sessions-detail-chat-col"
            ref={splitOpen ? chatPanel.panelRef : undefined}
            style={splitOpen && !chatCollapsed ? { width: chatPanel.width, flex: `0 0 ${chatPanel.width}` } : undefined}
          >
            {splitOpen && !chatCollapsed && (
              <button
                className="session-chat-collapse-btn"
                onClick={() => setChatCollapsed(true)}
                title="Collapse chat"
              >⟩</button>
            )}
        <SessionDetailPanel
          session={selectedSession}
          taskTitle={resolvedTaskTitle}
          onTitleChanged={loadTree}
          onSessionReplaced={handleSessionReplaced}
          optimisticMessages={sessionSend.optimisticMsgs}
          onMessagesDelivered={sessionSend.handleMessagesDelivered}
          onBatchCompleted={sessionSend.handleBatchCompleted}
          onBatchFailed={sessionSend.handleBatchFailed}
          onEditQueued={handleEditQueued}
          onDeleteQueued={handleDeleteQueued}
          onAgentQueued={sessionSend.addExternalQueued}
          onRetryFailed={handleRetryFailed}
          onDismissFailed={sessionSend.dismissFailed}
          onStreamingChange={setIsStreaming}
          activeView={activeView}
          onSelectView={selectedSession ? selectView : undefined}
          onModelPillClick={() => setModelPickerOpen((v) => !v)}
          sessionControls={sessionControls}
          setSessionControl={setSessionControl}
        />
        {selectedSession && (
          <div className="session-chat-input-wrapper">
            {sessionSend.sendError && (
              <div className="session-send-error text-xs" style={{ color: 'var(--danger, var(--error))', padding: '4px 16px' }}>
                {sessionSend.sendError}
              </div>
            )}
            <ChatInput
              onSend={handleSend}
              onInterruptSend={handleInterruptSend}
              isStreaming={isStreaming}
              placeholder="Send a message to this session... (/ for commands)"
              showCommands={false}
              sessionCommands={slashCommands}
              searchSessionCommands={searchSlashCommands}
              onRefreshSessionCommands={refreshSlashCommands}
              onControlCommand={handleControlCommand}
              draftKey={selectedId ? `draft:session:${selectedId}` : undefined}
              prefillText={prefillText}
              prefillNonce={prefillNonce}
              onToggleMode={selectedSession.engine === 'codex' ? () => {
                const control = sessionControls.find((candidate) => candidate.id === 'mode');
                const next = nextSessionControlValue(control);
                if (control && next) void setSessionControl(control.id, next);
              } : undefined}
            />
            {modelPickerOpen && (
              <ModelPicker
                currentModel={selectedSession?.model}
                currentEffort={selectedSession?.effectiveEffort ?? selectedSession?.effort}
                sessionId={selectedId ?? undefined}
                host={selectedSession?.host}
                onSwitch={handleModelSwitch}
                onEffortSwitch={handleEffortSwitch}
                onClose={() => setModelPickerOpen(false)}
              />
            )}
          </div>
        )}
          </div>{/* .sessions-detail-chat-col */}
        </div>{/* .sessions-detail-split */}
      </div>
    </div>
  );
}
