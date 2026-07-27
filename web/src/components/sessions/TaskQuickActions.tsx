/**
 * TaskQuickActions — phase badge (inline) + kebab "⋮" menu for task actions.
 *
 * Used in session panels to show task status and actions.
 * Phase badge stays visible; priority, star, attention, pin, source
 * are consolidated into the kebab dropdown.
 */

import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Task, TaskPhase, TaskPriority } from '@open-walnut/core';
import { fetchTask, updateTask, starTask } from '@/api/tasks';
import { ApiError } from '@/api/client';
import { useEvent } from '@/hooks/useWebSocket';
import * as ICONS from '@/components/common/Icons';
import type { FocusTier } from '@/api/focus';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { DatePicker, formatDateDisplay } from '@/components/common/DatePicker';
import { TIER_OPTIONS, TIER_COLORS, PRIORITY_OPTIONS } from './task-meta-constants';

/* ── Phase constants ─────────────────────────────────────────────── */

const PHASE_ICON: Record<string, ReactNode> = {
  TODO: '○',
  IN_PROGRESS: '◐',
  AGENT_COMPLETE: '✓',
  AWAIT_HUMAN_ACTION: '👤',
  HUMAN_VERIFIED: '✅',
  POST_WORK_COMPLETED: '📦',
  COMPLETE: '✓✓',
};

const PHASE_LABEL: Record<string, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  AWAIT_HUMAN_ACTION: 'Await Human Action',
  HUMAN_VERIFIED: 'Human Verified',
  POST_WORK_COMPLETED: 'Post-Work Done',
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
}

export function TaskQuickActions({ taskId, task: externalTask, isPinned, pinnedTier, onPinTask, onUnpinTask, onSetTier, compact, slot = 'all', extraSection, onOpenTaskDetail }: TaskQuickActionsProps) {
  const integrations = useIntegrations();
  const [task, setTask] = useState<Task | null>(externalTask ?? null);
  const [kebabOpen, setKebabOpen] = useState(false);
  const [kebabPos, setKebabPos] = useState<{ top: number; right: number } | null>(null);
  const kebabBtnRef = useRef<HTMLButtonElement>(null);
  const kebabMenuRef = useRef<HTMLDivElement>(null);

  const closeKebab = useCallback(() => setKebabOpen(false), []);

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
  useEvent('task:starred', (data) => {
    const d = data as { task?: Task };
    if (d.task && d.task.id === taskId) setTask(d.task);
  });

  // Close kebab on outside click or scroll
  useEffect(() => {
    if (!kebabOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (kebabBtnRef.current?.contains(e.target as Node)) return;
      if (kebabMenuRef.current?.contains(e.target as Node)) return;
      closeKebab();
    };
    const handleScroll = () => closeKebab();
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [kebabOpen, closeKebab]);

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
        ...(completing ? { completed_at: now, session_id: undefined, plan_session_id: undefined, exec_session_id: undefined, session_status: undefined, plan_session_status: undefined, exec_session_status: undefined, needs_attention: undefined } : {}),
        updated_at: now,
      };
    });
    const id = task.id;
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
  }, [task]);

  const handleSetPriority = useCallback((priority: TaskPriority) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, priority } : prev);
    updateTask(id, { priority }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab]);

  const handleToggleStar = useCallback(() => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, starred: !prev.starred } : prev);
    starTask(id).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab]);

  const handleToggleAttention = useCallback(() => {
    if (!task) return;
    const id = task.id;
    let nextAttention = false;
    setTask(prev => {
      if (!prev) return prev;
      nextAttention = !prev.needs_attention;
      return { ...prev, needs_attention: nextAttention };
    });
    updateTask(id, { needs_attention: nextAttention }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab]);

  const handleSetDate = useCallback((date: string | null) => {
    if (!task) return;
    const id = task.id;
    setTask(prev => prev ? { ...prev, due_date: date ?? undefined } : prev);
    updateTask(id, { due_date: date ?? '' }).catch(() => {
      fetchTask(id).then(setTask).catch(() => {});
    });
    closeKebab();
  }, [task, closeKebab]);

  const handleKebabToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!kebabOpen && kebabBtnRef.current) {
      const rect = kebabBtnRef.current.getBoundingClientRect();
      // Taller when a Session section is appended — otherwise the estimate is
      // too low and a two-section menu opens downward then gets clipped.
      const menuHeight = extraSection ? 560 : 350;
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow < menuHeight ? Math.max(8, rect.top - menuHeight) : rect.bottom + 2;
      setKebabPos({ top, right: window.innerWidth - rect.right });
    }
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
          className={`task-quick-phase-btn${task.phase ? ` task-phase-${task.phase.toLowerCase()}` : ''}`}
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
      {slot !== 'phase' && kebabOpen && (
        <div
          ref={kebabMenuRef}
          className="task-kebab-menu"
          style={kebabPos ? { position: 'fixed', top: kebabPos.top, right: kebabPos.right, zIndex: 9999 } : undefined}
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

          {/* Star */}
          <button
            className={`task-kebab-item${task.starred ? ' task-kebab-item-active' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleToggleStar(); }}
          >
            <span className="task-kebab-icon">{task.starred ? ICONS.ICON_STAR_FILLED : ICONS.ICON_STAR_EMPTY}</span>
            <span>{task.starred ? 'Unstar' : 'Star'}</span>
          </button>

          {/* Attention */}
          {!isDone && (
            <button
              className={`task-kebab-item${task.needs_attention ? ' task-kebab-item-active' : ''}`}
              onClick={(e) => { e.stopPropagation(); handleToggleAttention(); }}
            >
              <span className="task-kebab-icon" style={{ color: task.needs_attention ? 'var(--error)' : undefined }}>●</span>
              <span>{task.needs_attention ? 'Clear attention' : 'Needs attention'}</span>
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
                  {TIER_OPTIONS.map((t) => (
                    <button
                      key={t.value}
                      className={`task-kebab-tier-btn${pinnedTier === t.value ? ' active' : ''}`}
                      style={{ color: TIER_COLORS[t.value] }}
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

          {/* Date */}
          <div className="task-kebab-divider" />
          <div className="task-kebab-date">
            <span className="task-kebab-date-label">
              Date{task.due_date ? `: ${formatDateDisplay(task.due_date)}` : ''}
            </span>
            <DatePicker
              date={task.due_date}
              onChange={handleSetDate}
              inline
            />
          </div>

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
        </div>
      )}
    </div>
  );
}
