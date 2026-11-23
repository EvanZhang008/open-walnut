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
 *             asks the host (hostVerdict): it owns the session (taken: the window ends as with its
 *             row), it says it does not and its runtime runs no CLI of it (lost: the session is the
 *             leader's again and the kind's onLost runs, a start fails as one that never ran and its
 *             waiting lines park with why, a resume runs here once), else it waits on (no two judges
 *             of one session), said in Walnut Health.
 *   restart   a leader that stops in the window arms the lost check again at boot for every mark
 *             (rearmHandOvers), with the hooks of its kind; its clock runs from the host's first
 *             channel link after the boot.
 *   disowned  a host that says twice it does not own a session it judges, outside any window
 *             (host-judged-send.ts confirmHostDisowns): takeSessionBack, and the next delivery hands
 *             it over again with the claim.
 */
import { log } from '../logging/index.js'
import { forgetHostJudged, noteHostJudged } from '../core/sessions/judge-of.js'
import {
  clearHandOverMark, handOverMarkStands, handOverMarks, writeHandOverMark, type HandOverKind, type HandOverMark,
} from '../core/session-channel/handover-marks.js'
import { NOT_OWN_SESSION } from '../core/session-channel/host-api.js'
import { healthConditions, hostLabel } from '../core/notifications/health-items.js'
import { forgetWaitingLines, releaseLinesAfterHandOver } from './host-judged-send.js'

export type { HandOverKind } from '../core/session-channel/handover-marks.js'

/** What the host says of a hand-over whose answer was lost: it has it, it may, or it never took it. */
export type HandOverVerdict = 'taken' | 'wait' | 'lost'

