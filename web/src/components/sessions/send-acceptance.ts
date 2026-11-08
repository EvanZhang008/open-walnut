/**
 * What a send's acceptance does to its bubble and to the panel's error line.
 * Pure, so the transitions are unit-tested (tests/web/send-acceptance.test.ts);
 * the proof itself (an answer, or the server's record when the answer was lost)
 * is api/session-send.ts.
 *
 *   pending ──answer──────────────▶ received / delivered
 *   pending ──error, server kept──▶ received / delivered (or parked: failed with Retry)
 *   pending ──error, no proof─────▶ failed ──late proof──▶ received / delivered
 *
 * A late proof never revives a bubble the SERVER reported undelivered (a batch
 * that failed, a parked row): only the server's own delivery event settles those
 * (optimistic-dedup.ts uuidProves).
 */
import type { KeptRow, SendAck } from '@/api/session-send';

export interface AcceptableBubble {
  queueId: string;
  status: 'pending' | 'received' | 'delivered' | 'failed';
  userUuid?: string;
  failedError?: string;
  parked?: boolean;
  waitsFor?: string;
  serverUndelivered?: boolean;
  launch?: boolean;
  dedupText?: string;
  timestamp?: string;
}

/**
 * The bubble after the server's answer `res` (a lost answer's stand-in included).
 * `deliveredEarly`: a delivery named its id before the answer came (optimistic-dedup.ts
 * statusOnAdopt, read once by the caller, outside any state updater).
 */
export function acceptedBubble<T extends AcceptableBubble>(m: T, res: SendAck, deliveredEarly = false): T {
  const parked = res.recovered?.parked;
  if (parked) {
    const { launch: _launch, ...rest } = m;
    return {
      ...rest, queueId: res.messageId, status: 'failed', serverUndelivered: true,
      parked: true, ...(parked.waitsFor ? { waitsFor: parked.waitsFor } : {}),
      ...(parked.reason ? { failedError: parked.reason } : {}),
      ...(res.enqueuedAt ? { timestamp: res.enqueuedAt } : {}),
    } as T;
  }
  const delivered = m.status === 'delivered' || deliveredEarly || res.alreadyDelivered === true;
  const { failedError: _error, parked: _parked, waitsFor: _waits, ...rest } = m;
  return {
    ...rest, queueId: res.messageId, status: delivered ? 'delivered' : 'received',
    ...(res.dedupText ? { dedupText: res.dedupText } : {}),
    ...(res.enqueuedAt ? { timestamp: res.enqueuedAt } : {}),
  } as T;
}

/**
 * A late proof (`row`) over the bubbles: the one whose user line it names, refused
 * by the CLIENT only (its answer was lost), is accepted. `settled` lists the
 * bubbles that were failed and are not now: their composers' drafts settle.
 */
export function applyLateKept<T extends AcceptableBubble>(
  bubbles: readonly T[], row: KeptRow, deliveredEarly = false,
): { next: readonly T[]; settled: T[] } {
  const settled: T[] = [];
  let changed = false;
  const next = bubbles.map((m) => {
    if (m.userUuid !== row.userUuid || m.launch || m.serverUndelivered || m.parked) return m;
    // A send still waiting on its answer takes its id from that answer (with the text the server enqueued).
    if (m.status !== 'failed') return m;
    const accepted = acceptedBubble(m, {
      messageId: row.messageId, ...(row.enqueuedAt ? { enqueuedAt: row.enqueuedAt } : {}),
      ...(row.delivered ? { alreadyDelivered: true } : {}), recovered: row,
    }, deliveredEarly);
    changed = true;
    if (accepted.status !== 'failed') settled.push(m);
    return accepted;
  });
  return { next: changed ? next : bubbles, settled };
}

/** The panel's red line: the send it is about, by user line, when there is one. */
export interface SendErrorState { text: string; userUuid?: string }

/**
 * The line shows while the send it is about still reads failed. A send the
 * server proved it kept (or history shows) takes its line with it; an error with
 * no send (a paste upload, a Stop) stays until the next send.
 */
export function shownSendError(err: SendErrorState | null, bubbles: readonly AcceptableBubble[]): string | null {
  if (!err) return null;
  if (!err.userUuid) return err.text;
  return bubbles.some((m) => m.userUuid === err.userUuid && m.status === 'failed') ? err.text : null;
}
