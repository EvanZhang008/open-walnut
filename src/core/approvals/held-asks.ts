/**
 * A single-use ask the fence holds back (single-use-fence.ts) waits here until the person is back,
 * and the task that asked is told then to ask again, once (2026-11-25, Walnut VP: a Git push and a
 * leak-gate approval were refused as "user_away", told "do not ask again", and nobody ever asked
 * again: a Slack fix waited five days).
 *
 * The fence still decides when an ask may ring the person's devices; what changed is what a refusal
 * leaves behind. A refusal that only means "not now" (he is away, Walnut cannot tell, another
 * single-use ask is on his devices or is about to be, his last one ended unanswered and he has done
 * nothing since, too many asks wait) keeps a held ask, in a file beside the approvals (held.json; an
 * older Walnut never reads it). Nothing is sent to his devices while it is held.
 *
 *  - Release: once a fresh ask of it would be let through (store.ts heldSweepDeps makes the same
 *    checks createApproval makes: he is back, typed in a chat or a window or the phone app reported
 *    attention on any screen, or a phone streams a session; no other single-use ask is on his
 *    devices; the pending cap has room), the oldest held ask of its class is released: its task's
 *    session is told to take the step again now, and his devices are kept for that ask (the fence
 *    refuses another task's for RELEASE_GRACE_MS), so it goes to his devices, one tap.
 *  - Once: one held ask per step of a task (the command and folder it runs, else its line); asking
 *    again while it is held finds it (a new commit's line takes its place), and an ask of that step
 *    that goes through marks it asked. A release whose ask is refused again waits again; past
 *    MAX_RELEASES releases it ends.
 *  - Deadline: a held ask lapses HOLD_MS after it was first held, and its task is told it is void:
 *    the same step is not held again for another HOLD_MS (its task reports that it waits for him).
 *  - Never held: a step the person denied, one that reached him MAX_UNANSWERED times unanswered, a
 *    second ask of the step already on his devices; a held one that becomes such is dropped, told.
 *  - Bounded: MAX_HELD_PER_TASK open held asks per task and MAX_HELD per class; past that, not held.
 *
 * Asked and decided only on the leader (store.ts); the sweep runs there (initApprovals).
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { homeWritesStopped } from '../../lib/leader-clocks.js'
import { log } from '../../logging/index.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { bus, EventNames } from '../event-bus.js'
import { HELD_MARK } from './cli-core.js'
import type { FenceRefusal, FenceSubject, NotHeld } from './single-use-fence.js'
import type { ApprovalRequester } from './types.js'

/** How long a held ask waits for the person before it lapses (a weekend away). `WALNUT_APPROVAL_HOLD_HOURS` overrides. */
export const HOLD_MS = 72 * 60 * 60_000
/** After a release, how long its task has to ask again; the person's devices are kept for it meanwhile. */
export const RELEASE_GRACE_MS = 10 * 60_000
/** Open held asks one class (the person's, or one test run's) may keep, and one task. */
export const MAX_HELD = 20
export const MAX_HELD_PER_TASK = 3
/** Times a held ask is released (its task told to ask again) before it ends unreached. */
export const MAX_RELEASES = 3
/** Held asks that ended stay this long as the record of what waited and what came of it. */
const KEEP_ENDED_MS = 7 * 24 * 60 * 60_000

export function holdMs(env: NodeJS.ProcessEnv = process.env): number {
  const h = Number(env.WALNUT_APPROVAL_HOLD_HOURS)
  return Number.isFinite(h) && h > 0 ? h * 60 * 60_000 : HOLD_MS
}

/** The words every held refusal carries: a newer `walnut approve` reads them as "asked, answer later" (exit 4). */
export { HELD_MARK }

