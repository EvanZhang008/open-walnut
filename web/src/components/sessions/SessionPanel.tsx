import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotes } from './SessionNotes';
import { UserMessagesSummary } from './UserMessagesSummary';
import { PlanPreviewSection } from './PlanPreviewSection';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSessionStream } from '@/hooks/useSessionStream';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import type { ImageAttachment } from '@/api/chat';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, executePlanContinue, executePlanSession } from '@/api/sessions';
import { fetchTask } from '@/api/tasks';
import { fetchPinnedTasks, pinTask, unpinTask } from '@/api/focus';
import { timeAgo } from '@/utils/time';
import { WorkStatusPicker } from './WorkStatusPicker';
import { SessionCopyButtons } from './SessionCopyButtons';
import { ModelPicker } from './ModelPicker';
import { SessionExpandedModal } from './SessionExpandedModal';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { wsClient } from '@/api/ws';
import type { SessionRecord } from '@/types/session';

interface SessionPanelErrorBoundaryProps {
  sessionId: string;
  onClose: () => void;
  children: ReactNode;
}

interface SessionPanelErrorBoundaryState {
  hasError: boolean;
}

class SessionPanelErrorBoundary extends Component<SessionPanelErrorBoundaryProps, SessionPanelErrorBoundaryState> {
  constructor(props: SessionPanelErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): SessionPanelErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('SessionPanel crashed:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: SessionPanelErrorBoundaryProps) {
    if (this.state.hasError && prevProps.sessionId !== this.props.sessionId) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="session-panel" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px' }}>
          <p style={{ color: 'var(--fg-muted)', margin: 0 }}>Something went wrong loading this session.</p>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              sessionStorage.removeItem('walnut-home-session-columns');
              this.props.onClose();
            }}
          >
            Close panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface SessionPanelProps {
  sessionId: string;
  onClose: () => void;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  /** Called when "Clear Context & Execute" creates a new session — parent should switch to it. */
  onSessionReplaced?: (newSessionId: string) => void;
  /** When true, panel is rendered inside the expanded modal — hides expand button, stretches to fill container. */
  expanded?: boolean;
}

