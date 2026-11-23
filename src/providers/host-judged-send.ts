/**
 * The lines this leader queued for a session its host runs and judges, and their way to that host
 * (docs/plan/one-service-every-host.md, phase 2). The leader's own drain is off for such a session
 * (host-judged-runner.ts GATED), so every line that waits here goes by this module, and a line
 * stays in this leader's queue until the host confirmed it took it.
 *
 *   send       a person's or an agent's send: every waiting line (pending rows, rows held for after
 *              the turn or a cold wake, which go with their hold) and a kick that drains the host's queue
 *   hand       a row just held here: the waiting lines, held ones only as holds (no kick)
 *   redeliver  ONE path for every line not confirmed taken: a send or a hand that failed or was
 *              refused puts its lines back and tries again (5 s, 30 s, 2 min, then every 10 min, never
 *              giving up), and each time the host's channel links (leader-side.ts onLinked) every
 *              session of that host with waiting lines goes again at once
 *   once       a resend is idempotent on the host: it queues each line by its row id once
 *              (session-message-queue.ts enqueueMessage `onceById`), so a send whose answer was lost
 *              (the host took it, the leader timed out) never runs twice
 *   refused    the host answered no three times in a row: the rows that would run park here with the
 *              host's reason (a person retries them); a link that fails is never a refusal
 *   hand-over  while a start or a resume of the session waits for its host's answer (host-handover.ts
 *              handOverPending), nothing goes and nothing counts: the lines wait here, and go once
 *              the host's answer or row ends the window (releaseLinesAfterHandOver), or are the
 *              leader's own again when the session is taken back (forgetWaitingLines)
 *
 * All of it in the session's command order (inOrder): a send takes the lines the one before it
 * left, an interrupt after a send goes after it.
 */
import { log } from '../logging/index.js'
import { judgingHostOf } from '../core/sessions/judge-of.js'
import { heldOf } from '../core/sessions/handed-holds.js'
import type { QueuedLine } from '../core/session-channel/host-api.js'
import type { QueuedMessage } from '../core/session-queue-store.js'
import { NOT_OWN_SESSION } from '../core/session-channel/host-api.js'
import { handOverPending } from './host-handover.js'

/** Waits before each retry of a session's waiting lines; the last one repeats for good. */
export const REDELIVER_MS = [5_000, 30_000, 120_000, 600_000]
/** Refusals in a row after which the rows that would run park with the host's reason. */
export const REFUSALS_BEFORE_PARK = 3
export const HOST_REFUSED_REASON = 'The host that runs this session refused the message'

interface Waiting {
  attempt: number
  refusals: number
  timer: ReturnType<typeof setTimeout> | null
  /** The send whose kick did not reach the host: its source and wait end, for the task's input edge. */
  kick?: { source: string; endsWait: boolean }
}

/** Sessions whose lines (or kick) did not reach their host yet. */
const waiting = new Map<string, Waiting>()

/** The leader side (leader-boot.ts), or a throw while this server has no link to its hosts. */
async function leaderSide() {
  const { activeLeaderSide } = await import('../core/session-channel/leader-boot.js')
  const side = activeLeaderSide()
  if (!side) throw new Error('this server has no link to the hosts that run their sessions')
  return side
}

const commandChains = new Map<string, Promise<void>>()

/** Run `run` after every command of `sid` before it (a failure of one never stops the next). */
export function inOrder(sid: string, run: () => Promise<void>): Promise<void> {
  const next = (commandChains.get(sid) ?? Promise.resolve()).catch(() => {}).then(run)
  commandChains.set(sid, next)
  void next.finally(() => { if (commandChains.get(sid) === next) commandChains.delete(sid) }).catch(() => {})
  return next
}

