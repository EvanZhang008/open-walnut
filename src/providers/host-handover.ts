/**
 * A start or a resume this leader hands to the host that will run and judge the session
 * (docs/plan/one-service-every-host.md, phase 2), and the window in which its outcome is not known
 * here. One module for both kinds (host-judged-runner.ts startOnJudgingHost, host-resume.ts).
 *
 *   hand      handStartToHost: a mark on disk first (core/session-channel/handover-marks.ts), then in
 *             flight (a rows snapshot keeps it), host-judged here, and the leader's row marked the
 *             host's (session-tracker.ts handSeedToHost)
 *   window    while the mark stands, the session is neither the host's for sends nor the leader's: a
 *             send or a redelivery of it waits here, unsent and never counted as a refusal
 *             (host-judged-send.ts), and no copy round makes the row the host's without its claim
 *             (session-db.ts applySessionCopy)
 *   ended     the host's yes (handOverAnswered) or its row of the session (noteHostStartBorn; the
 *             channel clears the mark with the row, in one transaction): what waited goes to the host
 *             then, once by its row ids
 *   back      a refusal, a request never sent, or the lost check (takeStartBack): the leader's again
 *   lost      no answer: armLostStartCheck waits for the host's row up to the in-flight time, then
 *             the session is the leader's again and the kind's onLost runs (a start fails as one that
 *             never ran, a resume runs here once). A kind's `stillRuns` asks the host first and keeps
 *             it waiting while the host may run it (no two judges of one session).
 *   restart   a leader that stops in the window arms the lost check again at boot for every mark
 *             (rearmHandOvers), with the hooks of its kind.
 */
import { log } from '../logging/index.js'
import { forgetHostJudged, noteHostJudged } from '../core/sessions/judge-of.js'
import {
  clearHandOverMark, handOverMarkStands, handOverMarks, writeHandOverMark, type HandOverKind, type HandOverMark,
} from '../core/session-channel/handover-marks.js'
import { forgetWaitingLines, releaseLinesAfterHandOver } from './host-judged-send.js'

export type { HandOverKind } from '../core/session-channel/handover-marks.js'

/** What a lost check does with a hand-over of one kind. */
export interface LostHooks {
  /** The host never took it: it is the leader's again (taken back first). */
  onLost?: (err: Error) => Promise<void>
  /** The host's row of it came: the host has it. */
  onBorn?: () => void
  /** Asked when the wait runs out: true keeps it waiting another round (the host may run it). */
  stillRuns?: () => Promise<boolean>
}

/**
 * Seeded sessions whose start went to their host and whose born row has not come yet (a start the
 * host answered, or one whose answer was lost), until then or IN_FLIGHT_MS: a rows snapshot keeps
 * them untouched (rows-snapshot.ts), even one taken before the host wrote the row.
 */
const inFlight = new Map<string, number>()
const IN_FLIGHT_MS = 15 * 60_000
/** At boot, a mark whose wait already ran out still waits this long for the host's channel to link. */
const REARM_FLOOR_MS = 60_000

export function hostStartsInFlight(): ReadonlySet<string> {
  const now = Date.now()
  for (const [sid, until] of inFlight) if (until <= now) inFlight.delete(sid)
  return new Set(inFlight.keys())
}

/** The unanswered hand-overs, as on disk (loaded once; written through). */
const marks = new Map<string, HandOverMark>()
let marksLoaded = false

function loadMarks(): void {
  if (marksLoaded) return
  try {
    const all = handOverMarks()
    if (!all) return
    // Host-judged from the first look: a send of it goes the host-judged way and waits there.
    for (const m of all) { marks.set(m.sid, m); noteHostJudged(m.sid, m.host) }
    marksLoaded = true
  } catch { /* no database yet: asked again next time */ }
}

