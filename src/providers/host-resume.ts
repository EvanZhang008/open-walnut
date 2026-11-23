/**
 * A legacy session at rest, resumed by its host's own service (docs/plan/one-service-every-host.md,
 * phase 2): a delivery to a session this leader ran on a host (a row without `judge: 'host'`) whose
 * CLI runs nowhere now, on a host where a new start would go to the host's service
 * (host-judged-runner.ts startGoesToHost) and whose service takes a resume (switch.ts
 * SESSION_RESUME_CAP), is handed to that host. The host resumes the same CLI session id from the
 * same row (cwd, mode, engine, model) and the session is host-judged from then on.
 *
 *   where      every delivery of a queued line runs the runner's processNext (a send of any source,
 *              a redelivery, restart recovery, auto-continue, a retry): it asks here first, so one
 *              place covers them all. A Restart without a message (reinitialize) stays legacy.
 *   at rest    notAtRestReason: no live process the leader holds, no turn, restart, delivery or
 *              start in flight, no pending stop, no running transfer, no line out, and the host's
 *              runtime says no CLI of it runs (no answer is not at rest). A live session is never
 *              handed over. ACP engines (Codex and the rest) stay legacy: a resume of one needs its
 *              runtime and journal on the host, which this path does not move.
 *   claim      the same as a start's (host-judged-runner.ts handStartToHost): in flight, the
 *              leader's row marked the host's, the born row fills it in, and the lost-start rules
 *              when the answer does not come. The host claims the row (session-db.ts claimStartingRow).
 *   lines      the waiting lines go with the resume (by their row ids: the host queues each once,
 *              ever), so the message is delivered once: taken by the host, or back here.
 *   failed     refused, or never sent: the lines are back and this delivery goes on as legacy (once:
 *              the session is held legacy for a while, so the same delivery never asks again).
 *              No answer: the lines wait here, unsent, until the host's born row says it took them
 *              (they go to it again, a no-op there) or the lost-start time runs out without it (the
 *              row is the leader's again and the legacy resume runs once). Never both.
 *
 * With the switch off for the row's host, resumeHostOf answers null after one row lookup, and the
 * delivery runs exactly as before.
 */
import { log } from '../logging/index.js'
import { sessionJudgeInStore } from '../core/session-db.js'
import type { QueuedMessage } from '../core/session-queue-store.js'
import type { SessionRecord } from '../core/types.js'
import type { StartBody } from '../core/session-channel/host-api.js'
import { isAcpEngine } from '../core/agents/engine-registry.js'
import { claimHostStarted } from '../core/session-channel/leader-tasks.js'
import { armLostStartCheck, handStartToHost, startGoesToHost, takeStartBack } from './host-judged-runner.js'
import { forwardSend, queuedLineOf } from './host-judged-send.js'

/** Why a legacy session is not handed to its host now (each keeps today's legacy delivery). */
export type NotAtRest =
  | 'no_row' | 'host_judged' | 'acp_engine' | 'host_takes_no_resume' | 'sdk_session' | 'live_process'
  | 'turn_in_flight' | 'restart_in_flight' | 'delivery_preparing' | 'start_in_flight' | 'stop_pending'
  | 'transfer_running' | 'line_out' | 'cli_alive' | 'cli_unknown'

/** What the at-rest decision reads of one session. `cli` undefined: the runtime was not asked yet. */
export interface RestFacts {
  row: Pick<SessionRecord, 'engine' | 'status_reason' | 'pid' | 'stopRequest' | 'judge' | 'host'> | null
  hostResumes: boolean
  sdk: boolean
  wrapperLive: boolean
  turnInFlight: boolean
  restartInFlight: boolean
  preparing: boolean
  transferRunning: boolean
  /** A queued line of it is out (status 'processing'): a delivery holds it, or a dead CLI may. */
  lineOut: boolean
  /** The host's runtime: its CLI runs (true), does not (false), or no answer (null). */
  cli?: boolean | null
}

