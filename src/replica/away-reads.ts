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
 *   GET /tasks/bulk                                 each projected row folded; a task
 *                                                   made here projected, not "not found"
 *   GET /v1/tasks/:id/sessions                      a task made here: its sessions here
 *   GET /sessions/:id, /v1/sessions/:id,            the live state of the sessions started
 *       /sessions/task/:taskId                      here is read first; the route answers
 *   GET /tasks/:id/<any other>, /v1/...             a task made here that the route cannot
 *                                                   find: 503 needs_leader, never "not found"
 *   GET /v1/sessions                                this host's sessions with their live state
 *                                                   (follower.sessions), a task made here named
 *   GET /v1/search                                  the tasks made here that match, first
 *   GET /v1/status, from this host's own call       walnut_status with `away`: the leader is away,
 *                                                   what waits for it, the ops answered here
 *                                                   (away-op-decisions.ts)
 *
 * A task whose session this host started alone (away-starts.ts, ask-launch.ts) carries that
 * session as the Mac will link it (overlay.ts folds it: task-row-fold.ts foldAwayStart), with
 * its live state read first (`fresh`). A row only the overlay holds (a task made here) gets the
 * Mac's session enrichment on the reads where the Mac's route gives it (`enrich`: GET /tasks/:id
 * and the GET /tasks list, tasks.ts enrichTasksWithSessionStatus), so task_get says what its
 * session does in the Mac's words (execution running, idle, waiting).
 *
 * A row or Board with a write still on its way carries `replica_sync`:
 * `pending` (in the journal) or `awaiting` (the Mac took it, its copy round has
 * not come yet). The console shows "Syncs when your Mac is back" on it. An
 * answer the Mac makes never carries the field, so the Mac's DOM is unchanged.
 */

import { isInboxProject } from '../core/inbox-project.js'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createBoardOffline, type OfflineSliceBoard } from '../providers/offline-board-core.js'
import type { Overlay } from './overlay.js'
import { createdRow } from './write-port.js'
import { NEEDS_LEADER_HEADERS, needsLeaderBody } from '../core/replication/needs-leader.js'
import { awayStatus, withHostSessions, withTasksMadeHere } from './away-read-folds.js'
import type { HostSessionsNow } from './ask-launch.js'

export const SYNC_FIELD = 'replica_sync'

