/**
 * What a service set move (service-set-move.ts) asks the shared daemon and this server before it
 * stops anything there, each answered by the repo's own checks, never by a stored status alone
 * (review round 1, B4 and B5):
 *
 *   moveSessions    this Walnut's sessions there: every record of this host the store holds live
 *                   or failed (running, idle, error), and every one the daemon itself lists alive
 *                   (a record a restart left 'stopped'). Each is judged busy by this server's runner
 *                   (in a turn, work that outlives its turn: outliving-work.ts) and by a fresh
 *                   getState from the daemon (host-work.ts hostWorkFrom: the turn, a permission
 *                   prompt, background commands and subagents, an agent team, a wakeup, a /loop).
 *                   No answer is busy. An ACP session blocks the move (its worker's stop cannot be
 *                   proven the same way), as does a CLI of it running outside the shared daemon.
 *   stopProven      the normal stop (terminateSession), then the proof its CLI is gone: the
 *                   daemon's cli.holder, which judges the owner record by pid AND start time and
 *                   scans the process table (cli-owner-core.ts). A lost host, an unconfirmed stop
 *                   or a daemon that cannot answer cli.holder is no proof.
 *   openWorkThere   other work of this Walnut there: commands under way on the link, and the
 *                   host_exec runs of this Walnut's tasks (exec.list).
 *   dropWalnutScope this Walnut's triggers and plugin jobs on the shared daemon emptied, the way the
 *                   leader configures them (triggers.configure, jobs.configure for its home), so
 *                   that daemon neither checks nor fires them nor resumes a session for a fire;
 *                   none left armed (a trigger a journal record holds is armed again by the daemon)
 *                   and no fire undelivered.
 *   moveBlocker     a shared daemon the move must not touch at all: one older than the per-Walnut
 *                   split (no walnut-scope-v1: an empty set there clears every Walnut's triggers,
 *                   review round 2, M5), or one that cannot hand over this Walnut's triggers' memory.
 *   takeTriggerMemory / seedTriggerMemory  each disarmed trigger's exact state (its seen items and
 *                   cursor) from the shared daemon (triggers.state.snapshot), handed to the set's
 *                   daemon before the triggers are pushed there (triggers.state.seed), so their first
 *                   check there does not report every item again (review round 2, M2).
 *   stopFollowerThere  this Walnut's follower there stopped and proven off (server.status).
 */
import type { SessionRecord } from '../core/types.js'
import type { TerminateResult } from '../core/sessions/session-lifecycle.js'
import { hostWorkFrom, HOST_WORK_TIMEOUT_MS, type HostWork } from '../core/sessions/host-work.js'
import { OUTLIVING_SOURCES, type OutlivingSource } from '../core/sessions/outliving-work.js'
import { assertOutwardDoor, leaderPermitActive } from '../core/leader/switch/doors.js'
import { isAcpEngine } from '../core/agents/engine-registry.js'
import type { CliHolderAnswer } from './remote-session-manager.js'
import type { MoveSession, StopResult } from './service-set-move.js'
import { HostRevokedError, revokedAs } from '../core/session-channel/revoked-hosts.js'

/** The link's part these checks use (service-set-move-link.ts SetLinkConn). */
export interface MoveCheckLink {
  hostKey: string
  home: string
  /** Past the move's own hold. */
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  hasCapability(cap: string): boolean
  /** Work commands on this link not answered yet. */
  workUnderWay(): number
  walnutId(): Promise<string>
}

/** This server's own facts; the defaults read the session store, the runner and the task store. */
export interface MoveCheckDeps {
  records?(): Promise<SessionRecord[]>
  runner?(): Promise<{
    inTurn(id: string): boolean | null
    outliving(id: string): OutlivingSource[]
    cronArmed(id: string): boolean
  }>
  terminate?(id: string): Promise<TerminateResult>
  holder?(link: MoveCheckLink, sid: string): Promise<CliHolderAnswer>
  /** Which of these task ids are this Walnut's. */
  ownTasks?(ids: string[]): Promise<Set<string>>
  /** Whether this server started the host command `jobId` (host-exec-jobs.ts startedRun): a run that names no task. */
  startedHere?(jobId: string): Promise<boolean>
  now?(): number
  sleep?(ms: number): Promise<void>
}

