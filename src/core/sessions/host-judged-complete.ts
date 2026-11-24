/**
 * Completing a task whose session its host runs and judges (session-tracker completeTaskSessions).
 * The leader writes nothing of that session's row and signals no process (R2-M3): it asks the host.
 *
 * Two asks (HostCompletionAsk `when`):
 *   now       the completion was decided now by someone else than the session (the board, a bulk
 *             write, a forced delete): the host stops it whole, as a person's stop goes.
 *   turn_end  the session completed its own task mid-turn, or a pass that did not just decide the
 *             completion (the boot pass, a later write to the complete task) found it still live:
 *             it stops when its turn ends, never mid-turn.
 *
 * A host naming SESSION_COMPLETE_STOP_CAP takes the ask itself (takeCompletionStop, the host half
 * below, a `lifecycle` call): a `turn_end` ask is kept on the host's own row (`taskCompleteStop`
 * 'turn_end', which comes back to the leader as a host field) and watched by the host's own
 * turn-end wait (self-complete-stop.ts), so a restart of either side keeps it. The leader then
 * asks nothing more of a row whose copy shows that marker: a later pass that does not see it yet
 * asks again, and the host takes the same ask once (2026-11-24: the leader's wait was in memory
 * only, and the boot pass after a leader restart handed the host a force stop mid-turn).
 *
 * A host that does not name it (an older Walnut) keeps the old way: a `turn_end` ask is the
 * leader's own wait for the turn's end (stopWhenTurnEnds, in memory), then the stop is handed
 * over (terminateOnHost). An ask made before the host's report says which, and one its host did
 * not take (its link is down), waits here and goes when the host reports or links again
 * (leader-boot.ts); a leader restart forgets it, and the boot pass asks again (`turn_end`).
 */
import { log } from '../../logging/index.js'
import type { SessionRecord } from '../types.js'

export interface HostCompletionAsk {
  /** Leader time of the decision (the turn-end wait's deadline counts from it). */
  at: string
  when: 'now' | 'turn_end'
  /** The task's reopen count when it was decided: a host whose task copy counts more drops the stop. */
  reopens?: number
}

export interface HostCompletionStop { sid: string; host: string; when: HostCompletionAsk['when'] }

/** What a host's last report says of it: takes the ask itself, an older Walnut, or not known yet. */
export type HostCompleteStopState = 'takes' | 'old' | 'down'

const hostState = new Map<string, HostCompleteStopState>()
/** Asks that did not reach their host yet, by host, then session: a `turn_end` one wins over `now`. */
const waiting = new Map<string, Map<string, HostCompletionStop>>()
/** Asks on their way to a host now: a later pass does not ask again meanwhile. */
const inFlight = new Set<string>()

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

function park(s: HostCompletionStop): void {
  let m = waiting.get(s.host)
  if (!m) waiting.set(s.host, (m = new Map()))
  const prev = m.get(s.sid)
  m.set(s.sid, prev?.when === 'turn_end' ? prev : s)
}

