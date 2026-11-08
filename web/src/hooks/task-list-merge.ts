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
/**
 * Task fields tasksShallowEqual and listRowEqual do not compare, and why. A field written without
 * moving updated_at that a row draws must be compared, or its change is dropped as "equal" (it
 * happened for the Brief, a VP's name, a team stop, the workspace, and the Org pins, one at a time);
 * tests/web/task-list-merge.test.ts fails on a Task field in neither place, so a new one is decided.
 */
export const UNCOMPARED_TASK_FIELDS: Readonly<Record<string, string>> = {
  // Each write of these moves updated_at with it, or reaches the UI by another event.
  description: 'written with updated_at', summary: 'written with updated_at', note: 'written with updated_at',
  conversation_log: 'written with updated_at', end_date: 'written with updated_at', created_at: 'never changes',
  phase_changed_at: 'moves with phase', field_at: 'bookkeeping of field writes', ext: 'plugin payload, written with updated_at',
  plugin_only: 'the task:updated handler drops the row itself (dropPluginOnly)',
  // Kept for the server and the sessions; no row draws them.
  transfer_state: 'not drawn', last_start: 'not drawn', routine_start: 'not drawn', session_history_count: 'not drawn',
  session_status_unavailable: 'not drawn', family_group_id: 'not drawn', auto_links: 'not drawn',
  created_by_op: 'not drawn', applied_ops: 'not drawn', ledger_desc: 'not drawn', walnut_agent: 'set at create',
  agent_id: 'set at create', status_report: 'drawn through user_status', promise_alarm: 'not drawn',
  needs_recheck: 'not drawn', letter_recheck: 'not drawn', recheck_watch: 'not drawn', agent_memory: 'read on its own panel',
  cwd_missing: 'not drawn', watch: 'not drawn (the server keeps who hears a task)',
  // The engine comparison's facts: the server reads them for Usage & Costs; no task row draws them.
  engine_pick: 'not drawn (Usage & Costs reads it on the server)', start_failures: 'not drawn (Usage & Costs)',
  reopens: 'not drawn (Usage & Costs)', first_completed_at: 'not drawn (Usage & Costs)', completions: 'not drawn (Usage & Costs)',
  review_score: 'not drawn (Usage & Costs)',
  needs_marked_at: 'drawn through user_status (a person\'s own Needs you)',
  ask_answered: 'drawn through user_status (an ask answered above leaves Needs you)',
  asks_answered: 'drawn through user_status, as ask_answered',
  asks_withdrawn: 'not drawn (a record of answers taken back; the ask shows through user_status)',
};

