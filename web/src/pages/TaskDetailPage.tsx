import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchTask, toggleCompleteTask, addNote, updateNote, updateDescription, deleteTask, addTag, removeTag, addDependency, removeDependency, updateTask, type TaskDetail } from '@/api/tasks';
import { TaskFieldEditor } from '@/components/tasks/TaskFieldEditor';
import { PluginFieldPills } from '@/components/tasks/PluginFieldPicker';
import { DatePicker } from '@/components/common/DatePicker';
import { fetchSessionsForTask, updateSession } from '@/api/sessions';
import type { SessionRecord } from '@open-walnut/core';
import { PriorityBadge } from '@/components/common/PriorityBadge';
import { StatusBadge } from '@/components/common/StatusBadge';
import { TagEditor } from '@/components/tasks/TagEditor';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useEvent } from '@/hooks/useWebSocket';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import type { ImageAttachment } from '@/api/chat';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { useTasksContext } from '@/contexts/TasksContext';
import { useConfirm, useAlert } from '@/hooks/useConfirm';
import { openPopout } from '@/popout/openPopout';
import { openSessionOnHome } from '@/utils/open-session';
import { ICON_NEW_TAB } from '@/components/common/Icons';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { resolveSessionRecordStatus } from '@/stores/session-status-store';

/**
 * Route entry. Resolves the task id and the operation-error reporter from
 * app-shell context, then renders <TaskDetailView/>.
 *
 * Id comes from the route param (`/tasks/:id`) when present, falling back to a
 * `?id=` query param (`/tasks?id=...`) — the route param always wins, so the
 * canonical `/tasks/:id` route is unaffected.
 *
 * Lives inside <AppShell> (TasksProvider present), so `useTasksContext()` is
 * safe here. The pop-out path uses <PopoutTaskDetail/> instead (no provider).
 */
export function TaskDetailPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const id = routeId ?? params.get('id') ?? undefined;
  const { showOperationError } = useTasksContext();
  return <TaskDetailView id={id} showOperationError={showOperationError} />;
}

/**
 * Pop-out entry. Rendered by PopoutTask (under PopoutRoot, OUTSIDE AppShell —
 * no TasksProvider), so it MUST NOT call useTasksContext. Sources the id from
 * the `?id=` query param and falls back to `window.alert` for operation errors
 * (the shell's unified notification toaster isn't mounted in a pop-out window).
 */
export function PopoutTaskDetail() {
  const [params] = useSearchParams();
  const id = params.get('id') ?? undefined;
  const alert = useAlert();
  return (
    <TaskDetailView
      id={id}
      isPopout
      showOperationError={(msg) => { void alert({ title: 'Operation failed', message: msg }); }}
    />
  );
}

interface TaskDetailViewProps {
  /** Full task id (or unique prefix). From route param or `?id=` query. */
  id: string | undefined;
  /** True when rendered inside a pop-out window (hides the back button). */
  isPopout?: boolean;
  /** Report a failed operation (toast in-app, alert in pop-out). */
  showOperationError: (msg: string) => void;
}

