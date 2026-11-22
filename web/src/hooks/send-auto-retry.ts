/**
 * A send that failed only because the connection was down goes out again by itself.
 *
 * 2026-11-21 (the user: "isn't there fucking retry?"): a deploy restarted the server,
 * the socket was down about 17 s, and a message he sent then waited its 10 s for the
 * socket (api/ws.ts PRE_OPEN_RPC_TIMEOUT_MS), failed, and stayed red with a small
 * Retry while the connection came back seconds later. Two red lines said so: the
 * bubble's and the composer's.
 *
 * The rule, pure so it is tested alone (tests/web/send-auto-retry.test.ts):
 *  - only a CONNECTION failure waits for the connection: the socket was not open, it
 *    closed with the send in flight, or the send got no answer in time. A refusal the
 *    server answered (a parked row, a stopped session, a bad request) never resends.
 *  - only a send with its own user line uuid: that uuid is how the server knows the
 *    same send again (session-chat.ts: a queued row with it is that row; a line the CLI
 *    already ran with it is delivered), so a resend can never add a second copy.
 *  - at most AUTO_RETRY_MAX tries by itself, and only within AUTO_RETRY_MAX_AGE_MS of the
 *    first; then it is an ordinary failed send with a Retry the person presses (2026-11-22:
 *    words a person wrote ten minutes ago may no longer be what he wants sent).
 *
 * The chat's bubbles (hooks/useSessionSend.ts) and the quick bar's receipts
 * (components/quickbar/useQuickReceipts.ts) follow this one rule; the server side is
 * src/core/sessions/send-once.ts.
 */

/** How many times a send is sent again by itself before the person's Retry takes over. */
export const AUTO_RETRY_MAX = 3;

/** A send older than this (from its first try) is never sent again by itself. */
export const AUTO_RETRY_MAX_AGE_MS = 10 * 60_000;

/** Error words of a send that never got through (api/ws.ts, api/session-send.ts withDeadline). */
const CONNECTION_FAILURE = /^(?:WebSocket not connected|WebSocket disconnected|no answer in \d+s$)/;

/**
 * Codes of an HTTP send Walnut never confirmed (api/quick.ts postNdjson): the fetch threw
 * (`network`), the answer broke off (`follow_lost`) or ended (`no_answer`) before the line that
 * says it was sent. All three may or may not have reached Walnut, so all three go one way: the
 * same send again under its own user line, which the server keeps as one (send-once.ts). Only a
 * send still waiting on that line asks (the quick bar's receipt in `sending`): after it, a broken
 * answer only lost the reply.
 */
const CONNECTION_CODES: ReadonlySet<string> = new Set(['network', 'follow_lost', 'no_answer']);

/** A failure by its words (a socket send) or by its code (an HTTP send's `{code, message}` line). */
export type SendFailure = string | { message: string; code?: string } | undefined;

/** A send that failed this way may have reached the server: only the same user line may follow it. */
export function isConnectionFailure(failure: SendFailure): boolean {
  if (!failure) return false;
  if (typeof failure === 'string') return CONNECTION_FAILURE.test(failure);
  return (!!failure.code && CONNECTION_CODES.has(failure.code)) || CONNECTION_FAILURE.test(failure.message);
}

/** When a send was first tried: an ISO time (a bubble's `timestamp`) or epoch ms. */
function firstTriedAt(at: string | number | undefined): number | undefined {
  if (at === undefined) return undefined;
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Too old to go out by itself any more. A send with no known time is never too old. */
export function pastAutoRetryAge(at: string | number | undefined, now = Date.now()): boolean {
  const first = firstTriedAt(at);
  return first !== undefined && now - first >= AUTO_RETRY_MAX_AGE_MS;
}

export interface AutoRetryBubble {
  queueId: string;
  status: string;
  text?: string;
  userUuid?: string;
  /** When it was first sent (ISO): past AUTO_RETRY_MAX_AGE_MS it no longer goes out by itself. */
  timestamp?: string;
  draftOrigin?: { key: string };
  /** Failed for the connection only: sent again by itself once it is back. */
  waitsForConnection?: boolean;
  /** How many times it was sent again by itself. */
  autoTries?: number;
}

/**
 * Whether a send that just failed with `failure` waits for the connection (after `tries` resends
 * by itself). `at`: when it was first tried (a bubble's `timestamp`, a receipt's epoch ms).
 */
export function waitsForConnectionAfter(
  failure: SendFailure, send: { userUuid?: string; timestamp?: string | number }, tries = 0, now = Date.now(),
): boolean {
  return isConnectionFailure(failure) && !!send.userUuid && tries < AUTO_RETRY_MAX && !pastAutoRetryAge(send.timestamp, now);
}

/** Waiting for the connection, with tries left and young enough to go out by itself. */
function stillWaits(m: AutoRetryBubble, now: number): boolean {
  return m.status === 'failed' && !!m.waitsForConnection && !!m.userUuid
    && (m.autoTries ?? 0) < AUTO_RETRY_MAX && !pastAutoRetryAge(m.timestamp, now);
}

/** The bubbles to send again now: waiting for the connection, which is up, and not on their way already. */
export function dueForAutoRetry<T extends AutoRetryBubble>(bubbles: readonly T[], connected: boolean, inFlight: ReadonlySet<string>, now = Date.now()): T[] {
  if (!connected) return [];
  return bubbles.filter((m) => stillWaits(m, now) && !inFlight.has(m.queueId));
}

/**
 * The bubbles that waited too long: no longer sent by themselves, so each becomes an ordinary
 * failed send (its red line and Retry), never dropped quietly.
 */
export function expiredAutoRetry<T extends AutoRetryBubble>(bubbles: readonly T[], now = Date.now()): T[] {
  return bubbles.filter((m) => m.status === 'failed' && m.waitsForConnection && pastAutoRetryAge(m.timestamp, now));
}

/** When the next waiting bubble grows too old (epoch ms), for one timer; undefined when none waits. */
export function nextAutoRetryExpiry(bubbles: readonly AutoRetryBubble[]): number | undefined {
  let next: number | undefined;
  for (const m of bubbles) {
    if (m.status !== 'failed' || !m.waitsForConnection) continue;
    const first = firstTriedAt(m.timestamp);
    if (first !== undefined && (next === undefined || first + AUTO_RETRY_MAX_AGE_MS < next)) next = first + AUTO_RETRY_MAX_AGE_MS;
  }
  return next;
}

/**
 * A send from `boxKey` with these same words that waits to go out by itself, or is going out by
 * itself now. A failed send's words come back to its box; pressing Enter on them again is that
 * send, never a second one under a new user line (which the server could not tell from a new message).
 */
export function sameWaitingSend<T extends AutoRetryBubble>(bubbles: readonly T[], text: string, boxKey: string | undefined, now = Date.now()): T | undefined {
  if (!boxKey) return undefined;
  // Too old to go out by itself: Enter on its words is a new send (the old one shows its Retry).
  return bubbles.find((m) => m.draftOrigin?.key === boxKey && m.text === text && !!m.userUuid && !pastAutoRetryAge(m.timestamp, now)
    && ((m.status === 'failed' && m.waitsForConnection) || (m.status === 'pending' && (m.autoTries ?? 0) > 0)));
}
