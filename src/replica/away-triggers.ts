/**
 * This host's own trigger calls while the Mac is away (task B; away-calls.ts has the others):
 * decided here with the Mac's own rules (trigger-api.ts, trigger-fields.ts, trigger-watches.ts,
 * trigger-label.ts, task-wait-clock.ts) and this replica's copies, then armed and journaled by the
 * daemon through `follower.op` as the very `op` record its own away answer writes
 * (offline-host-core.ts followerCall: armTrigger, opTriggerWrite):
 *
 *   POST   /v1/routines/trigger      trigger_create: the daemon gives the id and arms it at once
 *   PATCH  /v1/routines/:id          trigger_pause / trigger_resume ({enabled} alone); any other
 *                                    change is trigger_update (away-trigger-update.ts)
 *   DELETE /v1/routines/:id          trigger_delete
 *   POST   /v1/routines/check-test   trigger_test: the check run once here (follower.trigger.test)
 *   GET    /v1/routines[/:id]        trigger_list and the read before a pause: the routines copy
 *                                    with this host's own triggers over it (follower.triggers):
 *                                    one made here, a pause, a resume, a delete or a change made here
 *
 * The reads and the test need the daemon's `follower-triggers-v1`; without it the copy answers
 * alone and the test is handed back to the daemon's own away answer.
 *
 * A trigger of a task the Mac keeps local (core/replication/host-private.ts) is in this host's
 * armed set (its check runs here) but in no copy: no list here shows it, and a call naming it is
 * refused as kept-local-calls.ts refuses a call about that task (keptHereTriggerIds).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { OFFLINE_HEADER } from './dispatch.js'
import { fieldBases, needsLeaderAnswer, refusalAnswer, type PortAnswer, type TaskRow, type WriteActor } from './write-port.js'
import { bodyOf, findAwayTask, settleCall, writeAnswer } from './away-calls.js'
import { TRIGGER_DESCRIPTION_MAX, parseEveryMs } from '../core/routines/trigger-fields.js'
import { parseTriggerWatch, TRIGGER_WATCH_INVALID } from '../core/routines/trigger-watches.js'
import { TIME_LIMIT_DEFAULT_S, TIME_LIMIT_MAX_S, testCallTimeoutMs } from '../core/cron/trigger-time-limit.js'
import { parseWaitUntil } from '../core/task-wait-clock.js'
import { log } from '../logging/index.js'
import { namesKeptLocal, refreshLocalTasksHere, type LocalTasksHere } from '../core/replication/kinds/local-tasks.js'
import { rowWithHereChanges, updateHere } from './away-trigger-update.js'

/** The daemon capability the reads and the test ride on. */
export const FOLLOWER_TRIGGERS_CAP = 'follower-triggers-v1'
/** The fires are delivered by the host, so the prompt rides in the def (the daemon's DELIVER_PROMPT_MAX). */
const PROMPT_MAX = 32 * 1024
const MIN_EVERY_MS = 10_000
const READ_TIMEOUT_MS = 3_000
/** Routine routes under /v1/routines that name no routine. */
const NOT_IDS = new Set(['actions', 'status', 'executors', 'draft', 'check-test', 'trigger'])

/** One of this Walnut's triggers on this host, as `follower.triggers` lists it. */
export interface HereTrigger {
  id: string
  state: 'armed' | 'paused' | 'deleted'
  def: { id: string; name: string; everyMs: number; check: { run: string; cwd?: string; timeoutSeconds?: number }; deliver?: { taskId?: string; prompt?: string } }
  status?: { nextRunAtMs?: number; lastRunAtMs?: number; consecutiveErrors?: number; pendingFires?: number }
  created?: boolean
  description?: string
  /** What this host changed (trigger_update's arguments, the later over the earlier). */
  changes?: Record<string, unknown>
}

type Job = Record<string, unknown>

