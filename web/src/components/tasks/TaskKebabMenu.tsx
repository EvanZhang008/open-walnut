/**
 * TaskKebabMenu — "⋮" dropdown menu for task row actions.
 *
 * Consolidates: source badge, external link, details, priority, star, pin
 * into a single kebab button to reduce visual noise per task row.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Task, TaskPriority } from '@walnut/core';
import type { FocusTier } from '@/api/focus';
import * as ICONS from '../common/Icons';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { resolveTaskSessionId } from '@/utils/session-status';
import { DatePicker, formatDateDisplay } from '../common/DatePicker';

interface TaskKebabMenuProps {
  task: Task;
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
  onDelete?: (id: string) => void;
}

const TIER_OPTIONS: { value: FocusTier; label: string; icon: string }[] = [
  { value: 'focus', label: 'Focus', icon: '●' },
  { value: 'satellite', label: 'Satellite', icon: '○' },
  { value: 'wait', label: 'Wait', icon: '◐' },
];

const TIER_COLORS: Record<FocusTier, string> = {
  focus: 'var(--accent)',
  satellite: 'var(--fg-muted)',
  wait: '#8e8e93',
};

const PRIORITY_OPTIONS: { value: TaskPriority; icon: string; label: string }[] = [
  { value: 'immediate', icon: '!!', label: 'Immediate' },
  { value: 'important', icon: '!', label: 'Important' },
  { value: 'backlog', icon: '~', label: 'Backlog' },
  { value: 'none', icon: '--', label: 'None' },
];

export function TaskKebabMenu({ task, isFocused, isDetailOpen, isPinned, pinnedTier, isDone, onExpandDetail, onClearFocus, onSetPriority, onStar, onPinTask, onUnpinTask, onSetTier, onOpenSession, onSetDate, onUnparent, onMoveUp, onUngroup, onDelete }: TaskKebabMenuProps) {
  const integrations = useIntegrations();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (btnRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('scroll', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('scroll', handleScroll);
    };
  }, [open, closeMenu]);

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const menuHeight = 350; // approximate max height
      const spaceBelow = window.innerHeight - rect.bottom;
      const top = spaceBelow < menuHeight ? Math.max(8, rect.top - menuHeight) : rect.bottom + 2;
      setMenuPos({ top, right: window.innerWidth - rect.right });
    }
    setOpen(!open);
  };

  // Source badge info
  const sourceMeta = task.source ? getIntegrationMeta(integrations, task.source) : null;
  const badge = task.source === 'local' ? 'L' : (sourceMeta?.badge ?? task.source?.charAt(0).toUpperCase());
  const integrationName = task.source === 'local' ? 'Local' : (sourceMeta?.name ?? task.source);
  const badgeColor = sourceMeta?.badgeColor;
  // has_synced is the server-precomputed `!!task.ext?.[task.source]` for the
  // minimal list payload (ext is dropped there); fall back to it when ext isn't inlined.
  const synced = task.source && task.source !== 'local' && (!!task.ext?.[task.source] || !!(task as unknown as Record<string, unknown>).has_synced || !!((task as unknown as Record<string, unknown>)[({ 'ms-todo': 'ms_todo_id' } as Record<string, string>)[task.source] ?? '']));

  return (
    <div className="task-kebab-wrapper">
      <button
        ref={btnRef}
        className="task-kebab-btn"
        onClick={handleToggle}
        title="More actions"
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <div
          ref={menuRef}
          className="task-kebab-menu"
          style={menuPos ? { position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 } : undefined}
        >
          {/* Session status */}
          {(() => {
            const sessionId = resolveTaskSessionId(task);
            const ss = task.session_status;
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

          {/* Pin / Tier */}
          {!isDone && (onPinTask || isPinned) && (
            <>
              <div className="task-kebab-divider" />
              {isPinned && onUnpinTask && (
                <button
                  className="task-kebab-item"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnpinTask(task.id);
                    closeMenu();
                  }}
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
                        closeMenu();
                      }}
                    >
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
                      className={`badge badge-${p.value}${task.priority === p.value ? ' badge-active' : ''} badge-clickable`}
                      title={p.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (p.value !== task.priority) onSetPriority(task.id, p.value);
                        closeMenu();
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
                  Date{task.due_date ? `: ${formatDateDisplay(task.due_date)}` : ''}
                </span>
                <DatePicker
                  date={task.due_date}
                  onChange={(date) => { onSetDate(task.id, date); closeMenu(); }}
                  inline
                />
              </div>
            </>
          )}

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
        </div>
      )}
    </div>
  );
}