/** How long a stop's proof waits for a CLI that takes its time to exit after its SIGINT (drill round 3, R3-2: 8 s). */
export const STOP_PROOF_MS = 30_000
const STOP_PROOF_EVERY_MS = 2_000

const LIVE_OR_FAILED = new Set(['running', 'idle', 'error'])

async function defaultRecords(): Promise<SessionRecord[]> {
  return (await import('../core/session-tracker.js')).listSessions()
}

async function defaultRunner(): Promise<NonNullable<Awaited<ReturnType<NonNullable<MoveCheckDeps['runner']>>>>> {
  const { sessionRunner } = await import('./claude-code-session.js')
  return {
    inTurn: (id) => sessionRunner.isInTurn(id),
    outliving: (id) => sessionRunner.outlivingWorkOf(id),
    cronArmed: (id) => sessionRunner.isCronArmed(id),
  }
}

async function defaultHolder(link: MoveCheckLink, sid: string): Promise<CliHolderAnswer> {
  const { askCliHolder } = await import('./remote-session-manager.js')
  const { hostHolder } = await import('../core/sessions/org-own-folder.js')
  const asked = { hasCapability: (c: string) => link.hasCapability(c), send: async (cmd: string, p: Record<string, unknown>, t?: number) => ({ ok: true, ...(await link.send(cmd, p ?? {}, t)) }) }
  return hostHolder((s) => askCliHolder(asked, s), sid)
}

async function defaultTerminate(id: string): Promise<TerminateResult> {
  const { terminateSession } = await import('../core/sessions/session-lifecycle.js')
  return terminateSession(id, { by: 'walnut' })
}

async function defaultStartedHere(jobId: string): Promise<boolean> {
  return !!(await import('../core/hosts/host-exec-jobs.js')).startedRun(jobId)
}

async function defaultOwnTasks(ids: string[]): Promise<Set<string>> {
  const { listTasksByIds } = await import('../core/task-manager.js')
  return new Set((await listTasksByIds(ids)).map((t) => t.id))
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 200)
const workWords = (sources: readonly OutlivingSource[]): string => sources.map((s) => OUTLIVING_SOURCES[s]).join(', ')

/** The daemon's own list of the sessions whose CLI lives there (`list`). Throws when it does not answer. */
async function aliveOnDaemon(link: MoveCheckLink): Promise<Set<string>> {
  const r = await link.send('list', {}, 10_000)
  if (r.ok === false || !Array.isArray(r.sessions)) throw new Error(`the shared daemon did not list its sessions (${String(r.error ?? 'no list')})`)
  return new Set((r.sessions as Array<{ sid?: unknown; alive?: unknown }>).filter((s) => s.alive === true && typeof s.sid === 'string').map((s) => s.sid as string))
}

/** Fields a snapshot of a daemon that can say what outlives a turn always carries (daemon-fold.ts assembleSnapshot). */
const FULL_SNAPSHOT = ['detachedBgCount', 'teamActive', 'cronActive', 'wakeupAt'] as const

/**
 * Why the host's answer cannot prove a live session quiet: no snapshot, an older daemon's snapshot
 * missing what outlives a turn, a line it was sent and has not answered, an open prompt. Null: it can.
 * The move reads any doubt as busy, never as quiet (review round 2, M1).
 */
function notProvenQuiet(resp: Record<string, unknown>): string | null {
  const snap = resp.snapshot as Record<string, unknown> | null | undefined
  if (!snap || !(Number(snap.v) > 0)) return 'the shared daemon gives no snapshot of it'
  const missing = FULL_SNAPSHOT.filter((k) => !(k in snap))
  if (missing.length) return `the shared daemon is too old to say what outlives its turn (no ${missing.join(', ')})`
  const quiet = resp.quiet as { lineAwaitingAnswer?: unknown; promptOpen?: unknown } | undefined
  if (quiet?.lineAwaitingAnswer === true) return 'a line it was sent is not answered yet'
  if (quiet?.promptOpen === true) return 'a prompt of it is open'
  return null
}