/** One queued row as it crosses to a host (host-api.ts QueuedLine). */
export function queuedLineOf(m: QueuedMessage): QueuedLine {
  const held = heldOf(m)
  return {
    id: m.id, message: m.message,
    ...(m.userUuid ? { userUuid: m.userUuid } : {}), ...(m.lineUuid ? { lineUuid: m.lineUuid } : {}),
    ...(m.closesPrompt ? { closesPrompt: true as const } : {}), ...(m.sentBy ? { sentBy: m.sentBy } : {}),
    ...(held ? { held } : {}),
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function stateOf(sid: string): Waiting {
  let w = waiting.get(sid)
  if (!w) { w = { attempt: 0, refusals: 0, timer: null }; waiting.set(sid, w) }
  return w
}

function settle(sid: string): void {
  const w = waiting.get(sid)
  if (w?.timer) clearTimeout(w.timer)
  waiting.delete(sid)
}

function scheduleRedeliver(sid: string): void {
  const w = stateOf(sid)
  if (w.timer) return
  const wait = REDELIVER_MS[Math.min(w.attempt, REDELIVER_MS.length - 1)]
  w.attempt++
  w.timer = setTimeout(() => { w.timer = null; redeliver(sid) }, wait)
  w.timer.unref?.()
}

interface DeliverOpts {
  /** The send event's own payload (a send); a redelivery or a hand makes its own. */
  body?: Record<string, unknown>
  /** Drain the host's queue after the lines are queued there (a send, a redelivery of a send). */
  kick: boolean
  source: string
  endsWait: boolean
}

/**
 * Hand every waiting line of `sid` to `host`; resolves once the host took them. Not taken: the lines
 * are back in this queue and a redelivery is scheduled (or, refused too often, the rows park), and
 * it rejects with why.
 */
async function deliver(sid: string, host: string, o: DeliverOpts): Promise<void> {
  if (handOverPending(sid)) { waitForHandOver(sid, o); return }
  let side: Awaited<ReturnType<typeof leaderSide>>
  try { side = await leaderSide() } catch (err) {
    if (o.kick) stateOf(sid).kick = { source: o.source, endsWait: o.endsWait }
    scheduleRedeliver(sid)
    throw err
  }
  const { takeLinesForHost, parkMessages } = await import('../core/session-message-queue.js')
  let taken: Awaited<ReturnType<typeof takeLinesForHost>>
  try { taken = await takeLinesForHost(sid) } catch (err) {
    // Not taken (the queue file could not be written): the lines are still queued here.
    if (o.kick) stateOf(sid).kick = { source: o.source, endsWait: o.endsWait }
    scheduleRedeliver(sid)
    throw err
  }
  const goesNow = taken.lines.some((m) => !heldOf(m))
  const kick = o.kick || goesNow
  if (taken.lines.length === 0 && !kick) { settle(sid); return }
  const payload: Record<string, unknown> = {
    ...(o.body ?? { sessionId: sid, message: '' }),
    sessionId: sid,
    queued: taken.lines.map(queuedLineOf),
    busSource: (o.body?.busSource as string | undefined) ?? o.source,
    ...(kick ? {} : { holdOnly: true }),
  }
  const w = stateOf(sid)
  // The send this kick stands for: its task input edge waits for the host to take it.
  if (kick) w.kick = { source: o.source, endsWait: o.endsWait || w.kick?.endsWait === true }
  let a: Awaited<ReturnType<typeof side.sendToHost>>
  try {
    a = await side.sendToHost(host, payload)
  } catch (err) {
    await taken.putBack()
    log.session.warn('host-run session: its lines did not reach its host; they go again', { sessionId: sid, host, lines: taken.lines.length, attempt: w.attempt, error: errText(err) })
    scheduleRedeliver(sid)
    throw err
  }
  if (a.ok !== true) {
    await taken.putBack()
    // A hand-over of it began while this send was out: the host does not own it yet, which is no
    // refusal; the lines wait for the hand-over's end.
    if (a.error === NOT_OWN_SESSION && handOverPending(sid)) { waitForHandOver(sid, o); return }
    w.refusals++
    const why = a.error ?? 'no reason given'
    if (w.refusals >= REFUSALS_BEFORE_PARK) {
      const runs = taken.lines.filter((m) => !heldOf(m))
      const parked = await parkMessages(runs, `${HOST_REFUSED_REASON}: ${why}`)
      log.session.warn('host-run session: its host kept refusing its lines; they are parked here', { sessionId: sid, host, parked, error: why })
      settle(sid)
    } else scheduleRedeliver(sid)
    throw new Error(`the host ${host} refused the send: ${why}`)
  }
  const told = w.kick
  settle(sid)
  // The host has them: their transit ends (session-queue-transit.ts).
  await taken.done()
  if (taken.lines.length > 0) log.session.info('host-run session: its lines went to its host', { sessionId: sid, host, lines: taken.lines.length, kick })
  // The task is the leader's: its side of the send is done once the host took it (leader-tasks.ts).
  if (kick && told) {
    const { noteHostSessionSend } = await import('../core/session-channel/leader-tasks.js')
    void noteHostSessionSend(sid, told.source, told.endsWait)
  }
}

/** A send (or a redelivery) of a session whose hand-over is unanswered: it waits, its kick kept for the release. */
function waitForHandOver(sid: string, o: DeliverOpts): void {
  const w = stateOf(sid)
  if (w.timer) { clearTimeout(w.timer); w.timer = null }
  if (o.kick) w.kick = { source: o.source, endsWait: o.endsWait || w.kick?.endsWait === true }
  log.session.info('host-run session: its lines wait here until its host answers the hand-over', { sessionId: sid })
}

/** The hand-over of `sid` ended with the host having it: what waited for it goes now. */
export function releaseLinesAfterHandOver(sid: string): void {
  void (async () => {
    if (!waiting.has(sid)) {
      const { peekLinesForHost } = await import('../core/session-message-queue.js')
      if ((await peekLinesForHost(sid)).length === 0) return
    }
    const w = waiting.get(sid)
    if (w) w.attempt = 0
    redeliver(sid)
  })().catch(() => { /* redeliver logs and retries itself */ })
}

/** The session is the leader's again (a hand-over taken back): nothing of it waits for a host. */
export function forgetWaitingLines(sid: string): void {
  settle(sid)
}

/**
 * A send to a session its host runs: the lines this leader queued for it (the send route queued
 * them here, hints and all) go with it to the host's queue, and leave this one once the host took
 * them. Not taken: they wait here and go again (redeliver), logged there: the send itself is
 * handled, so this never rejects (the runner's subscriber has nothing left to do with it).
 */
export function forwardSend(sid: string, host: string, body: Record<string, unknown>, source: string, endsWait: boolean): Promise<void> {
  return inOrder(sid, () => deliver(sid, host, { body, kick: true, source, endsWait })).catch(() => { /* logged; it goes again */ })
}

/**
 * Rows this leader held for a session its host runs (after the turn, a cold wake) go to the host with
 * their hold: the host releases them (sessions/handed-holds.ts). Lines that would run go with them.
 */
export function handHeldToHost(sid: string): void {
  const host = judgingHostOf(sid)
  if (!host) return
  inOrder(sid, () => deliver(sid, host, { kick: false, source: 'queue-hold', endsWait: false })).catch(() => { /* logged; it goes again */ })
}

/** Try `sid`'s waiting lines again now (a retry's time came, its host linked). */
function redeliver(sid: string): void {
  const host = judgingHostOf(sid)
  if (!host) { settle(sid); return }
  const w = waiting.get(sid)
  const kick = w?.kick
  inOrder(sid, () => deliver(sid, host, { kick: !!kick, source: kick?.source ?? 'queue-redeliver', endsWait: kick?.endsWait ?? false })).catch(() => { /* logged; it goes again */ })
}

/**
 * The channel of `host` linked: every session of that host with lines waiting here (or a kick that
 * did not reach it) goes again now, whatever its retry clock said. Also after this leader restarted:
 * its queue is on disk.
 */
export async function redeliverWaitingFor(host: string): Promise<number> {
  const { sessionsWithLinesForHost } = await import('../core/session-message-queue.js')
  const sids = new Set([...(await sessionsWithLinesForHost()), ...waiting.keys()])
  let n = 0
  for (const sid of sids) {
    if (judgingHostOf(sid) !== host) continue
    const w = waiting.get(sid)
    if (w?.timer) { clearTimeout(w.timer); w.timer = null }
    if (w) w.attempt = 0
    redeliver(sid)
    n++
  }
  if (n > 0) log.session.info('host-run sessions: lines that waited for their host go to it now', { host, sessions: n })
  return n
}

/** Tests: is a redelivery of `sid` scheduled, and how many sessions wait. */
export function _waitingForTesting(sid?: string): { sessions: number; scheduled: boolean; attempt: number; refusals: number } {
  const w = sid ? waiting.get(sid) : undefined
  return { sessions: waiting.size, scheduled: !!w?.timer, attempt: w?.attempt ?? 0, refusals: w?.refusals ?? 0 }
}

export function _resetHostJudgedSendForTesting(): void {
  for (const w of waiting.values()) if (w.timer) clearTimeout(w.timer)
  waiting.clear()
  commandChains.clear()
}
