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
import { forgetHostJudged, judgeOfStart, judgingHostOf, noteHostJudged } from '../core/sessions/judge-of.js'
import { sessionPort } from '../core/sessions/session-port.js'
import { sessionTaskAndEngineInStore } from '../core/session-db.js'
import { isAcpEngine } from '../core/agents/engine-registry.js'
import { remoteJudgedSession, type RemoteJudgedSession } from './remote-judged-session.js'
import type { HostCallTarget } from '../core/session-channel/host-calls.js'
import type { StartBody, StartBundle } from '../core/session-channel/host-api.js'
import { claimHostStarted, hostStartedSaid, noteHostSessionStarted } from '../core/session-channel/leader-tasks.js'
import { _resetHostJudgedSendForTesting, forwardSend, inOrder } from './host-judged-send.js'

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

/**
 * A runner method of a host-judged session, on its host. `args` are the method's arguments after
 * the session id: the sid rides the call's body and the host puts it first (host-calls.ts
 * hostCallArgs). A callback cannot cross: such a call is refused here, never sent short.
 */
function callRunner(sid: string, member: string, args: unknown[]): Promise<unknown> {
  const p = hostJudgedSession(sid)
  if (!p) return Promise.reject(new Error(`session ${sid} is not run by a host`))
  if (args.some((a) => typeof a === 'function')) return Promise.reject(new Error(`${member} takes a callback, which cannot reach the host that runs session ${sid}`))
  return p.call(member, args, 'runner' as HostCallTarget)
}

function fire(sid: string, member: string, args: unknown[]): void {
  callRunner(sid, member, args).catch((err: unknown) => {
    log.session.warn('host-run session: a runner call to its host failed', { sessionId: sid, member, error: err instanceof Error ? err.message : String(err) })
  })
}

/**
 * The bus event the runner's subscriber must not handle itself: its handling, or null. Sync, so a
 * legacy session's event keeps its order (no await before the runner's own switch).
 */
