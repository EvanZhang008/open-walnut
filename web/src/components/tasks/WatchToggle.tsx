/**
 * Watch: the user keeps a task in front of them, at the top of the home task panel
 * (its Watching section), whatever its phase, tier or pin (2026-10-29, the user: "if
 * someone wants to keep looking at a task ... how can we keep it on top"). Not called
 * "pin": Focus and the pinned board already are pins. One field, `watched_at`, the
 * time the watch began; clearing it ends the watch. Nothing else about the task moves.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { updateTask } from '@/api/tasks';
import { log } from '@/utils/log';
import * as ICONS from '../common/Icons';
import { isWatched } from './status-sections';
import '@/styles/task-watch.css';

/**
 * A plain PATCH's value, per task, until its echo (or a failure) arrives, so the eye and the menu
 * row answer the click. Kept outside any component: the kebab's row unmounts with the menu, and a
 * menu opened again before the echo still reads the click (2026-11-09 review).
 */
interface PendingWatch { value: string; write: number; settled: boolean }
const pendingWatch = new Map<string, PendingWatch>();
const pendingListeners = new Set<() => void>();
let writeSeq = 0;
function setPendingWatch(id: string, next: PendingWatch | null): void {
  if (next) pendingWatch.set(id, next); else pendingWatch.delete(id);
  for (const l of pendingListeners) l();
}
function subscribePending(l: () => void): () => void {
  pendingListeners.add(l);
  return () => { pendingListeners.delete(l); };
}

export function useWatchToggle(task: Pick<Task, 'id'> & { watched_at?: string | null }) {
  const store = useTasksContextSafe();
  const pending = useSyncExternalStore(subscribePending, () => pendingWatch.get(task.id), () => pendingWatch.get(task.id));
  const base = task.watched_at ?? null;
  // The task moved after the latest click's write came back (its echo, or anyone's later write):
  // that is the truth now. A move while that write is still out is an older click's echo, and the
  // latest click stays (2026-11-09 review: Watch, then Stop watching, the first echo first).
  useEffect(() => {
    const p = pendingWatch.get(task.id);
    if (p?.settled) setPendingWatch(task.id, null);
  }, [task.id, base]);
  const watched = pending ? pending.value !== '' : isWatched(task);
  // Off the board's store (a session menu on the Org page), a plain PATCH; the
  // task:updated it broadcasts refreshes whoever shows the task.
  // A task the board's store does not hold (an archived one a session panel opened) is a plain
  // PATCH too: the store's optimistic update only patches rows it has and swallows the echo,
  // which is the one thing that would bring the task onto the Watching list.
  const toggle = () => {
    const watched_at = watched ? '' : new Date().toISOString();
    if (store && store.tasks.some((t) => t.id === task.id)) { store.update(task.id, { watched_at }); return; }
    const write = ++writeSeq;
    setPendingWatch(task.id, { value: watched_at, write, settled: false });
    void updateTask(task.id, { watched_at }).then(() => {
      // Back: the echo that follows (or came already) retires it; until then it is the server's value.
      const p = pendingWatch.get(task.id);
      if (p?.write === write) setPendingWatch(task.id, { ...p, settled: true });
    }, (err) => {
      log.warn('task-watch', 'watch write failed', { taskId: task.id, error: String(err) });
      // Only the latest click's value is shown: an older write failing leaves it.
      if (pendingWatch.get(task.id)?.write === write) setPendingWatch(task.id, null);
      store?.showOperationError(`Could not ${watched_at ? 'watch' : 'stop watching'} the task: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  return { watched, toggle };
}

/** Watching's drag (watchReorder): each write goes through the board's store, applied at once, the
 *  same as a watch; a task the store does not hold is a plain PATCH. */
export function useWatchReorder(): (writes: readonly { id: string; watched_at: string }[]) => void {
  const store = useTasksContextSafe();
  return useCallback((writes) => {
    log.info('task-watch', 'watching reordered', { taskIds: writes.map((w) => w.id).join(','), writes: writes.length });
    for (const w of writes) {
      if (store && store.tasks.some((t) => t.id === w.id)) { store.update(w.id, { watched_at: w.watched_at }); continue; }
      void updateTask(w.id, { watched_at: w.watched_at }).catch((err) => {
        log.warn('task-watch', 'watch order write failed', { taskId: w.id, error: String(err) });
      });
    }
  }, [store]);
}

/** The row menu's Watch / Stop watching item. */
export function WatchMenuItem({ task, afterAction }: { task: Task; afterAction?: () => void }) {
  const { watched, toggle } = useWatchToggle(task);
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
