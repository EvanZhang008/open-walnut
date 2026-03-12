import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import type { Task } from '@walnut/core';
import { renderNoteMarkdown } from '@/utils/markdown';
import { fetchTask, toggleCompleteTask, starTask, addNote, updateNote, updateDescription, deleteTask, addTag, removeTag, addDependency, removeDependency, updateTask } from '@/api/tasks';
import { SprintPicker } from '@/components/tasks/SprintPicker';
import { fetchSessionsForTask, updateSession } from '@/api/sessions';
import type { SessionRecord } from '@walnut/core';
import { PriorityBadge } from '@/components/common/PriorityBadge';
import { StatusBadge } from '@/components/common/StatusBadge';
import { StarButton } from '@/components/common/StarButton';
import { TagEditor } from '@/components/tasks/TagEditor';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useEvent } from '@/hooks/useWebSocket';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import type { ImageAttachment } from '@/api/chat';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const integrations = useIntegrations();
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newNote, setNewNote] = useState('');
  const [editingNote, setEditingNote] = useState(false);
  const [noteEditValue, setNoteEditValue] = useState('');
  const [editingDescription, setEditingDescription] = useState(false);
  const [descEditValue, setDescEditValue] = useState('');
  const [sessionRecords, setSessionRecords] = useState<Map<string, SessionRecord>>(new Map());
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showDepPicker, setShowDepPicker] = useState(false);
  const [depSearch, setDepSearch] = useState('');
  const [depSearchResults, setDepSearchResults] = useState<Task[]>([]);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sessionSend = useSessionSend(activeSessionId);

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
  useEvent('task:starred', (data) => {
    const { task: updated } = data as { task?: Task };
    if (!updated) { loadTask(); return; }
    if (updated.id === taskId) setTask(updated);
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
  useEvent('session:status-changed', (data) => {
    const d = data as { sessionId?: string; taskId?: string };
    if (isMyTask(d.taskId)) {
      refetchSessions();
    }
  });

  // Auto-select the most recent active session
  useEffect(() => {
    const activeIds = [task?.plan_session_id, task?.exec_session_id].filter(Boolean) as string[];
    if (activeIds.length > 0) {
      // If current selection is still active, keep it; otherwise pick the last
      if (!activeSessionId || !activeIds.includes(activeSessionId)) {
        setActiveSessionId(activeIds.at(-1)!);
      }
    } else {
      setActiveSessionId(null);
    }
  }, [task?.plan_session_id, task?.exec_session_id, activeSessionId]);

  const handleComplete = async () => {
    if (!id) return;
    const updated = await toggleCompleteTask(id);
    setTask(updated);
  };

  const handleStar = async () => {
    if (!id) return;
    const updated = await starTask(id);
    setTask(updated);
  };

  const handleSprintChange = async (sprintName: string | null) => {
    if (!id) return;
    const updated = await updateTask(id, { sprint: sprintName ?? '' });
    setTask(updated);
  };

  const handleDelete = async () => {
    if (!id) return;
    const confirmed = window.confirm(`Delete task "${task?.title}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await deleteTask(id);
      navigate('/tasks');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const handleAddNote = async () => {
    if (!id || !newNote.trim()) return;
    const updated = await addNote(id, newNote.trim());
    setTask(updated);
    setNewNote('');
  };

  const handleSaveNote = async () => {
    if (!id) return;
    const updated = await updateNote(id, noteEditValue);
    setTask(updated);
    setEditingNote(false);
  };

  const handleSaveDescription = async () => {
    if (!id) return;
    const updated = await updateDescription(id, descEditValue);
    setTask(updated);
    setEditingDescription(false);
  };


  const activeSessionIds = useMemo(
    () => [task?.plan_session_id, task?.exec_session_id]
      .filter((sid): sid is string => !!sid && !sessionRecords.get(sid)?.archived),
    [task?.plan_session_id, task?.exec_session_id, sessionRecords],
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
      const rec = sessionRecords.get(sid);
      if (rec?.archived) archived.push(sid);
      else other.push(sid);
    }
    return { otherSessionIds: other, archivedSessionIds: archived };
  }, [task?.session_ids, sessionRecords, activeSessionIds]);

  const renderedNote = useMemo(
    () => task?.note ? renderNoteMarkdown(task.note) : '',
    [task?.note],
  );

  const renderedSummary = useMemo(
    () => task?.summary ? renderNoteMarkdown(task.summary) : '',
    [task?.summary],
  );

  const renderedConversationLog = useMemo(() => {
    if (!task?.conversation_log) return '';
    const log = task.conversation_log;
    const entries = log.split(/(?=^### \d{4}-\d{2}-\d{2} \d{2}:\d{2})/m).filter(Boolean);
    const reversed = entries.length > 1 ? entries.reverse().join('\n\n') : log;
    return renderNoteMarkdown(reversed);
  }, [task?.conversation_log]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;
  if (!task) return <div className="empty-state"><p>Task not found</p></div>;

  return (
    <div>
      <button className="btn mb-4" onClick={handleBack}>&larr; Back</button>

      <div className="card mb-4">
        <div className="flex items-center gap-3 mb-2">
          <StarButton starred={!!task.starred} onClick={handleStar} />
          <h1 className="page-title" style={{ flex: 1 }}>{task.title}</h1>
        </div>
        <div className="flex gap-2 items-center mb-4">
          <StatusBadge status={task.status} phase={task.phase} />
          <PriorityBadge priority={task.priority} />
          <span className="text-sm text-muted">{task.category}{task.project && task.project !== task.category ? ` / ${task.project}` : ''}</span>
          {task.due_date && <span className="text-sm text-muted">Due: {task.due_date}</span>}
          <SprintPicker sprint={task.sprint} onSprintChange={handleSprintChange} />
        </div>
        {/* Dependencies */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '0.85rem', fontWeight: 600, opacity: 0.7 }}>Dependencies</h3>
            {(task as Record<string, unknown>).is_blocked && (
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
              {((task as Record<string, unknown>).resolved_dependencies as Array<{ id: string; title: string; phase: string }> | undefined)?.map((dep) => (
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
          {((task as Record<string, unknown>).dependents as Array<{ id: string; title: string; phase: string }> | undefined)?.length ? (
            <div style={{ marginTop: '0.75rem' }}>
              <h4 style={{ margin: '0 0 4px', fontSize: '0.8rem', fontWeight: 500, opacity: 0.5 }}>Dependents (waiting on this task)</h4>
              {((task as Record<string, unknown>).dependents as Array<{ id: string; title: string; phase: string }>).map((dep) => (
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
        <div className="mb-3">
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
        {task.source === 'local' ? (
          <div className="mb-4">
            <span className="text-sm text-muted">Local only — not synced to any service</span>
          </div>
        ) : task.external_url ? (
          <div className="mb-4">
            <a
              href={task.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="task-detail-external-link"
            >
              Open in {getIntegrationMeta(integrations, task.source)?.externalLinkLabel ?? getIntegrationMeta(integrations, task.source)?.name ?? 'External'} &#x2197;
            </a>
          </div>
        ) : null}
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={handleComplete}>
            {task.status === 'done' ? 'Reopen' : 'Complete'}
          </button>
          <button
            className="btn"
            onClick={handleDelete}
            style={{ color: 'var(--danger, #ff3b30)' }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* Parent Task */}
      {(() => {
        const parent = (task as Record<string, unknown>).parent as { id: string; title: string; phase: string; status: string } | undefined;
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
      {((task as Record<string, unknown>).children as Array<{ id: string; title: string; phase: string; status: string; priority: string }> | undefined)?.length ? (
        <div className="card mb-4">
          <h2 className="mb-2" style={{ fontSize: '16px', fontWeight: 600 }}>
            Child Tasks
            <span style={{ marginLeft: 8, fontSize: '0.75rem', fontWeight: 400, opacity: 0.5 }}>
              {((task as Record<string, unknown>).children as Array<unknown>).length}
            </span>
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {((task as Record<string, unknown>).children as Array<{ id: string; title: string; phase: string; status: string; priority: string }>).map((child) => (
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

      {/* Active Sessions — inline chat (always first) */}
      {activeSessionIds.length > 0 && (
        <div className="card mb-4">
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
                const record = sessionRecords.get(sid);
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
                optimisticMessages={sessionSend.optimisticMsgs}
                onMessagesDelivered={sessionSend.handleMessagesDelivered}
                onBatchCompleted={sessionSend.handleBatchCompleted}
                onEditQueued={(queueId, newText) => sessionSend.handleEditQueued(activeSessionId, queueId, newText)}
                onDeleteQueued={(queueId) => sessionSend.handleDeleteQueued(activeSessionId, queueId)}
                onAgentQueued={sessionSend.addExternalQueued}
                onClearCommitted={sessionSend.clearCommitted}
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
              const record = sessionRecords.get(sid);
              const label = record?.title || sid.slice(0, 12) + '\u2026';
              const dotClass = record?.work_status === 'error' ? 'dot-error' : 'dot-completed';
              return (
                <div key={sid} className="flex items-center gap-2">
                  <span className={`session-pill-status-dot ${dotClass}`} />
                  <span
                    className="session-id-pill"
                    title={sid}
                    onClick={() => navigate(`/sessions?id=${sid}`)}
                  >
                    {label}
                  </span>
                  {record?.work_status && (
                    <span className="text-xs text-muted">{record.work_status}</span>
                  )}
                  {record?.process_status === 'stopped' && (
                    <button
                      className="btn btn-sm"
                      style={{ fontSize: '0.7rem', padding: '1px 6px', opacity: 0.7 }}
                      onClick={() => updateSession(sid, { archived: true }).then(() => {
                        setSessionRecords(prev => {
                          const m = new Map(prev);
                          const r = m.get(sid);
                          if (r) m.set(sid, { ...r, archived: true });
                          return m;
                        });
                        loadTask();
                      })}
                    >
                      Archive
                    </button>
                  )}
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
                    const record = sessionRecords.get(sid);
                    const label = record?.title || sid.slice(0, 12) + '\u2026';
                    return (
                      <div key={sid} className="flex items-center gap-2" style={{ opacity: 0.6 }}>
                        <span className="session-pill-status-dot dot-completed" />
                        <span
                          className="session-id-pill"
                          title={sid}
                          onClick={() => navigate(`/sessions?id=${sid}`)}
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
                          onClick={() => updateSession(sid, { archived: false }).then(() => {
                            setSessionRecords(prev => {
                              const m = new Map(prev);
                              const r = m.get(sid);
                              if (r) m.set(sid, { ...r, archived: false });
                              return m;
                            });
                          })}
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

      {/* Summary (AI-maintained) */}
      {task.summary && (
        <div className="card mb-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Summary</h2>
            <span style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 4,
              background: 'var(--accent)',
              color: '#fff',
              fontWeight: 500,
            }}>
              AI-maintained
            </span>
          </div>
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedSummary }} />
        </div>
      )}

      {/* Conversation Log */}
      {task.conversation_log && (
        <div className="card mb-4">
          <h2 className="mb-2" style={{ fontSize: '16px', fontWeight: 600 }}>Conversation Log</h2>
          <div className="markdown-body conversation-log" dangerouslySetInnerHTML={{ __html: renderedConversationLog }} />
        </div>
      )}


      {/* Description */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Description</h2>
          {!editingDescription && (
            <button
              className="btn btn-sm"
              onClick={() => { setDescEditValue(task.description || ''); setEditingDescription(true); }}
            >
              Edit
            </button>
          )}
        </div>
        {editingDescription ? (
          <div>
            <textarea
              ref={descRef}
              value={descEditValue}
              onChange={(e) => setDescEditValue(e.target.value)}
              rows={4}
              style={{ width: '100%', resize: 'vertical' }}
              placeholder="What is this task about? Why does it exist?"
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button className="btn btn-primary btn-sm" onClick={handleSaveDescription}>Save</button>
              <button className="btn btn-sm" onClick={() => setEditingDescription(false)}>Cancel</button>
            </div>
          </div>
        ) : task.description ? (
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(task.description) }} />
        ) : (
          <p className="text-muted text-sm">No description yet</p>
        )}
      </div>

      {/* Note */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-2">
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Note</h2>
          {!editingNote && task.note && (
            <button
              className="btn btn-sm"
              onClick={() => { setNoteEditValue(task.note || ''); setEditingNote(true); }}
            >
              Edit
            </button>
          )}
        </div>
        {editingNote ? (
          <div>
            <textarea
              ref={noteRef}
              value={noteEditValue}
              onChange={(e) => setNoteEditValue(e.target.value)}
              rows={12}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 13 }}
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button className="btn btn-primary btn-sm" onClick={handleSaveNote}>Save</button>
              <button className="btn btn-sm" onClick={() => setEditingNote(false)}>Cancel</button>
            </div>
          </div>
        ) : task.note ? (
          <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedNote }} />
        ) : (
          <p className="text-muted text-sm">No notes yet</p>
        )}
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddNote(); }}
            placeholder="Add to note..."
            style={{ flex: 1 }}
          />
          <button className="btn btn-sm" onClick={handleAddNote}>Add</button>
        </div>
      </div>
    </div>
  );
}
