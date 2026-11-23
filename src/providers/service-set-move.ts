/**
 * The move of this Walnut's sessions on a host from another Walnut's shared daemon to its own
 * service set there (service-set.ts; the experiment host_service_sets). One code path for SSH and
 * host-network links. One move at a time per host; its state is kept on this machine's disk next to
 * the host's other daemon facts, so a leader restart resumes it or cleanly gives it up.
 *
 *   waiting   wait, at most waitMs (30 min), for a moment when none of this Walnut's sessions there is
 *             in a turn; a running turn is never stopped. At the bound: give up, keep everything as it
 *             is, report, try again later (the next update, or retryMs).
 *   holding   new starts and sends for the host are held (as for a host that is briefly away: the
 *             rows stay pending and go out on the next connect), each of this Walnut's live sessions
 *             there is stopped the normal way and must confirm its exit, and this Walnut's follower
 *             there is stopped. Sessions this leader does not know as its own are never touched.
 *   flipped   the link is pointed at the set's service (SSH: its runtime dir; net: the walnut-net
 *             route of this leader's endpoint, with a revert on the host if it is not confirmed),
 *             and the link is dialled again: its hello must name the set. Then the route is
 *             confirmed, the held work is released there, and the stopped sessions resume there on
 *             their next message (--resume, as after any stop).
 *   done      the leader no longer speaks for its home on the shared daemon; that daemon, its
 *             launcher and its boot item are left exactly as they are (the other Walnut's).
 *   reverted  the set's service did not answer in time: the link is pointed back, dialled again,
 *             the held work released there, reported, and the move tried again later.
 *   gave_up   the wait ran out, or a stop did not confirm: nothing flipped, reported, tried later.
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
}

const PHASES = new Set<MovePhase>(['waiting', 'holding', 'flipped', 'done', 'gave_up', 'reverted'])

const validMove = (e: unknown): e is MoveRecord => {
  const r = e as MoveRecord
  return !!r && typeof r === 'object' && r.v === 1 && Number.isFinite(r.at) && isServiceSetId(r.set)
    && (r.link === 'ssh' || r.link === 'net') && PHASES.has(r.phase) && Number.isFinite(r.startedAt)
    && Array.isArray(r.stopped) && r.stopped.every((s) => typeof s === 'string')
}

/** Per place (`ssh:<host>`, `net:<host>`); a record a month old is no move any more. */
export const serviceSetMoves = new KeyedUpdateStore<MoveRecord>('daemon-service-set-move.json', 'WALNUT_SERVICE_SET_MOVE_FILE', 30 * 24 * 3600_000, validMove)

const envMs = (name: string, fallback: number): number => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/** The bound on the wait for a moment with no turn (decided: 30 min); WALNUT_SERVICE_SET_MOVE_WAIT_MS for tests. */
export const moveWaitMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_WAIT_MS', 30 * 60_000)
/** How long the set's service has to answer after the flip. */
export const moveReconnectMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_RECONNECT_MS', 120_000)
/** The slow retry after a give-up or a revert. */
export const moveRetryMs = (): number => envMs('WALNUT_SERVICE_SET_MOVE_RETRY_MS', 2 * 3600_000)
const POLL_MS = 15_000

export interface MoveSession {
  id: string
  /** In a turn now (process_status running): never stopped. */
  inTurn: boolean
}

export type MoveOutcome =
  | { result: 'moved'; stopped: string[] }
  | { result: 'gave_up'; why: string; stopped: string[] }
  | { result: 'reverted'; why: string; stopped: string[] }
  | { result: 'not_due'; why: string }

export interface MoveDeps {
  /** The set this Walnut's service is on there (16 hex). */
  set: string
  link: 'ssh' | 'net'
  now(): number
  sleep(ms: number): Promise<void>
  store: { read(): Promise<MoveRecord | null>; write(r: MoveRecord | null): Promise<void> }
  /** This Walnut's live sessions on the host's shared daemon (its own records only). */
  sessions(): Promise<MoveSession[]>
  /** Stop one the normal way; true once its exit is confirmed. */
  stop(id: string): Promise<boolean>
  /** Hold new starts and sends for the host (they wait as for a host that is briefly away). */
  hold(): void
  /** Release them: they go to whatever the link reaches now. */
  release(): void
  /** Stop this Walnut's follower on the shared daemon (server.configure null for its home). */
  stopFollower(): Promise<void>
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
  /** An update just named the set: a try before nextTryAt is allowed. */
  force?: boolean
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300)
}