/** What a held refusal tells the asker (a script prints it; an agent reads it). */
export function heldWords(h: Pick<HeldAsk, 'id' | 'until'>): string {
  return `${HELD_MARK} (${h.id}) until the user is back in Walnut, at most until ${h.until}, and then tells this session `
    + 'to take the step again: its approval goes to his devices then, one tap. Until then do not ask again and do not ask '
    + 'the user about it; asking again finds this same held ask. Keep this task open (not complete): the notice comes '
    + 'to this session, and a closed task is never told.'
}

export type HeldReason = FenceRefusal['code']
export type HeldState = 'held' | 'released' | 'asked' | 'lapsed'
export type LapsedWhy = 'deadline' | 'no_session' | 'not_reached' | Exclude<NotHeld, 'same_pending'>

export interface HeldAsk {
  id: string
  what: string
  requester: Pick<ApprovalRequester, 'host' | 'taskId' | 'taskTitle' | 'sessionId' | 'command' | 'cwd'>
  testRun?: string
  /** Why it waits (the fence's code at the last refusal). */
  reason: HeldReason
  state: HeldState
  heldAt: string
  /** It lapses at this time when not asked by then. */
  until: string
  /** Which step of its task it is (stepKey): one held ask per step. */
  step?: string
  /** Lines of this step held before and replaced by a newer one (the release names them too). */
  earlier?: string[]
  /** How often its task was told to ask again (a release whose ask was refused again waits again). */
  releases: number
  releasedAt?: string
  /** When the release's note reached its task (a release marked but never told is released again). */
  toldAt?: string
  /** The approval its task asked when it went through. */
  askedAs?: string
  askedAt?: string
  lapsedAt?: string
  lapsedWhy?: LapsedWhy
}

interface HeldFile { version: 1; held: HeldAsk[] }
const EMPTY: HeldFile = { version: 1, held: [] }

function heldFile(): string {
  return path.join(WALNUT_HOME, 'approvals', 'held.json')
}

let chain: Promise<unknown> = Promise.resolve()
function serial<R>(fn: () => Promise<R>): Promise<R> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

const classKey = (testRun: string | undefined) => testRun ?? ''
/** Held or released, not yet asked or ended. */
const live = (h: HeldAsk): boolean => h.state === 'held' || h.state === 'released'
const ofTask = (h: HeldAsk, s: { testRun?: string; taskId?: string }): boolean =>
  classKey(h.testRun) === classKey(s.testRun) && !!s.taskId && h.requester.taskId === s.taskId

/**
 * Which step of its task an ask is: the command and the folder it runs in (a push of a new commit is
 * the same step, its line changed), else its line. Pure.
 */
export function stepKey(what: string, r: Pick<ApprovalRequester, 'command' | 'cwd'>): string {
  return r.command ? `cmd:${r.command}\u0000${r.cwd ?? ''}` : `what:${what}`
}
const stepOf = (h: HeldAsk): string => h.step ?? stepKey(h.what, h.requester)

function prune(file: HeldFile, now: number): void {
  file.held = file.held.filter((h) => live(h) || now - Date.parse(h.lapsedAt ?? h.askedAt ?? h.heldAt) < KEEP_ENDED_MS)
}

export interface HoldInput extends FenceSubject {
  what: string
  requester: HeldAsk['requester']
}

/** Why a refused ask was not held: the class or the task keeps the most, or its step was held to its deadline lately. */
export type NotKept = { full: true } | { void: HeldAsk }

/**
 * Keep this refused ask until the person is back: its step's live held ask (it keeps its deadline
 * and takes this newer line), else a new one. Not kept when the class or the task keeps the most,
 * or the same step lapsed at its deadline within HOLD_MS (void: its task reports that it waits).
 * Holding kicks no sweep: the checks that just refused it would refuse it again.
 */
