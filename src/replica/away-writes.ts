/**
 * The away writes of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * sections 3, 5 and 7; WP10): the routes a person writes through while the Mac
 * is away, answered here through the write port (write-port.ts), never by the
 * Mac's own route handler (which would write the copy, read only here).
 *
 * Mounted on a host replica only, after the auth middleware. It acts only on a
 * request the dispatcher marked as an away write (req.replicaWrite, set when the
 * route table's row journals: route-table.ts WP10 block); everything else goes
 * on to the real routes. The Mac and the companion never mount it.
 *
 *   tasks    PATCH /tasks/:id, POST /tasks, POST /tasks/:id/complete,
 *            POST /tasks/:id/toggle-complete, PUT /tasks/:id/{note,description,summary},
 *            the /api/v1 twins the phone calls
 *   focus    POST|DELETE /focus/tasks/:id (pin, unpin), PUT /focus/tasks/:id/tier and
 *            PUT /focus/reorder (one task moved, with its anchor): a task-move record
 *            is the Focus bar's order and tier (a project list's order needs the Mac:
 *            the journal has no record for it); each answers the Focus bar as it now
 *            shows, in the Mac's TierResult shape (a pinned-only answer once wiped
 *            every tier in the console)
 *   boards   PUT /v1/tasks/:id/board, POST /v1/tasks/:id/board/edits,
 *            POST /v1/tasks/:id/board/threads/:thread, PUT /v1/tasks/:id/board/projects/:project
 *   sessions POST /v1/sessions/:id/messages and POST /sessions/:id/permission for a
 *            session that runs on this host (follower.send, follower.permission)
 *   devices  DELETE /devices/:name: a device removing itself (applied to the device
 *            copy at once, journaled as device-revoke)
 *
 * A write the table journals that no handler here knows answers needs_leader.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type TaskRow, type WriteActor, type WritePort } from './write-port.js'
import type { TierBody } from './away-reads.js'
import { applyVoiceReply } from '../core/sessions/voice-reply.js'
import { PIN_TIER_POLICY, migrateFocusTier } from '../core/types.js'

/** The built-in Focus tiers (task-v1.ts BUILTIN_TIERS): a tier write names one of them or a custom tier. */
const BUILTIN_TIERS: readonly string[] = PIN_TIER_POLICY.map((entry) => entry.tier)

export interface AwayWritesDeps {
  port: WritePort
  /** The paired device of a request's Bearer token (stable id from the device copy), or null. */
  actorOf(req: Request): WriteActor | null
  /** A task as this replica shows it (copy plus overlay), or null. */
  task(id: string): Promise<TaskRow | null>
  /** The Focus bar this replica shows (the copy's tiers with the overlay folded in, away-reads.ts overlayTiers). */
  tiers(): Promise<TierBody>
  /** Whether a session runs on this host (its writes go to the daemon); false: a Mac session. */
  sessionHere(sid: string): Promise<boolean>
  /** A device revoked here: off the device copy at once (the Mac's later lists keep it off until they drop it). */
  revokeLocally(deviceId: string): void
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

type Handler = (req: Request, w: ReplicaWrite, actor: WriteActor, params: Record<string, string>) => Promise<PortAnswer>

interface Row { method: string; pattern: string; handle: Handler }

function body(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean)
  const got = path.split('/').filter(Boolean)
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!
    let g = got[i]!
    try { g = decodeURIComponent(g) } catch { /* as sent */ }
    if (w.startsWith(':')) params[w.slice(1)] = g
    else if (w !== g) return null
  }
  return params
}

/**
 * The one task a reorder moved (a drag moves one), with its anchor in the new
 * order, or null when the new order is not one move away from the old one.
 */
export function singleMove(oldOrder: readonly string[], given: readonly string[]): { taskId: string; anchor: { after?: string; before?: string } } | null {
  // Only the tasks the old order knows (a task made here moves only through the Mac).
  const known = new Set(oldOrder)
  const newOrder = given.filter((id) => known.has(id))
  const ids = new Set(newOrder)
  const before = oldOrder.filter((id) => ids.has(id))
  if (before.length !== newOrder.length || newOrder.length < 2) return null
  if (before.every((id, i) => id === newOrder[i])) return null
  for (let i = 0; i < newOrder.length; i++) {
    const id = newOrder[i]!
    const a = before.filter((x) => x !== id)
    const b = newOrder.filter((x) => x !== id)
    if (a.every((x, j) => x === b[j])) {
      return { taskId: id, anchor: i > 0 ? { after: newOrder[i - 1]! } : { before: newOrder[1]! } }
    }
  }
  return null
}

