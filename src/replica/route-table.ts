/**
 * The route table of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 3): an ordered list of `{method, pattern, cls, away}` the dispatcher
 * (dispatch.ts) reads for every request on the public port.
 *
 *   cls   local    answered here even while the Mac answers (host data)
 *         feature  the route calls routeFeature itself
 *         leader   forwarded while the Mac answers (the default)
 *   away  read          the route runs on this replica's copies (x-walnut-offline)
 *         host-write    the route's write goes to the replica write port (WP10)
 *         queue:<kind>  journaled as that kind (WP10)
 *         note-write    a note write (WP11)
 *         needs-leader  503 needs_leader (the default for every non-GET)
 *
 * Patterns are express-like: `:name` is one segment, a trailing `*` is any rest
 * (none included). First match wins. Ratchet: tests/replica/route-table-coverage.test.ts
 * walks the real app and fails on a write route with no explicit away row, and
 * on a journaling away (`host-write`, `queue:*`, `note-write`) on a wildcard
 * row, so a new write never journals by accident.
 */

export type RouteClass = 'local' | 'feature' | 'leader'
export type AwayRule = 'read' | 'host-write' | `queue:${string}` | 'note-write' | 'needs-leader'

export interface RouteRow {
  /** An HTTP method, `*` for any, or `WRITE` for every method but GET and HEAD. */
  method: string
  pattern: string
  cls?: RouteClass
  away?: AwayRule
  /** Said in the 503 needs_leader body (and for the reader of this table). */
  why?: string
}

export interface RouteDecision {
  cls: RouteClass
  away: AwayRule
  why?: string
  /** The row that decided, or null (the defaults). */
  row: RouteRow | null
}

const W = 'WRITE'

/** The table. Order matters: the first matching row decides. */
export const ROUTE_TABLE: readonly RouteRow[] = [
  // The phone app's calls (iOS, the frozen /api/v1): every one has its row.
  { method: 'GET', pattern: '/api/v1/status', away: 'read' },
  { method: 'GET', pattern: '/api/v1/instance', away: 'read' },
  { method: 'GET', pattern: '/api/v1/me', away: 'read' },
  { method: 'POST', pattern: '/api/v1/devices/self', away: 'needs-leader', why: 'device_changes_need_mac' },
  { method: 'GET', pattern: '/api/v1/tasks', away: 'read' },
  { method: 'GET', pattern: '/api/v1/tasks/:id', away: 'read' },
  { method: 'POST', pattern: '/api/v1/tasks', away: 'needs-leader', why: 'task_writes_need_mac' },
  { method: W, pattern: '/api/v1/tasks/:id', away: 'needs-leader', why: 'task_writes_need_mac' },
  { method: 'GET', pattern: '/api/v1/sessions', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/:id', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/history', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/transcript', away: 'read' },
  { method: W, pattern: '/api/v1/sessions/:id/messages', away: 'needs-leader', why: 'session_writes_need_mac' },
  // The terminal is a /ws RPC; node-pty is not on hosts (section 3).
  // Plugin routes are the leader's by prefix (their credentials stay on the Mac;
  // plugins do not load on a replica, so even their reads need it).
  { method: '*', pattern: '/api/plugins/*', cls: 'leader', away: 'needs-leader', why: 'plugins_need_mac' },
  // Everything else: writes need the Mac until WP10 gives them a journal.
  { method: W, pattern: '/api/v1/*', away: 'needs-leader' },
  { method: W, pattern: '/api/*', away: 'needs-leader' },
]

function segments(p: string): string[] {
  return p.split('/').filter(Boolean)
}

/** Whether `pattern` (a table row) matches `path` (a request's, or a walked route's). */
export function patternMatches(pattern: string, path: string): boolean {
  const want = segments(pattern)
  const got = segments(path)
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    if (w === '*' && i === want.length - 1) return true
    const g = got[i]
    if (g === undefined) return false
    if (w.startsWith(':')) continue
    if (w.toLowerCase() !== g.toLowerCase()) return false
  }
  return got.length === want.length
}

export function methodMatches(rowMethod: string, method: string): boolean {
  const m = method.toUpperCase()
  if (rowMethod === '*') return true
  if (rowMethod === W) return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS'
  return rowMethod === m || (rowMethod === 'GET' && m === 'HEAD')
}

/** Whether a row's away journals a write (WP10/WP11): those rows must be exact. */
export function journals(away: AwayRule | undefined): boolean {
  return away === 'host-write' || away === 'note-write' || (typeof away === 'string' && away.startsWith('queue:'))
}

export function isRead(method: string): boolean {
  const m = method.toUpperCase()
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'
}

export function classify(method: string, path: string, table: readonly RouteRow[] = ROUTE_TABLE): RouteDecision {
  let pathname = path
  try { pathname = decodeURIComponent(path) } catch { /* as sent */ }
  pathname = pathname.replace(/\/{2,}/g, '/')
  for (const row of table) {
    if (!methodMatches(row.method, method) || !patternMatches(row.pattern, pathname)) continue
    return {
      cls: row.cls ?? 'leader',
      away: row.away ?? (isRead(method) ? 'read' : 'needs-leader'),
      ...(row.why ? { why: row.why } : {}),
      row,
    }
  }
  return { cls: 'leader', away: isRead(method) ? 'read' : 'needs-leader', row: null }
}
