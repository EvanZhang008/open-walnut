/**
 * SessionRunner's routing for sessions a host runs and judges itself
 * (docs/plan/one-service-every-host.md, phase 2): the one place the leader's runner hands such a
 * session to its host, so claude-code-session.ts carries only a few calls into here.
 *
 *   start      a start whose host judges it (judge-of.ts judgeOfStart) is assembled on the leader
 *              (hints, the task, the session context: the start bundle) and POSTed to the host
 *   commands   a send, an interrupt of a host-judged session goes to its host
 *   turn end   the runner's result/error handling (queue drain, batch settle) is the host's: skipped
 *   lookups    findSessionByClaudeId and the other lookups answer a host-judged session with its
 *              RemoteJudgedSession, and the runner methods other modules call (the inventory's
 *              Table B) answer from its mirrored state or forward to the host
 *
 * With the switch off no row is a host's and no start is, so every wrapper calls the runner's own
 * method, after one memoized check (judge-of.ts).
 */
import fsp from 'node:fs/promises'
import { log } from '../logging/index.js'
import { EventNames, type BusEvent } from '../core/event-bus.js'
import { judgeOfStart, judgingHostOf, noteHostJudged } from '../core/sessions/judge-of.js'
import { sessionPort } from '../core/sessions/session-port.js'
import { sessionTaskAndEngineInStore } from '../core/session-db.js'
import { isAcpEngine } from '../core/agents/engine-registry.js'
import { remoteJudgedSession, type RemoteJudgedSession } from './remote-judged-session.js'
import type { HostCallTarget } from '../core/session-channel/host-calls.js'
import type { StartBody, StartBundle } from '../core/session-channel/host-api.js'

type AnyFn = (...args: any[]) => any
type Proto = Record<string, unknown>

/** The engine kind of a host-judged session, read once from its row. */
const kinds = new Map<string, 'native' | 'acp'>()

function kindOf(sid: string): 'native' | 'acp' {
  const k = kinds.get(sid)
  if (k) return k
  const row = sessionTaskAndEngineInStore(sid)
  const kind = isAcpEngine((row?.engine ?? undefined) as import('../core/types.js').SessionEngine | undefined) ? 'acp' : 'native'
  if (row) kinds.set(sid, kind)
  return kind
}

/** The proxy of a host-judged session, or undefined (a legacy session). */
export function hostJudgedSession(sid: string, want?: 'native' | 'acp'): RemoteJudgedSession | undefined {
  if (typeof sid !== 'string' || !sid) return undefined
  const host = judgingHostOf(sid)
  if (!host) return undefined
  const kind = kindOf(sid)
  if (want && kind !== want) return undefined
  return remoteJudgedSession(sid, host, kind, () => sessionTaskAndEngineInStore(sid)?.taskId ?? undefined)
}

async function leaderSide() {
  const { activeLeaderSide } = await import('../core/session-channel/leader-boot.js')
  const side = activeLeaderSide()
  if (!side) throw new Error('this server has no link to the hosts that run their sessions')
  return side
}

/** A runner method of a host-judged session, on its host. */
function callRunner(sid: string, member: string, args: unknown[]): Promise<unknown> {
  const p = hostJudgedSession(sid)
  if (!p) return Promise.reject(new Error(`session ${sid} is not run by a host`))
  return p.call(member, args, 'runner' as HostCallTarget)
}

function fire(sid: string, member: string, args: unknown[]): void {
  callRunner(sid, member, args).catch((err: unknown) => {
    log.session.warn('host-run session: a runner call to its host failed', { sessionId: sid, member, error: err instanceof Error ? err.message : String(err) })
  })
}

/** What crosses: a callback does not (respawnOnCurrentPrompt's stillWanted), JSON values do. */
function crossing(args: unknown[]): unknown[] {
  return args.filter((a) => typeof a !== 'function')
}

/**
 * The bus event the runner's subscriber must not handle itself: its handling, or null. Sync, so a
 * legacy session's event keeps its order (no await before the runner's own switch).
 */
