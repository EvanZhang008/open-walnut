import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { fetchSessionTree, fetchSession } from '@/api/sessions';
import { SessionTreePanel } from '@/components/sessions/SessionTreePanel';
import { SessionDetailPanel } from '@/components/sessions/SessionDetailPanel';
import { ChatInput } from '@/components/chat/ChatInput';
import { ModelPicker } from '@/components/sessions/ModelPicker';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { wsClient } from '@/api/ws';
import { useEvent } from '@/hooks/useWebSocket';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSessionStream } from '@/hooks/useSessionStream';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import type { ImageAttachment } from '@/api/chat';
import type { SessionTreeResponse, SessionRecord } from '@/types/session';

const LS_HIDE_COMPLETED = 'open-walnut-session-tree-hide-completed';
const LS_LIST_WIDTH_KEY = 'open-walnut-session-list-width-v2';
const LIST_WIDTH_MIN = 260;
const LIST_WIDTH_MAX_PCT = 0.45;
const LIST_WIDTH_DEFAULT = 380;

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
  // Fallback session fetched directly when URL has ?id= but the session isn't in the tree
  const [directSession, setDirectSession] = useState<SessionRecord | null>(null);

  const sessionSend = useSessionSend(selectedId);
  const { isStreaming } = useSessionStream(selectedId);
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

  // Re-clamp list width when window resizes (e.g. zoom change, small screen)
  useEffect(() => {
    const onResize = () => setListWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadTree = useCallback(() => {
    fetchSessionTree(hideCompleted)
      .then((data) => setTreeData(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [hideCompleted]);

  useEffect(() => { loadTree(); }, [loadTree]);

  useEvent('session:started', () => { loadTree(); });
  useEvent('session:ended', () => { loadTree(); });
  useEvent('session:result', () => { loadTree(); });
  useEvent('session:error', (data: unknown) => {
    // Optimistically patch errorMessage so SessionDetailPanel shows it immediately
    const d = data as { sessionId?: string; error?: string };
    if (d.sessionId && d.error && treeData) {
      setTreeData((prev) => {
        if (!prev) return prev;
        const patch = (sessions: SessionRecord[]) => {
          for (const s of sessions) {
            if (s.claudeSessionId === d.sessionId) {
              s.work_status = 'error';
              s.errorMessage = d.error!.slice(0, 500);
              return true;
            }
          }
          return false;
        };
        for (const cat of prev.tree) {
          for (const t of cat.directTasks) { if (patch(t.sessions)) return { ...prev }; }
          for (const proj of cat.projects) {
            for (const t of proj.tasks) { if (patch(t.sessions)) return { ...prev }; }
          }
        }
        if (patch(prev.orphanSessions)) return { ...prev };
        return prev;
      });
    }
    loadTree();
  });
  useEvent('session:status-changed', (data: unknown) => {
    // Auto-switch to new exec session when "Clear Context & Execute" creates one
    const d = data as { sessionId?: string; fromPlanSessionId?: string; process_status?: string; work_status?: string; activity?: string };
    if (d.fromPlanSessionId && d.sessionId && d.fromPlanSessionId === selectedId) {
      setSelectedId(d.sessionId);
    }

    // Optimistically apply status fields to in-memory tree data so the UI updates
    // immediately — without waiting for the loadTree() API round-trip.
    // This fixes the stale-status bug where FIFO sessions show Idle/Agent Complete
    // even though they transitioned to Running/In Progress.
    if (d.sessionId && treeData && (d.process_status || d.work_status)) {
      setTreeData((prev) => {
        if (!prev) return prev;
        const patch = (sessions: SessionRecord[]) => {
          for (const s of sessions) {
            if (s.claudeSessionId === d.sessionId) {
              if (d.process_status) s.process_status = d.process_status as SessionRecord['process_status'];
              if (d.work_status) s.work_status = d.work_status as SessionRecord['work_status'];
              if ('activity' in d) s.activity = d.activity;
              return true;
            }
          }
          return false;
        };
        for (const cat of prev.tree) {
          for (const t of cat.directTasks) { if (patch(t.sessions)) return { ...prev }; }
          for (const proj of cat.projects) {
            for (const t of proj.tasks) { if (patch(t.sessions)) return { ...prev }; }
          }
        }
        if (patch(prev.orphanSessions)) return { ...prev };
        return prev;
      });
    }

    loadTree();
  });

  const handleToggleHideCompleted = () => {
    setHideCompleted((prev) => {
      const next = !prev;
      localStorage.setItem(LS_HIDE_COMPLETED, String(next));
      return next;
    });
  };

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
    if (!selectedId) { setDirectSession(null); return; }
    if (treeSession) { setDirectSession(null); return; }
    // Not in tree — fetch directly
    fetchSession(selectedId).then((s) => setDirectSession(s));
  }, [selectedId, treeSession]);

  const selectedSession = treeSession ?? directSession;

  // Slash command autocomplete for session input
  const { items: slashCommands, search: searchSlashCommands } = useSlashCommands(selectedSession?.cwd);

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
    sessionSend.send(selectedId, message, images);
  }, [selectedId, sessionSend]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    if (!selectedId) return;
    sessionSend.interruptSend(selectedId, message, images);
  }, [selectedId, sessionSend]);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      setModelPickerOpen(true);
    }
  }, []);

  const handleModelSwitch = useCallback((model: string, immediate: boolean) => {
    setModelPickerOpen(false);
    if (!selectedId) return;
    wsClient.sendRpc('session:send', {
      sessionId: selectedId,
      message: '',
      model,
      interrupt: immediate || undefined,
    }).catch((err: Error) => {
      console.error('Model switch failed:', err);
    });
  }, [selectedId]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div className="sessions-split-view">
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
        />
      </div>
      <div className="sessions-resize-handle" onMouseDown={handleResizeStart} />
      <div className="sessions-detail-pane">
        <SessionDetailPanel
          session={selectedSession}
          taskTitle={selectedTaskTitle}
          onTitleChanged={loadTree}
          onSessionReplaced={handleSessionReplaced}
          optimisticMessages={sessionSend.optimisticMsgs}
          onMessagesDelivered={sessionSend.handleMessagesDelivered}
          onBatchCompleted={sessionSend.handleBatchCompleted}
          onEditQueued={handleEditQueued}
          onDeleteQueued={handleDeleteQueued}
          onAgentQueued={sessionSend.addExternalQueued}
          onClearCommitted={sessionSend.clearCommitted}
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
              onControlCommand={handleControlCommand}
            />
            {modelPickerOpen && (
              <ModelPicker
                currentModel={selectedSession?.model}
                onSwitch={handleModelSwitch}
                onClose={() => setModelPickerOpen(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
