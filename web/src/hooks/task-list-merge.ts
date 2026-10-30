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
    // A Waiting task's clock ("Waiting until Fri 9:00"). Setting or clearing it
    // keeps the phase, so without it that echo bailed as "equal".
    'wait_until',
  ];
  for (const k of scalarKeys) if (a[k] !== b[k]) return false;
  // A host replica's mark on a row with a write still on its way to the Mac (WP10;
  // never on the Mac's own rows, where both sides lack it).
  if ((a as { replica_sync?: unknown }).replica_sync !== (b as { replica_sync?: unknown }).replica_sync) return false;
  // The one status the user sees (src/core/user-status.ts): small, compared whole.
  if (JSON.stringify(a.user_status ?? null) !== JSON.stringify(b.user_status ?? null)) return false;
  // An engine switch inside the task (sessions/engine-switch.ts), written raw: the composer's
  // line follows it (pending, switching, done, failed), and updated_at stays as it was.
  const sw = (t: Task) => (t.engine_switch
    ? `${t.engine_switch.id}|${t.engine_switch.state}|${t.engine_switch.session_id ?? ''}|${t.engine_switch.error ?? ''}|${t.engine_switch.message ? 1 : 0}` : '');
  if (sw(a) !== sw(b)) return false;
  // Main's or a lead's Brief (Org page): its rewrite leaves updated_at alone.
  if (a.brief?.at !== b.brief?.at || a.brief?.text !== b.brief?.text) return false;
  // The org's own fields (the Org page and its chart): a VP's name and instructions, a VP made
  // only to put projects under, and those projects are written raw, leaving updated_at alone.
  if (a.org_role !== b.org_role || a.org_name !== b.org_name || a.org_vp_only !== b.org_vp_only
    || a.org_instructions?.at !== b.org_instructions?.at || a.org_instructions?.text !== b.org_instructions?.text
    || (a.org_leads ?? []).join('\n') !== (b.org_leads ?? []).join('\n')) return false;
  // Written raw, leaving updated_at alone: the Board's Partial (a result's not-done list and its
  // settle) and a team stop (Stop / Resume the team, core/sessions/team-stop.ts).
  if (JSON.stringify(a.result_report ?? null) !== JSON.stringify(b.result_report ?? null)) return false;
  if ((a.team_stop?.at ?? null) !== (b.team_stop?.at ?? null)) return false;
  const arrKeys: (keyof Task)[] = ['tags', 'depends_on'];
  for (const k of arrKeys) {
    const av = (a[k] as string[] | undefined) ?? [];
    const bv = (b[k] as string[] | undefined) ?? [];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
  }
  // The isolated workspace (task.workspace): its writes leave updated_at alone, so
  // without this every progress line and state change bailed as "equal".
  const wa = a.workspace;
  const wb = b.workspace;
  if (wa !== wb && (wa?.state !== wb?.state || wa?.updated_at !== wb?.updated_at || wa?.progress !== wb?.progress
    || wa?.error !== wb?.error || wa?.launch_error !== wb?.launch_error || wa?.kept_reason !== wb?.kept_reason)) return false;
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
 *
 * `retain` names tasks the store learned about over WS AFTER the fetch was
 * issued. The fetched list is a snapshot from before they existed, so adopting
 * it wholesale would delete them until the next refetch (a ~6k-task list takes
 * seconds to arrive, and a task created in that window vanished from every
 * surface; the Ask Walnut slot then re-resolved its selection onto an OLDER ask
 * and stayed there). Such a task keeps its place at the head, in the order the
 * events inserted it. When the snapshot DOES carry it, the snapshot may still
 * predate the events that followed the insert (the session link lands a beat
 * after the create), so the row with the later server `updated_at` wins; both
 * stamps come from the server, so they compare.
 */
export function mergeFetchedTasks(prev: Task[], fetched: Task[], retain?: ReadonlySet<string>): Task[] {
  if (prev.length === 0) return fetched;
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let reused = 0;
  const next = fetched.map((t) => {
    const old = prevById.get(t.id);
    if (old && listRowEqual(old, t)) { reused++; return old; }
    if (old && retain?.has(t.id) && Date.parse(old.updated_at ?? '') > Date.parse(t.updated_at ?? '')) return old;
    return t;
  });
  if (retain?.size) {
    const fetchedIds = new Set(fetched.map((t) => t.id));
    const kept = prev.filter((t) => retain.has(t.id) && !fetchedIds.has(t.id));
    if (kept.length) return [...kept, ...next];
  }
  if (reused === fetched.length && prev.length === fetched.length) {
    let sameOrder = true;
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) { sameOrder = false; break; }
    }
    if (sameOrder) return prev;
  }
  return next;
}

/** An optimistic write's fields and when it was made (performance.now clock).
 *  `pending` counts the writes behind it the server has not answered yet;
 *  `settledAt` is when the last of them was answered. */
export interface LocalEdit { at: number; fields: Partial<Task>; pending?: number; settledAt?: number }

/**
 * A list answer read when its request left (`sentAt`), with the optimistic fields
 * written after that, still waiting for their write, or answered only after it left,
 * laid back over it: the answer cannot be trusted to hold them, and adopting it as is
 * drew a dragged card back where it came from until the next refetch. A request that
 * left before the write was answered may have been read before the write landed: a
 * host replica answers a list read at once while its write waits on the host's
 * journal (2026-10-17: a rename showed the old title again). Edits the answer holds
 * (written and answered before it left) are dropped from `edits`.
 */
export function overlayLaterEdits(fetched: Task[], edits: Map<string, LocalEdit>, sentAt: number): Task[] {
  const later = new Map<string, Partial<Task>>();
  for (const [id, edit] of edits) {
    if (edit.at > sentAt || (edit.pending ?? 0) > 0 || (edit.settledAt ?? -Infinity) > sentAt) later.set(id, edit.fields);
    else edits.delete(id);
  }
  if (later.size === 0) return fetched;
  return fetched.map((t) => { const f = later.get(t.id); return f ? { ...t, ...f } : t; });
}

/**
 * The fields an optimistic write changed on one row (`before` to `after`), with a
 * cleared field kept as `undefined`: what a LocalEdit holds for it.
 */
export function changedFields(before: Task, after: Task): Partial<Task> {
  const fields: Record<string, unknown> = {};
  const a = after as unknown as Record<string, unknown>;
  const b = before as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (a[k] !== b[k]) fields[k] = a[k];
  }
  return fields as Partial<Task>;
}
