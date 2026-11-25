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
 * A route that names one task (its id, or the start of one) answers only for a task the slice holds:
 * any other is the leader's, so it is `no_copy` too, never a "no such task" for one the leader has.
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

/** The routes that name one task, and where its id is. */
const ONE_TASK: readonly RegExp[] = [
  new RegExp(`^/api/(?:v1/)?tasks/(${ID})(?:/board(?:/owner)?|/sessions)?$`),
  /^\/api\/sessions\/task\/([^/]+)$/,
]

/**
 * Whether an away read of `path` (the request's pathname) is answered without a copy. `holdsTask`:
 * the slice holds a task with this id or one that starts with it (core/unstored-rows.ts).
 */
export function readsWithoutCopy(path: string, holdsTask: (id: string) => boolean = () => true): boolean {
  let p = path
  try { p = decodeURIComponent(path) } catch { /* as sent */ }
  p = p.replace(/\/{2,}/g, '/')
  if (!SLICE_READS.some((re) => re.test(p))) return false
  for (const re of ONE_TASK) {
    const id = re.exec(p)?.[1]
    if (id !== undefined) return holdsTask(id)
  }
  return true
}
