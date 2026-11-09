/**
 * An ACP session takes one queue row at a time: markNextProcessing refuses to
 * pick anything while a row of the session reads 'processing'. A row left
 * 'processing' with no delivery in flight (its revert or removal lost to a queue
 * lock timeout, or a server that stopped between the take and the settle) holds
 * every newer row back for good: no turn will ever end to drive it.
 *
 * 2026-11-09: after a steer loop stopped, one Codex session kept a row
 * 'processing' with a newer row pending behind it, and nothing went out again.
 *
 * So every ACP drain first settles such a row: removed when the worker is known to
 * have taken it (its prompt-accepted or steer-accepted fact was read), else put
 * back to pending, which is safe for a prompt because the worker answers the same
 * prompt command id with its first result instead of running it twice.
 */
import { getQueue, removeProcessed, revertToPending } from '../core/session-message-queue.js'
import { log } from '../logging/index.js'

export interface StrandedRowCheck {
  /** True while a delivery of this session may hold its 'processing' row (a take, a send or a steer in flight). */
  busy: () => boolean
  /** The worker took this row (AcpSession.hasTaken). */
  taken: (messageId: string) => boolean
}

/** Settle the session's 'processing' rows when no delivery holds them. Returns how many it settled. */
export async function settleStrandedAcpRows(sessionId: string, check: StrandedRowCheck): Promise<number> {
  if (check.busy()) return 0
  const stuck = (await getQueue(sessionId)).filter((m) => m.status === 'processing')
  // Read again after the await: a take that started meanwhile owns its row.
  if (stuck.length === 0 || check.busy()) return 0
  const taken = stuck.filter((m) => check.taken(m.id))
  const back = stuck.filter((m) => !check.taken(m.id))
  if (taken.length > 0) await removeProcessed(sessionId, taken.map((m) => m.id))
  if (back.length > 0) await revertToPending(back)
  log.session.warn('acp: a queue row was left processing with no delivery in flight; settled it', {
    sessionId,
    removed: taken.map((m) => m.id),
    repended: back.map((m) => m.id),
  })
  return stuck.length
}