export async function holdAsk(input: HoldInput, reason: HeldReason, now = Date.now()): Promise<HeldAsk | NotKept> {
  let out: HeldAsk | NotKept = { full: true }
  const r = input.requester
  const requester = Object.fromEntries(Object.entries({ host: r.host, taskId: r.taskId, taskTitle: r.taskTitle, sessionId: r.sessionId, command: r.command, cwd: r.cwd })
    .filter(([, v]) => typeof v === 'string' && v)) as HeldAsk['requester']
  const step = stepKey(input.what, requester)
  await serial(() => updateJsonFile<HeldFile>(heldFile(), EMPTY, (file) => {
    prune(file, now)
    const task = { testRun: input.testRun, taskId: r.taskId }
    const mine = file.held.filter((h) => ofTask(h, task) && stepOf(h) === step)
    const found = mine.find((h) => live(h) && Date.parse(h.until) > now)
    if (found) {
      // A release whose ask was refused again (he left again) waits again, told again when it goes.
      // A different line of the same step is kept by name: the release tells the task of both.
      const earlier = found.what !== input.what ? [...(found.earlier ?? []).filter((w) => w !== input.what), found.what].slice(-3) : found.earlier
      Object.assign(found, { what: input.what, requester, step, reason, state: 'held' as const, ...(earlier?.length ? { earlier } : {}) })
      delete found.releasedAt
      delete found.toldAt
      out = { ...found }
      return file
    }
    // Void: held to its deadline and he never came back (a release its task let go is no such end).
    const ended = mine.filter((h) => h.state === 'lapsed' && h.lapsedWhy === 'deadline' && h.releases === 0 && now - Date.parse(h.lapsedAt ?? h.until) < holdMs())
      .sort((a, b) => (b.lapsedAt ?? '').localeCompare(a.lapsedAt ?? ''))[0]
    if (ended) { out = { void: { ...ended } }; return undefined }
    const open = file.held.filter((h) => live(h) && classKey(h.testRun) === classKey(input.testRun))
    if (open.length >= MAX_HELD || open.filter((h) => ofTask(h, task)).length >= MAX_HELD_PER_TASK) return undefined
    const rec: HeldAsk = {
      id: 'held-' + crypto.randomBytes(9).toString('base64url'),
      what: input.what, requester, step, ...(input.testRun ? { testRun: input.testRun } : {}),
      reason, state: 'held', heldAt: new Date(now).toISOString(), until: new Date(now + holdMs()).toISOString(), releases: 0,
    }
    file.held.push(rec)
    out = { ...rec }
    return file
  }))
  const kept = out as HeldAsk | NotKept
  if ('id' in kept) log.web.info('approvals: single-use ask held until the person is back', { heldId: kept.id, reason, taskId: r.taskId })
  return kept
}

/** An ask of this step went through (it is on the person's devices): its held ask is done. */
export async function markAsked(ask: { testRun?: string; taskId?: string; step: string }, approvalId: string, now = Date.now()): Promise<void> {
  if (!ask.taskId) return
  const at = new Date(now).toISOString()
  await serial(() => updateJsonFile<HeldFile>(heldFile(), EMPTY, (file) => {
    const found = file.held.filter((h) => live(h) && ofTask(h, ask) && stepOf(h) === ask.step)
    for (const h of found) Object.assign(h, { state: 'asked' as const, askedAs: approvalId, askedAt: at })
    return found.length ? file : undefined
  })).catch((err) => log.web.warn('approvals: marking a held ask asked failed', { error: String(err) }))
}

/** A held ask released in its grace (its task is asking again now), for the fence to keep the devices for it. */
export async function reservedHeld(testRun: string | undefined, now = Date.now()): Promise<{ heldId: string; taskId?: string } | null> {
  const file = await readJsonFile<HeldFile>(heldFile(), EMPTY).catch(() => EMPTY)
  const h = file.held.find((x) => x.state === 'released' && classKey(x.testRun) === classKey(testRun) && now - Date.parse(x.releasedAt ?? x.heldAt) < RELEASE_GRACE_MS)
  return h ? { heldId: h.id, ...(h.requester.taskId ? { taskId: h.requester.taskId } : {}) } : null
}

