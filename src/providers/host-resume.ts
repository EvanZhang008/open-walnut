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
 *              place covers them all (tests/providers/host-resume-entry-ratchet.test.ts). An ACP
 *              engine's send drains without processNext, so its branch asks too, before it attaches
 *              (an attach starts a worker); the runner serializes both asks per session. A Restart
 *              without a message (reinitialize) stays legacy.
 *   at rest    notAtRestReason: a line waits, no live process the leader holds, no turn, restart,
 *              delivery or start in flight, no pending stop, no running transfer, no line out, and
 *              the host's runtime says no CLI of it runs (no answer is not at rest). The runner's
 *              own facts are read again right before the hand, with no await between. A live
 *              session is never handed over.
 *   ACP        an ACP engine's session (Codex and the rest) is handed the same way to a host whose
 *              service names SESSION_RESUME_ACP_CAP (else 'acp_engine': legacy). Nothing moves: its
 *              worker, its journal and the engine's own thread are on the host already, in the daemon
 *              the host's service runs; the host attaches it from the same row and lazy-resumes it
 *              by its provider session id. Its runtime is asked for the worker by the row's runtime id
 *              (host-handover.ts cliOnHost), and the runner's object of it counts live while it holds
 *              anything (a worker, a turn, a prompt, an attach).
 *   claim      a start's hand-over (host-handover.ts): a mark on disk, in flight, the leader's row
 *              marked the host's, the born row ends it, the lost check when no answer comes. The
 *              host claims the row (session-db.ts claimStartingRow).
 *   lines      the waiting lines go with the resume by their row ids (the host queues each once,
 *              ever) and leave this queue only once the host said yes: a leader that stops in
 *              between still holds them. Delivered once: taken by the host, or delivered here.
 *   failed     refused, or never sent: this delivery goes on as legacy (once: the session is held
 *              legacy for a while, so the same delivery never asks again).
 *   no answer  the window stays open (sends wait, host-judged-send.ts) until the host's row says it
 *              took the resume (what waited goes to it once) or the lost check decides; that check
 *              asks the host (host-handover.ts hostVerdict) and resumes here only when the host says
 *              it does not own the session and its runtime runs no CLI of it, else it waits on and
 *              says so in Walnut Health. Never both. A leader restart in the window arms the check
 *              again (rearmHandOversAtBoot).
 *
 * With the switch off for every host resumeHostOf answers null without a row read, and the
 * delivery runs exactly as before; off for the row's host, null with no line. On for it, the
 * decision logs one line whichever way it goes: resumeHostOf when the host is not asked
 * (NoResumeHost), else resumeAtRestOnHost (stays legacy and why, or handed).
 */
import { log } from '../logging/index.js'
import { sessionJudgeInStore, sessionTaskAndEngineInStore } from '../core/session-db.js'
import { judgingHostOf } from '../core/sessions/judge-of.js'
import type { QueuedMessage } from '../core/session-queue-store.js'
import type { SessionRecord } from '../core/types.js'
import type { StartBody } from '../core/session-channel/host-api.js'
import { isAcpEngine } from '../core/agents/engine-registry.js'
import { claimHostStarted, unclaimHostStarted } from '../core/session-channel/leader-tasks.js'
import { anyHostSwitchOn, hostResumesSessions, hostSwitchOnFor } from '../core/session-channel/resume-hosts.js'
import { isHandedHold } from '../core/sessions/handed-holds.js'
import { startGoesToHost } from './host-judged-runner.js'
import { armLostStartCheck, cliOnHost, handOverAnswered, handOverPending, handStartToHost, hostVerdict, rearmHandOvers, startLostHooks, takeStartBack, type LostHooks } from './host-handover.js'
import { queuedLineOf } from './host-judged-send.js'

/** Why a legacy session is not handed to its host now (each keeps today's legacy delivery). */
export type NotAtRest =
  | 'no_row' | 'host_judged' | 'acp_engine' | 'host_takes_no_resume' | 'sdk_session' | 'live_process'
  | 'turn_in_flight' | 'restart_in_flight' | 'delivery_preparing' | 'start_in_flight' | 'stop_pending'
  | 'transfer_running' | 'line_out' | 'nothing_waiting' | 'cli_alive' | 'cli_unknown'