export function routeHostJudgedEvent(event: BusEvent): Promise<void> | null {
  // A host's record said again here (leader-side.ts) is never a command to this runner.
  if (event.source === 'host-channel') return Promise.resolve()
  const sid = (event.data as { sessionId?: unknown } | null)?.sessionId
  if (typeof sid !== 'string' || !sid) return null
  switch (event.name) {
    case EventNames.SESSION_SEND:
    case EventNames.SESSION_INTERRUPT: {
      const host = judgingHostOf(sid)
      if (!host) return null
      // The provenance rides the envelope (phase.ts reads it): it goes with the command.
      const body = { ...(event.data as Record<string, unknown>), busSource: event.source }
      if (event.name === EventNames.SESSION_INTERRUPT) {
        return inOrder(sid, async () => {
          const a = await (await leaderSide()).interruptOnHost(host, body)
          if (a.ok !== true) throw new Error(`the host ${host} refused the interrupt: ${a.error ?? 'no reason given'}`)
        })
      }
      return forwardSend(sid, host, body, event.source, (event.data as { endsWait?: unknown }).endsWait === true)
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

/**
 * Seeded sessions whose start went to their host and whose born row has not come yet (a start the
 * host answered, or one whose answer was lost), until then or IN_FLIGHT_MS: a rows snapshot keeps
 * them untouched (rows-snapshot.ts), even one taken before the host wrote the row.
 */
const inFlight = new Map<string, number>()
const IN_FLIGHT_MS = 15 * 60_000
export function hostStartsInFlight(): ReadonlySet<string> {
  const now = Date.now()
  for (const [sid, until] of inFlight) if (until <= now) inFlight.delete(sid)
  return new Set(inFlight.keys())
}

/** The host's born row of `sid` was applied here (leader-side.ts): its start is no longer in flight. */
export function noteHostStartBorn(sid: string): void {
  inFlight.delete(sid)
}

/**
 * The start's answer did not come (the leader's timeout, a link that dropped): the host may run it.
 * Thrown by the request (never an answer the host gave). Exported for tests.
 */
export class HostStartOutcomeUnknown extends Error {
  readonly why = 'host_start_outcome_unknown'
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
  // The spilled message's file is this server's: its text goes instead, with the path the message
  // names, and the host spills it again and points the message at its own file.
  if (largePromptFile) {
    payload.largePrompt = await fsp.readFile(largePromptFile.localPath, 'utf8')
    payload.largePromptPath = largePromptFile.localPath
    // This server's copy is read: nothing here reads it again.
    await fsp.rm(largePromptFile.localPath, { force: true }).catch(() => {})
  }
  payload.startBundle = await startBundle(data)
  if (source) payload.busSource = source
  const side = await leaderSide()
  // A row seeded for this start (task-start.ts makes one under the id it answers with) is the
  // host's before the host speaks: its facts can beat the start's answer.
  const seeded = (data as { preassignedSessionId?: unknown }).preassignedSessionId
  const tracker = await import('../core/session-tracker.js')
  let handed = false
  if (typeof seeded === 'string' && seeded) {
    inFlight.set(seeded, Date.now() + IN_FLIGHT_MS)
    noteHostJudged(seeded, host)
    handed = await tracker.handSeedToHost(seeded, host).catch((err: unknown) => {
      log.session.warn('host start: the seeded row was not handed to its host', { sessionId: seeded, host, error: err instanceof Error ? err.message : String(err) })
      return false
    })
  }
  log.session.info('session routing', { taskId: data.taskId, type: 'host', host })
  let a: Awaited<ReturnType<typeof side.startOnHost>>
  try {
    a = await side.startOnHost(host, payload)
  } catch (err) {
    // No answer (the leader's timeout, a link that dropped): the host may have taken it, so it is
    // the host's (one owner): never failed here as the leader's own, never run here. Its born row
    // says it started, the host's own row says how it ended (R2-H2).
    const why = err instanceof Error ? err.message : String(err)
    if (typeof seeded === 'string' && seeded) {
      log.session.warn('host start: no answer from the host; the session stays the host\'s and its channel tells what became of it', { sessionId: seeded, host, error: why })
      void commit(seeded).catch(() => {})
      return { claudeSessionId: seeded, title: '' }
    }
    throw new HostStartOutcomeUnknown(`the host ${host} did not answer the start (${why}); if it took it, its channel brings the session`)
  }
  if (a.ok !== true || typeof a.sessionId !== 'string' || !a.sessionId) {
    // The host said no: the seed is the leader's again, and the start's failure is written on it.
    if (typeof seeded === 'string' && seeded) {
      inFlight.delete(seeded)
      forgetHostJudged(seeded)
      if (handed) await tracker.takeSeedBack(seeded, host).catch(() => {})
    }
    throw new Error(`the host ${host} did not start the session: ${a.error ?? 'no reason given'}${a.why ? ` (${String(a.why)})` : ''}`)
  }
  noteHostJudged(a.sessionId, host)
  kinds.set(a.sessionId, isAcpEngine(data.engine) ? 'acp' : 'native')
  void commit(a.sessionId).catch(() => {})
  // The start is this leader's, so its session:started is too, as the runner says it for a start
  // it runs (handleStart), now with the id the host named; unless the channel said it first (the
  // host's born row of it, or its own fact, beat this answer): one per session (claimHostStarted).
  if (claimHostStarted(a.sessionId)) {
    const { bus } = await import('../core/event-bus.js')
    bus.emit(EventNames.SESSION_STARTED, {
      sessionId: a.sessionId, claudeSessionId: a.sessionId, taskId: data.taskId,
      project: (data as { project?: string }).project ?? payload.startBundle?.task?.project ?? '', host,
    }, ['main-ai'], { source: 'session-runner' })
  }
  // The task is the leader's: its slot, link and phase are set here (leader-tasks.ts), once.
  void noteHostSessionStarted(a.sessionId, data.taskId, data.mode)
  return { claudeSessionId: a.sessionId, title: typeof a.title === 'string' ? a.title : '' }
}

/** Was `sid`'s session:started said on this leader already (its handed start, or the channel's first word)? */
export function startAnnouncedHere(sid: string): boolean {
  return hostStartedSaid(sid)
}

/**
 * The channel's re-emit asks this for each fact: a session:started said here already (the start
 * this leader handed on, or the one said from the host's born row) is not said again; one not said
 * yet is claimed, so the answer of a handed start that comes after it says none either.
 */
export function saidHereAlready(name: string, data: unknown): boolean {
  if (name !== EventNames.SESSION_STARTED) return false
  const d = data as { sessionId?: unknown; claudeSessionId?: unknown } | null
  const sid = d?.sessionId ?? d?.claudeSessionId
  return typeof sid === 'string' && !!sid && !claimHostStarted(sid)
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
  'reinitialize', 'recoverCancelledForSession',
] as const
/** Forwarded to the host's runner, not awaited (sync methods). */
const FORWARD_SYNC = ['settleInFlightTurn', 'syncTask', 'syncLane', 'adoptNewCwd'] as const
/**
 * Refused for a host-judged session, by name: a host runs these for its own sessions itself.
 * respawnOnCurrentPrompt takes a callback (host-calls.ts) and the host's own prompt refresh runs it.
 */
export class HostRunsItError extends Error {
  readonly why = 'host_runs_it'
  constructor(member: string, sid: string, host: string) {
    super(`${member} is not run here for session ${sid}: its host ${host} runs it itself`)
  }
}
const REFUSED = ['respawnOnCurrentPrompt'] as const
/** The leader's own delivery of a host-judged session: never (the host drains its queue). */
const GATED: Record<string, () => unknown> = {
  processNext: () => Promise.resolve(),
  deliverRest: () => undefined,
  onLinesReclaimedFor: () => undefined,
}

/** Every runner method this module wraps (a test checks each still exists on SessionRunner). */
export const HOST_JUDGED_RUNNER_METHODS: readonly string[] = [
  ...Object.keys(SYNC_LOOKUPS), ...Object.keys(ASYNC_LOOKUPS), ...Object.keys(MIRRORED), ...FORWARD_ASYNC, ...FORWARD_SYNC, ...REFUSED, ...Object.keys(GATED),
]

/** The runner methods forwarded to a host-run session's host: each is in HOST_CALL_ALLOWLIST.runner (a test checks). */
export const HOST_FORWARDED_RUNNER_METHODS: readonly string[] = [...FORWARD_ASYNC, ...FORWARD_SYNC]

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
      return judgingHostOf(sid) ? callRunner(sid, name, rest) : orig.call(this, sid, ...rest)
    })
  }
  for (const name of FORWARD_SYNC) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      if (judgingHostOf(sid)) { fire(sid, name, rest); return undefined }
      return orig.call(this, sid, ...rest)
    })
  }
  for (const name of REFUSED) {
    wrap(name, (orig) => function (this: unknown, sid: string, ...rest: unknown[]) {
      const host = judgingHostOf(sid)
      return host ? Promise.reject(new HostRunsItError(name, sid, host)) : orig.call(this, sid, ...rest)
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
  inFlight.clear()
  _resetHostJudgedSendForTesting()
}