export function routeHostJudgedEvent(event: BusEvent): Promise<void> | null {
  const sid = (event.data as { sessionId?: unknown } | null)?.sessionId
  if (typeof sid !== 'string' || !sid) return null
  switch (event.name) {
    case EventNames.SESSION_SEND:
    case EventNames.SESSION_INTERRUPT: {
      const host = judgingHostOf(sid)
      if (!host) return null
      const op = event.name === EventNames.SESSION_SEND ? 'send' : 'interrupt'
      // The provenance rides the envelope (phase.ts reads it): it goes with the command.
      const body = { ...(event.data as Record<string, unknown>), source: event.source }
      return leaderSide().then((side) => op === 'send' ? side.sendToHost(host, body) : side.interruptOnHost(host, body)).then(async (a) => {
        if (a.ok !== true) throw new Error(`the host ${host} refused the ${op}: ${a.error ?? 'no reason given'}`)
        // The task is the leader's: its side of the send is done here (leader-tasks.ts).
        if (op === 'send') {
          const { noteHostSessionSend } = await import('../core/session-channel/leader-tasks.js')
          void noteHostSessionSend(sid, event.source, (event.data as { endsWait?: unknown }).endsWait === true)
        }
      })
    }
    // The host settles the turn, drains the queue and releases what waited on a prompt (its own
    // runner, on its own bus); what it did comes back as facts.
    case EventNames.SESSION_PERMISSION_RESOLVED:
    case EventNames.SESSION_RESULT:
    case EventNames.SESSION_ERROR:
      return judgingHostOf(sid) ? Promise.resolve() : null
    default:
      return null
  }
}

/** Would `host`'s own service run a start there? */
export function startGoesToHost(host: string | undefined): boolean {
  return judgeOfStart(host) === 'host'
}

interface StartData {
  taskId: string
  message: string
  host?: string
  cwd?: string
  mode?: string
  engine?: import('../core/types.js').SessionEngine
  profile?: import('../core/types.js').SessionProfile
  appendSystemPromptExact?: string | null
  largePromptFile?: { localPath: string; originalLength: number }
}

/**
 * The leader's data a host needs to assemble this start (host-api.ts StartBundle): the task, its
 * project's metadata, the session context the leader builds, the place, the profile. A part that
 * fails is left out; the host then answers it from its own copies.
 */
