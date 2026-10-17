/**
 * Reads over the overlay on a host replica (docs/plan/walnut-replica-servers-impl.md,
 * sections 4 and 5; WP10): an answer made from the copies while the Mac is away
 * shows every write this host's journal holds (overlay.ts) and its mark.
 *
 * Mounted on a host replica only. It touches an answer only when the dispatcher
 * answered it from the copies (x-walnut-answered-via: replica), and only the
 * reads a person sees a task or a Board through:
 *
 *   GET /tasks, /tasks/enriched, /v1/tasks          each row folded, tasks made
 *                                                   here added (when the query's
 *                                                   filters are ones this file
 *                                                   can check); the copy's order
 *   GET /tasks/:id, /v1/tasks/:id                   the row folded; a task made
 *                                                   here answers 200, not 404
 *   GET /v1/tasks/:id/board[?team=1]                the Board it answers (the team
 *                                                   owner's) with its records
 *   GET /focus/tasks, /v1/focus/tasks               the Focus bar with pins, tier
 *                                                   changes and moves folded in
 *
 * A row or Board with a write still on its way carries `replica_sync`:
 * `pending` (in the journal) or `awaiting` (the Mac took it, its copy round has
 * not come yet). The console shows "Syncs when your Mac is back" on it. An
 * answer the Mac makes never carries the field, so the Mac's DOM is unchanged.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createBoardOffline, type OfflineSliceBoard } from '../providers/offline-board-core.js'
import type { Overlay } from './overlay.js'
import { createdRow, madeByHuman } from './write-port.js'

export const SYNC_FIELD = 'replica_sync'

export interface AwayReadsDeps {
  overlay: Overlay
  /** Whether this answer is made from the copies (the dispatcher's answered-via header). */
  answeredAway(res: Response): boolean
  /** How long a read waits for the daemon's pending records at most. */
  refreshWaitMs?: number
}

type Row = Record<string, unknown> & { id: string }

const BOARD_KIT = createBoardOffline()

function q(req: Request, key: string): string | undefined {
  const v = req.query[key]
  const s = Array.isArray(v) ? v[0] : v
  return typeof s === 'string' ? s : undefined
}

/**
 * Whether a task made here belongs in this list: true only when every filter the
 * query names is one checked here (ids, project, pinned, working_set, phase,
 * focus_tier, and a completed window, which a new task is always in); a list with any
 * other filter (a search, tags, a sprint) leaves it out.
 */
export function createdMatches(req: Request, row: Row): boolean {
  // completedWithinDays only drops completed tasks older than its window: a task made here is new.
  const known = new Set(['ids', 'project', 'pinned', 'working_set', 'phase', 'focus_tier', 'fields', 'limit', 'include_completed', 'slim', 'completedWithinDays'])
  for (const k of Object.keys(req.query)) if (!known.has(k)) return false
  const ids = q(req, 'ids')
  if (ids !== undefined && !ids.split(',').includes(row.id)) return false
  const project = q(req, 'project')
  if (project !== undefined && String(row.project ?? '') !== project) return false
  const pinned = q(req, 'pinned') ?? (q(req, 'working_set') === 'true' ? 'true' : undefined)
  if (pinned !== undefined && Boolean(row.pinned) !== (pinned === 'true')) return false
  const phase = q(req, 'phase')
  if (phase !== undefined && !phase.split(',').includes(String(row.phase ?? ''))) return false
  const tier = q(req, 'focus_tier')
  if (tier !== undefined && !tier.split(',').includes(String(row.focus_tier ?? ''))) return false
  return true
}

/** A list answer with the overlay folded in. */
export function overlayList(req: Request, rows: Row[], overlay: Overlay): Row[] {
  const out: Row[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!r || typeof r.id !== 'string') { out.push(r); continue }
    seen.add(r.id)
    const folded = overlay.task(r.id, r) as Row | null
    out.push(folded ?? r)
  }
  for (const id of overlay.createdTaskIds()) {
    if (seen.has(id)) continue
    const row = overlay.task(id, null) as Row | null
    if (row && createdMatches(req, row)) { out.unshift(row); seen.add(id) }
  }
  // No moves here: a move's anchor is a place in the pinned order (the Focus bar,
  // overlayTiers), and means nothing in a project's or a search's list.
  return out
}

