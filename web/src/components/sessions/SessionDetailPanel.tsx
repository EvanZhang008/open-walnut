import { useState, useRef, useEffect, useCallback, useMemo, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotes } from './SessionNotes';
import { SessionFileExplorer } from './SessionFileExplorer';
import { SessionTerminal } from './SessionTerminal';
import { FileViewer } from '../common/FileViewer';
import { UserMessagesSummary } from './UserMessagesSummary';
// PlanPreviewSection replaced by inline plan popover in meta bar
import { ProcessStatusBadge } from './WorkStatusPicker';
import { SessionCopyButtons } from './SessionCopyButtons';
import { TaskQuickActions } from './TaskQuickActions';
import { updateSession, executePlanSession, executePlanContinue, restartSession, investigateSession } from '@/api/sessions';
import { log } from '@/utils/log';
import { buildInvestigationClip } from '@/utils/investigation-clipboard';
import { fetchTask, updateTask } from '@/api/tasks';
import { fetchPinnedTasks, pinTask, unpinTask, setTaskTier } from '@/api/focus';
import type { FocusTier } from '@/api/focus';
import { SessionRetryButton } from './SessionRetryButton';
import { SideQuestionDrawer } from './SideQuestionDrawer';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { useSessionUsage, formatModelName, getContextWindowSize } from '@/hooks/useSessionUsage';
import { useEvent } from '@/hooks/useWebSocket';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import type { SessionRecord, TaskPhase } from '@/types/session';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { timeAgo } from '@/utils/time';
import { wsClient } from '@/api/ws';
import { ICON_CLIPBOARD, ICON_LIGHTNING, ICON_WARNING, ICON_LOCATE, ICON_SEARCH } from '@/components/common/Icons';
import { renderMarkdownWithRefs } from '@/utils/markdown';

interface SessionDetailPanelProps {
  session: SessionRecord | null;
  taskTitle?: string;
  summary?: string;
  /** @deprecated No longer used — kept for backward compat. */
  taskHasExecSession?: boolean;
  onTitleChanged?: () => void;
  /** Called when "Clear Context & Execute" creates a new session — parent should update selectedId. */
  onSessionReplaced?: (newSessionId: string) => void;
  optimisticMessages?: import('./SessionChatHistory').OptimisticMessage[];
  onMessagesDelivered?: (count: number) => void;
  onBatchCompleted?: (count: number) => void;
  onBatchFailed?: (messageIds: string[], error: string) => void;
  onEditQueued?: (queueId: string, newText: string) => void;
  onDeleteQueued?: (queueId: string) => void;
  onAgentQueued?: (msg: { queueId: string; text: string }) => void;
  onClearCommitted?: () => void;
  onRetryFailed?: (queueId: string) => void;
  onDismissFailed?: (queueId: string) => void;
  /** Bubbles the stream hook's isStreaming up to page-level so the page doesn't
   *  need its own useSessionStream mount (would double RPCs + race defensive clear). */
  onStreamingChange?: (isStreaming: boolean) => void;
  /** Changed view (full-screen File Diff + chat) is owned by the page (it holds the
   *  ChatInput). The panel only renders the chip + reflects its open state. */
  changedOpen?: boolean;
  onToggleChanged?: () => void;
}

/** Renders plan markdown content inside the plan popover with scrollable area */
function PlanPopoverContent({ content, cwd }: { content: string; cwd?: string }) {
  const html = useMemo(() => renderMarkdownWithRefs(content, cwd), [content, cwd]);
  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function CopyableId({ value, truncate }: { value: string; truncate?: number }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(timerRef.current); }, []);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  };
  const display = truncate ? value.slice(0, truncate) + '\u2026' : value;
  return (
    <span className="session-detail-copyable" onClick={copy} title={`Click to copy: ${value}`}>
      <code>{display}</code>
      <span className="session-detail-copy-icon">{copied ? 'Copied' : 'Copy'}</span>
    </span>
  );
}