async function startBundle(data: StartData): Promise<StartBundle> {
  const bundle: StartBundle = {
    hintsApplied: true,
    ...(data.cwd ? { place: { cwd: data.cwd, ...(data.host ? { host: data.host } : {}) } } : {}),
    ...(data.profile ? { profile: data.profile } : {}),
  }
  if (data.taskId) {
    try {
      const { getTask, getProjectMetadata } = await sessionPort().tasks.loadTaskManager()
      const task = await getTask(data.taskId)
      if (task) {
        bundle.task = task
        if (task.project) bundle.projectMetadata = (await getProjectMetadata(task.project)) as Record<string, unknown> | null
      }
    } catch (err) {
      log.session.warn('host start: the task was left out of the start bundle', { taskId: data.taskId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const native = !isAcpEngine(data.engine)
  if (native && !data.profile?.slim && data.appendSystemPromptExact === undefined) {
    try {
      const { buildSessionContext } = await sessionPort().launch.loadSessionContext()
      const ctx = await buildSessionContext(data.taskId ?? '', data.cwd, data.host)
      if (ctx.systemPrompt) bundle.sessionContext = { systemPrompt: ctx.systemPrompt }
    } catch (err) {
      log.session.warn('host start: the session context was left out of the start bundle', { taskId: data.taskId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return bundle
}

/**
 * Start a session on the host whose service runs it. `data` already carries its start hints;
 * `commit` is their commit (hint-send.ts), run once the host named the session. `source`: the bus
 * source of the start, which frames its first message on the host as it would here.
 */
export async function startOnJudgingHost<T extends StartData>(data: T, commit: (sid: string) => Promise<void>, source?: string): Promise<{ claudeSessionId: string; title: string }> {
  const host = data.host!
  const { largePromptFile, ...rest } = data
  const payload = { ...rest } as unknown as StartBody
  // The spilled message's file is this server's: its text goes instead (the host spills it again).
  if (largePromptFile) payload.largePrompt = await fsp.readFile(largePromptFile.localPath, 'utf8')
  payload.startBundle = await startBundle(data)
  if (source) payload.source = source
  const side = await leaderSide()
  log.session.info('session routing', { taskId: data.taskId, type: 'host', host })
  const a = await side.startOnHost(host, payload)
  if (a.ok !== true || typeof a.sessionId !== 'string' || !a.sessionId) {
    throw new Error(`the host ${host} did not start the session: ${a.error ?? 'no reason given'}${a.why ? ` (${String(a.why)})` : ''}`)
  }
  noteHostJudged(a.sessionId, host)
  kinds.set(a.sessionId, isAcpEngine(data.engine) ? 'acp' : 'native')
  void commit(a.sessionId).catch(() => {})
  // The task is the leader's: its slot, link and phase are set here (leader-tasks.ts).
  const { noteHostSessionStarted } = await import('../core/session-channel/leader-tasks.js')
  void noteHostSessionStarted(a.sessionId, data.taskId, data.mode)
  return { claudeSessionId: a.sessionId, title: typeof a.title === 'string' ? a.title : '' }
}

/** Lookups: the runner's own object first, then a host-judged session's proxy. */
const SYNC_LOOKUPS: Record<string, 'native' | 'acp'> = { findByClaudeId: 'native', findSessionByClaudeId: 'native', findAcpSession: 'acp' }
const ASYNC_LOOKUPS: Record<string, 'native' | 'acp'> = { getOrAttachLiveSession: 'native', findOrAttachAcpSession: 'acp' }
/** Answered from the mirrored state (the rest of Table B goes through findSessionByClaudeId). */
const MIRRORED: Record<string, (p: RemoteJudgedSession, args: unknown[]) => unknown> = {
  isTurnRunning: (p) => p.turnRunning || p.activity === 'processing',
  deliveryWait: (p) => p.deliveryWait,
}
/** Forwarded to the host's runner, its answer awaited. */
const FORWARD_ASYNC = [
  'isBackgroundWorkActive', 'reconcilePendingBackgroundTasks', 'requestTurnCompleteSelfReport', 'changePermissionMode',
  'reinitialize', 'respawnOnCurrentPrompt', 'recoverCancelledForSession',
] as const
/** Forwarded to the host's runner, not awaited (sync methods). */
const FORWARD_SYNC = ['settleInFlightTurn', 'syncTask', 'syncLane', 'adoptNewCwd'] as const
/** The leader's own delivery of a host-judged session: never (the host drains its queue). */
const GATED: Record<string, () => unknown> = {
  processNext: () => Promise.resolve(),
  deliverRest: () => undefined,
  onLinesReclaimedFor: () => undefined,
}

/** Every runner method this module wraps (a test checks each still exists on SessionRunner). */
export const HOST_JUDGED_RUNNER_METHODS: readonly string[] = [
  ...Object.keys(SYNC_LOOKUPS), ...Object.keys(ASYNC_LOOKUPS), ...Object.keys(MIRRORED), ...FORWARD_ASYNC, ...FORWARD_SYNC, ...Object.keys(GATED),
]

const INSTALLED = Symbol.for('walnut.hostJudgedRouting')

/** Wrap SessionRunner's methods (its prototype) once. */
export function installHostJudgedRouting(proto: object): void {
  const p = proto as Proto & { [INSTALLED]?: true }
  if (p[INSTALLED]) return
  p[INSTALLED] = true
  const wrap = (name: string, make: (orig: AnyFn) => AnyFn): void => {
    const orig = p[name]
    if (typeof orig !== 'function') throw new Error(`host-judged routing: SessionRunner has no ${name}`)
    p[name] = make(orig as AnyFn)
  }
  for (const [name, want] of Object.entries(SYNC_LOOKUPS)) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      return orig.call(this, sid, ...rest) ?? hostJudgedSession(sid, want)
    })
  }
  for (const [name, want] of Object.entries(ASYNC_LOOKUPS)) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      const proxy = hostJudgedSession(sid, want)
      return proxy ? Promise.resolve(proxy) : orig.call(this, sid, ...rest)
    })
  }
  for (const [name, answer] of Object.entries(MIRRORED)) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      const proxy = hostJudgedSession(sid)
      return proxy ? answer(proxy, rest) : orig.call(this, sid, ...rest)
    })
  }
  for (const name of FORWARD_ASYNC) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      return judgingHostOf(sid) ? callRunner(sid, name, crossing(rest)) : orig.call(this, sid, ...rest)
    })
  }
  for (const name of FORWARD_SYNC) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      if (judgingHostOf(sid)) { fire(sid, name, crossing(rest)); return undefined }
      return orig.call(this, sid, ...rest)
    })
  }
  for (const [name, skip] of Object.entries(GATED)) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      return judgingHostOf(sid) ? skip() : orig.call(this, sid, ...rest)
    })
  }
}

export function _resetHostJudgedRunnerForTesting(): void {
  kinds.clear()
}
