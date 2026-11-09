/**
 * Every queue row Walnut reports delivered (session:messages-delivered, the runner's one proof
 * that a CLI has the line) stamps `reachedAt` on the request it carries
 * (session-requests.ts markRequestsReached), so the silent-target notice knows the target has the
 * ask after any restart (session-request-notify.ts TARGET_SIGNS). A subscriber, not a call at each
 * delivery site: every emitter of the event, a future engine's too, is covered by construction.
 * Leader only: only the primary keeps the request ledger.
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import { eventData } from '../event-types.js';
import { log } from '../../logging/index.js';

const SUBSCRIBER = 'request-reached';

/** One write at a time, in delivery order. */
let chain: Promise<unknown> = Promise.resolve();

export function onDelivered(event: BusEvent): Promise<unknown> {
  if (event.name !== EventNames.SESSION_MESSAGES_DELIVERED) return chain;
  const ids = eventData<'session:messages-delivered'>(event).messageIds ?? [];
  if (!ids.length) return chain;
  chain = chain.then(async () => {
    const { markRequestsReached } = await import('../session-requests.js');
    const stamped = await markRequestsReached(ids);
    if (stamped.length) log.session.info('request reached its target', { requestIds: stamped, messageIds: ids });
  }).catch((err) => log.session.warn('request reached stamp failed', { messageIds: ids, error: err instanceof Error ? err.message : String(err) }));
  return chain;
}

export function startRequestReachedWatch(): { stop: () => void } {
  bus.subscribe(SUBSCRIBER, (event) => { void onDelivered(event); }, {
    global: true,
    interest: [EventNames.SESSION_MESSAGES_DELIVERED],
  });
  return { stop: () => bus.unsubscribe(SUBSCRIBER) };
}

/**
 * Message ids of these sessions' queue rows waiting to go out (pending or parked). A delivery is a
 * write into the CLI's pipe, not its reading: when the process dies with the line unread, the queue
 * takes the row back (reclaimUntakenLines, requeueUnanswered, revertToPending and the rest), and a
 * stamp from that write proves nothing (review of 2026-11-09). Read from the queue itself, so every
 * path that takes a row back is covered by construction.
 */
export async function takenBackIds(sessionIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { getQueue } = await import('../session-message-queue.js');
    for (const sid of new Set(sessionIds.filter(Boolean))) {
      for (const m of await getQueue(sid)) if (m.status !== 'processing') out.add(m.id);
    }
  } catch { /* none known: the stamps stand */ }
  return out;
}
