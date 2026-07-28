/**
 * TaskKebabMenu — "⋮" dropdown menu for task row actions.
 *
 * Consolidates: source badge, external link, details, priority, star, pin
 * into a single kebab button to reduce visual noise per task row.
 */

import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskPriority } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import * as ICONS from '../common/Icons';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { resolveTaskSessionId } from '@/utils/session-status';
import { DatePicker, formatDateDisplay } from '../common/DatePicker';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';

type TaskListProjection = Task & {
  /** Precomputed by fields=list because that projection intentionally omits ext. */
  has_synced?: boolean;
  /** Legacy MS To-Do sync marker retained for pre-ext task records. */
  ms_todo_id?: string;
};

interface TaskKebabMenuProps {
  task: TaskListProjection;
  isFocused: boolean;
  /** Whether the detail pane is actually visible (not just focused/selected). */
  isDetailOpen?: boolean;
  isPinned: boolean;
  pinnedTier?: FocusTier;
  isDone: boolean;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onSetPriority?: (id: string, priority: string) => void;
  onStar?: (id: string) => void;
  onPinTask?: (id: string) => void;
  onUnpinTask?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  onOpenSession?: (sessionId: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  /** Promote a subtask to top-level (remove parent_task_id). Only shown when task has a parent. */
  onUnparent?: (id: string) => void;
  /** Move task up one slot among its siblings. Pass undefined when task is already first. */
  onMoveUp?: (id: string) => void;
  /** Remove this task from its virtual group. Only shown when task.group_id is set. */
  onUngroup?: (id: string) => void;
  /** True when this task's group is hidden from the Focus area — enables "Unhide group". */
  isGroupHidden?: boolean;
  /** Unhide this task's group back into the Focus area. Only shown when isGroupHidden. */
  onUnhideGroup?: (groupId: string) => void;
  /** Enter multi-select mode with this task picked (to group several tasks). Only on list rows. */
  onStartSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
}

const TIER_OPTIONS: { value: FocusTier; label: string; icon: ReactNode }[] = [
  { value: 'focus', label: 'Focus', icon: ICONS.ICON_TIER_FOCUS },
  { value: 'satellite', label: 'Satellite', icon: ICONS.ICON_TIER_SATELLITE },
  { value: 'wait', label: 'Wait', icon: ICONS.ICON_TIER_WAIT },
];

// Wait is amber (paused/blocked) — the old grey half-circle was indistinguishable
// from Satellite's grey outline at a glance.
const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--fg-muted)',
  wait: 'var(--tier-wait, #ff9f0a)',
};

const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

/**
 * Shared set-priority / pin-to-tier / set-date blocks — the SAME panel rows the
 * per-task kebab shows, reused by the multi-select "Group ▸" batch dropdown so
 * there is one definition of these actions (no drift). In batch mode `task` is
 * null: there is no single current value to highlight, so every option renders
 * un-selected and the callback fans out across the caller's selection.
 */
