/**
 * PRIMARY: the phone messages (cloud relay, `qm-mobile-*` ids) this Mac's queue
 * took, and the companion's question "do you hold this one?".
 *
 * ## Accepted ids (post-delivery idempotency)
 *
 * The durable queue dedupes by messageId only while the row is still queued; a
 * relay replay that arrives after the message was delivered and drained would
 * enqueue it again. The fate of every relayed id closes that window
 * (DaemonConnection handleMessageRequest). It is kept in the queue file itself,
 * written in the same write as the row (core/relay-fates.ts), for the
 * companion's own horizon (24h, send-outcomes.ts).
 *
 * ## Withdraw (the companion's direct path)
 *
 * When the Mac's link to a host goes quiet, a phone send the companion relayed
 * toward the Mac may or may not have reached the Mac's queue (the answer was
 * lost). The host is still on the companion's bridge and takes sends directly,
 * but sending one there while the Mac's queue may hold it would deliver it
 * twice, and sending one while an earlier message of the session still waits
 * here would deliver them out of order. So the companion asks the Mac (over the
 * Mac's own bridge, which still answers):
 *  - a pending row with nothing of the session queued ahead of it is removed
 *    ('withdrawn'); an id this Mac never saw is 'not-received'. Either way the
 *    id is FENCED here: a relay frame of it that arrives later (one still on its
 *    way) is refused, so the companion's direct path is its only delivery;
 *  - 'behind': an earlier message of the session is still queued here. Nothing
 *    may deliver this one yet, so the companion keeps waiting for the Mac;
 *  - 'delivering' (its row is being delivered), 'delivered' (it ran here), and
 *    'removed' (a person removed it here): never sent another way;
 *  - 'stopped' (a stop here parked it: it never runs) and 'parked' (parked for
 *    a person to retry here): never sent another way either. 'stopped' names
 *    the stop, so the companion fences the session's other held messages by
 *    it before its own session list shows it (gate r3, N5/M7: a later message
 *    of the session could run directly past a stop only this Mac knew).
 * The answer and the row's removal are one durable write, so no crash point
 * between them leaves a lie behind (gate r2, M3/M4).
 */

import { log } from '../../logging/index.js';

/** Per-id serialization: an enqueue and a withdraw of one message never interleave. */
const locks = new Map<string, Promise<unknown>>();

export async function withMobileMessageLock<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
  const earlier = locks.get(messageId) ?? Promise.resolve();
  const mine = earlier.catch(() => {}).then(fn);
  locks.set(messageId, mine);
  try {
    return await mine;
  } finally {
    if (locks.get(messageId) === mine) locks.delete(messageId);
  }
}

export type { WithdrawState } from '../relay-fates.js';

/** What became of a relayed id here: 'taken', 'removed', a fence, or undefined (never seen). */
export async function relayFate(messageId: string): Promise<import('../relay-fates.js').RelayFate | undefined> {
  const { relayFateOf } = await import('../session-message-queue.js');
  return relayFateOf(messageId);
}

/** The companion's question for one relayed message (see the file header). */
export async function withdrawMobileMessage(
  sessionId: string, messageId: string,
): Promise<{ state: import('../relay-fates.js').WithdrawState; stop?: { id: string; state: string; requestedAt?: string } }> {
  return withMobileMessageLock(messageId, async () => {
    const { withdrawRelayedMessage } = await import('../session-message-queue.js');
    const state = await withdrawRelayedMessage(sessionId, messageId);
    log.session.info('mobile relay: companion asked to withdraw a message', { sessionId, messageId, state });
    if (state !== 'stopped') return { state };
    // The stop that parked it: the companion fences the session by it.
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const stop = (await getSessionByClaudeId(sessionId).catch(() => null))?.stopRequest;
    return stop?.id
      ? { state, stop: { id: stop.id, state: stop.state, ...(stop.requestedAt ? { requestedAt: stop.requestedAt } : {}) } }
      : { state };
  });
}
