/**
 * The Ask Walnut slot's selection model — pure, no React.
 *
 * The slot on the home page is a view over ORDINARY tasks: every Ask Walnut
 * launch stamps `walnut_agent` on the task it creates and files it under the
 * "Ask Walnut" project, so the drawer's list is "those tasks, newest first" and
 * the panel below is the selected task's session. Keeping the two decisions here
 * (which tasks, which one is selected) means they can be pinned without a DOM: a
 * browser spec can only observe them indirectly, and each one has a silent
 * failure mode (a list that reorders while an ask streams, a selection that
 * jumps off the task the user just launched).
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
 * turn streams (the session writes back), so ordering on it reshuffled the list
 * under the cursor while an ask was answering — the user aimed at row 3 and
 * clicked whatever slid into its place. A row's position is the order the
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

/** Project names compare case-insensitively and ignore surrounding whitespace:
 *  the registry keeps the user's casing, and a task moved by hand may carry
 *  either. */
function sameProject(a: string | undefined, b: string): boolean {
  return (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Every Ask Walnut task, newest first. Never mutates the input list (it is the
 * shared task store's array).
 *
 * Two ways in, by design (user, 2026-09-07): a task IS an ask when it was born
 * one (`walnut_agent`, wherever it has since been filed) OR when it lives under
 * the Ask Walnut project now (filed there by hand, or born there). One list, so
 * moving an ask to a project does not make its conversation vanish from the
 * drawer, and dragging a task INTO the project makes it reachable from the
 * chat. `project` is the registry name the launcher files asks under.
 */
export function selectAskWalnutTasks(tasks: readonly Task[], project: string): Task[] {
  return tasks
    .filter((t) => t.walnut_agent === true || sameProject(t.project, project))
    .sort(compareRecency);
}

/**
 * Which task is selected after the task list changed.
 *
 * The persisted id wins while its task still exists; otherwise the newest task
 * takes over (a deleted or archived-away selection must not leave the slot
 * blank).
 *
 * "Newest" prefers a task that HAS a conversation (`hasSession`): the project
 * rule lets a plain todo dragged into the Ask Walnut project into the list, and
 * a fresh window with no persisted pick would otherwise open on that todo's
 * "no session yet" card instead of the last conversation. It stays a candidate
 * (picking it by hand is fine); it just is not the default. Only when nothing
 * has a session does the newest bare task win.
 *
 * An EMPTY list keeps the persisted pick instead of clearing it. The task store
 * starts empty on every page load and fills a tick later, so "no candidates" is
 * the ordinary state at first paint, not evidence the task is gone — clearing
 * there is exactly how a reload used to lose the selection (it also erased the
 * persisted id on the way out, so the next resolve had nothing to restore). The
 * caller renders its composer off "no rows", never off a null selection, so a
 * selection pointing at a task nobody can see costs nothing.
 *
 * Sort-independent: it derives "newest" with the same (birth-order) comparator
 * the drawer uses rather than trusting the caller to have sorted, so a raw store
 * array is a legal argument and the default pick is always the TOP row.
 */
export function resolveSelection(
  persistedId: string | null | undefined,
  tasks: readonly Task[],
  hasSession: (task: Task) => boolean = () => true,
): string | null {
  if (persistedId && tasks.some((t) => t.id === persistedId)) return persistedId;
  if (!tasks.length) return persistedId ?? null;
  let newest: Task | null = null;
  let newestWithSession: Task | null = null;
  for (const t of tasks) {
    if (!newest || compareRecency(t, newest) < 0) newest = t;
    if (hasSession(t) && (!newestWithSession || compareRecency(t, newestWithSession) < 0)) newestWithSession = t;
  }
  return (newestWithSession ?? newest)?.id ?? null;
}
