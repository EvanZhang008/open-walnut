/**
 * A turn's error that Walnut held while it continued the turn itself (turn-run.ts: the context
 * recovery, the safeguard switch, the usage-limit and endpoint waits), raised once the retrier gives
 * up: the error card first, then, once any quiet turn is over, the phase edge the error would have
 * moved. One flow for both places a retrier runs:
 *
 *   the leader, its own sessions   the card is the server's (web/server.ts publishSessionErrorNotification),
 *                                  the phase applySessionPhase
 *   a host, the sessions it runs   both are the leader's: the card goes as a `session:retry-over` fact
 *                                  (sendRetryOver), and the phase edge's applySessionPhase, which the
 *                                  host's task copy cannot take, goes the same way from phase.ts's gate;
 *                                  the leader raises them (session-channel/leader-retry-over.ts)
 */
import { bus, EventNames } from '../event-bus.js'
import type { SessionRecord } from '../types.js'
import type { SessionRetryOverEvent } from '../event-types.js'
import { log } from '../../logging/index.js'

/** Raises the held error card of `rec` with the retrier's words. */
export type HeldErrorCard = (rec: SessionRecord, words: string) => Promise<void>

/** Who hears a host's retry-over fact on its leader (the leader's subscriber has this name). */
export const RETRY_OVER_SUBSCRIBER = 'host-retry-over'

/**
 * Raise the error card a retrier held, and move the task's phase as the error would have, while
 * `still()` says the session is still in the state the retrier gave up in.
 */
export async function raiseHeldError(rec: SessionRecord, words: string, why: string, still: () => Promise<boolean>, card: HeldErrorCard): Promise<void> {
  if (!(await still())) return
  await card(rec, words)
  // The session stays the task's. A compaction's quiet turn keeps a short grace after its result,
  // in which the phase ignores the session: wait it out.
  if (!rec.taskId) return
  const { isQuietTurn } = await import('./quiet-turn.js')
  for (let i = 0; i < 90 && isQuietTurn(rec.claudeSessionId); i++) await new Promise((r) => setTimeout(r, 1_000))
  if (!(await still())) return
  const { applySessionPhase } = await import('../phase.js')
  await applySessionPhase(rec.taskId, 'session:error', why, { sessionId: rec.claudeSessionId, retryOver: true })
    .catch((err) => log.web.warn('held session error: phase not applied', { taskId: rec.taskId, why, error: String(err) }))
}

/** A host's part of a retry that is over, for its leader (a fact of the session's channel). */
export function sendRetryOver(sessionId: string, taskId: string | undefined, part: Omit<SessionRetryOverEvent, 'sessionId' | 'taskId'>): void {
  const data: SessionRetryOverEvent = { sessionId, ...(taskId ? { taskId } : {}), ...part }
  bus.emit(EventNames.SESSION_RETRY_OVER, data, [RETRY_OVER_SUBSCRIBER], { source: 'retry-over' })
}

/** On a host: the held card goes to the leader. */
export const cardToLeader: HeldErrorCard = async (rec, words) => {
  sendRetryOver(rec.claudeSessionId, rec.taskId, { card: { words } })
}

/** The context recovery's give-up, raised while the record still holds this failure (a click may have recovered it meanwhile). */
export function contextRecoveryGaveUp(card: HeldErrorCard): (rec: SessionRecord, words: string, failedAt: string) => Promise<void> {
  return (rec, words, failedAt) => raiseHeldError(rec, words, 'context-full-recovery:gave-up', async () => {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const now = await getSessionByClaudeId(rec.claudeSessionId).catch(() => null)
    return now?.contextRecovery?.state === 'failed' && now.contextRecovery.at === failedAt
  }, card)
}

/** The safeguard switch's give-up: only a switch that could not happen; a turn that runs again (someone's message) is past this error. */
export function safeguardGaveUp(card: HeldErrorCard): (rec: SessionRecord, words: string) => Promise<void> {
  return (rec, words) => raiseHeldError(rec, words, 'safeguard-switch:gave-up', async () => {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    return (await getSessionByClaudeId(rec.claudeSessionId).catch(() => null))?.process_status !== 'running'
  }, card)
}
