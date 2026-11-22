/**
 * The leader's side of a retry a host gave up on (sessions/held-error.ts): a `session:retry-over`
 * fact of a session its host runs raises the held error card (the server's, installed by
 * web/server.ts) and moves the phase edge the host's give-up made. Only for a session a host judges:
 * the leader's own retriers raise their own.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { judgingHostOf } from '../sessions/judge-of.js'
import { RETRY_OVER_SUBSCRIBER, type HeldErrorCard } from '../sessions/held-error.js'
import type { SessionRetryOverEvent } from '../event-types.js'
import type { SessionRecord } from '../types.js'

let card: HeldErrorCard | null = null

/** The server's error card (web/server.ts): installed with its own retriers. */
export function setRetryOverCard(fn: HeldErrorCard | null): void {
  card = fn
}

export async function onRetryOver(event: BusEvent): Promise<void> {
  const d = event.data as SessionRetryOverEvent | null
  const sid = d?.sessionId
  if (!sid || !judgingHostOf(sid)) return
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const rec: SessionRecord = (await getSessionByClaudeId(sid).catch(() => null)) ?? ({ claudeSessionId: sid, ...(d.taskId ? { taskId: d.taskId } : {}) } as SessionRecord)
  const taskId = d.taskId ?? rec.taskId
  if (d.card && typeof d.card.words === 'string' && card) {
    await card({ ...rec, ...(taskId ? { taskId } : {}) }, d.card.words).catch((err: unknown) => {
      log.session.warn('host-run session: the held error card was not raised', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
    })
  }
  if (d.phase && taskId && (d.phase.trigger === 'session:error' || d.phase.trigger === 'session:result')) {
    const { applySessionPhase } = await import('../phase.js')
    await applySessionPhase(taskId, d.phase.trigger, String(d.phase.why ?? 'host-retry-over'), { sessionId: sid, retryOver: true }).catch((err: unknown) => {
      log.session.warn('host-run session: the give-up\'s phase was not applied', { sessionId: sid, taskId, error: err instanceof Error ? err.message : String(err) })
    })
  }
}

export function startLeaderRetryOver(): () => void {
  bus.subscribe(RETRY_OVER_SUBSCRIBER, (e) => { if (e.name === EventNames.SESSION_RETRY_OVER) void onRetryOver(e) })
  return () => bus.unsubscribe(RETRY_OVER_SUBSCRIBER)
}
