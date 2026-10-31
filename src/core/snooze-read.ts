/**
 * The snooze of one task, its ancestors read from the store (server only: snooze.ts itself stays
 * pure, the web bundles it through user-status.ts).
 */
import { snoozedUntil } from './snooze.js';
import type { Task } from './types.js';

type Snoozable = Pick<Task, 'id' | 'start_date' | 'parent_task_id'>;

/** snoozedUntil for one task. Never throws (null on a read it cannot make). For a path that holds
 *  one task, not the list. */
export async function readSnoozedUntil(task: Snoozable, nowMs = Date.now()): Promise<string | null> {
  try {
    const byId = new Map<string, Snoozable>([[task.id, task]]);
    if (!task.start_date && task.parent_task_id) {
      const { getTask } = await import('./task-manager.js');
      let cur: Snoozable | null = task;
      for (let hops = 0; cur?.parent_task_id && !cur.start_date && hops < 10; hops++) {
        cur = await getTask(cur.parent_task_id).catch(() => null);
        if (cur) byId.set(cur.id, cur);
      }
    }
    return snoozedUntil(task, byId, nowMs);
  } catch {
    return null;
  }
}
