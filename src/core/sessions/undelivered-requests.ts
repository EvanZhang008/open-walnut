/**
 * A request whose message never reached its target is answered with that fact.
 *
 * A peer's task_send rides the target's queue as one row holding a `peer-note`
 * envelope that names its `request="rq-…"` (Walnut notices may ride in front of
 * it in the same row: a place note, a wait note, the instruction notice). While
 * that row is still in the queue the target has not read it, so:
 *   - a phase edge of the target (its turn ended, it errored) is about some
 *     other turn and must not settle the request (session-request-notify.ts);
 *   - a row PARKED because it can never have run (the host refused the session,
 *     the resumed CLI exited before reading it, the CLI dropped it) settles it at
 *     once with the park reason, so the asker hears "not delivered" now instead
 *     of "its turn ended" with an old quote (2026-10-28), or nothing until the
 *     deadline.
 */

import { log } from '../../logging/index.js';
import { parseWalnutMessage } from '../peers/walnut-message-tag.js';
import type { QueuedMessage } from '../session-queue-store.js';

/** At most this many envelopes are read from one row (notices ride in front of the ask). */
const MAX_ENVELOPES = 16;

/** Every envelope in a row's text, in order. */
function envelopesOf(text: string): Array<NonNullable<ReturnType<typeof parseWalnutMessage>>> {
  const out: Array<NonNullable<ReturnType<typeof parseWalnutMessage>>> = [];
  let rest = text;
  while (out.length < MAX_ENVELOPES) {
    const envelope = parseWalnutMessage(rest);
    if (!envelope) break;
    out.push(envelope);
    const at = rest.indexOf(envelope.raw);
    if (at < 0) break;
    rest = rest.slice(at + envelope.raw.length);
  }
  return out;
}

/** A row's peer ask: its request id and the task that sent it. A reply's id is its receiver's own, so it is none. */
export function peerAskOf(row: Pick<QueuedMessage, 'message'>): { requestId?: string; fromTask?: string } | undefined {
  const ask = envelopesOf(row.message).find((e) => e.kind === 'peer-note');
  if (!ask) return undefined;
  const id = ask.attrs.request;
  return {
    ...(id && /^rq-[a-f0-9]{6,}$/.test(id) ? { requestId: id } : {}),
    ...(ask.attrs['from-task'] ? { fromTask: ask.attrs['from-task'] } : {}),
  };
}

/** The request a queued row carries, if it is a peer's ask with one. */
export function requestIdOf(row: Pick<QueuedMessage, 'message'>): string | undefined {
  return peerAskOf(row)?.requestId;
}

/**
 * A park reason that proves the message never ran. Other parks are not: a Stop
 * (the user's choice, and a sender told to resend would undo it) and a line the
 * CLI may already have run under its uuid say nothing of the sort.
 */
export function parkMeansNeverRan(reason: string | undefined): boolean {
  if (!reason) return false;
  return /^Not delivered( yet)?:/.test(reason)
    || /^Not sent: the session budget is paused/.test(reason)
    || /dropped this message without running it/.test(reason)
    || /working directory (no longer exists|not set|not available)/i.test(reason)
    || /no active session found for session id/i.test(reason);
}

/**
 * A park reason that says another process has the session open: a terminal (the
 * user working in it, most often) or another Walnut (delivery-failure.ts words it).
 * The task is in use, not broken.
 */
export function isHeldElsewhereReason(reason: unknown): boolean {
  return typeof reason === 'string'
    && /^Not delivered yet: (the user \(or someone\) has this session open in a terminal|another Walnut runs this session)/.test(reason);
}

/** A park a Stop made: the message never ran either, but by the user's choice, so nobody is told to resend it. */
export function parkByStop(reason: string | undefined): boolean {
  return reason === 'Session stopped by user; retry explicitly to send'
    || reason === 'The session ended before Claude Code ran this message';
}

/**
 * Requests whose asked message is on its way into the target right now: the row is
 * created first (the message names its id) and queued after, so between the two
 * there is no row to find, and a phase edge of the target's earlier turn landing
 * there settled the request as answered (agent-send-wait.test.ts on CI, 2026-10-30).
 * The creator marks it until its message is queued or started; the mark also lapses
 * after DELIVERING_MAX_MS, so one a crash never cleared holds nothing for long.
 */
const delivering = new Map<string, number>();
export const DELIVERING_MAX_MS = 2 * 60_000;

/** Mark request `id` as on its way; call the returned function once its message is in. */
export function noteRequestDelivering(id: string): () => void {
  const at = Date.now();
  delivering.set(id, at);
  return () => { if (delivering.get(id) === at) delivering.delete(id); };
}

/** Whether request `id`'s message is still on its way into its target. */
export function requestDelivering(id: string): boolean {
  const at = delivering.get(id);
  if (at === undefined) return false;
  if (Date.now() - at <= DELIVERING_MAX_MS) return true;
  delivering.delete(id);
  return false;
}

/** The row of `requestId` still in `sessionId`'s queue (not delivered), if any. */
export async function undeliveredRowFor(sessionId: string | undefined, requestId: string): Promise<QueuedMessage | undefined> {
  if (!sessionId) return undefined;
  const { getQueue } = await import('../session-message-queue.js');
  const queue = await getQueue(sessionId).catch(() => [] as QueuedMessage[]);
  return queue.find((m) => requestIdOf(m) === requestId);
}

/** The newest row of `sessionId` parked since `sinceMs` for a reason that proves it never ran. */
export async function recentNeverRanPark(sessionId: string | undefined, sinceMs: number): Promise<QueuedMessage | undefined> {
  if (!sessionId) return undefined;
  const { getQueue } = await import('../session-message-queue.js');
  const queue = await getQueue(sessionId).catch(() => [] as QueuedMessage[]);
  return queue
    .filter((m) => m.status === 'parked' && parkMeansNeverRan(m.parkedReason) && Date.parse(m.parkedAt ?? '') >= sinceMs)
    .sort((a, b) => (b.parkedAt ?? '').localeCompare(a.parkedAt ?? ''))[0];
}

/** Tell each asker whose message was just parked for good. Never throws. */
export async function notifyParkedRequests(rows: readonly QueuedMessage[]): Promise<void> {
  for (const row of rows) {
    if (!parkMeansNeverRan(row.parkedReason)) continue;
    const id = requestIdOf(row);
    if (!id) continue;
    try {
      const { getSessionRequest } = await import('../session-requests.js');
      const request = await getSessionRequest(id);
      if (!request || request.status !== 'pending') continue;
      const { notifyRequesterFallback } = await import('./session-request-notify.js');
      await notifyRequesterFallback(request, 'error', { notDelivered: row.parkedReason });
    } catch (err) {
      log.session.warn('parked request: notifying the asker failed', {
        requestId: id, sessionId: row.sessionId, messageId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
