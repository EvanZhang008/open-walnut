import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { useConfirm } from '@/hooks/useConfirm';
import { formatDateDisplay, isOverdue } from '../common/DatePicker';
import { ProjectSourceBadge } from './ProjectSourceBadge';
import { TaskSessionPill } from './SessionPill';
import { SyncIndicator, type TaskListProjection } from './TaskCard';

interface TasksPageTableProps {
  tasks: Task[];
  /** null = All Tasks (renders the PROJECT column), '' = Inbox, else a project name. */
  activeProject: string | null;
  /** lowercased project name → provider source, for the PROJECT column badges. */
  sourceByName: Map<string, string>;
  onToggleComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onCreate: (title: string) => void | Promise<void>;
}

const PRIORITY_META: Record<string, { dot: string; labelCls: string; label: string }> = {
  immediate: { dot: 'p0', labelCls: ' lp0', label: 'P0 · urgent' },
  important: { dot: 'p1', labelCls: ' lp1', label: 'P1 · high' },
  backlog: { dot: 'p2', labelCls: '', label: 'P2 · normal' },
};

/** Dense Asana-style task table: sticky header, 36px rows, top ghost add-row. */
export function TasksPageTable({
  tasks,
  activeProject,
  sourceByName,
  onToggleComplete,
  onDelete,
  onCreate,
}: TasksPageTableProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isAll = activeProject === null;
  const cols = isAll ? 'tp-cols-5' : 'tp-cols-4';

  // ── ghost add-row state ──
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const ghostScopeLabel = isAll || activeProject === '' ? 'Inbox' : activeProject;

  const handleGhostKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setAdding(false);
      setDraft('');
    } else if (e.key === 'Enter') {
      const title = draft.trim();
      if (!title) return;
      setDraft('');
      void onCreate(title);
      // Re-arm: the input stays open and focused for rapid entry.
      inputRef.current?.focus();
    }
  };

  const handleDelete = async (e: MouseEvent, task: Task) => {
    e.stopPropagation();
    if (await confirm({ title: `Delete task “${task.title}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
      onDelete(task.id);
    }
  };

  return (
    <div className="tp-table-scroll" data-testid="tasks-table">
      <div className={`tp-thead ${cols}`}>
        <span>Title</span>
        <span>Priority</span>
        <span>Due</span>
        <span>Session</span>
        {isAll && <span>Project</span>}
      </div>

      {/* ghost "＋ New task…" row — always at the very top of the body */}
      <div
        className={`tp-ghost ${cols}${adding ? ' editing' : ''}`}
        data-testid="tasks-ghost-row"
        onClick={() => { if (!adding) setAdding(true); }}
      >
        <span className="tp-cell-title">
          <span className="tp-gplus">＋</span>
          {adding ? (
            <input
              ref={inputRef}
              className="tp-ghost-input"
              placeholder="Task title — Enter to create"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleGhostKey}
              onBlur={() => { if (!draft.trim()) { setAdding(false); setDraft(''); } }}
            />
          ) : (
            <span className="tp-ghost-text">New task… ({ghostScopeLabel})</span>
          )}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="tp-empty">Nothing here — use the "＋ New task…" row above or "＋ Task".</div>
      ) : (
        tasks.map((t) => {
          const pri = PRIORITY_META[t.priority];
          const dueLabel = t.due_date ? formatDateDisplay(t.due_date) : '';
          const project = t.project || '';
          return (
            <div key={t.id} className={`tp-row ${cols}${t.status === 'done' ? ' done' : ''}`} data-task-id={t.id}>
              <span className="tp-cell-title">
                <button
                  type="button"
                  className="tp-status-circle"
                  title={t.status === 'done' ? 'Mark as todo' : 'Mark as done'}
                  onClick={() => onToggleComplete(t.id)}
                >
                  {t.status === 'done' ? '✓' : ''}
                </button>
                {t.starred && <span className="tp-row-star">★</span>}
                <button
                  type="button"
                  className="tp-row-title"
                  onClick={() => navigate(`/tasks/${t.id}`)}
                >
                  {t.title}
                </button>
                <SyncIndicator task={t as TaskListProjection} />
              </span>
              <span>
                {pri ? (
                  <span className={`tp-cell-pri${pri.labelCls}`}>
                    <span className={`tp-p-dot ${pri.dot}`} />
                    {pri.label}
                  </span>
                ) : (
                  <span className="tp-cell-empty">–</span>
                )}
              </span>
              <span className={`tp-cell-due${isOverdue(t.due_date) && t.status !== 'done' ? ' overdue' : ''}`}>
                {dueLabel || <span className="tp-cell-empty">–</span>}
              </span>
              <span className="tp-cell-session">
                {/* Shared pill — same status text/classes as every other surface
                    (specs assert .task-session-pill contains Running/Idle here). */}
                <TaskSessionPill task={t} />
              </span>
              {isAll && (
                <span>
                  <span className="tp-proj-pill" title={project || 'Inbox'}>
                    {project ? '📁' : '📥'}
                    <span className="tp-proj-name">{project || 'Inbox'}</span>
                    <ProjectSourceBadge source={project ? sourceByName.get(project.toLowerCase()) : undefined} />
                  </span>
                </span>
              )}
              <button
                type="button"
                className="tp-row-del"
                title="Delete task"
                onClick={(e) => void handleDelete(e, t)}
              >
                ⋮
              </button>
            </div>
          );
        })
      )}
    </div>
  );
}