/** What the runner knows of a session now (sync: read again right before the hand). */
interface RunnerFacts {
  sdk: boolean
  wrapperLive: boolean
  turnInFlight: boolean
  restartInFlight: boolean
  preparing: boolean
}

/** What the at-rest decision reads of one session. `cli` undefined: the runtime was not asked yet. */
export interface RestFacts extends RunnerFacts {
  row: Pick<SessionRecord, 'engine' | 'status_reason' | 'pid' | 'stopRequest' | 'judge' | 'host'> | null
  hostResumes: boolean
  /** The host's service also resumes an ACP engine's session (SESSION_RESUME_ACP_CAP). */
  hostResumesAcp?: boolean
  transferRunning: boolean
  /** A queued line of it is out (status 'processing'): a delivery holds it, or a dead CLI may. */
  lineOut: boolean
  /** A line waits to go (a pending row, a handed hold): with none, nothing is handed over. */
  linesWaiting: boolean
  /** The host's runtime: its CLI runs (true), does not (false), or no answer (null). */
  cli?: boolean | null
}

/** The first reason `f` is not at rest, or null when nothing of it runs anywhere. */
export function notAtRestReason(f: RestFacts): NotAtRest | null {
  if (!f.row) return 'no_row'
  if (f.row.judge === 'host') return 'host_judged'
  if (isAcpEngine(f.row.engine ?? undefined) && f.hostResumesAcp !== true) return 'acp_engine'
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
  if (!f.linesWaiting) return 'nothing_waiting'
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
  /** The host runs it now: the runner's own (dead) objects of it go, so lookups answer the host's. */
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
 * Why a delivery to a legacy session whose host has the switch on does not ask that host at all:
 *   held_legacy           a hand-over of it failed a short while ago (holdLegacy)
 *   host_takes_no_resume  the host's running service does not name SESSION_RESUME_CAP (an older build)
 *   host_not_judging      the host's service is not linked, or does not name SESSION_JUDGE_CAP
 *   host_takes_no_acp_resume  an ACP send's ask: the host's service does not name SESSION_RESUME_ACP_CAP
 */
export type NoResumeHost = 'held_legacy' | 'host_takes_no_resume' | 'host_not_judging' | 'host_takes_no_acp_resume'

function noResumeHostReason(sid: string, host: string): NoResumeHost | null {
  const until = heldLegacy.get(sid)
  if (until !== undefined) {
    if (until > Date.now()) return 'held_legacy'
    heldLegacy.delete(sid)
  }
  if (!hostResumesSessions(host)) return 'host_takes_no_resume'
  if (!startGoesToHost(host)) return 'host_not_judging'
  return null
}

/**
 * The host a delivery to the legacy session `sid` may hand it to, or null. Sync, so a delivery that
 * stays legacy waits on nothing; while the switch is off for every host it reads no row either.
 */
export function resumeHostOf(sid: string): string | null {
  if (!sid || !anyHostSwitchOn()) return null
  let row: ReturnType<typeof sessionJudgeInStore>
  try { row = sessionJudgeInStore(sid) } catch { return null }
  // Not a legacy session of a host (a host-judged one goes to its host by its own route), or the switch off for it: quiet.
  if (!row || row.judgedByHost || !row.host || row.host === '__local__' || !hostSwitchOnFor(row.host)) return null
  const why = noResumeHostReason(sid, row.host)
  if (why) {
    log.session.info('host resume: the session stays legacy, its host is not asked', { sessionId: sid, host: row.host, why })
    return null
  }
  return row.host
}

/**
 * resumeHostOf for an ACP engine's send, which its runner branch asks before it attaches the session
 * (an attach starts a worker): null, quiet, for any other row (processNext asks for those). With the
 * switch off for every host it reads no row.
 */
export function acpResumeHostOf(sid: string): string | null {
  if (!sid || !anyHostSwitchOn()) return null
  let row: ReturnType<typeof sessionTaskAndEngineInStore>
  try { row = sessionTaskAndEngineInStore(sid) } catch { return null }
  if (!isAcpEngine((row?.engine ?? undefined) as SessionRecord['engine'])) return null
  const host = resumeHostOf(sid)
  if (host && !hostResumesSessions(host, 'acp')) {
    log.session.info('host resume: the session stays legacy, its host is not asked', { sessionId: sid, host, why: 'host_takes_no_acp_resume' })
    return null
  }
  return host
}

function runnerFacts(sid: string, r: RunnerRest): RunnerFacts {
  return { sdk: r.sdk(sid), wrapperLive: r.wrapperLive(sid), turnInFlight: r.turnInFlight(sid), restartInFlight: r.restartInFlight(sid), preparing: r.preparing(sid) }
}

async function restFacts(sid: string, r: RunnerRest): Promise<{ facts: RestFacts; row: SessionRecord | null; transferRunning: () => boolean }> {
  const [{ getSessionByClaudeId }, { getQueue }, { runningTransferFor }] = await Promise.all([
    import('../core/session-tracker.js'), import('../core/session-message-queue.js'), import('../core/transfer/transfer-jobs.js'),
  ])
  const row = await getSessionByClaudeId(sid)
  const queue: QueuedMessage[] = row ? await getQueue(sid) : []
  const transferRunning = () => !!row?.taskId && !!runningTransferFor(row.taskId)
  return {
    row,
    transferRunning,
    facts: {
      row,
      hostResumes: !!row?.host && hostResumesSessions(row.host),
      hostResumesAcp: !!row?.host && hostResumesSessions(row.host, 'acp'),
      ...runnerFacts(sid, r),
      transferRunning: transferRunning(),
      lineOut: queue.some((m) => m.status === 'processing'),
      linesWaiting: queue.some((m) => m.status === 'pending' || isHandedHold(m)),
    },
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * What a lost check does with a resume (host-handover.ts): the host's row in time, or the host saying
 * it holds the session, it is the host's; else it resumes here only when the host says it does not
 * own it and its runtime runs no CLI of it (hostVerdict).
 */
function resumeHooks(sid: string, host: string, r: RunnerRest): LostHooks {
  return {
    onBorn: () => r.dropDeadWrapper(sid),
    verdict: () => hostVerdict(sid, host),
    onLost: async () => {
      holdLegacy(sid)
      unclaimHostStarted(sid)
      log.session.warn('host resume: the host never took a resume whose answer was lost; delivered here as legacy', { sessionId: sid, host })
      r.deliverHere(sid)
    },
  }
}

/** The ask of each session that runs now: the next one waits for it. */
const asking = new Map<string, Promise<boolean>>()

/**
 * Hand the legacy session `sid`, at rest, to `host` as a resume. True: the host has it (or may: an
 * answer that was lost), so this delivery is done here. False: deliver it as legacy now.
 *
 * One ask per session at a time (a processNext and an ACP send's branch may ask at once): one that
 * waited finds the session handed by the one before it (its host judges it, or the hand-over waits
 * for the host's word), and that is a true too: what it would deliver is the hand-over's.
 */
export function resumeAtRestOnHost(sid: string, host: string, r: RunnerRest): Promise<boolean> {
  const run = (asking.get(sid) ?? Promise.resolve(false)).catch(() => false)
    .then(() => (judgingHostOf(sid) !== null || handOverPending(sid) ? true : resumeNow(sid, host, r)))
  asking.set(sid, run)
  void run.catch(() => false).then(() => { if (asking.get(sid) === run) asking.delete(sid) })
  return run
}

async function resumeNow(sid: string, host: string, r: RunnerRest): Promise<boolean> {
  const { facts, row, transferRunning } = await restFacts(sid, r)
  let why = notAtRestReason(facts)
  if (!why) why = notAtRestReason({ ...facts, cli: await cliOnHost(host, sid) })
  if (!why) await r.unparkWaiting(sid).catch(() => {})
  // After every await above, and with none from here to the hand: a Restart or a transfer begun meanwhile keeps it legacy.
  if (!why) why = notAtRestReason({ ...facts, ...runnerFacts(sid, r), transferRunning: transferRunning(), cli: false })
  if (why || !row) {
    log.session.info('host resume: the session stays legacy, it is not at rest', { sessionId: sid, host, why, ...(why === 'live_process' ? r.wrapperState?.(sid) : {}) })
    return false
  }
  // A resume is no new session: the born row of it says no session:started here.
  claimHostStarted(sid)
  const handed = await handStartToHost(sid, host, 'resume')
  const back = async (): Promise<false> => {
    await takeStartBack(sid, host, handed)
    unclaimHostStarted(sid)
    holdLegacy(sid)
    return false
  }
  if (!handed) {
    // The row changed meanwhile (another host's, a host's already): nothing went out.
    log.session.info('host resume: the session stays legacy, its row could not be marked its host\'s', { sessionId: sid, host })
    return back()
  }
  const [{ peekLinesForHost, takeLinesForHost }, { getSessionByClaudeId }, { activeLeaderSide }, { requestNotSent }] = await Promise.all([
    import('../core/session-message-queue.js'), import('../core/session-tracker.js'),
    import('../core/session-channel/leader-boot.js'), import('../core/session-channel/leader-side.js'),
  ])
  const lines = await peekLinesForHost(sid)
  const marked = (await getSessionByClaudeId(sid).catch(() => null)) ?? row
  const body: StartBody = {
    // The send's own source frames its lines and stamps a person's input on the host, as a send to a
    // host-judged session does (host-judged-send.ts); a delivery no send asked for is Walnut's.
    taskId: marked.taskId ?? '', message: '', busSource: r.sendSource ?? 'host-resume',
    resumeSessionId: sid, resumeRow: marked, queued: lines.map(queuedLineOf),
  }
  const fallBack = async (what: string, err: string): Promise<false> => {
    log.session.warn(`host resume: ${what}; delivered here as legacy`, { sessionId: sid, host, error: err })
    return back()
  }
  const side = activeLeaderSide()
  if (!side) return fallBack('this leader has no link to its hosts', 'no leader side')
  log.session.info('session routing', { taskId: marked.taskId, type: 'host-resume', host, sessionId: sid, lines: lines.length })
  let a: Awaited<ReturnType<typeof side.startOnHost>>
  try {
    a = await side.startOnHost(host, body)
  } catch (err) {
    if (requestNotSent(err)) return fallBack('the host did not get the resume', errText(err))
    // No answer: the host may have it. Its lines wait here, unsent, until the host's row ends the
    // window (they go to it again, once there by their ids) or the lost check decides.
    armLostStartCheck(sid, host, true, errText(err), resumeHooks(sid, host, r))
    log.session.warn('host resume: no answer from the host; the session waits for its word', { sessionId: sid, host, error: errText(err) })
    return true
  }
  if (a.ok !== true) return fallBack('the host refused the resume', `${a.error ?? 'no reason given'}${a.why ? ` (${String(a.why)})` : ''}`)
  // The host queued them: they leave this queue now.
  if (lines.length > 0) await takeLinesForHost(sid, { ids: lines.map((m) => m.id) }).then((t) => t.done()).catch(() => {})
  r.dropDeadWrapper(sid)
  handOverAnswered(sid)
  log.session.info('host resume: the host resumes the session; it is host-judged from now on', { sessionId: sid, host, lines: lines.length })
  return true
}

/**
 * Boot (leader-boot.ts): the hand-overs this leader had no answer to when it stopped wait for their
 * host again, each with the hooks of its kind (a start fails as one that never ran, a resume as above).
 */
export async function rearmHandOversAtBoot(runner?: BootRunner): Promise<number> {
  const r = runner ?? (await import('./claude-code-session.js')).sessionRunner
  const { activeLeaderSide } = await import('../core/session-channel/leader-boot.js')
  return rearmHandOvers((m) => {
    if (m.kind === 'start') return startLostHooks(m.sid, m.host, (err) => r.failLostHostStart(m.sid, err))
    claimHostStarted(m.sid)
    return resumeHooks(m.sid, m.host, r.resumeView())
  }, (host) => { const side = activeLeaderSide(); return typeof side?.linked === 'function' && side.linked(host) })
}

/** The runner a boot arms the hand-overs with (claude-code-session.ts SessionRunner). */
export interface BootRunner {
  resumeView(): RunnerRest
  failLostHostStart(sid: string, err: unknown): Promise<void>
}

export function _resetHostResumeForTesting(): void {
  heldLegacy.clear()
  asking.clear()
}

/** Tests: a hand-over of `sid` just failed (it is held legacy for a while). */
export function _holdLegacyForTesting(sid: string): void {
  holdLegacy(sid)
}