/** Run (or resume) the move. Called while the link reaches another daemon than the set's. */
export async function runMove(d: MoveDeps): Promise<MoveOutcome> {
  const waitMs = d.waitMs ?? moveWaitMs()
  const reconnectMs = d.reconnectMs ?? moveReconnectMs()
  const retryMs = d.retryMs ?? moveRetryMs()
  let r = await d.store.read().catch(() => null)
  if (r && (r.set !== d.set || r.link !== d.link)) r = null
  if (r && (r.phase === 'gave_up' || r.phase === 'reverted') && !d.force && (r.nextTryAt ?? 0) > d.now()) {
    return { result: 'not_due', why: `the last try ${r.phase === 'gave_up' ? 'gave up' : 'was put back'} (${r.why ?? ''}); tried again later` }
  }
  // A flip a restart left while the link reaches the shared daemon did not hold: point it back first.
  if (r?.phase === 'flipped') await d.unflip().catch(() => {})
  const resume = r && (r.phase === 'waiting' || r.phase === 'holding')
  let rec: MoveRecord = resume
    ? { ...r!, phase: 'waiting', at: d.now() }
    : { v: 1, at: d.now(), set: d.set, link: d.link, phase: 'waiting', startedAt: d.now(), stopped: [] }
  const save = async (patch: Partial<MoveRecord>): Promise<void> => {
    rec = { ...rec, ...patch, at: d.now() }
    await d.store.write(rec)
  }
  const end = async (outcome: Exclude<MoveOutcome, { result: 'moved' } | { result: 'not_due' }>): Promise<MoveOutcome> => {
    await save({ phase: outcome.result, why: outcome.why, nextTryAt: d.now() + retryMs }).catch(() => {})
    d.report(outcome)
    return outcome
  }
  await save({})

  // waiting: a moment with no turn, then the hold, then the same check again (a send that slipped in).
  let quiet: MoveSession[] | null = null
  for (;;) {
    const before = await d.sessions()
    if (!before.some((s) => s.inTurn)) {
      d.hold()
      const after = await d.sessions().catch((): MoveSession[] | null => null)
      if (after && !after.some((s) => s.inTurn)) { quiet = after; break }
      d.release()
    }
    if (d.now() - rec.startedAt >= waitMs) {
      return end({ result: 'gave_up', why: `a turn of this Walnut's sessions there ran the whole wait (${Math.round(waitMs / 60_000)} min); nothing was stopped`, stopped: rec.stopped })
    }
    await d.sleep(d.pollMs ?? POLL_MS)
  }

  // holding: the starts and sends wait; each live session stops the normal way, then the follower.
  await save({ phase: 'holding' })
  for (const s of quiet) {
    const ok = await d.stop(s.id).catch(() => false)
    if (!ok) {
      d.release()
      return end({ result: 'gave_up', why: `session ${s.id} did not confirm its stop; the sessions stopped so far resume on the shared daemon`, stopped: rec.stopped })
    }
    await save({ stopped: [...new Set([...rec.stopped, s.id])] })
  }
  try {
    await d.stopFollower()
  } catch (e) {
    d.release()
    return end({ result: 'gave_up', why: `this Walnut's follower on the shared daemon did not stop (${errText(e)})`, stopped: rec.stopped })
  }

  // flipped: on disk before the flip, so a restart in between points it back.
  await save({ phase: 'flipped' })
  let flipError: string | null = null
  try { await d.flip() } catch (e) { flipError = errText(e) }
  const got = flipError === null ? await d.reconnect(reconnectMs).catch(() => null) : null
  if (got === d.set) {
    await d.confirm().catch(() => { /* net: the set's service confirms it itself when its leader's link authenticates */ })
    await save({ phase: 'done', why: undefined, nextTryAt: undefined })
    d.release()
    const outcome: MoveOutcome = { result: 'moved', stopped: rec.stopped }
    d.report(outcome)
    return outcome
  }
  // Never leave the host unreachable: back to the shared daemon, the held work released there.
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