export interface AwayTriggersDeps {
  actorOf(req: Request): WriteActor | null
  hostKey: string | null
  capabilities(): readonly string[] | null
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  findTask(ref: string): Promise<TaskRow | null>
  /** The calling session's row here (its task and folder), or null. */
  session(sid: string): Promise<{ taskId?: string | null; cwd?: string | null } | null>
  /** The routines copy (with each routine's owner), or null when this replica holds none. */
  copyJobs(includeDisabled: boolean): Promise<Job[] | null>
  /** The server's trigger label (trigger-label.ts). */
  label(input: { name?: unknown; description?: unknown; prompt?: unknown; run?: unknown }): string
  /** What this host's copy says the Mac keeps local (kinds/local-tasks.ts, the one local-calls.ts reads); absent: that copy. */
  localTasks?(): Promise<LocalTasksHere>
  now?(): number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A trigger of this host as the routine row the server lists (the copy's own row when it has one). */
export function withHere(job: Job | null, t: HereTrigger, host: string, now: number): Job {
  const def = t.def
  const made: Job = job ?? {
    id: def.id, name: def.name, ...(t.description ? { description: t.description } : {}),
    schedule: { kind: 'every', everyMs: def.everyMs },
    check: { run: def.check.run, ...(def.check.cwd ? { cwd: def.check.cwd } : {}), host, timeoutSeconds: def.check.timeoutSeconds ?? TIME_LIMIT_DEFAULT_S },
    executor: { type: 'session', config: { ...(def.deliver?.taskId ? { target: def.deliver.taskId } : {}), ...(def.deliver?.prompt ? { prompt: def.deliver.prompt } : {}) } },
    state: {},
  }
  // A change made here, with the Mac's own merge (away-trigger-update.ts).
  const base = rowWithHereChanges(made, def, t.changes, (msg, data) => log.web.warn(msg, data))
  const state: Record<string, unknown> = { ...((base.state as Record<string, unknown> | undefined) ?? {}) }
  const s = t.status
  if (typeof s?.nextRunAtMs === 'number') state.nextRunAtMs = s.nextRunAtMs
  if (typeof s?.lastRunAtMs === 'number') state.lastRunAtMs = s.lastRunAtMs
  if (typeof s?.consecutiveErrors === 'number') state.consecutiveErrors = s.consecutiveErrors
  // Fires this host delivered that the Mac has not counted yet (2026-11-21 real host run: `fires: 0` after one).
  if (typeof s?.pendingFires === 'number' && s.pendingFires > 0) state.fireCount = (typeof state.fireCount === 'number' ? state.fireCount : 0) + s.pendingFires
  // Paused here: read as paused (never "stopped"), from when this host says so.
  if (t.state === 'paused' && typeof state.pausedAtMs !== 'number') state.pausedAtMs = now
  return { ...base, enabled: t.state === 'armed', state, ...(t.created ? { queued: true } : {}) }
}

/**
 * The triggers of this host's set that are a kept-local task's: one that delivers to it or to one of
 * its sessions, and, while the Mac keeps any task local, one the routines copy withheld (not in the
 * copy, not made here). `copyIds` null: this replica keeps no routines copy, so only the first.
 */
export function keptHereTriggerIds(here: readonly HereTrigger[], copyIds: ReadonlySet<string> | null, kept: LocalTasksHere): Set<string> {
  const out = new Set<string>()
  if (kept.tasks.size === 0) return out
  for (const t of here) {
    const target = t.def?.deliver?.taskId
    if ((typeof target === 'string' && namesKeptLocal(target, kept)) || (copyIds !== null && !copyIds.has(t.id) && !t.created)) out.add(t.id)
  }
  return out
}

/** The routines copy with this host's triggers over it: a delete here gone, one made here added, a kept-local task's left out. */
export function mergeHereTriggers(copy: readonly Job[], here: readonly HereTrigger[], host: string, includeDisabled: boolean, now: number, kept: ReadonlySet<string> = new Set()): Job[] {
  const left = new Map(here.filter((t) => !kept.has(t.id)).map((t) => [t.id, t]))
  const out: Job[] = []
  for (const job of copy) {
    if (kept.has(String(job.id))) continue
    const t = left.get(String(job.id))
    if (!t) { out.push(job); continue }
    left.delete(t.id)
    if (t.state !== 'deleted') out.push(withHere(job, t, host, now))
  }
  for (const t of left.values()) if (t.state !== 'deleted') out.push(withHere(null, t, host, now))
  return includeDisabled ? out : out.filter((j) => j.enabled !== false)
}

/** The words of a call about a kept-local task's trigger (kept-local-calls.ts KEPT_TRIGGER_WORDS). */
export const KEPT_TRIGGER_MESSAGE = 'that trigger belongs to a task kept local on your Mac, so this host does not show or change it. Nothing was done or saved; run it again once your Mac is back.'

type HostTriggerDeps = Pick<AwayTriggersDeps, 'request' | 'copyJobs' | 'localTasks' | 'log'>

const localTasksOf = (deps: Pick<AwayTriggersDeps, 'localTasks'>): Promise<LocalTasksHere> =>
  (deps.localTasks ?? refreshLocalTasksHere)().catch(() => ({ tasks: new Set<string>(), sessions: new Set<string>() }))

/** This host's armed triggers (follower.triggers), and which are a kept-local task's: for the routes here and local-calls.ts. */
export function hostTriggers(deps: HostTriggerDeps) {
  async function hereTriggers(id?: string): Promise<HereTrigger[] | null> {
    try {
      const r = await deps.request('follower.triggers', id ? { triggerId: id } : {}, READ_TIMEOUT_MS)
      return r.ok === false || !Array.isArray(r.triggers) ? null : r.triggers as HereTrigger[]
    } catch (err) {
      deps.log('warn', 'replica: this host\'s triggers could not be read', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }
  /** The kept-local task's triggers among `here`, against the whole routines copy. */
  async function keptOf(here: readonly HereTrigger[], copy?: readonly Job[] | null): Promise<Set<string>> {
    const kept = await localTasksOf(deps)
    if (kept.tasks.size === 0) return new Set()
    const all = copy !== undefined ? copy : await deps.copyJobs(true)
    return keptHereTriggerIds(here, all ? new Set(all.map((j) => String(j.id))) : null, kept)
  }
  /** Whether `id` is a kept-local task's trigger of this host's set (no daemon list: not one). */
  async function keptTrigger(id: string): Promise<boolean> {
    if ((await localTasksOf(deps)).tasks.size === 0) return false
    const t = (await hereTriggers(id))?.find((x) => x.id === id)
    return !!t && (await keptOf([t])).has(id)
  }
  return { hereTriggers, keptOf, keptTrigger }
}

/** The routines copy with each routine's owner, as this replica holds it (null: it keeps none). */
export async function routinesCopyJobs(includeDisabled: boolean): Promise<Job[] | null> {
  const [{ companionRoutinesCopy }, { withRoutineOwners }] = await Promise.all([
    import('../core/replication/kinds/routines-follower.js'), import('../core/routines/routine-owner.js'),
  ])
  const copied = await companionRoutinesCopy({ includeDisabled })
  return copied ? await withRoutineOwners(copied) as unknown as Job[] : null
}

export function awayTriggers(deps: AwayTriggersDeps): RequestHandler {
  const now = deps.now ?? Date.now
  const host = deps.hostKey ?? ''
  const hasCap = () => deps.capabilities()?.includes(FOLLOWER_TRIGGERS_CAP) === true
  const needsMac = (what: string) => needsLeaderAnswer('routine_writes_need_mac', `${what} needs your Mac; nothing was changed.`)

  const { hereTriggers, keptOf, keptTrigger } = hostTriggers(deps)

  const localTasks = (): Promise<LocalTasksHere> => localTasksOf(deps)
  const keptAnswer = (): PortAnswer => refusalAnswer('task_kept_local', KEPT_TRIGGER_MESSAGE, { why: 'task_kept_local' })

  async function list(req: Request): Promise<PortAnswer | null> {
    const here = await hereTriggers()
    if (!here) return null
    const includeDisabled = req.query.includeDisabled === 'true'
    const copy = await deps.copyJobs(includeDisabled)
    if (!copy && !here.length) return null
    // Kept is judged against every routine of the copy, the paused ones too.
    const kept = await keptOf(here, includeDisabled ? copy : undefined)
    return { answered: false, status: 200, body: { jobs: mergeHereTriggers(copy ?? [], here, host, includeDisabled, now(), kept) } }
  }

  async function one(id: string): Promise<PortAnswer | null> {
    const t = (await hereTriggers(id))?.find((x) => x.id === id)
    if (!t) return null
    const copy = await deps.copyJobs(true)
    if ((await keptOf([t], copy)).has(id)) return keptAnswer()
    if (t.state === 'deleted') return refusalAnswer('not_found', `No trigger ${id}: it was deleted on this host`)
    const job = copy?.find((j) => j.id === id) ?? null
    return { answered: false, status: 200, body: { job: withHere(job, t, host, now()) } }
  }

  /** The row a change is made on: as GET answers it (this host's over the copy), else the copy's own. */
  async function rowOf(id: string): Promise<Job | 'deleted' | null> {
    const t = (await hereTriggers(id))?.find((x) => x.id === id)
    if (t?.state === 'deleted') return 'deleted'
    const job = (await deps.copyJobs(true))?.find((j) => j.id === id) ?? null
    return t ? withHere(job, t, host, now()) : job
  }


  async function create(req: Request, w: ReplicaWrite, actor: WriteActor): Promise<PortAnswer> {
    if (actor.kind !== 'session') return needsMac('A trigger a plugin job makes')
    const b = bodyOf(req)
    if (str(b.template)) return needsMac('A template trigger (its check asks your Mac)')
    if (b.id !== undefined) return refusalAnswer('bad_request', 'trigger_create takes no "id": Walnut names the trigger')
    if (str(b.host) && str(b.host) !== host) return needsMac(`A trigger on host "${str(b.host)}"`)
    const run = str(b.run)
    if (!run) return refusalAnswer('bad_request', 'run is required: the shell command that decides whether to fire')
    const prompt = str(b.prompt)
    if (!prompt) return refusalAnswer('bad_request', 'prompt is required: what the session should do when it fires')
    if (prompt.length > PROMPT_MAX) return needsMac('A trigger prompt over 32 KB')
    const description = str(b.description).replace(/\s+/g, ' ')
    if (!description) return refusalAnswer('bad_request', 'description is required: one or two plain sentences saying what this watches, when it fires, and what the session does then')
    if (description.length > TRIGGER_DESCRIPTION_MAX) return refusalAnswer('bad_request', `description is ${description.length} characters; the limit is ${TRIGGER_DESCRIPTION_MAX} (one or two sentences)`)
    const watch = parseTriggerWatch(b.watches)
    if (watch === 'invalid') return refusalAnswer('bad_request', TRIGGER_WATCH_INVALID)
    const watches = watch === null ? null : watch.kind === 'own' ? 'own' : watch.what
    const everyMs = parseEveryMs(b.every)
    if (everyMs === null) return refusalAnswer('bad_request', 'every is required: milliseconds, or a duration like "30s" / "5m" / "1h"')
    if (everyMs < MIN_EVERY_MS) return refusalAnswer('bad_request', `every must be at least ${MIN_EVERY_MS / 1000}s`)
    if (b.wait !== undefined && typeof b.wait !== 'boolean') return refusalAnswer('bad_request', 'wait must be true or false')
    let waitUntil: string | undefined
    try { waitUntil = parseWaitUntil(b.wait_until, now()) } catch (err) { return refusalAnswer('bad_request', err instanceof Error ? err.message : String(err)) }
    const max = b.maxFiresPerDay
    if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 0)) return refusalAnswer('bad_request', 'maxFiresPerDay must be a whole number, 0 or more (0 = no limit)')
    const t = b.timeoutSeconds
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t <= 0)) return refusalAnswer('bad_request', 'timeoutSeconds must be a whole number of seconds')
    const timeoutSeconds = Math.min(TIME_LIMIT_MAX_S, Math.max(1, typeof t === 'number' ? t : TIME_LIMIT_DEFAULT_S))
    // The task its fires go to: the caller's own, or one this replica holds.
    const me = await deps.session(actor.sid)
    const session = str(b.session) || 'this'
    if (session === 'this' && !str(me?.taskId)) return refusalAnswer('bad_request', 'no calling session; pass session: <taskId>')
    const targetRef = session === 'this' ? str(me?.taskId) : session
    // A task the Mac keeps local: this host holds none of it, so it arms nothing for it.
    if (namesKeptLocal(targetRef, await localTasks())) return refusalAnswer('task_kept_local', 'that task is kept local on your Mac, so this host arms no trigger for it. Nothing was done or saved; run it again once your Mac is back.', { why: 'task_kept_local' })
    let task: TaskRow | null
    try { task = await deps.findTask(targetRef) } catch (err) { return refusalAnswer('bad_request', err instanceof Error ? err.message : String(err)) }
    if (!task) return needsLeaderAnswer('target_needs_mac', 'This host does not hold the task the trigger would wake; arming it needs your Mac. Nothing was armed.')
    if (task.phase === 'COMPLETE') return refusalAnswer('bad_request', `task ${task.id} is complete, so a fire could not land there; point the trigger at an open task`)
    const name = deps.label({ name: b.name, description, prompt, run })
    // A park is the session's call, as online: only with wait:true, never for a watch of the user or its own work.
    const park = b.wait === true && !watches ? { ...(waitUntil !== undefined ? { wait_until: waitUntil } : {}) } : null
    const base = park ? fieldBases(task, { phase: 'WAITING', wait_until: null }) : undefined
    const r = await w.submit('trigger_create', {
      run, prompt, description, name, everyMs, taskId: task.id, cwd: str(b.cwd) || str(me?.cwd), timeoutSeconds,
      ...(typeof max === 'number' ? { max } : {}), watches, own: str(me?.taskId) === task.id, ...(park ? { park } : {}),
    }, base, actor)
    const a = settleCall(r, 201)
    if (!a.answered && a.status === 201) deps.log('info', 'replica: a trigger was armed on this host while the Mac is away', { triggerId: a.body.id, taskId: task.id, opId: w.opId })
    return a
  }

