/**
 * The session port of a host that runs and judges its own sessions (sessions/session-port.ts;
 * docs/plan/one-service-every-host.md, phase 2, the plan's section 1). The session classes run
 * here unchanged; what they read and write of the leader's data answers here by group:
 *
 *   records   this host's own session store; a row this host makes is its own (`judge:'host'`,
 *             `host: WALNUT_HOST_KEY`), and a rename or a removal of one is told to the fact
 *             emitter (host-emitter.ts). A row that is a copy of the leader's stays as it was.
 *   tasks     reads: the start bundle of the start in flight (host-api.ts StartBundle), else this
 *             host's copies. The task side of a session this host runs (its session links, the
 *             phase its start and its turns move, its last activity) is the leader's, made from
 *             the facts it applies (leader-tasks.ts, and its turn-end handlers on the facts it
 *             re-emits): answered here as unchanged, never tried. The code outside the session
 *             classes reaches the same writes through applySessionPhase and the task-manager's
 *             session-link writer, which skip them by judge-of.ts taskSideOnLeader. Any other
 *             field of an updateTask goes to this service's own API as the session's own call
 *             (the in-process credential naming the session, replica/write-actor.ts), so the
 *             follower's route table decides, exactly as for a session's `walnut` call: away, the
 *             write port journals it for the leader; a write the table keeps for the leader
 *             answers `needs_leader`, raised as NeedsLeaderError (the existing shape).
 *   config    this host's config copy (the leader's settings without its secrets).
 *   launch    the bundle first (the session context, the hints already applied), else this host's
 *             own modules on its copies; the leader's list of frequent folders is not written here.
 *   messages  the queue of a session runs where the session runs: this host's own.
 *   recovery  this host's own modules.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { leaderSessionPort } from '../sessions/session-port-leader.js'
import { callThrough, type SessionPort, type SessionTrackerPort, type TaskManagerPort, type PhasePort } from '../sessions/session-port.js'
import { rowOwnedHere } from '../sessions/session-row-owner.js'
import { NeedsLeaderError } from '../replication/needs-leader.js'
import type { StartBundle } from './host-api.js'
import type { Task } from '../types.js'

/**
 * How long a bundle stays when its start never clears it (a lost route): a safety bound only. A
 * start in flight clears its own entry when it ends, however long it took.
 */
const BUNDLE_MAX_MS = 60 * 60_000

interface BundleEntry { taskId: string; bundle: StartBundle; sid?: string; until: number }

/**
 * The bundles of the starts in flight, each under its start's own id (its preassigned session id,
 * or one made for it: host-routes.ts startIdOf), never by task: two starts of one task each keep
 * their own (R2-M5). A read made inside a start (`run`) answers from that start's bundle; any other
 * read of a task answers from the newest bundle of that task.
 */
export class StartBundles {
  private byStart = new Map<string, BundleEntry>()
  private readonly current = new AsyncLocalStorage<string>()
  constructor(private readonly now: () => number = Date.now) {}

  put(startId: string, taskId: string, bundle: StartBundle, sid?: string): void {
    if (!startId || !taskId) return
    this.byStart.delete(startId)
    this.byStart.set(startId, { taskId, bundle, ...(sid ? { sid } : {}), until: this.now() + BUNDLE_MAX_MS })
  }

  /** Run `fn` as start `startId`: the reads it makes answer from its own bundle first. */
  /** Is a start of the session `sid` (its preassigned id) running here now? */
  startingSid(sid: string): boolean {
    const at = this.now()
    for (const e of this.byStart.values()) if (e.sid === sid && e.until > at) return true
    return false
  }

  run<T>(startId: string, fn: () => Promise<T>): Promise<T> {
    return this.current.run(startId, fn)
  }

  /** The bundle that answers for `taskId` here: the running start's, else the newest of that task. */
  private entry(taskId: string | undefined): BundleEntry | null {
    if (!taskId) return null
    const at = this.now()
    const mine = this.current.getStore()
    if (mine) {
      const e = this.byStart.get(mine)
      if (e && e.until > at && (e.taskId === taskId || e.bundle.task?.id === taskId)) return e
    }
    let found: BundleEntry | null = null
    for (const [id, e] of this.byStart) {
      if (e.until <= at) { this.byStart.delete(id); continue }
      if (e.taskId === taskId) found = e
    }
    return found
  }

  get(taskId: string | undefined): StartBundle | null {
    return this.entry(taskId)?.bundle ?? null
  }

  /** The session id the start in flight for `taskId` named (its preassigned id), if any. */
  sidOf(taskId: string): string | null {
    return this.entry(taskId)?.sid ?? null
  }

  /** The bundle's task when `idPrefix` names it. */
  task(idPrefix: string): Task | null {
    const own = this.entry(idPrefix)
    if (own?.bundle.task) return own.bundle.task
    const at = this.now()
    for (const e of [...this.byStart.values()].reverse()) {
      if (e.until <= at) continue
      if (e.bundle.task && e.bundle.task.id === idPrefix) return e.bundle.task
    }
    return null
  }

