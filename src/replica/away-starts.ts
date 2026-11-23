/**
 * A task's start, made by this host's own `walnut` calls while the Mac is away (the
 * `host-local-calls` capability; local-calls.ts runs the calls; a message is away-sends.ts's). Only
 * those callers reach here: the route table answers a phone or a browser `needs_leader` on
 * these routes as before (route-table.ts `localAway`).
 *
 *   POST /v1/tasks/:id/start   (task_start, and task_create's start)
 *     only where the task would run: a task that has a session on this host continues it
 *     (a message to it while it runs); a task with none starts here only when this host's
 *     journal still holds its create (the Mac adopts such a task's session alone: apply-session.ts) and its
 *     project's default host is this host, in the project's default folder (or the folder named), from
 *     the Mac's plain-session template (host-start-core.ts planTask), built as the Mac
 *     builds a fresh Claude Code start (fresh-claude-start.ts). The daemon journals its
 *     `session` record (`run: 'task'`) for the Mac's `task-start` drain, which adopts it as
 *     the task's own session. Anywhere else: `needs_leader` with why.
 *     The brake: this host already runs, or is starting, as many live sessions as its own
 *     memory allows (live-sessions.ts memoryLiveLimit, never the Mac's setting): `throttled`,
 *     retry later, nothing started. A start's session id comes from its op id, so a retry
 *     of the same call (a lost answer, this replica restarted) is the same start: the daemon
 *     starts one session per id. The session shows here at once (ask-launch.ts noteStarted).
 *     One start of a task at a time, as the Mac's pending starts: a second under another op id
 *     while one runs hears the Mac's 409 session_exists, and starts nothing.
 *     The mode, under the Mac's start-mode ceiling (start-ceiling.ts): a session starts work at most
 *     as loose as its own mode, a plugin job its daemon did not vouch for at most 'default'. A looser
 *     mode asked for is the Mac's 403 before anything else, final; none asked for is the caller's own
 *     mode under a ceiling, else the project's.
 */

import { projectOrInbox } from '../core/inbox-project.js'
import crypto from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ReplicaWrite } from './dispatch.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type TaskRow, type WriteActor, type WritePort } from './write-port.js'
import type { FreshClaudeStart } from '../core/sessions/fresh-claude-start.js'
import { log } from '../logging/index.js'
import { memoryLiveLimit } from '../core/sessions/live-sessions.js'
import { defaultCwdOnHost } from '../core/sessions/launch-place.js'
import { sessionExistsWords } from '../core/sessions/one-session-per-task.js'
import type { SessionMode } from '../core/types.js'
import { awayStartCaller, capAwayStart, replicaStartCaller, type StartCallerDeps } from './start-ceiling.js'
import { callerUnprovenOf } from '../lib/caller-unproven.js'

/** The daemon capability a task start here needs (follower.start `run: 'task'`). */
export const TASK_START_CAP = 'follower-gateway-v1'
/** Each try of a start waits this long (a CLI start), as an ask's does. */
const START_TIMEOUT_MS = 45_000
const SESSIONS_TIMEOUT_MS = 3_000
/** The start inputs a start here takes; any other needs the Mac. */
const START_KEYS = new Set(['message', 'cwd', 'cwd_chosen', 'host', 'mode', 'model', 'effort', 'engine', 'no_workspace'])

export interface TaskSession { sid: string; host?: string | null; startedAt?: string }

