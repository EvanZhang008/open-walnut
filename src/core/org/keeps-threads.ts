/**
 * Which tasks keep Threads (threads-model.ts): the user's own requests to them, one thread per
 * subject. Main and every lead always do. Any other task keeps them once the user turned them on
 * in its ⋮ menu (Task.threads_on; 2026-11-18, the user, about a leader task whose asks piled up in
 * one chat: "we should be able to enable the thread for a leader, default off ... click the more
 * and select to open"). A router never does.
 *
 * Every place that files, reads, reminds or answers a node's threads asks this one function, never
 * org_role itself (tests/core/org/keeps-threads-ratchet.test.ts fails on a new raw check).
 */
/** The two fields that decide it (a Task, or the prompt builder's slice of one). */
export type ThreadKeeper = { org_role?: string; threads_on?: boolean };

/**
 * The experiment task_threads (2026-11-19, the user: "let's make all a thread, thread auto open for
 * all task"): every task keeps Threads unless the user turned them off for it (threads_on false).
 * Set by the status sync from the config on boot and on every config change (user-status-sync.ts).
 */
let everyTask = false;
export function setThreadsForEveryTask(on: boolean): void { everyTask = on; }
export function threadsForEveryTask(): boolean { return everyTask; }

export function keepsThreads(task: ThreadKeeper | null | undefined, forEveryTask = everyTask): boolean {
  if (!task) return false;
  if (task.org_role === 'main' || task.org_role === 'lead') return true;
  if (task.org_role) return false;
  return task.threads_on === true || (forEveryTask && task.threads_on !== false);
}
