/**
 * Completing a task whose session its host runs and judges (session-tracker completeTaskSessions).
 * The leader writes nothing of that session's row and signals no process (R2-M3): it asks the host.
 *
 * The asks (HostCompletionAsk `when`):
 *   now       the completion was decided now by someone else than the session (the board, a bulk
 *             write, a forced delete): the host stops it whole, as a person's stop goes.
 *   turn_end  the session completed its own task mid-turn, or a pass that did not just decide the
 *             completion (the boot pass, a later write to the complete task) found it still live:
 *             it stops when its turn ends, never mid-turn.
 *   cancel    the task was reopened: a stop the host still waits to make is dropped.
 *
 * A host naming SESSION_COMPLETE_STOP_CAP takes the ask itself (takeCompletionStop, the host half
 * below, a `lifecycle` call): a `turn_end` ask is kept on the host's own row (`taskCompleteStop`
 * 'turn_end', which comes back to the leader as a host field) and watched by the host's own
 * turn-end wait (self-complete-stop.ts), so a restart of either side keeps it. A later pass that
 * did not just decide the completion asks nothing of a row whose copy shows that marker; a new
 * decision asks again, and the host takes the same ask once (2026-11-24: the leader's wait was in
 * memory only, and the boot pass after a leader restart handed the host a force stop mid-turn).
 *
 * The last turn's summary: the hooks that summarize a turn into the task note run here, on the
 * leader, and ask the live CLI for its self-report. A session whose host waits to stop it is
 * summarized at once when its turn ends (hostAwaitsCompletionStop, read by the summary hook in
 * session-hooks/builtins.ts), and the host is told when that summary is done
 * (completionSummaryDone); the host stops the CLI only then, or after HOST_SUMMARY_WAIT_MS when no
 * word comes (this leader away).
 *
 * A host that does not name it (an older Walnut, or one that went back to one) keeps the old way:
 * a `turn_end` ask is the leader's own wait for the turn's end (stopWhenTurnEnds, in memory), then
 * the stop is handed over (terminateOnHost); a marker such a host left on its row is not read. An
 * ask made before the host's report says which, and one its host did not take (its link is down),
 * waits here and goes when the host reports or links again (leader-boot.ts); a leader restart
 * forgets it, and the boot pass asks again (`turn_end`).
 */
import { log } from '../../logging/index.js'
import type { SessionRecord, Task } from '../types.js'
import { judgedByHost, rowOwnedHere, thisHostKey } from './session-row-owner.js'

export interface HostCompletionAsk {
  /** Leader time of the decision (the turn-end wait's deadline counts from it). */
  at: string
  when: 'now' | 'turn_end' | 'cancel'
  /** The task's reopen count when it was decided (absent: not known); a host whose task copy counts more drops the stop. */
  reopens?: number
}

export interface HostCompletionStop { sid: string; host: string; when: HostCompletionAsk['when'] }

/** What a host's last report says of it: takes the ask itself, an older Walnut, or not known yet. */
export type HostCompleteStopState = 'takes' | 'old' | 'down'

const hostState = new Map<string, HostCompleteStopState>()
/** Asks that did not reach their host yet, by host, then session (park says which one wins). */
const waiting = new Map<string, Map<string, HostCompletionStop>>()
/** Asks on their way to a host now: a later pass does not ask again meanwhile. */
const inFlight = new Set<string>()
/** Sessions a host took a `turn_end` ask of from this leader: their last turn is summarized at once. */
const turnEndAsked = new Set<string>()

/** A host's report named (or did not name) SESSION_COMPLETE_STOP_CAP (session-channel/leader-boot.ts). */
export function noteHostCompleteStop(host: string, state: HostCompleteStopState): void {
  const was = hostState.get(host)
  hostState.set(host, state)
  if (state !== 'down' && was !== state) retryCompletionStopsFor(host)
}

export function hostCompleteStopState(host: string): HostCompleteStopState {
  return hostState.get(host) ?? 'down'
}

