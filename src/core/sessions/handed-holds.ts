/**
 * The holds of a session its host runs and judges live on that host (docs/plan/one-service-every-host.md,
 * phase 2, the resend family on the host). A message the leader lines up for after the running turn
 * (queue-after-turn.ts) or holds for a cold session's next wake (cold-hold.ts) is decided on the
 * leader, where the send is made, and then handed to the host with its hold:
 *
 *   leader   sendMessageToSession stores the held row, then handHeldRowsToHost: the row leaves this
 *            queue for the host's (providers/host-judged-send.ts handHeldToHost, a `holdOnly`
 *            send). A hand that fails goes again until the host takes it (that module's one
 *            redelivery path), and any later send to the session takes the held rows with its own
 *            lines (session-message-queue.ts takeLinesForHost).
 *   host     the routes queue each handed line held under the same reason (queueLinesOnHost), so the
 *            host's own queue-after-turn releases it when the host's turn ends and its cold hold
 *            when the session wakes or the hold reaches its max, whether the leader is there or not.
 *
 * Only these two reasons cross: any other held row (parked for a failure, held for a move) stays
 * where it is. The leader's panel no longer lists a row once it went to the host (known limit: an
 * edit or a withdraw of it needs the host's queue read through the leader, not built yet).
 */
import { AFTER_TURN_REASON, COLD_HOLD_REASON } from '../relay-fates.js'
import type { QueuedMessage } from '../session-queue-store.js'
import type { QueuedLine } from '../session-channel/host-api.js'

export const HANDED_HOLD_REASONS: readonly string[] = [AFTER_TURN_REASON, COLD_HOLD_REASON]

/** A held row that goes to the host with its hold. */
export function isHandedHold(row: Pick<QueuedMessage, 'status' | 'parkedReason'>): boolean {
  return row.status === 'parked' && !!row.parkedReason && HANDED_HOLD_REASONS.includes(row.parkedReason)
}

/** The hold a queued row carries to the host, or undefined (a row ready to go). */
export function heldOf(row: Pick<QueuedMessage, 'status' | 'parkedReason' | 'coldSend'>): QueuedLine['held'] {
  if (!isHandedHold(row)) return undefined
  return { reason: row.parkedReason!, ...(row.coldSend ? { coldSend: row.coldSend } : {}) }
}

/** Leader: a row was just held for `sid`; a session its host judges gets it there now. */
export function handHeldRowsToHost(sid: string): void {
  void (async () => {
    const { judgingHostOf } = await import('./judge-of.js')
    if (!judgingHostOf(sid)) return
    const { handHeldToHost } = await import('../../providers/host-judged-send.js')
    handHeldToHost(sid)
  })().catch(() => { /* handHeldToHost logs and retries itself */ })
}

/** The options of one handed line's enqueue on the host: its hold, when it is one that crosses. */
export function heldEnqueueOptions(line: Pick<QueuedLine, 'held'>): { heldReason?: string; coldSend?: { source: string; endsWait?: true } } {
  const h = line.held
  if (!h || typeof h.reason !== 'string' || !HANDED_HOLD_REASONS.includes(h.reason)) return {}
  return { heldReason: h.reason, ...(h.reason === COLD_HOLD_REASON && h.coldSend && typeof h.coldSend.source === 'string' ? { coldSend: h.coldSend } : {}) }
}

/**
 * Host: queue the lines a send brought (the host routes' `enqueue`): the leader's queue rows, as its
 * send stored them (a person's line as he typed it, an agent's already framed there and framed here
 * when it still reads as a person's, never passed as his; a line with no sender, a send made on this
 * host, framed for the send's own source), each held row under its hold. A line that goes now first
 * puts this session's cold holds back in line in front of it, as a send made here does
 * (session-message-queue.ts sendMessageToSession); the holds the lines brought are watched here.
 */
export async function queueLinesOnHost(sid: string, lines: readonly QueuedLine[], source: string): Promise<void> {
  const [{ enqueueMessage, getQueue, withdrawQueuedLines }, { frameAsWalnut, frameForSource }] = await Promise.all([import('../session-message-queue.js'), import('./send-frame.js')])
  const reasons = new Set<string>()
  // All or nothing: the rows queued here before one failed are taken back, so a failure the leader
  // answers by delivering the lines itself (a resume it falls back from) leaves none to run here too.
  const had = new Set((await getQueue(sid)).map((m) => m.id))
  const added: string[] = []
  try {
    for (const l of lines) {
      const text = l.sentBy === 'person' ? l.message : l.sentBy === 'agent' ? frameAsWalnut(l.message, source) : frameForSource(l.message, source)
      const held = heldEnqueueOptions(l)
      if (held.heldReason) reasons.add(held.heldReason)
      await enqueueMessage(sid, text, {
        // By the leader's row id, once: a resend whose first answer was lost queues nothing again.
        ...(l.id ? { id: l.id, onceById: true } : {}), ...(l.userUuid ? { userUuid: l.userUuid } : {}), ...(l.lineUuid ? { lineUuid: l.lineUuid } : {}),
        ...(l.closesPrompt ? { closesPrompt: true } : {}), ...(l.sentBy ? { sentBy: l.sentBy } : {}),
        ...held,
      })
      if (l.id && !had.has(l.id)) added.push(l.id)
    }
  } catch (err) {
    await withdrawQueuedLines(sid, added).catch(() => 0)
    throw err
  }
  // Only once every line is queued (a failure leaves the holds as they were). The held rows keep
  // their place, in front of the lines just queued.
  if (lines.some((l) => !heldEnqueueOptions(l).heldReason)) {
    const { releaseColdHolds } = await import('./cold-hold.js')
    await releaseColdHolds(sid, 'a message that goes now')
  }
  if (reasons.has(AFTER_TURN_REASON)) (await import('./queue-after-turn.js')).noteAfterTurnHold(sid)
  if (reasons.has(COLD_HOLD_REASON)) (await import('./cold-hold.js')).noteColdHold(sid)
}