/** A fixture server's spec starts with nothing held (routes/test-host-fixture.ts only). */
export async function _clearHeldForFixture(): Promise<void> {
  await serial(() => updateJsonFile<HeldFile>(heldFile(), EMPTY, () => ({ version: 1, held: [] })))
}

export async function listHeld(opts: { viewer?: string; all?: boolean } = {}): Promise<HeldAsk[]> {
  const file = await readJsonFile<HeldFile>(heldFile(), EMPTY)
  return file.held.filter((h) => classKey(h.testRun) === classKey(opts.viewer) && (opts.all || live(h)))
}

/** What the sweep decided for one held ask: tell its task to ask again, or that it lapsed. */
export interface HeldTell { held: HeldAsk; kind: 'release' | 'lapse' }

/** For one held ask now: a fresh ask of it would pass the fence (go), not yet (wait), or never (drop, why). */
export type HeldVerdict = 'go' | 'wait' | Exclude<LapsedWhy, 'deadline' | 'no_session'>

/**
 * Pure: on one snapshot, the held asks that lapse now (deadline, released MAX_RELEASES times, or
 * dropped) and the one released now: the oldest held ask of each class that may go, unless one
 * released in its grace waits.
 */
export function decideHeld(held: HeldAsk[], now: number, verdict: (h: HeldAsk) => HeldVerdict): HeldTell[] {
  const out: HeldTell[] = []
  const lapse = (h: HeldAsk, why: LapsedWhy) => out.push({ held: { ...h, lapsedWhy: why }, kind: 'lapse' })
  const inGrace = (h: HeldAsk) => h.state === 'released' && now - Date.parse(h.releasedAt ?? h.heldAt) < RELEASE_GRACE_MS
  // Held, or released and never told past its grace (Walnut stopped between marking and telling).
  const waiting = (h: HeldAsk) => h.state === 'held' || (h.state === 'released' && !h.toldAt && !inGrace(h))
  const open: HeldAsk[] = []
  for (const h of held.filter(live)) {
    if (Date.parse(h.until) <= now) { lapse(h, 'deadline'); continue }
    // Released this often and its ask never went through: something keeps refusing it; ring no more.
    if (waiting(h) && h.releases >= MAX_RELEASES) { lapse(h, 'not_reached'); continue }
    const v = waiting(h) ? verdict(h) : 'wait'
    if (v === 'denied' || v === 'unanswered') { lapse(h, v); continue }
    open.push(h)
  }
  for (const c of new Set(open.map((h) => classKey(h.testRun)))) {
    const mine = open.filter((h) => classKey(h.testRun) === c)
    if (mine.some(inGrace)) continue
    const next = mine.filter(waiting).sort((a, b) => a.heldAt.localeCompare(b.heldAt)).find((h) => verdict(h) === 'go')
    if (next) out.push({ held: next, kind: 'release' })
  }
  return out
}

export interface SweepDeps {
  /** For each held ask now, what a fresh ask of it would meet (store.ts reads the approvals and the person once). */
  verdict(): Promise<(h: HeldAsk) => HeldVerdict>
  /** Tell the asking task; false when it has no session to tell. */
  tell(t: HeldTell): Promise<boolean>
}

let deps: SweepDeps | null = null
export function setHeldSweepDeps(d: SweepDeps | null): void { deps = d }

