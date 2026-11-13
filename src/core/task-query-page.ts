import { recentCompletedWindow, type CompletedWindowTask } from './task-recent-completed.js';

/** All callers count and page the same final visible match set. */
export function taskMatchPage<T extends CompletedWindowTask>(
  matches: T[],
  limit?: number,
  completedWithinDays?: number,
): { tasks: T[]; total: number; truncated: boolean; completedHidden?: number } {
  const window = completedWithinDays === undefined ? undefined : recentCompletedWindow(matches, completedWithinDays);
  const visible = window?.tasks ?? matches;
  const tasks = limit === undefined ? visible : visible.slice(0, limit);
  return {
    tasks, total: visible.length, truncated: tasks.length < visible.length,
    ...(window ? { completedHidden: window.completedHidden } : {}),
  };
}
