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
 *  - at most AUTO_RETRY_MAX tries by itself; then it is an ordinary failed send with a
 *    Retry the person presses.
 */

/** How many times a send is sent again by itself before the person's Retry takes over. */
export const AUTO_RETRY_MAX = 3;

/** Error words of a send that never got through (api/ws.ts, api/session-send.ts withDeadline). */
const CONNECTION_FAILURE = /^(?:WebSocket not connected|WebSocket disconnected|no answer in \d+s$)/;

export function isConnectionFailure(error: string | undefined): boolean {
  return !!error && CONNECTION_FAILURE.test(error);
}

export interface AutoRetryBubble {
  queueId: string;
  status: string;
  text?: string;
  userUuid?: string;
  draftOrigin?: { key: string };
  /** Failed for the connection only: sent again by itself once it is back. */
  waitsForConnection?: boolean;
  /** How many times it was sent again by itself. */
  autoTries?: number;
}

/** Whether a send that just failed with `error` waits for the connection (after `tries` resends by itself). */
export function waitsForConnectionAfter(error: string, bubble: Pick<AutoRetryBubble, 'userUuid'>, tries = 0): boolean {
  return isConnectionFailure(error) && !!bubble.userUuid && tries < AUTO_RETRY_MAX;
}

/** The bubbles to send again now: waiting for the connection, which is up, and not on their way already. */
export function dueForAutoRetry<T extends AutoRetryBubble>(bubbles: readonly T[], connected: boolean, inFlight: ReadonlySet<string>): T[] {
  if (!connected) return [];
  return bubbles.filter((m) => m.status === 'failed' && m.waitsForConnection && !!m.userUuid
    && (m.autoTries ?? 0) < AUTO_RETRY_MAX && !inFlight.has(m.queueId));
}

/**
 * A send from `boxKey` with these same words that waits to go out by itself, or is going out by
 * itself now. A failed send's words come back to its box; pressing Enter on them again is that
 * send, never a second one under a new user line (which the server could not tell from a new message).
 */
export function sameWaitingSend<T extends AutoRetryBubble>(bubbles: readonly T[], text: string, boxKey: string | undefined): T | undefined {
  if (!boxKey) return undefined;
  return bubbles.find((m) => m.draftOrigin?.key === boxKey && m.text === text && !!m.userUuid
    && ((m.status === 'failed' && m.waitsForConnection) || (m.status === 'pending' && (m.autoTries ?? 0) > 0)));
}