export function tasksShallowEqual(a: Task, b: Task): boolean {
  const scalarKeys: (keyof Task)[] = [
    'title', 'status', 'phase', 'priority', 'project',
    'parent_task_id', 'group_id', 'due_date', 'start_date', 'completed_at', 'updated_at',
    'sync_error', 'external_url', 'unread', 'source', 'sprint',
    'cwd', 'session_id', 'plan_session_id', 'exec_session_id', 'summary_session_id',
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
  // A start waiting for room on a host (start-queue.ts), written raw: the details show its line.
  if ((a.start_queue?.at ?? null) !== (b.start_queue?.at ?? null) || a.start_queue?.host !== b.start_queue?.host
    || a.start_queue?.reason !== b.start_queue?.reason) return false;
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
  // Why a task in a project that syncs is kept local (Task.sync_hold): the gate's verdict lands
  // after the create, and the row and its Sync menu draw it.
  if ((a.sync_hold?.state ?? null) !== (b.sync_hold?.state ?? null) || a.sync_hold?.at !== b.sync_hold?.at
    || a.sync_hold?.outside?.state !== b.sync_hold?.outside?.state) return false;
  // Main's or a lead's Brief (Org page): its rewrite leaves updated_at alone.
  if (a.brief?.at !== b.brief?.at || a.brief?.text !== b.brief?.text
    || JSON.stringify(a.brief?.text_sources ?? null) !== JSON.stringify(b.brief?.text_sources ?? null)) return false;
  if (JSON.stringify(a.last_words ?? null) !== JSON.stringify(b.last_words ?? null)) return false;
  // Its refresh turn asked (sessions/brief-refresh.ts): the Brief reads "Updating" until it lands.
  if ((a.brief_refresh?.at ?? null) !== (b.brief_refresh?.at ?? null)) return false;
  // The org's own fields (the Org page and its chart): a VP's name and instructions, a VP made
  // only to put projects under, and those projects are written raw, leaving updated_at alone.
  if (a.org_role !== b.org_role || a.org_name !== b.org_name || a.org_vp_only !== b.org_vp_only
    || a.org_instructions?.at !== b.org_instructions?.at || a.org_instructions?.text !== b.org_instructions?.text
    || (a.org_leads ?? []).join('\n') !== (b.org_leads ?? []).join('\n')) return false;
  // Main's or a VP's background start (org-autostart.ts): the Org page says starting, or why it failed.
  if (a.org_start?.state !== b.org_start?.state || a.org_start?.at !== b.org_start?.at) return false;
  // The Org nodes a task is pinned to (src/core/org/org-pins.ts), written raw: the Org list and the
  // node's Pinned tab draw them.
  if ((a.org_pins ?? []).map((p) => p.node).join('\n') !== (b.org_pins ?? []).map((p) => p.node).join('\n')) return false;
  // Written raw, leaving updated_at alone: the Board's Partial (a result's not-done list and its
  // settle) and a team stop (Stop / Resume the team, core/sessions/team-stop.ts).
  if (JSON.stringify(a.result_report ?? null) !== JSON.stringify(b.result_report ?? null)) return false;
  if ((a.team_stop?.at ?? null) !== (b.team_stop?.at ?? null)) return false;
  // Drawn (the transfer links, a watched section, a link's name, the old sessions' list, the session
  // panel's fallback-engine banner) and some written raw (a transfer's far end, the fallback note):
  // compared whole, they are small.
  // The pull request watcher's snapshots and the task's two switches (pull-requests/pr-watch.ts),
  // written raw: the PR pill and its card draw them.
  for (const k of ['transferred_to', 'transferred_from', 'transfer', 'watched_at', 'link_names', 'legacy_session_ids', 'engine_fallback', 'pr_status', 'pr_auto_complete', 'pr_wake', 'launch_source'] as const) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  if (a.router_area_id !== b.router_area_id || a.router_paused !== b.router_paused) return false;
  const arrKeys: (keyof Task)[] = ['tags', 'depends_on', 'router_links'];
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
 * stamps come from the server, so they compare. `eventRows` holds the row each
 * retained task's latest server event left in the store; it decides an equal stamp
 * (retainedRowWins).
 */
export function mergeFetchedTasks(
  prev: Task[],
  fetched: Task[],
  retain?: ReadonlySet<string>,
  eventRows?: ReadonlyMap<string, Task>,
): Task[] {
  if (prev.length === 0) return fetched;
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let reused = 0;
  const next = fetched.map((t) => {
    const old = prevById.get(t.id);
    if (old && listRowEqual(old, t)) { reused++; return old; }
    if (old && retain?.has(t.id)) {
      const wins = retainedRowWins(old, t, eventRows?.get(t.id));
      if (wins === 'row') return old;
      if (wins === 'fields') return withEventFields(t, old);
    }
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

/**
 * Whether a retained row outranks the snapshot's copy of it. A later server stamp
 * wins (`row`). On an EQUAL stamp the row's own fields still win (`fields`) when it is
 * exactly what a server event left in the store (`eventRow`, the same object): many
 * writes leave `updated_at` alone (a read marker, user_status, result_report, a team
 * stop), so an event and a snapshot read before it carry one stamp, and the snapshot
 * (older) used to win (2026-11-07: a read ask came back as unread in a list that never
 * refetched). A row an optimistic write touched since the event is no longer that
 * object, and the snapshot's copy, the server's answer, wins the tie as before.
 */
function retainedRowWins(old: Task, fetched: Task, eventRow: Task | undefined): 'row' | 'fields' | false {
  const a = Date.parse(old.updated_at ?? '');
  const b = Date.parse(fetched.updated_at ?? '');
  if (a > b) return 'row';
  return a === b && eventRow === old ? 'fields' : false;
}

/**
 * The snapshot's row with what the event row says laid over it. An event carries the
 * raw task, which lacks what the list answer adds (a read marker set before, the
 * session it backfills): a key the event row leaves out keeps the snapshot's value.
 */
function withEventFields(fetched: Task, eventRow: Task): Task {
  const out = { ...fetched } as Record<string, unknown>;
  for (const [k, v] of Object.entries(eventRow)) if (v !== undefined) out[k] = v;
  return out as unknown as Task;
}

/** An optimistic write's fields and when it was made (performance.now clock).
 *  `pending` counts the writes behind it the server has not answered yet;
 *  `settledAt` is when the last of them was answered. */
export interface LocalEdit { at: number; fields: Partial<Task>; pending?: number; settledAt?: number }

/** Record optimistic fields (merged into the row's earlier edit), one more write
 *  behind them when `pending`. */
export function noteLocalEdits(edits: Map<string, LocalEdit>, patches: Record<string, Partial<Task>>, pending: boolean, at: number): void {
  for (const [id, fields] of Object.entries(patches)) {
    const prev = edits.get(id);
    edits.set(id, { at, fields: { ...prev?.fields, ...fields }, pending: (prev?.pending ?? 0) + (pending ? 1 : 0) });
  }
}

/** One write behind each row's edit was answered. */
export function settleLocalEdits(edits: Map<string, LocalEdit>, ids: readonly string[], at: number): void {
  for (const id of ids) {
    const edit = edits.get(id);
    if (edit?.pending) { edit.pending -= 1; edit.settledAt = at; }
  }
}

/** A server echo of one row: an optimistic edit still waiting for its write wins over it. */
export function heldOverEcho(task: Task, edits: Map<string, LocalEdit>): Task {
  const held = edits.get(task.id);
  return held?.pending ? { ...task, ...held.fields } : task;
}

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
