/**
 * Pure task-list comparison + refetch-merge helpers, extracted from useTasks
 * so they stay unit-testable (useTasks itself pulls the WS client singleton,
 * which needs a browser environment).
 */
import type { Task } from '@open-walnut/core';

/**
 * Shallow equality over UI-visible task fields. Used to suppress no-op
 * `setTasks` calls from secondary WS echoes (e.g. plugin sync writes
 * `ext`/`_syncedAt` and re-emits TASK_UPDATED — nothing UI-visible changed,
 * but a naive `setTasks` still creates a new tasks array identity and
 * re-renders every row). The list below intentionally excludes `ext`,
 * `_syncedAt`, and other backend-only fields.
 */
export function tasksShallowEqual(a: Task, b: Task): boolean {
  const scalarKeys: (keyof Task)[] = [
    'title', 'status', 'phase', 'priority', 'project',
    'parent_task_id', 'group_id', 'due_date', 'start_date', 'completed_at', 'updated_at',
    'sync_error', 'external_url', 'unread', 'source', 'sprint',
    'cwd', 'session_id', 'plan_session_id', 'exec_session_id',
    // Session-resume touch updates ONLY this field now (the pin-bump side
    // effect was removed), so it must count as a UI-visible diff — without it
    // the Recent sort never refreshes live after chatting with a task.
    'last_session_update',
    // Focus Bar state is now DERIVED from task objects (useFocusBar), so pin
    // changes must count as UI-visible diffs — without these keys a task:updated
    // echo whose only change is pin/tier would bail as "shallow equal".
    'pinned', 'focus_tier', 'pin_order',
  ];
  for (const k of scalarKeys) if (a[k] !== b[k]) return false;
  const arrKeys: (keyof Task)[] = ['tags', 'depends_on'];
  for (const k of arrKeys) {
    const av = (a[k] as string[] | undefined) ?? [];
    const bv = (b[k] as string[] | undefined) ?? [];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  // Session status slots (nested objects) — compare on the process_status/activity
  // fields we actually render; deeper equality not needed because session:status-changed
  // is a separate WS event that delivers those changes with its own merge path.
  const cmpStatus = (x: Task['session_status'], y: Task['session_status']): boolean =>
    (x?.process_status ?? null) === (y?.process_status ?? null) &&
    (x?.activity ?? null) === (y?.activity ?? null);
  return cmpStatus(a.session_status, b.session_status)
    && cmpStatus(a.plan_session_status, b.plan_session_status)
    && cmpStatus(a.exec_session_status, b.exec_session_status);
}

/** List-payload fields OUTSIDE tasksShallowEqual's UI-visible set that still
 *  ride `fields=list` and render somewhere (badges, star, progress). Needed by
 *  the refetch merge below so a change in them isn't silently dropped. */
export function listRowEqual(a: Task, b: Task): boolean {
  if (!tasksShallowEqual(a, b)) return false;
  const ar = a as unknown as Record<string, unknown>;
  const br = b as unknown as Record<string, unknown>;
  // is_blocked drives the blocked badge and session_ids is the search-results
  // join key — a refetch whose only change is one of these must not be dropped
  // as "row equal" (the stale row would then never heal until an unrelated
  // field changed too).
  for (const k of ['has_description', 'has_note', 'has_summary', 'has_conversation_log', 'has_ext', 'has_synced', 'starred', 'is_blocked']) {
    if (ar[k] !== br[k]) return false;
  }
  const as = (ar.session_ids as string[] | undefined) ?? [];
  const bs = (br.session_ids as string[] | undefined) ?? [];
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) if (as[i] !== bs[i]) return false;
  const am = ar.milestones;
  const bm = br.milestones;
  if (am !== bm && JSON.stringify(am ?? null) !== JSON.stringify(bm ?? null)) return false;
  return true;
}

/**
 * Identity-preserving refetch merge: adopt the fetched list's ORDER and content,
 * but reuse the previous object for every task that didn't visibly change.
 * Memoized rows then bail on reference equality instead of re-rendering all
 * ~6k rows because a full refetch minted 6k fresh objects. If nothing at all
 * changed, the previous ARRAY is returned so consumers skip entirely.
 */
export function mergeFetchedTasks(prev: Task[], fetched: Task[]): Task[] {
  if (prev.length === 0) return fetched;
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let reused = 0;
  const next = fetched.map((t) => {
    const old = prevById.get(t.id);
    if (old && listRowEqual(old, t)) { reused++; return old; }
    return t;
  });
  if (reused === fetched.length && prev.length === fetched.length) {
    let sameOrder = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) { sameOrder = false; break; }
    }
    if (sameOrder) return prev;
  }
  return next;
}
