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
 *   disowned   the host answers that it does not own the session, outside any hand-over (its store lost
 *              the row, it gave the row back): no refusal either. Asked once more (confirmHostDisowns),
 *              a second no takes the session back as the leader's, at rest, and its lines go by the
 *              leader's next delivery, which hands it over again with the claim (host-resume.ts)
 *   folder     a send that wakes the CLI at rest on its host makes its folder ready here first
 *              (session-folder-prep.ts: a released workspace made again); one still gone parks
 *              what would run here, recorded the folder-gone way, and nothing goes
 *   hand-over  while a start or a resume of the session waits for its host's answer (host-handover.ts
 *              handOverPending), nothing goes and nothing counts: the lines wait here, and go once
 *              the host's answer or row ends the window (releaseLinesAfterHandOver), or are the
 *              leader's own again when the session is taken back (forgetWaitingLines)
 *
 * All of it in the session's command order (inOrder): a send takes the lines the one before it
 * left, an interrupt after a send goes after it.
 */
import { log } from '../logging/index.js'
import { sendSourceReopensTerminal } from '../core/phase.js'
import { judgingHostOf } from '../core/sessions/judge-of.js'
import { heldOf } from '../core/sessions/handed-holds.js'
import type { QueuedLine } from '../core/session-channel/host-api.js'
import type { QueuedMessage } from '../core/session-queue-store.js'
import { NOT_OWN_SESSION } from '../core/session-channel/host-api.js'
import { askHostOwns, handOverPending, takeSessionBack } from './host-handover.js'
import { prepareHostSessionFolder } from './session-folder-prep.js'

/** Waits before each retry of a session's waiting lines; the last one repeats for good. */
export const REDELIVER_MS = [5_000, 30_000, 120_000, 600_000]
/** Refusals in a row after which the rows that would run park with the host's reason. */
export const REFUSALS_BEFORE_PARK = 3
export const HOST_REFUSED_REASON = 'The host that runs this session refused the message'

interface Waiting {
  attempt: number
  refusals: number
  timer: ReturnType<typeof setTimeout> | null
  /** The send whose kick did not reach the host: its source and wait end, for the task's input edge, and when it was sent. */
  kick?: Kick
}

interface Kick { source: string; endsWait: boolean; at: number }

/**
 * The kick a wait keeps for its task's input edge, `o`'s merged into the one waiting: a person's or a
 * peer's send stays the source (it reopens a COMPLETE task) when an automated one comes after it (a
 * hold handed on, a redelivery), and the wait ends with the earliest send's time.
 */
