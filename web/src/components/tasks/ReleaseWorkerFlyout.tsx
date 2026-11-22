import { EmptyState } from '@/components/common/EmptyState';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { log } from '@/utils/log';
import { taskStatusLabel } from '@/utils/session-status';
import { subtaskPlaceLabel } from './subtask-index';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { RELEASE_FILTER_FROM, releaseCandidates } from './team-menu-model';
import '@/styles/subtask-pill.css';
import { MicInput } from '@/components/common/BoxMic';

/**
 * "Release a worker…": pick one of `leader`'s workers to let go. The worker
 * keeps running and stays where it is (project, folder); only the link to the
 * leader goes, through the store's own `reparentTask(id, null)`, the same write
 * as the worker's "Leave leader", so the pills follow in the same frame.
 *
 * The twin of AdoptWorkerFlyout and dressed in its classes: the root carries
 * `.adopt-worker-flyout` too, so every host menu's outside-click closer that
 * exempts the Adopt picker exempts this one as well. A filter box appears from
 * RELEASE_FILTER_FROM workers on.
 */
export function ReleaseWorkerFlyout({ open, anchorRef, leader, onClose, onPicked }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  leader: Pick<Task, 'id' | 'title' | 'project'>;
  /** Fired after a pick and on every dismiss (outside click, Escape, lost anchor). */
  onClose: () => void;
  /** A worker was released (before onClose): a host menu closes itself too. */
  onPicked?: (worker: Task) => void;
}) {
  const store = useTasksContextSafe();
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, rootRef, { minHeight: 160, onAnchorLost: onClose });

  useEffect(() => {
    if (!open) { setFilter(''); setActive(0); setError(null); }
  }, [open]);

  const tasks = store?.tasks;
  const all = useMemo(() => (open && tasks ? releaseCandidates(tasks, leader.id) : []), [open, tasks, leader.id]);
  const shown = useMemo(
    () => (open && tasks && filter.trim() ? releaseCandidates(tasks, leader.id, filter) : all),
    [open, tasks, leader.id, filter, all],
  );

  // One close policy with every popover (useOverlayLayer): Escape closes only this
  // flyout, so a host menu under it stays open; an outside press closes it.
  useOverlayLayer({ passOutsideClick: true, open, refs: [rootRef, anchorRef], onClose: () => onClose() });

  if (!open || typeof document === 'undefined') return null;

  const pick = (worker: Task) => {
    if (!store) { setError('The task list is not loaded here.'); return; }
    // The store may have moved on since the list rendered (released or moved elsewhere).
    if (!releaseCandidates(store.tasks, leader.id).some((t) => t.id === worker.id)) {
      setError(`“${orgDisplayTitle(worker)}” is no longer a worker of this task.`);
      return;
    }
    log.info('tasks', 'worker released', { leaderTaskId: leader.id, workerTaskId: worker.id });
    store.reparentTask(worker.id, null);
    onPicked?.(worker);
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
      className="adopt-worker-flyout release-worker-flyout wn-overlay wn-menu"
      role="dialog"
      aria-label={`Release a worker of ${orgDisplayTitle(leader)}`}
      data-testid="release-worker-flyout"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="adopt-worker-title wn-title">Release a worker of &ldquo;{orgDisplayTitle(leader)}&rdquo;</div>
      {all.length >= RELEASE_FILTER_FROM && (
        <MicInput fieldClassName="adopt-worker-filter-field mic-field-compact" data-no-draft="search"
          className="adopt-worker-filter is-sm"
          placeholder="Filter workers…"
          value={filter}
          setText={(text) => { setFilter(text); setActive(0); setError(null); }}
          onKeyDown={onFilterKey}
          aria-label="Filter workers"
          autoFocus
        />
      )}
      {error && <div className="adopt-worker-error" role="alert">{error}</div>}
      {shown.length === 0 && (
        <EmptyState size="row" title={filter.trim() ? 'No worker matches “' + filter.trim() + '”' : 'No worker left to release'} />
      )}
      <ul className="adopt-worker-list" role="listbox">
        {shown.map((t, i) => {
          const place = subtaskPlaceLabel(t, leader.project);
          return (
            <li key={t.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`adopt-worker-row${i === active ? ' is-active' : ''}`}
                data-testid="release-worker-row"
                data-peek-row="" data-task-id={t.id}
                title={`Release "${orgDisplayTitle(t)}" from "${orgDisplayTitle(leader)}". It keeps running on its own.`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(t)}
              >
                <span className="adopt-worker-row-title wn-title">{orgDisplayTitle(t)}</span>
                <span className="adopt-worker-row-meta wn-meta">
                  {taskStatusLabel(t)}
                  {place ? ` · ${place}` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}