  /** The project metadata a bundle in flight carries for `project`; undefined: none says. */
  projectMetadata(project: string): Record<string, unknown> | null | undefined {
    const at = this.now()
    const mine = this.current.getStore()
    const entries = [...this.byStart.entries()].reverse()
    entries.sort(([a], [b]) => (a === mine ? -1 : b === mine ? 1 : 0))
    for (const [, e] of entries) {
      if (e.until <= at || e.bundle.projectMetadata === undefined) continue
      if ((e.bundle.task?.project ?? '') === project) return e.bundle.projectMetadata
    }
    return undefined
  }

  /** The start ended: only its own entry goes. */
  clear(startId: string): void { this.byStart.delete(startId) }
}

/** This service's own API, called as one of its sessions (null `sid`: as no session). */
export interface OwnApi {
  request(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body: unknown, opts: { sid: string | null }): Promise<{ status: number; body: unknown }>
}

/**
 * The default OwnApi: an HTTP call to this server's own root with its in-process credential and
 * the caller session (lib/self-api-root.ts, replica/write-actor.ts). Null before the server listens.
 */
export async function selfOwnApi(): Promise<OwnApi | null> {
  const [{ demoApiHeaders, getSelfApiRoot, getSelfCallToken }, { CALLER_SID_HEADER }] = await Promise.all([
    import('../../lib/self-api-root.js'), import('../../ops/executor.js'),
  ])
  return {
    async request(method, path, body, opts) {
      const root = getSelfApiRoot()
      const token = getSelfCallToken()
      if (!root || !token) throw new NeedsLeaderError('no_self_api', 'this host\'s server cannot call its own API yet')
      const url = root + path
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`, 'content-type': 'application/json', ...demoApiHeaders(url),
          ...(opts.sid ? { [CALLER_SID_HEADER]: opts.sid } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let parsed: unknown = null
      try { parsed = text ? JSON.parse(text) : null } catch { parsed = { error: text.slice(0, 300) } }
      return { status: res.status, body: parsed }
    },
  }
}

export interface HostSessionPortOptions {
  /** This host's key (WALNUT_HOST_KEY). */
  hostKey: string
  bundles: StartBundles
  api: () => Promise<OwnApi | null>
  /** The session of this host that runs `taskId`, for a task write made on its behalf. */
  sessionOfTask?(taskId: string): string | null
  /** Before the store renames: the emitter expects it (host-emitter.ts expectRename). */
  beforeRename?(from: string, to: string): void
  /** The store did not rename (it answered no, or threw). */
  renameFailed?(from: string, to: string): void
  onRename?(from: string, to: string): void
  onDrop?(sids: string[]): void
  /** The modules every member falls back to (the leader's port is this host's own modules). */
  base?: SessionPort
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/** A route's refusal as the error the session classes already know. */
function refusal(status: number, body: unknown, fallbackWhy: string): NeedsLeaderError {
  const err = (body as { error?: unknown } | null)?.error
  const e = err && typeof err === 'object' ? err as { why?: unknown; code?: unknown; message?: unknown } : null
  const why = typeof e?.why === 'string' ? e.why : typeof e?.code === 'string' ? e.code : fallbackWhy
  const message = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : `this host could not make the write (${status})`
  return new NeedsLeaderError(why, message)
}

export function createHostSessionPort(o: HostSessionPortOptions): SessionPort {
  const base = o.base ?? leaderSessionPort
  const t = (): SessionTrackerPort => base.records.tracker
  const hostKey = o.hostKey

  const tracker: SessionTrackerPort = {
    acceptAcpPrompt: callThrough(t, 'acceptAcpPrompt'),
    emitSessionStatusChanged: callThrough(t, 'emitSessionStatusChanged'),
    getAcpIdentityReplacementTarget: callThrough(t, 'getAcpIdentityReplacementTarget'),
    getSessionByClaudeId: callThrough(t, 'getSessionByClaudeId'),
    listOrphanCandidates: callThrough(t, 'listOrphanCandidates'),
    rollbackAcpSessionIdMigration: callThrough(t, 'rollbackAcpSessionIdMigration'),
    stageAcpSessionIdMigration: callThrough(t, 'stageAcpSessionIdMigration'),
    updateSessionRecord: callThrough(t, 'updateSessionRecord'),
    updateSessionRecordConditionally: callThrough(t, 'updateSessionRecordConditionally'),
    createSessionRecord: (async (sid, taskId, project, cwd, extra) => {
      const existing = await t().getSessionByClaudeId(sid)
      // A copy of a leader's row (a session this host does not judge) is written as before.
      if (existing && !rowOwnedHere(existing, hostKey)) return t().createSessionRecord(sid, taskId, project, cwd, extra)
      // A row made with this host's own key is judge 'host' at birth (session-db.ts, the own-row writer).
      return t().createSessionRecord(sid, taskId, project, cwd, { ...extra, host: hostKey })
    }) as SessionTrackerPort['createSessionRecord'],
    renameSessionId: (async (from, to, updates) => {
      // Said before the write: the store announces the new id's row before this call returns.
      o.beforeRename?.(from, to)
      let r: Awaited<ReturnType<SessionTrackerPort['renameSessionId']>>
      try {
        r = await t().renameSessionId(from, to, updates)
      } catch (err) {
        o.renameFailed?.(from, to)
        throw err
      }
      if (r) o.onRename?.(from, to)
      else o.renameFailed?.(from, to)
      return r
    }) as SessionTrackerPort['renameSessionId'],
    deleteSessionRecords: (async (ids, reason) => {
      const n = await t().deleteSessionRecords(ids, reason)
      if (n > 0) o.onDrop?.([...ids])
      return n
    }) as SessionTrackerPort['deleteSessionRecords'],
  }

  async function taskWrite(taskId: string, method: 'PATCH', path: string, body: unknown): Promise<unknown> {
    const sid = o.sessionOfTask?.(taskId) ?? o.bundles.sidOf(taskId)
    if (!sid) throw new NeedsLeaderError('no_caller_session', 'no session of this host runs this task, so the write is the leader\'s')
    const api = await o.api()
    if (!api) throw new NeedsLeaderError('no_self_api', 'this host\'s server cannot call its own API yet')
    const r = await api.request(method, path, body, { sid })
    if (r.status >= 200 && r.status < 300) return r.body
    throw refusal(r.status, r.body, 'task_writes_need_mac')
  }

  const taskManager = async (): Promise<TaskManagerPort> => {
    const local = await base.tasks.loadTaskManager()
    const getTask = async (id: string): Promise<Task> => o.bundles.task(id) ?? local.getTask(id)
    /** A session link: the leader's, from the facts (leader-tasks.ts). The task answers as it is. */
    const leaderLinks = async (id: string): Promise<{ task: Task }> => ({ task: await getTask(id) })
    return {
      getTask,
      getProjectMetadata: (async (project) => {
        const fromBundle = o.bundles.projectMetadata(project)
        return fromBundle !== undefined ? fromBundle : local.getProjectMetadata(project)
      }) as TaskManagerPort['getProjectMetadata'],
      updateTask: (async (id, updates) => {
        // The phase a start moves is the leader's: it moves it when the session's row is born there.
        const { phase: _leaderMovesIt, ...rest } = (updates ?? {}) as Record<string, unknown>
        if (Object.keys(rest).length === 0) return { task: await getTask(id) }
        const body = await taskWrite(id, 'PATCH', `/api/tasks/${encodeURIComponent(id)}`, rest)
        const task = (body as { task?: Task } | null)?.task
        return { task: task ?? await local.getTask(id) }
      }) as TaskManagerPort['updateTask'],
      linkSession: leaderLinks as TaskManagerPort['linkSession'],
      linkSessionSlot: leaderLinks as TaskManagerPort['linkSessionSlot'],
      clearSession: leaderLinks as TaskManagerPort['clearSession'],
      clearSessionSlot: leaderLinks as TaskManagerPort['clearSessionSlot'],
      addSessionToHistory: leaderLinks as TaskManagerPort['addSessionToHistory'],
      replaceSessionIdLinks: leaderLinks as TaskManagerPort['replaceSessionIdLinks'],
      // Every activity of a session asks this: the leader reads it off the facts instead.
      touchLastSessionUpdate: async () => {},
    }
  }

  const phase = async (): Promise<PhasePort> => {
    const local = await base.tasks.loadPhase()
    return {
      applySessionPhase: (async () => ({ changed: false })) as PhasePort['applySessionPhase'],
      isChatSendSource: local.isChatSendSource,
      isPersonSendSource: local.isPersonSendSource,
      sendSourceReopensTerminal: local.sendSourceReopensTerminal,
    }
  }

  return {
    records: { tracker, loadTracker: async () => tracker },
    tasks: {
      loadTaskManager: taskManager,
      loadPhase: phase,
      // A started session's link to its task is the leader's, from its born row (leader-tasks.ts):
      // nothing here asks the task copy, which may not have a task made a moment ago (start-link.ts).
      loadStartLink: async () => ({ linkStartedSession: async () => {}, linkAcpStartedSession: async () => {} }),
    },
    config: base.config,
    launch: {
      ...base.launch,
      loadSessionContext: async () => {
        const local = await base.launch.loadSessionContext()
        return {
          buildSessionContext: async (taskId, cwd, host, opts) => {
            const ctx = o.bundles.get(taskId)?.sessionContext
            if (ctx) return ctx
            const task = opts?.task ?? o.bundles.task(taskId) ?? undefined
            return local.buildSessionContext(taskId, cwd, host, task ? { ...opts, task } : opts)
          },
        }
      },
      // The leader's list of the folders sessions start in: not this host's to write.
      loadFrequentDirs: async () => ({ recordDirectory: (async () => {}) as never }),
    },
    messages: {
      ...base.messages,
      loadHintSend: async () => {
        const local = await base.messages.loadHintSend()
        return {
          prepareStartHints: (async (data, opts) => {
            if (o.bundles.get((data as { taskId?: string }).taskId)?.hintsApplied) return { data, commit: async () => {} }
            return local.prepareStartHints(data, opts)
          }) as typeof local.prepareStartHints,
        }
      },
    },
    recovery: base.recovery,
  }
}
