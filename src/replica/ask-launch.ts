/**
 * A new Ask Walnut while the Mac is away, on a host replica
 * (docs/plan/walnut-replica-servers-impl.md section 8, WP12). Ask Walnut is a Claude Code
 * session, so the ask runs as a session on THIS host:
 *
 *   1. the launch route (`POST /api/sessions/quick-start` with `walnutAgent`, the console's
 *      Ask Walnut composer; `POST /api/v1/sessions` with `walnutAgent`, the phone) is an
 *      away `queue:ask` row (route-table.ts): the dispatcher hands it here with its op id;
 *   2. `follower.start {check: true}` (cap `replica-start-v1`) runs every check the daemon
 *      makes of the start (its template, the fields, the limits, a Mac that can adopt the
 *      session, the journal's room) and journals nothing, so a refusal leaves no task;
 *   3. the ask's task is journaled as a `task-create` through the write port (filed and
 *      tiered as the Mac files an ask: ask-launch-plan.ts, createMeta below), so the
 *      overlay shows it at once;
 *   4. `follower.start` asks the daemon to start the session from the Mac's spawn template
 *      with this replica's fields only: the session id (the client's own id for the launch
 *      when it sent one, so its lost-answer reconcile finds the session; else minted here),
 *      the task, the persona from the `personas` copy (kinds/personas.ts) and the session
 *      context for that task, the first message (stdin), model, effort and mode. Each try
 *      waits FOLLOWER_START_TIMEOUT_MS (a CLI start); a retry is answered by the first
 *      attempt. Once the CLI runs, the daemon journals a `session` record the Mac adopts on
 *      its drain (offline-merge/apply-session.ts). A start that passed the check and still
 *      failed (a limit another start reached in between, a CLI that did not start) leaves
 *      its task, as a failed start on the Mac leaves its task;
 *   5. until the Mac's copy lists the session, this replica shows its row itself
 *      (session-tracker.ts installAwaySessions), so the console opens it, its history is
 *      read on this host (self-host.ts), and a message to it goes through follower.send;
 *   6. the CLI's turns reach the console by a poll of `follower.sessions` while a session
 *      started here works: each new write tells browsers `session:batch-completed` (the
 *      history refetches) and a turn end `session:result`.
 *
 * Refusals: no persona copy `needs_leader {why:'persona_not_copied'}`; a daemon without the
 * capability `daemon_needs_upgrade`; no template on the daemon `no_spawn_template` (its own
 * answer); a folder session (no `walnutAgent`), a retry on an existing task or pictures
 * need the Mac. A host session that blocks on a permission prompt pushes nothing to the
 * phone while the Mac is away (section 2's stated limit): the prompt is answered in the console.
 */

import crypto from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { SessionRecord, Task } from '../core/types.js'
import { askProjectFor } from '../core/sessions/ask-list.js'
import { migrateFocusTier } from '../core/types.js'
import { needsLeaderAnswer, refusalAnswer, type PortAnswer, type WriteActor, type WritePort } from './write-port.js'

/** The daemon capability a new ask on the host needs. */
export const REPLICA_START_CAP = 'replica-start-v1'

/** The launch routes this module answers while away (route-table.ts `queue:ask` rows name the same). */
export const ASK_LAUNCH_PATTERNS: ReadonlyArray<{ method: string; pattern: string }> = [
  { method: 'POST', pattern: '/api/sessions/quick-start' },
  { method: 'POST', pattern: '/api/v1/sessions' },
]

/**
 * Each try of a `follower.start`: longer than a CLI start (the daemon's spawn gate probes the
 * CLI for up to 10 s and asks the spawn shell for up to 8 s more), so a slow start is not read
 * as a lost answer. A try that still times out is asked again and answered by the first.
 */
export const FOLLOWER_START_TIMEOUT_MS = 45_000