function keepKick(sid: string, o: Pick<DeliverOpts, 'source' | 'endsWait'>): void {
  const w = stateOf(sid)
  const prev = w.kick
  const source = prev && sendSourceReopensTerminal(prev.source) && !sendSourceReopensTerminal(o.source) ? prev.source : o.source
  w.kick = { source, endsWait: o.endsWait || prev?.endsWait === true, at: prev?.at ?? Date.now() }
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

/**
 * The wait of `sid` ends, the one place it does. A send's kick still on it that never reached the
 * host is the task's input all the same, as a send the runner takes is at send time: a forced peer
 * message reopens a COMPLETE task whatever becomes of its lines (taken back by the leader with the
 * session, its host gone, parked). `edgeGiven`: the caller ran the edge itself (the host took the
 * lines, or the edge went before a park's error). 2026-11-26, the Walnut VP: every path that drops a
 * kick, not only the gone folder (tests/providers/host-judged-send-park-reopen.test.ts).
 */
function settle(sid: string, o: { edgeGiven?: boolean } = {}): Promise<void> {
  const w = waiting.get(sid)
  if (w?.timer) clearTimeout(w.timer)
  waiting.delete(sid)
  return w?.kick && !o.edgeGiven ? kickEdge(sid, w.kick) : Promise.resolve()
}

/**
 * The input edge of a kick that never reached its host. Not once the task was completed after the
 * send (the user closed it meanwhile, and a late retry must not reopen it); never throws.
 */
async function kickEdge(sid: string, kick: Kick): Promise<void> {
  try {
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const row = await getSessionByClaudeId(sid).catch(() => null)
    if (!row?.taskId) return
    const { getTask } = await import('../core/task-manager.js')
    const task = await getTask(row.taskId).catch(() => null)
    if (!task || (task.phase === 'COMPLETE' && Date.parse(task.completed_at ?? '') > kick.at)) return
    const { noteHostSessionSend } = await import('../core/session-channel/leader-tasks.js')
    await noteHostSessionSend(sid, kick.source, kick.endsWait)
  } catch (err) {
    log.session.warn('host-run session: the input edge of a send that never reached its host failed', { sessionId: sid, error: errText(err) })
  }
}

function scheduleRedeliver(sid: string): void {
  const w = stateOf(sid)
  if (w.timer) return
  const wait = REDELIVER_MS[Math.min(w.attempt, REDELIVER_MS.length - 1)]
  w.attempt++
  w.timer = setTimeout(() => { w.timer = null; redeliver(sid) }, wait)
  w.timer.unref?.()
}

/**
 * A send whose lines park (on the gone folder, or after the host kept refusing them) instead of
 * reaching the host still is the task's input,
 * at send time and before the park's error, as the runner's handleSend makes it for a session it
 * runs (syncPhaseAfterSend runs before its spawn parks): a person's or a peer's message reopens a
 * COMPLETE task, and the folder-gone error that follows hands it back as Needs you, the usual way.
 * 2026-11-25 and 11-26: two forced task_sends to completed tasks parked on a removed workspace; the
 * redelivery after the folder came back carries the source 'folder-moved', which reopens nothing, so
 * each task worked on while it read COMPLETE and its asker's request was settled as completed with
 * no answer. A send kept from an earlier try (`kick` on its wait) counts as this one.
 */
async function inputEdgeBeforePark(sid: string, o: Pick<DeliverOpts, 'kick' | 'source' | 'endsWait'>): Promise<void> {
  if (o.kick) keepKick(sid, o)
  const kept = waiting.get(sid)?.kick
  if (!kept) return
  const { noteHostSessionSend } = await import('../core/session-channel/leader-tasks.js')
  await noteHostSessionSend(sid, kept.source, kept.endsWait)
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
    if (o.kick) keepKick(sid, o)
    scheduleRedeliver(sid)
    throw err
  }
  const { takeLinesForHost, parkMessages, peekLinesForHost, unparkRowsAhead } = await import('../core/session-message-queue.js')
  // A send that wakes its CLI at rest on the host (a kick, a line that runs): its folder is made
  // ready here first, as a spawn here would (a released workspace made again); the host's service
  // cannot. Never waited for here: this session's command chain (a Stop too) would wait behind it.
  // Still gone: the lines that would run park here, and the remake (kickRemake, its own longer
  // wait) sends them when the folder is there; one that cannot be made takes the folder-gone way.
  const wakes = o.kick || (await peekLinesForHost(sid).catch(() => [])).some((m) => !heldOf(m))
  if (wakes) {
    const folder = await prepareHostSessionFolder(sid, host, { remakeWaitMs: 0 })
    if (!folder.ok) {
      await inputEdgeBeforePark(sid, o)
      await parkWaitingOnGoneFolder(sid, folder.error ?? 'Working directory not available', folder.folder, folder.remake === 'pending')
      void settle(sid, { edgeGiven: true })
      return
    }
  }
  // Rows parked here on the gone folder (or on the agent) ride ahead of the lines that go now, in
  // their own order (core/sessions/folder-wait.ts), also into a CLI already running there (it is in
  // the folder); with no line going now it moves nothing. The host's runner does the same with its own.
  await unparkRowsAhead(sid).catch(() => [])
  let taken: Awaited<ReturnType<typeof takeLinesForHost>>
  try { taken = await takeLinesForHost(sid) } catch (err) {
    // Not taken (the queue file could not be written): the lines are still queued here.
    if (o.kick) keepKick(sid, o)
    scheduleRedeliver(sid)
    throw err
  }
  const goesNow = taken.lines.some((m) => !heldOf(m))
  const kick = o.kick || goesNow || !!waiting.get(sid)?.kick
  if (taken.lines.length === 0 && !kick) { void settle(sid); return }
  const payload: Record<string, unknown> = {
    ...(o.body ?? { sessionId: sid, message: '' }),
    sessionId: sid,
    queued: taken.lines.map(queuedLineOf),
    busSource: (o.body?.busSource as string | undefined) ?? o.source,
    ...(kick ? {} : { holdOnly: true }),
  }
  const w = stateOf(sid)
  // The send this kick stands for: its task input edge waits for the host to take it.
  if (kick) keepKick(sid, o)
  // These rows are this session's now (a row moved here from another session too): its host's
  // facts may name them (handed-sessions.ts linesNotOthers). Written before the send.
  if (taken.lines.length > 0) {
    const { noteLinesHanded } = await import('../core/session-channel/handed-sessions.js')
    await noteLinesHanded(sid, taken.lines.map((m) => m.id)).catch((err) => log.session.warn('host-run session: its handed lines were not noted', { sessionId: sid, host, error: errText(err) }))
  }
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
    // The host does not hold it: never a refusal. Asked again; a second no takes it back here.
    if (a.error === NOT_OWN_SESSION) {
      if (o.kick) keepKick(sid, o)
      void confirmHostDisowns(sid, host).then((back) => { if (!back && judgingHostOf(sid) === host) scheduleRedeliver(sid) })
      return
    }
    w.refusals++
    const why = a.error ?? 'no reason given'
    if (w.refusals >= REFUSALS_BEFORE_PARK) {
      const runs = taken.lines.filter((m) => !heldOf(m))
      // The send is the task's input before the park's error, which hands it back (inputEdgeBeforePark).
      await inputEdgeBeforePark(sid, o)
      const parked = await parkMessages(runs, `${HOST_REFUSED_REASON}: ${why}`)
      log.session.warn('host-run session: its host kept refusing its lines; they are parked here', { sessionId: sid, host, parked, error: why })
      if (runs.length > 0) {
        const { reportParkedBatch } = await import('./claude-code-session.js')
        reportParkedBatch(sid, runs.map((m) => m.id), `${HOST_REFUSED_REASON}: ${why}`)
        // A delivery failure's error moves no phase (server.ts): the task is handed back here, as a
        // refused start is (claude-code-session.ts start-refused), so it never reads Working idle.
        await refusedBack(sid)
      }
      void settle(sid, { edgeGiven: true })
    } else scheduleRedeliver(sid)
    throw new Error(`the host ${host} refused the send: ${why}`)
  }
  // Taken back meanwhile (forgetWaitingLines ended this wait and gave its edge): not twice.
  const told = waiting.get(sid) === w ? w.kick : undefined
  void settle(sid, { edgeGiven: true })
  // The host has them: their transit ends (session-queue-transit.ts).
  await taken.done()
  if (taken.lines.length > 0) log.session.info('host-run session: its lines went to its host', { sessionId: sid, host, lines: taken.lines.length, kick })
  // The task is the leader's: its side of the send is done once the host took it (leader-tasks.ts).
  if (kick && told) {
    const { noteHostSessionSend } = await import('../core/session-channel/leader-tasks.js')
    void noteHostSessionSend(sid, told.source, told.endsWait)
  }
}