function EditableTitle({ sessionId, taskId, title, onSaved }: { sessionId: string; taskId?: string; title: string; onSaved?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setValue(title); }, [title]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const save = () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === title) {
      setValue(title);
      setEditing(false);
      return;
    }
    setSaving(true);
    const req = taskId
      ? updateTask(taskId, { title: trimmed })
      : updateSession(sessionId, { title: trimmed });
    req
      .then(() => {
        setEditing(false);
        onSaved?.();
      })
      .catch(() => {
        setValue(title);
        setEditing(false);
      })
      .finally(() => setSaving(false));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { setValue(title); setEditing(false); }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="session-detail-title-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        disabled={saving}
        maxLength={500}
      />
    );
  }

  return (
    <h2
      className="session-detail-title session-detail-title-editable"
      onClick={() => setEditing(true)}
      title={taskId ? 'Click to rename task' : 'Click to rename session'}
    >
      {title}
    </h2>
  );
}

export function SessionDetailPanel({ session, taskTitle, summary, onTitleChanged, onSessionReplaced, optimisticMessages, onMessagesDelivered, onBatchCompleted, onBatchFailed, onEditQueued, onDeleteQueued, onAgentQueued, onClearCommitted, onRetryFailed, onDismissFailed, onStreamingChange, changedOpen, onToggleChanged }: SessionDetailPanelProps) {
  const navigate = useNavigate();
  const enabledModes = useEnabledModes();
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fileViewerState, setFileViewerState] = useState<{ path: string; line?: number } | null>(null);
  // Pre-fetched task + pin state for TaskQuickActions (avoids self-fetch null-render)
  const [sessionTask, setSessionTask] = useState<import('@open-walnut/core').Task | null>(null);
  const [pinned, setPinned] = useState(false);
  const [pinnedTier, setPinnedTier] = useState<FocusTier | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshPinState = useCallback((taskId: string | undefined) => {
    if (!taskId) return;
    fetchPinnedTasks().then((data) => {
      const isPinned = data.pinned_tasks.includes(taskId);
      setPinned(isPinned);
      if (isPinned) {
        const tier: FocusTier = data.focus_tasks?.includes(taskId) ? 'focus'
          : data.wait_tasks?.includes(taskId) ? 'wait' : 'satellite';
        setPinnedTier(tier);
      } else {
        setPinnedTier(undefined);
      }
    }).catch(() => {});
  }, []);

  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'focus_bar') return;
    refreshPinState(session?.taskId);
  });

  const handlePinTask = useCallback(async (id: string) => {
    try { await pinTask(id); setPinned(true); } catch (err) { console.error('Pin failed:', err); }
  }, []);

  const handleUnpinTask = useCallback(async (id: string) => {
    try { await unpinTask(id); setPinned(false); setPinnedTier(undefined); } catch (err) { console.error('Unpin failed:', err); }
  }, []);

  const handleSetTier = useCallback(async (id: string, tier: FocusTier) => {
    try { await setTaskTier(id, tier); setPinnedTier(tier); } catch (err) { console.error('Set tier failed:', err); }
  }, []);

  useEffect(() => {
    if (!session?.taskId) { setSessionTask(null); setPinned(false); setPinnedTier(undefined); return; }
    fetchTask(session.taskId).then(setSessionTask).catch(() => {});
    refreshPinState(session.taskId);
  }, [session?.taskId, refreshPinState]);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(session?.claudeSessionId);
  sessionIdRef.current = session?.claudeSessionId;

  // Local mode override — applied after user clicks mode toggle (session prop doesn't update immediately)
  const [modeOverride, setModeOverride] = useState<string | null>(null);
  // Reset override when session changes
  const prevSessionId = useRef(session?.claudeSessionId);
  if (session?.claudeSessionId !== prevSessionId.current) {
    prevSessionId.current = session?.claudeSessionId;
    if (modeOverride !== null) setModeOverride(null);
  }

  // Action chip toggle state
  const [planPopoverOpen, setPlanPopoverOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Fetch messages for the UserMessagesSummary
  const sessionId_ = session?.claudeSessionId || '';
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId_ || null);

  // Lift plan hook here so we can provide plan content via context to all PlanCards
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  // mode === 'plan' covers sessions still actively planning — planCompleted is only set after the plan tool call finishes,
  // so without this the Plan chip would be hidden during active planning.
  const shouldFetchPlan = hasPlan || isFromPlan || session?.mode === 'plan';
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId_ || undefined, shouldFetchPlan);

  // Auto-refresh plan content when modal opens
  useEffect(() => {
    if (planPopoverOpen && shouldFetchPlan) {
      planRefresh();
    }
  }, [planPopoverOpen, shouldFetchPlan, planRefresh]);

  // Close plan modal on Escape
  useEffect(() => {
    if (!planPopoverOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlanPopoverOpen(false);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [planPopoverOpen]);

  // Listen for PlanCard expand → open the same plan modal
  useEffect(() => {
    const handler = () => setPlanPopoverOpen(true);
    window.addEventListener('open-plan-modal', handler);
    return () => window.removeEventListener('open-plan-modal', handler);
  }, []);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId_ || null);
  // Fallback: derive model + context % from last assistant message in history
  const lastAssistant = !historyLoading && historyMessages.length > 0
    ? [...historyMessages].reverse().find(m => m.role === 'assistant' && m.model)
    : undefined;
  // Priority: live WebSocket > SessionRecord > history-derived
  const rawModel = liveUsage.model || session?.model || lastAssistant?.model;
  const displayModel = formatModelName(rawModel);
  // Context %: live WS first, then compute from history usage
  let contextPercent = liveUsage.contextPercent;
  if (contextPercent == null && lastAssistant?.usage) {
    const u = lastAssistant.usage as Record<string, number>;
    const totalInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    if (totalInput > 0) {
      const ctxSize = getContextWindowSize(rawModel, totalInput);
      contextPercent = Math.round(totalInput / ctxSize * 100);
    }
  }

  // Retry — resume path: session auto-recovers via WS status events, nothing to do.
  // Retry — fallback path: listen for task:updated to detect new session linked after retry.
  const retryTaskIdRef = useRef<string | null>(null);
  const handleResuming = useCallback(() => {
    // processNext() emits SESSION_STATUS_CHANGED which updates session state.
    // Error banner clears automatically when errorMessage is cleared.
  }, []);
  const handleRetried = useCallback((taskId: string) => {
    retryTaskIdRef.current = taskId;
  }, []);
  const [restartBusy, setRestartBusy] = useState(false);
  const handleRestart = useCallback(async () => {
    if (!session?.claudeSessionId) {
      log.warn('session-detail', 'restart clicked but no claudeSessionId', { taskId: session?.taskId });
      return;
    }
    log.info('session-detail', 'restart button clicked', { sessionId: session.claudeSessionId });
    setRestartBusy(true);
    try {
      const result = await restartSession(session.claudeSessionId);
      log.info('session-detail', 'restart API returned', { sessionId: session.claudeSessionId, result });
    } catch (err) {
      log.error('session-detail', 'restart API failed', {
        sessionId: session.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    setRestartBusy(false);
  }, [session?.claudeSessionId, session?.taskId]);

  // Investigate — freeze an evidence bundle + open a manual incident. Shows a
  // brief inline confirmation ("incident <id>") since there's no global toast bus.
  const [investigating, setInvestigating] = useState(false);
  const [investigateResult, setInvestigateResult] = useState<{ kind: 'ok'; id: string } | { kind: 'error' } | null>(null);
  const investigateTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => { clearTimeout(investigateTimerRef.current); }, []);
  const handleInvestigate = useCallback(async () => {
    if (investigating || !session?.claudeSessionId) return;
    const sid = session.claudeSessionId;
    log.info('session-detail', 'investigate button clicked', { sessionId: sid, taskId: session?.taskId });
    setInvestigating(true);
    setInvestigateResult(null);
    try {
      const { incident } = await investigateSession(sid, session?.taskId);
      log.info('session-detail', 'investigate captured evidence', { sessionId: sid, incidentId: incident.id, bundlePath: incident.bundlePath });
      const clip = buildInvestigationClip({
        sessionId: sid,
        taskId: session?.taskId,
        incidentId: incident.id,
        bundlePath: incident.bundlePath,
        host: session?.host,
      });
      await navigator.clipboard.writeText(clip).catch(() => {});
      setInvestigateResult({ kind: 'ok', id: incident.id });
      clearTimeout(investigateTimerRef.current);
      investigateTimerRef.current = setTimeout(() => setInvestigateResult(null), 6000);
    } catch (err) {
      log.error('session-detail', 'investigate failed', {
        sessionId: sid,
        error: err instanceof Error ? err.message : String(err),
      });
      setInvestigateResult({ kind: 'error' });
      clearTimeout(investigateTimerRef.current);
      investigateTimerRef.current = setTimeout(() => setInvestigateResult(null), 4000);
    } finally {
      setInvestigating(false);
    }
  }, [investigating, session?.claudeSessionId, session?.taskId, session?.host]);
  useEvent('task:updated', (data: unknown) => {
    const d = data as { task?: { id?: string; exec_session_id?: string; plan_session_id?: string } };
    const t = d.task;
    if (!t?.id || !retryTaskIdRef.current || t.id !== retryTaskIdRef.current) return;
    const newSessionId = t.exec_session_id ?? t.plan_session_id;
    if (newSessionId && session?.claudeSessionId) {
      retryTaskIdRef.current = null;
      onSessionReplaced?.(newSessionId);
    }
  });

  const handleFileOpen = useCallback((path: string, line?: number) => {
    setFileViewerState({ path, line });
  }, []);
  const handleFileViewerClose = useCallback(() => setFileViewerState(null), []);

  // Scroll-to-message: find the message element in SessionChatHistory by data-msg-index
  const handleMessageClick = useCallback((messageIndex: number) => {
    const container = panelRef.current?.querySelector('.session-history');
    if (!container) return;
    const target = container.querySelector(`[data-msg-index="${messageIndex}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight
      target.classList.add('user-messages-highlight');
      setTimeout(() => target.classList.remove('user-messages-highlight'), 1500);
    } else {
      // Message is truncated — ask SessionChatHistory to expand and scroll to it
      container.dispatchEvent(new CustomEvent('expand-to-message', {
        detail: { messageIndex }, bubbles: false,
      }));
    }
  }, []);

  // Reset state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setDetailsOpen(false);
    setPlanPopoverOpen(false);
    setNotesOpen(false);
    setMessagesOpen(false);
  }, [session?.claudeSessionId]);

  if (!session) {
    return (
      <div className="session-detail-panel">
        <div className="session-detail-empty">
          <p className="text-muted">Select a session to view its conversation</p>
        </div>
      </div>
    );
  }

  const sessionId = session.claudeSessionId || '';
  const sessionFallbackTitle = session.title || session.description || session.slug || sessionId || 'Untitled session';
  const title = (session.taskId ? taskTitle : null) || sessionFallbackTitle;
  const ps = session.process_status ?? 'stopped';
  // SessionsPage doesn't pass task phase; hardcoded 'TODO' is safe because
  // SessionChatHistory only uses it for resume detection (checking IN_PROGRESS),
  // and the detail panel doesn't need that feature.
  const taskPhase: TaskPhase = 'TODO';
  const isEmbedded = session.provider === 'embedded';
  // planCompleted=true means the plan is definitively done — show Execute even if session is still running
  // (SSH FIFO sessions stay alive after plan completion; execution creates a new session anyway).
  // For exec sessions without planCompleted, require the session to be stopped.
  const showExecuteButtons =
    (session.planCompleted === true || (plan && !planLoading && ps !== 'running'))
    && ps !== 'error'
    && !executeStarted;

  /** "Execute" — resumes the same session with bypass permissions. */
  const handleExecuteContinue = async () => {
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
  };

  /** "Clear Context & Execute" — creates a fresh session, old one is archived (reason: plan_executed). */
  const handleClearContextExecute = async () => {
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
  };

  // Build compact meta bar items
  const hasDetails = !!(session.project || session.startedAt || session.cwd || session.host || session.activity || session.description);

  const planContentValue = plan?.content ?? null;

  return (
    <PlanContentContext.Provider value={planContentValue}>
      <div className="session-detail-panel" ref={panelRef}>
        <div className="session-detail-header">
          {/* Title row with badges */}
          <div className="session-detail-title-row">
            {session.taskId && (
              <TaskQuickActions
                taskId={session.taskId}
                task={sessionTask}
                slot="phase"
                compact
              />
            )}
            <EditableTitle sessionId={sessionId} taskId={session.taskId} title={title} onSaved={onTitleChanged} />
            {session.taskId && (
              <button
                className="task-action-btn session-detail-locate"
                onClick={() => navigate(`/tasks/${session.taskId}`)}
                title={taskTitle ? `Go to task: ${taskTitle}` : `Go to task ${session.taskId}`}
                aria-label="Locate task"
              >
                {ICON_LOCATE}
              </button>
            )}
            {session.taskId && (
              <TaskQuickActions
                taskId={session.taskId}
                task={sessionTask}
                isPinned={pinned}
                pinnedTier={pinnedTier}
                onPinTask={handlePinTask}
                onUnpinTask={handleUnpinTask}
                onSetTier={handleSetTier}
                slot="kebab"
              />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {session.mode && session.mode !== 'default' && (
                <span
                  className="session-detail-badge"
                  style={{ color: 'var(--fg-muted)', background: 'var(--bg-tertiary)', fontWeight: 600, fontSize: '11px' }}
                >
                  {session.mode === 'plan' ? <>{ICON_CLIPBOARD}{' Plan'}</> : <>{ICON_LIGHTNING}{' Bypass'}</>}
                </span>
              )}
              {session.archived && (
                <span
                  className="session-detail-badge"
                  style={{ color: '#f59e0b', background: '#f59e0b20', fontWeight: 600, fontSize: '11px' }}
                >
                  Archived{session.archive_reason ? ` · ${session.archive_reason === 'plan_executed' ? 'plan executed' : session.archive_reason}` : ''}
                </span>
              )}
              {isEmbedded && (
                <span className="session-detail-badge session-detail-badge-embedded">
                  Embedded
                </span>
              )}
              {session.host && (
                <span
                  className="session-detail-badge"
                  style={{ color: 'var(--fg-muted)', background: 'var(--bg-tertiary)', fontSize: '11px', fontWeight: 600 }}
                  title={session.hostname || session.host}
                >
                  SSH: {session.host}
                </span>
              )}
              <ProcessStatusBadge
                processStatus={ps}
                size="md"
                errorMessage={session.errorMessage}
              />
            </div>
          </div>

          {/* Compact meta bar */}
          <div className="session-detail-meta-bar">
            {displayModel && (
              <span className="session-detail-model-pill" title={liveUsage.model || session?.model || ''}>
                {displayModel}
                {contextPercent != null && (
                  <span
                    className="session-detail-context-pct"
                    style={{
                      color: contextPercent > 80 ? 'var(--danger, #ff3b30)'
                        : contextPercent > 50 ? 'var(--warning, #ff9500)'
                        : 'var(--fg-muted)',
                    }}
                    title={`Context window: ${contextPercent}%${liveUsage.inputTokens ? ` (${Math.round(liveUsage.inputTokens / 1000)}K tokens)` : ''}`}
                  >
                    {' '}{contextPercent}%
                  </span>
                )}
              </span>
            )}
            {session.messageCount != null && session.messageCount > 0 && (
              <span>{session.messageCount} msgs</span>
            )}
            {session.lastActiveAt && (
              <span title={new Date(session.lastActiveAt).toLocaleString()}>{timeAgo(session.lastActiveAt)}</span>
            )}
            {/* onForkComplete omitted: fork resolves asynchronously, new session appears via list refresh */}
            {sessionId && (
              <SessionCopyButtons
                sessionId={sessionId}
                cwd={session.cwd}
                project={session.project}
                taskId={session.taskId}
                taskTitle={taskTitle}
              />
            )}
            {!session.archived && (
              <button
                className="session-copy-chip"
                onClick={handleRestart}
                disabled={restartBusy}
                title="Restart session"
              >
                {restartBusy ? 'Restarting...' : 'Restart'}
              </button>
            )}
            <button
              className="session-copy-chip"
              onClick={handleInvestigate}
              disabled={investigating}
              title="Capture an evidence bundle (logs + CLI stream + daemon), open an incident, and copy all related ids to the clipboard"
            >
              {ICON_SEARCH}{' '}
              {investigating
                ? 'Capturing…'
                : investigateResult?.kind === 'ok'
                  ? `Copied — ${investigateResult.id} ✓`
                  : investigateResult?.kind === 'error'
                    ? 'Capture failed'
                    : 'Investigate'}
            </button>
            {(ps === 'stopped' || ps === 'error') && !session.archived && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.7rem', padding: '1px 6px', opacity: 0.7 }}
                onClick={() => updateSession(sessionId, { archived: true })}
                title="Archive this session"
              >
                Archive
              </button>
            )}
            {session.archived && (
              <button
                className="btn btn-sm"
                style={{ fontSize: '0.7rem', padding: '1px 6px' }}
                onClick={() => updateSession(sessionId, { archived: false })}
                title="Unarchive this session"
              >
                Unarchive
              </button>
            )}
          </div>

          {/* Action chips row: Plan / Notes / Messages */}
          <div className="session-meta-row-2">
            {(shouldFetchPlan || showExecuteButtons) && (
              <>
                <button
                  className={`session-action-chip${planPopoverOpen ? ' session-action-chip-active' : ''}`}
                  onClick={() => setPlanPopoverOpen(o => !o)}
                  title="Plan & Execute"
                >
                  Plan {planPopoverOpen ? '\u25B4' : '\u25BE'}
                </button>
                {planPopoverOpen && (
                  <div className="plan-popup-overlay" onClick={() => setPlanPopoverOpen(false)}>
                    <div className="plan-popup-container" onClick={e => e.stopPropagation()}>
                      <div className="plan-popup-header">
                        <span className="plan-popup-title">
                          {plan?.planFile?.split('/').pop() ?? 'Plan'}
                          {isFromPlan && plan?.sourceSessionId && (
                            <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 400, color: 'var(--fg-muted)' }}>
                              from{' '}
                              <a
                                href={`/sessions?id=${plan.sourceSessionId}`}
                                style={{ color: 'var(--accent)' }}
                                onClick={(e) => { e.preventDefault(); navigate(`/sessions?id=${plan.sourceSessionId}`); setPlanPopoverOpen(false); }}
                              >
                                {plan.sourceSessionId.slice(0, 12)}...
                              </a>
                            </span>
                          )}
                        </span>
                        <div className="plan-popup-header-actions">
                          {showExecuteButtons && (
                            <>
                              <button className="execute-plan-btn" onClick={handleExecuteContinue} disabled={executing}>
                                {executing ? 'Starting\u2026' : '\u25B6 Execute'}
                              </button>
                              <button className="execute-plan-btn-secondary" onClick={handleClearContextExecute} disabled={executing}>
                                Clear Context & Execute
                              </button>
                            </>
                          )}
                          {executeStarted && <span style={{ fontSize: '11px', color: '#0d9488' }}>Started</span>}
                          {executeError && <span style={{ fontSize: '11px', color: 'var(--error)' }}>{executeError}</span>}
                          <button
                            className="plan-preview-refresh"
                            onClick={async (e) => { e.stopPropagation(); await planRefresh(); }}
                            title="Refresh plan content"
                          >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                              <path d="M1.5 8a6.5 6.5 0 0111.3-4.4"/><polyline points="13 1 13 4.5 9.5 4.5"/>
                              <path d="M14.5 8a6.5 6.5 0 01-11.3 4.4"/><polyline points="3 15 3 11.5 6.5 11.5"/>
                            </svg>
                            {' '}Refresh
                          </button>
                        </div>
                        <button className="plan-popup-close" onClick={() => setPlanPopoverOpen(false)} aria-label="Close">&times;</button>
                      </div>
                      <div className="plan-popup-body">
                        {planLoading && !plan && (
                          <div style={{ fontSize: '12px', color: 'var(--fg-muted)', padding: '20px 0', textAlign: 'center' }}>Loading plan...</div>
                        )}
                        {plan?.content && (
                          <PlanPopoverContent content={plan.content} cwd={session?.cwd} />
                        )}
                      </div>
                      <div className="plan-popup-input">
                        <input
                          className="plan-popup-input-field"
                          placeholder="Send a message while viewing plan..."
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                              const val = (e.target as HTMLInputElement).value.trim();
                              if (val) {
                                wsClient.sendRpc('session:send', { sessionId, message: val }).catch(() => {});
                                (e.target as HTMLInputElement).value = '';
                              }
                            }
                          }}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
            <button
              className={`session-action-chip${notesOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setNotesOpen(o => !o)}
              title="Session notes"
            >
              Notes
            </button>
            <button
              className={`session-action-chip${messagesOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setMessagesOpen(o => !o)}
              title="My messages in this session"
            >
              Msgs
              {!historyLoading && (() => {
                const count = historyMessages.filter(m => m.role === 'user' && m.text.trim()).length;
                return count > 0 ? <span className="session-action-chip-count">{count}</span> : null;
              })()}
            </button>
            <button
              className={`session-action-chip${filesOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setFilesOpen(o => !o)}
              title="Browse session working directory"
            >
              Files
            </button>
            {onToggleChanged && (
              <button
                className={`session-action-chip${changedOpen ? ' session-action-chip-active' : ''}`}
                onClick={onToggleChanged}
                title="See the files this session changed — full-screen diff alongside the chat"
              >
                Changed
              </button>
            )}
            <button
              className={`session-action-chip${terminalOpen ? ' session-action-chip-active' : ''}`}
              onClick={() => setTerminalOpen(o => !o)}
              title="Open a terminal in the session working directory"
            >
              Terminal
            </button>
            {(() => {
              const LABELS: Record<string, string> = { default: 'Default', bypass: 'Bypass', plan: 'Plan', accept: 'Accept' };
              const ICONS: Record<string, string> = { default: '\u2699\uFE0F', bypass: '\u26A1', plan: '\uD83D\uDCCB', accept: '\u2705' };
              const currentMode = (modeOverride ?? session.mode) || 'default';
              const isPlan = currentMode === 'plan';
              const nextMode = enabledModes[(enabledModes.indexOf(currentMode) + 1) % enabledModes.length]!;
              const handleModeToggle = async () => {
                setModeOverride(nextMode);
                try {
                  await updateSession(sessionId, { mode: nextMode });
                } catch (err) {
                  setModeOverride(null); // revert on error
                  console.warn('[session-detail] mode toggle failed', sessionId, nextMode, err);
                }
              };
              const icon = ICONS[currentMode] ?? '\u2699\uFE0F';
              const label = LABELS[currentMode] ?? currentMode;
              return (
                <button
                  className={`mode-toggle-pill${isPlan ? ' plan-active' : ''}`}
                  onClick={handleModeToggle}
                  title={`Mode: ${currentMode}. Click to cycle → ${nextMode}`}
                >
                  <span className="mode-toggle-pill-label">
                    {icon} {label}
                  </span>
                </button>
              );
            })()}
          </div>

          {/* Collapsible details */}
          {hasDetails && (
            <div className="session-detail-collapse">
              <button
                className="session-detail-collapse-toggle"
                onClick={() => setDetailsOpen(!detailsOpen)}
              >
                <span className="session-detail-collapse-arrow">{detailsOpen ? '\u25BE' : '\u25B8'}</span>
                Details
              </button>
              {detailsOpen && (
                <div className="session-detail-collapse-body">
                  <div className="session-detail-info-grid">
                    {session.project && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Project</span>
                        <span className="session-detail-info-value">{session.project}</span>
                      </div>
                    )}
                    {session.startedAt && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Started</span>
                        <span className="session-detail-info-value">{formatDate(session.startedAt)}</span>
                      </div>
                    )}
                    {session.cwd && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Working Dir</span>
                        <span className="session-detail-info-value"><code className="session-detail-code">{session.cwd}</code></span>
                      </div>
                    )}
                    {session.host && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Host</span>
                        <span className="session-detail-info-value">
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                            }}
                          >
                            <span
                              style={{
                                background: 'var(--bg-tertiary)',
                                color: 'var(--fg-muted)',
                                padding: '1px 6px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 600,
                              }}
                            >
                              SSH
                            </span>
                            {session.host}
                          </span>
                        </span>
                      </div>
                    )}
                    {session.activity && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Activity</span>
                        <span className="session-detail-info-value" style={{ fontStyle: 'italic' }}>{session.activity}</span>
                      </div>
                    )}
                    {session.description && (
                      <div className="session-detail-info-row">
                        <span className="session-detail-info-label">Description</span>
                        <span className="session-detail-info-value">{session.description}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {summary && (
            <p className="session-detail-summary text-sm">{summary}</p>
          )}
        </div>
        {messagesOpen && (
          <div className="session-action-panel">
            <UserMessagesSummary
              messages={historyMessages}
              loading={historyLoading}
              onMessageClick={handleMessageClick}
            />
          </div>
        )}
        {notesOpen && (
          <div className="session-action-panel">
            <SessionNotes
              sessionId={sessionId}
              initialNote={session.human_note}
            />
          </div>
        )}
        {filesOpen && (
          <div className="session-action-panel session-action-panel-files">
            <SessionFileExplorer cwd={session.cwd} host={session.host} />
          </div>
        )}
        {terminalOpen && (
          <SessionTerminal
            sessionId={sessionId}
            label={session.cwd ?? session.host ?? 'Terminal'}
            host={session.host}
            onClose={() => setTerminalOpen(false)}
          />
        )}
        {ps === 'error' && session.errorMessage && (() => {
          // Coupling: 'Connection lost' is set by session-health-monitor when daemon unreachable.
          // 'Reconnecting' activity is set by the same monitor's recoverConnectionLostSessions().
          const isReconnecting = session.errorMessage.includes('Connection lost')
            && session.activity?.includes('Reconnecting');
          return (
            <div className={`session-error-banner${isReconnecting ? ' session-error-banner--reconnecting' : ''}`}>
              <span className="session-error-banner-icon">{isReconnecting ? '\u21BB' : ICON_WARNING}</span>
              <span className="session-error-banner-text">
                {isReconnecting ? 'Reconnecting to remote host...' : session.errorMessage}
              </span>
              <SessionRetryButton sessionId={session.claudeSessionId} onRetried={handleRetried} onResuming={handleResuming} />
            </div>
          );
        })()}
        {!historyLoading && (ps === 'stopped' || ps === 'error') && !session.archived
          && historyMessages.filter(m => m.role === 'assistant').length === 0
          && historyMessages.some(m => m.role === 'user') && (
          <div className="session-error-banner" style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', borderColor: 'color-mix(in srgb, var(--warning) 25%, transparent)' }}>
            <span className="session-error-banner-icon">{ICON_WARNING}</span>
            <span className="session-error-banner-text">Session returned empty — Claude may have encountered an issue.</span>
            <button className="session-retry-btn" onClick={handleRestart} disabled={restartBusy}>
              {restartBusy ? 'Restarting...' : 'Restart'}
            </button>
          </div>
        )}
        <SessionChatHistory
          key={sessionId}
          sessionId={sessionId}
          phase={taskPhase}
          initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
          sessionCwd={session.cwd}
          sessionHost={session.host}
          optimisticMessages={optimisticMessages}
          onMessagesDelivered={onMessagesDelivered}
          onBatchCompleted={onBatchCompleted}
          onBatchFailed={onBatchFailed}
          onEditQueued={onEditQueued}
          onDeleteQueued={onDeleteQueued}
          onAgentQueued={onAgentQueued}
          onClearCommitted={onClearCommitted}
          onRetryFailed={onRetryFailed}
          onDismissFailed={onDismissFailed}
          onFileOpen={handleFileOpen}
          onStreamingChange={onStreamingChange}
        />
        <SideQuestionDrawer sessionId={session?.claudeSessionId} />
        {fileViewerState && (
          <FileViewer
            path={fileViewerState.path}
            line={fileViewerState.line}
            host={session.host}
            onClose={handleFileViewerClose}
          />
        )}
      </div>
    </PlanContentContext.Provider>
  );
}
