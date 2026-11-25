/**
 * The reads a host's Walnut service that keeps no copy (WALNUT_COPIES=none) answers while the
 * leader is away: the ones whose rows are its slice's (slice-source.ts installs them beneath the
 * stores) or this server's own. Every other away read is answered by the dispatcher with
 * `needs_leader {why:'no_copy'}` at once (dispatch.ts awayReadHere): its route would run on empty
 * stores and answer "nothing" for data the leader has. A local row (a session of this host, its
 * transcript and files) never comes here: the dispatcher answers it before the away rule.
 *
 * The routes, by the daemon's own away reads they stand for (the copyless design page's read
 * table, counted from offline-host-core.ts `handle`), and the few reads of this server's own:
 *   task_get, task_list, task_get_bulk, task_sessions, task_history   a task row, a list, its sessions
 *   board_get           a task's Board and its team's owner
 *   pins and tiers      the Focus bar over the same rows (a pin's read before its write)
 *   session_list        this host's sessions, one session's record
 *   request_get, open_items, the caller (`/me`, which every write op resolving its own task reads)
 *   walnut_status, the instance; trigger_list (the triggers this host runs, follower.triggers)
 *   op_result, transfer_get, task_dir, the start check: this server's own records
 * Search, notes, memory, skills, the inbox, the org, folders and every setting are not here: the
 * leader keeps them (no_copy). tests/replica/copyless-reads.test.ts holds every away read op to it.
 *
 * A route that names one task (its id, or the start of one), one session or one request answers only
 * for a row the slice holds, and the bulk read only when the slice holds every task it names: any
 * other is the leader's, so it is `no_copy` too, never a "no such task" for one the leader has.
 */

/** A task id segment: not one of the collection paths a task id pattern would take. */
const ID = '(?!(?:enriched|bulk|groups|board-counts|meta|suggest-accuracy|reorder|start-check)(?:/|$))[^/]+'

const SLICE_READS: readonly RegExp[] = [
  /^\/api\/(?:v1\/)?tasks$/,
  /^\/api\/tasks\/(?:enriched|bulk)$/,
  /^\/api\/v1\/tasks\/start-check$/,
  new RegExp(`^/api/(?:v1/)?tasks/${ID}(?:/board(?:/owner)?|/sessions)?$`),
  /^\/api\/(?:v1\/)?focus\/tasks$/,
  /^\/api\/(?:v1\/)?sessions$/,
  /^\/api\/(?:v1\/)?sessions\/[^/]+$/,
  /^\/api\/sessions\/task\/[^/]+$/,
  /^\/api\/v1\/requests\/[^/]+$/,
  /^\/api\/v1\/me(?:\/open|\/task-dir)?$/,
  /^\/api\/v1\/(?:status|instance)$/,
  /^\/api\/(?:v1\/)?routines$/,
  /^\/api\/v1\/(?:op-calls|transfers)\/[^/]+$/,
]

/** What the slice holds, by id (core/unstored-rows.ts sliceHolds). */
export interface SliceHolds {
  /** A task with this id, or one whose id starts with it. */
  task(id: string): boolean
  session(id: string): boolean
  request(id: string): boolean
}

/** Holds everything: a caller that only asks which routes are slice reads. */
const ANY: SliceHolds = { task: () => true, session: () => true, request: () => true }

/** The routes that name one row, where its id is, and which kind of row it is. */
const ONE_ROW: ReadonlyArray<{ re: RegExp; kind: keyof SliceHolds }> = [
  { re: new RegExp(`^/api/(?:v1/)?tasks/(${ID})(?:/board(?:/owner)?|/sessions)?$`), kind: 'task' },
  { re: /^\/api\/sessions\/task\/([^/]+)$/, kind: 'task' },
  { re: /^\/api\/(?:v1\/)?sessions\/([^/]+)$/, kind: 'session' },
  { re: /^\/api\/v1\/requests\/([^/]+)$/, kind: 'request' },
]

/**
 * Whether an away read of `url` (the request's path, with its query) is answered without a copy.
 * `holds`: what the slice holds. A route naming one row answers only for a row the slice holds, and
 * the bulk read only when it holds every task it names: the others are the leader's.
 */
export function readsWithoutCopy(url: string, holds: SliceHolds = ANY): boolean {
  const q = url.indexOf('?')
  let p = q < 0 ? url : url.slice(0, q)
  try { p = decodeURIComponent(p) } catch { /* as sent */ }
  p = p.replace(/\/{2,}/g, '/')
  if (!SLICE_READS.some((re) => re.test(p))) return false
  for (const { re, kind } of ONE_ROW) {
    const id = re.exec(p)?.[1]
    if (id !== undefined) return holds[kind](id)
  }
  if (/^\/api\/tasks\/bulk$/.test(p)) {
    const ids = (new URLSearchParams(q < 0 ? '' : url.slice(q + 1)).get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    // No ids: the route's own 400, not the leader's data.
    return ids.every((id) => holds.task(id))
  }
  return true
}