/** The first reason `f` is not at rest, or null when nothing of it runs anywhere. */
export function notAtRestReason(f: RestFacts): NotAtRest | null {
  if (!f.row) return 'no_row'
  if (f.row.judge === 'host') return 'host_judged'
  if (isAcpEngine(f.row.engine ?? undefined)) return 'acp_engine'
  if (!f.hostResumes) return 'host_takes_no_resume'
  if (f.sdk) return 'sdk_session'
  if (f.wrapperLive) return 'live_process'
  if (f.turnInFlight) return 'turn_in_flight'
  if (f.restartInFlight) return 'restart_in_flight'
  if (f.preparing) return 'delivery_preparing'
  if (f.row.status_reason === 'awaiting_spawn' || f.row.status_reason === 'spawn_outcome_unknown') return 'start_in_flight'
  if (f.row.stopRequest?.state === 'pending') return 'stop_pending'
  if (f.transferRunning) return 'transfer_running'
  if (f.lineOut) return 'line_out'
  if (f.cli === true) return 'cli_alive'
  if (f.cli === null) return 'cli_unknown'
  return null
}

/** What the runner knows of a session, and what it does around a resume (claude-code-session.ts). */
export interface RunnerRest {
  /** The bus source of the send this delivery is for (who sent it), when a send asked for it. */
  sendSource?: string
  sdk(sid: string): boolean
  wrapperLive(sid: string): boolean
  /** What the runner's object of it says (logged when it keeps the session legacy). */
  wrapperState?(sid: string): Record<string, unknown>
  turnInFlight(sid: string): boolean
  restartInFlight(sid: string): boolean
  preparing(sid: string): boolean
  /** Rows parked only until the agent could run go back in line first, as the legacy delivery does. */
  unparkWaiting(sid: string): Promise<unknown>
  /** The host runs it now: the runner's own (dead) object of it goes, so lookups answer the host's. */
  dropDeadWrapper(sid: string): void
  /** Deliver it here after all (a resume whose answer was lost and that the host never took). */
  deliverHere(sid: string): void
}

/** Sessions whose hand-over failed: delivered as legacy, and not asked about again for a while. */
const heldLegacy = new Map<string, number>()
const HOLD_LEGACY_MS = 10 * 60_000
const HOLD_LEGACY_MAX = 2_000

function holdLegacy(sid: string): void {
  if (heldLegacy.size >= HOLD_LEGACY_MAX) heldLegacy.delete(heldLegacy.keys().next().value!)
  heldLegacy.set(sid, Date.now() + HOLD_LEGACY_MS)
}

/**
 * The host a delivery to the legacy session `sid` may hand it to, or null. Sync, so a delivery that
 * stays legacy (every one while the switch is off) waits on nothing more than one row lookup.
 */
export function resumeHostOf(sid: string): string | null {
  if (!sid) return null
  const until = heldLegacy.get(sid)
  if (until !== undefined) {
    if (until > Date.now()) return null
    heldLegacy.delete(sid)
  }
  let row: ReturnType<typeof sessionJudgeInStore>
  try { row = sessionJudgeInStore(sid) } catch { return null }
  if (!row || row.judgedByHost || !row.host || row.host === '__local__') return null
  return startGoesToHost(row.host) ? row.host : null
}

async function restFacts(sid: string, r: RunnerRest): Promise<{ facts: RestFacts; row: SessionRecord | null }> {
  const [{ getSessionByClaudeId }, { getQueue }, { hostResumesSessions }, { runningTransferFor }] = await Promise.all([
    import('../core/session-tracker.js'), import('../core/session-message-queue.js'),
    import('../core/session-channel/leader-boot.js'), import('../core/transfer/transfer-jobs.js'),
  ])
  const row = await getSessionByClaudeId(sid)
  const queue: QueuedMessage[] = row ? await getQueue(sid) : []
  return {
    row,
    facts: {
      row,
      hostResumes: !!row?.host && hostResumesSessions(row.host),
      sdk: r.sdk(sid), wrapperLive: r.wrapperLive(sid), turnInFlight: r.turnInFlight(sid),
      restartInFlight: r.restartInFlight(sid), preparing: r.preparing(sid),
      transferRunning: !!row?.taskId && !!runningTransferFor(row.taskId),
      lineOut: queue.some((m) => m.status === 'processing'),
    },
  }
}