function TaskDetailView({ id, isPopout = false, showOperationError }: TaskDetailViewProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const integrations = useIntegrations();
  const confirm = useConfirm();
  const alert = useAlert();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newNote, setNewNote] = useState('');
  const [sessionRecords, setSessionRecords] = useState<Map<string, SessionRecord>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showDepPicker, setShowDepPicker] = useState(false);
  const [depSearch, setDepSearch] = useState('');
  const [depSearchResults, setDepSearchResults] = useState<Task[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const sessionSend = useSessionSend(activeSessionId);
  const statusEpoch = useSessionStatusEpoch();

  const handleBack = useCallback(() => {
    location.key === 'default' ? navigate('/') : navigate(-1);
  }, [location.key, navigate]);

  // Resolved full task ID — use for ALL event matching (URL param `id` may be a prefix)
  const taskId = task?.id ?? id;

  const loadTask = useCallback(() => {
    if (!id) return;
    setLoading(true);
    fetchTask(id)
      .then(setTask)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { loadTask(); }, [loadTask]);

  // Single session refetch — used by initial load + all WebSocket event handlers.
  // Uses resolved taskId (full ID) so the backend query always matches.
  const refetchSessions = useCallback(() => {
    if (!taskId) return;
    fetchSessionsForTask(taskId).then((sessions) => {
      const map = new Map<string, SessionRecord>();
      for (const s of sessions) map.set(s.claudeSessionId, s);
      setSessionRecords(map);
    }).catch(() => {});
  }, [taskId]);

  // Event match helper — checks if an event's taskId matches our task
  const isMyTask = useCallback((eventTaskId?: string) => {
    return !!eventTaskId && eventTaskId === taskId;
  }, [taskId]);

  const searchDepsDebounce = useRef<ReturnType<typeof setTimeout>>(null);
  const handleDepSearch = useCallback((query: string) => {
    setDepSearch(query);
    if (searchDepsDebounce.current) clearTimeout(searchDepsDebounce.current);
    if (!query.trim()) { setDepSearchResults([]); return; }
    searchDepsDebounce.current = setTimeout(async () => {
      try {
        const { fetchTasks } = await import('@/api/tasks');
        const tasks = await fetchTasks();
        const q = query.toLowerCase();
        setDepSearchResults(
          tasks.filter((t) =>
            t.id !== id &&
            !task?.depends_on?.includes(t.id) &&
            (t.title.toLowerCase().includes(q) || t.id.startsWith(q))
          ).slice(0, 10)
        );
      } catch { /* ignore */ }
    }, 300);
  }, [id, task?.depends_on]);

  const handleAddDep = useCallback(async (depId: string) => {
    if (!id) return;
    try {
      const updated = await addDependency(id, depId);
      setTask(updated);
      setShowDepPicker(false);
      setDepSearch('');
      setDepSearchResults([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add dependency');
    }
  }, [id]);

  const handleRemoveDep = useCallback(async (depId: string) => {
    if (!id) return;
    try {
      const updated = await removeDependency(id, depId);
      setTask(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove dependency');
    }
  }, [id]);

  // Load session records when task is available or session slots change.
  useEffect(() => {
    if (!task) return;
    refetchSessions();
  }, [task?.session_ids?.length, task?.exec_session_id, task?.plan_session_id, refetchSessions]);

  // ── Live updates via WebSocket ──
  // All handlers use resolved `taskId` (full ID) for matching — never raw URL param.

  // Task events — also reload when a child task changes (to refresh children list)
  useEvent('task:updated', (data) => {
    const { task: updated } = data as { task?: Task };
    if (!updated) { loadTask(); return; }
    if (updated.id === taskId) setTask(updated);
    else if (updated.parent_task_id === taskId) loadTask();
  });
  useEvent('task:completed', (data) => {
    const { task: updated } = data as { task?: Task };
    if (!updated) { loadTask(); return; }
    if (updated.id === taskId) setTask(updated);
    else if (updated.parent_task_id === taskId) loadTask();
  });
  useEvent('task:created', (data) => {
    const { task: created } = data as { task?: Task };
    if (created?.parent_task_id === taskId) loadTask();
  });
  useEvent('task:deleted', (data) => {
    const { id: deletedId } = data as { id: string };
    if (deletedId === taskId) navigate('/');
  });

  // Session events — all funnel through refetchSessions (no duplicated fetch logic)
  useEvent('session:started', (data) => {
    if (isMyTask((data as { taskId?: string }).taskId)) {
      loadTask();
      refetchSessions();
    }
  });
  useEvent('session:ended', (data) => {
    if (isMyTask((data as { taskId?: string }).taskId)) {
      loadTask();
      refetchSessions();
    }
  });
  // Auto-select the most recent active session
  useEffect(() => {
    const activeIds = [task?.plan_session_id, task?.exec_session_id].filter(Boolean) as string[];
    if (activeIds.length > 0) {
      // If current selection is still active, keep it; otherwise pick the last
      if (!activeSessionId || !activeIds.includes(activeSessionId)) {
        setActiveSessionId(activeIds[activeIds.length - 1]);
      }
    } else {
      setActiveSessionId(null);
    }
  }, [task?.plan_session_id, task?.exec_session_id, activeSessionId]);

  const handleComplete = async () => {
    if (!id) return;
    try {
      const updated = await toggleCompleteTask(id);
      setTask(updated);
    } catch (err) {
      // Surface 4xx errors (e.g. 409 active children guard) as a global toast.
      // Without this, the promise rejection is silently swallowed.
      showOperationError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDateChange = async (date: string | null) => {
    if (!id) return;
    const updated = await updateTask(id, { due_date: date ?? '' });
    setTask(updated);
  };

  const handleStartDateChange = async (date: string | null) => {
    if (!id) return;
    const updated = await updateTask(id, { start_date: date ?? '' });
    setTask(updated);
  };

  const handleDelete = async () => {
    if (!id) return;
    const confirmed = await confirm({ title: `Delete task “${task?.title}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
    if (!confirmed) return;
    try {
      await deleteTask(id);
      navigate('/tasks');
    } catch (e) {
      await alert({ title: 'Delete failed', message: (e as Error).message });
    }
  };

  const handleAddNote = async () => {
    if (!id || !newNote.trim()) return;
    const updated = await addNote(id, newNote.trim());
    setTask(updated);
    setNewNote('');
  };

  const activeSessionIds = useMemo(
    () => [task?.plan_session_id, task?.exec_session_id]
      .filter((sid): sid is string => {
        if (!sid) return false;
        const record = sessionRecords.get(sid);
        return !record || !resolveSessionRecordStatus(record).archived;
      }),
    [task?.plan_session_id, task?.exec_session_id, sessionRecords, statusEpoch],
  );
  // Merge task.session_ids with API-returned sessions (embedded sessions may not be in session_ids)
  const { otherSessionIds, archivedSessionIds } = useMemo(() => {
    const taskSids = task?.session_ids ?? [];
    const apiSids = [...sessionRecords.keys()];
    const allSids = [...new Set([...taskSids, ...apiSids])];
    const nonActive = allSids.filter((sid) => !activeSessionIds.includes(sid));
    const archived: string[] = [];
    const other: string[] = [];
    for (const sid of nonActive) {
      const baseRecord = sessionRecords.get(sid);
      const rec = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
      if (rec?.archived) archived.push(sid);
      else other.push(sid);
    }
    return { otherSessionIds: other, archivedSessionIds: archived };
  }, [task?.session_ids, sessionRecords, activeSessionIds, statusEpoch]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;
  if (!task) return <div className="empty-state"><p>Task not found</p></div>;

  return (
    <div className="task-detail-v2">
      {/* One-line header: back / title / status / actions — no scrolling to act. */}
      <div className="tdv2-head">
        {/* Back button is meaningless in a pop-out window (no in-app history). */}
        {!isPopout && (
          <button className="btn tdv2-back" onClick={handleBack}>&larr;</button>
        )}
        <h1 className="tdv2-title" title={task.title}>{task.title}</h1>
        <StatusBadge status={task.status} phase={task.phase} />
        {!isPopout && (
          <button
            className="btn btn-icon"
            title="Open in new tab"
            aria-label="Open in new tab"
            onClick={() => openPopout('task', { id: task.id })}
          >
            {ICON_NEW_TAB}
          </button>
        )}
        <button className="btn btn-primary" onClick={handleComplete}>
          {task.status === 'done' ? 'Reopen' : 'Complete'}
        </button>
        <button className="btn" onClick={handleDelete} style={{ color: 'var(--danger, #ff3b30)' }}>
          Delete
        </button>
      </div>

      <div className="tdv2-body">
      <div className="tdv2-main">
        {/* Dependencies */}
        <div className="card mb-4" style={{ display: task.is_blocked || showDepPicker || (task.depends_on?.length ?? 0) > 0 || (task.dependents?.length ?? 0) > 0 ? undefined : 'none' }}>
        <div style={{ marginBottom: '0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, opacity: 0.7 }}>Dependencies</h3>
            {task.is_blocked && (
              <span style={{ fontSize: '0.7rem', padding: '1px 6px', borderRadius: '4px', background: '#f59e0b20', color: '#f59e0b', fontWeight: 500 }}>blocked</span>
            )}
            <button
              onClick={() => setShowDepPicker(!showDepPicker)}
              style={{ marginLeft: 'auto', fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)' }}
            >
              {showDepPicker ? 'Cancel' : '+ Add'}
            </button>
          </div>
          {showDepPicker && (
            <div style={{ marginBottom: '0.5rem' }}>
              <input
                type="text"
                value={depSearch}
                onChange={(e) => handleDepSearch(e.target.value)}
                placeholder="Search tasks to add as dependency..."
                style={{ width: '100%', padding: '4px 8px', fontSize: '0.8rem', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                autoFocus
              />
              {depSearchResults.length > 0 && (
                <div style={{ marginTop: '4px', border: '1px solid var(--border)', borderRadius: '4px', maxHeight: '150px', overflowY: 'auto', background: 'var(--bg-primary)' }}>
                  {depSearchResults.map((t) => (
                    <div
                      key={t.id}
                      onClick={() => handleAddDep(t.id)}
                      style={{ padding: '4px 8px', cursor: 'pointer', fontSize: '0.8rem', borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                      onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'transparent'; }}
                    >
                      <span style={{ opacity: 0.5, marginRight: '6px' }}>{t.id.slice(0, 8)}</span>
                      {t.title}
                      <span style={{ opacity: 0.4, marginLeft: '6px', fontSize: '0.7rem' }}>{t.phase}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {task.depends_on && task.depends_on.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {task.resolved_dependencies?.map((dep) => (
                <div key={dep.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-secondary)' }}>
                  <span style={{ color: dep.phase === 'COMPLETE' ? '#34c759' : '#f59e0b' }}>
                    {dep.phase === 'COMPLETE' ? '\u2713' : '\u25CB'}
                  </span>
                  <span
                    style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}
                    onClick={() => navigate(`/tasks/${dep.id}`)}
                  >
                    {dep.title}
                  </span>
                  <span style={{ opacity: 0.4, fontSize: '0.7rem' }}>{dep.phase}</span>
                  <button
                    onClick={() => handleRemoveDep(dep.id)}
                    style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.75rem', padding: '0 4px' }}
                    title="Remove dependency"
                  >
                    &times;
                  </button>
                </div>
              )) ?? task.depends_on.map((depId) => (
                <div key={depId} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-secondary)' }}>
                  <span style={{ opacity: 0.5 }}>{depId.slice(0, 8)}</span>
                  <button
                    onClick={() => handleRemoveDep(depId)}
                    style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.75rem', padding: '0 4px' }}
                    title="Remove dependency"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          ) : (
            !showDepPicker && <span style={{ fontSize: '0.8rem', opacity: 0.4 }}>No dependencies</span>
          )}
          {/* Reverse: dependents */}
          {task.dependents?.length ? (
            <div style={{ marginTop: '0.75rem' }}>
              <h4 style={{ margin: '0 0 4px', fontSize: '0.8rem', fontWeight: 500, opacity: 0.5 }}>Dependents (waiting on this task)</h4>
              {task.dependents.map((dep) => (
                <div key={dep.id} style={{ fontSize: '0.8rem', padding: '2px 0' }}>
                  <span
                    style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--border)' }}
                    onClick={() => navigate(`/tasks/${dep.id}`)}
                  >
                    {dep.title}
                  </span>
                  <span style={{ opacity: 0.4, marginLeft: '6px', fontSize: '0.7rem' }}>{dep.phase}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {/* Parent Task */}
      {(() => {
        const parent = task.parent;
        if (!parent) return null;
        return (
          <div className="card mb-4" style={{ padding: '12px 16px' }}>
            <span style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', opacity: 0.5 }}>Parent Task</span>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: 4, cursor: 'pointer' }}
              onClick={() => navigate(`/tasks/${parent.id}`)}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: parent.status === 'done' ? '#34c759'
                  : parent.phase === 'IN_PROGRESS' ? '#007aff'
                  : parent.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                  : parent.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                  : 'var(--text-secondary)',
              }} />
              <span style={{ fontSize: '0.9rem' }}>{parent.title}</span>
            </div>
          </div>
        );
      })()}

      {/* Child Tasks */}
      {task.children?.length ? (
        <div className="card mb-4">
          <h2 className="mb-2" style={{ fontSize: '16px', fontWeight: 600 }}>
            Child Tasks
            <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, opacity: 0.5 }}>
              {task.children.length}
            </span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {task.children.map((child) => (
              <div
                key={child.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 10px', borderRadius: '6px',
                  background: 'var(--bg-secondary)', cursor: 'pointer',
                }}
                onClick={() => navigate(`/tasks/${child.id}`)}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-tertiary)'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-secondary)'; }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: child.status === 'done' ? '#34c759'
                    : child.phase === 'IN_PROGRESS' ? '#007aff'
                    : child.phase === 'AGENT_COMPLETE' ? 'var(--error)'
                    : child.phase === 'AWAIT_HUMAN_ACTION' ? 'var(--error)'
                    : 'var(--text-secondary)',
                  opacity: child.status === 'done' ? 0.6 : 1,
                }} />
                <span style={{
                  flex: 1, fontSize: '0.85rem',
                  textDecoration: child.status === 'done' ? 'line-through' : 'none',
                  opacity: child.status === 'done' ? 0.5 : 1,
                }}>
                  {child.title}
                </span>
                <span style={{ fontSize: '0.7rem', opacity: 0.4 }}>{child.phase}</span>
                {child.priority !== 'none' && (
                  <PriorityBadge priority={child.priority as 'immediate' | 'important' | 'backlog' | 'none'} />
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Active Sessions — inline chat (always first via .tdv2-sessions order) */}
      {activeSessionIds.length > 0 && (
        <div className="card mb-4 tdv2-sessions">
          <h2 className="mb-2" style={{ fontSize: '16px', fontWeight: 600 }}>
            Active Sessions
            <span className="task-session-pill task-session-pill-running" style={{ marginLeft: 8 }}>
              <span className="task-session-dot" />
              {activeSessionIds.length}
            </span>
          </h2>
          {activeSessionIds.length > 1 && (
            <div className="task-session-tabs">
              {activeSessionIds.map((sid) => {
                const baseRecord = sessionRecords.get(sid);
                const record = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
                const label = record?.title || sid.slice(0, 12) + '\u2026';
                return (
                  <button
                    key={sid}
                    className={`task-session-tab${activeSessionId === sid ? ' active' : ''}`}
                    onClick={() => setActiveSessionId(sid)}
                  >
                    <span className="session-pill-status-dot dot-active" />
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {activeSessionId && (
            <div className="task-session-chat-container">
              <SessionChatHistory
                sessionId={activeSessionId}
                engine={sessionRecords.get(activeSessionId)?.engine}
                optimisticMessages={sessionSend.optimisticMsgs}
                onMessagesDelivered={sessionSend.handleMessagesDelivered}
                onBatchCompleted={sessionSend.handleBatchCompleted}
                onEditQueued={(queueId, newText) => sessionSend.handleEditQueued(activeSessionId, queueId, newText)}
                onDeleteQueued={(queueId) => sessionSend.handleDeleteQueued(activeSessionId, queueId)}
                onAgentQueued={sessionSend.addExternalQueued}
              />
              <div className="session-chat-input-wrapper">
                {sessionSend.sendError && (
                  <div className="text-xs" style={{ color: 'var(--error)', padding: '4px 16px' }}>
                    {sessionSend.sendError}
                  </div>
                )}
                <ChatInput
                  onSend={(msg: string, images?: ImageAttachment[]) => sessionSend.send(activeSessionId, msg, images)}
                  placeholder="Send a message to this session..."
                  showCommands={false}
                  draftKey={activeSessionId ? `draft:session:${activeSessionId}` : undefined}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Other Sessions */}
      {otherSessionIds.length > 0 && (
        <div className="card mb-4">
          <h2 className="mb-2" style={{ fontSize: '16px', fontWeight: 600 }}>
            {activeSessionIds.length > 0 ? 'Other Sessions' : 'Linked Sessions'}
          </h2>
          <div className="flex flex-col gap-2">
            {otherSessionIds.map((sid) => {
              const baseRecord = sessionRecords.get(sid);
              const record = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
              const label = record?.title || sid.slice(0, 12) + '\u2026';
              const dotClass = record?.process_status === 'error' ? 'dot-error' : 'dot-completed';
              return (
                <div
                  key={sid}
                  className="tdv2-session-row"
                  title={sid}
                  onClick={() => openSessionOnHome(sid, navigate)}
                >
                  <span className={`session-pill-status-dot ${dotClass}`} />
                  <span className="tdv2-session-label">{label}</span>
                  {record?.process_status && (
                    <span className="text-xs text-muted">{record.process_status}</span>
                  )}
                  {(record?.process_status === 'stopped' || record?.process_status === 'error') && (
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: '0.7rem', padding: '1px 6px', opacity: 0.7 }}
                      onClick={(e) => { e.stopPropagation(); void updateSession(sid, { archived: true }).then(loadTask); }}
                    >
                      Archive
                    </button>
                  )}
                  {/* Arrow must come from a JS string literal (an escape sequence in
                      JSX *text* renders as the six literal characters), which is why
                      the sibling ellipses above use '\u2026' the same way. */}
                  <span className="tdv2-session-open">Open session {'\u2192'}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Archived Sessions */}
      {archivedSessionIds.length > 0 && (
        <div className="card mb-4">
          <div className="session-detail-collapse">
            <button
              className="session-detail-collapse-toggle"
              onClick={() => setArchivedOpen(!archivedOpen)}
            >
              <span className="session-detail-collapse-arrow">{archivedOpen ? '\u25BE' : '\u25B8'}</span>
              Archived Sessions ({archivedSessionIds.length})
            </button>
            {archivedOpen && (
              <div className="session-detail-collapse-body">
                <div className="flex flex-col gap-2">
                  {archivedSessionIds.map((sid) => {
                    const baseRecord = sessionRecords.get(sid);
                    const record = baseRecord ? resolveSessionRecordStatus(baseRecord) : undefined;
                    const label = record?.title || sid.slice(0, 12) + '\u2026';
                    return (
                      <div key={sid} className="flex items-center gap-2" style={{ opacity: 0.6 }}>
                        <span className="session-pill-status-dot dot-completed" />
                        <span
                          className="session-id-pill"
                          title={sid}
                          onClick={() => openSessionOnHome(sid, navigate)}
                        >
                          {label}
                        </span>
                        {record?.archive_reason && (
                          <span className="text-xs text-muted" style={{ fontStyle: 'italic' }}>
                            {record.archive_reason === 'plan_executed' ? 'plan executed' : record.archive_reason}
                          </span>
                        )}
                        <button
                          className="btn btn-sm"
                          style={{ fontSize: '0.7rem', padding: '1px 6px' }}
                          onClick={() => updateSession(sid, { archived: false })}
                        >
                          Unarchive
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Summary (AI) + Milestones cards were retired 2026-07-18: the NOTE below is
          the single AI-maintained living document (Executive Summary / User Request /
          Context / Progress / References / Work Log); task.summary is derived from its
          Executive Summary and shown only in list views. */}

      {/* Description — shared rich editor, always-on autosave. */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Description</h2>
        </div>
        <TaskFieldEditor
          taskId={task.id}
          field="description"
          value={task.description || ''}
          save={updateDescription}
          placeholder="What is this task about? Why does it exist?"
        />
      </div>

      {/* Note — shared rich editor, always-on autosave. */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Note</h2>
        </div>
        {/* Empty note + a session attached = the AI's first self-report simply
            hasn't fired yet (short quiet window after the first turn). Say so —
            a silent blank reads as "broken" (two incident reports, 2026-07-25). */}
        {!(task.note || '').trim() && (task.session_ids?.length ?? 0) > 0 && (
          <div className="text-sm mb-2" style={{ color: 'var(--text-tertiary, #8a8a8e)' }}>
            AI keeps this note updated after each working session — the first
            update lands shortly after the session pauses.
          </div>
        )}
        <TaskFieldEditor
          taskId={task.id}
          field="note"
          value={task.note || ''}
          save={updateNote}
          placeholder="Working notes, findings, context…"
        />
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') handleAddNote(); }}
            placeholder="Add to note..."
            style={{ flex: 1 }}
          />
          <button className="btn btn-sm" onClick={handleAddNote}>Add</button>
        </div>
      </div>
      </div>{/* /tdv2-main */}

      {/* Right meta rail — every attribute inline-editable, no scrolling hunt. */}
      <aside className="tdv2-side">
        <div className="tdv2-kv">
          <span className="tdv2-k">Project</span>
          <span className="tdv2-v">{task.project || 'Inbox'}</span>
        </div>
        <div className="tdv2-kv">
          <span className="tdv2-k">Priority</span>
          <span className="tdv2-v"><PriorityBadge priority={task.priority} /></span>
        </div>
        <div className="tdv2-kv">
          <span className="tdv2-k">Start</span>
          <span className="tdv2-v"><DatePicker date={task.start_date} onChange={handleStartDateChange} label="Start" ghostWhenEmpty /></span>
        </div>
        <div className="tdv2-kv">
          <span className="tdv2-k">Due</span>
          <span className="tdv2-v"><DatePicker date={task.due_date} onChange={handleDateChange} label="Due" ghostWhenEmpty /></span>
        </div>
        {/* Plugin-declared fields (manifest taskFields) — generic pills; each
            opens the shared option flyout. Replaces the hardcoded SprintPicker. */}
        <div className="tdv2-kv">
          <span className="tdv2-k">Fields</span>
          <span className="tdv2-v"><PluginFieldPills task={task} /></span>
        </div>
        <div className="tdv2-kv tdv2-kv-block">
          <span className="tdv2-k">Tags</span>
          <TagEditor
            tags={task.tags ?? []}
            onAdd={async (tag) => {
              const updated = await addTag(task.id, tag);
              setTask(updated);
            }}
            onRemove={async (tag) => {
              const updated = await removeTag(task.id, tag);
              setTask(updated);
            }}
          />
        </div>
        <div className="tdv2-kv">
          <span className="tdv2-k">Source</span>
          <span className="tdv2-v">
            {task.source === 'local' ? (
              <span className="text-sm text-muted" title="Local only — not synced to any service">Local</span>
            ) : task.external_url ? (
              <a
                href={task.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="task-detail-external-link"
              >
                {getIntegrationMeta(integrations, task.source)?.externalLinkLabel ?? getIntegrationMeta(integrations, task.source)?.name ?? 'External'} &#x2197;
              </a>
            ) : (
              <span className="text-sm text-muted">{task.source}</span>
            )}
          </span>
        </div>
      </aside>
      </div>{/* /tdv2-body */}
    </div>
  );
}
