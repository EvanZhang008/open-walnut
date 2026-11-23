/**
 * The move of this Walnut's sessions on a host from another Walnut's shared daemon to its own
 * service set there (service-set.ts; the experiment host_service_sets). One code path for SSH and
 * host-network links. One move at a time per host; its state is kept on this machine's disk next to
 * the host's other daemon facts, so a leader restart resumes it or cleanly gives it up.
 *
 *   waiting   wait, at most waitMs (30 min), for a moment when nothing of this Walnut works there:
 *             no session in a turn or with work that outlives its turn (judged from a fresh read
 *             of the host, service-set-move-checks.ts), no host_exec run of its tasks, no command
 *             under way. Then hold this Walnut's work for the host (service-set-hold.ts), wait for
 *             what passed just before the hold, stop its follower there (it could start work by
 *             itself), and look again. A running turn is never stopped. At the bound, or on an
 *             ACP session (its stop cannot be proven): give up, keep everything as it is, report.
 *   holding   each session is judged again and stopped the normal way, and its CLI proven gone
 *             (the daemon's cli.holder: pid and start time); then this Walnut's triggers and
 *             plugin jobs there are emptied. Sessions this leader does not know as its own are
 *             never touched. Anything not proven: the shared daemon gets back what was taken
 *             (the link dials it again), the hold is released, and the try gives up.
 *   flipped   the link is pointed at the set's service (SSH: its runtime dir; net: the walnut-net
 *             route of this leader's endpoint, with a revert on the host if it is not confirmed),
 *             and the link is dialled again: its hello must name the set. Then the route is
 *             confirmed, the held work is released there, and the stopped sessions resume there on
 *             their next message (--resume, as after any stop).
 *   done      the leader no longer speaks for its home on the shared daemon; that daemon, its
 *             launcher and its boot item are left exactly as they are (the other Walnut's).
 *   reverted  the set's service did not answer in time: the link is pointed back, dialled again,
 *             the held work released there, reported, and the move tried again later.
 *   gave_up   the wait ran out, or something was not proven: nothing flipped, reported, tried later.
 *
 * Failures in a row back off (the retry wait doubles, up to a day) and end after MOVE_MAX_TRIES with
 * a notice that says so; an update that names the set again tries anew.
 *
 * A record found at start: 'waiting' or 'holding' (the hold lived in the old process only) waits
 * again from the same start; 'flipped' while the link reaches the shared daemon is pointed back
 * first (the flip did not hold) and starts over; 'flipped' while it reaches the set is settled as
 * done (settleMove). Pure: every effect is a dependency (service-set-move-link.ts builds them).
 */
import { KeyedUpdateStore } from './daemon-update-store.js'
import { isServiceSetId } from './service-set.js'

export type MovePhase = 'waiting' | 'holding' | 'flipped' | 'done' | 'gave_up' | 'reverted'

export interface MoveRecord {
  v: 1
  /** Last write (the store's age). */
  at: number
  set: string
  link: 'ssh' | 'net'
  phase: MovePhase
  /** When this try's wait began: the wait bound counts from here, across a leader restart. */
  startedAt: number
  /** Sessions this try stopped on the shared daemon (they resume on their next message). */
  stopped: string[]
  why?: string
  /** After a give-up or a revert: no new try before this, unless asked (an update named the set again). */
  nextTryAt?: number
  /** Tries in a row that gave up or were put back: the wait before the next one doubles, and it ends (MOVE_MAX_TRIES). */
  failures?: number
}

/** The links a record may name (a value check, not a branch on the kind). */
const LINKS = new Set<unknown>(['ssh', 'net'])
const PHASES = new Set<MovePhase>(['waiting', 'holding', 'flipped', 'done', 'gave_up', 'reverted'])

const validMove = (e: unknown): e is MoveRecord => {
  const r = e as MoveRecord
  return !!r && typeof r === 'object' && r.v === 1 && Number.isFinite(r.at) && isServiceSetId(r.set)
    && LINKS.has(r.link) && PHASES.has(r.phase) && Number.isFinite(r.startedAt)
    && Array.isArray(r.stopped) && r.stopped.every((s) => typeof s === 'string')
}