export function awayWrites(deps: AwayWritesDeps): RequestHandler {
  const { port } = deps
  const text = (b: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof b[k] === 'string') return b[k] as string
    return undefined
  }
  const textField = (field: 'note' | 'description' | 'summary'): Handler => (req, w, actor, p) => {
    const b = body(req)
    const value = text(b, 'content', field, 'text')
    if (value === undefined) return Promise.resolve(refusalAnswer('bad_request', `${field} must be a string`))
    return port.taskUpdate(w, actor, p.id!, { [field]: value })
  }
  const toggle: Handler = async (_req, w, actor, p) => {
    const row = await deps.task(p.id!)
    if (!row) return refusalAnswer('not_found', `Task ${p.id} not found`)
    return row.phase === 'COMPLETE' ? port.taskUpdate(w, actor, p.id!, { phase: 'TODO' }) : port.taskComplete(w, actor, p.id!)
  }
  /** A Focus bar write's answer: the bar as it shows now (the write is in the overlay already). */
  const withTiers = async (a: PortAnswer, pick?: (t: TierBody) => Record<string, unknown>): Promise<PortAnswer> => {
    if (a.answered || a.status >= 300) return a
    const t = await deps.tiers()
    return { answered: false, status: 200, body: { ...(pick ? pick(t) : t), queued: true, offline: true } }
  }
  // The Mac's checks first (focus.ts, task-v1.ts): a write the drain would skip is refused here, never shown kept.
  const pin = (pinned: boolean): Handler => async (_req, w, actor, p) => {
    const row = await deps.task(p.id!)
    if (!row) return refusalAnswer('not_found', `Task ${p.id} not found`)
    const bar = await deps.tiers()
    // Pinning a pinned task, or unpinning one that is not: the bar as it is, nothing journaled.
    if (bar.pinned_tasks.includes(p.id!) === pinned) return { answered: false, status: 200, body: { pinned_tasks: bar.pinned_tasks } }
    if (pinned && row.phase === 'COMPLETE') return refusalAnswer('conflict', 'Cannot pin a completed task')
    return withTiers(await port.taskUpdate(w, actor, p.id!, { pinned }), (t) => ({ pinned_tasks: t.pinned_tasks }))
  }
  const reorder: Handler = async (req, w, actor) => {
    const b = body(req)
    const given = Array.isArray(b.task_ids) ? b.task_ids.filter((x): x is string => typeof x === 'string') : []
    if (!Array.isArray(b.task_ids) || given.length !== b.task_ids.length) return refusalAnswer('bad_request', 'task_ids must be an array of strings')
    const move = singleMove((await deps.tiers()).pinned_tasks, given)
    if (!move) return needsLeaderAnswer('reorder_needs_mac', 'Only one task can be moved at a time while your Mac is away.')
    return withTiers(await port.taskMove(w, actor, move.taskId, move.anchor))
  }
  const tier: Handler = async (req, w, actor, p) => {
    const t = body(req).tier
    const bar = await deps.tiers()
    const customIds = Object.keys(bar.custom_tier_tasks ?? {})
    if (typeof t !== 'string' || (!BUILTIN_TIERS.includes(migrateFocusTier(t)) && !customIds.includes(t))) {
      return refusalAnswer('bad_request', `tier must be one of: ${[...BUILTIN_TIERS, ...customIds].join(', ')}`)
    }
    if (!(await deps.task(p.id!))) return refusalAnswer('not_found', `Task ${p.id} not found`)
    if (!bar.pinned_tasks.includes(p.id!)) return refusalAnswer('bad_request', `Task is not pinned: ${p.id}`)
    // A retired built-in name ('backlog') is journaled as its successor, the tier the Mac lands it in.
    return withTiers(await port.taskMove(w, actor, p.id!, null, customIds.includes(t) ? t : migrateFocusTier(t)))
  }
  const send: Handler = async (req, w, _actor, p) => {
    const sid = p.id!
    if (!(await deps.sessionHere(sid))) return needsLeaderAnswer('session_on_mac', 'This session runs through your Mac; sending to it needs your Mac.')
    const b = body(req)
    // The daemon delivers text: a picture rides only through the Mac (the WS twin's answer too).
    if (Array.isArray(b.images) && b.images.length) return needsLeaderAnswer('images_need_mac', 'Pictures reach a session only through your Mac; nothing of this message was sent.')
    if (b.voice !== undefined && typeof b.voice !== 'boolean') return refusalAnswer('bad_request', 'voice must be a boolean')
    const message = text(b, 'text', 'message')
    if (message === undefined || !message.trim()) return refusalAnswer('bad_request', 'text must be a non-empty string')
    // A voice-mode send asks for a spoken answer, as on the Mac (session-send-v1.ts).
    const words = b.voice === true ? applyVoiceReply(message.trim()) : message
    return port.send(w, sid, words, typeof b.messageId === 'string' ? b.messageId : undefined)
  }
  const permission: Handler = async (req, w, _actor, p) => {
    const sid = p.id!
    if (!(await deps.sessionHere(sid))) return needsLeaderAnswer('session_on_mac', 'This session runs through your Mac; answering it needs your Mac.')
    const b = body(req)
    if (typeof b.requestId !== 'string' || !b.requestId) return refusalAnswer('bad_request', 'requestId must be a string')
    const answer: Record<string, unknown> = { requestId: b.requestId, allow: b.allow === true }
    for (const k of ['message', 'optionId', 'answers']) if (b[k] !== undefined) answer[k] = b[k]
    return port.permission(w, sid, answer)
  }
  const revoke: Handler = async (req, w, actor, p) => {
    const name = p.name!
    // `?target=cloud` removes a pairing on the cloud companion (devices.ts), never this one.
    if (req.query && (req.query as Record<string, unknown>).target !== undefined) {
      return needsLeaderAnswer('device_changes_need_mac', 'Removing a pairing on another server needs your Mac.')
    }
    // A device removes itself away (its own sign-out); removing another needs the owner's rights, which only the Mac knows.
    if (actor.name !== name) return needsLeaderAnswer('device_changes_need_mac', 'Removing another device needs your Mac.')
    const a = await port.deviceRevoke(w, actor, actor.deviceId, name)
    if (!a.answered && a.status < 300) {
      deps.revokeLocally(actor.deviceId)
      deps.log('info', 'replica: a device removed itself while the Mac is away', { deviceId: actor.deviceId, name, opId: w.opId })
    }
    return a
  }
  const board = (op: string, argsOf: (b: Record<string, unknown>, p: Record<string, string>) => Record<string, unknown>): Handler =>
    (req, w, actor, p) => port.board(w, actor, op, p.id!, argsOf(body(req), p))

  const rows: Row[] = [
    // The console's task writes.
    { method: 'POST', pattern: '/tasks', handle: (req, w, actor) => port.taskCreate(w, actor, body(req)) },
    { method: 'PATCH', pattern: '/tasks/:id', handle: (req, w, actor, p) => port.taskUpdate(w, actor, p.id!, body(req)) },
    { method: 'POST', pattern: '/tasks/:id/complete', handle: (_req, w, actor, p) => port.taskComplete(w, actor, p.id!) },
    { method: 'POST', pattern: '/tasks/:id/toggle-complete', handle: toggle },
    { method: 'PUT', pattern: '/tasks/:id/note', handle: textField('note') },
    { method: 'PUT', pattern: '/tasks/:id/description', handle: textField('description') },
    { method: 'PUT', pattern: '/tasks/:id/summary', handle: textField('summary') },
    // The phone's (and the console's v1) twins.
    { method: 'POST', pattern: '/v1/tasks', handle: (req, w, actor) => port.taskCreate(w, actor, body(req)) },
    { method: 'PATCH', pattern: '/v1/tasks/:id', handle: (req, w, actor, p) => port.taskUpdate(w, actor, p.id!, body(req)) },
    { method: 'POST', pattern: '/v1/tasks/:id/complete', handle: (_req, w, actor, p) => port.taskComplete(w, actor, p.id!) },
    { method: 'PUT', pattern: '/v1/tasks/:id/note', handle: textField('note') },
    { method: 'PUT', pattern: '/v1/tasks/:id/description', handle: textField('description') },
    { method: 'PUT', pattern: '/v1/tasks/:id/summary', handle: textField('summary') },
    // Focus: pinned and its tier are task fields.
    { method: 'POST', pattern: '/focus/tasks/:id', handle: pin(true) },
    { method: 'DELETE', pattern: '/focus/tasks/:id', handle: pin(false) },
    { method: 'PUT', pattern: '/focus/tasks/:id/tier', handle: tier },
    { method: 'PUT', pattern: '/focus/reorder', handle: reorder },
    { method: 'POST', pattern: '/v1/focus/tasks/:id', handle: pin(true) },
    { method: 'DELETE', pattern: '/v1/focus/tasks/:id', handle: pin(false) },
    { method: 'PUT', pattern: '/v1/focus/tasks/:id/tier', handle: tier },
    { method: 'PUT', pattern: '/v1/focus/reorder', handle: reorder },
    // Boards.
    { method: 'PUT', pattern: '/v1/tasks/:id/board', handle: board('board_set', (b) => ({ html: b.html, ...(typeof b.version === 'number' ? { version: b.version } : {}) })) },
    { method: 'POST', pattern: '/v1/tasks/:id/board/edits', handle: board('board_edit', (b) => ({ edits: b.edits, ...(typeof b.version === 'number' ? { version: b.version } : {}) })) },
    { method: 'POST', pattern: '/v1/tasks/:id/board/threads/:thread', handle: board('board_post', (b, p) => ({ thread: p.thread, text: b.text })) },
    { method: 'PUT', pattern: '/v1/tasks/:id/board/projects/:project', handle: board('board_project_set', (b, p) => ({ ...b, id: p.project })) },
    // Sessions that run on this host.
    { method: 'POST', pattern: '/v1/sessions/:id/messages', handle: send },
    { method: 'POST', pattern: '/sessions/:id/permission', handle: permission },
    { method: 'POST', pattern: '/v1/sessions/:id/permission', handle: permission },
    // A device's own sign-out.
    { method: 'DELETE', pattern: '/devices/:name', handle: revoke },
  ]

  return (req: Request, res: Response, next: NextFunction): void => {
    const w = req.replicaWrite
    if (!w) { next(); return }
    const method = req.method.toUpperCase()
    let hit: { row: Row; params: Record<string, string> } | null = null
    for (const row of rows) {
      if (row.method !== method) continue
      const params = match(row.pattern, req.path)
      if (params) { hit = { row, params }; break }
    }
    const answer = (a: PortAnswer) => {
      if (a.answered || res.headersSent) return
      if (a.status === 503 || a.status === 429) {
        const retry = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
        if (typeof retry === 'number') res.setHeader('retry-after', String(retry))
      }
      res.status(a.status).json(a.body)
    }
    if (!hit) {
      deps.log('warn', 'replica: an away write has no handler here', { method, path: req.path, opId: w.opId })
      answer(needsLeaderAnswer('needs_mac', 'This needs your Mac, which is not answering right now.'))
      return
    }
    const actor = deps.actorOf(req)
    if (!actor) {
      // A device copy row with no stable id (an older Mac sent none): the Mac could not check it later.
      answer(needsLeaderAnswer('device_changes_need_mac', 'This device is not known to this host by its id yet; it needs your Mac.'))
      return
    }
    hit.row.handle(req, w, actor, hit.params).then(answer, (err: unknown) => {
      deps.log('warn', 'replica: an away write failed', { method, path: req.path, opId: w.opId, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) answer(refusalAnswer('internal', 'This host could not keep the change.'))
    })
  }
}