async function askOne(s: HostCompletionStop): Promise<void> {
  const state = hostCompleteStopState(s.host)
  if (state === 'down') { park(s); return }
  if (inFlight.has(s.sid)) return
  inFlight.add(s.sid)
  try {
    if (state === 'old') {
      if (s.when === 'turn_end') {
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

// ---------------------------------------------------------------------------------------------
// The host half: a `lifecycle` member (host-calls.ts, host-lifecycle.ts) run on the host for its
// own row.

export type HostCompletionAnswer = { state: 'stopped' | 'turn_end' | 'not_own' }

/** Is this one of this host's own rows (the host runs and judges it here)? */
export async function ownRowHere(rec: Pick<SessionRecord, 'judge' | 'host'> | null | undefined): Promise<boolean> {
  const { rowOwnedHere, thisHostKey } = await import('./session-row-owner.js')
  return rowOwnedHere(rec, thisHostKey())
}

/**
 * On the host: the leader says the session's task is complete. `now` stops it at once; `turn_end`
 * keeps the stop on this host's own row and stops it when its turn ends (self-complete-stop.ts
 * watches it here, and again after this host restarts). Taking the same ask twice stops it once.
 */
export async function takeCompletionStop(sid: string, ask: HostCompletionAsk): Promise<HostCompletionAnswer> {
  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js')
  const rec = await getSessionByClaudeId(sid)
  if (!rec || !await ownRowHere(rec)) return { state: 'not_own' }
  if ((rec.process_status === 'stopped' || rec.process_status === 'error') && rec.pid == null) return { state: 'stopped' }
  const { isAwaitingTurnEnd, stopWhenTurnEnds } = await import('./self-complete-stop.js')
  const marked = rec.taskCompleteStop?.state === 'turn_end'
  // A session already waiting for its turn's end keeps waiting (as on the leader: a later
  // completion of its task does not cut the turn it completed it in).
  if (ask?.when === 'now' && !marked && !isAwaitingTurnEnd(sid)) {
    await stopOwnCompleted(sid)
    return { state: 'stopped' }
  }
  const at = typeof ask?.at === 'string' && Number.isFinite(Date.parse(ask.at)) ? ask.at : new Date().toISOString()
  if (!marked) {
    await updateSessionRecord(sid, {
      taskCompleteStop: { at, state: 'turn_end', actor: true, ...(typeof ask?.reopens === 'number' ? { reopens: ask.reopens } : {}) },
    })
  }
  const since = Date.parse(marked ? rec.taskCompleteStop!.at : at)
  stopWhenTurnEnds(sid, Number.isFinite(since) ? since : Date.now())
  log.session.info('task complete stop: kept on this host\'s row, stopped when its turn ends', { sessionId: sid, at })
  return { state: 'turn_end' }
}

/**
 * On the host: the turn-end wait of one of its own rows is still wanted. The leader decided the
 * completion (the marker says so); the task copy here only vetoes it when it shows the task
 * reopened since (a copy that lags, or a task kept off this host, leaves the marker's word).
 */
export async function hostCompletionStillWanted(rec: SessionRecord): Promise<boolean> {
  const marker = rec.taskCompleteStop
  if (marker?.state !== 'turn_end') return false
  if (!rec.taskId) return true
  try {
    const { listTasksByIds } = await import('../task-manager.js')
    const task = (await listTasksByIds([rec.taskId]))[0]
    if (task && task.phase !== 'COMPLETE' && (task.reopens ?? 0) > (marker.reopens ?? 0)) return false
  } catch { /* no copy readable: the marker's word */ }
  return true
}

/** The stop of one of this host's own completed sessions, then its marker goes; a stop that failed keeps it and looks again. */
export async function stopOwnCompleted(sid: string): Promise<void> {
  const { clearTaskCompleteStop } = await import('./task-complete-stop.js')
  try {
    // Stopped already (its stop landed before its marker went, then this host restarted): only the marker goes.
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const rec = await getSessionByClaudeId(sid)
    if (rec && (rec.process_status === 'stopped' || rec.process_status === 'error') && rec.pid == null) {
      await clearTaskCompleteStop(sid, 'turn_end')
      return
    }
    const { terminateSession } = await import('./session-lifecycle.js')
    await terminateSession(sid, { force: true, by: 'task_completed' })
    await clearTaskCompleteStop(sid, 'turn_end')
    log.session.info('task complete stop: this host stopped its completed session', { sessionId: sid })
  } catch (err) {
    log.session.warn('task complete stop: this host could not stop its completed session; it tries again', {
      sessionId: sid, error: err instanceof Error ? err.message : String(err),
    })
    const { TURN_END_POLL_MS } = await import('./turn-end-wait.js')
    const t = setTimeout(() => {
      void (async () => {
        const { getSessionByClaudeId } = await import('../session-tracker.js')
        const rec = await getSessionByClaudeId(sid)
        if (!rec?.taskCompleteStop || rec.taskCompleteStop.state !== 'turn_end') return
        const { stopWhenTurnEnds } = await import('./self-complete-stop.js')
        stopWhenTurnEnds(sid, Date.parse(rec.taskCompleteStop.at) || Date.now())
      })().catch(() => {})
    }, TURN_END_POLL_MS)
    t.unref?.()
  }
}

export function _completionStopsWaitingForTesting(host: string): string[] {
  return [...(waiting.get(host)?.keys() ?? [])]
}

export function _resetHostJudgedCompleteForTesting(): void {
  waiting.clear()
  inFlight.clear()
  hostState.clear()
}