/** An ask for `sid` is on its way or waits for its host: a later pass leaves it be. */
export function completionAskPending(sid: string): boolean {
  if (inFlight.has(sid)) return true
  for (const m of waiting.values()) if (m.has(sid)) return true
  return false
}

/** Hand each ask to its host now; one the host did not take waits for its next report or link. */
export function stopHostRunForCompletion(stops: readonly HostCompletionStop[]): void {
  for (const s of stops) void askOne(s)
}

/** The newer decision wins, except that a `now` never undoes a `turn_end` (as on the host). */
function park(s: HostCompletionStop): void {
  let m = waiting.get(s.host)
  if (!m) waiting.set(s.host, (m = new Map()))
  const prev = m.get(s.sid)
  m.set(s.sid, prev?.when === 'turn_end' && s.when === 'now' ? prev : s)
}

async function askOne(s: HostCompletionStop): Promise<void> {
  const state = hostCompleteStopState(s.host)
  if (state === 'down') { park(s); return }
  if (inFlight.has(s.sid)) { if (s.when === 'cancel') park(s); return }
  inFlight.add(s.sid)
  try {
    if (state === 'old') {
      if (s.when === 'cancel') {
        // The leader's own wait asks the task again before it acts (self-complete-stop.ts asked).
      } else if (s.when === 'turn_end') {
        // Its host stops only what it is handed: this leader waits for the turn's end itself.
        const { stopWhenTurnEnds } = await import('./self-complete-stop.js')
        stopWhenTurnEnds(s.sid)
      } else {
        const { terminateOnHost } = await import('./host-judged-controls.js')
        await terminateOnHost(s.sid, { force: true, by: 'task_completed' })
      }
    } else {
      const { onJudgingHost } = await import('./host-judged-controls.js')
      const ask: HostCompletionAsk = { at: new Date().toISOString(), when: s.when, ...await reopensOf(s.sid) }
      const answer = await onJudgingHost(s.sid, 'takeCompletionStop', [ask]) as HostCompletionAnswer
      if (s.when === 'turn_end' && answer?.state === 'turn_end') rememberTurnEndAsk(s.sid)
      log.session.info('completing a task: its host took the stop of its session', { sessionId: s.sid, host: s.host, when: s.when, state: answer?.state })
    }
    waiting.get(s.host)?.delete(s.sid)
  } catch (err) {
    park(s)
    log.session.warn('completing a task: its host did not take the stop of its session; it goes when the host links', {
      sessionId: s.sid, host: s.host, when: s.when, error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    inFlight.delete(s.sid)
  }
}

function rememberTurnEndAsk(sid: string): void {
  if (turnEndAsked.size > 1_000) turnEndAsked.clear()
  turnEndAsked.add(sid)
}

/** The task's reopen count now; not known (a read that failed) is left out, and the host then never vetoes on it. */
async function reopensOf(sid: string): Promise<{ reopens?: number }> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const { listTasksByIds } = await import('../task-manager.js')
    const taskId = (await getSessionByClaudeId(sid))?.taskId
    const task = taskId ? (await listTasksByIds([taskId]))[0] : undefined
    // A task never reopened counts none.
    return task ? { reopens: typeof task.reopens === 'number' ? task.reopens : 0 } : {}
  } catch {
    return {}
  }
}

/** The channel to `host` linked, or its report said which way it stops: the asks that waited for it go now. */
export function retryCompletionStopsFor(host: string): void {
  const m = waiting.get(host)
  if (!m || m.size === 0) return
  const stops = [...m.values()]
  m.clear()
  stopHostRunForCompletion(stops)
}

/** Is `rec` a row its host judges (not this server's own)? */
function hostsRow(rec: SessionRecord | null | undefined): rec is SessionRecord {
  return !!rec && judgedByHost(rec) && !rowOwnedHere(rec, thisHostKey())
}

/**
 * The task was reopened (task-manager.ts emitPhaseChanged, leaving COMPLETE): each of its sessions
 * whose host takes the stop itself is told to drop a stop it still waits to make. Not only the
 * host's task copy, which can lag or never hold the task.
 */