/** One pass: lapse what is past its deadline or may never be asked, release the next one when the person is back. */
export async function sweepHeld(now = Date.now()): Promise<HeldTell[]> {
  if (!deps) return []
  const file = await readJsonFile<HeldFile>(heldFile(), EMPTY)
  if (!file.held.some(live)) return []
  const decided = decideHeld(file.held, now, await deps.verdict())
  const at = new Date(now).toISOString()
  const told: HeldTell[] = []
  for (const t of decided) {
    // Mark first (once, under the lock), tell after: a crash between them loses a note, never sends two.
    let won = false
    await serial(() => updateJsonFile<HeldFile>(heldFile(), EMPTY, (f) => {
      const h = f.held.find((x) => x.id === t.held.id)
      // Decided on what it was: a newer line held in between is decided on the next pass.
      if (!h || h.state !== t.held.state || h.what !== t.held.what) return undefined
      if (t.kind === 'release') { Object.assign(h, { state: 'released' as const, releasedAt: at, releases: h.releases + 1 }); delete h.toldAt }
      else Object.assign(h, { state: 'lapsed' as const, lapsedAt: at, lapsedWhy: t.held.lapsedWhy })
      t.held = { ...h }
      won = true
      return f
    }))
    if (!won) continue
    // A released ask its task chose not to take again ends quietly: it was told, and "do nothing" was an answer.
    const quiet = t.kind === 'lapse' && t.held.lapsedWhy === 'deadline' && !!t.held.toldAt
    let reached: boolean | 'failed'
    try { reached = quiet ? true : await deps.tell(t) } catch (err) {
      reached = 'failed'
      log.web.warn('approvals: telling a held ask\'s task failed', { heldId: t.held.id, error: String(err) })
    }
    if (t.kind === 'release') {
      // Told: its grace runs, then it ends at its deadline unless asked. Nobody to take the step again
      // (the task closed, its sessions ended): it lapses, and the next may go. A note that did not go
      // out (the send failed) waits again, released again next pass.
      await serial(() => updateJsonFile<HeldFile>(heldFile(), EMPTY, (f) => {
        const h = f.held.find((x) => x.id === t.held.id)
        if (!h || h.state !== 'released') return undefined
        if (reached === true) h.toldAt = new Date().toISOString()
        else if (reached === 'failed') { h.state = 'held'; delete h.releasedAt }
        else Object.assign(h, { state: 'lapsed' as const, lapsedAt: at, lapsedWhy: 'no_session' as const })
        return f
      }))
    }
    log.web.info(`approvals: held ask ${t.kind === 'release' ? 'released' : 'lapsed'}`, { heldId: t.held.id, taskId: t.held.requester.taskId, why: t.held.lapsedWhy, told: reached })
    told.push(t)
  }
  return told
}

// The sweep: on a clock while anything is held, and soon after a sign of the person or an ask ending.
const TICK_MS = 60_000
export const KICK_MS = 2_000
const SUBSCRIBER = 'approvals-held'
let timer: NodeJS.Timeout | null = null
let kickTimer: NodeJS.Timeout | null = null
let running: Promise<unknown> | null = null
let again = false

function run(): void {
  // A leader switch's stop began (src/lib/leader-clocks.ts): the held file is leader data, written no more.
  if (homeWritesStopped()) return
  // A kick during a pass runs one more pass after it, never a second at once.
  if (running) { again = true; return }
  running = sweepHeld().catch((err) => log.web.warn('approvals: held sweep failed', { error: String(err) })).finally(() => {
    running = null
    if (again && deps) { again = false; run() }
  })
}

/** Sweep soon (debounced): the person showed up, or a single-use ask ended. Only once the sweep runs (startHeldSweep). */
export function kick(): void {
  if (!deps || !timer || kickTimer) return
  kickTimer = setTimeout(() => { kickTimer = null; run() }, KICK_MS)
  kickTimer.unref?.()
}

/** On the leader (initApprovals): the minute clock, and a kick whenever a window or the phone app reports the person's attention. */
export function startHeldSweep(d: SweepDeps): void {
  deps = d
  if (timer) clearInterval(timer)
  timer = setInterval(run, TICK_MS)
  timer.unref?.()
  bus.subscribe(SUBSCRIBER, () => kick(), { global: true, interest: [EventNames.TIME_BANKED] })
  run()
}

export function stopHeldSweep(): void {
  if (timer) clearInterval(timer)
  if (kickTimer) clearTimeout(kickTimer)
  timer = kickTimer = null
  again = false
  deps = null
  bus.unsubscribe(SUBSCRIBER)
}