function dropMark(sid: string): boolean {
  loadMarks()
  // Written through: a mark on disk is in memory too, so a session with none costs no write.
  if (!marks.delete(sid)) return false
  try { clearHandOverMark(sid) } catch (err) {
    log.session.warn('host hand-over: its mark was not cleared on disk', { sessionId: sid, error: errText(err) })
  }
  return true
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Is a hand-over of `sid` unanswered (its sends wait here)? Sync: one map lookup. */
export function handOverPending(sid: string): boolean {
  loadMarks()
  return marks.has(sid)
}

/**
 * A start (or a resume) of `sid` goes to `host`: it is in flight and the host's before the host
 * speaks (its facts can beat the answer), and the leader's row of it, when there is one, is marked
 * the host's, so the channel's born row fills it in. True: a row was marked (takeStartBack gives it
 * back). The mark comes first and in the same tick as noteHostJudged, so no send of it goes out
 * before the window is open.
 */
export async function handStartToHost(sid: string, host: string, kind: HandOverKind = 'start'): Promise<boolean> {
  loadMarks()
  const m: HandOverMark = { sid, host, kind, since: Date.now() }
  marks.set(sid, m)
  try { writeHandOverMark(m) } catch (err) {
    log.session.warn('host hand-over: its mark was not written on disk; a restart in its window forgets it', { sessionId: sid, host, error: errText(err) })
  }
  inFlight.set(sid, m.since + IN_FLIGHT_MS)
  noteHostJudged(sid, host)
  const tracker = await import('../core/session-tracker.js')
  return tracker.handSeedToHost(sid, host).catch((err: unknown) => {
    log.session.warn('host start: the seeded row was not handed to its host', { sessionId: sid, host, error: errText(err) })
    return false
  })
}

/** The host said yes: the window ends, and what waited goes to the host now (it is in flight until its born row). */
export function handOverAnswered(sid: string): void {
  if (dropMark(sid)) releaseLinesAfterHandOver(sid)
}

/** The host did not take the start (or the resume) of `sid`: it is the leader's again, and so is its row. */
export async function takeStartBack(sid: string, host: string, handed: boolean): Promise<void> {
  inFlight.delete(sid)
  const lost = lostStarts.get(sid)
  if (lost) { clearTimeout(lost.timer); lostStarts.delete(sid) }
  dropMark(sid)
  forgetHostJudged(sid)
  // What waited for the host is the leader's to deliver now (its runner's own queue).
  forgetWaitingLines(sid)
  if (!handed) return
  const tracker = await import('../core/session-tracker.js')
  await tracker.takeSeedBack(sid, host).catch(() => {})
}

/** How long a hand-over whose answer was lost waits for the host's row (tests shorten it). */
export function lostStartMs(): number {
  const n = Number(process.env.WALNUT_HOST_START_LOST_MS)
  return Number.isFinite(n) && n > 0 ? n : IN_FLIGHT_MS
}

const lostStarts = new Map<string, { hooks: LostHooks; timer: ReturnType<typeof setTimeout> }>()

/**
 * A hand-over whose answer was lost (sent, no answer): when the wait runs out with no row from the
 * host, the host never took it, and `hooks.onLost` runs; its row in time runs `hooks.onBorn`.
 */
export function armLostStartCheck(sid: string, host: string, handed: boolean, why: string, hooks: LostHooks = {}, waitMs = lostStartMs()): void {
  const before = lostStarts.get(sid)
  if (before) clearTimeout(before.timer)
  const entry = { hooks, timer: undefined as unknown as ReturnType<typeof setTimeout> }
  const arm = (ms: number) => {
    entry.timer = setTimeout(() => {
      void lostCheck(sid, host, handed, why, entry, arm).catch((err: unknown) => log.session.warn('host start: failing a lost start failed', { sessionId: sid, host, error: errText(err) }))
    }, ms)
    entry.timer.unref?.()
  }
  lostStarts.set(sid, entry)
  arm(waitMs)
}

async function lostCheck(sid: string, host: string, handed: boolean, why: string, entry: { hooks: LostHooks }, arm: (ms: number) => void): Promise<void> {
  if (lostStarts.get(sid) !== entry) return // its row came, or it was taken back
  // The channel cleared the mark with the host's row while this process did not hear of it.
  if (handOverMarkStands(sid) === false && marks.has(sid)) { noteHostStartBorn(sid); return }
  if (entry.hooks.stillRuns && await entry.hooks.stillRuns().catch(() => true)) {
    if (lostStarts.get(sid) !== entry) return
    log.session.warn('host hand-over: no row from the host yet, and it may run the session; it waits on', { sessionId: sid, host })
    inFlight.set(sid, Date.now() + lostStartMs())
    arm(lostStartMs())
    return
  }
  if (lostStarts.get(sid) !== entry) return
  lostStarts.delete(sid)
  await takeStartBack(sid, host, handed)
  log.session.warn('host start: no born row came for a start whose answer was lost; it failed', { sessionId: sid, host, error: why })
  await entry.hooks.onLost?.(new Error(`the host ${host} never started the session (${why})`))
}

/** The host's row of `sid` was applied here (leader-side.ts): its hand-over is no longer in flight. */
export function noteHostStartBorn(sid: string): void {
  inFlight.delete(sid)
  const lost = lostStarts.get(sid)
  if (lost) { clearTimeout(lost.timer); lostStarts.delete(sid) }
  const marked = dropMark(sid)
  lost?.hooks.onBorn?.()
  if (marked || lost) releaseLinesAfterHandOver(sid)
}

/**
 * At boot: every hand-over this leader had not heard the answer of when it stopped is host-judged
 * and in flight again, and its lost check runs again with what is left of its wait (at least
 * REARM_FLOOR_MS, so the host's channel can link first). `hooksOf` gives the hooks of its kind.
 */
export function rearmHandOvers(hooksOf: (m: HandOverMark) => LostHooks): number {
  loadMarks()
  const now = Date.now()
  let n = 0
  for (const m of [...marks.values()]) {
    if (lostStarts.has(m.sid)) continue
    const left = Math.max(m.since + lostStartMs() - now, Math.min(lostStartMs(), REARM_FLOOR_MS))
    inFlight.set(m.sid, now + left)
    noteHostJudged(m.sid, m.host)
    armLostStartCheck(m.sid, m.host, true, 'this leader restarted before the host answered', hooksOf(m), left)
    n++
  }
  if (n > 0) log.session.info('host hand-over: hand-overs unanswered before this leader restarted wait for their host again', { count: n })
  return n
}

export function _resetHostHandOverForTesting(opts: { keepDisk?: boolean } = {}): void {
  for (const e of lostStarts.values()) clearTimeout(e.timer)
  lostStarts.clear()
  inFlight.clear()
  if (!opts.keepDisk) for (const sid of marks.keys()) { try { clearHandOverMark(sid) } catch { /* no database */ } }
  marks.clear()
  marksLoaded = false
}