/** What a lost check does with a hand-over of one kind. */
export interface LostHooks {
  /** The host never took it: it is the leader's again (taken back first). */
  onLost?: (err: Error) => Promise<void>
  /** The host's row of it came, or the host said it has it: the host has it. */
  onBorn?: () => void
  /** Asked when the wait runs out (hostVerdict): only 'lost' gives it back; 'wait' waits another round. */
  verdict?: () => Promise<HandOverVerdict>
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
export async function handStartToHost(sid: string, host: string, kind: HandOverKind = 'start', o: { taskId?: string } = {}): Promise<boolean> {
  loadMarks()
  const m: HandOverMark = { sid, host, kind, since: Date.now() }
  marks.set(sid, m)
  try { writeHandOverMark(m) } catch (err) {
    log.session.warn('host hand-over: its mark was not written on disk; a restart in its window forgets it', { sessionId: sid, host, error: errText(err) })
  }
  inFlight.set(sid, m.since + IN_FLIGHT_MS)
  noteHostJudged(sid, host)
  // The host may bring this session here (handed-sessions.ts), for its task: a start's, or the
  // resumed row's own. On disk before anything goes out.
  const [hands, { sessionTaskAndEngineInStore }] = await Promise.all([import('../core/session-channel/handed-sessions.js'), import('../core/session-db.js')])
  const taskId = o.taskId ?? (() => { try { return sessionTaskAndEngineInStore(sid)?.taskId } catch { return undefined } })() ?? ''
  await hands.handStart(host, sid, { taskId }).catch((err: unknown) => {
    log.session.warn('host hand-over: its hand was not kept; the host\'s row of it applies only once the leader\'s is the host\'s', { sessionId: sid, host, error: errText(err) })
  })
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
  if (lost?.timer) clearTimeout(lost.timer)
  if (lost) lostStarts.delete(sid)
  waitingLink.delete(sid)
  dropMark(sid)
  forgetHostJudged(sid)
  // What waited for the host is the leader's to deliver now (its runner's own queue).
  forgetWaitingLines(sid)
  // The host may no longer bring it here as a new session (handed-sessions.ts).
  await (await import('../core/session-channel/handed-sessions.js')).dropHandsOf(host, sid).catch((err: unknown) => {
    log.session.warn('host hand-over: the hand of a session taken back was not dropped; it lapses by itself', { sessionId: sid, host, error: errText(err) })
  })
  if (!handed) return
  const tracker = await import('../core/session-tracker.js')
  await tracker.takeSeedBack(sid, host).catch(() => {})
}

/** How long a hand-over whose answer was lost waits for the host's row (tests shorten it). */
export function lostStartMs(): number {
  const n = Number(process.env.WALNUT_HOST_START_LOST_MS)
  return Number.isFinite(n) && n > 0 ? n : IN_FLIGHT_MS
}

const lostStarts = new Map<string, { hooks: LostHooks; timer: ReturnType<typeof setTimeout> | null }>()

/**
 * A hand-over whose answer was lost (sent, no answer): when the wait runs out with no row from the
 * host, its verdict is asked; only 'lost' gives it back and runs `hooks.onLost`. Its row in time
 * runs `hooks.onBorn`. `waitMs` null: armed, its clock not running yet (rearmHandOvers).
 */
export function armLostStartCheck(sid: string, host: string, handed: boolean, why: string, hooks: LostHooks = {}, waitMs: number | null = lostStartMs()): void {
  const before = lostStarts.get(sid)
  if (before?.timer) clearTimeout(before.timer)
  const entry: { hooks: LostHooks; timer: ReturnType<typeof setTimeout> | null; arm?: (ms: number) => void } = { hooks, timer: null }
  entry.arm = (ms: number) => {
    entry.timer = setTimeout(() => {
      void lostCheck(sid, host, handed, why, entry, entry.arm!).catch((err: unknown) => log.session.warn('host start: failing a lost start failed', { sessionId: sid, host, error: errText(err) }))
    }, ms)
    entry.timer.unref?.()
  }
  lostStarts.set(sid, entry)
  if (waitMs !== null) entry.arm(waitMs)
}

async function lostCheck(sid: string, host: string, handed: boolean, why: string, entry: { hooks: LostHooks }, arm: (ms: number) => void): Promise<void> {
  if (lostStarts.get(sid) !== entry) return // its row came, or it was taken back
  // The channel cleared the mark with the host's row while this process did not hear of it.
  if (handOverMarkStands(sid) === false && marks.has(sid)) { noteHostStartBorn(sid); return }
  const verdict = entry.hooks.verdict ? await entry.hooks.verdict().catch((): HandOverVerdict => 'wait') : 'lost'
  if (lostStarts.get(sid) !== entry) return
  if (verdict === 'taken') {
    log.session.info('host hand-over: the host holds the session whose answer was lost; it is the host\'s', { sessionId: sid, host })
    noteHostStartBorn(sid)
    return
  }
  if (verdict === 'wait') {
    log.session.warn('host hand-over: no row from the host yet, and it may run the session; it waits on', { sessionId: sid, host })
    inFlight.set(sid, Date.now() + lostStartMs())
    arm(lostStartMs())
    return
  }
  lostStarts.delete(sid)
  await takeStartBack(sid, host, handed)
  log.session.warn('host start: no born row came for a start whose answer was lost; it failed', { sessionId: sid, host, error: why })
  await entry.hooks.onLost?.(new Error(`the host ${host} never started the session (${why})`))
}

/** The host's row of `sid` was applied here (leader-side.ts): its hand-over is no longer in flight. */
export function noteHostStartBorn(sid: string): void {
  inFlight.delete(sid)
  const lost = lostStarts.get(sid)
  if (lost?.timer) clearTimeout(lost.timer)
  if (lost) lostStarts.delete(sid)
  const marked = dropMark(sid)
  lost?.hooks.onBorn?.()
  if (marked || lost) releaseLinesAfterHandOver(sid)
}

// ── What the host says of a session (the lost check, and a host that says it does not own one) ──

/** The leader side, or null while this server has no link to its hosts. */
async function sideNow() {
  const { activeLeaderSide } = await import('../core/session-channel/leader-boot.js')
  return activeLeaderSide()
}

/**
 * Does `host` own `sid` (or start it now)? A send with no line and nothing to run (holdOnly) is
 * answered by the host's own check (host-routes.ts): yes, no (not_own_session), or null (no answer,
 * another refusal).
 */
export async function askHostOwns(sid: string, host: string): Promise<boolean | null> {
  const side = await sideNow().catch(() => null)
  if (!side) return null
  try {
    const a = await side.sendToHost(host, { sessionId: sid, message: '', queued: [], holdOnly: true })
    return a.ok === true ? true : a.error === NOT_OWN_SESSION ? false : null
  } catch {
    return null
  }
}

/** The host's runtime on the CLI of `sid`, through this leader's daemon link to it (null: no answer). */
export async function cliOnHost(host: string, sid: string): Promise<boolean | null> {
  try {
    const { probeDaemonSession } = await import('./daemon-connection.js')
    const probe = await probeDaemonSession(host, sid)
    return probe ? probe.alive : null
  } catch {
    return null
  }
}

/** A hand-over whose answer was lost and whose host may have it: one Walnut Health item per session. */
const unanswered = healthConditions('host-handover')
const unansweredKey = (sid: string) => `host-handover-unanswered:${sid}`

/**
 * The verdict on a hand-over whose answer was lost: 'taken' when the host owns the session, 'lost'
 * only when it says it does not and its runtime runs no CLI of it, else 'wait' (with a Health item:
 * the session waits for its host's word and is never run here too).
 */
export async function hostVerdict(sid: string, host: string): Promise<HandOverVerdict> {
  const owns = await askHostOwns(sid, host)
  if (owns === true) { void unanswered.recover(unansweredKey(sid)); return 'taken' }
  const alive = owns === false ? await cliOnHost(host, sid) : null
  if (owns === false && alive === false) { void unanswered.recover(unansweredKey(sid)); return 'lost' }
  void unanswered.raise(unansweredKey(sid), async () => {
    const label = await hostLabel(host)
    const why = owns === null ? `${label} does not answer` : alive ? `its CLI runs on ${label}` : `${label} does not say whether its CLI runs`
    return {
      kind: 'operation-error', severity: 'warning', category: 'Sessions', host, sessionId: sid,
      title: `A session handed to ${label} has no answer yet`,
      body: `Walnut handed the session to ${label} and got no answer, and ${why}, so Walnut does not run it here too: its messages wait until ${label} answers, and Walnut asks again later.`,
      detail: `hand-over of ${sid} to ${host}: no answer and no row from the host; it owns it: ${String(owns)}, its runtime says the CLI runs: ${String(alive)}`,
      dedupKey: unansweredKey(sid), recoveryKey: unansweredKey(sid),
    }
  })
  return 'wait'
}

/** The hooks of a start (in process, and armed again at boot): its failure, then the lines that waited. */
export function startLostHooks(sid: string, host: string, onLost?: (err: Error) => Promise<void>): LostHooks {
  return {
    verdict: () => hostVerdict(sid, host),
    onBorn: () => { void unanswered.recover(unansweredKey(sid)) },
    onLost: async (err) => {
      await onLost?.(err)
      await parkStartLines(sid, err)
    },
  }
}

export const HOST_START_LOST_REASON = 'The session did not start on its host'

/** Lines a person sent while a start was out, on a start that never ran: parked, with why, for a Retry. */
async function parkStartLines(sid: string, err: Error): Promise<void> {
  try {
    const [{ peekLinesForHost, parkMessages }, { heldOf }] = await Promise.all([import('../core/session-message-queue.js'), import('../core/sessions/handed-holds.js')])
    const runs = (await peekLinesForHost(sid)).filter((m) => !heldOf(m))
    if (runs.length > 0) await parkMessages(runs, `${HOST_START_LOST_REASON}: ${err.message}`)
  } catch (e) {
    log.session.warn('host start: the lines of a start that never ran were not parked', { sessionId: sid, error: errText(e) })
  }
}

/** The leader's own delivery of a session (the runner's processNext), for a session taken back from its host. */
let leaderDelivery: ((sid: string) => void) | null = null
export function setLeaderDelivery(fn: ((sid: string) => void) | null): void {
  leaderDelivery = fn
}

/**
 * The host does not hold `sid` (it said so twice, outside any hand-over: its store lost the row, it
 * gave the row back): the session is the leader's again, at rest, and its next delivery runs here,
 * which hands it to the host again with the claim and the at-rest checks (host-resume.ts).
 */
export async function takeSessionBack(sid: string, host: string): Promise<void> {
  await takeStartBack(sid, host, true)
  const { forgetRemoteJudgedSession } = await import('./remote-judged-session.js')
  forgetRemoteJudgedSession(sid)
  leaderDelivery?.(sid)
}

/**
 * At boot: every hand-over this leader had not heard the answer of when it stopped is host-judged
 * and in flight again, and its lost check is armed again with what is left of its wait (at least
 * REARM_FLOOR_MS). Its clock runs from its host's first channel link after the boot (noteHostLinked),
 * not from the boot, or from REARM_BACKSTOP_MS after the boot if that host never links.
 * `hooksOf` gives the hooks of its kind.
 */
export function rearmHandOvers(hooksOf: (m: HandOverMark) => LostHooks, linkedNow: (host: string) => boolean = () => false): number {
  loadMarks()
  const now = Date.now()
  let n = 0
  for (const m of [...marks.values()]) {
    if (lostStarts.has(m.sid)) continue
    const left = Math.max(m.since + lostStartMs() - now, Math.min(lostStartMs(), REARM_FLOOR_MS))
    inFlight.set(m.sid, now + REARM_BACKSTOP_MS + left)
    noteHostJudged(m.sid, m.host)
    armLostStartCheck(m.sid, m.host, true, 'this leader restarted before the host answered', hooksOf(m), null)
    waitingLink.set(m.sid, { host: m.host, left })
    n++
  }
  for (const host of new Set([...waitingLink.values()].map((w) => w.host))) if (linkedNow(host)) noteHostLinked(host)
  if (waitingLink.size > 0 && !backstop) {
    backstop = setTimeout(() => { backstop = null; for (const sid of [...waitingLink.keys()]) startClock(sid) }, REARM_BACKSTOP_MS)
    backstop.unref?.()
  }
  if (n > 0) log.session.info('host hand-over: hand-overs unanswered before this leader restarted wait for their host again', { count: n })
  return n
}

/** Re-armed checks whose clock waits for their host's first link after the boot. */
const waitingLink = new Map<string, { host: string; left: number }>()
const REARM_BACKSTOP_MS = IN_FLIGHT_MS
let backstop: ReturnType<typeof setTimeout> | null = null

function startClock(sid: string): void {
  const w = waitingLink.get(sid)
  waitingLink.delete(sid)
  const entry = lostStarts.get(sid) as { timer: ReturnType<typeof setTimeout> | null; arm?: (ms: number) => void } | undefined
  if (!w || !entry?.arm || entry.timer) return
  inFlight.set(sid, Date.now() + w.left)
  entry.arm(w.left)
}

/** `host`'s session channel linked (leader-boot.ts onLinked): the re-armed clocks of its hand-overs start. */
export function noteHostLinked(host: string): void {
  for (const [sid, w] of [...waitingLink]) if (w.host === host) startClock(sid)
}

export function _resetHostHandOverForTesting(opts: { keepDisk?: boolean } = {}): void {
  for (const e of lostStarts.values()) if (e.timer) clearTimeout(e.timer)
  lostStarts.clear()
  waitingLink.clear()
  if (backstop) { clearTimeout(backstop); backstop = null }
  unanswered.reset()
  inFlight.clear()
  if (!opts.keepDisk) for (const sid of marks.keys()) { try { clearHandOverMark(sid) } catch { /* no database */ } }
  marks.clear()
  marksLoaded = false
}