/** A Board answer with the overlay's records applied (the kit the daemon checks writes with). */
export function overlayBoard(taskId: string, body: Record<string, unknown>, overlay: Overlay): Record<string, unknown> {
  const records = overlay.boardRecords(taskId)
  if (!records.length) return body
  // A kanban-only answer (?fields=kanban) carries no document: it gets the mark alone.
  if (!('board' in body)) {
    const m = overlay.markOf('boards', taskId)
    return m ? { ...body, [SYNC_FIELD]: m } : body
  }
  const pub = (body.board ?? null) as { html?: string; version?: number; updated_at?: string; updated_by?: string } | null
  let board: OfflineSliceBoard | undefined = pub && typeof pub.html === 'string'
    ? { taskId, html: pub.html, version: Number(pub.version) || 0, ...(typeof pub.updated_at === 'string' ? { updated_at: pub.updated_at } : {}), ...(typeof pub.updated_by === 'string' ? { updated_by: pub.updated_by } : {}), threads: { ...(body.threads as Record<string, never> ?? {}) }, marks: { ...(body.marks as Record<string, never> ?? {}) }, projects: { ...(body.projects as Record<string, never> ?? {}) }, choices: { ...(body.choices as Record<string, never> ?? {}) } }
    : undefined
  for (const r of records) {
    const op = String(r.op ?? '')
    const args = (r.args ?? {}) as Record<string, unknown>
    const actor = r.actor as { kind?: string; name?: string; deviceId?: string } | undefined
    const by = actor?.kind === 'device' ? `device:${actor.name ?? actor.deviceId}` : 'task:'
    const postId = typeof r.postId === 'string' ? r.postId : `bm-offline-${r.seq}`
    try { board = BOARD_KIT.apply(board, op, args, by, new Date(r.at).toISOString(), taskId, () => postId) } catch { /* a record the kit cannot apply shows nothing */ }
  }
  if (!board) return body
  // A post a person made here reads as theirs (the kit names the device).
  const threads: Record<string, unknown> = {}
  for (const [t, list] of Object.entries(board.threads ?? {})) {
    threads[t] = (list ?? []).map((m) => (m.author.startsWith('device:') ? { ...m, author: 'user' } : m))
  }
  const mark = overlay.markOf('boards', taskId)
  return {
    ...body,
    board: { html: board.html, version: board.version, ...(board.updated_at ? { updated_at: board.updated_at } : {}), ...(board.updated_by ? { updated_by: board.updated_by } : {}) },
    threads, marks: board.marks ?? {}, projects: board.projects ?? {}, choices: board.choices ?? {},
    board_version: board.version,
    ...(mark ? { [SYNC_FIELD]: mark } : {}),
  }
}

