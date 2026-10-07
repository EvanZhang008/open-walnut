/**
 * TaskDetailPane: one task's details, in the popup TaskDetailModal hosts (Home's
 * "Details", the session menu's "Task detail").
 *
 *   ┌ PROJECT ─────────────────────────────────────────────── × ┐
 *   │ Title                                                    │
 *   │ [status] [priority] [plugin fields] [tags]               │
 *   ├──────────────────────────────────────┬───────────────────┤
 *   │ Sessions · Parent · Subtasks         │ Start   Due       │
 *   │ Description                          │ Time    Source    │
 *   │ Note                                 │ Created Updated ID│
 *   └──────────────────────────────────────┴───────────────────┘
 *
 * The same split as the /tasks/:id page (TaskDetailPage): what the task IS on the
 * left, every small fact about it in one rail on the right. A narrow popup stacks the
 * rail above the main column. Each part is plain rows under a small label, not a box
 * of its own (2026-10-06 redesign: the old pane stacked a box per part, repeated the
 * task's phase on every session and printed session ids).
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task as CoreTask, SessionRecord } from '@open-walnut/core';
import { fetchSessionsForTask } from '@/api/sessions';
import { fetchTask, updateTask as apiUpdateTask } from '@/api/tasks';
import { fetchTriageHistory } from '@/api/chat';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { useShowPriority } from '@/hooks/useShowPriority';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { PluginSlotFact, PluginSlots } from '@/plugins/PluginSlots';
import { resolveSessionRecordStatus, sessionStatusStore } from '@/stores/session-status-store';
import { renderNoteMarkdown } from '@/utils/markdown';
import { timeAgo } from '@/utils/time';
import { CopyableId } from '../common/CopyableId';
import { DatePicker } from '../common/DatePicker';
import { PluginFieldPills } from './PluginFieldPicker';
import { TagEditor } from './TagEditor';
import { TaskStatusBadge, formatWaitUntil } from './TaskStatusControl';
import { Fact, Section, SessionRow, TaskRow } from './TaskDetailRows';
import { dateTags } from '../../../../src/core/tag-model';
import '@/styles/task-detail-pane.css';

type Task = CoreTask & { has_description?: boolean; has_summary?: boolean; has_ext?: boolean; has_note?: boolean };

const PRIORITY_TEXT: Record<string, string> = {
  immediate: '!! Immediate',
  important: '! Important',
  backlog: '~ Backlog',
};

const fullDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : undefined);

interface TaskDetailPaneProps {
  task: Task;
  allTasks?: Task[];
  onClose?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenTriageForTask?: (taskId: string) => void;
  onFocusChild?: (task: Task) => void;
  style?: CSSProperties;
}

export function TaskDetailPane({ task, allTasks, onClose, onOpenSession, onOpenTriageForTask, onFocusChild, style }: TaskDetailPaneProps) {
  const navigate = useNavigate();
  const integrations = useIntegrations();
  const statusEpoch = useSessionStatusEpoch();
  const showPriority = useShowPriority();
  // The home list ships slim rows: has_* says a field exists when its text was stripped.
  const hasDescription = !!task.description || !!task.has_description;
  const hasNote = !!task.note || !!task.has_note;
  const hasExt = !!(task.ext && Object.keys(task.ext).length > 0) || !!task.has_ext;

  // One fetchTask rehydrates every stripped field together.
  const [fullTask, setFullTask] = useState<Task | null>(null);
  useEffect(() => { setFullTask(null); }, [task.id]);
  const needsFullLoad = (hasNote && !task.note) || (hasDescription && !task.description) || (hasExt && !task.ext);
  useEffect(() => {
    if (!needsFullLoad || fullTask) return;
    let cancelled = false;
    fetchTask(task.id).then((t) => { if (!cancelled) setFullTask(t); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsFullLoad, fullTask, task.id]);
  const noteContent = task.note ?? fullTask?.note;
  const descriptionContent = task.description ?? fullTask?.description;

  // Edits write through the shared task store when it has this row, so the board row
  // moves in the same frame; the REST call is the fallback (the pop-out has no store).
  const store = useTasksContextSafe();
  const inStore = () => !!store?.tasks.some((t) => t.id === task.id);
  const handleDateChange = async (date: string | null) => {
    if (inStore()) { store!.update(task.id, { due_date: date ?? '' }); return; }
    await apiUpdateTask(task.id, { due_date: date ?? '' });
  };
  const handleStartDateChange = async (date: string | null) => {
    if (inStore()) { store!.update(task.id, { start_date: date ?? '' }); return; }
    await apiUpdateTask(task.id, { start_date: date ?? '' });
  };
  const handleTags = (change: { add_tags?: string[]; remove_tags?: string[] }) => {
    if (inStore()) { store!.update(task.id, change); return; }
    void apiUpdateTask(task.id, change).catch(() => { /* the row keeps its tags; the pane re-reads on the next event */ });
  };

  // parent_task_id may be an id prefix.
  const childTasks = useMemo(
    () => (allTasks ?? []).filter((t) => t.parent_task_id && task.id.startsWith(t.parent_task_id)),
    [allTasks, task.id],
  );
  const parentTask = useMemo(
    () => (allTasks && task.parent_task_id ? allTasks.find((t) => t.id.startsWith(task.parent_task_id!)) ?? null : null),
    [allTasks, task.parent_task_id],
  );
  const openTask = (t: Task) => (onFocusChild ? onFocusChild(t) : navigate(`/tasks/${t.id}`));

  // Every session the task names, from session_ids and the slot fields, so the list
  // does not vanish while session_ids is stale.
  const allSessionIds = useMemo(() => {
    const ids = new Set<string>(task.session_ids ?? []);
    for (const sid of [task.session_id, task.plan_session_id, task.exec_session_id]) if (sid) ids.add(sid);
    return Array.from(ids);
  }, [task.session_ids, task.session_id, task.plan_session_id, task.exec_session_id]);

  const [sessionRecords, setSessionRecords] = useState<Map<string, SessionRecord>>(new Map());
  const [sessionsLoading, setSessionsLoading] = useState(false);
  useEffect(() => {
    if (!allSessionIds.length) { setSessionRecords(new Map()); setSessionsLoading(false); return; }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setSessionsLoading(true);
    const apply = (sessions: SessionRecord[]) => {
      if (cancelled) return;
      setSessionRecords(new Map(sessions.map((s) => [s.claudeSessionId, s])));
      setSessionsLoading(false);
    };
    fetchSessionsForTask(task.id).then(apply).catch(() => {
      // Retry once: a transient error must not hide the sessions.
      if (cancelled) return;
      retryTimer = setTimeout(() => {
        if (cancelled) return;
        fetchSessionsForTask(task.id).then(apply).catch(() => { if (!cancelled) setSessionsLoading(false); });
      }, 1000);
    });
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [task.id, allSessionIds.join(',')]);

  // Before the records load, every id is a placeholder row; after, archived ones drop
  // and sessions the API knows (embedded runs filtered server-side) join.
  const loadingRows = sessionsLoading && sessionRecords.size === 0;
  const visibleSessionIds = useMemo(() => {
    if (sessionRecords.size === 0) return allSessionIds;
    const visible: string[] = [];
    for (const sid of allSessionIds) {
      const base = sessionRecords.get(sid);
      if (base && !resolveSessionRecordStatus(base).archived) visible.push(sid);
    }
    for (const [sid, base] of sessionRecords) {
      if (!allSessionIds.includes(sid) && !resolveSessionRecordStatus(base).archived) visible.push(sid);
    }
    return visible;
  }, [allSessionIds, sessionRecords, statusEpoch]);
  const openSession = (sid: string) => (onOpenSession ? onOpenSession(sid) : navigate(`/sessions?id=${sid}`));

  const [triageTotal, setTriageTotal] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchTriageHistory(1, task.id).then((resp) => { if (!cancelled) setTriageTotal(resp.total); }).catch(() => { /* non-critical */ });
    return () => { cancelled = true; };
  }, [task.id]);

  const source = getIntegrationMeta(integrations, task.source);
  const sessionRows = loadingRows ? allSessionIds : visibleSessionIds.filter((sid) => sessionRecords.has(sid));
  const hasMain = sessionRows.length > 0 || !!parentTask || childTasks.length > 0 || hasNote || hasDescription
    || (triageTotal > 0 && !!onOpenTriageForTask);

  return (
    <div className="todo-detail-pane tdp" style={style}>
      <header className="tdp-head todo-detail-meta">
        <div className="tdp-head-top">
          <span className="todo-detail-project">{task.project || 'Inbox'}</span>
          {onClose && (
            <button className="todo-detail-close" onClick={onClose} aria-label="Close detail panel" title="Close">&times;</button>
          )}
        </div>
        <h2 className="todo-detail-title">{task.title}</h2>
        <div className="todo-detail-badges">
          <TaskStatusBadge task={task} />
          {showPriority && task.priority && PRIORITY_TEXT[task.priority] && (
            <span className={`todo-detail-priority-pill priority-${task.priority}`}>{PRIORITY_TEXT[task.priority]}</span>
          )}
          <PluginFieldPills task={task} />
          <TagEditor
            tags={task.tags ?? []}
            derived={dateTags(task)}
            placeholder="+ Tag"
            onAdd={(tag) => handleTags({ add_tags: [tag] })}
            onRemove={(tag) => handleTags({ remove_tags: [tag] })}
          />
        </div>
      </header>

      <div className="tdp-body">
        <div className="tdp-main">
          {sessionRows.length > 0 && (
            <Section label="Sessions" count={sessionRows.length}>
              {sessionRows.map((sid) => {
                const record = loadingRows ? undefined : resolveSessionRecordStatus(sessionRecords.get(sid)!);
                const live = loadingRows ? (sessionStatusStore.getStatus(sid) ?? task.session_status) : record;
                return (
                  <SessionRow
                    key={sid}
                    sessionId={sid}
                    record={record}
                    processStatus={live?.process_status || 'stopped'}
                    isPlan={live?.mode === 'plan' || !!live?.planCompleted}
                    onOpen={openSession}
                  />
                );
              })}
            </Section>
          )}

          {parentTask && (
            <Section label="Parent">
              <TaskRow title={parentTask.title} phase={parentTask.phase} done={parentTask.status === 'done'} onOpen={() => openTask(parentTask)} />
            </Section>
          )}

          {childTasks.length > 0 && (
            <Section label="Subtasks" count={childTasks.length}>
              {childTasks.map((child) => (
                <TaskRow key={child.id} title={child.title} phase={child.phase} done={child.status === 'done'} onOpen={() => openTask(child)} />
              ))}
            </Section>
          )}

          {triageTotal > 0 && onOpenTriageForTask && (
            <button type="button" className="tdp-link" onClick={() => onOpenTriageForTask(task.id)}>
              Triage history ({triageTotal}) &rarr;
            </button>
          )}

          {hasDescription && (
            <Section label="Description" className="tdp-doc">
              {descriptionContent
                ? <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(descriptionContent) }} />
                : <div className="tdp-muted">Loading…</div>}
            </Section>
          )}

          {hasNote && (
            <Section label="Note" className="tdp-doc">
              {noteContent
                ? <div className="todo-detail-note markdown-body" dangerouslySetInnerHTML={{ __html: renderNoteMarkdown(noteContent) }} />
                : <div className="tdp-muted">Loading…</div>}
            </Section>
          )}

          {!hasMain && <div className="todo-detail-empty tdp-muted">No sessions, note or description yet.</div>}
        </div>

        <aside className="tdp-rail" aria-label="Task facts">
          <Fact label="Start"><DatePicker date={task.start_date} onChange={handleStartDateChange} label="Start" bare /></Fact>
          <Fact label="Due"><DatePicker date={task.due_date} onChange={handleDateChange} label="Due" bare /></Fact>
          {task.phase === 'WAITING' && task.wait_until && (
            <Fact label="Waiting until" testId="task-detail-wait-until">{formatWaitUntil(task.wait_until)}</Fact>
          )}
          {/* Plugin facts (walnut.ui.slot 'task.meta'), e.g. the time this task took. */}
          <PluginSlots
            target="task.meta"
            props={{ taskId: task.id }}
            onNavigate={onClose}
            wrap={(entry, node) => (
              <PluginSlotFact entry={entry} className="tdp-fact" labelClassName="tdp-fact-k" valueClassName="tdp-fact-v">{node}</PluginSlotFact>
            )}
          />
          <Fact label="Source">
            {task.external_url ? (
              <a className="tdp-source" href={task.external_url} target="_blank" rel="noopener noreferrer" title={`Open in ${source?.externalLinkLabel ?? source?.name ?? 'the source'}`}>
                {source?.name ?? 'Link'} &#x2197;
              </a>
            ) : (
              <span className="tdp-muted">{task.source && task.source !== 'local' ? (source?.name ?? task.source) : 'Local'}</span>
            )}
          </Fact>
          {task.created_at && <Fact label="Created" title={fullDate(task.created_at)}>{timeAgo(task.created_at)}</Fact>}
          {task.updated_at && <Fact label="Updated" title={fullDate(task.updated_at)}>{timeAgo(task.updated_at)}</Fact>}
          <Fact label="ID"><CopyableId id={task.id} label="" /></Fact>
        </aside>
      </div>
    </div>
  );
}
