/**
 * Completing a task whose session its host runs and judges (session-tracker completeTaskSessions):
 * the leader writes nothing of that session's row and signals no process (R2-M3). Its host stops
 * it, whole, as a person's stop of it goes (host-judged-controls.ts terminateOnHost, `force`: a
 * completed task's session stops whatever crons it armed, as a session here does); its row comes
 * back through the channel. The session that completed its own task mid-turn stops when that turn
 * ends (self-complete-stop.ts waits on the facts here, then completes again, which lands here).
 *
 * A stop the host did not take (its link is down) waits here and goes when its channel links
 * again (leader-boot.ts onLinked). Kept in memory: a leader restart loses the wait (known limit,
 * design/C3b-design.md Amendments).
 */
import { log } from '../../logging/index.js'

/** Stops of completed tasks' host sessions that did not reach their host yet, by host. */
const waiting = new Map<string, Set<string>>()

export interface HostCompletionStop { sid: string; host: string }

/** Hand each stop to its host now; one the host did not take waits for its next link. */
export function stopHostRunForCompletion(stops: readonly HostCompletionStop[]): void {
  for (const s of stops) void stopOne(s)
}

async function stopOne({ sid, host }: HostCompletionStop): Promise<void> {
  try {
    const { terminateOnHost } = await import('./host-judged-controls.js')
    await terminateOnHost(sid, { force: true, by: 'task_completed' })
    waiting.get(host)?.delete(sid)
  } catch (err) {
    let set = waiting.get(host)
    if (!set) waiting.set(host, (set = new Set()))
    set.add(sid)
    log.session.warn('completing a task: its host did not take the stop of its session; it goes when the host links', {
      sessionId: sid, host, error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** The channel to `host` linked: the stops that waited for it go now. */
export function retryCompletionStopsFor(host: string): void {
  const set = waiting.get(host)
  if (!set || set.size === 0) return
  const sids = [...set]
  set.clear()
  stopHostRunForCompletion(sids.map((sid) => ({ sid, host })))
}

export function _completionStopsWaitingForTesting(host: string): string[] {
  return [...(waiting.get(host) ?? [])]
}

export function _resetHostJudgedCompleteForTesting(): void {
  waiting.clear()
}