export function TaskActionMenuItems({
  task, isPinned, pinnedTier, isDone, batchMode,
  onSetPriority, onPinTask, onUnpinTask, onSetTier, onSetDate, afterAction,
}: {
  /** Single task (kebab) — null in batch mode. */
  task: Task | null;
  isPinned: boolean;
  pinnedTier?: FocusTier;
  isDone: boolean;
  /** Batch mode: tier button calls onSetTier(tier) directly (caller fans out pin+tier per task). */
  batchMode?: boolean;
  onSetPriority?: (priority: string) => void;
  onPinTask?: () => void;
  onUnpinTask?: () => void;
  onSetTier?: (tier: FocusTier) => void;
  onSetDate?: (date: string | null) => void;
  /** Close the menu after an action fires. */
  afterAction: () => void;
}) {
  return (
    <>
      {/* Pin / Tier */}
      {(batchMode ? !!onSetTier : !isDone && (onPinTask || isPinned)) && (
        <>
          <div className="task-kebab-divider" />
          {!batchMode && isPinned && onUnpinTask && (
            <button
              className="task-kebab-item"
              onClick={(e) => { e.stopPropagation(); onUnpinTask(); afterAction(); }}
            >
              <span className="task-kebab-icon">{ICONS.ICON_PIN_FILLED}</span>
              <span>Unpin</span>
            </button>
          )}
          <div className="task-kebab-tier">
            <span className="task-kebab-tier-label">{!batchMode && isPinned ? 'Move to' : 'Pin to'}</span>
            <div className="task-kebab-tier-options">
              {TIER_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  className={`task-kebab-tier-btn${!batchMode && pinnedTier === t.value ? ' active' : ''}`}
                  style={{ color: TIER_COLORS[t.value] }}
                  title={t.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (batchMode) {
                      // Caller fans out pin+tier across the whole selection.
                      onSetTier?.(t.value);
                    } else if (isPinned) {
                      if (pinnedTier !== t.value) onSetTier?.(t.value);
                    } else {
                      // Pin first, then set the tier. The 100ms gap is a race guard: the
                      // pin must register (server write + local focus-store update) before
                      // setTier targets it — fired synchronously, setTier hits a task the
                      // focus store doesn't yet know is pinned and the tier is dropped.
                      // (Not a hard guarantee; the proper fix is a pin-with-tier API. This
                      // same pattern is mirrored in TodoPanel.batchPinToTier.)
                      onPinTask?.();
                      setTimeout(() => onSetTier?.(t.value), 100);
                    }
                    afterAction();
                  }}
                >
                  <span className="task-kebab-tier-btn-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Priority */}
      {onSetPriority && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-priority">
            <span className="task-kebab-priority-label">Priority</span>
            <div className="task-kebab-priority-options">
              {PRIORITY_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  className={`badge badge-${p.value}${task && task.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                  title={p.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!task || p.value !== task.priority) onSetPriority(p.value);
                    afterAction();
                  }}
                >
                  {p.icon}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Date */}
      {onSetDate && (
        <>
          <div className="task-kebab-divider" />
          <div className="task-kebab-date">
            <span className="task-kebab-date-label">
              Date{task?.due_date ? `: ${formatDateDisplay(task.due_date)}` : ''}
            </span>
            <DatePicker
              date={task?.due_date}
              onChange={(date) => { onSetDate(date); afterAction(); }}
              inline
            />
          </div>
        </>
      )}
    </>
  );
}

export function TaskKebabMenu({ task, isFocused, isDetailOpen, isPinned, pinnedTier, isDone, onExpandDetail, onClearFocus, onSetPriority, onStar, onPinTask, onUnpinTask, onSetTier, onOpenSession, onSetDate, onUnparent, onMoveUp, onUngroup, isGroupHidden, onUnhideGroup, onStartSelect, onDelete }: TaskKebabMenuProps) {
  const integrations = useIntegrations();
  const sessionId = resolveTaskSessionId(task);
  const storedSessionStatus = useSessionStatus(sessionId);
  const [open, setOpen] = useState(false);
  /** Set only by the right-click path, which anchors the menu at the cursor. */
  const [cursorAnchor, setCursorAnchor] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => { setOpen(false); setCursorAnchor(null); }, []);
  // Measured placement + height cap — the menu height is never guessed, so a
  // tall menu in a short window scrolls internally instead of being clipped.
  const menuPos = useMenuPlacement(open, btnRef, menuRef, {
    anchorPoint: cursorAnchor,
    // A task row is filtered out from under an open menu often here (the live
    // todo search re-filters as you type); close rather than strand the menu.
    onAnchorLost: closeMenu,
  });

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    // Three different scroll cases, deliberately:
    //  1. Inside the menu — the menu scrolls its own overflow now, so this must
    //     NOT dismiss it (that would make the fix unusable).
    //  2. Right-click path (cursorAnchor set) — a cursor anchor is a frozen
    //     viewport point, not an element. Once the page scrolls, it no longer
    //     points at the row it was opened on, so close outright. Safe here
    //     because a right-click never scrolls the row into view, so this can't
    //     fire in the same tick as the open (see case 3).
    //  3. Button path — follow the trigger (useMenuPlacement repositions) and
    //     only close once it truly leaves the viewport. A blanket close-on-scroll
    //     would fire in the SAME tick as the opening click whenever that click
    //     scrolls the row into view, so the menu never appeared at all — the bug
    //     documented in TaskBatchMenu.tsx.
    const handleScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (cursorAnchor) { closeMenu(); return; }
      const r = btnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) closeMenu();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, closeMenu, cursorAnchor]);

  // Right-click anywhere on the task row opens this kebab menu at the cursor —
  // the row is an app object, not a document, so the browser context menu is
  // replaced. The row element is found via the [data-task-id] ancestor every
  // task surface (list row, pinned/tier/recent card) already carries.
  useEffect(() => {
    const row = btnRef.current?.closest<HTMLElement>('[data-task-id]');
    if (!row) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Keep the native menu inside text-editing surfaces (inline title edit).
      if (target.isContentEditable) return;
      // Nested/overlapping rows: only the innermost row owns the right-click.
      if (target.closest('[data-task-id]') !== row) return;
      e.preventDefault();
      // Placement (flip, clamp, height cap) is all measured by useMenuPlacement —
      // record only the cursor point it should anchor to.
      setCursorAnchor({ x: e.clientX, y: e.clientY });
      setOpen(true);
    };
    row.addEventListener('contextmenu', handleContextMenu);
    return () => row.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCursorAnchor(null);   // button path anchors to the button, not a cursor
    setOpen(!open);
  };

  // Source badge info
  const sourceMeta = task.source ? getIntegrationMeta(integrations, task.source) : null;
  const badge = task.source === 'local' ? 'L' : (sourceMeta?.badge ?? task.source?.charAt(0).toUpperCase());
  const integrationName = task.source === 'local' ? 'Local' : (sourceMeta?.name ?? task.source);
  const badgeColor = sourceMeta?.badgeColor;
  // has_synced is the server-precomputed `!!task.ext?.[task.source]` for the
  // minimal list payload (ext is dropped there); fall back to it when ext isn't inlined.
  const legacySynced = task.source === 'ms-todo' && Boolean(task.ms_todo_id);
  const synced = task.source
    && task.source !== 'local'
    && (Boolean(task.ext?.[task.source]) || Boolean(task.has_synced) || legacySynced);

  // data-menu-open replaces a `:has(.task-kebab-menu)` CSS check that kept the ⋮
  // visible while its menu was open — the menu is portalled to <body> now, so it
  // is no longer a descendant for :has() to find.
  return (
    <div className="task-kebab-wrapper" data-menu-open={open || undefined}>
      <button
        ref={btnRef}
        className="task-kebab-btn"
        onClick={handleToggle}
        title="More actions"
        aria-label="More actions"
      >
        ⋮
      </button>
      {/* Portalled to <body>: `position: fixed` escapes clipping ancestors but
          NOT stacking contexts, so a z-indexed ancestor (a panel header, a
          sticky bar) caps this menu at the ancestor's layer no matter how high
          its own z-index is. See the note in TaskQuickActions.tsx. */}
      {open && createPortal(
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(menuPos)}
        >
          {/* Session status */}
          {(() => {
            const ss = storedSessionStatus ?? task.session_status;
            if (!sessionId && !ss) return null;
            const isRunning = ss?.process_status === 'running';
            const isError = ss?.process_status === 'error';
            const needsAttention = task.phase === 'AGENT_COMPLETE' || task.phase === 'AWAIT_HUMAN_ACTION';
            const color = isError || needsAttention ? 'var(--error)' : isRunning ? 'var(--success)' : 'var(--fg-muted)';
            const label = isRunning ? 'AI is working...' : isError ? 'Session error' : needsAttention ? 'Needs your attention' : 'Session idle';
            return (
              <button
                className="task-kebab-item"
                onClick={(e) => {
                  e.stopPropagation();
                  if (sessionId && onOpenSession) { onOpenSession(sessionId); closeMenu(); }
                }}
              >
                <span className="task-kebab-icon" style={{ color }}>●</span>
                <span>{label}</span>
              </button>
            );
          })()}

          {/* Details */}
          <button
            className={`task-kebab-item${isDetailOpen ? ' task-kebab-item-active' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (isDetailOpen) onClearFocus?.();
              else onExpandDetail?.(task);
              closeMenu();
            }}
          >
            <span className="task-kebab-icon">{ICONS.ICON_INFO}</span>
            <span>{isDetailOpen ? 'Close details' : 'Details'}</span>
          </button>

          {/* Star */}
          {onStar && (
            <button
              className={`task-kebab-item${task.starred ? ' task-kebab-item-active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onStar(task.id);
                closeMenu();
              }}
            >
              <span className="task-kebab-icon">{task.starred ? ICONS.ICON_STAR_FILLED : ICONS.ICON_STAR_EMPTY}</span>
              <span>{task.starred ? 'Unstar' : 'Star'}</span>
            </button>
          )}

          {/* Select — enter multi-select mode with this task picked, to group several together */}
          {onStartSelect && (
            <button
              className="task-kebab-item"
              onClick={(e) => {
                e.stopPropagation();
                onStartSelect(task.id);
                closeMenu();
              }}
            >
              <span className="task-kebab-icon">☑</span>
              <span>Select…</span>
            </button>
          )}

          {/* Move actions — hierarchy + order shortcuts (precise alternative to drag) */}
          {((onUnparent && task.parent_task_id) || onMoveUp) && (
            <>
              <div className="task-kebab-divider" />
              {onUnparent && task.parent_task_id && (
                <button
                  className="task-kebab-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnparent(task.id);
                    closeMenu();
                  }}
                >
                  <span className="task-kebab-icon">←</span>
                  <span>Move left</span>
                </button>
              )}
              {onMoveUp && (
                <button
                  className="task-kebab-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveUp(task.id);
                    closeMenu();
                  }}
                >
                  <span className="task-kebab-icon">↑</span>
                  <span>Move up</span>
                </button>
              )}
            </>
          )}

          {/* Ungroup — remove this task from its virtual group */}
          {onUngroup && task.group_id && (
            <>
              <div className="task-kebab-divider" />
              <button
                className="task-kebab-item"
                onClick={(e) => {
                  e.stopPropagation();
                  onUngroup(task.id);
                  closeMenu();
                }}
              >
                <span className="task-kebab-icon">⑂</span>
                <span>Remove from group</span>
              </button>
            </>
          )}

          {/* Unhide group — restore a Focus-hidden group back into the pinned area.
              Only shown when this task belongs to a currently-hidden group. */}
          {onUnhideGroup && task.group_id && isGroupHidden && (
            <button
              className="task-kebab-item"
              onClick={(e) => {
                e.stopPropagation();
                onUnhideGroup(task.group_id!);
                closeMenu();
              }}
            >
              <span className="task-kebab-icon">⊙</span>
              <span>Unhide group in Focus</span>
            </button>
          )}

          {/* Pin / Tier · Priority · Date — shared with the multi-select batch dropdown */}
          <TaskActionMenuItems
            task={task}
            isPinned={isPinned}
            pinnedTier={pinnedTier}
            isDone={isDone}
            onSetPriority={onSetPriority ? (p) => onSetPriority(task.id, p) : undefined}
            onPinTask={onPinTask ? () => onPinTask(task.id) : undefined}
            onUnpinTask={onUnpinTask ? () => onUnpinTask(task.id) : undefined}
            onSetTier={onSetTier ? (t) => onSetTier(task.id, t) : undefined}
            onSetDate={onSetDate ? (d) => onSetDate(task.id, d) : undefined}
            afterAction={closeMenu}
          />

          {/* Source badge — combined with external link if available */}
          {task.source && (() => {
            const statusText = task.sync_error ? ' (sync error)' : synced ? '' : task.source !== 'local' ? ' (unsynced)' : '';
            const badgeEl = (
              <span
                className="task-source-badge"
                style={!task.sync_error && badgeColor ? { background: badgeColor, color: 'white' } : task.source === 'local' ? { background: '#8E8E93', color: 'white' } : undefined}
              >
                {task.sync_error ? '!' : badge}
              </span>
            );
            if (task.external_url) {
              return (
                <>
                  <div className="task-kebab-divider" />
                  <a
                    className="task-kebab-item task-kebab-info"
                    href={task.external_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => { e.stopPropagation(); closeMenu(); }}
                  >
                    {badgeEl}
                    <span>{integrationName}{statusText}</span>
                    <span className="task-kebab-external-arrow">↗</span>
                  </a>
                </>
              );
            }
            return (
              <>
                <div className="task-kebab-divider" />
                <div className="task-kebab-item task-kebab-info">
                  {badgeEl}
                  <span>{integrationName}{statusText}</span>
                </div>
              </>
            );
          })()}
          {/* External link without source */}
          {!task.source && task.external_url && (() => {
            const label = 'external';
            return (
              <>
                <div className="task-kebab-divider" />
                <a
                  className="task-kebab-item"
                  href={task.external_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); closeMenu(); }}
                >
                  <span className="task-kebab-icon">↗</span>
                  <span>Open in {label}</span>
                </a>
              </>
            );
          })()}

          {/* Delete */}
          {onDelete && (
            <>
              <div className="task-kebab-divider" />
              <button
                className="task-kebab-item task-kebab-item-danger"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(task.id);
                  closeMenu();
                }}
              >
                <span className="task-kebab-icon">{ICONS.ICON_TRASH}</span>
                <span>Delete</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