/** One session judged: null when nothing of it runs on the host. */
async function judge(link: MoveCheckLink, r: SessionRecord, listedAlive: boolean, d: MoveCheckDeps): Promise<MoveSession | null> {
  const id = r.claudeSessionId
  const say = (w: string) => `session ${id}: ${w}`
  if (isAcpEngine(r.engine)) return { id, blocks: say('an ACP session, whose stop the move cannot prove; it stays where it is') }
  const runner = await (d.runner ?? defaultRunner)()
  if (runner.inTurn(id) === true) return { id, busy: say('in a turn') }
  const own = [...runner.outliving(id)]
  if (runner.cronArmed(id) && !own.includes('loop')) own.push('loop')
  if (own.length) return { id, busy: say(workWords(own)) }
  let resp: Record<string, unknown>
  try {
    resp = await link.send('getState', { sid: id }, HOST_WORK_TIMEOUT_MS)
  } catch (e) {
    return { id, busy: say(`the shared daemon did not answer for it (${errText(e)})`) }
  }
  const work: HostWork | null = resp.ok === true && resp.exists === false && !listedAlive ? { alive: false, working: false } : hostWorkFrom(resp as Parameters<typeof hostWorkFrom>[0])
  if (!work) return { id, busy: say('the shared daemon cannot say what it does') }
  if (!work.alive && !listedAlive) {
    // The daemon holds no live CLI of it: proven by the host's one owner record, else it runs elsewhere.
    const h = await (d.holder ?? defaultHolder)(link, id)
    if (h.state === 'free') return null
    if (h.state === 'held') return { id, blocks: say(`a CLI of it runs on the host outside the shared daemon (${h.detail ?? 'live'})`) }
    return { id, busy: say(`the host cannot say whether a CLI of it runs (${h.state}${h.detail ? `: ${h.detail}` : ''})`) }
  }
  if (work.inTurn) return { id, busy: say('in a turn') }
  const there = work.outliving ?? []
  if (there.length) return { id, busy: say(workWords(there)) }
  const doubt = notProvenQuiet(resp)
  if (doubt) return { id, busy: say(doubt) }
  return { id }
}

/** This Walnut's sessions on the shared daemon, each judged quiet, busy or blocking. Throws when the daemon cannot list them. */
export async function moveSessions(link: MoveCheckLink, d: MoveCheckDeps = {}): Promise<MoveSession[]> {
  const alive = await aliveOnDaemon(link)
  const records = (await (d.records ?? defaultRecords)())
    // An archived record whose CLI the daemon still lists alive is moved too (review round 2, M-L5).
    .filter((s) => s.host === link.hostKey && ((!s.archived && LIVE_OR_FAILED.has(s.process_status)) || alive.has(s.claudeSessionId)))
  const out: MoveSession[] = []
  for (const r of records) {
    const j = await judge(link, r, alive.has(r.claudeSessionId), d)
    if (j) out.push(j)
  }
  return out
}

/** Stop one session the normal way and prove its CLI gone; judged again first (it may have become busy). */
export async function stopProven(link: MoveCheckLink, id: string, d: MoveCheckDeps = {}): Promise<StopResult> {
  const record = (await (d.records ?? defaultRecords)()).find((s) => s.claudeSessionId === id && s.host === link.hostKey)
  if (!record) return { ok: false, why: `session ${id}: its record is gone` }
  const alive = await aliveOnDaemon(link).catch(() => null)
  if (!alive) return { ok: false, busy: true, why: `session ${id}: the shared daemon did not list its sessions` }
  const now = await judge(link, record, alive.has(id), d)
  if (!now) return { ok: true }
  if (now.blocks) return { ok: false, why: now.blocks }
  if (now.busy) return { ok: false, busy: true, why: now.busy }
  let res: TerminateResult
  try {
    res = await (d.terminate ?? defaultTerminate)(id)
  } catch (e) {
    const code = (e as { extra?: { code?: unknown } }).extra?.code
    return { ok: false, why: code === 'cron_owner'
      ? `session ${id}: it owns scheduled crons (a /loop), which its stop would end`
      : `session ${id}: its stop failed (${errText(e)})` }
  }
  if (res.hostLost) return { ok: false, why: `session ${id}: its host read as lost, so its stop is not proven` }
  const state = res.stopRequest?.state ?? (res.status === 'terminated' ? 'confirmed' : res.status)
  const unconfirmed = `session ${id}: the shared daemon did not confirm its stop (${state})`
  if (state !== 'confirmed' && state !== 'pending') return { ok: false, why: unconfirmed }
  // A stop still pending, or a CLI still held, may be a CLI slow to exit: its CLI gone, within a bound, is the proof.
  const clock = d.now ?? Date.now
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }))
  const until = clock() + STOP_PROOF_MS
  for (;;) {
    const h = await (d.holder ?? defaultHolder)(link, id)
    if (h.state === 'free') return { ok: true }
    if (h.state === 'too-old') return { ok: false, why: `session ${id}: the shared daemon cannot prove its CLI is gone (no cli-holder-v1)` }
    if (clock() >= until) {
      if (state === 'pending') return { ok: false, why: unconfirmed }
      return { ok: false, why: `session ${id}: ${h.state === 'held' ? `a CLI of it still runs (${h.detail ?? 'live'})` : `the host did not say its CLI is gone (${h.detail ?? h.state})`}` }
    }
    await sleep(STOP_PROOF_EVERY_MS)
  }
}