export interface AwayReadsDeps {
  overlay: Overlay
  /** Whether this answer is made from the copies (the dispatcher's answered-via header). */
  answeredAway(res: Response): boolean
  /** How long a read waits for the daemon's pending records at most. */
  refreshWaitMs?: number
  /** The live state of the sessions this host started alone (ask-launch.ts fresh); absent: as last known. */
  fresh?(): Promise<void>
  /** Whether a session (by id), or a task (by id) through one of its sessions, is one this replica started alone and the copy does not hold. */
  awayHere?(kind: 'session' | 'task', id: string): boolean
  /** The Mac's session enrichment of task rows (tasks.ts enrichTasksWithSessionStatus); absent: rows as folded. */
  enrich?(rows: Row[]): Promise<Row[]>
  /** The sessions a task held, as the Mac's route answers them (engine-switch-v1.ts taskSessionsAnswer). */
  taskSessions?(task: Row): Promise<Record<string, unknown>>
  /** The Mac's name for this host: walnut_status says who answers, the session list whose live state is read here. */
  hostKey?: string | null
  /** The live state of every session of this Walnut on this host (follower.sessions), by id; null: not known now. */
  hostSessions?(): Promise<HostSessionsNow | null>
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
  // A filter of '' or `Inbox` is the Inbox, which a row says either way (older rows say '').
  if (project !== undefined && (isInboxProject(project) ? !isInboxProject(String(row.project ?? '')) : String(row.project ?? '') !== project)) return false
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
    const folded = overlay.taskForReaders(r.id, r) as Row | null
    out.push(folded ?? r)
  }
  // A plugin's own task (Task.plugin_only) is in no general list, as on the Mac (tasks.ts
  // hidePluginOnly, api-v1.ts phoneListedTasks): only a console list naming its ids gets it.
  const keptShown = req.path !== '/v1/tasks' && q(req, 'ids') !== undefined
  for (const id of overlay.createdTaskIds()) {
    if (seen.has(id)) continue
    const row = overlay.taskForReaders(id, null) as Row | null
    if (row && row.plugin_only && !keptShown) continue
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
  const pub = (body.board ?? null) as { html?: string; version?: number; updated_at?: string; updated_by?: string; updated_session_id?: string; html_sources?: OfflineSliceBoard['html_sources'] } | null
  let board: OfflineSliceBoard | undefined = pub && typeof pub.html === 'string'
    ? { taskId, html: pub.html, version: Number(pub.version) || 0, ...(typeof pub.updated_at === 'string' ? { updated_at: pub.updated_at } : {}), ...(typeof pub.updated_by === 'string' ? { updated_by: pub.updated_by } : {}), ...(typeof pub.updated_session_id === 'string' ? { updated_session_id: pub.updated_session_id } : {}), ...(Array.isArray(pub.html_sources) ? { html_sources: pub.html_sources } : {}), threads: { ...(body.threads as Record<string, never> ?? {}) }, marks: { ...(body.marks as Record<string, never> ?? {}) }, projects: { ...(body.projects as Record<string, never> ?? {}) }, choices: { ...(body.choices as Record<string, never> ?? {}) } }
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
    board: { html: board.html, version: board.version, ...(board.updated_at ? { updated_at: board.updated_at } : {}), ...(board.updated_by ? { updated_by: board.updated_by } : {}), ...(board.updated_session_id ? { updated_session_id: board.updated_session_id } : {}), ...(board.html_sources ? { html_sources: board.html_sources } : {}) },
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
      const row = createdRow(id, (r.fields ?? {}) as Record<string, unknown>, placement, e.at, r.actor)
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

/**
 * A bulk answer (tasks.ts GET /tasks/bulk, task-bulk-get.ts) with the overlay folded in: a row
 * keeps the fields it projects, with the folded values; an id that matched nothing in the copy
 * and names a task made here is projected from its folded row by the Mac's own projection.
 */
export function overlayBulk(body: Record<string, unknown>, overlay: Overlay, project: (row: Row, fields: string[]) => Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.tasks)) return body
  const fields = Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === 'string') : []
  let errors = 0
  const tasks = (body.tasks as Array<Record<string, unknown>>).map((item) => {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!id) return item
    if (typeof item.error === 'string') {
      const made = item.error === 'not found' ? overlay.taskForReaders(id, null) as Row | null : null
      if (!made) { errors++; return item }
      const mark = made[SYNC_FIELD]
      return { ...project(made, fields), ...(mark ? { [SYNC_FIELD]: mark } : {}) }
    }
    const folded = overlay.taskForReaders(id, item as Row)
    if (!folded || folded === item) return item
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(item)) out[k] = folded[k]
    if (folded[SYNC_FIELD]) out[SYNC_FIELD] = folded[SYNC_FIELD]
    return out
  })
  return { ...body, tasks, ...(typeof body.errors === 'number' ? { errors } : {}) }
}

const STATUS_PATH = '/v1/status'
const SESSIONS_LIST_PATH = '/v1/sessions'
const SEARCH_PATH = '/v1/search'

const FOCUS_PATHS = new Set(['/focus/tasks', '/v1/focus/tasks'])
const LIST_PATHS = new Set(['/tasks', '/tasks/enriched', '/v1/tasks'])
const ONE_RE = /^\/(?:v1\/)?tasks\/([^/]+)$/
const BOARD_RE = /^\/v1\/tasks\/([^/]+)\/board$/
const BULK_PATH = '/tasks/bulk'
/** The sessions a task held (engine-switch-v1.ts, task_history's `sessions`). */
const SESSIONS_RE = /^\/v1\/tasks\/([^/]+)\/sessions$/
/** Any other read of one task: a task made here that its route cannot find needs the Mac (a 404 would say it does not exist). */
const SUB_RE = /^\/(?:v1\/)?tasks\/([^/]+)\/(?!board(?:\/|$)).+$/
/** A session's record, by id (not a session's own data: away-session-reads.ts), and a task's session list. */
const SESSION_RECORD_RE = /^\/(?:v1\/)?sessions\/([^/]+)$/
const TASK_SESSIONS_RE = /^\/sessions\/task\/([^/]+)$/
const decodeOr = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
/** Collection paths the one-task patterns would take for an id. */
const NOT_IDS = new Set(['enriched', 'bulk', 'groups', 'board-counts', 'meta', 'suggest-accuracy', 'reorder'])
/** The reads whose Mac route enriches its rows with their sessions' status (tasks.ts). */
const ENRICHED_PATHS = new Set(['/tasks'])
const ENRICHED_ONE_RE = /^\/tasks\/([^/]+)$/
export const TASK_MADE_HERE_NEEDS_MAC = 'task_made_here_needs_mac'

