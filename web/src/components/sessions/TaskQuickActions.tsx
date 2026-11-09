/**
 * TaskQuickActions — phase badge (inline) + kebab "⋮" menu for task actions.
 *
 * Used in session panels to show task status and actions.
 * Phase badge stays visible; pin, dates, project, source (and priority, when
 * Settings shows it) are consolidated into the kebab dropdown.
 */

import { useState, useEffect, useRef, useCallback, lazy, Suspense, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskPhase, TaskPriority } from '@open-walnut/core';
import { deleteTask, fetchTask, updateTask } from '@/api/tasks';
import { createPhaseWriter } from './task-phase-write';
import { useEvent } from '@/hooks/useWebSocket';
import * as ICONS from '@/components/common/Icons';
import { resolveTaskSessionId, taskCircleClass, taskStatusLabel, taskUserState } from '@/utils/session-status';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useIdleCompactingSession } from '@/stores/idle-compacting-store';
import { NEEDS_CATEGORY_LABELS, needsLineOf } from '@open-walnut/user-status';
import type { FocusTier } from '@/api/focus';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { keepNativeContextMenu } from '@/utils/context-menu';
import { useStoreTask, useTasksContextSafe } from '@/contexts/TasksContext';
import { useTaskUndo } from '@/undo/TaskUndoContext';
import { AgentMemoryPanel } from '@/components/org/AgentMemoryPanel';
import { TaskMenuRows } from '@/components/tasks/TaskMenuRows';
import { KebabIcon } from '@/components/tasks/KebabIcon';
import { rowAnchorOf, scrollMovedRow, type RowAnchor } from '@/utils/cursor-menu-scroll';

/** The task's detail, loaded when it opens: it brings the notes editor, and every composer has these actions. */
const OutsideTaskDetail = lazy(() => import('@/components/tasks/OutsideTaskDetail').then((m) => ({ default: m.OutsideTaskDetail })));

/* ── Phase constants ─────────────────────────────────────────────── */

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: '○',
  IN_PROGRESS: '◐',
  NEED_ACTION: '✓',
  COMPLETE: '✓✓',
};

/** The task's status as the user reads it (taskStatusLabel: Needs you, Working, Waiting, Not
 *  started, Completed); one with only a result to read names what to do with it, the category of
 *  its Needs you line (2026-11-02; Icons.tsx binaryPhaseIcon). */
function quickPhaseLabel(task: Task): string {
  if (taskUserState(task) === 'read') { const line = task.user_status ? needsLineOf(task.user_status) : null; return NEEDS_CATEGORY_LABELS[line?.category ?? 'look']; }
  return taskStatusLabel(task);
}


/* ── Component ───────────────────────────────────────────────────── */

interface TaskQuickActionsProps {
  /** Task this menu acts on. Optional: a task-less session still gets a kebab
   *  when `extraSection` is supplied (Session actions only). */
  taskId?: string;
  /** If parent already has the task, pass it to avoid an extra fetch. */
  task?: Task | null;
  /** Pin/unpin/tier callbacks (from session panel). */
  isPinned?: boolean;
  pinnedTier?: FocusTier;
  onPinTask?: (id: string) => void;
  onUnpinTask?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  /** Icon-only phase button (hides the phase label text). */
  compact?: boolean;
  /** Which sub-element(s) to render. 'all' (default) = phase + kebab; 'phase' or 'kebab' = only that part. */
  slot?: 'all' | 'phase' | 'kebab';
  /** The phone's short menu (N12): leading rows, Task detail and Status only. */
  phoneMenu?: boolean;
  /**
   * Extra content appended to the bottom of the kebab dropdown, below a divider
   * (e.g. session-panel's "Session" actions). Receives `close` so items can
   * dismiss the dropdown. When provided, the kebab renders even for a task-less
   * session so those actions stay reachable.
   */
  extraSection?: (close: () => void) => ReactNode;
  /**
   * Content at the very TOP of the kebab, above the task rows and its own divider:
   * the controls of the surface itself (the session strip's panel count), which a
   * person reaches for constantly and should find before any task or session action.
   */
  leadingSection?: (close: () => void) => ReactNode;
  /** Open the task's full-screen detail modal (same one the home task panel opens). */
  onOpenTaskDetail?: (taskId: string) => void;
  /**
   * CSS selector of an ancestor whose RIGHT-CLICK opens this kebab at the cursor
   * (e.g. '.session-panel-header'). Opt-in per call site, because a blanket
   * listener would fight the one TaskKebabMenu already installs on task rows.
   * Same pattern and same exemptions as that one: an editable target keeps the
   * native menu, and only the innermost matching ancestor owns the gesture.
   */
  contextMenuScope?: string;
  /**
   * The person just completed this task from this control (the ring, or the status menu's
   * Complete). Fired once the shared store has applied it (which rolls itself back on a
   * refusal), or, with no store row, once the server accepted the write; `from` is the phase
   * it left. A session column uses it to close itself.
   */
  /** `title`: the task's title, for a toast the board's list cannot name yet (a slow first load). */
  onCompleted?: (info: { taskId: string; from: TaskPhase; title?: string }) => void;
}

