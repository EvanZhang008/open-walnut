/**
 * Lean event frames: a socket that asks for them (`/ws?lean=<signature>`, the web app since
 * 2026-11-11) is sent only what changed since that same socket last heard it.
 *
 * Why: two events carried most of every page's WebSocket traffic, about 7 MB a minute
 * per page on the Mac's production. `session:background-tasks` repeats a session's
 * whole background ledger (206 rows, 160 KB, most of them long finished) about four
 * times a second, and `task:updated` repeats the whole task, its note (18 KB) and
 * agent memory (12 KB) included, on every change of any field (measured 2026-11-11:
 * 10.8 MB and 3.1 MB of 15 MB in 90 seconds).
 *
 * How: the server remembers, per socket, a hash of each background row and of each
 * large task field it sent that socket. A row or field whose hash is unchanged is left
 * out, and the frame's `lean` block says what was. The web client keeps what it was
 * sent on that socket and rebuilds the whole payload before any listener sees it
 * (web/src/api/ws-lean.ts), so every consumer reads exactly what it read before. A
 * value left out keeps its key, as null, so the rebuilt payload lists its keys in the
 * same order. The state lives and dies with the socket: a reconnect starts both
 * sides from nothing.
 *
 * A socket that does not ask (an older page, the phone, a script) gets whole frames,
 * unchanged. `WALNUT_WS_LEAN=0` on the server sends whole frames to everyone.
 */
import crypto from 'node:crypto'
import {
  LEAN_BACKGROUND_EVENT, LEAN_FIELD_MIN_BYTES, LEAN_FORGET_EVENT, LEAN_MAX_SESSIONS, LEAN_MAX_TASKS, LEAN_SIGNATURE,
  LEAN_TASK_EVENTS, LEAN_VERSION, deletedTaskId, touchLru,
} from '../../lib/ws-lean-protocol.js'

/** What one socket was sent, keyed so the next frame can leave the rest out. */
export interface LeanState {
  /** Background ledger per session: row hash per background task id, the id order, the script hash. */
  bg: Map<string, { rows: Map<string, string>; order: string; script?: string }>
  /** Large task fields per task id: field name -> hash of its JSON. */
  task: Map<string, Map<string, string>>
}

export function newLeanState(): LeanState {
  return { bg: new Map(), task: new Map() }
}

export function leanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WALNUT_WS_LEAN !== '0'
}

/** True when the upgrade URL asks for lean frames under exactly this server's rules. */
export function wantsLean(url: URL | null | undefined): boolean {
  return !!url && url.searchParams.get('lean') === LEAN_SIGNATURE && leanEnabled()
}

const hash = (s: string): string => crypto.createHash('sha1').update(s).digest('base64')
const TASK_EVENTS = new Set(LEAN_TASK_EVENTS)

/** Shapes one event's payload for one socket, updating what that socket was sent. */
export type LeanShaper = (state: LeanState) => unknown

/**
 * The per-socket shaper for one event, or null when the event is sent whole and
 * changes nothing. The work every socket shares (hashing rows and fields) runs once.
 */
export function leanShaper(name: string, data: unknown): LeanShaper | null {
  if (name === LEAN_BACKGROUND_EVENT) return backgroundShaper(data)
  if (TASK_EVENTS.has(name)) return taskShaper(data)
  if (name === LEAN_FORGET_EVENT) {
    const id = deletedTaskId(data)
    return id ? (state) => { state.task.delete(id); return data } : null
  }
  return null
}

function backgroundShaper(data: unknown): LeanShaper | null {
  const d = data as ({ sessionId?: unknown; tasks?: unknown; scriptSource?: unknown } & Record<string, unknown>) | null
  if (!d || typeof d.sessionId !== 'string') return null
  const sessionId = d.sessionId
  // A whole frame the client also reads as whole: it forgets the session, so does the server.
  if (!Array.isArray(d.tasks)) return (state) => { state.bg.delete(sessionId); return data }
  const rows: Array<{ id: string; hash: string; row: unknown }> = []
  const seen = new Set<string>()
  for (const row of d.tasks as unknown[]) {
    const id = (row as { taskId?: unknown } | null)?.taskId
    // A row with no id (or one id twice) cannot be keyed: send this frame whole and
    // forget this session's rows for the socket, as the client does on a whole frame.
    if (typeof id !== 'string' || !id || seen.has(id)) {
      return (state) => { state.bg.delete(sessionId); return data }
    }
    seen.add(id)
    rows.push({ id, hash: hash(JSON.stringify(row)), row })
  }
  const order = JSON.stringify(rows.map((r) => r.id))
  const script = typeof d.scriptSource === 'string' ? hash(d.scriptSource) : undefined
  return (state) => {
    const sent = state.bg.get(sessionId)
    const changed = rows.filter((r) => sent?.rows.get(r.id) !== r.hash).map((r) => r.row)
    const sameOrder = !!sent && sent.order === order
    const sameScript = !!sent && script !== undefined && sent.script === script
    touchLru(state.bg, sessionId, { rows: new Map(rows.map((r) => [r.id, r.hash])), order, script }, LEAN_MAX_SESSIONS)
    return {
      ...d,
      tasks: null,
      ...(sameScript ? { scriptSource: null } : {}),
      lean: {
        v: LEAN_VERSION,
        kind: 'background-tasks',
        changed,
        ...(sameOrder ? {} : { ids: rows.map((r) => r.id) }),
        ...(sameScript ? { sameScript: true } : {}),
      },
    }
  }
}

function taskShaper(data: unknown): LeanShaper | null {
  const d = data as ({ task?: unknown } & Record<string, unknown>) | null
  const task = d?.task as Record<string, unknown> | null | undefined
  if (!d || !task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string') return null
  const id = task.id
  const big = new Map<string, string>()
  for (const [field, value] of Object.entries(task)) {
    if (value === undefined || value === null) continue
    const json = JSON.stringify(value)
    if (json !== undefined && json.length >= LEAN_FIELD_MIN_BYTES) big.set(field, hash(json))
  }
  if (big.size === 0) {
    // Nothing large to keep: the frame rides whole and both sides forget the task.
    return (state) => { state.task.delete(id); return data }
  }
  return (state) => {
    const sent = state.task.get(id)
    const omit: string[] = []
    const keep: string[] = []
    const lean: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(task)) {
      const h = big.get(field)
      if (h === undefined) lean[field] = value
      else if (sent?.get(field) === h) { omit.push(field); lean[field] = null }
      else { keep.push(field); lean[field] = value }
    }
    touchLru(state.task, id, big, LEAN_MAX_TASKS)
    return { ...d, task: lean, lean: { v: LEAN_VERSION, kind: 'task', omit, keep } }
  }
}
