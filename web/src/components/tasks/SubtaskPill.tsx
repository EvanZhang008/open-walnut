import { resolveTaskToken, subscribeEntityLabels, getEntityLabelsVersion } from '@/stores/entity-label-store';
import { matchParentRef } from '../../../../src/lib/id-ref';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { binaryPhaseIcon } from '@/components/common/Icons';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useKeyboardOpenFocus } from '@/hooks/useKeyboardOpenFocus';
import { useOpenTask } from '@/hooks/useOpenTask';
import { resolveTaskSessionId, taskCircleClass, taskStatusLabel, taskUserState } from '@/utils/session-status';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { openSubtasksOf, subtaskPlaceLabel } from './subtask-index';
import { leaderWord } from './team-menu-model';
import '@/styles/subtask-pill.css';

/**
 * "Worker" pill: this task is a subtask (it has a parent_task_id), a worker of its
 * leader. (It read "Sub" until the Board made the pair a team: a leader and its
 * workers share one board.)
 *
 * Work a session files is that session's subtask wherever it lands (see
 * caller-placement.ts): beside it, in another project, or from a Personal AI
 * conversation. The main list indents a subtask under its parent only inside one
 * project; everywhere else (the pinned tiers show every task as a flat card, a
 * subtask in another project is a top-level row there) the pill is the only sign.
 *
 * A click opens the team, not the leader (2026-11-03, the user: "worker when click
 * should not directly jump, should show a list of leader and all worker"): the
 * leader first, then every open worker of that leader, this one marked; a row is
 * the same locate a chat task reference does. The flyout is the Leader pill's
 * (LeaderPill.tsx), with the same overlay rules (web/src/AGENTS.md): placed by
 * useMenuPlacement, portalled to <body>, its root stops pointerdown (the rows are
 * dnd-kit draggables), Escape and an outside click close it.
 */
export function subtaskPillTitle(parentTitle: string | undefined): string {
  return parentTitle
    ? `Worker of "${parentTitle}". Click to see its team.`
    : 'Worker of another task. Click to see its team.';
}

export function SubtaskPill({ task, className }: { task: { id?: string; parent_task_id?: string }; className?: string }) {
  const openTask = useOpenTask();
  const store = useTasksContextSafe();
  useSyncExternalStore(subscribeEntityLabels, getEntityLabelsVersion, getEntityLabelsVersion);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const markOpen = useKeyboardOpenFocus(open, menuRef);
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

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    // Capture phase: every pill on a row stops its own pointerdown (see LeaderPill.tsx).
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  const parentId = task.parent_task_id;
  if (!parentId) return null;
  // parent_task_id may be a short prefix (legacy data): the store's rule everywhere.
  const parent = (store ? matchParentRef(store.tasks, { id: task.id ?? '', parent_task_id: parentId }) : undefined) ?? null;
  const resolved = !parent ? resolveTaskToken(parentId) : undefined;
  const parentTitle = parent ? orgDisplayTitle(parent) : resolved?.label.title;
  const leaderId = parent?.id ?? resolved?.id ?? parentId;
  // The team is read only while the list is open: a board draws this pill on every worker row.
  const workers = open && store ? openSubtasksOf(store.tasks, leaderId) : [];
  const self = open && task.id ? store?.tasks.find((t) => t.id === task.id) : undefined;
  // A finished worker is not in its leader's open list, but its own pill still lists it.
  const team = self && !workers.some((w) => w.id === self.id) ? [self, ...workers] : workers;

  const goTo = (id: string, t: Task | null | undefined) => {
    close(false);
    const sid = t ? resolveTaskSessionId(t) : null;
    openTask(id, sid ? { sessionId: sid } : undefined);
  };

  const row = (t: Task, role: 'leader' | 'worker') => {
    const isSelf = t.id === task.id;
    const place = role === 'worker' && parent ? subtaskPlaceLabel(t, parent.project) : null;
    return (
      <button
        type="button"
        className={`leader-sub-row${isSelf ? ' is-self' : ''}`}
        data-testid={role === 'leader' ? 'worker-team-leader' : 'worker-team-row'}
        data-peek-row="" data-task-id={t.id}
        aria-current={isSelf ? 'true' : undefined}
        title={`Go to "${orgDisplayTitle(t)}"`}
        onClick={() => goTo(t.id, t)}
      >
        <span className={`task-phase-icon-btn leader-sub-phase ${taskCircleClass(t, null)}`} aria-hidden="true">
          {binaryPhaseIcon(false, t.phase, taskUserState(t))}
        </span>
        <span className="leader-sub-title">{orgDisplayTitle(t)}</span>
        {place && <span className="leader-sub-place" title={`In project ${place}`}>{place}</span>}
        <span className="leader-sub-phase-label">
          {role === 'leader' ? leaderWord(t) : isSelf ? 'This task' : taskStatusLabel(t)}
        </span>
      </button>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`task-team-pill task-row-pill todo-item-subtask-pill${className ? ` ${className}` : ''}`}
        title={subtaskPillTitle(parentTitle)}
        aria-label="Worker"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="subtask-pill"
        data-parent-task-id={leaderId}
        // A narrow task column shows this letter instead of the word (CSS only; the
        // text stays for readers and tests).
        data-short="W"
        onPointerDown={(e) => e.stopPropagation()}
        // WebKit never focuses a button on click, so the mousedown would focus the row
        // around the pill, which scrolls itself into view before mouseup (the Leader
        // pill's trap). Keyboard focus is unaffected.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          // The pill sits inside a clickable, draggable row: this click is the pill's alone.
          e.preventDefault();
          e.stopPropagation();
          markOpen(e);
          setOpen((v) => !v);
        }}
      >
        <span className="task-pill-long">Worker</span>
        {parentTitle && <span className="task-worker-parent" data-testid="worker-parent-title">{parentTitle}</span>}
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="leader-subtasks-flyout worker-team-flyout"
              role="dialog"
              aria-label="This task's team"
              data-testid="worker-team-flyout"
              style={menuPlacementStyle(placement)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="leader-subtasks-title">Team</div>
              <ul className="leader-subtasks-list">
                <li className="leader-sub-item">
                  {parent ? row(parent, 'leader') : (
                    <button type="button" className="leader-sub-row" data-testid="worker-team-leader" data-task-id={leaderId} onClick={() => goTo(leaderId, null)}>
                      <span className="leader-sub-title">{parentTitle ?? 'The leader task'}</span>
                      <span className="leader-sub-phase-label">Leader</span>
                    </button>
                  )}
                </li>
              </ul>
              {team.length > 0 && (
                <>
                  <div className="leader-subtasks-title">
                    {team.length === 1 ? 'Worker' : `${team.length} workers`}
                  </div>
                  <ul className="leader-subtasks-list">
                    {team.map((w) => <li key={w.id} className="leader-sub-item">{row(w, 'worker')}</li>)}
                  </ul>
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