/** Per place (`ssh:<host>`, `net:<host>`); a record a month old is no move any more (a done move lives on the host's set record). */
export const serviceSetMoves = new KeyedUpdateStore<MoveRecord>('daemon-service-set-move.json', 'WALNUT_SERVICE_SET_MOVE_FILE', 30 * 24 * 3600_000, validMove)

const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** The bound on the wait for a moment with no turn (decided: 30 min); WALNUT_SERVICE_SET_MOVE_WAIT_MS for tests. */
export const moveWaitMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_WAIT_MS', 30 * 60_000)
/** How long the set's service has to answer after the flip. */
export const moveReconnectMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_RECONNECT_MS', 120_000)
/** The slow retry after a give-up or a revert: the first wait; each failure in a row doubles it (up to a day). */
export const moveRetryMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_RETRY_MS', 2 * 3600_000)
/** After this many tries in a row that failed, Walnut stops trying by itself and says so (review round 1, should-fix 10). */
export const MOVE_MAX_TRIES = 4
const RETRY_CAP_MS = 24 * 3600_000
const POLL_MS = 15_000
/** How long the hold waits for the starts and sends that passed just before it. */
const DRAIN_MS = 30_000

export interface MoveSession {
  id: string
  /** Why it must not be stopped now: a turn, work that outlives its turn, a daemon that cannot say. Absent: quiet. */
  busy?: string
  /** Why the move cannot take it at all (an ACP session, a CLI outside the shared daemon): the move gives up. */
  blocks?: string
}

/** A stop proven (its CLI gone), or why not; `busy`: it became busy right before its stop. */
export type StopResult = { ok: true } | { ok: false; why: string; busy?: boolean }

export type MoveOutcome =
  | { result: 'moved'; stopped: string[] }
  | { result: 'gave_up'; why: string; stopped: string[]; failures?: number; final?: boolean }
  | { result: 'reverted'; why: string; stopped: string[]; failures?: number; final?: boolean }
  | { result: 'not_due'; why: string }

export interface MoveDeps {
  /** The set this Walnut's service is on there (16 hex). */
  set: string
  link: 'ssh' | 'net'
  now(): number
  sleep(ms: number): Promise<void>
  store: { read(): Promise<MoveRecord | null>; write(r: MoveRecord | null): Promise<void> }
  /** This Walnut's sessions on the host's shared daemon, judged from a fresh read (service-set-move-checks.ts). */
  sessions(): Promise<MoveSession[]>
  /** Other work of this Walnut still there (host_exec runs, commands under way), in words; null when none. */
  openWork(): Promise<string | null>
  /** Stop one the normal way and prove its CLI gone. */
  stop(id: string): Promise<StopResult>
  /** Hold this Walnut's work for the host (service-set-hold.ts). */
  hold(): void
  /** True once the work commands that passed just before the hold are answered (bounded). */
  drained(boundMs: number): Promise<boolean>
  /** Release it: it goes to whatever the link reaches now. */
  release(): void
  /** Stop this Walnut's follower on the shared daemon and see it off; throws when it may still run. */
  stopFollower(): Promise<void>
  /** Empty this Walnut's triggers and plugin jobs on the shared daemon; throws when not done. */
  dropScope(): Promise<void>
  /** A try that gave up after the follower stop: the shared daemon gets back this Walnut's follower, triggers and jobs (the link dials it again). */
  restore(): Promise<void>
  /** Point the link at the set's service; unflip points it back (idempotent); confirm keeps the flip. */
  flip(): Promise<void>
  unflip(): Promise<void>
  confirm(): Promise<void>
  /** Drop the link and dial again; the set the new hello names ('' the default), or null with no hello within `boundMs`. */
  reconnect(boundMs: number): Promise<string | null>
  report(outcome: MoveOutcome): void
  waitMs?: number
  pollMs?: number
  reconnectMs?: number
  retryMs?: number
  /** An update just named the set: a try before nextTryAt (or after the last try) is allowed. */
  force?: boolean
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300)
}

