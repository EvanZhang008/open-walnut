/**
 * Watch: the user keeps a task in front of them, at the top of the home task panel
 * (its Watching section), whatever its phase, tier or pin (2026-10-29, the user: "if
 * someone wants to keep looking at a task ... how can we keep it on top"). Not called
 * "pin": Focus and the pinned board already are pins. One field, `watched_at`, the
 * time the watch began; clearing it ends the watch. Nothing else about the task moves.
 *
 * Background is the other end of the same list (2026-11-11, the user: long-running work such as
 * a CR review or a cron job, "无论 task 是什么 status，它不会出来"): one field, `background_at`,
 * holds an open task in the Background group at the foot of the panel whatever its state. Both
 * marks are written the same way, so they share one toggle (useListMark); the server keeps a
 * task in one of the two at most.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { updateTask } from '@/api/tasks';
import { log } from '@/utils/log';
import * as ICONS from '../common/Icons';
import { isWatched } from './status-sections';
import '@/styles/task-watch.css';

/** The list marks a toggle writes: Watching's and Background's. */
type ListMarkField = 'watched_at' | 'background_at';
const markKey = (field: ListMarkField, id: string) => `${field}:${id}`;

/**
 * A plain PATCH's value, per task and mark, until its echo (or a failure) arrives, so the eye and the menu
 * row answer the click. Kept outside any component: the kebab's row unmounts with the menu, and a
 * menu opened again before the echo still reads the click (2026-11-09 review).
 */
interface PendingWatch { value: string; settled: boolean }
const pendingWatch = new Map<string, PendingWatch>();
const pendingListeners = new Set<() => void>();
function setPendingWatch(id: string, next: PendingWatch | null): void {
  if (next) pendingWatch.set(id, next); else pendingWatch.delete(id);
  for (const l of pendingListeners) l();
}
function subscribePending(l: () => void): () => void {
  pendingListeners.add(l);
  return () => { pendingListeners.delete(l); };
}

/**
 * One Watch write per task at a time, the latest click last: a click while a write is out only
 * replaces what goes next, so the server applies the clicks in order and ends on the last one
 * (2026-11-09 review: two PATCHes reaching the server in the opposite order kept the first click).
 */
const watchWriting = new Set<string>();
const watchNext = new Map<string, string>();
const MARK_WORDS: Record<ListMarkField, { on: string; off: string }> = {
  watched_at: { on: 'watch', off: 'stop watching' },
  background_at: { on: 'move to Background', off: 'take out of Background' },
};

function queueWatchWrite(id: string, field: ListMarkField, value: string, showError?: (msg: string) => void): void {
  const key = markKey(field, id);
  watchNext.set(key, value);
  if (watchWriting.has(key)) return;
  watchWriting.add(key);
  void (async () => {
    while (watchNext.has(key)) {
      const v = watchNext.get(key)!;
      watchNext.delete(key);
      try {
        await updateTask(id, { [field]: v });
      } catch (err) {
        log.warn('task-watch', 'list mark write failed', { taskId: id, field, error: String(err) });
        // A newer click still goes out; with none, the click is undone and said so.
        if (!watchNext.has(key) && pendingWatch.get(key)?.value === v) setPendingWatch(key, null);
        showError?.(`Could not ${v ? MARK_WORDS[field].on : MARK_WORDS[field].off} the task: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // The latest click is written: its echo (or one that came already) retires the held value.
      const p = pendingWatch.get(key);
      if (!watchNext.has(key) && p?.value === v) setPendingWatch(key, { ...p, settled: true });
    }
    watchWriting.delete(key);
  })();
}

type MarkTask = Pick<Task, 'id'> & { watched_at?: string | null; background_at?: string | null };

/** One list mark's state and its toggle: applied through the board's store when it holds the
 *  task, else a plain PATCH held until its echo. */
function useListMark(task: MarkTask, field: ListMarkField, isOn: (t: MarkTask) => boolean) {
  const store = useTasksContextSafe();
  const key = markKey(field, task.id);
  const pending = useSyncExternalStore(subscribePending, () => pendingWatch.get(key), () => pendingWatch.get(key));
  const base = task[field] ?? null;
  // The task moved after the latest click's write came back (its echo, or anyone's later write):
  // that is the truth now. A move while that write is still out is an older click's echo, and the
  // latest click stays (2026-11-09 review: Watch, then Stop watching, the first echo first).
  useEffect(() => {
    const p = pendingWatch.get(key);
    if (p?.settled) setPendingWatch(key, null);
  }, [key, base]);
  const on = pending ? pending.value !== '' : isOn(task);
  // Off the board's store (a session menu on the Org page), a plain PATCH; the
  // task:updated it broadcasts refreshes whoever shows the task.
  // A task the board's store does not hold (an archived one a session panel opened) is a plain
  // PATCH too: the store's optimistic update only patches rows it has and swallows the echo,
  // which is the one thing that would bring the task onto the Watching list.
  const toggle = () => {
    const value = on ? '' : new Date().toISOString();
    log.info('task-watch', 'list mark toggled', { taskId: task.id, field, on: !on });
    if (store && store.tasks.some((t) => t.id === task.id)) { store.update(task.id, { [field]: value }); return; }
    setPendingWatch(key, { value, settled: false });
    queueWatchWrite(task.id, field, value, store?.showOperationError);
  };
  return { on, toggle };
}

export function useWatchToggle(task: MarkTask) {
  const { on, toggle } = useListMark(task, 'watched_at', isWatched);
  return { watched: on, toggle };
}

/** In Background or not: the mark only (a completed task keeps it, so the menu can take it out). */
const hasBackgroundMark = (t: MarkTask) => !!t.background_at;

export function useBackgroundToggle(task: MarkTask) {
  const { on, toggle } = useListMark(task, 'background_at', hasBackgroundMark);
  return { inBackground: on, toggle };
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

/** The row menu's Move to Background / Take out of Background item (2026-11-11). */
export function BackgroundMenuItem({ task, afterAction }: { task: Task; afterAction?: () => void }) {
  const { inBackground, toggle } = useBackgroundToggle(task);
  return (
    <button
      type="button"
      className="task-kebab-item"
      data-testid="task-kebab-background"
      title={inBackground
        ? 'Back to the list: it shows where its state puts it again'
        : 'Long-running work: keep it in the Background group at the foot of the list, whatever its state'}
      onClick={(e) => { e.stopPropagation(); toggle(); afterAction?.(); }}
    >
      <span className="task-kebab-icon">{ICONS.ICON_BACKGROUND}</span>
      <span>{inBackground ? 'Take out of Background' : 'Move to Background'}</span>
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