/** The patterns this router answers (the route table's WP10 rows name the same; route-table tests compare). */
export const AWAY_WRITE_PATTERNS: ReadonlyArray<{ method: string; pattern: string }> = [
  { method: 'POST', pattern: '/api/tasks' }, { method: 'PATCH', pattern: '/api/tasks/:id' },
  { method: 'POST', pattern: '/api/tasks/:id/complete' }, { method: 'POST', pattern: '/api/tasks/:id/toggle-complete' },
  { method: 'PUT', pattern: '/api/tasks/:id/note' }, { method: 'PUT', pattern: '/api/tasks/:id/description' }, { method: 'PUT', pattern: '/api/tasks/:id/summary' },
  { method: 'POST', pattern: '/api/v1/tasks' }, { method: 'PATCH', pattern: '/api/v1/tasks/:id' },
  { method: 'POST', pattern: '/api/v1/tasks/:id/complete' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/note' }, { method: 'PUT', pattern: '/api/v1/tasks/:id/description' }, { method: 'PUT', pattern: '/api/v1/tasks/:id/summary' },
  { method: 'POST', pattern: '/api/focus/tasks/:id' }, { method: 'DELETE', pattern: '/api/focus/tasks/:id' }, { method: 'PUT', pattern: '/api/focus/tasks/:id/tier' },
  { method: 'PUT', pattern: '/api/focus/reorder' }, { method: 'PUT', pattern: '/api/v1/focus/reorder' },
  { method: 'POST', pattern: '/api/v1/focus/tasks/:id' }, { method: 'DELETE', pattern: '/api/v1/focus/tasks/:id' }, { method: 'PUT', pattern: '/api/v1/focus/tasks/:id/tier' },
  { method: 'PUT', pattern: '/api/v1/tasks/:id/board' }, { method: 'POST', pattern: '/api/v1/tasks/:id/board/edits' },
  { method: 'POST', pattern: '/api/v1/tasks/:id/board/threads/:thread' }, { method: 'PUT', pattern: '/api/v1/tasks/:id/board/projects/:project' },
  { method: 'POST', pattern: '/api/v1/sessions/:id/messages' }, { method: 'POST', pattern: '/api/sessions/:id/permission' },
  { method: 'POST', pattern: '/api/v1/sessions/:id/permission' },
  { method: 'DELETE', pattern: '/api/devices/:name' },
]
