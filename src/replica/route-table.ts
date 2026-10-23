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
 * (none included), a trailing `:name+` is one note path (one or more segments: an
 * exact route whose last parameter is a vault path, WP11). First match wins. Ratchet: tests/replica/route-table-coverage.test.ts
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
  /**
   * A `local` row answers here only for this host's data (self-host.ts, WP6):
   * `session` = the `:id` session runs on this host, `host` = the request's
   * `host` query names this host (a `sessionId` query never decides). Otherwise
   * the row is a `leader` row, and its `away` says what happens while away.
   */
  local?: 'session' | 'host'
  /**
   * A `local` row whose answer here also needs this daemon capability: the
   * changes view only when the daemon computes it host-local ('changes-v1');
   * without it the reader path would miss the files the session wrote outside
   * its cwd (the follower scope refuses them), so the Mac answers, as before WP6.
   */
  cap?: string
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
  // WP12: a new Ask Walnut while the Mac is away runs as a session on this host
  // (replica/ask-launch.ts: its task journaled, the daemon starts it from the Mac's
  // template). A folder session, a retry and pictures still need the Mac (its answers).
  { method: 'POST', pattern: '/api/sessions/quick-start', away: 'queue:ask', why: 'ask_needs_mac' },
  { method: 'POST', pattern: '/api/v1/sessions', away: 'queue:ask', why: 'ask_needs_mac' },
  // The phone app's calls (iOS, the frozen /api/v1): every one has its row.
  { method: 'GET', pattern: '/api/v1/status', away: 'read' },
  { method: 'GET', pattern: '/api/v1/instance', away: 'read' },
  { method: 'GET', pattern: '/api/v1/me', away: 'read' },
  { method: 'POST', pattern: '/api/v1/devices/self', away: 'needs-leader', why: 'device_changes_need_mac' },
  { method: 'GET', pattern: '/api/v1/tasks', away: 'read' },
  { method: 'GET', pattern: '/api/v1/tasks/:id', away: 'read' },
  { method: 'POST', pattern: '/api/v1/tasks', away: 'host-write' },
  // A list's own order: the journal has no record for it (a Focus bar move is a task-move).
  { method: 'PATCH', pattern: '/api/v1/tasks/reorder', away: 'needs-leader', why: 'list_order_needs_mac' },
  { method: 'PATCH', pattern: '/api/v1/tasks/:id', away: 'host-write' },
  { method: W, pattern: '/api/v1/tasks/:id', away: 'needs-leader', why: 'task_writes_need_mac' },
  { method: 'GET', pattern: '/api/v1/sessions', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/list-dirs', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/v1/sessions/:id', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/history', cls: 'local', local: 'session', away: 'read' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/transcript', cls: 'local', local: 'session', away: 'read' },
  { method: 'POST', pattern: '/api/v1/sessions/:id/messages', away: 'host-write' },
  { method: W, pattern: '/api/v1/sessions/:id/messages', away: 'needs-leader', why: 'session_writes_need_mac' },
  // Host data, answered on this host even while the Mac answers (WP6, self-host.ts):
  // a session that runs here, a file or a diff of this host, read through the
  // follower link. A session or a host elsewhere goes to the Mac as before.
  { method: 'GET', pattern: '/api/sessions/:id/history', cls: 'local', local: 'session' },
  { method: 'GET', pattern: '/api/sessions/:id/subagent/:agentId/history', cls: 'local', local: 'session' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/subagent/:agentId/history', cls: 'local', local: 'session' },
  { method: 'GET', pattern: '/api/sessions/:id/changes', cls: 'local', local: 'session', cap: 'changes-v1' },
  { method: 'GET', pattern: '/api/sessions/:id/changes/file', cls: 'local', local: 'session', cap: 'changes-v1' },
  { method: 'GET', pattern: '/api/v1/sessions/:id/changes', cls: 'local', local: 'session', cap: 'changes-v1' },
  // A file read with no `host` (the Mac's own file) or of another host is the
  // Mac's even while it is away: the handlers would read it from this replica's
  // disk, outside the daemon's owner scope (and it is not this host's file).
  { method: 'GET', pattern: '/api/file-content', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/files/list', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/files/resolve-path', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/files/references', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  // The phone's twins of the same reads (files-v1.ts calls the same functions).
  { method: 'GET', pattern: '/api/v1/file-content', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/v1/files/list', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/v1/files/resolve-path', cls: 'local', local: 'host', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/v1/file-raw/*', away: 'needs-leader', why: 'files_need_mac' },
  // The new-session dir picker lists a host's (or, with no host, the Mac's) dirs
  // (the phone's twin sits above /api/v1/sessions/:id, which would take it).
  { method: 'GET', pattern: '/api/sessions/list-dirs', away: 'needs-leader', why: 'files_need_mac' },
  // The other reads of a file by path: the Mac's (forwarded), and while it is
  // away nobody's here (this replica's disk is not the Mac's, and the daemon's
  // owner scope would not apply to a read of it).
  { method: 'GET', pattern: '/api/file-raw/*', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/file-history/*', away: 'needs-leader', why: 'files_need_mac' },
  { method: 'GET', pattern: '/api/local-image/*', away: 'needs-leader', why: 'files_need_mac' },
  // A session's spend and budget: the Mac's usage store plus the daemon's budget
  // file under the Mac's data home. Neither is copied, so this replica's own
  // route could only fail (a 503 with no why, seen in the away console).
  { method: 'GET', pattern: '/api/usage/sessions/:sid', away: 'needs-leader', why: 'usage_needs_mac' },
  // This server's own health.
  { method: 'GET', pattern: '/api/health', cls: 'local' },
  // The terminal is a /ws RPC; node-pty is not on hosts (section 3).
  // Plugin routes are the leader's by prefix (their credentials stay on the Mac;
  // plugins do not load on a replica, so even their reads need it).
  { method: '*', pattern: '/api/plugins/*', cls: 'leader', away: 'needs-leader', why: 'plugins_need_mac' },
  // WP10: the writes a person makes while the Mac is away, journaled by this host's
  // daemon through the write port (write-port.ts; the handlers: away-writes.ts,
  // which names the same paths). Each row is exact. Every other task and session
  // write needs the Mac and says why, so the console says it in words.
  { method: 'PATCH', pattern: '/api/tasks/reorder', away: 'needs-leader', why: 'list_order_needs_mac' },
  { method: 'POST', pattern: '/api/tasks', away: 'host-write' },
  { method: 'PATCH', pattern: '/api/tasks/:id', away: 'host-write' },
  { method: 'POST', pattern: '/api/tasks/:id/complete', away: 'host-write' },
  { method: 'POST', pattern: '/api/tasks/:id/toggle-complete', away: 'host-write' },
  { method: 'PUT', pattern: '/api/tasks/:id/note', away: 'host-write' },
  { method: 'PUT', pattern: '/api/tasks/:id/description', away: 'host-write' },
  { method: 'PUT', pattern: '/api/tasks/:id/summary', away: 'host-write' },
  { method: 'POST', pattern: '/api/v1/tasks/:id/complete', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/note', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/description', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/summary', away: 'host-write' },
  { method: 'POST', pattern: '/api/focus/tasks/:id', away: 'host-write' },
  { method: 'DELETE', pattern: '/api/focus/tasks/:id', away: 'host-write' },
  { method: 'PUT', pattern: '/api/focus/tasks/:id/tier', away: 'host-write' },
  { method: 'PUT', pattern: '/api/focus/reorder', away: 'host-write' },
  { method: 'POST', pattern: '/api/v1/focus/tasks/:id', away: 'host-write' },
  { method: 'DELETE', pattern: '/api/v1/focus/tasks/:id', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/focus/tasks/:id/tier', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/focus/reorder', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/board', away: 'host-write' },
  { method: 'POST', pattern: '/api/v1/tasks/:id/board/edits', away: 'host-write' },
  { method: 'POST', pattern: '/api/v1/tasks/:id/board/threads/:thread', away: 'host-write' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/board/projects/:project', away: 'host-write' },
  { method: 'POST', pattern: '/api/sessions/:id/permission', away: 'host-write' },
  { method: 'POST', pattern: '/api/v1/sessions/:id/permission', away: 'host-write' },
  { method: 'DELETE', pattern: '/api/devices/:name', away: 'host-write' },
  { method: W, pattern: '/api/tasks/*', away: 'needs-leader', why: 'task_writes_need_mac' },
  { method: W, pattern: '/api/sessions/*', away: 'needs-leader', why: 'session_writes_need_mac' },
  // WP5 copies: the conversation lists, routines, prefs, favorites and the config
  // read from this replica's copies while away (the default read row). Only the
  // lists are copied, never a conversation body: a body read is the Mac's.
  { method: 'GET', pattern: '/api/chat/history', away: 'needs-leader', why: 'conversation_bodies_need_mac' },
  { method: 'GET', pattern: '/api/chat/stats', away: 'needs-leader', why: 'conversation_bodies_need_mac' },
  { method: 'GET', pattern: '/api/chat/triage', away: 'needs-leader', why: 'conversation_bodies_need_mac' },
  // The phone's twins: the copied list says the conversation exists, so a body
  // read here would answer 200 with no messages, and the phone replaces its rows
  // with that answer.
  { method: 'GET', pattern: '/api/v1/conversations/:id/messages', away: 'needs-leader', why: 'conversation_bodies_need_mac' },
  { method: 'GET', pattern: '/api/v1/chat/stats', away: 'needs-leader', why: 'conversation_bodies_need_mac' },
  // The memory and the skills: the daemon keeps their copy for its sessions, but this
  // server has no reader of it, and its own data dir holds neither, so a read here
  // would answer an empty memory or only the built-in skills as if they were the user's.
  ...['/api/memory', '/api/memory/*', '/api/v1/memory', '/api/v1/memory/*'].map((pattern): RouteRow => ({ method: 'GET', pattern, away: 'needs-leader', why: 'memory_needs_mac' })),
  ...['/api/skills', '/api/skills/*', '/api/v1/skills', '/api/v1/skills/*'].map((pattern): RouteRow => ({ method: 'GET', pattern, away: 'needs-leader', why: 'skills_need_mac' })),
  // The writes of those copied stores: the Mac owns each store, so each says which
  // one it is (the same why the replica's own refusal of it carries). Exact
  // methods: a routine's `:id` would also take /draft, /check-test and /trigger,
  // which change no routine and keep the plain away answer.
  { method: 'PUT', pattern: '/api/config', away: 'needs-leader', why: 'config_writes_need_mac' },
  ...['/api/routines', '/api/cron', '/api/v1/routines'].flatMap((base): RouteRow[] => [
    { method: 'POST', pattern: base, away: 'needs-leader', why: 'routine_writes_need_mac' },
    { method: 'PATCH', pattern: `${base}/:id`, away: 'needs-leader', why: 'routine_writes_need_mac' },
    { method: 'DELETE', pattern: `${base}/:id`, away: 'needs-leader', why: 'routine_writes_need_mac' },
    { method: 'POST', pattern: `${base}/:id/toggle`, away: 'needs-leader', why: 'routine_writes_need_mac' },
  ]),
  { method: 'PUT', pattern: '/api/ui-prefs', away: 'needs-leader', why: 'prefs_writes_need_mac' },
  { method: W, pattern: '/api/favorites/*', away: 'needs-leader', why: 'prefs_writes_need_mac' },
  { method: 'POST', pattern: '/api/agents/:agentId/conversations', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'PUT', pattern: '/api/agents/:agentId/conversations/active', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'PATCH', pattern: '/api/agents/:agentId/conversations/:cid', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'DELETE', pattern: '/api/agents/:agentId/conversations/:cid', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'PUT', pattern: '/api/v1/conversations/active', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'PATCH', pattern: '/api/v1/conversations/:id', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  { method: 'DELETE', pattern: '/api/v1/conversations/:id', away: 'needs-leader', why: 'conversation_writes_need_mac' },
  // WP11: a note written while away (away-notes.ts answers these in the Mac's own shapes,
  // through the daemon's note journal). `:path+` is the vault path (exact routes: the
  // ratchet's wildcard rule reads `*`). Moves, folders, attachments and the index need
  // the Mac and say so.
  { method: 'PUT', pattern: '/api/notes-v2/content/:path+', away: 'note-write' },
  { method: 'DELETE', pattern: '/api/notes-v2/content/:path+', away: 'note-write' },
  { method: 'PUT', pattern: '/api/v1/notes/content/:path+', away: 'note-write' },
  { method: 'POST', pattern: '/api/v1/notes', away: 'note-write' },
  { method: 'DELETE', pattern: '/api/v1/notes/:path+', away: 'note-write' },
  { method: W, pattern: '/api/notes-v2/*', away: 'needs-leader', why: 'note_changes_need_mac' },
  { method: W, pattern: '/api/v1/notes/*', away: 'needs-leader', why: 'note_changes_need_mac' },
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
    // A note path: one or more segments, none of them `..`.
    if (i === want.length - 1 && w.startsWith(':') && w.endsWith('+')) {
      return got.length > i && got.slice(i).every((g) => g !== '..')
    }
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