/** The Focus bar's tiers (task-manager.ts TierResult), as GET /api/focus/tasks answers them. */
export interface TierBody {
  pinned_tasks: string[]
  focus_tasks: string[]
  satellite_tasks: string[]
  backlog_tasks: string[]
  wait_tasks: string[]
  custom_tier_tasks: Record<string, string[]>
  [k: string]: unknown
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * The Focus bar with the overlay folded in: pins and unpins, tier changes and moves
 * still on their way to the Mac, one record at a time in seq order, as the Mac's
 * drain applies them (offline-merge/apply-v2.ts: a move places a pinned task at its
 * anchor, a missing anchor appends it at the end; a pin appends). The split is
 * task-manager.ts splitTiers': satellite is every pinned task in no other
 * registered tier.
 */
export function overlayTiers(body: Record<string, unknown>, overlay: Overlay): TierBody {
  const custom = (body.custom_tier_tasks && typeof body.custom_tier_tasks === 'object' ? body.custom_tier_tasks : {}) as Record<string, unknown>
  const customIds = Object.keys(custom)
  const tierOf = new Map<string, string | undefined>()
  for (const id of ids(body.focus_tasks)) tierOf.set(id, 'focus')
  for (const id of ids(body.wait_tasks)) tierOf.set(id, 'wait')
  for (const t of customIds) for (const id of ids(custom[t])) tierOf.set(id, t)
  let pinned = ids(body.pinned_tasks)
  const records = overlay.entries().filter((e) => e.kind.startsWith('task-') && typeof e.record.taskId === 'string').sort((a, b) => a.seq - b.seq)
  for (const e of records) {
    const id = e.record.taskId as string
    const r = e.record
    if (e.kind === 'task-create') {
      // A task made away lands where the Mac's create puts it: pinned (a person's default,
      // or a tier) at the bottom of the board, in its tier.
      const placement = (r.placement ?? {}) as { tier?: string }
      const row = createdRow(id, (r.fields ?? {}) as Record<string, unknown>, placement, e.at, madeByHuman(r.actor))
      if (row.pinned === true && !pinned.includes(id)) {
        pinned = [...pinned, id]
        tierOf.set(id, typeof placement.tier === 'string' && placement.tier ? placement.tier : undefined)
      }
      continue
    }
    const fields = (e.kind === 'task-fields' ? r.fields : null) as Record<string, { value?: unknown }> | null
    const tier = e.kind === 'task-move' ? r.tier : fields?.focus_tier ? fields.focus_tier.value : undefined
    if (e.kind === 'task-move' ? typeof tier === 'string' : !!fields?.focus_tier) tierOf.set(id, typeof tier === 'string' && tier ? tier : undefined)
    if (fields?.pinned) {
      if (fields.pinned.value === true && !pinned.includes(id)) pinned = [...pinned, id]
      if (fields.pinned.value !== true) pinned = pinned.filter((x) => x !== id)
    }
    const anchor = (e.kind === 'task-move' ? r.anchor : null) as { after?: string; before?: string } | null
    if (anchor && pinned.includes(id)) {
      const rest = pinned.filter((x) => x !== id)
      const ref = anchor.after ?? anchor.before
      const at = ref ? rest.indexOf(ref) : -1
      if (at === -1) rest.push(id)
      else rest.splice(anchor.after ? at + 1 : at, 0, id)
      pinned = rest
    }
  }
  const inTier = (t: string) => pinned.filter((id) => tierOf.get(id) === t)
  return {
    ...body,
    pinned_tasks: pinned,
    focus_tasks: inTier('focus'),
    satellite_tasks: pinned.filter((id) => { const t = tierOf.get(id); return !(t === 'focus' || t === 'wait' || (t !== undefined && customIds.includes(t))) }),
    backlog_tasks: [],
    wait_tasks: inTier('wait'),
    custom_tier_tasks: Object.fromEntries(customIds.map((t) => [t, inTier(t)])),
  }
}

const FOCUS_PATHS = new Set(['/focus/tasks', '/v1/focus/tasks'])
const LIST_PATHS = new Set(['/tasks', '/tasks/enriched', '/v1/tasks'])
const ONE_RE = /^\/(?:v1\/)?tasks\/([^/]+)$/
const BOARD_RE = /^\/v1\/tasks\/([^/]+)\/board$/

export function awayReads(deps: AwayReadsDeps): RequestHandler {
  const waitMs = deps.refreshWaitMs ?? 1_500
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' || !deps.answeredAway(res)) { next(); return }
    const path = req.path
    const one = LIST_PATHS.has(path) ? null : ONE_RE.exec(path)
    const boardHit = BOARD_RE.exec(path)
    const focus = FOCUS_PATHS.has(path)
    if (!LIST_PATHS.has(path) && !one && !boardHit && !focus) { next(); return }
    if (one && ['enriched', 'bulk', 'groups', 'board-counts', 'meta', 'suggest-accuracy', 'reorder'].includes(one[1]!)) { next(); return }
    const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
    // Never longer than `waitMs`: a slow daemon leaves the answer as the copy has it.
    const fresh = Promise.race([deps.overlay.refresh(1_000), new Promise<void>((r) => { const t = setTimeout(r, waitMs); t.unref?.() })])
    fresh.then(() => {
      const json = res.json.bind(res)
      res.json = ((b: unknown) => {
        try {
          if (!b || typeof b !== 'object' || Array.isArray(b)) return json(b)
          const out = { ...(b as Record<string, unknown>) }
          if (boardHit) {
            // `?team=1` answers the team owner's Board (board-v1.ts board_task_id), and the
            // console writes to that id, so the overlay is keyed by it, not by the URL's task.
            const owner = typeof out.board_task_id === 'string' && out.board_task_id ? out.board_task_id : decode(boardHit[1]!)
            return json(res.statusCode < 300 ? overlayBoard(owner, out, deps.overlay) : out)
          }
          if (focus) return json(res.statusCode < 300 ? overlayTiers(out, deps.overlay) : out)
          if (one) {
            const id = decode(one[1]!)
            if (res.statusCode === 404) {
              const made = deps.overlay.task(id, null)
              if (made) { res.status(200); return json({ task: made }) }
              return json(out)
            }
            if (out.task && typeof out.task === 'object') out.task = deps.overlay.task(id, out.task as Row) ?? out.task
            return json(out)
          }
          if (Array.isArray(out.tasks)) out.tasks = overlayList(req, out.tasks as Row[], deps.overlay)
          return json(out)
        } catch {
          return json(b)
        }
      }) as Response['json']
      next()
    }, () => next())
  }
}