/** The Mac's bulk projection (task-bulk-get.ts), loaded once a bulk read is folded. */
let bulkProject: ((row: Row, fields: string[]) => Record<string, unknown>) | null = null
async function loadBulkProject(): Promise<(row: Row, fields: string[]) => Record<string, unknown>> {
  if (!bulkProject) {
    const { bulkGetFromTasks } = await import('../core/task-bulk-get.js')
    bulkProject = (row, fields) => bulkGetFromTasks([row.id], [row as never], fields.length ? fields : undefined).items[0] as Record<string, unknown>
  }
  return bulkProject
}

export function awayReads(deps: AwayReadsDeps): RequestHandler {
  const waitMs = deps.refreshWaitMs ?? 1_500
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' || !deps.answeredAway(res)) { next(); return }
    const path = req.path
    // The record of a session this replica started alone, or the sessions of a task with one
    // (sessions.ts, session-lifecycle-v1.ts): its live state first, then the route answers as it
    // does. Any other session read answers at once.
    const taskSessions = TASK_SESSIONS_RE.exec(path)
    const record = taskSessions ? null : SESSION_RECORD_RE.exec(path)
    if (taskSessions || record) {
      const id = (taskSessions ?? record)![1]!
      const ours = taskSessions ? deps.awayHere?.('task', decodeOr(id)) : deps.awayHere?.('session', decodeOr(id))
      if (!ours || !deps.fresh) { next(); return }
      const t = new Promise<void>((r) => { const h = setTimeout(r, waitMs); h.unref?.() })
      void Promise.race([deps.fresh().catch(() => {}), t]).then(() => next(), () => next())
      return
    }
    // walnut_status from this host's own call (a session's or a plugin job's): it says the leader is
    // away, what waits for it, and what answers here (the daemon's own away status said as much).
    if (path === STATUS_PATH && (req.get?.('x-walnut-caller-sid') || req.get?.('x-walnut-plugin-id'))) {
      const t = new Promise<void>((r) => { const h = setTimeout(r, waitMs); h.unref?.() })
      void Promise.race([deps.overlay.refresh(1_000), t]).then(() => {
        const json = res.json.bind(res)
        res.json = ((b: unknown) => (b && typeof b === 'object' && !Array.isArray(b) && res.statusCode < 300
          ? json({ ...(b as Record<string, unknown>), away: awayStatus(deps) })
          : json(b))) as Response['json']
        next()
      }, () => next())
      return
    }
    // The session list (session_list, the phone's list): this host's sessions say what they do now.
    if (path === SESSIONS_LIST_PATH && deps.hostSessions) {
      // The route would filter `status` on the copy's states, before the fold: the fold applies it.
      const status = typeof req.query?.status === 'string' && req.query.status ? req.query.status : undefined
      if (status) {
        const { status: _status, ...rest } = req.query
        Object.defineProperty(req, 'query', { value: rest, configurable: true, enumerable: true, writable: true })
      }
      const t = new Promise<null>((r) => { const h = setTimeout(() => r(null), waitMs); h.unref?.() })
      const live = deps.hostSessions().catch(() => null)
      void Promise.race([Promise.all([live, deps.overlay.refresh(1_000)]).then(([m]) => m), t]).then((m) => {
        const json = res.json.bind(res)
        res.json = ((b: unknown) => json(res.statusCode < 300 ? withHostSessions(b, m, deps, status) : b)) as Response['json']
        next()
      }, () => next())
      return
    }
    // search: the tasks made here that the search copy does not hold yet.
    if (path === SEARCH_PATH) {
      const t = new Promise<void>((r) => { const h = setTimeout(r, waitMs); h.unref?.() })
      void Promise.race([deps.overlay.refresh(1_000), t]).then(() => {
        const json = res.json.bind(res)
        res.json = ((b: unknown) => json(res.statusCode < 300 ? withTasksMadeHere(b, req.query, deps.overlay) : b)) as Response['json']
        next()
      }, () => next())
      return
    }
    const bulk = path === BULK_PATH
    const one = LIST_PATHS.has(path) || bulk ? null : ONE_RE.exec(path)
    const boardHit = BOARD_RE.exec(path)
    const focus = FOCUS_PATHS.has(path)
    const sessionsHit = SESSIONS_RE.exec(path)
    const sub = !boardHit && !sessionsHit ? SUB_RE.exec(path) : null
    if (!LIST_PATHS.has(path) && !one && !boardHit && !focus && !bulk && !sessionsHit && !sub) { next(); return }
    const idOf = one ?? sessionsHit ?? sub
    if (idOf && NOT_IDS.has(idOf[1]!)) { next(); return }
    const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
    const enrichHere = !!deps.enrich && (ENRICHED_PATHS.has(path) || ENRICHED_ONE_RE.test(path))
    // Never longer than `waitMs`: a slow daemon leaves the answer as the copy has it.
    const ready = Promise.all([
      deps.overlay.refresh(1_000),
      deps.fresh?.().catch(() => {}),
      bulk ? loadBulkProject() : undefined,
    ])
    const fresh = Promise.race([ready, new Promise<void>((r) => { const t = setTimeout(r, waitMs); t.unref?.() })])
    fresh.then(() => {
      const json = res.json.bind(res)
      /** An answer made after the route's (its words as given when that fails). */
      const later = (make: () => Promise<unknown>, fallback: unknown): Response => {
        make().then((b) => { if (!res.headersSent) json(b) }, () => { if (!res.headersSent) json(fallback) })
        return res
      }
      /** Rows only the overlay holds, with the Mac's session enrichment, then the answer (its rows as folded when that fails). */
      const sendEnriched = (rows: Row[], answer: (enriched: Row[]) => unknown, fallback: unknown): Response => {
        if (!enrichHere || !rows.length) return json(fallback)
        return later(async () => answer(await deps.enrich!(rows)), fallback)
      }
      res.json = ((b: unknown) => {
        try {
          if (!b || typeof b !== 'object' || Array.isArray(b)) return json(b)
          const out = { ...(b as Record<string, unknown>) }
          if (bulk) return json(res.statusCode < 300 && bulkProject ? overlayBulk(out, deps.overlay, bulkProject) : out)
          if (boardHit) {
            // `?team=1` answers the team owner's Board (board-v1.ts board_task_id), and the
            // console writes to that id, so the overlay is keyed by it, not by the URL's task.
            const owner = typeof out.board_task_id === 'string' && out.board_task_id ? out.board_task_id : decode(boardHit[1]!)
            return json(res.statusCode < 300 ? overlayBoard(owner, out, deps.overlay) : out)
          }
          if (focus) return json(res.statusCode < 300 ? overlayTiers(out, deps.overlay) : out)
          // A task made here is not in the copy its route reads: answered from the overlay, or the Mac's.
          const made = idOf && res.statusCode === 404 ? deps.overlay.taskForReaders(decode(idOf[1]!), null) as Row | null : null
          if (sessionsHit) {
            if (!made || !deps.taskSessions) return json(out)
            res.status(200)
            return later(() => deps.taskSessions!(made), out)
          }
          if (sub) {
            if (!made) return json(out)
            res.status(503)
            for (const [k, v] of Object.entries(NEEDS_LEADER_HEADERS)) res.setHeader(k, v)
            return json(needsLeaderBody(TASK_MADE_HERE_NEEDS_MAC, 'This task was made here while your Mac is away; this part of it needs your Mac.'))
          }
          if (one) {
            const id = decode(one[1]!)
            if (res.statusCode === 404) {
              if (!made) return json(out)
              res.status(200)
              return sendEnriched([made], (e) => ({ task: e[0] ?? made }), { task: made })
            }
            if (out.task && typeof out.task === 'object') out.task = deps.overlay.taskForReaders(id, out.task as Row) ?? out.task
            return json(out)
          }
          if (Array.isArray(out.tasks)) {
            const fromCopy = new Set((out.tasks as Row[]).map((r) => r?.id))
            const tasks = overlayList(req, out.tasks as Row[], deps.overlay)
            out.tasks = tasks
            const added = tasks.filter((r) => r && !fromCopy.has(r.id))
            // The route counted the copy's matches (`total`, before its limit): this host's own rows count too.
            if (added.length && typeof out.total === 'number') out.total += added.length
            return sendEnriched(added, (e) => {
              const byId = new Map(e.map((r) => [r.id, r]))
              return { ...out, tasks: tasks.map((r) => (r && byId.get(r.id)) || r) }
            }, out)
          }
          return json(out)
        } catch {
          return json(b)
        }
      }) as Response['json']
      next()
    }, () => next())
  }
}
