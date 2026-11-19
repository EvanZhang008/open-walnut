/**
 * Whether a session offers a task's Threads, and the switch that turns them on or off
 * (Task.threads_on, src/core/org/keeps-threads.ts). Kept apart from SessionThreadsPane so the
 * panel reads it without loading the pane.
 */
import type { Task } from '@open-walnut/core';
import { useSyncExternalStore } from 'react';
import { apiPatch } from '@/api/client';
import type { TaskStoreActions } from '@/contexts/TasksContext';
import { log } from '@/utils/log';

/** A session menu's Threads rows (the desktop Open group, the phone's rows): off, the row turns them on and opens them; on, it opens or closes them, and a second row turns them off. */
export interface ThreadsMenu { on: boolean; onOpen: () => void; onTurnOff: () => void }

/** Does this task's session offer Threads in its menu? A leader (a task with a Board tab) or one already on; never Main or a lead, whose Threads are on the Org page. */
export function threadsOffered(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined, leads: boolean): boolean {
  return !!task && !task.org_role && (leads || task.threads_on === true);
}

/** Does the task keep Threads by the user's switch (Main and the leads keep theirs on the Org page)? */
export function threadsKeptBy(task: Pick<Task, 'org_role' | 'threads_on'> | null | undefined): boolean {
  return !!task && !task.org_role && task.threads_on === true;
}

/** Turn a task's Threads on or off: through the task list when it holds the row (it shows at once), else PATCH /api/tasks/:id. True when it saved. */
export async function setTaskThreads(taskId: string, on: boolean, store?: TaskStoreActions | null): Promise<boolean> {
  try {
    const ok = store?.has(taskId)
      ? await store.update(taskId, { threads_on: on })
      : await apiPatch(`/api/tasks/${encodeURIComponent(taskId)}`, { threads_on: on }).then(() => true);
    if (ok) log.info('session-threads', on ? 'threads turned on' : 'threads turned off', { taskId });
    return ok;
  } catch (err) {
    log.warn('session-threads', 'threads switch did not save', { taskId, on, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * A link that opens a task's Threads (`/tasks/<id>?view=threads`, the phone buzz of a thread that waits
 * on him: src/core/push/thread-push.ts): the task's panel opens the view once it shows that task.
 * Kept a short while, so a panel that mounts after the link still takes it.
 */
const THREADS_VIEW_ASK_MS = 30_000;
const threadsViewAsks = new Map<string, number>();
const askListeners = new Set<() => void>();
let askTick = 0;

export function askThreadsView(taskId: string, now = Date.now()): void {
  threadsViewAsks.set(taskId, now);
  askTick += 1;
  for (const l of askListeners) l();
}

/** Changes with every new ask, so a panel already on screen looks again (useSyncExternalStore). */
export function useThreadsViewAskTick(): number {
  return useSyncExternalStore(
    (l) => { askListeners.add(l); return () => { askListeners.delete(l); }; },
    () => askTick,
  );
}

/** True once for a task whose Threads a link asked for (and forgets the ask). */
export function takeThreadsViewAsk(taskId: string | undefined, now = Date.now()): boolean {
  if (!taskId) return false;
  const at = threadsViewAsks.get(taskId);
  if (at === undefined) return false;
  threadsViewAsks.delete(taskId);
  return now - at < THREADS_VIEW_ASK_MS;
}
