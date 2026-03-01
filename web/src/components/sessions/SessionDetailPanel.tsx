import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react';
import { SessionChatHistory } from './SessionChatHistory';
import { SessionNotes } from './SessionNotes';
import { UserMessagesSummary } from './UserMessagesSummary';
import { PlanPreviewSection } from './PlanPreviewSection';
import { WorkStatusPicker } from './WorkStatusPicker';
import { SessionCopyButtons } from './SessionCopyButtons';
import { updateSession, executePlanSession, executePlanContinue } from '@/api/sessions';
import { useSessionHistory } from '@/hooks/useSessionHistory';
import { useSessionPlan } from '@/hooks/useSessionPlan';
import { useSessionUsage, formatModelName } from '@/hooks/useSessionUsage';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import type { SessionRecord } from '@/types/session';
import { timeAgo } from '@/utils/time';

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
  onEditQueued?: (queueId: string, newText: string) => void;
  onDeleteQueued?: (queueId: string) => void;
  onAgentQueued?: (msg: { queueId: string; text: string }) => void;
  onClearCommitted?: () => void;
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

function EditableTitle({ sessionId, title, onSaved }: { sessionId: string; title: string; onSaved?: () => void }) {
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
    updateSession(sessionId, { title: trimmed })
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
      title="Click to rename"
    >
      {title}
    </h2>
  );
}

export function SessionDetailPanel({ session, taskTitle, summary, onTitleChanged, onSessionReplaced, optimisticMessages, onMessagesDelivered, onBatchCompleted, onEditQueued, onDeleteQueued, onAgentQueued, onClearCommitted }: SessionDetailPanelProps) {
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executeStarted, setExecuteStarted] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [executeOpen, setExecuteOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // Track latest sessionId so async callbacks can detect navigation
  const sessionIdRef = useRef(session?.claudeSessionId);
  sessionIdRef.current = session?.claudeSessionId;

  // Fetch messages for the UserMessagesSummary
  const sessionId_ = session?.claudeSessionId || '';
  const { messages: historyMessages, loading: historyLoading } = useSessionHistory(sessionId_ || null);

  // Lift plan hook here so we can provide plan content via context to all PlanCards
  const hasPlan = !!session?.planCompleted;
  const isFromPlan = !!session?.fromPlanSessionId;
  const shouldFetchPlan = hasPlan || isFromPlan;
  const { plan, loading: planLoading, refresh: planRefresh } = useSessionPlan(sessionId_ || undefined, shouldFetchPlan);

  // Real-time model + context window usage
  const liveUsage = useSessionUsage(sessionId_ || null);
  // For display: prefer live data, fall back to SessionRecord.model for stopped sessions
  const displayModel = formatModelName(liveUsage.model || session?.model);
  const contextPercent = liveUsage.contextPercent;

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
    }
  }, []);

  // Reset state when session changes
  useEffect(() => {
    setExecuting(false);
    setExecuteError(null);
    setExecuteStarted(false);
    setDetailsOpen(false);
    setExecuteOpen(false);
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
  const title = session.title || session.description || session.slug || sessionId || 'Untitled session';
  const ps = session.process_status ?? 'stopped';
  const ws = session.work_status ?? 'completed';
  const isEmbedded = session.provider === 'embedded';
  const showExecuteButtons =
    session.planCompleted === true
    && ws !== 'error'
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

  /** "Clear Context & Execute" — creates a fresh session, old one is absorbed. */
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
  const taskLabel = taskTitle || session.taskId;
  const hasDetails = !!(session.project || session.startedAt || session.cwd || session.host || session.activity || session.description);

  const planContentValue = plan?.content ?? null;

  return (
    <PlanContentContext.Provider value={planContentValue}>
      <div className="session-detail-panel" ref={panelRef}>
        <div className="session-detail-header">
          {/* Title row with badges */}
          <div className="session-detail-title-row">
            <EditableTitle sessionId={sessionId} title={title} onSaved={onTitleChanged} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {session.mode && session.mode !== 'default' && (
                <span
                  className="session-detail-badge"
                  style={{ color: 'var(--fg-muted)', background: 'var(--bg-tertiary)', fontWeight: 600, fontSize: '11px' }}
                >
                  {session.mode === 'plan' ? '\uD83D\uDCCB Plan' : '\u26A1 Bypass'}
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
              <WorkStatusPicker
                sessionId={sessionId}
                processStatus={ps}
                workStatus={ws}
                size="md"
              />
            </div>
          </div>

          {/* Compact meta bar */}
          <div className="session-detail-meta-bar">
            {session.taskId && (
              <a href={`/tasks/${session.taskId}`} className="session-detail-link" title={`Task: ${session.taskId}`}>
                {taskLabel}
              </a>
            )}
            {displayModel && (
              <span className="session-detail-model-pill">
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
            {sessionId && <SessionCopyButtons sessionId={sessionId} cwd={session.cwd} />}
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

          <PlanPreviewSection session={session} plan={plan} loading={planLoading} refresh={planRefresh} />

          {summary && (
            <p className="session-detail-summary text-sm">{summary}</p>
          )}
          {(showExecuteButtons || executeStarted) && (
            <div className="execute-plan-section">
              <button className="execute-plan-toggle" onClick={() => setExecuteOpen(o => !o)}>
                <span className="execute-plan-arrow">{executeOpen ? '\u25BE' : '\u25B8'}</span>
                <span className="execute-plan-label">
                  {executeStarted ? 'Execution Started' : 'Execute Plan'}
                </span>
                {!executeStarted && !executeOpen && (
                  <span className="execute-plan-hint">2 options</span>
                )}
              </button>
              {executeOpen && !executeStarted && showExecuteButtons && (
                <div className="execute-plan-body">
                  <div className="execute-plan-options">
                    <button
                      className="execute-plan-btn"
                      onClick={handleExecuteContinue}
                      disabled={executing}
                    >
                      {executing ? 'Starting\u2026' : '\u25B6 Execute'}
                      <span className="execute-plan-btn-desc">Resume with full permissions</span>
                    </button>
                    <button
                      className="execute-plan-btn-secondary"
                      onClick={handleClearContextExecute}
                      disabled={executing}
                    >
                      Clear Context & Execute
                      <span className="execute-plan-btn-desc">Fresh session with plan injected</span>
                    </button>
                  </div>
                  {executeError && (
                    <div className="execute-plan-error">{executeError}</div>
                  )}
                </div>
              )}
              {executeOpen && executeStarted && (
                <div className="execute-plan-body">
                  <p className="execute-plan-started">Session is now executing the plan.</p>
                </div>
              )}
            </div>
          )}
        </div>
        <UserMessagesSummary
          messages={historyMessages}
          loading={historyLoading}
          onMessageClick={handleMessageClick}
        />
        <SessionNotes
          sessionId={sessionId}
          initialNote={session.human_note}
        />
        <SessionChatHistory
          key={sessionId}
          sessionId={sessionId}
          workStatus={session.work_status}
          initialPrompt={historyMessages.find(m => m.role === 'user')?.text}
          optimisticMessages={optimisticMessages}
          onMessagesDelivered={onMessagesDelivered}
          onBatchCompleted={onBatchCompleted}
          onEditQueued={onEditQueued}
          onDeleteQueued={onDeleteQueued}
          onAgentQueued={onAgentQueued}
          onClearCommitted={onClearCommitted}
        />
      </div>
    </PlanContentContext.Provider>
  );
}