  async function change(req: Request, w: ReplicaWrite, actor: WriteActor, id: string): Promise<PortAnswer> {
    if (actor.kind !== 'session') return needsMac('A trigger change by a plugin job')
    if (await keptTrigger(id)) return keptAnswer()
    let op = 'trigger_delete'
    if (req.method.toUpperCase() === 'PATCH') {
      const b = bodyOf(req)
      const keys = Object.keys(b).filter((k) => b[k] !== undefined)
      if (keys.length !== 1 || keys[0] !== 'enabled' || typeof b.enabled !== 'boolean') {
        return updateHere({ hostKey: host, row: rowOf, log: deps.log }, req, w, actor, id)
      }
      op = b.enabled ? 'trigger_resume' : 'trigger_pause'
    }
    return settleCall(await w.submit(op, { id }, undefined, actor), 200)
  }

  async function test(req: Request, actor: WriteActor): Promise<PortAnswer> {
    const b = bodyOf(req)
    if (b.testId !== undefined) return needsLeaderAnswer('needs_mac', 'A check started through your Mac is read through your Mac.')
    const check = (b.check && typeof b.check === 'object' ? b.check : {}) as Record<string, unknown>
    const run = str(check.run)
    if (!run) return refusalAnswer('bad_request', 'check.run is required')
    if (str(check.host) && str(check.host) !== host) return needsMac(`A check on host "${str(check.host)}"`)
    if (!hasCap()) return needsLeaderAnswer('daemon_needs_upgrade', 'This host\'s Walnut daemon cannot run a check for this server yet; it updates on your Mac\'s next connect.')
    const me = actor.kind === 'session' ? await deps.session(actor.sid) : null
    const cwd = str(check.cwd) || str(me?.cwd)
    const limit = check.timeoutSeconds
    const id = str(b.id)
    if (id && await keptTrigger(id)) return keptAnswer()
    let r: Record<string, unknown>
    try {
      r = await deps.request('follower.trigger.test', {
        actor, args: { run, ...(cwd ? { cwd } : {}), ...(typeof limit === 'number' ? { timeoutSeconds: limit } : {}), ...(id ? { id } : {}) },
      }, testCallTimeoutMs(limit))
    } catch (err) {
      return refusalAnswer('internal', `The check could not be run on this host: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (r.ok === false) return refusalAnswer(typeof r.errorKind === 'string' ? r.errorKind : 'internal', String(r.error ?? 'the daemon refused the check'), r.detail, typeof r.retryAfterMs === 'number' ? r.retryAfterMs : undefined)
    const { ok: _ok, id: _id, ...body } = r
    return { answered: false, status: 200, body }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase()
    const path = req.path.replace(/\/+$/, '')
    if (!path.startsWith('/v1/routines')) { next(); return }
    const idHit = /^\/v1\/routines\/([^/]+)$/.exec(path)
    const id = idHit && !NOT_IDS.has(idHit[1]!) ? idHit[1]! : ''
    const fail = (err: unknown) => {
      deps.log('warn', 'replica: a local trigger call failed here', { path, error: err instanceof Error ? err.message : String(err) })
      writeAnswer(res, refusalAnswer('internal', 'This host could not do it.'))
    }
    const actor = deps.actorOf(req)
    const local = !!actor && actor.kind !== 'device'
    if (method === 'GET') {
      // Only a read this replica answers away (dispatch.ts set its offline header), for this host's own call.
      if (!local || !res.getHeader(OFFLINE_HEADER) || !hasCap() || (path !== '/v1/routines' && !id)) { next(); return }
      ;(id ? one(id) : list(req)).then((a) => (a ? writeAnswer(res, a) : next()), fail)
      return
    }
    const w = req.replicaWrite
    if (!w) { next(); return }
    if (!local) { writeAnswer(res, needsLeaderAnswer('needs_mac', 'This needs your Mac, which is not answering right now.')); return }
    let run: Promise<PortAnswer> | null = null
    if (method === 'POST' && path === '/v1/routines/trigger') run = create(req, w, actor!)
    else if (method === 'POST' && path === '/v1/routines/check-test') run = test(req, actor!)
    else if ((method === 'PATCH' || method === 'DELETE') && id) run = change(req, w, actor!, id)
    if (!run) { next(); return }
    run.then((a) => writeAnswer(res, a), fail)
  }
}

/** The real dependencies on a host replica (server.ts mounts it beside away-calls.ts). */
export async function wireAwayTriggers(o: {
  away: { actorOf(req: Request): WriteActor | null; task(id: string): Promise<TaskRow | null> }
  hostKey: string | null
  capabilities(): readonly string[] | null
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
}): Promise<RequestHandler> {
  const { createTriggerLabel } = await import('../core/routines/trigger-label.js')
  const labels = createTriggerLabel()
  return awayTriggers({
    actorOf: (req) => o.away.actorOf(req),
    hostKey: o.hostKey,
    capabilities: o.capabilities,
    request: o.request,
    findTask: (ref) => findAwayTask(o.away, ref),
    session: async (sid) => {
      const { getSessionByClaudeId } = await import('../core/session-tracker.js')
      const rec = await getSessionByClaudeId(sid).catch(() => null)
      return rec ? { taskId: rec.taskId ?? null, cwd: rec.cwd ?? null } : null
    },
    copyJobs: routinesCopyJobs,
    label: (input) => labels.label(input),
    log: (level, msg, data) => log.web[level](msg, data),
  })
}