/** Other work of this Walnut still on the shared daemon, in words; null when none. */
export async function openWorkThere(link: MoveCheckLink, d: MoveCheckDeps = {}): Promise<string | null> {
  const n = link.workUnderWay()
  if (n > 0) return `${n} command${n === 1 ? '' : 's'} of this Walnut to the shared daemon (a start, a one-shot or a host command) still under way`
  if (!link.hasCapability('host-exec-v1')) return null
  let reply: Record<string, unknown>
  try {
    reply = await link.send('exec.list', {}, 10_000)
  } catch (e) {
    return `the shared daemon did not list its host commands (${errText(e)})`
  }
  if (!Array.isArray(reply.jobs)) return 'the shared daemon did not list its host commands'
  const jobs = (reply.jobs as Array<{ running?: unknown; taskId?: unknown; jobId?: unknown }>).filter((j) => j.running === true)
  const running = jobs.filter((j) => typeof j.taskId === 'string' && j.taskId).map((j) => j.taskId as string)
  // A run that names no task is this Walnut's when this server started it (review round 2, M-L5).
  let mine = 0
  for (const j of jobs) if (!(typeof j.taskId === 'string' && j.taskId) && typeof j.jobId === 'string' && await (d.startedHere ?? defaultStartedHere)(j.jobId)) mine++
  if (running.length === 0 && mine === 0) return null
  const own = running.length ? await (d.ownTasks ?? defaultOwnTasks)([...new Set(running)]) : new Set<string>()
  mine += running.filter((t) => own.has(t)).length
  return mine > 0 ? `${mine} host_exec run${mine === 1 ? '' : 's'} of this Walnut's tasks still run${mine === 1 ? 's' : ''} there` : null
}

export const WALNUT_SCOPE_CAPABILITY = 'walnut-scope-v1'
const SNAPSHOT_CAPABILITY = 'trigger-state-snapshot-v1'
const SEED_CAPABILITY = 'trigger-state-seed-v1'

/** Why the move must not touch this shared daemon at all; null when it may. Asked before anything changes. */
export async function moveBlocker(link: Pick<MoveCheckLink, 'hasCapability'>, triggerIds: readonly string[]): Promise<string | null> {
  // An older daemon keeps one trigger and job set for every Walnut: emptying "ours" empties the other's.
  if (!link.hasCapability(WALNUT_SCOPE_CAPABILITY)) return `the shared daemon is older than the per-Walnut split (no ${WALNUT_SCOPE_CAPABILITY}), so dropping this Walnut's triggers there would clear the other Walnut's too`
  if (triggerIds.length && !link.hasCapability(SNAPSHOT_CAPABILITY)) return `the shared daemon cannot hand over what this Walnut's triggers remember (no ${SNAPSHOT_CAPABILITY}), so they would report every item again`
  return null
}

