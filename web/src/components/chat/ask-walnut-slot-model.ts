/**
 * The Ask Walnut slot's selection model — pure, no React.
 *
 * The slot on the home page is a view over ORDINARY tasks: every Ask Walnut
 * launch stamps `walnut_agent` on the task it creates, so the tab strip is just
 * "that flag, newest first" and the panel below is that task's session. Keeping
 * the two decisions here (which tasks, which tab) means they can be pinned
 * without a DOM: a browser spec can only observe them indirectly, and each one
 * has a silent failure mode (a tab strip that reorders while an ask streams, a
 * selection that jumps off the task the user just launched).
 *
 * WHICH SESSION a task's panel mounts is deliberately NOT here — it is
 * `resolveTaskSessionId` in utils/session-status.ts, the one precedence every
 * other surface (board row, dock card, focus locate) already uses.
 */

import type { Task } from '@open-walnut/core';

/** ISO → ms, with an unparseable/absent stamp sorting LAST rather than poisoning
 *  the comparison with NaN. */
function ms(iso: string | undefined): number {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * Newest BORN first: `created_at`, then `updated_at`, then the id.
 *
 * Birth order, deliberately not activity order: `updated_at` moves every time a
 * turn streams (the session writes back), so ordering on it reshuffled the tab
 * strip under the cursor while an ask was answering — the user aimed at tab 3
 * and clicked whatever slid into its place. A tab's position is the order the
 * conversations were started in, which nothing can change after the fact.
 *
 * The trailing id compare is what makes the order STABLE — two tasks stamped in
 * the same millisecond would otherwise flip places whenever the list is
 * refetched. `-Infinity - -Infinity` is NaN, which is falsy, so a pair with no
 * usable stamps falls through to the next key instead of returning it.
 */
function compareRecency(a: Task, b: Task): number {
  return (ms(b.created_at) - ms(a.created_at))
    || (ms(b.updated_at) - ms(a.updated_at))
    || a.id.localeCompare(b.id);
}

/** Every Ask Walnut task, newest first. Never mutates the input list (it is the
 *  shared task store's array). */
export function selectAskWalnutTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter((t) => t.walnut_agent === true).sort(compareRecency);
}

/**
 * Which tab is selected after the task list changed.
 *
 * The persisted id wins while its task still exists; otherwise the newest task
 * takes over (a deleted or archived-away selection must not leave the slot
 * blank).
 *
 * An EMPTY list keeps the persisted pick instead of clearing it. The task store
 * starts empty on every page load and fills a tick later, so "no candidates" is
 * the ordinary state at first paint, not evidence the task is gone — clearing
 * there is exactly how a reload used to lose the selected tab (it also erased the
 * persisted id on the way out, so the next resolve had nothing to restore). The
 * caller renders its composer off "no tabs", never off a null selection, so a
 * selection pointing at a task nobody can see costs nothing.
 *
 * Sort-independent: it derives "newest" with the same (birth-order) comparator
 * the tab strip uses rather than trusting the caller to have sorted, so a raw
 * store array is a legal argument and the default pick is always the LEFTMOST
 * tab.
 */
export function resolveSelection(
  persistedId: string | null | undefined,
  tasks: readonly Task[],
): string | null {
  if (persistedId && tasks.some((t) => t.id === persistedId)) return persistedId;
  if (!tasks.length) return persistedId ?? null;
  let newest: Task | null = null;
  for (const t of tasks) if (!newest || compareRecency(t, newest) < 0) newest = t;
  return newest?.id ?? null;
}
