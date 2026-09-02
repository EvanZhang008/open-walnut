/**
 * TaskQuickActions — phase badge (inline) + kebab "⋮" menu for task actions.
 *
 * Used in session panels to show task status and actions.
 * Phase badge stays visible; priority, star, attention, pin, source
 * are consolidated into the kebab dropdown.
 */

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskPhase, TaskPriority } from '@open-walnut/core';
import { fetchTask, updateTask } from '@/api/tasks';
import { ApiError } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import * as ICONS from '@/components/common/Icons';
import { taskCircleClass } from '@/utils/session-status';
import type { FocusTier } from '@/api/focus';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { DatePicker, formatDateDisplay, formatStartDateDisplay } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { keepNativeContextMenu } from '@/utils/context-menu';
import { useFocusBarContextSafe } from '@/contexts/FocusBarContext';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { TIER_OPTIONS, tierColor, PRIORITY_OPTIONS } from './task-meta-constants';
import { MoveToProjectSection } from '@/components/tasks/TaskKebabMenu';

/* ── Phase constants ─────────────────────────────────────────────── */

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: '○',
  IN_PROGRESS: '◐',
  AGENT_COMPLETE: '✓',
  COMPLETE: '✓✓',
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  COMPLETE: 'Complete',
};


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
  /**
   * Extra content appended to the bottom of the kebab dropdown, below a divider
   * (e.g. session-panel's "Session" actions). Receives `close` so items can
   * dismiss the dropdown. When provided, the kebab renders even for a task-less
   * session so those actions stay reachable.
   */
  extraSection?: (close: () => void) => ReactNode;
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
}