/** Empty this Walnut's triggers and plugin jobs on the shared daemon (for its home only). Throws when not done. */
export async function dropWalnutScope(link: MoveCheckLink): Promise<void> {
  const home = link.home
  // The outward doors (leader/switch/doors.ts): only the machine holding the write permission changes
  // what a daemon runs for this Walnut. A refusal throws before the shared daemon is told anything.
  if (leaderPermitActive()) {
    assertOutwardDoor('trigger-arm', link.hostKey)
    assertOutwardDoor('plugin-jobs', link.hostKey)
  }
  if (!link.hasCapability(WALNUT_SCOPE_CAPABILITY)) throw new Error(`the shared daemon has no ${WALNUT_SCOPE_CAPABILITY}`)
  const t = await link.send('triggers.configure', { config: { version: 1, triggers: [] }, home }, 30_000)
  if (t.ok !== true) throw new Error(`the shared daemon did not drop this Walnut's triggers (${String(t.error ?? 'no answer')})`)
  const pending = (Array.isArray(t.released) ? t.released as Array<{ pending?: unknown }> : []).filter((r) => Number(r?.pending) > 0)
  // A released clock with fires nobody acked would be started there by the daemon itself.
  if (pending.length) throw new Error(`${pending.length} clock routine${pending.length === 1 ? '' : 's'} there still had fires to deliver`)
  // A trigger a journal record holds is armed again even by an empty set; a fire not acked stays there.
  // (A daemon that does not count them answers neither: its journal was drained before, M3.)
  if (Number(t.armed) > 0) throw new Error(`${Number(t.armed)} of this Walnut's triggers there stay armed (held by its offline journal)`)
  if (Number(t.draining) > 0) throw new Error(`${Number(t.draining)} of this Walnut's triggers there still have fires to deliver`)
  if (!link.hasCapability('plugin-jobs-v1')) return
  const walnutId = await link.walnutId()
  const j = await link.send('jobs.configure', { home, spec: { v: 1, home, walnutId, jobs: [] } }, 30_000)
  if (j.ok !== true) throw new Error(`the shared daemon did not drop this Walnut's plugin jobs (${String(j.error ?? 'no answer')})`)
}

/** One disarmed trigger's exact state on the shared daemon (a triggers.state.snapshot reply's state and digest). */
export interface TriggerMemory { triggerId: string; state: Record<string, unknown>; digest: string }

/** Refusals that pass with a short wait (the disarm just happened). */
const SNAPSHOT_SOON = new Set(['check_running', 'host_delivery_in_flight', 'draining', 'armed'])
/** Refusals that mean there is nothing to carry. */
const SNAPSHOT_NOTHING = new Set(['state_missing', 'state_stale'])

/** Each of `ids`' memory on the shared daemon, after the drop. Throws when one cannot be taken (the move gives up). */
export async function takeTriggerMemory(link: MoveCheckLink, ids: readonly string[], sleep: (ms: number) => Promise<void>): Promise<TriggerMemory[]> {
  if (!ids.length || !link.hasCapability(SNAPSHOT_CAPABILITY)) return []
  const out: TriggerMemory[] = []
  for (const triggerId of ids) {
    for (let i = 0; ; i++) {
      const r = await link.send('triggers.state.snapshot', { home: link.home, triggerId }, 15_000)
      if (r.ok === false) throw new Error(`trigger ${triggerId}: the shared daemon did not answer for its memory (${String(r.error ?? 'no answer')})`)
      if (r.supported === true && r.state && typeof r.digest === 'string') {
        // Carried whatever its entries' age: the shared daemon skips every seen id until a fire prunes it, and the
        // set's daemon reads the same memory the same way. An entry past 30 days is not a reason to report it again.
        out.push({ triggerId, state: r.state as Record<string, unknown>, digest: r.digest })
        break
      }
      const reason = String(r.reason ?? '')
      if (SNAPSHOT_NOTHING.has(reason)) break
      if (!SNAPSHOT_SOON.has(reason) || i >= 4) throw new Error(`trigger ${triggerId}: its memory could not be taken (${reason || 'no answer'})`)
      await sleep(2_000)
    }
  }
  return out
}

/** The set's daemon can never take this memory (no trigger-state-seed-v1): it is owed no more, and the triggers start afresh there. */
export class SeedRefusedForGood extends Error {}

/** A seed that can never land: a daemon with no seed, or a host revoked (HostRevokedError). */
export function seedRefusedForGood(err: unknown): boolean {
  return err instanceof SeedRefusedForGood || err instanceof HostRevokedError
}

