import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { binaryPhaseIcon } from '@/components/common/Icons';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { locateTaskOnHome } from '@/utils/open-session';
import { PHASE_LABELS, resolveTaskSessionId, taskCircleClass } from '@/utils/session-status';
import { AdoptWorkerFlyout } from './AdoptWorkerFlyout';
import { doneSubtaskCount, leaderPillTitle, openSubtasksOf, subtaskPlaceLabel } from './subtask-index';
import '@/styles/subtask-pill.css';

/**
 * "Leader · N" pill: this task has subtasks still open, and the pill lists them.
 * N counts the OPEN ones only, and the flyout lists only those: a finished
 * subtask is history, not work the leader is waiting on (2026-10-01: a leader
 * read `Leader · 8` and listed all eight while most were done). No open
 * subtask, no pill.
 *
 * The twin of the Sub pill (SubtaskPill.tsx). The board nests a subtask under
 * its leader only inside one project, and the pinned tiers show every task as
 * a flat card, so a leader whose work went to another project (or is pinned)
 * had nothing but a count. The flyout lists every open subtask, wherever it
 * lives (its project named when it is not the leader's), with its phase; a row is
 * the same locate a Sub pill does, so the user can walk the whole team from
 * the leader's row.
 *
 * Overlay rules (web/src/AGENTS.md): placed by useMenuPlacement, portalled to
 * <body>, root stops pointerdown propagation (the rows are dnd-kit draggables),
 * outside-click closer exempts `.leader-subtasks-flyout`. The list's last row,
 * "Adopt a task…", swaps it for the AdoptWorkerFlyout on the same pill.
 */
export function LeaderPill({ task, className }: { task: Task; className?: string }) {
  const navigate = useNavigate();
  const store = useTasksContextSafe();
  const [open, setOpen] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, triggerRef, menuRef, {
    align: 'start',
    preferSide: 'down',
    minHeight: 120,
    onAnchorLost: () => setOpen(false),
  });

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const subtasks = store ? openSubtasksOf(store.tasks, task.id) : [];
  const done = store ? doneSubtaskCount(store.tasks, task.id) : 0;

  // The last open subtask finished, deleted or re-parented while the flyout is
  // open takes the pill with it.
  useEffect(() => {
    if (open && subtasks.length === 0) setOpen(false);
  }, [open, subtasks.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (target.closest('.leader-subtasks-flyout')) return;
      if (triggerRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (subtasks.length === 0) return null;

  const goTo = (sub: Task) => {
    close(false);
    const sid = resolveTaskSessionId(sub);
    locateTaskOnHome(sub.id, navigate, sid ? { sessionId: sid } : undefined);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`task-team-pill todo-item-leader-pill${className ? ` ${className}` : ''}`}
        title={leaderPillTitle(subtasks, done)}
        aria-label={open ? 'Leads subtasks. Hide them' : 'Leads subtasks. List them'}
        aria-haspopup="dialog"
        aria-expanded={open || adoptOpen}
        data-testid="leader-pill"
        data-subtask-count={subtasks.length}
        // A narrow session header shows this letter instead of the words (CSS only;
        // the text stays for readers and tests); the count rides in the hover text.
        data-short="L"
        onPointerDown={(e) => e.stopPropagation()}
        // WebKit never focuses a button on click, so the mousedown would focus the
        // row around the pill, which scrolls itself into view before mouseup and
        // the click lands on whatever moved under the pointer (same trap as the
        // TRIGGER pill). Keyboard focus is unaffected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // An open picker is this pill's too: a click on the pill closes it.
          if (adoptOpen) { setAdoptOpen(false); return; }
          setOpen((v) => !v);
        }}
      >
        <span className="task-pill-long">Leader · {subtasks.length}</span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="leader-subtasks-flyout"
              role="dialog"
              aria-label="Subtasks of this task"
              data-testid="leader-subtasks-flyout"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="leader-subtasks-title">
                {subtasks.length === 1 ? 'Open subtask' : `${subtasks.length} open subtasks`} of &ldquo;{task.title}&rdquo;
              </div>
              <ul className="leader-subtasks-list">
                {subtasks.map((sub) => {
                  const place = subtaskPlaceLabel(sub, task.project);
                  return (
                    <li key={sub.id}>
                      <button
                        type="button"
                        className="leader-sub-row"
                        data-testid="leader-sub-row"
                        data-task-id={sub.id}
                        title={`Go to "${sub.title}"`}
                        onClick={() => goTo(sub)}
                      >
                        <span className={`task-phase-icon-btn leader-sub-phase ${taskCircleClass(sub, null)}`} aria-hidden="true">
                          {binaryPhaseIcon(false, sub.phase)}
                        </span>
                        <span className="leader-sub-title">{sub.title}</span>
                        {place && <span className="leader-sub-place" title={`In project ${place}`}>{place}</span>}
                        <span className="leader-sub-phase-label">{PHASE_LABELS[sub.phase] ?? sub.phase}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="leader-adopt-row">
                <button
                  type="button"
                  className="leader-sub-row"
                  data-testid="leader-adopt"
                  title={`Make another open task a worker of "${task.title}"`}
                  onClick={() => { close(false); setAdoptOpen(true); }}
                >
                  <span className="leader-sub-title">Adopt a task…</span>
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
      <AdoptWorkerFlyout
        open={adoptOpen}
        anchorRef={triggerRef}
        align="start"
        leader={task}
        onClose={() => setAdoptOpen(false)}
      />
    </>
  );
}