export async function cancelHostCompletionStops(task: Pick<Task, 'session_ids'> & { session_id?: string | null }): Promise<void> {
  const sids = [...new Set([...(task.session_ids ?? []), ...(task.session_id ? [task.session_id] : [])])]
  if (sids.length === 0) return
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  for (const sid of sids) {
    const rec = await getSessionByClaudeId(sid).catch(() => null)
    if (!hostsRow(rec) || hostCompleteStopState(rec.host!) === 'old') continue
    if (rec.taskCompleteStop?.state !== 'turn_end' && !turnEndAsked.has(sid) && !completionAskPending(sid)) continue
    turnEndAsked.delete(sid)
    void askOne({ sid, host: rec.host!, when: 'cancel' })
  }
}

/**
 * The summary hook's question (session-hooks/builtins.ts): does the host of this session wait to
 * stop it when its turn ends? Then the turn that just ended is its last, summarized at once.
 */
export async function hostAwaitsCompletionStop(sid: string): Promise<boolean> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const rec = await getSessionByClaudeId(sid).catch(() => null)
  if (!hostsRow(rec) || hostCompleteStopState(rec.host!) !== 'takes') return false
  return rec.taskCompleteStop?.state === 'turn_end' || turnEndAsked.has(sid)
}

/** The summary of its last turn is in the task note (or failed): its host may stop it now. */
export async function tellHostSummaryDone(sid: string, gen: number | undefined): Promise<void> {
  try {
    const { onJudgingHost } = await import('./host-judged-controls.js')
    await onJudgingHost(sid, 'completionSummaryDone', [gen === undefined ? {} : { gen }])
  } catch (err) {
    // The host stops it after its own wait's limit.
    log.session.warn('completing a task: the host was not told its session\'s last summary is done', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------------------------
// The host half: `lifecycle` members (host-calls.ts, host-lifecycle.ts) run on the host for its
// own rows.

export type HostCompletionAnswer = { state: 'stopped' | 'turn_end' | 'cancelled' | 'not_own' }

/** How long a host waits for its leader's word that the last turn's summary is done (the summary's own limits, 10 s + 3 min). */
export const HOST_SUMMARY_WAIT_MS = 190_000
let hostSummaryWaitMs = HOST_SUMMARY_WAIT_MS
/** At most this many stops are tried for one session; then its marker stays for the next start of this service. */
const STOP_TRIES_MAX = 5

/** The leader's word per session: the turn generation it summarized, and when it came (this host's clock). */
const summaryDone = new Map<string, { gen?: number; at: number }>()
/** A waiting stop per session: `true` its word came, `false` it was dropped (a reopen). */
const summaryWaiters = new Map<string, (heard: boolean) => void>()
/** When this host took the `turn_end` ask (its clock): a word before it is of an earlier completion. */
const takenAt = new Map<string, number>()
const stopTries = new Map<string, number>()
/** Sessions whose failed stop is to be tried again after a poll. */
const retryArmed = new Map<string, ReturnType<typeof setTimeout>>()

/** Is this one of this host's own rows (the host runs and judges it here)? */
export async function ownRowHere(rec: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): Promise<boolean> {
  return rowOwnedHere(rec, thisHostKey())
}

/**
 * On the host: the leader says the session's task is complete. `now` stops it at once; `turn_end`
 * keeps the stop on this host's own row and stops it when its turn ends (self-complete-stop.ts
 * watches it here, and again after this host restarts); `cancel` drops a stop still waiting.
 * Taking the same ask twice stops it once.
 */
export async function takeCompletionStop(sid: string, ask: HostCompletionAsk): Promise<HostCompletionAnswer> {
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
  const rec = await getSessionByClaudeId(sid)
  if (!rec || !await ownRowHere(rec)) return { state: 'not_own' }
  const self = await import('./self-complete-stop.js')
  if (ask?.when === 'cancel') {
    self.cancelStopAtTurnEnd(sid)
    forgetHostCompletion(sid)
    const { clearTaskCompleteStop } = await import('./task-complete-stop.js')
    await clearTaskCompleteStop(sid, 'turn_end')
    log.session.info('task complete stop: its task was reopened; this host keeps its session', { sessionId: sid })
    return { state: 'cancelled' }
  }
  if ((rec.process_status === 'stopped' || rec.process_status === 'error') && rec.pid == null) return { state: 'stopped' }
  const marked = rec.taskCompleteStop?.state === 'turn_end'
  // A session already waiting for its turn's end keeps waiting (as on the leader: a later
  // completion of its task does not cut the turn it completed it in).
  if (ask?.when === 'now' && !marked && !self.isAwaitingTurnEnd(sid)) {
    await stopOwnCompleted(sid)
    return { state: 'stopped' }
  }
  const at = typeof ask?.at === 'string' && Number.isFinite(Date.parse(ask.at)) ? ask.at : new Date().toISOString()
  if (!marked) {
    await updateSessionRecord(sid, {
      taskCompleteStop: { at, state: 'turn_end', actor: true, ...(typeof ask?.reopens === 'number' ? { reopens: ask.reopens } : {}) },
    })
    takenAt.set(sid, Date.now())
  }
  const since = Date.parse(marked ? rec.taskCompleteStop!.at : at)
  self.stopWhenTurnEnds(sid, Number.isFinite(since) ? since : Date.now())
  log.session.info('task complete stop: kept on this host\'s row, stopped when its turn ends', { sessionId: sid, at })
  return { state: 'turn_end' }
}

/** On the host: the leader summarized the session's last turn into its task note (`gen`: the turn generation it read). */
export async function completionSummaryDone(sid: string, word: { gen?: unknown }): Promise<{ ok: true }> {
  const gen = typeof word?.gen === 'number' ? word.gen : undefined
  summaryDone.set(sid, { ...(gen !== undefined ? { gen } : {}), at: Date.now() })
  if (summaryDone.size > 1_000) summaryDone.delete(summaryDone.keys().next().value!)
  summaryWaiters.get(sid)?.(true)
  return { ok: true }
}

async function liveTurnGenHere(sid: string): Promise<number | undefined> {
  try {
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    return sessionRunner.findSessionByClaudeId(sid)?.turnGen
  } catch { return undefined }
}

/** The leader's word is for the turn that just ended: its generation when both know it, else a word since the ask. */
async function summaryCovers(sid: string): Promise<boolean> {
  const word = summaryDone.get(sid)
  if (!word) return false
  const gen = await liveTurnGenHere(sid)
  if (word.gen !== undefined && gen !== undefined) return word.gen === gen
  return word.at >= (takenAt.get(sid) ?? 0)
}

/** On the host, before its stop: wait for the leader's word that the last turn is in the note, at most hostSummaryWaitMs. */
export async function awaitLeaderSummary(sid: string): Promise<'done' | 'timeout'> {
  if (await summaryCovers(sid)) return 'done'
  if (hostSummaryWaitMs <= 0) return 'timeout'
  const heard = await new Promise<'word' | 'dropped' | 'limit'>((resolve) => {
    const timer = setTimeout(() => { summaryWaiters.delete(sid); resolve('limit') }, hostSummaryWaitMs)
    timer.unref?.()
    summaryWaiters.set(sid, (word) => { clearTimeout(timer); summaryWaiters.delete(sid); resolve(word ? 'word' : 'dropped') })
  })
  if (heard === 'word') return await summaryCovers(sid) ? 'done' : awaitLeaderSummary(sid)
  if (heard === 'limit') log.session.warn('task complete stop: no word of the last turn\'s summary from the leader; stopping anyway', { sessionId: sid })
  return 'timeout'
}

/**
 * On the host: the turn-end wait of one of its own rows is still wanted. The leader decided the
 * completion (the marker says so) and tells a reopen (`cancel`); the task copy here only vetoes
 * it when it shows the task reopened since. A copy that lags, a task kept off this host, or a
 * reopen count the leader did not know leaves the marker's word.
 */
export async function hostCompletionStillWanted(rec: SessionRecord): Promise<boolean> {
  const marker = rec.taskCompleteStop
  if (marker?.state !== 'turn_end') return false
  if (!rec.taskId || typeof marker.reopens !== 'number') return true
  try {
    const { listTasksByIds } = await import('../task-manager.js')
    const task = (await listTasksByIds([rec.taskId]))[0]
    if (task && task.phase !== 'COMPLETE' && (task.reopens ?? 0) > marker.reopens) return false
  } catch { /* no copy readable: the marker's word */ }
  return true
}

function forgetHostCompletion(sid: string): void {
  summaryDone.delete(sid)
  summaryWaiters.get(sid)?.(false)
  takenAt.delete(sid)
  stopTries.delete(sid)
}

/** The stop of one of this host's own completed sessions, then its marker goes; a stop that failed keeps it and tries again, a few times. */
export async function stopOwnCompleted(sid: string): Promise<void> {
  const { clearTaskCompleteStop } = await import('./task-complete-stop.js')
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  try {
    // Gone, or stopped already (its stop landed before its marker went, then this host restarted): only the marker goes.
    const rec = await getSessionByClaudeId(sid)
    if (!rec || ((rec.process_status === 'stopped' || rec.process_status === 'error') && rec.pid == null)) {
      if (rec) await clearTaskCompleteStop(sid, 'turn_end')
      forgetHostCompletion(sid)
      return
    }
    const { terminateSession } = await import('./session-lifecycle.js')
    await terminateSession(sid, { force: true, by: 'task_completed' })
    await clearTaskCompleteStop(sid, 'turn_end')
    forgetHostCompletion(sid)
    log.session.info('task complete stop: this host stopped its completed session', { sessionId: sid })
  } catch (err) {
    const tries = (stopTries.get(sid) ?? 0) + 1
    stopTries.set(sid, tries)
    const notFound = (err as { status?: unknown })?.status === 404
    const last = notFound || tries >= STOP_TRIES_MAX
    log.session.warn(last
      ? 'task complete stop: this host could not stop its completed session and stops trying; its marker stays for this service\'s next start'
      : 'task complete stop: this host could not stop its completed session; it tries again', {
      sessionId: sid, tries, error: err instanceof Error ? err.message : String(err),
    })
    if (last) { stopTries.delete(sid); return }
    const { TURN_END_POLL_MS } = await import('./turn-end-wait.js')
    const t = setTimeout(() => {
      retryArmed.delete(sid)
      void (async () => {
        const rec = await getSessionByClaudeId(sid)
        if (rec?.taskCompleteStop?.state !== 'turn_end') return
        const { stopWhenTurnEnds } = await import('./self-complete-stop.js')
        stopWhenTurnEnds(sid, Date.parse(rec.taskCompleteStop.at) || Date.now())
      })().catch(() => {})
    }, TURN_END_POLL_MS)
    t.unref?.()
    retryArmed.set(sid, t)
  }
}

/** Test-only: the host's wait for the leader's summary word (no argument restores it). */
export function __setHostSummaryWaitMs(ms?: number): void {
  hostSummaryWaitMs = ms ?? HOST_SUMMARY_WAIT_MS
}

export function _stopRetriesArmedForTest(): string[] {
  return [...retryArmed.keys()]
}

export function _awaitingLeaderSummaryForTest(): string[] {
  return [...summaryWaiters.keys()]
}

export function _completionStopsWaitingForTesting(host: string): string[] {
  return [...(waiting.get(host)?.keys() ?? [])]
}

export function _resetHostJudgedCompleteForTesting(): void {
  waiting.clear()
  inFlight.clear()
  hostState.clear()
  turnEndAsked.clear()
  summaryDone.clear()
  for (const w of [...summaryWaiters.values()]) w(false)
  summaryWaiters.clear()
  takenAt.clear()
  stopTries.clear()
  for (const t of retryArmed.values()) clearTimeout(t)
  retryArmed.clear()
}