/**
 * Answers to a seed that no resend changes (the daemon's errorKind): the socket speaks for another
 * Walnut (refuseForeignHome), a request it cannot read, a Walnut it does not know, a refusal. With
 * an "unknown command" (a daemon that lost the command), they are refusals for good of that trigger.
 */
const SEED_FINAL_KINDS = new Set(['not_owner', 'bad_request', 'unknown_walnut', 'session_other_walnut', 'refused', 'forbidden', 'host_revoked'])
function seedFinalError(r: { errorKind?: unknown; error?: unknown; message?: unknown } | null | undefined): boolean {
  return !!r && (SEED_FINAL_KINDS.has(String(r.errorKind ?? '')) || /unknown command/i.test(String(r.error ?? r.message ?? '')))
}

/** A seed's end: what is still owed (a link cut, a timeout, a write that failed there), and the triggers the set's daemon refused for good. */
export interface SeedOutcome { left: TriggerMemory[]; refused: string[] }

/**
 * Hand the memory to the set's daemon (the link reaches it now), before its triggers are pushed there.
 * Each trigger's memory is taken (seeded, or kept there already), refused for good (any other refusal:
 * the trigger is held there already, a state that does not check out), or still owed: a write that
 * failed there, and on a send that threw or a reply that is no answer, that one and every one after it
 * (an answer no resend changes, SEED_FINAL_KINDS, is a refusal for good of that one).
 * Throws a final refusal for all of it: a revoked host (HostRevokedError), a daemon with no seed.
 */
export async function seedTriggerMemory(link: MoveCheckLink, memory: readonly TriggerMemory[]): Promise<SeedOutcome> {
  if (!memory.length) return { left: [], refused: [] }
  // A revoked host is handed none of this Walnut's trigger memory (session-channel/revoked-reach.ts).
  const as = revokedAs(link.hostKey)
  if (as) throw new HostRevokedError(link.hostKey, 'trigger memory is not handed to it', as)
  if (!link.hasCapability(SEED_CAPABILITY)) throw new SeedRefusedForGood(`the set's daemon takes no trigger memory (no ${SEED_CAPABILITY})`)
  const left: TriggerMemory[] = []
  const refused: string[] = []
  for (let i = 0; i < memory.length; i++) {
    const m = memory[i]!
    let r: Record<string, unknown>
    try {
      r = await link.send('triggers.state.seed', { home: link.home, triggerId: m.triggerId, state: m.state, digest: m.digest }, 15_000)
    } catch (err) {
      if (seedFinalError(err as { errorKind?: unknown; message?: unknown })) { refused.push(`trigger ${m.triggerId}: ${String((err as Error).message ?? err)}`); continue }
      return { left: [...left, ...memory.slice(i)], refused }
    }
    if (r.ok !== true) {
      if (seedFinalError(r)) { refused.push(`trigger ${m.triggerId}: ${String(r.errorKind ?? r.error)}`); continue }
      return { left: [...left, ...memory.slice(i)], refused }
    }
    // `state_exists`: the set already keeps its own (an earlier move there): it is kept.
    if (r.seeded === true || r.reason === 'state_exists') continue
    if (r.reason === 'write_failed') left.push(m)
    else refused.push(`trigger ${m.triggerId}: ${String(r.reason ?? 'no answer')}`)
  }
  return { left, refused }
}

/** Stop this Walnut's follower on the shared daemon and see it off. Throws when it may still run. */
export async function stopFollowerThere(link: MoveCheckLink, sleep: (ms: number) => Promise<void>): Promise<void> {
  // A daemon with no followers at all has none of this Walnut's to stop.
  if (!link.hasCapability('host-server-v1')) return
  const home = link.home
  const r = await link.send('server.configure', { home, spec: null }, 15_000)
  if (r.ok !== true) {
    if (/unknown command/i.test(String(r.error ?? ''))) return
    throw new Error(`server.configure was refused (${String(r.error ?? 'no answer')})`)
  }
  let state = ''
  for (let i = 0; i < 5; i++) {
    const st = await link.send('server.status', { home }, 10_000)
    if (st.ok !== true) throw new Error(`server.status did not answer (${String(st.error ?? 'no answer')})`)
    state = String((st.status as { state?: unknown } | undefined)?.state ?? 'off')
    if (state === 'off') return
    await sleep(2_000)
  }
  throw new Error(`it still reads ${state}`)
}
