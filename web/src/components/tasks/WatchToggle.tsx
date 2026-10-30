/**
 * Watch: the user keeps a task in front of them, at the top of the home task panel
 * (its Watching section), whatever its phase, tier or pin (2026-10-29, the user: "if
 * someone wants to keep looking at a task ... how can we keep it on top"). Not called
 * "pin": Focus and the pinned board already are pins. One field, `watched_at`, the
 * time the watch began; clearing it ends the watch. Nothing else about the task moves.
 */
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import * as ICONS from '../common/Icons';
import { isWatched } from './status-sections';
import '@/styles/task-watch.css';

export function useWatchToggle(task: Pick<Task, 'id'> & { watched_at?: string | null }) {
  const store = useTasksContextSafe();
  const watched = isWatched(task);
  const toggle = store
    ? () => store.update(task.id, { watched_at: watched ? '' : new Date().toISOString() })
    : undefined;
  return { watched, toggle };
}

/** The row menu's Watch / Stop watching item. */
export function WatchMenuItem({ task, afterAction }: { task: Task; afterAction?: () => void }) {
  const { watched, toggle } = useWatchToggle(task);
  if (!toggle) return null;
  return (
    <button
      type="button"
      className="task-kebab-item"
      data-testid="task-kebab-watch"
      title={watched ? 'Take it off the Watching list' : 'Keep it at the top of the task panel, whatever its state'}
      onClick={(e) => { e.stopPropagation(); toggle(); afterAction?.(); }}
    >
      <span className="task-kebab-icon">{watched ? ICONS.ICON_EYE_OFF : ICONS.ICON_EYE}</span>
      <span>{watched ? 'Stop watching' : 'Watch'}</span>
    </button>
  );
}

/** The eye in a task's header: lit while the task is watched. */
export function WatchButton({ task, className = '' }: { task: Task; className?: string }) {
  const { watched, toggle } = useWatchToggle(task);
  if (!toggle) return null;
  return (
    <button
      type="button"
      className={`task-watch-btn${watched ? ' is-watched' : ''} ${className}`.trim()}
      data-testid="task-watch-btn"
      aria-pressed={watched}
      aria-label={watched ? 'Stop watching' : 'Watch'}
      title={watched ? 'Watching: kept at the top of the task panel. Click to stop.' : 'Watch: keep it at the top of the task panel, whatever its state'}
      onClick={(e) => { e.stopPropagation(); toggle(); }}
    >
      {ICONS.ICON_EYE}
    </button>
  );
}
