/**
 * PRIMARY: what became of each phone message the companion relayed into this
 * Mac's queue. Kept INSIDE the queue file (session-message-queue.ts), so a row
 * and its fate always change in the same write.
 *
 * Why the same write (gate r2, M3 and M4): with the fates in a file of their
 * own, a crash between the two writes left a lie behind. Either the queue took
 * a message and the fates never heard of it (a later "not received" let the
 * companion deliver it again by the host's direct path: two turns), or a
 * withdraw removed the row and died before the fates changed (a later
 * "delivered" for a message that never ran: a lost message). One write has no
 * such point.
 *
 * Fates (id -> [fate, ms]; at most MAX_FATES ids, each kept FATE_HORIZON_MS):
 *  - 'taken':     this queue took it. Its row is here, or it ran.
 *  - 'removed':   a person removed its row here before it ran.
 *  - 'withdrawn': the companion asked for it back and its pending row was
 *                 removed. The companion delivers it another way.
 *  - 'fenced':    the companion asked about an id this queue never took. A relay
 *                 of it that arrives later (a frame still on its way) is refused,
 *                 because the companion delivers it another way.
 * 'withdrawn' and 'fenced' are FENCES: a relay of that id is never taken again
 * (gate r2, B1: a late frame used to become a second delivery).
 */

export type RelayFate = 'taken' | 'removed' | 'withdrawn' | 'fenced';
export type RelayFates = Record<string, [RelayFate, number]>;

/**
 * The companion's answer for one message (mobile-relay-ledger.ts):
 *  - 'withdrawn' / 'not-received': this queue will not deliver it; the companion may.
 *  - 'delivering': its row is being delivered right now, or went back to the
 *                  queue while its line may be in a CLI (only this Mac resends it).
 *  - 'delivered':  it ran here.
 *  - 'removed':    a person removed it here; it will not run anywhere.
 *  - 'behind':     an earlier message of the session is still queued here, so
 *                  nothing may deliver this one yet (it would overtake that one).
 *  - 'stopped':    a stop on this Mac parked its row: it never runs, by any path.
 *  - 'parked':     its row is parked here for another reason (a delivery that
 *                  cannot succeed); a person retries or discards it here, so
 *                  nothing else may deliver it.
 * A parked row is never given back (gate r3, M7): handed to the companion, it
 * went by the host's direct path and ran past the stop that parked it. An older
 * companion reads the two new answers as "wait", which is safe.
 */
export type WithdrawState =
  | 'withdrawn' | 'not-received' | 'delivering' | 'delivered' | 'removed' | 'behind' | 'stopped' | 'parked';

/** Why a stop parks a pending row (session-message-queue.ts markProcessing). */
export const STOP_PARKED_REASON = 'Session stopped by user; retry explicitly to send';

/** The slice of the queue store the fates work on. */
export interface FateStore {
  queues: Record<string, Array<{ id: string; status: string; parkedReason?: string; lineInDoubt?: true }>>;
  relay?: RelayFates;
}

export const MAX_FATES = 2000;
/** The companion's own horizon (send-outcomes.ts SEND_HORIZON_MS). */
export const FATE_HORIZON_MS = 24 * 60 * 60_000;

/** Ids the phone relay mints (session-stream-v1.ts); a delivered one counts as taken. */
const MOBILE_ID = /^qm-mobile-/;

/** A phone message id (one a companion may ask about), whether or not a fate was recorded for it. */
export function isPhoneMessageId(id: string): boolean {
  return MOBILE_ID.test(id);
}

export function isRelayFence(fate: RelayFate | undefined): boolean {
  return fate === 'withdrawn' || fate === 'fenced';
}

export function fateOf(s: FateStore, id: string, now = Date.now()): RelayFate | undefined {
  const entry = s.relay?.[id];
  if (!entry || now - entry[1] > FATE_HORIZON_MS) return undefined;
  return entry[0];
}

/** Record a fate (newest last, so the oldest is dropped first). */
export function setFate(s: FateStore, id: string, fate: RelayFate, now = Date.now()): void {
  const relay = (s.relay ??= {});
  delete relay[id];
  relay[id] = [fate, now];
  pruneFates(s, now);
}

export function pruneFates(s: FateStore, now = Date.now()): void {
  const relay = s.relay;
  if (!relay) return;
  const ids = Object.keys(relay);
  let over = ids.length - MAX_FATES;
  for (const id of ids) {
    if (over > 0 || now - relay[id][1] > FATE_HORIZON_MS) {
      delete relay[id];
      over--;
    }
  }
}

/**
 * Rows a delivery just removed (removeProcessed): a phone message among them
 * ran here. Recorded in the same write, so it holds for an id whose enqueue
 * predates the fates as well.
 */
export function noteDelivered(s: FateStore, rows: Array<{ id: string }>, now = Date.now()): void {
  for (const row of rows) {
    const fate = fateOf(s, row.id, now);
    if (fate === 'taken' || (fate === undefined && MOBILE_ID.test(row.id))) setFate(s, row.id, 'taken', now);
  }
}

/** Is a row of the session that may still run ahead of `beforeIndex` (all of the queue when absent)? */
function earlierQueued(queue: Array<{ status: string }>, beforeIndex = queue.length): boolean {
  for (let i = 0; i < beforeIndex; i++) {
    if (queue[i].status === 'pending' || queue[i].status === 'processing') return true;
  }
  return false;
}

/**
 * The companion's question for one relayed message, answered and recorded in
 * one write (the caller holds the queue's lock). The row is looked for in every
 * session's queue (a migration moves rows between session ids).
 */
export function withdrawIn(s: FateStore, sessionId: string, id: string, now = Date.now()): WithdrawState {
  const order = [sessionId, ...Object.keys(s.queues).filter((k) => k !== sessionId)];
  for (const key of order) {
    const queue = s.queues[key];
    const at = queue?.findIndex((m) => m.id === id) ?? -1;
    if (!queue || at === -1) continue;
    if (queue[at].status === 'processing') return 'delivering';
    if (queue[at].status === 'parked') return queue[at].parkedReason === STOP_PARKED_REASON ? 'stopped' : 'parked';
    // Its line may be in a CLI already: only a resend under the same uuid may deliver it.
    if (queue[at].lineInDoubt) return 'delivering';
    if (earlierQueued(queue, at)) return 'behind';
    queue.splice(at, 1);
    if (queue.length === 0) delete s.queues[key];
    setFate(s, id, 'withdrawn', now);
    return 'withdrawn';
  }
  switch (fateOf(s, id, now)) {
    case 'taken': return 'delivered';
    case 'removed': return 'removed';
    case 'withdrawn': return 'withdrawn';
    case 'fenced': return 'not-received';
    default: break;
  }
  // Never seen here. An earlier message of the session still queued here must
  // go first; the id stays unfenced, so a relay of it later queues behind it.
  const own = s.queues[sessionId];
  if (own && earlierQueued(own)) return 'behind';
  setFate(s, id, 'fenced', now);
  return 'not-received';
}
