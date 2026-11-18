/**
 * Whether a session offers a task's Threads, and the switch that turns them on or off
 * (Task.threads_on, src/core/org/keeps-threads.ts). Kept apart from SessionThreadsPane so the
 * panel reads it without loading the pane.
 */
import type { Task } from '@open-walnut/core';
import { apiPatch } from '@/api/client';
import type { TaskStoreActions } from '@/contexts/TasksContext';
import { log } from '@/utils/log';

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

