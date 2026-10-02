import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { log } from '@/utils/log';
import { adoptCandidates, resolveParent } from './adopt-candidates';
import '@/styles/subtask-pill.css';

/** Rows drawn at once; the filter narrows a longer list (the store can hold thousands). */
const SHOWN_ROWS = 100;

/**
 * "Adopt a worker…": pick an open task to become a worker (subtask) of
 * `leader`. Opened from the task kebab and from the Leader pill's flyout.
 *
 * Candidates come from the browser's task store (adopt-candidates.ts: never the
 * leader, its ancestors, its team, or finished work), newest first, filtered by
 * the box at the top. A pick is the store's own `reparentTask`, the same
 * optimistic write a drag onto the leader makes, so every pill on the page
 * follows in the same frame.
 *
 * Overlay rules (web/src/AGENTS.md): placed by useMenuPlacement, portalled to
 * <body>, root stops pointerdown (task rows are dnd-kit draggables), and a host
 * menu's outside-click closer must exempt `.adopt-worker-flyout`.
 */
export function AdoptWorkerFlyout({ open, anchorRef, anchorPoint, align, leader, onClose, onPicked }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  /** Anchor at a viewport point instead (keep it in state: it is a hook dep). */
  anchorPoint?: { x: number; y: number } | null;
  align?: 'right' | 'left' | 'center' | 'start';
  leader: Pick<Task, 'id' | 'title'>;
  /** Fired after a pick and on every dismiss (outside click, Escape, lost anchor). */
  onClose: () => void;
  /** A pick landed (before onClose): a host menu closes itself too. */
  onPicked?: (worker: Task) => void;
}) {
  const store = useTasksContextSafe();
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, rootRef, {
    minHeight: 200,
    align,
    anchorPoint,
    onAnchorLost: onClose,
  });

  useEffect(() => {
    if (!open) { setFilter(''); setActive(0); setError(null); }
  }, [open]);

  const tasks = store?.tasks;
  const candidates = useMemo(
    () => (open && tasks ? adoptCandidates(tasks, leader.id, filter) : []),
    [open, tasks, leader.id, filter],
  );
  const byId = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t] as const)), [tasks]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.adopt-worker-flyout')) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Ours alone: a host menu under this flyout stays open.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  const shown = candidates.slice(0, SHOWN_ROWS);
  const pick = (candidate: Task) => {
    if (!store) { setError('The task list is not loaded here.'); return; }
    // The store may have moved on since the list rendered (another tab adopted it).
    if (!adoptCandidates(store.tasks, leader.id).some((t) => t.id === candidate.id)) {
      setError(`“${candidate.title}” can no longer join this team.`);
      return;
    }
    log.info('tasks', 'worker adopted', { leaderTaskId: leader.id, workerTaskId: candidate.id, previousLeader: candidate.parent_task_id ?? '' });
    store.reparentTask(candidate.id, leader.id);
    onPicked?.(candidate);
    onClose();
  };
  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(shown.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const target = shown[Math.min(active, shown.length - 1)];
      if (target) pick(target);
    }
  };

  return createPortal(
    <div
      ref={rootRef}
      className="adopt-worker-flyout"
      role="dialog"
      aria-label={`Adopt a worker for ${leader.title}`}
      data-testid="adopt-worker-flyout"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="adopt-worker-title">Adopt a worker for &ldquo;{leader.title}&rdquo;</div>
      <input
        className="adopt-worker-filter"
        placeholder="Filter tasks…"
        value={filter}
        onChange={(e) => { setFilter(e.target.value); setActive(0); setError(null); }}
        onKeyDown={onFilterKey}
        aria-label="Filter tasks"
        autoFocus
      />
      {error && <div className="adopt-worker-error" role="alert">{error}</div>}
      {!store && <div className="adopt-worker-empty">The task list is not loaded here.</div>}
      {store && shown.length === 0 && (
        <div className="adopt-worker-empty">{filter.trim() ? 'No matching open task' : 'No open task to adopt'}</div>
      )}
      <ul className="adopt-worker-list" role="listbox">
        {shown.map((t, i) => {
          const currentLeader = resolveParent(store?.tasks ?? [], byId, t.parent_task_id);
          return (
            <li key={t.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`adopt-worker-row${i === active ? ' is-active' : ''}`}
                data-testid="adopt-worker-row"
                data-task-id={t.id}
                title={`Make "${t.title}" a worker of "${leader.title}"`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(t)}
              >
                <span className="adopt-worker-row-title">{t.title}</span>
                <span className="adopt-worker-row-meta">
                  {t.project || 'Inbox'}
                  {currentLeader ? ` · Worker of ${currentLeader.title}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {candidates.length > shown.length && (
        <div className="adopt-worker-more">Showing {shown.length} of {candidates.length}. Type to narrow.</div>
      )}
    </div>,
    document.body,
  );
}