export interface AwayStartsDeps {
  port: WritePort
  actorOf(req: Request): WriteActor | null
  /** A task as this replica shows it (copy plus overlay), or null. */
  task(id: string): Promise<TaskRow | null>
  /** The Mac's name for this host. */
  hostKey: string | null
  capabilities(): readonly string[] | null
  /** A follower link request (`follower.sessions`). */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** The task's sessions (the copy, and the ones this host started that the copy does not list yet). */
  sessionsOfTask(taskId: string): Promise<TaskSession[]>
  /** A project's registry row (default_host, default_cwd, its session defaults), or null. */
  projectMeta(project: string): Promise<Record<string, unknown> | null>
  /** Whether this host's journal holds the task's create still (its first start here is the Mac's to adopt). */
  madeHere(taskId: string): boolean
  /** The Mac's words for a start of a task already started or starting (one-session-per-task.ts sessionExistsWords). */
  sessionExists(task: { id: string; title?: string }): string
  /** This host's live session limit, from its own memory (never 0, never unlimited). */
  liveLimit(): number
  /** The fresh start the Mac would make (null: not on Claude Code). Throws when its context cannot be built. */
  freshStart(o: { host: string; cwd: string; task: TaskRow; meta: Record<string, unknown> | null }): Promise<FreshClaudeStart | null>
  /** The first words as the caller's (send-frame.ts), never as a person's. */
  frame(text: string, actor: WriteActor): Promise<string>
  /** Who the caller is for the start-mode ceiling: a session's mode, a vouched plugin job (start-ceiling.ts). */
  startCaller: StartCallerDeps
  /** A session started here: its row shows at once and its turns reach the console (ask-launch.ts noteStarted). */
  started(row: { sid: string; taskId: string; cwd: string; mode: string; title: string; project: string }): void
  /** A message delivered to a session here started a turn: it is watched again (ask-launch.ts watch). */
  continued?(sid: string): void
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

function bodyOf(req: Request): Record<string, unknown> {
  const b = req.body as unknown
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * A start's session id, from its op id: the same call asked again (its call id gives the same op
 * id) names the same session, which the daemon starts once (follower.start dedupes by id).
 */
export function startSessionId(opId: string, taskId: string): string {
  const h = crypto.createHash('sha256').update(`task-start\0${opId}\0${taskId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function awayStarts(deps: AwayStartsDeps): RequestHandler {
  /** Starts under way here: counted against the limit until the daemon lists them. */
  let starting = 0
  const here = (s: TaskSession) => !!deps.hostKey && str(s.host) === deps.hostKey
  const latest = (list: TaskSession[]) => [...list].sort((a, b) => str(b.startedAt).localeCompare(str(a.startedAt)))[0]

  /** The live sessions on this host now, by the daemon's own list (null: it could not be read). */
  async function liveHere(): Promise<Array<{ sid?: unknown; state?: unknown }> | null> {
    try {
      const r = await deps.request('follower.sessions', {}, SESSIONS_TIMEOUT_MS)
      const list = Array.isArray(r.sessions) ? r.sessions as Array<{ sid?: unknown; state?: unknown }> : []
      return list.filter((s) => s.state === 'working' || s.state === 'idle')
    } catch (err) {
      deps.log('warn', 'replica: this host\'s live sessions could not be read for a start', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }

  async function sendTo(w: ReplicaWrite, actor: WriteActor, sid: string, taskId: string, text: string): Promise<PortAnswer> {
    const a = await deps.port.send(w, sid, await deps.frame(text, actor), undefined, { framed: true })
    if (a.answered || a.status >= 300) return a
    deps.continued?.(sid)
    deps.log('info', 'replica: a message to a task on this host was delivered while the Mac is away', { taskId, sessionId: sid, opId: w.opId })
    return { answered: false, status: 200, body: { ...a.body, taskId, targetTaskId: taskId, targetSessionId: sid } }
  }

  /** The start of a task under way here, by task: its session id (the Mac's pending starts). */
  const holding = new Map<string, string>()

  async function start(req: Request, w: ReplicaWrite, actor: WriteActor, taskId: string): Promise<PortAnswer> {
    // The Mac's ceiling first, as its task start caps the mode before anything else (task-start.ts).
    const capped = await capAwayStart(await awayStartCaller(req, actor, deps.startCaller), str(bodyOf(req).mode), { unproven: !!callerUnprovenOf(req) })
    if ('refused' in capped) {
      deps.log('warn', 'replica: a task start asked for a mode looser than its caller may start', { taskId, opId: w.opId })
      return capped.refused
    }
    // Held before anything of the task is read, so a second start under another op id never reads the task
    // as free while this one is under way. The same op asked again goes on: the daemon starts
    // one session per id.
    const sid = startSessionId(w.opId, taskId)
    const held = holding.get(taskId)
    if (held !== undefined && held !== sid) {
      const task = await deps.task(taskId)
      return { answered: false, status: 409, body: { error: { code: 'session_exists', message: deps.sessionExists({ id: taskId, title: str(task?.title) }) }, existing_session_id: held } }
    }
    if (held === undefined) holding.set(taskId, sid)
    try {
      return await startFree(req, w, actor, taskId, capped.mode)
    } finally {
      if (held === undefined) holding.delete(taskId)
    }
  }

  async function startFree(req: Request, w: ReplicaWrite, actor: WriteActor, taskId: string, capped: SessionMode | undefined): Promise<PortAnswer> {
    const b = bodyOf(req)
    const task = await deps.task(taskId)
    if (!task) return refusalAnswer('not_found', `Task ${taskId} not found`)
    const message = str(b.message)
    const sessions = await deps.sessionsOfTask(taskId)
    const own = sessions.filter(here)
    if (own.length) {
      // The task has its session here: a start with words continues it, as the Mac's does.
      const s = latest(own)!
      // This very start asked again (its answer lost, or this replica restarted): started once.
      const same = own.find((x) => x.sid === startSessionId(w.opId, taskId))
      if (same) return { answered: false, status: 200, body: { taskId, sessionId: same.sid, started: true, offline: true, duplicate: true } }
      if (!message) return needsLeaderAnswer('session_resume_needs_mac', 'This task already has its session on this host; starting it again with no message needs your Mac.')
      const a = await sendTo(w, actor, s.sid, taskId, message)
      return a.answered || a.status >= 300 ? a : { answered: false, status: 200, body: { taskId, sessionId: s.sid, continued: true, started: true, offline: true } }
    }
    if (sessions.length) return needsLeaderAnswer('task_runs_elsewhere', 'This task\'s session runs on another machine; starting it needs your Mac.')
    // Only a task whose create this host's journal still holds: the Mac adopts a session started here for no other.
    if (!deps.madeHere(taskId)) return needsLeaderAnswer('task_made_on_mac', 'This task was made on your Mac, or your Mac has its create already; its first start needs your Mac.')
    const extra = Object.keys(b).filter((k) => !START_KEYS.has(k) && b[k] !== undefined)
    if (extra.length) return needsLeaderAnswer('start_needs_mac', `${extra.join(', ')} can only be used while your Mac answers; nothing was started.`, { fields: extra })
    if (str(b.host) && str(b.host) !== deps.hostKey) return needsLeaderAnswer('task_runs_elsewhere', 'Starting on another machine needs your Mac.')
    const engine = str(b.engine)
    if (engine && engine !== 'claude' && engine !== 'claude-code') return needsLeaderAnswer('engine_needs_mac', 'Only a Claude Code session starts on this host while your Mac is away.')
    const project = str(task.project)
    // The Inbox ('' on an older row) has settings like any project.
    const meta = await deps.projectMeta(projectOrInbox(project))
    if (!deps.hostKey || str(meta?.default_host) !== deps.hostKey) {
      return needsLeaderAnswer('task_runs_elsewhere', 'This task\'s project runs its sessions on another machine; starting it needs your Mac.')
    }
    const cwd = str(b.cwd) || str(defaultCwdOnHost(meta as { default_cwd?: string; default_host?: string } | null, deps.hostKey))
    if (!cwd) return needsLeaderAnswer('no_folder', 'This task\'s project names no folder on this host; starting it needs your Mac.')
    if (deps.capabilities()?.includes(TASK_START_CAP) !== true) return needsLeaderAnswer('daemon_needs_upgrade', 'This host\'s Walnut daemon cannot start a task\'s session yet; it updates on your Mac\'s next connect.')
    // The brake: no more live sessions here, counting the starts under way, than this host's
    // memory allows. Counted and taken with no await between, so two starts never share a slot.
    const limit = deps.liveLimit()
    const list = await liveHere()
    if (!list) return refusalAnswer('throttled', 'This host could not count its live sessions just now; nothing was started. Try again in a moment.', { why: 'live_count_unread' }, 5_000)
    // This very start already runs (a retry right after this replica restarted, before it lists
    // the session again): done, never held by the brake it already passed.
    const sid = startSessionId(w.opId, taskId)
    if (list.some((x) => x.sid === sid)) return { answered: false, status: 200, body: { taskId, sessionId: sid, started: true, offline: true, duplicate: true } }
    const live = list.length
    if (live + starting >= limit) {
      deps.log('warn', 'replica: a task start was held, this host runs its live session limit', { taskId, live, starting, limit })
      return refusalAnswer('throttled', `This host already runs ${live + starting} live sessions, its limit (${limit}); nothing was started. Try again once one ends.`, { why: 'live_limit' }, 60_000)
    }
    starting++
    try {
      return await startHere(w, actor, b, task, taskId, message, { host: deps.hostKey, cwd, meta, mode: capped })
    } finally {
      starting--
    }
  }

  async function startHere(w: ReplicaWrite, actor: WriteActor, b: Record<string, unknown>, task: TaskRow, taskId: string, message: string, at: { host: string; cwd: string; meta: Record<string, unknown> | null; mode: SessionMode | undefined }): Promise<PortAnswer> {
    const { host, cwd, meta } = at
    let fresh: FreshClaudeStart | null
    try {
      fresh = await deps.freshStart({ host, cwd, task, meta })
    } catch (err) {
      deps.log('warn', 'replica: a task start could not build its session context', { taskId, error: err instanceof Error ? err.message : String(err) })
      return needsLeaderAnswer('context_needs_mac', 'This host could not build the task\'s session context; starting it needs your Mac.')
    }
    if (!fresh) return needsLeaderAnswer('engine_needs_mac', 'This task\'s project runs another engine; starting it needs your Mac.')
    const first = message || str(task.description) || str(task.title)
    // The ceiling's mode (the one asked for, or the caller's own under a ceiling) is named; else the project's.
    const mode = at.mode ?? fresh.mode
    const model = str(b.model) && str(b.model) !== 'default' ? str(b.model) : fresh.model
    const effort = str(b.effort) || fresh.effort
    const sid = startSessionId(w.opId, taskId)
    const { START_TASK_TOKEN } = await import('../providers/trigger-clock-core.js')
    const r = await w.call('follower.start', {
      run: 'task', sid, taskId, title: str(task.title) || taskId, cwd, mode, modeNamed: at.mode !== undefined || fresh.modeNamed,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      // The first words framed with their source (deps.frame: a job's automation, a session's peer note).
      context: fresh.context, taskToken: START_TASK_TOKEN, firstMessage: await deps.frame(first, actor),
      host, actor,
    }, { timeoutMs: START_TIMEOUT_MS })
    if (r.kind === 'answered') return { answered: true }
    if (r.kind === 'refused') {
      deps.log('warn', 'replica: a task start was refused by the host', { taskId, sessionId: sid, code: r.code, error: r.message })
      return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
    }
    const startedSid = typeof r.reply.sid === 'string' ? r.reply.sid : sid
    deps.started({ sid: startedSid, taskId, cwd, mode, title: str(task.title) || taskId, project: str(task.project) })
    deps.log('info', 'replica: a task\'s session started on this host while the Mac is away', { taskId, sessionId: startedSid, opId: w.opId })
    return { answered: false, status: 200, body: { taskId, sessionId: startedSid, started: true, offline: true } }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const w = req.replicaWrite
    if (!w || req.method.toUpperCase() !== 'POST') { next(); return }
    const path = req.path.replace(/\/+$/, '')
    const startHit = /^\/v1\/tasks\/([^/]+)\/start$/.exec(path)
    if (!startHit) { next(); return }
    const actor = deps.actorOf(req)
    const answer = (a: PortAnswer) => {
      if (a.answered || res.headersSent) return
      if (a.status === 503 || a.status === 429) {
        const retry = (a.body.error as { retryAfter?: unknown } | undefined)?.retryAfter
        if (typeof retry === 'number') res.setHeader('retry-after', String(retry))
      }
      res.status(a.status).json(a.body)
    }
    if (!actor || actor.kind === 'device') { answer(needsLeaderAnswer('needs_mac', 'This needs your Mac, which is not answering right now.')); return }
    let id: string
    try { id = decodeURIComponent(startHit[1]!) } catch { id = startHit[1]! }
    const run = start(req, w, actor, id)
    run.then(answer, (err: unknown) => {
      deps.log('warn', 'replica: a local call failed here', { path, opId: w.opId, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) answer(refusalAnswer('internal', 'This host could not do it.'))
    })
  }
}

/** A task's sessions as this replica holds them (the copy, and the ones this host started that it does not list yet). */
export async function taskSessions(taskId: string): Promise<TaskSession[]> {
  const { getSessionsForTask } = await import('../core/session-tracker.js')
  return (await getSessionsForTask(taskId)).map((r) => ({ sid: r.claudeSessionId, host: r.host ?? null, startedAt: r.startedAt }))
}

/** Words delivered here as the caller's (send-frame.ts), never as a person's: a job's automation, a session's peer note. */
export async function frameAsCaller(text: string, actor: WriteActor, task: (id: string) => Promise<TaskRow | null>): Promise<string> {
  const { frameStartText } = await import('../core/sessions/send-frame.js')
  if (actor.kind === 'plugin-job') return frameStartText(text, { source: `automation:plugin job ${actor.plugin}/${actor.job}` })
  // A device never starts here (needs_leader first); named all the same, as the console's start names it.
  if (actor.kind !== 'session') {
    const { startRouteSource } = await import('../core/sessions/send-sent-by.js')
    return frameStartText(text, { source: startRouteSource('quick-start', {}) })
  }
  const { getSessionByClaudeId } = await import('../core/session-tracker.js')
  const rec = await getSessionByClaudeId(actor.sid).catch(() => null)
  if (!rec) return frameStartText(text, { source: 'api-agent', callerSid: actor.sid })
  const title = rec.taskId ? String((await task(rec.taskId))?.title ?? '') : ''
  return frameStartText(text, { source: 'api-agent', caller: { title, claudeSessionId: actor.sid, ...(rec.taskId ? { taskId: rec.taskId } : {}), ...(rec.host ? { host: rec.host } : {}) } })
}

/** The real dependencies on a host replica (server.ts mounts the handler before away.writes). */
export function wireAwayStarts(o: {
  away: { port: WritePort; actorOf(req: Request): WriteActor | null; task(id: string): Promise<TaskRow | null>; overlay: { createPending(id: string): boolean } }
  hostKey: string | null
  started: AwayStartsDeps['started']
  continued?: AwayStartsDeps['continued']
  capabilities(): readonly string[] | null
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
}): RequestHandler {
  return awayStarts({
    port: o.away.port,
    actorOf: (req) => o.away.actorOf(req),
    task: (id) => o.away.task(id),
    hostKey: o.hostKey,
    capabilities: o.capabilities,
    request: o.request,
    sessionsOfTask: taskSessions,
    projectMeta: async (project) => (await import('../core/task-manager.js')).getProjectMetadata(project),
    sessionExists: (task) => sessionExistsWords(task).message,
    // The overlay's creates: pending in this host's journal, or taken by the Mac and not in the copy yet.
    // Still in this host's journal: a create the Mac already took may have been refused there,
    // and a session started for it now would be refused too (it answers needs_leader instead).
    madeHere: (taskId) => o.away.overlay.createPending(taskId),
    // This machine's memory only: the copied config is the Mac's (its own local_live_limit).
    liveLimit: () => memoryLiveLimit(),
    freshStart: async ({ host, cwd, task, meta }) => {
      const [{ getConfig }, { freshClaudeStart }, { readProjectLaunchDefaults }] = await Promise.all([
        import('../core/config-manager.js'), import('../core/sessions/fresh-claude-start.js'), import('../core/sessions/project-launch-defaults.js'),
      ])
      return freshClaudeStart({
        config: await getConfig(), host, cwd,
        task: task as unknown as Parameters<typeof freshClaudeStart>[0]['task'],
        defaults: readProjectLaunchDefaults(meta),
      })
    },
    frame: (text, actor) => frameAsCaller(text, actor, (id) => o.away.task(id)),
    startCaller: replicaStartCaller,
    started: (row) => o.started(row),
    continued: (sid) => o.continued?.(sid),
    log: (level, msg, data) => log.web[level](msg, data),
  })
}