export function TaskQuickActions({ taskId, task: externalTask, isPinned, pinnedTier, onPinTask, onUnpinTask, onSetTier, compact, slot = 'all', phoneMenu = false, extraSection, leadingSection, onOpenTaskDetail, contextMenuScope, onCompleted }: TaskQuickActionsProps) {
  // The board's copy first: a caller that passes no task (a bound draft's header) draws its kebab
  // from the store in the first frame instead of after a GET (2026-11-04, "the data is cache").
  const storeTask = useStoreTask(externalTask === undefined ? taskId : undefined);
  const [task, setTask] = useState<Task | null>(externalTask ?? storeTask ?? null);
  // Writes go through the shared task store when it carries this row: the
  // optimistic change then reaches the board, the detail pane and the parent
  // session header in the same frame, and the store owns the REST call, the
  // echo guard and the error banner. The direct REST path below stays for a
  // task the list does not have (or no store at all: pop-out windows).
  const store = useTasksContextSafe();
  const taskUndo = useTaskUndo();
  const storeFor = useCallback((id: string) => (
    store && store.tasks.some((t) => t.id === id) ? store : null
  ), [store]);
  // The phase menu's own writes (no shared store): the latest pick per task wins.
  const [writePhase] = useState(() => createPhaseWriter());
  const [kebabOpen, setKebabOpen] = useState(false);
  // Main's, a lead's or a VP's "Memory & instructions" (opened from the row below Task detail).
  const [memoryOpen, setMemoryOpen] = useState(false);
  // The task's details where the host has no detail pane of its own (an Org node's chat).
  const [detailOpen, setDetailOpen] = useState(false);
  /** Set only by the right-click path, which anchors the menu at the cursor. */
  const [cursorAnchor, setCursorAnchor] = useState<{ x: number; y: number } | null>(null);
  const kebabBtnRef = useRef<HTMLButtonElement>(null);
  const kebabMenuRef = useRef<HTMLDivElement>(null);
  /** The menu goes away by itself (a press elsewhere, a scroll): the caret is wherever that left it. */
  const dismissKebab = useCallback(() => { setKebabOpen(false); setCursorAnchor(null); }, []);
  const closeKebab = useCallback(() => {
    dismissKebab();
    // An action whose row went with the menu leaves the caret nowhere: it goes back to the
    // button the menu came from, so the keys still act on this column (a snooze, a pin).
    requestAnimationFrame(() => {
      const btn = kebabBtnRef.current;
      const nowhere = !document.activeElement || document.activeElement === document.body;
      if (nowhere && btn?.isConnected) btn.focus({ preventScroll: true });
    });
  }, [dismissKebab]);
  /** The right-clicked header and where it sat when the menu opened (cursor-menu-scroll.ts). */
  const scopeAnchor = useRef<RowAnchor | null>(null);
  // Measured placement — this menu is the tallest in the app (task actions +
  // an inline date picker + the Session section), so its height must never be
  // guessed. See useMenuPlacement for why.
  const kebabPos = useMenuPlacement(kebabOpen, kebabBtnRef, kebabMenuRef, {
    anchorPoint: cursorAnchor,
    // The row can be filtered out or re-rendered away while the menu is open;
    // without this the menu is stranded off-screen with no way back.
    onAnchorLost: dismissKebab,
  });

  // Right-click anywhere on the opted-in ancestor opens this kebab at the cursor.
  // The header of a session panel is an app object, not a document, so the
  // browser's menu ("Back / Reload / Inspect Element" in the Mac app) is replaced
  // by the actions that panel actually has.
  useEffect(() => {
    if (!contextMenuScope || slot === 'phase') return;
    const scope = kebabBtnRef.current?.closest<HTMLElement>(contextMenuScope);
    if (!scope) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      // Editable targets (the inline title editor) and a live text selection keep
      // the native menu — the shared rules, so every surface behaves the same.
      const selection = window.getSelection();
      if (keepNativeContextMenu(target, {
        selectionText: selection && !selection.isCollapsed ? selection.toString() : '',
        selectionAnchor: selection?.anchorNode ?? null,
        scope,
      })) return;
      if (target.closest(contextMenuScope) !== scope) return;
      e.preventDefault();
      scopeAnchor.current = rowAnchorOf(scope);
      setCursorAnchor({ x: e.clientX, y: e.clientY });
      setKebabOpen(true);
    };
    scope.addEventListener('contextmenu', handleContextMenu);
    return () => scope.removeEventListener('contextmenu', handleContextMenu);
  }, [contextMenuScope, slot]);

  // Fetch the task only when neither the caller nor the board has it (a task the store does not
  // hold, a store still loading); the store follows the task's events, so its copy is current.
  const haveStoreTask = !!storeTask;
  useEffect(() => {
    if (externalTask !== undefined) { setTask(externalTask ?? null); return; }
    if (!taskId) { setTask(null); return; }
    if (storeTask) { setTask(storeTask); return; }
    setTask(null);
    fetchTask(taskId).then(setTask).catch((err) => {
      console.error('[TaskQuickActions] Failed to fetch task:', err);
    });
    // storeTask rides in for its value; a refetch only when the store gains or loses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, externalTask, haveStoreTask]);
  useEffect(() => {
    if (externalTask === undefined && storeTask) setTask(storeTask);
  }, [externalTask, storeTask]);

  // Keep in sync via WS events
  useEvent('task:updated', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });
  useEvent('task:completed', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });

  // Close kebab on outside click, Escape, or once the trigger scrolls away.
  // The menu now scrolls internally, so a scroll event originating INSIDE it
  // must not dismiss it — and an outside scroll only closes the menu when the
  // trigger actually leaves the viewport (useMenuPlacement repositions
  // otherwise). A blanket close-on-scroll would fire in the same tick as the
  // opening click whenever that click scrolls the row into view — the failure
  // documented at length in TaskBatchMenu.tsx.
  // Kept in the component rather than in useMenuPlacement because dismissal is a
  // product decision (TaskKebabMenu's right-click path closes on ANY outside
  // scroll), while the hook only owns geometry. Mirror changes in
  // TaskKebabMenu.tsx, which runs the same rules plus a cursor-anchor branch.
  useEffect(() => {
    if (!kebabOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (kebabBtnRef.current?.contains(e.target as Node)) return;
      if (kebabMenuRef.current?.contains(e.target as Node)) return;
      // The Project picker's list and the Adopt a worker picker are their own portals.
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout, .adopt-worker-flyout')) return;
      dismissKebab();
    };
    // The menu's Esc is its own: taken in the capture phase and consumed, so the layer under it
    // (full screen, a Board peek tab) stays open (one Esc closes one layer).
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      // A worker picker opened from the menu (Adopt, Release) is the layer on top and takes its own
      // Esc (its capture listener): the menu stays. The menu's other pickers (Project, a plugin
      // field) keep no Esc of their own, so one Esc closes them with the menu, as before.
      if (document.querySelector('.adopt-worker-flyout')) return;
      e.preventDefault();
      e.stopPropagation();
      closeKebab();
    };
    const handleScroll = (e: Event) => {
      if (kebabMenuRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout, .adopt-worker-flyout')) return;
      // A cursor anchor is a frozen viewport point: close once a scroll moved what
      // was right-clicked away from under it (the button path instead follows its
      // trigger — see the comment above).
      if (cursorAnchor) { if (scrollMovedRow(scopeAnchor.current, e.target)) dismissKebab(); return; }
      const r = kebabBtnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) dismissKebab();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey, true);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey, true);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [kebabOpen, closeKebab, dismissKebab, cursorAnchor]);

  const handlePhaseChange = useCallback((phase: string, ring = false) => {
    if (!task || task.phase === phase) return;
    const now = new Date().toISOString();
    const completing = phase === 'COMPLETE';
    setTask(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        phase: phase as TaskPhase,
        status: completing ? 'done' as const : phase === 'TODO' || phase === 'WAITING' ? 'todo' as const : 'in_progress' as const,
        // wait_until belongs to WAITING alone (server applyPhase).
        ...(phase === 'WAITING' ? {} : { wait_until: undefined }),
        ...(completing ? { completed_at: now, session_id: undefined, plan_session_id: undefined, exec_session_id: undefined, session_status: undefined, plan_session_status: undefined, exec_session_status: undefined, unread: undefined } : {}),
        updated_at: now,
      };
    });
    const id = task.id;
    // A column's own completion before the board's first list has come (a slow load): the
    // store takes it all the same and holds the phase over the row when the list brings it, so
    // the column closes at once and a refusal still gives it back. The direct path below waited
    // for the server, so a late refusal kept the column, and a list answer read before the
    // click put the old phase back under the ring and kept the column too (2026-11-09).
    const shared = storeFor(id) ?? (completing && onCompleted && store?.loading ? store : null);
    if (shared) {
      // A column's own completion takes its Undo from the column (useColumnCompleteClose);
      // anywhere else a complete or reopen takes the plain one.
      if (completing && onCompleted) {
        shared.setPhase(id, phase, { row: task });
        onCompleted({ taskId: id, from: task.phase, title: task.title });
      } else if (taskUndo) taskUndo.setPhase(id, phase, ring ? { ring } : undefined);
      else shared.setPhase(id, phase);
      return;
    }
    // Nothing rolls back the store here, so the host hears about the completion only once the
    // server has taken it: a refused write must never cost the person their column.
    // One op id for every attempt, 2 s apart (task-phase-write.ts): a 504 that reached the Mac,
    // or an answer that may be journaled, is never sent again and is shown; a newer pick drops
    // this one's retries.
    const from = task.phase;
    const title = task.title;
    void writePhase(id, phase, {
      done: () => { if (completing) onCompleted?.({ taskId: id, from, title }); },
      resync: () => { fetchTask(id).then(setTask).catch(() => {}); },
      showError: (message) => store?.showOperationError(message),
    });
  }, [task, storeFor, store, writePhase, onCompleted, taskUndo]);

  // The status control's "Until" row. Same split as the other writes: this
  // menu's own copy at once, then the shared store when it carries the row.
  const handleSetWaitUntil = useCallback((id: string, waitUntil: string) => {
    setTask(prev => (prev && prev.id === id
      ? { ...prev, phase: 'WAITING' as TaskPhase, status: 'todo' as const, wait_until: waitUntil || undefined }
      : prev));
    const shared = storeFor(id);
    if (shared) { shared.update(id, { phase: 'WAITING', wait_until: waitUntil }); return; }
    updateTask(id, { phase: 'WAITING', wait_until: waitUntil }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
  }, [storeFor]);

  const handleSetPriority = useCallback((priority: TaskPriority) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, priority } : prev);
    const shared = storeFor(id);
    if (shared) shared.update(id, { priority });
    else updateTask(id, { priority }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab, storeFor]);

  const handleSetDate = useCallback((date: string | null) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, due_date: date ?? undefined } : prev);
    const shared = storeFor(id);
    if (shared) shared.update(id, { due_date: date ?? '' });
    else updateTask(id, { due_date: date ?? '' }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab, storeFor]);

  const handleSetStartDate = useCallback((date: string | null) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, start_date: date ?? undefined } : prev);
    const shared = storeFor(id);
    if (shared) {
      if (taskUndo) taskUndo.setStartDate(id, date); else shared.update(id, { start_date: date ?? '' });
    } else updateTask(id, { start_date: date ?? '' }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab, storeFor, taskUndo]);

  // Kebab "Project" select. Through the store this is the same move the board
  // kebab makes (project flip + reorder into the destination group).
  const handleMoveToProject = useCallback((project: string) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, project } : prev);
    const shared = storeFor(id);
    if (shared) shared.moveTask(id, project);
    else updateTask(id, { project }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab, storeFor]);

  // Delete: the store's path when it carries the row (it shows a refusal, a live session's
  // 409 included), else a plain DELETE, so a menu off the board deletes as the board's does.
  const handleDelete = useCallback((id: string) => {
    // Its delete is already held (the list hid it): one DELETE goes out, at the end of its Undo.
    if (taskUndo?.isDeleteHeld(id)) return;
    const shared = storeFor(id);
    if (shared) {
      if (taskUndo) taskUndo.deleteTask(id); else void shared.deleteTask(id);
      return;
    }
    deleteTask(id).catch((err) => store?.showOperationError(`Could not delete the task: ${String(err)}`));
  }, [storeFor, store, taskUndo]);

  const handleKebabToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCursorAnchor(null);   // button path anchors to the button, not a cursor
    setKebabOpen(!kebabOpen);
  };

  // The live status, as the task lists read it: the task's own snapshot can still say running from
  // when its session started (2026-11-05 review: a new task's header circle pulsed while idle).
  // Hooks, so before the return below.
  const circleSessionId = task ? resolveTaskSessionId(task) : null;
  const circleStatus = useSessionStatus(circleSessionId);
  useIdleCompactingSession(circleSessionId);

  // A task-less session still shows the kebab when it carries a Session section.
  if (!task && !(slot !== 'phase' && extraSection)) return null;

  const isDone = task?.status === 'done' || task?.phase === 'COMPLETE';

  return (
    <div className="task-quick-actions">
      {/* Phase badge — one click toggles open ↔ Completed */}
      {slot !== 'kebab' && task && (
      <div className="task-quick-phase">
        <button
          className={`task-quick-phase-btn ${taskCircleClass(task, circleStatus)}`}
          onClick={(e) => {
            e.stopPropagation();
            handlePhaseChange(isDone ? 'TODO' : 'COMPLETE', true);
          }}
          title={isDone ? 'Done — click to reopen' : 'Click to complete'}
          // An icon alone (a narrow column) still says what it does.
          aria-label={compact ? (isDone ? 'Reopen the task' : 'Complete the task') : undefined}
        >
          <span className="task-quick-phase-icon">{ICONS.binaryPhaseIcon(isDone, task.phase, taskUserState(task))}</span>
          {!compact && <span className="task-quick-phase-label">{quickPhaseLabel(task)}</span>}
        </button>
      </div>
      )}

      {/* Kebab menu button */}
      {slot !== 'phase' && (
      <button
        ref={kebabBtnRef}
        className="task-kebab-btn"
        onClick={handleKebabToggle}
        title="More actions"
        aria-label="More actions"
        style={{ opacity: 1 }}
      >
        <KebabIcon />
      </button>
      )}
      {/* Portalled to <body> deliberately. `position: fixed` escapes CLIPPING
          ancestors but NOT stacking contexts, and this menu's home is inside
          .session-panel-header (position:absolute, z-index:30). Its own
          z-index:9999 only orders it WITHIN that context, so the whole subtree
          competed as 30 and the composer overlay of the time (.session-panel-input,
          then z-index:40) drew over it, the menu rendered fine, just underneath.
          Raising the number would only lose to the next overlay; leaving the
          context is the fix.
          Same reason ViewDropdown/TaskDetailModal portal. */}
      {slot !== 'phase' && kebabOpen && createPortal(
        <div
          ref={kebabMenuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(kebabPos)}
        >
          {/* The surface's own controls first (the panel count), then the task. */}
          {leadingSection && (
            <>
              {leadingSection(closeKebab)}
              {(task || extraSection) && <div className="task-kebab-divider" />}
            </>
          )}
          {/* The task's rows: one definition for every task menu (TaskMenuRows). Only the
              surface's own controls (above) and the Session group (below) are this menu's. */}
          {task && (
            <TaskMenuRows
              task={task}
              isPinned={Boolean(isPinned)}
              pinnedTier={pinnedTier}
              isDone={isDone}
              close={closeKebab}
              phoneMenu={phoneMenu}
              onSetStartDate={handleSetStartDate}
              onSetDate={handleSetDate}
              onSetPhase={(_id, phase) => handlePhaseChange(phase)}
              onSetWaitUntil={handleSetWaitUntil}
              onSetPriority={(pr) => handleSetPriority(pr as TaskPriority)}
              onPinTask={onPinTask ? () => onPinTask(task.id) : undefined}
              onUnpinTask={onUnpinTask ? () => onUnpinTask(task.id) : undefined}
              onSetTier={onSetTier ? (t) => onSetTier(task.id, t) : undefined}
              onMoveToProject={handleMoveToProject}
              detail={{ onToggle: () => (onOpenTaskDetail ? onOpenTaskDetail(task.id) : setDetailOpen(true)) }}
              onOpenMemory={() => setMemoryOpen(true)}
              onDelete={() => handleDelete(task.id)}
            />
          )}

          {/* Session section — appended below the task actions, or shown alone
              for a task-less session. */}
          {extraSection && (
            <>
              {task && <div className="task-kebab-divider" />}
              {extraSection(closeKebab)}
            </>
          )}
        </div>,
        document.body,
      )}
      {memoryOpen && task && <AgentMemoryPanel task={task} onClose={() => setMemoryOpen(false)} />}
      {detailOpen && task && <Suspense fallback={null}><OutsideTaskDetail task={task} onClose={() => setDetailOpen(false)} /></Suspense>}
    </div>
  );
}