export function TaskQuickActions({ taskId, task: externalTask, isPinned, pinnedTier, onPinTask, onUnpinTask, onSetTier, compact, slot = 'all', extraSection, onOpenTaskDetail, contextMenuScope }: TaskQuickActionsProps) {
  const integrations = useIntegrations();
  // Built-ins + the user's custom tiers. Safe hook: this kebab also renders on
  // surfaces that may sit outside the FocusBarProvider.
  const customTiers = useFocusBarContextSafe()?.customTiers ?? [];
  const tierOptions = [
    ...TIER_OPTIONS,
    ...customTiers.map((ct) => ({ value: ct.id, label: ct.label })),
  ];
  const [task, setTask] = useState<Task | null>(externalTask ?? null);
  // Writes go through the shared task store when it carries this row: the
  // optimistic change then reaches the board, the detail pane and the parent
  // session header in the same frame, and the store owns the REST call, the
  // echo guard and the error banner. The direct REST path below stays for a
  // task the list does not have (or no store at all: pop-out windows).
  const store = useTasksContextSafe();
  const storeFor = useCallback((id: string) => (
    store && store.tasks.some((t) => t.id === id) ? store : null
  ), [store]);
  const [kebabOpen, setKebabOpen] = useState(false);
  /** Set only by the right-click path, which anchors the menu at the cursor. */
  const [cursorAnchor, setCursorAnchor] = useState<{ x: number; y: number } | null>(null);
  const kebabBtnRef = useRef<HTMLButtonElement>(null);
  const kebabMenuRef = useRef<HTMLDivElement>(null);
  const closeKebab = useCallback(() => { setKebabOpen(false); setCursorAnchor(null); }, []);
  // Measured placement — this menu is the tallest in the app (task actions +
  // an inline date picker + the Session section), so its height must never be
  // guessed. See useMenuPlacement for why.
  const kebabPos = useMenuPlacement(kebabOpen, kebabBtnRef, kebabMenuRef, {
    anchorPoint: cursorAnchor,
    // The row can be filtered out or re-rendered away while the menu is open;
    // without this the menu is stranded off-screen with no way back.
    onAnchorLost: closeKebab,
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
      setCursorAnchor({ x: e.clientX, y: e.clientY });
      setKebabOpen(true);
    };
    scope.addEventListener('contextmenu', handleContextMenu);
    return () => scope.removeEventListener('contextmenu', handleContextMenu);
  }, [contextMenuScope, slot]);

  // Fetch task if not provided externally
  useEffect(() => {
    if (externalTask !== undefined) { setTask(externalTask ?? null); return; }
    if (!taskId) { setTask(null); return; }
    setTask(null);
    fetchTask(taskId).then(setTask).catch((err) => {
      console.error('[TaskQuickActions] Failed to fetch task:', err);
    });
  }, [taskId, externalTask]);

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
      // The Project picker's list is its own portal (MoveToProjectSection).
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout')) return;
      closeKebab();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeKebab(); };
    const handleScroll = (e: Event) => {
      if (kebabMenuRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest?.('.task-kebab-project-flyout')) return;
      // A cursor anchor is a frozen viewport point: once the page scrolls it no
      // longer points at what was right-clicked, so close outright (the button
      // path instead follows its trigger — see the comment above).
      if (cursorAnchor) { closeKebab(); return; }
      const r = kebabBtnRef.current?.getBoundingClientRect();
      if (r && (r.bottom < 0 || r.top > window.innerHeight)) closeKebab();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [kebabOpen, closeKebab, cursorAnchor]);

  const handlePhaseChange = useCallback((phase: string) => {
    if (!task || task.phase === phase) return;
    const now = new Date().toISOString();
    const completing = phase === 'COMPLETE';
    setTask(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        phase: phase as TaskPhase,
        status: completing ? 'done' as const : phase === 'TODO' ? 'todo' as const : 'in_progress' as const,
        ...(completing ? { completed_at: now, session_id: undefined, plan_session_id: undefined, exec_session_id: undefined, session_status: undefined, plan_session_status: undefined, exec_session_status: undefined, unread: undefined } : {}),
        updated_at: now,
      };
    });
    const id = task.id;
    const shared = storeFor(id);
    if (shared) { shared.setPhase(id, phase); return; }
    const attempt = (retries: number) => {
      updateTask(id, { phase }).catch((err) => {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          fetchTask(id).then(setTask).catch(() => {});
          return;
        }
        if (retries > 0) {
          setTimeout(() => attempt(retries - 1), 2000);
        } else {
          fetchTask(id).then(setTask).catch(() => {});
        }
      });
    };
    attempt(5);
  }, [task, storeFor]);

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

  /** Manual read/unread flip — the "mark as unread" escape hatch (you glanced at
   *  a task but want it to keep nagging). */
  const handleToggleUnread = useCallback(() => {
    if (!task) return;
    const id = task.id;
    const nextUnread = !task.unread;
    setTask(prev => prev ? { ...prev, unread: nextUnread } : prev);
    const shared = storeFor(id);
    if (shared) shared.update(id, { unread: nextUnread });
    else updateTask(id, { unread: nextUnread }).catch(() => {
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
    if (shared) shared.update(id, { start_date: date ?? '' });
    else updateTask(id, { start_date: date ?? '' }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab, storeFor]);

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

  const handleKebabToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCursorAnchor(null);   // button path anchors to the button, not a cursor
    setKebabOpen(!kebabOpen);
  };

  // A task-less session still shows the kebab when it carries a Session section.
  if (!task && !(slot !== 'phase' && extraSection)) return null;

  const isDone = task?.status === 'done' || task?.phase === 'COMPLETE';

  return (
    <div className="task-quick-actions">
      {/* Phase badge — one click toggles To Do ↔ Complete */}
      {slot !== 'kebab' && task && (
      <div className="task-quick-phase">
        <button
          className={`task-quick-phase-btn ${taskCircleClass(task)}`}
          onClick={(e) => {
            e.stopPropagation();
            handlePhaseChange(isDone ? 'TODO' : 'COMPLETE');
          }}
          title={isDone ? 'Done — click to reopen' : 'Click to complete'}
        >
          <span className="task-quick-phase-icon">{ICONS.binaryPhaseIcon(isDone)}</span>
          {!compact && <span className="task-quick-phase-label">{PHASE_LABEL[task.phase] ?? task.phase}</span>}
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
        ⋮
      </button>
      )}
      {/* Portalled to <body> deliberately. `position: fixed` escapes CLIPPING
          ancestors but NOT stacking contexts, and this menu's home is inside
          .session-panel-header (position:absolute, z-index:30). Its own
          z-index:9999 only orders it WITHIN that context, so the whole subtree
          competed as 30 and the composer (.session-panel-input, z-index:40) drew
          over it — the menu rendered fine, just underneath. Raising the number
          would only lose to the next overlay; leaving the context is the fix.
          Same reason ViewDropdown/TaskDetailModal portal. */}
      {slot !== 'phase' && kebabOpen && createPortal(
        <div
          ref={kebabMenuRef}
          className="task-kebab-menu"
          style={menuPlacementStyle(kebabPos)}
        >
          {task && (<>
          {/* Task detail — opens the same full-screen modal as the home task panel */}
          {onOpenTaskDetail && (
            <>
              <button
                className="task-kebab-item"
                onClick={(e) => { e.stopPropagation(); onOpenTaskDetail(task.id); closeKebab(); }}
              >
                <span className="task-kebab-icon">{ICONS.ICON_INFO}</span>
                <span>Task detail</span>
              </button>
              <div className="task-kebab-divider" />
            </>
          )}

          {/* Read / unread */}
          {!isDone && (
            <button
              className={`task-kebab-item${task.unread ? ' task-kebab-item-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleToggleUnread(); }}
            >
              <span className="task-kebab-icon" style={{ color: task.unread ? 'var(--error)' : undefined }}>●</span>
              <span>{task.unread ? 'Mark read' : 'Mark unread'}</span>
            </button>
          )}

          {/* Pin / Tier — same as TodoPanel kebab */}
          {!isDone && (onPinTask || isPinned) && (
            <>
              <div className="task-kebab-divider" />
              {isPinned && onUnpinTask && (
                <button
                  className="task-kebab-item"
                  onClick={(e) => { e.stopPropagation(); onUnpinTask(task.id); closeKebab(); }}
                >
                  <span className="task-kebab-icon">{ICONS.ICON_PIN_FILLED}</span>
                  <span>Unpin</span>
                </button>
              )}
              <div className="task-kebab-tier">
                <span className="task-kebab-tier-label">{isPinned ? 'Move to' : 'Pin to'}</span>
                <div className="task-kebab-tier-options">
                  {tierOptions.map((t) => (
                    <button
                      key={t.value}
                      className={`task-kebab-tier-btn${pinnedTier === t.value ? ' active' : ''}`}
                      style={{ color: tierColor(t.value) }}
                      title={t.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isPinned) {
                          if (pinnedTier !== t.value) onSetTier?.(task.id, t.value);
                        } else {
                          onPinTask?.(task.id);
                          setTimeout(() => onSetTier?.(task.id, t.value), 100);
                        }
                        closeKebab();
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="task-kebab-divider" />

          {/* Priority */}
          <div className="task-kebab-priority">
            <span className="task-kebab-priority-label">Priority</span>
            <div className="task-kebab-priority-options">
              {PRIORITY_OPTIONS.map((p) => (
                <button
                  key={p.value}
                  className={`badge badge-${p.value}${task.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                  title={p.label}
                  onClick={(e) => { e.stopPropagation(); if (p.value !== task.priority) handleSetPriority(p.value); else closeKebab(); }}
                >
                  {p.icon}
                </button>
              ))}
            </div>
          </div>

          {/* Start date — when to begin (drives the Now view's deferral) */}
          <div className="task-kebab-divider" />
          <div className="task-kebab-date">
            <span className="task-kebab-date-label">
              Start{task.start_date ? `: ${formatStartDateDisplay(task.start_date)}` : ''}
            </span>
            <DatePicker
              date={task.start_date}
              onChange={handleSetStartDate}
              inline
            />
          </div>

          {/* Due date — the deadline */}
          <div className="task-kebab-divider" />
          <div className="task-kebab-date">
            <span className="task-kebab-date-label">
              Due{task.due_date ? `: ${formatDateDisplay(task.due_date)}` : ''}
            </span>
            <DatePicker
              date={task.due_date}
              onChange={handleSetDate}
              inline
            />
          </div>

          {/* Move to project — same section as the TodoPanel kebab */}
          <MoveToProjectSection current={task.project || ''} onMove={handleMoveToProject} afterAction={closeKebab} />

          {/* Source badge — combined with external link if available */}
          {(() => {
            if (!task.source) {
              // External link without source
              if (task.external_url) {
                const label = 'external';
                return (
                  <>
                    <div className="task-kebab-divider" />
                    <a
                      className="task-kebab-item"
                      href={task.external_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => { e.stopPropagation(); closeKebab(); }}
                    >
                      <span className="task-kebab-icon">↗</span>
                      <span>Open in {label}</span>
                    </a>
                  </>
                );
              }
              return null;
            }
            const sourceMeta = getIntegrationMeta(integrations, task.source);
            const badge = task.source === 'local' ? 'L' : (sourceMeta?.badge ?? task.source?.charAt(0).toUpperCase());
            const integrationName = task.source === 'local' ? 'Local' : (sourceMeta?.name ?? task.source);
            const badgeColor = sourceMeta?.badgeColor;
            const synced = task.source !== 'local' && (!!task.ext?.[task.source] || !!((task as unknown as Record<string, unknown>)[({ 'ms-todo': 'ms_todo_id' } as Record<string, string>)[task.source] ?? '']));
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
                    onClick={(e) => { e.stopPropagation(); closeKebab(); }}
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
          </>)}

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
    </div>
  );
}