/** The first reason the sessions and the open work give not to stop now; null: quiet. */
async function notQuiet(d: MoveDeps): Promise<{ sessions: MoveSession[]; busy: string | null; blocks: string | null }> {
  let sessions: MoveSession[]
  try { sessions = await d.sessions() } catch (e) { return { sessions: [], busy: errText(e), blocks: null } }
  const blocks = sessions.find((s) => s.blocks)?.blocks ?? null
  const busy = sessions.find((s) => s.busy)?.busy ?? (await d.openWork().catch((e) => errText(e)))
  return { sessions, busy, blocks }
}

/** Run (or resume) the move. Called while the link reaches another daemon than the set's. */
export async function runMove(d: MoveDeps): Promise<MoveOutcome> {
  const waitMs = d.waitMs ?? moveWaitMs()
  const reconnectMs = d.reconnectMs ?? moveReconnectMs()
  const retryMs = d.retryMs ?? moveRetryMs()
  let r = await d.store.read().catch(() => null)
  if (r && (r.set !== d.set || r.link !== d.link)) r = null
  const failed = r && (r.phase === 'gave_up' || r.phase === 'reverted')
  if (failed && !d.force && (r!.failures ?? 1) >= MOVE_MAX_TRIES) {
    return { result: 'not_due', why: `the move failed ${r!.failures} times in a row (last: ${r!.why ?? ''}); Walnut tries again when an update names the set` }
  }
  if (failed && !d.force && (r!.nextTryAt ?? 0) > d.now()) {
    return { result: 'not_due', why: `the last try ${r!.phase === 'gave_up' ? 'gave up' : 'was put back'} (${r!.why ?? ''}); tried again later` }
  }
  // A flip a restart left while the link reaches the shared daemon did not hold: point it back first.
  if (r?.phase === 'flipped') await d.unflip().catch(() => {})
  const resume = r && (r.phase === 'waiting' || r.phase === 'holding')
  const failures = failed ? r!.failures ?? 1 : resume ? r!.failures ?? 0 : 0
  let rec: MoveRecord = resume
    ? { ...r!, phase: 'waiting', at: d.now() }
    : { v: 1, at: d.now(), set: d.set, link: d.link, phase: 'waiting', startedAt: d.now(), stopped: [], ...(failures ? { failures } : {}) }
  const save = async (patch: Partial<MoveRecord>): Promise<void> => {
    rec = { ...rec, ...patch, at: d.now() }
    await d.store.write(rec)
  }
  const end = async (outcome: { result: 'gave_up' | 'reverted'; why: string; stopped: string[] }): Promise<MoveOutcome> => {
    // Each failure in a row doubles the wait before the next try; after MOVE_MAX_TRIES Walnut stops by itself.
    const n = failures + 1
    const final = n >= MOVE_MAX_TRIES
    const nextTryAt = final ? undefined : d.now() + Math.min(retryMs * 2 ** (n - 1), RETRY_CAP_MS)
    await save({ phase: outcome.result, why: outcome.why, failures: n, nextTryAt }).catch(() => {})
    const out = { ...outcome, failures: n, ...(final ? { final: true } : {}) }
    d.report(out)
    return out
  }
  await save({})

  // waiting: a moment with nothing of this Walnut at work there, then the hold, the drain of what passed
  // just before it, the follower's stop (it could start work there by itself), and the same look again.
  let quiet: MoveSession[] | null = null
  let lastBusy = ''
  for (;;) {
    const before = await notQuiet(d)
    if (before.blocks) return end({ result: 'gave_up', why: `${before.blocks}; nothing was stopped`, stopped: rec.stopped })
    if (!before.busy) {
      d.hold()
      if (!(await d.drained(DRAIN_MS))) {
        d.release()
        lastBusy = 'a start or send that went just before the hold was still under way'
      } else {
        try {
          await d.stopFollower()
        } catch (e) {
          d.release()
          return end({ result: 'gave_up', why: `this Walnut's follower on the shared daemon did not stop (${errText(e)})`, stopped: rec.stopped })
        }
        const after = await notQuiet(d)
        if (!after.busy && !after.blocks) { quiet = after.sessions; break }
        await d.restore().catch(() => {})
        d.release()
        if (after.blocks) return end({ result: 'gave_up', why: `${after.blocks}; nothing was stopped`, stopped: rec.stopped })
        lastBusy = after.busy!
      }
    } else lastBusy = before.busy
    if (d.now() - rec.startedAt >= waitMs) {
      return end({ result: 'gave_up', why: `this Walnut's work there went on for the whole wait (${Math.round(waitMs / 60_000)} min; last: ${lastBusy}); nothing was stopped`, stopped: rec.stopped })
    }
    await d.sleep(d.pollMs ?? POLL_MS)
  }

  // holding: the work waits; each session stops the normal way and its CLI is proven gone, judged
  // again right before its stop; then this Walnut's triggers and plugin jobs there are emptied.
  const giveUp = async (why: string): Promise<MoveOutcome> => {
    await d.restore().catch(() => {})
    d.release()
    return end({ result: 'gave_up', why, stopped: rec.stopped })
  }
  await save({ phase: 'holding' })
  for (const s of quiet) {
    const res = await d.stop(s.id).catch((e): StopResult => ({ ok: false, why: `session ${s.id}: ${errText(e)}` }))
    if (!res.ok) {
      return giveUp(`${res.why}${res.busy ? ' right before its stop' : ''}; the sessions stopped so far resume on the shared daemon`)
    }
    await save({ stopped: [...new Set([...rec.stopped, s.id])] })
  }
  try {
    await d.dropScope()
  } catch (e) {
    return giveUp(`this Walnut's triggers and plugin jobs on the shared daemon were not dropped (${errText(e)})`)
  }

  // flipped: on disk before the flip, so a restart in between points it back.
  await save({ phase: 'flipped' })
  let flipError: string | null = null
  try { await d.flip() } catch (e) { flipError = errText(e) }
  const got = flipError === null ? await d.reconnect(reconnectMs).catch(() => null) : null
  if (got === d.set) {
    await save({ phase: 'done', why: undefined, nextTryAt: undefined, failures: undefined })
    await d.confirm().catch(() => { /* net: the set's service confirms it itself when its leader's link authenticates */ })
    d.release()
    const outcome: MoveOutcome = { result: 'moved', stopped: rec.stopped }
    d.report(outcome)
    return outcome
  }
  // Never leave the host unreachable: back to the shared daemon (it gets this Walnut's follower,
  // triggers and jobs again on that connect), the held work released there.
  await d.unflip().catch(() => {})
  await d.reconnect(reconnectMs).catch(() => null)
  d.release()
  const why = flipError
    ? `the flip to this Walnut's own service did not go through (${flipError})`
    : got === null
      ? `this Walnut's own service did not answer within ${Math.round(reconnectMs / 1000)} s`
      : `the link reached ${got ? `set ${got}` : 'the default daemon'}, not this Walnut's own service`
  return end({ result: 'reverted', why, stopped: rec.stopped })
}

/**
 * The link reaches the set's service: a move a restart left flipped is done (confirmed), and one in
 * any other phase is over too. Answers whether a record was settled.
 */
export async function settleMove(d: Pick<MoveDeps, 'set' | 'store' | 'confirm' | 'now'>): Promise<boolean> {
  const r = await d.store.read().catch(() => null)
  if (!r || r.set !== d.set || r.phase === 'done') return false
  if (r.phase === 'flipped') await d.confirm().catch(() => {})
  await d.store.write({ ...r, phase: 'done', at: d.now(), why: undefined, nextTryAt: undefined })
  return true
}

/** The phase kept for a place, for the SSH dir choice: the set's runtime dir once the move flipped. */
export async function movePhaseOf(place: string): Promise<MovePhase | null> {
  return (await serviceSetMoves.read(place).catch(() => null))?.phase ?? null
}

const running = new Map<string, Promise<MoveOutcome>>()

/** One move at a time per place: a second call while one runs shares it. */
export function moveOnce(place: string, run: () => Promise<MoveOutcome>): Promise<MoveOutcome> {
  const now = running.get(place)
  if (now) return now
  const p = run().finally(() => { if (running.get(place) === p) running.delete(place) })
  running.set(place, p)
  return p
}