/**
 * The folder of a host-run session is not there: what would run parks here with the spawn's reason
 * and the folder is recorded, the runner's way for its own (parkOnGoneFolder: noteFolderGone, which
 * follows a remake on its way, kickRemake, and sends the rows once the folder is there; else the
 * banner and its button). `remaking`: the task's workspace is being made again, so nothing failed
 * yet and no failure is said.
 */
async function parkWaitingOnGoneFolder(sid: string, reason: string, folder: { cwd: string; host: string } | undefined, remaking: boolean): Promise<void> {
  const { peekLinesForHost } = await import('../core/session-message-queue.js')
  const runs = (await peekLinesForHost(sid).catch(() => [])).filter((m) => !heldOf(m))
  const { parkOnGoneFolder } = await import('./claude-code-session.js')
  await parkOnGoneFolder(sid, runs, reason, folder, { quiet: remaking })
  log.session.warn(remaking
    ? 'host-run session: its workspace is being made again; its lines wait here and go when it is there'
    : 'host-run session: its folder is gone; its lines are parked here, not sent', { sessionId: sid, parked: runs.length, error: reason })
}

/** The lines a host kept refusing parked here: its task is handed back (Needs you), never left Working. */
async function refusedBack(sid: string): Promise<void> {
  try {
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const row = await getSessionByClaudeId(sid).catch(() => null)
    if (!row?.taskId) return
    const { applySessionPhase } = await import('../core/phase.js')
    await applySessionPhase(row.taskId, 'session:error', 'host-judged:refused-park', { sessionId: sid, processAlive: false })
  } catch (err) {
    log.session.warn('host-run session: handing its task back after a refused park failed', { sessionId: sid, error: errText(err) })
  }
}

/** A send (or a redelivery) of a session whose hand-over is unanswered: it waits, its kick kept for the release. */
function waitForHandOver(sid: string, o: DeliverOpts): void {
  const w = stateOf(sid)
  if (w.timer) { clearTimeout(w.timer); w.timer = null }
  if (o.kick) keepKick(sid, o)
  log.session.info('host-run session: its lines wait here until its host answers the hand-over', { sessionId: sid })
}

const confirming = new Set<string>()

/** How long before the host is asked again whether it owns a session it said it does not (tests shorten it). */
function disownConfirmMs(): number {
  const n = Number(process.env.WALNUT_HOST_DISOWN_CONFIRM_MS)
  return Number.isFinite(n) && n >= 0 ? n : 2_000
}

/**
 * `host` answered that it does not own `sid` (a send, an interrupt, a runner call), outside any
 * hand-over. Asked once more a moment later (askHostOwns); a second no takes the session back as
 * the leader's, at rest (host-handover.ts takeSessionBack). Every answer of that class comes here.
 * True: taken back.
 */
export async function confirmHostDisowns(sid: string, host: string): Promise<boolean> {
  if (!sid || confirming.has(sid) || handOverPending(sid) || judgingHostOf(sid) !== host) return false
  confirming.add(sid)
  try {
    await new Promise((r) => setTimeout(r, disownConfirmMs()))
    if (handOverPending(sid) || judgingHostOf(sid) !== host) return false
    if ((await askHostOwns(sid, host)) !== false) return false
    if (handOverPending(sid) || judgingHostOf(sid) !== host) return false
    log.session.warn('host-run session: its host does not hold it any more; it is the leader\'s again, and its next delivery hands it over again', { sessionId: sid, host })
    await takeSessionBack(sid, host)
    return true
  } finally {
    confirming.delete(sid)
  }
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
export function forgetWaitingLines(sid: string): Promise<void> {
  return settle(sid)
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
  if (!host) { void settle(sid); return }
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
