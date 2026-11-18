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

export function keepsThreads(task: ThreadKeeper | null | undefined): boolean {
  if (!task) return false;
  if (task.org_role === 'main' || task.org_role === 'lead') return true;
  return !task.org_role && task.threads_on === true;
}