/** The host's runtime on the CLI of `sid`, through this leader's daemon link to it. */
async function cliOnHost(host: string, sid: string): Promise<boolean | null> {
  try {
    const { probeDaemonSession } = await import('./daemon-connection.js')
    const probe = await probeDaemonSession(host, sid)
    return probe ? probe.alive : null
  } catch {
    return null
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Hand the legacy session `sid`, at rest, to `host` as a resume. True: the host has it (or may: an
 * answer that was lost), so this delivery is done here. False: deliver it as legacy now.
 */
export async function resumeAtRestOnHost(sid: string, host: string, r: RunnerRest): Promise<boolean> {
  const { facts, row } = await restFacts(sid, r)
  let why = notAtRestReason(facts)
  if (!why) why = notAtRestReason({ ...facts, cli: await cliOnHost(host, sid) })
  if (why || !row) {
    log.session.info('host resume: the session stays legacy, it is not at rest', { sessionId: sid, host, why, ...(why === 'live_process' ? r.wrapperState?.(sid) : {}) })
    return false
  }
  await r.unparkWaiting(sid).catch(() => {})
  // A resume is no new session: the born row of it says no session:started here.
  claimHostStarted(sid)
  const handed = await handStartToHost(sid, host)
  if (!handed) {
    // The row changed meanwhile (another host's, a host's already): nothing went out.
    log.session.info('host resume: the session stays legacy, its row could not be marked its host\'s', { sessionId: sid, host })
    await takeStartBack(sid, host, false)
    holdLegacy(sid)
    return false
  }
  const [{ takeLinesForHost }, { getSessionByClaudeId }, { activeLeaderSide }, { requestNotSent }] = await Promise.all([
    import('../core/session-message-queue.js'), import('../core/session-tracker.js'),
    import('../core/session-channel/leader-boot.js'), import('../core/session-channel/leader-side.js'),
  ])
  const taken = await takeLinesForHost(sid)
  const marked = (await getSessionByClaudeId(sid).catch(() => null)) ?? row
  const body: StartBody = {
    // The send's own source frames its lines and stamps a person's input on the host, as a send to a
    // host-judged session does (host-judged-send.ts); a delivery no send asked for is Walnut's.
    taskId: marked.taskId ?? '', message: '', busSource: r.sendSource ?? 'host-resume',
    resumeSessionId: sid, resumeRow: marked, queued: taken.lines.map(queuedLineOf),
  }
  const fallBack = async (what: string, err: string): Promise<false> => {
    await taken.putBack()
    await takeStartBack(sid, host, true)
    holdLegacy(sid)
    log.session.warn(`host resume: ${what}; delivered here as legacy`, { sessionId: sid, host, error: err })
    return false
  }
  const side = activeLeaderSide()
  if (!side) return fallBack('this leader has no link to its hosts', 'no leader side')
  log.session.info('session routing', { taskId: marked.taskId, type: 'host-resume', host, sessionId: sid, lines: taken.lines.length })
  let a: Awaited<ReturnType<typeof side.startOnHost>>
  try {
    a = await side.startOnHost(host, body)
  } catch (err) {
    if (requestNotSent(err)) return fallBack('the host did not get the resume', errText(err))
    // No answer: the host may have it. Its lines wait here unsent; its born row sends them again
    // (once there by their ids), or the lost-start time ends it here (host-judged-runner.ts).
    await taken.putBack()
    armLostStartCheck(sid, host, true, errText(err), async () => {
      holdLegacy(sid)
      log.session.warn('host resume: the host never took a resume whose answer was lost; delivered here as legacy', { sessionId: sid, host })
      r.deliverHere(sid)
    }, () => {
      r.dropDeadWrapper(sid)
      void forwardSend(sid, host, { sessionId: sid, message: '' }, 'host-resume', false)
    })
    log.session.warn('host resume: no answer from the host; the session waits for its word', { sessionId: sid, host, error: errText(err) })
    return true
  }
  if (a.ok !== true) return fallBack('the host refused the resume', `${a.error ?? 'no reason given'}${a.why ? ` (${String(a.why)})` : ''}`)
  r.dropDeadWrapper(sid)
  log.session.info('host resume: the host resumes the session; it is host-judged from now on', { sessionId: sid, host, lines: taken.lines.length })
  return true
}

export function _resetHostResumeForTesting(): void {
  heldLegacy.clear()
}
