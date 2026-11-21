/**
 * This host's own trigger calls while the Mac is away (task B; away-calls.ts has the others):
 * decided here with the Mac's own rules (trigger-api.ts, trigger-fields.ts, trigger-watches.ts,
 * trigger-label.ts, task-wait-clock.ts) and this replica's copies, then armed and journaled by the
 * daemon through `follower.op` as the very `op` record its own away answer writes
 * (offline-host-core.ts followerCall: armTrigger, opTriggerWrite):
 *
 *   POST   /v1/routines/trigger      trigger_create: the daemon gives the id and arms it at once
 *   PATCH  /v1/routines/:id          trigger_pause / trigger_resume ({enabled} alone; any other
 *                                    change is trigger_update, which needs the Mac)
 *   DELETE /v1/routines/:id          trigger_delete
 *   POST   /v1/routines/check-test   trigger_test: the check run once here (follower.trigger.test)
 *   GET    /v1/routines[/:id]        trigger_list and the read before a pause: the routines copy
 *                                    with this host's own triggers over it (follower.triggers):
 *                                    one made here, a pause, a resume or a delete made here
 *
 * The reads and the test need the daemon's `follower-triggers-v1`; without it the copy answers
 * alone and the test is handed back to the daemon's own away answer.
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
  status?: { nextRunAtMs?: number; lastRunAtMs?: number; consecutiveErrors?: number }
  created?: boolean
  description?: string
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
  now?(): number
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** A trigger of this host as the routine row the server lists (the copy's own row when it has one). */
export function withHere(job: Job | null, t: HereTrigger, host: string, now: number): Job {
  const def = t.def
  const base: Job = job ?? {
    id: def.id, name: def.name, ...(t.description ? { description: t.description } : {}),
    schedule: { kind: 'every', everyMs: def.everyMs },
    check: { run: def.check.run, ...(def.check.cwd ? { cwd: def.check.cwd } : {}), host, timeoutSeconds: def.check.timeoutSeconds ?? TIME_LIMIT_DEFAULT_S },
    executor: { type: 'session', config: { ...(def.deliver?.taskId ? { target: def.deliver.taskId } : {}), ...(def.deliver?.prompt ? { prompt: def.deliver.prompt } : {}) } },
    state: {},
  }
  const state: Record<string, unknown> = { ...((base.state as Record<string, unknown> | undefined) ?? {}) }
  const s = t.status
  if (typeof s?.nextRunAtMs === 'number') state.nextRunAtMs = s.nextRunAtMs
  if (typeof s?.lastRunAtMs === 'number') state.lastRunAtMs = s.lastRunAtMs
  if (typeof s?.consecutiveErrors === 'number') state.consecutiveErrors = s.consecutiveErrors
  // Paused here: read as paused (never "stopped"), from when this host says so.
  if (t.state === 'paused' && typeof state.pausedAtMs !== 'number') state.pausedAtMs = now
  return { ...base, enabled: t.state === 'armed', state, ...(t.created ? { queued: true } : {}) }
}

/** The routines copy with this host's triggers over it: a delete here gone, one made here added. */
export function mergeHereTriggers(copy: readonly Job[], here: readonly HereTrigger[], host: string, includeDisabled: boolean, now: number): Job[] {
  const left = new Map(here.map((t) => [t.id, t]))
  const out: Job[] = []
  for (const job of copy) {
    const t = left.get(String(job.id))
    if (!t) { out.push(job); continue }
    left.delete(t.id)
    if (t.state !== 'deleted') out.push(withHere(job, t, host, now))
  }
  for (const t of left.values()) if (t.state !== 'deleted') out.push(withHere(null, t, host, now))
  return includeDisabled ? out : out.filter((j) => j.enabled !== false)
}

export function awayTriggers(deps: AwayTriggersDeps): RequestHandler {
  const now = deps.now ?? Date.now
  const host = deps.hostKey ?? ''
  const hasCap = () => deps.capabilities()?.includes(FOLLOWER_TRIGGERS_CAP) === true
  const needsMac = (what: string) => needsLeaderAnswer('routine_writes_need_mac', `${what} needs your Mac; nothing was changed.`)

  async function hereTriggers(id?: string): Promise<HereTrigger[] | null> {
    try {
      const r = await deps.request('follower.triggers', id ? { triggerId: id } : {}, READ_TIMEOUT_MS)
      return r.ok === false || !Array.isArray(r.triggers) ? null : r.triggers as HereTrigger[]
    } catch (err) {
      deps.log('warn', 'replica: this host\'s triggers could not be read', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  async function list(req: Request): Promise<PortAnswer | null> {
    const here = await hereTriggers()
    if (!here) return null
    const includeDisabled = req.query.includeDisabled === 'true'
    const copy = await deps.copyJobs(includeDisabled)
    if (!copy && !here.length) return null
    return { answered: false, status: 200, body: { jobs: mergeHereTriggers(copy ?? [], here, host, includeDisabled, now()) } }
  }

  async function one(id: string): Promise<PortAnswer | null> {
    const t = (await hereTriggers(id))?.find((x) => x.id === id)
    if (!t) return null
    if (t.state === 'deleted') return refusalAnswer('not_found', `No trigger ${id}: it was deleted on this host`)
    const job = (await deps.copyJobs(true))?.find((j) => j.id === id) ?? null
    return { answered: false, status: 200, body: { job: withHere(job, t, host, now()) } }
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
    let task: TaskRow | null
    try { task = await deps.findTask(session === 'this' ? str(me?.taskId) : session) } catch (err) { return refusalAnswer('bad_request', err instanceof Error ? err.message : String(err)) }
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
    let op = 'trigger_delete'
    if (req.method.toUpperCase() === 'PATCH') {
      const b = bodyOf(req)
      const keys = Object.keys(b).filter((k) => b[k] !== undefined)
      if (keys.length !== 1 || keys[0] !== 'enabled' || typeof b.enabled !== 'boolean') return needsMac('Changing a trigger in place (trigger_update)')
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
    copyJobs: async (includeDisabled) => {
      const [{ companionRoutinesCopy }, { withRoutineOwners }] = await Promise.all([
        import('../core/replication/kinds/routines-follower.js'), import('../core/routines/routine-owner.js'),
      ])
      const copied = await companionRoutinesCopy({ includeDisabled })
      return copied ? await withRoutineOwners(copied) as unknown as Job[] : null
    },
    label: (input) => labels.label(input),
    log: (level, msg, data) => log.web[level](msg, data),
  })
}
