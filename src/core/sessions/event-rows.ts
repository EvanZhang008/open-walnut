/**
 * Queue rows for news that can happen again: a watch's news on a change or pull request, a
 * subtask's stop. The caller names the kind of news with a key; each event goes out under its
 * own id, `<key>-<uuid>`, and the key finds one still waiting in the queue.
 *
 * Why not the key itself as the id: a caller id tells the queue "this is the same send again".
 * A row with it still queued is that row, and one that already ran hands its CLI uuid to the new
 * row (enqueueMessage, settledLineUuid; batch-uuid.ts lineUuidFor derives it from the id too).
 * Claude Code skips a uuid it already saw, so news that recurred under one id was dropped
 * unread or parked as not acknowledged (2026-11-20: a change's "3 checks failed", told again
 * seven hours later for a new revision). Ratchet: tests/core/sessions/stable-row-ids.test.ts.
 */

import { randomUUID } from 'node:crypto'
import type { QueuedMessage } from '../session-queue-store.js'
import { AFTER_TURN_REASON } from '../relay-fates.js'
import { MOVE_HELD_REASON } from './engine-switch-io.js'

/** The id one event of `key` goes out under: never the id of an earlier event. */
export function eventRowId(key: string): string {
  return `${key}-${randomUUID()}`
}

/** A row of `key`'s news: one sent under eventRowId, or under the bare key by an older Walnut. */
export function isEventRowOf(id: string, key: string): boolean {
  return id === key || id.startsWith(`${key}-`)
}

/**
 * The newest row of `key`'s news that no line carried yet: pending, or held by Walnut itself until
 * it can go (a task move, the running turn, a cold session). Its text may still be replaced, and
 * the same news told again is not queued beside it. A row already written into the CLI is not
 * one: news told after it (a new revision failing again in the same turn) is new news. Nor is a
 * row parked as failed: the user sees that one, and new news goes out on its own.
 */
export async function queuedEventRow(sessionId: string, key: string): Promise<QueuedMessage | undefined> {
  const { getQueue } = await import('../session-message-queue.js')
  const heldByWalnut = (m: QueuedMessage) => m.status === 'parked'
    && (m.parkedReason === MOVE_HELD_REASON || m.parkedReason === AFTER_TURN_REASON || !!m.waitsFor)
  const queue = await getQueue(sessionId)
  for (let i = queue.length - 1; i >= 0; i--) {
    const m = queue[i]
    if (!isEventRowOf(m.id, key) || m.lineUuid || m.lineTries || m.lineInDoubt) continue
    if (m.status === 'pending' || heldByWalnut(m)) return m
  }
  return undefined
}