/** Stands in for the ask's task id in the precheck's context: mintTaskId's shape. */
const PENDING_TASK_ID = '00000000-0000000000000000'

/** A v4 UUID, the shape the daemon takes for a session id (host-start-core.ts). */
const SID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** How long a session started here stays watched after its last write (its turns reach the console). */
const WATCH_IDLE_MS = 10 * 60_000
const POLL_MS = 1_000
const POLL_TIMEOUT_MS = 3_000

export interface PersonaCopy {
  agentId: string
  name: string
  systemPrompt: string
  systemPromptMode: 'append' | 'replace'
  /** Copied for the record; the start takes the agent's tool lists from the Mac's template. */
  allowedTools?: string[]
  tools?: string[]
  effort?: string
  launchModel?: string
  launchEffort?: string
}

export interface AskLaunchDeps {
  port: WritePort
  actorOf(req: Request): WriteActor | null
  /** The Mac's name for this host: the `host` of the sessions that run here. */
  hostKey: string | null
  /** The `personas` copy's row for an agent, or null. */
  persona(agentId: string): Promise<PersonaCopy | null>
  /** The daemon's capabilities (its hello), or null before it answered. */
  capabilities(): readonly string[] | null
  /** A follower link request (follower.sessions). */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** Tell this replica's browsers (its own /ws). */
  broadcast(name: string, data: unknown): void
  /** The session context the Mac would append for this task (session-context.ts). */
  sessionContext(task: Task, cwd?: string): Promise<string>
  /** The `session` records this host's journal still holds (the overlay), for a restart of this replica. */
  pendingSessions?(): Array<Record<string, unknown>>
  now?(): number
  randomUUID?(): string
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export interface AskLaunch {
  handler: RequestHandler
  /** The session rows this replica shows for asks it started (session-tracker installAwaySessions). */
  rows(): SessionRecord[]
  /** Watch a session of this host whose turn a person started here (a message to it). */
  watch(sid: string): void
  stop(): void
}

function bodyOf(req: Request): Record<string, unknown> {
  const b = (req as Request & { body?: unknown }).body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/
/**
 * core/sessions/ask-launch-plan.ts ASK_DEFAULT_TIER (ask-launch.test.ts holds them equal);
 * not imported: that module reads the Mac's remembered launch picks.
 */
export const ASK_DEFAULT_TIER = 'focus'

/**
 * The launch's task meta as the create's fields, the way the Mac files an ask
 * (core/sessions/ask-launch-plan.ts askLaunchTier, quick-start.ts): the phone's launch
 * and a console launch naming no tier are born in Focus; `pinTier: null` is "do not pin";
 * Focus or Parked (a retired name read as its successor) pins into it; Satellite, or a
 * custom tier this host cannot check, pins in Satellite (the Mac's own fallback for a tier
 * it does not know). A priority other than none, the dates and `unread` ride along. null:
 * a value that was never a tier or a priority (the Mac answers 400 for it too).
 */
export function createMeta(raw: unknown, v1 = false): Record<string, unknown> | null {
  if (v1) return { focus_tier: ASK_DEFAULT_TIER }
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  const tier = m.pinTier === undefined ? ASK_DEFAULT_TIER : m.pinTier
  if (tier === null) out.pinned = false
  else if (typeof tier !== 'string') return null
  else {
    const t = migrateFocusTier(tier)
    if (t === 'focus' || t === 'wait') out.focus_tier = t
    else if (t === 'satellite' || /^ct_[a-z0-9]+$/.test(t)) out.pinned = true
    else return null
  }
  if (m.priority !== undefined && m.priority !== null && !['immediate', 'important', 'backlog', 'none'].includes(m.priority as string)) return null
  if (m.priority === 'immediate' || m.priority === 'important' || m.priority === 'backlog') out.priority = m.priority
  for (const k of ['due_date', 'start_date', 'end_date']) if (typeof m[k] === 'string' && DATE_RE.test(m[k] as string)) out[k] = m[k]
  if (m.unread === true) out.unread = true
  return out
}

function pathMatches(method: string, path: string): { v1: boolean } | null {
  if (method !== 'POST') return null
  const p = path.replace(/\/+$/, '').toLowerCase()
  if (p === '/sessions/quick-start') return { v1: false }
  if (p === '/v1/sessions') return { v1: true }
  return null
}

export function createAskLaunch(deps: AskLaunchDeps): AskLaunch {
  const now = deps.now ?? Date.now
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID())
  /** Asks started here, by session id: the row shown until the Mac's copy lists it. */
  const started = new Map<string, SessionRecord>()
  /** Sessions watched for turns: last write time seen and when it was last active. */
  const watched = new Map<string, { lastActiveAt?: string; state?: string; until: number }>()
  let timer: ReturnType<typeof setInterval> | null = null
  let polling = false

  function startPoll(): void {
    if (timer) return
    timer = setInterval(() => { void poll() }, POLL_MS)
    timer.unref?.()
  }

  /** A person started a turn of `sid` (its launch, a message): its end is told even when the first look already finds it over. */
  function watch(sid: string): void {
    const w = watched.get(sid)
    watched.set(sid, { ...(w ?? {}), state: 'working', until: now() + WATCH_IDLE_MS })
    startPoll()
  }

  /** One look at this host's sessions: a new write or a turn end tells browsers. */
  async function poll(): Promise<void> {
    if (polling) return
    for (const [sid, w] of watched) if (w.until < now()) watched.delete(sid)
    if (!watched.size) { if (timer) clearInterval(timer); timer = null; return }
    polling = true
    try {
      const r = await deps.request('follower.sessions', {}, POLL_TIMEOUT_MS)
      const list = Array.isArray(r.sessions) ? r.sessions as Array<{ sid?: unknown; state?: unknown; lastActiveAt?: unknown }> : []
      for (const s of list) {
        const sid = typeof s.sid === 'string' ? s.sid : ''
        const w = sid ? watched.get(sid) : undefined
        if (!w) continue
        const state = typeof s.state === 'string' ? s.state : 'stopped'
        const at = typeof s.lastActiveAt === 'string' ? s.lastActiveAt : undefined
        const row = started.get(sid)
        if (row) {
          row.process_status = state === 'working' ? 'running' : state === 'idle' ? 'idle' : 'stopped'
          if (at) row.lastActiveAt = at
        }
        if (at && at !== w.lastActiveAt) {
          w.until = now() + WATCH_IDLE_MS
          deps.broadcast('session:batch-completed', { sessionId: sid })
        }
        if (w.state === 'working' && state !== 'working') {
          deps.broadcast('session:result', { sessionId: sid })
          deps.broadcast('session:status-changed', { sessionId: sid, status: row?.process_status ?? 'idle', process_status: row?.process_status ?? 'idle' })
        }
        w.lastActiveAt = at
        w.state = state
      }
    } catch (err) {
      deps.log('warn', 'replica: the host sessions could not be read for the console', { error: err instanceof Error ? err.message : String(err) })
    } finally {
      polling = false
    }
  }

  function rows(): SessionRecord[] {
    // A replica restarted while the Mac is away: the journal still names the asks it started.
    for (const r of deps.pendingSessions?.() ?? []) {
      const sid = typeof r.sid === 'string' ? r.sid : ''
      if (!sid || started.has(sid)) continue
      started.set(sid, rowOf({
        sid, taskId: String(r.taskId ?? ''), cwd: typeof r.cwd === 'string' ? r.cwd : undefined,
        mode: typeof r.mode === 'string' ? r.mode : 'default', title: typeof r.title === 'string' ? r.title : '',
        project: typeof r.project === 'string' ? r.project : '', at: typeof r.startedAt === 'number' ? r.startedAt : now(), status: 'idle',
      }))
    }
    return [...started.values()]
  }

  function rowOf(o: { sid: string; taskId: string; cwd?: string; mode: string; title: string; project: string; at: number; status: SessionRecord['process_status'] }): SessionRecord {
    const iso = new Date(o.at).toISOString()
    return {
      claudeSessionId: o.sid, taskId: o.taskId, project: o.project, process_status: o.status,
      mode: o.mode as SessionRecord['mode'], startedAt: iso, lastActiveAt: iso, messageCount: 1,
      ...(o.cwd ? { cwd: o.cwd } : {}), ...(deps.hostKey ? { host: deps.hostKey } : {}),
      ...(o.title ? { title: o.title } : {}),
    } as SessionRecord
  }

  /** The launch, away. Every refusal says why; nothing is journaled before the checks pass. */
  async function launch(req: Request, v1: boolean): Promise<PortAnswer> {
    const w = req.replicaWrite!
    const b = bodyOf(req)
    if (b.walnutAgent !== true) return needsLeaderAnswer('session_writes_need_mac', 'Starting a session in a folder needs your Mac; Ask Walnut works here.')
    if (b.taskId !== undefined) return needsLeaderAnswer('ask_needs_mac', 'Starting this ask again needs your Mac.')
    if ((Array.isArray(b.images) && b.images.length > 0) || b.intent !== undefined || (b.engine !== undefined && b.engine !== 'claude')) {
      return needsLeaderAnswer(Array.isArray(b.images) && b.images.length > 0 ? 'images_need_mac' : 'ask_needs_mac', 'This kind of ask needs your Mac.')
    }
    if (b.host !== undefined && b.host !== null && b.host !== '') return refusalAnswer('bad_request', 'Ask Walnut runs where Walnut runs; it takes no host.')
    if (deps.capabilities()?.includes(REPLICA_START_CAP) !== true) return needsLeaderAnswer('daemon_needs_upgrade', 'This host\'s Walnut daemon cannot start an ask yet; it updates on your Mac\'s next connect.')
    const actor = deps.actorOf(req)
    if (!actor) return needsLeaderAnswer('device_changes_need_mac', 'This device is not known to this host by its id yet; it needs your Mac.')
    const message = typeof b.message === 'string' ? b.message : ''
    if (message.length > 200_000) return refusalAnswer('bad_request', 'The message is too long to start an ask here.')
    const meta = createMeta(b.taskMeta, v1)
    if (!meta) return refusalAnswer('bad_request', 'taskMeta names a tier or a priority that is not one.')
    if (b.project !== undefined && (typeof b.project !== 'string' || b.project.length > 256)) return refusalAnswer('bad_request', 'project must be a string up to 256 characters')
    const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : 'general'
    const persona = await deps.persona(agentId)
    if (!persona) return needsLeaderAnswer('persona_not_copied', 'This host has no copy of that agent yet; the ask needs your Mac.')
    // The caller's project, else "Ask <name>" (ask-launch-plan.ts askLaunchProject); the
    // placeholder title is always "Ask <name>" (quick-start.ts placeholderTitle).
    const askProject = askProjectFor({ id: persona.agentId, name: persona.name })
    const project = (typeof b.project === 'string' && b.project.trim()) || askProject
    const title = typeof b.taskTitle === 'string' && b.taskTitle.trim() ? b.taskTitle.trim().slice(0, 500) : askProject
    // The client's own id for this launch (web/src/api/sessions.ts quickStart): its
    // reconcile after a lost answer looks the session up by it.
    const sid = typeof b.sessionId === 'string' && SID_RE.test(b.sessionId) ? b.sessionId : uuid()
    const model = typeof b.model === 'string' && b.model && b.model !== 'default' ? b.model : persona.launchModel
    const effort = typeof b.effort === 'string' && b.effort ? b.effort : persona.launchEffort ?? persona.effort
    const mode = typeof b.mode === 'string' && b.mode ? b.mode : undefined
    const contextFor = (task: Record<string, unknown>) => deps.sessionContext({ ...task, title, project, walnut_agent: true } as unknown as Task).catch(() => '')
    const startFields = (context: string) => ({
      sid, agentId: persona.agentId, title,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(mode ? { mode } : {}),
      persona: { text: persona.systemPrompt, mode: persona.systemPromptMode, ...(context ? { context } : {}) },
      firstMessage: message, ...(deps.hostKey ? { host: deps.hostKey } : {}), actor,
    })
    // The daemon's checks first, journaling nothing: a refusal leaves no task behind. The
    // context is the one this task will get (its size counts), with an id of the shape
    // mintTaskId gives (write-port.ts) in place of the one not minted yet.
    const checked = await w.call('follower.start', { ...startFields(await contextFor({ ...meta, id: PENDING_TASK_ID })), check: true })
    if (checked.kind === 'answered') return { answered: true }
    if (checked.kind === 'refused') {
      deps.log('warn', 'replica: a new ask was refused by the host before its task was made', { sessionId: sid, code: checked.code, error: checked.message })
      return refusalAnswer(checked.code, checked.message, checked.detail, checked.retryAfterMs)
    }
    // The task (the same op id: a retry finds the first create), filed as the Mac files an ask.
    const made = await deps.port.taskCreate(w, actor, { title, project, ...meta })
    if (made.answered || made.status >= 300) return made
    const task = made.body.task as Task & Record<string, unknown>
    const taskId = String(task.id)
    const context = await contextFor({ ...task, id: taskId })
    const r = await w.call('follower.start', { ...startFields(context), taskId }, { timeoutMs: FOLLOWER_START_TIMEOUT_MS })
    if (r.kind === 'answered') return { answered: true }
    if (r.kind === 'refused') {
      deps.log('warn', 'replica: a new ask was refused by the host', { taskId, sessionId: sid, code: r.code, error: r.message })
      return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
    }
    const startedSid = typeof r.reply.sid === 'string' ? r.reply.sid : sid
    const mode0 = typeof r.reply.mode === 'string' ? r.reply.mode : mode ?? 'default'
    // The folder the daemon ran it in (the template's): where its transcript is read on this host.
    const cwd = typeof r.reply.cwd === 'string' && r.reply.cwd.startsWith('/') ? r.reply.cwd : undefined
    started.set(startedSid, rowOf({ sid: startedSid, taskId, ...(cwd ? { cwd } : {}), mode: mode0, title, project, at: now(), status: 'running' }))
    watch(startedSid)
    deps.log('info', 'replica: a new ask started on this host while the Mac is away', { taskId, sessionId: startedSid, agentId: persona.agentId, opId: w.opId })
    deps.broadcast('session:status-changed', { sessionId: startedSid, status: 'running', process_status: 'running', taskId })
    const shown = { ...task, walnut_agent: true, ...(persona.agentId !== 'general' ? { agent_id: persona.agentId } : {}) }
    return v1
      ? { answered: false, status: 201, body: { sessionId: startedSid, taskId, title } }
      : { answered: false, status: 200, body: { taskId, task: shown, sessionId: startedSid } }
  }

  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const hit = req.replicaWrite ? pathMatches(req.method.toUpperCase(), req.path) : null
    if (!hit) { next(); return }
    launch(req, hit.v1).then((a) => {
      if (a.answered || res.headersSent) return
      res.status(a.status).json(a.body)
    }, (err: unknown) => {
      deps.log('warn', 'replica: a new ask failed here', { path: req.path, opId: req.replicaWrite?.opId, error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) { const a = refusalAnswer('internal', 'This host could not start the ask.'); if (!a.answered) res.status(a.status).json(a.body) }
    })
  }

  return {
    handler, rows, watch,
    stop() { if (timer) clearInterval(timer); timer = null; watched.clear() },
  }
}