export function SessionPanel({ sessionId, onClose, onTaskClick, onSessionClick, onSessionReplaced, expanded }: SessionPanelProps) {
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const { optimisticMsgs, sendError, send, interruptSend, handleMessagesDelivered, handleBatchCompleted, handleEditQueued, handleDeleteQueued, addExternalQueued, clearCommitted } = useSessionSend(sessionId);
  const { isStreaming } = useSessionStream(sessionId);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Slash command autocomplete for session input
  const { items: slashCommands, search: searchSlashCommands } = useSlashCommands(session?.cwd);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Expanded modal state (only used when not already expanded)
  const [showExpanded, setShowExpanded] = useState(false);

  const handleControlCommand = useCallback((command: string) => {
    if (command === 'model') {
      setModelPickerOpen(true);
    }
  }, []);

  const handleModelSwitch = useCallback((model: string, immediate: boolean) => {
    setModelPickerOpen(false);
    // Send RPC with model switch (empty message is fine -- backend handles it via pendingModel)
    wsClient.sendRpc('session:send', {
      sessionId,
      message: '',
      model,
      interrupt: immediate || undefined,
    }).catch((err) => {
      console.error('Model switch failed:', err);
    });
  }, [sessionId]);

  // Fetch messages for the UserMessagesSummary
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId);

  // Plan content for PlanPreviewSection
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  const shouldFetchPlan = hasPlan || isFromPlan;
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId || undefined, shouldFetchPlan);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId);
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;
  const rawModel = liveUsage.model || session?.model || lastAssistant?.model;
  const displayModel = formatModelName(rawModel);
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      const ctxSize = getContextWindowSize(rawModel);
      contextPercent = Math.round(totalInput / ctxSize * 100);
    }
  }

  // Scroll-to-message handler for UserMessagesSummary
  const handleMessageClick = useCallback((messageIndex: number) => {
    const container = bodyRef.current?.querySelector('.session-history');
    if (!container) return;
    const target = container.querySelector(`[data-msg-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('user-messages-highlight');
      setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
    }
  }, []);

  // Task title for the breadcrumb link
  const [taskTitle, setTaskTitle] = useState<string | null>(null);

  // Pin state — self-contained (calls focus API directly)
  const [pinned, setPinned] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);

  // Check if this session's task is pinned (on mount + config changes)
  const refreshPinState = useCallback((taskId: string | undefined) => {
    if (!taskId) return;
    fetchPinnedTasks()
      .then((data) => setPinned(data.pinned_tasks.includes(taskId)))
      .catch(() => {});
  }, []);

  useEvent('config:changed', () => { refreshPinState(session?.taskId); });

  const handleTogglePin = useCallback(async () => {
    if (!session?.taskId || pinBusy) return;
    setPinBusy(true);
    try {
      if (pinned) {
        await unpinTask(session.taskId);
        setPinned(false);
      } else {
        await pinTask(session.taskId);
        setPinned(true);
      }
    } catch (err) {
      console.error('Pin toggle failed:', err);
    } finally {
      setPinBusy(false);
    }
  }, [session?.taskId, pinned, pinBusy]);

  // Fetch session metadata
  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setLoading(true);
    setTaskTitle(null);
    setPinned(false);
    fetchSession(sessionId).then((s) => {
      if (!cancelled) {
        setSession(s);
        setLoading(false);
        // Fetch associated task title + pin state
        if (s?.taskId) {
          fetchTask(s.taskId).then((t) => {
            if (!cancelled) setTaskTitle(t.title);
          }).catch(() => {});
          refreshPinState(s.taskId);
        }
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  // Merge event data directly on status changes (avoids stale DB reads)
  useEvent('session:status-changed', (data) => {
    const d = data as { sessionId?: string; process_status?: string; work_status?: string; activity?: string; mode?: string; planCompleted?: boolean };
    if (d.sessionId === sessionId) {
      setSession(prev => prev ? {
        ...prev,
        process_status: (d.process_status ?? prev.process_status) as SessionRecord['process_status'],
        work_status: (d.work_status ?? prev.work_status) as SessionRecord['work_status'],
        activity: d.activity ?? prev.activity,
        mode: (d.mode ?? prev.mode) as SessionRecord['mode'],
        ...(d.planCompleted ? { planCompleted: true } : {}),
        lastActiveAt: new Date().toISOString(),
      } : prev);
    }
  });

  useEvent('session:result', (data) => {
    const d = data as { sessionId?: string };
    if (d.sessionId === sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  useEvent('session:error', (data) => {
    const d = data as { sessionId?: string };
    if (d.sessionId === sessionId) {
      fetchSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
    }
  });

  // Execute plan buttons state
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);

  // Reset execute + expanded state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setShowExpanded(false);
  }, [sessionId]);

  const showExecuteButtons =
    session?.planCompleted === true
    && session?.work_status !== 'error'
    && !executeStarted;

  const handleExecuteContinue = useCallback(async () => {
    setExecuting(true);
    setExecuteError(null);
    try {
      await executePlanContinue(sessionId);
      setExecuteStarted(true);
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId]);

  const handleClearContextExecute = useCallback(async () => {
    const clickedSessionId = sessionIdRef.current; // snapshot at click time
    setExecuting(true);
    setExecuteError(null);
    try {
      const result = await executePlanSession(sessionId);
      setExecuteStarted(true);
      // Only navigate if user is still viewing the same session
      if (result.sessionId && sessionIdRef.current === clickedSessionId) {
        onSessionReplaced?.(result.sessionId);
      }
    } catch (err) {
      setExecuteError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(false);
    }
  }, [sessionId, onSessionReplaced]);

  const handleSend = useCallback((message: string, images?: ImageAttachment[]) => {
    send(sessionId, message, images);
  }, [sessionId, send]);

  const handleInterruptSend = useCallback((message: string, images?: ImageAttachment[]) => {
    interruptSend(sessionId, message, images);
  }, [sessionId, interruptSend]);

  const handleEdit = useCallback((queueId: string, newText: string) => {
    handleEditQueued(sessionId, queueId, newText);
  }, [sessionId, handleEditQueued]);

  const handleDelete = useCallback((queueId: string) => {
    handleDeleteQueued(sessionId, queueId);
  }, [sessionId, handleDeleteQueued]);

  const ps = session?.process_status;
  const ws = session?.work_status;

  // Header content
  const title = session?.title || session?.description || session?.slug || null;
  const sessionsPageUrl = `/sessions?id=${sessionId}`;

  return (
    <SessionPanelErrorBoundary sessionId={sessionId} onClose={onClose}>
      <div className={`session-panel${expanded ? ' session-panel--expanded' : ''}`} {...(showExpanded ? { inert: '' } as any : {})}>
        <div className="session-panel-header">
          <div className="session-panel-header-top">
            <div className="session-panel-title-area">
              {title
                ? <span className="session-panel-title" title={title}>{title}</span>
                : <span className="session-panel-title text-muted">Untitled session</span>
              }
              {!loading && session?.provider === 'embedded' && (
                <span
                  className="session-panel-badge"
                  style={{
                    color: 'var(--accent)',
                    background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
                    fontSize: '10px',
                    fontWeight: 600,
                  }}
                >
                  🤖 Embedded
                </span>
              )}
              {!loading && ps && ws && (
                <WorkStatusPicker
                  sessionId={sessionId}
                  processStatus={ps}
                  workStatus={ws}
                  size="sm"
                />
              )}
              {loading && <span className="session-panel-badge" style={{ color: 'var(--fg-muted)' }}>Loading...</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
              {!expanded && (
                <button
                  className="session-panel-expand"
                  onClick={() => setShowExpanded(true)}
                  title="Expand to full screen"
                  aria-label="Expand session to full screen"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="10 2 14 2 14 6" />
                    <polyline points="6 14 2 14 2 10" />
                    <line x1="14" y1="2" x2="9" y2="7" />
                    <line x1="2" y1="14" x2="7" y2="9" />
                  </svg>
                </button>
              )}
              {session?.taskId && (
                <button
                  className={`session-panel-pin${pinned ? ' pinned' : ''}`}
                  onClick={handleTogglePin}
                  disabled={pinBusy}
                  title={pinned ? 'Unpin from Focus Bar' : 'Pin to Focus Bar'}
                  aria-label={pinned ? 'Unpin from Focus Bar' : 'Pin to Focus Bar'}
                >
                  {pinned ? '\u{1F4CC}' : '\u{1F4CC}'}
                </button>
              )}
              <button className="session-panel-close" onClick={onClose} title="Close session panel">&times;</button>
            </div>
          </div>
          {session?.taskId && (
            <div
              className="session-panel-task-link"
              role="button"
              tabIndex={0}
              onClick={() => onTaskClick?.(session.taskId!)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onTaskClick?.(session.taskId!); }}
              title={taskTitle ? `Go to task: ${taskTitle}` : `Go to task ${session.taskId}`}
            >
              <span className="session-panel-task-icon">&#x1F4CB;</span>
              <span className="session-panel-task-title">{taskTitle || session.taskId}</span>
              <span className="session-panel-task-arrow">&#x2197;</span>
            </div>
          )}
          <div className="session-panel-meta">
            <span
              className="session-panel-id session-panel-id-link"
              role="button"
              tabIndex={0}
              onClick={() => navigate(sessionsPageUrl)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(sessionsPageUrl); }}
              title={`Open in Sessions page\n${sessionId}`}
            >
              {sessionId} &#x2197;
            </span>
            <SessionCopyButtons
              sessionId={sessionId}
              cwd={session?.cwd}
              taskId={session?.taskId}
              taskTitle={taskTitle ?? undefined}
              onForkComplete={(newTaskId, newSessionId) => {
                // Select the new child task, then open its session
                onTaskClick?.(newTaskId);
                if (newSessionId) onSessionClick?.(newSessionId);
              }}
            />
            {session?.host && (
              <span
                className="session-panel-host"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--fg-muted)',
                  padding: '1px 5px',
                  borderRadius: '4px',
                  fontSize: '10px',
                  fontWeight: 600,
                }}
                title={session.hostname || session.host}
              >
                SSH: {session.host}
              </span>
            )}
            {session?.project && <span className="session-panel-project" title={session.cwd || session.project}>{session.project}</span>}
            {displayModel && (
              <span className="session-detail-model-pill" title={rawModel || ''}>
                {displayModel}
                {contextPercent != null && (
                  <span
                    className="session-detail-context-pct"
                    style={{
                      color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                        : contextPercent > 50 ? 'var(--warning, #ff9500)'
                        : 'var(--fg-muted)',
                    }}
                    title={`Context: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K)` : ''}`}
                  >
                    {' '}{contextPercent}%
                  </span>
                )}
              </span>
            )}
            {session?.lastActiveAt && <span className="session-panel-time">{timeAgo(session.lastActiveAt)}</span>}
          </div>
        </div>

        {showExecuteButtons && (
          <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="execute-plan-btn"
              onClick={handleExecuteContinue}
              disabled={executing}
              style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px' }}
            >
              {executing ? 'Starting\u2026' : '\u25B6 Execute'}
            </button>
            <button
              className="execute-plan-btn-secondary"
              onClick={handleClearContextExecute}
              disabled={executing}
              style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '6px' }}
            >
              Clear Context & Execute
            </button>
            {executeError && (
              <span className="text-xs" style={{ color: 'var(--error)' }}>{executeError}</span>
            )}
          </div>
        )}
        {executeStarted && (
          <p className="text-xs text-muted" style={{ padding: '4px 12px', margin: 0 }}>
            Execution started.
          </p>
        )}
        {session && <PlanPreviewSection session={session} plan={plan} loading={planLoading} refresh={planRefresh} />}
        <UserMessagesSummary
          messages={historyMessages}
          loading={historyLoading}
          onMessageClick={handleMessageClick}
        />
        <SessionNotes
          sessionId={sessionId}
          initialNote={session?.human_note}
        />
        <div className="session-panel-body" ref={bodyRef}>
          <SessionChatHistory
            key={sessionId}
            sessionId={sessionId}
            workStatus={session?.work_status}
            initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
            sessionCwd={session?.cwd}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onEditQueued={handleEdit}
            onDeleteQueued={handleDelete}
            onAgentQueued={addExternalQueued}
            onClearCommitted={clearCommitted}
            onTaskClick={onTaskClick}
            onSessionClick={onSessionClick}
          />
        </div>

        <div className="session-panel-input">
          {sendError && (
            <div className="text-xs" style={{ color: 'var(--error)', padding: '4px 12px' }}>
              {sendError}
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
              currentModel={rawModel}
              onSwitch={handleModelSwitch}
              onClose={() => setModelPickerOpen(false)}
            />
          )}
        </div>
      </div>
      {showExpanded && (
        <SessionExpandedModal
          sessionId={sessionId}
          onClose={() => setShowExpanded(false)}
          onTaskClick={onTaskClick}
          onSessionClick={onSessionClick}
          onSessionReplaced={onSessionReplaced}
        />
      )}
    </SessionPanelErrorBoundary>
  );
}
