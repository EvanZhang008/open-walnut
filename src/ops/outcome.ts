/**
 * outcome.ts — every task/session write says WHAT CHANGED and WHAT COMES NEXT.
 *
 * Why this file exists (2026-09-01): an agent created a task, pinned it to
 * Focus, and reported the work as dispatched. Nothing in either result said
 * otherwise, and both statements were true on their own — the model's mistake
 * was in the MODEL of Walnut, not in the call. So the results now carry the
 * model:
 *
 *   task_create starts work; record_only only stores a record; pin/tier only change the board.
 *
 * Two fields, on every task_* / session_* write:
 *   outcome — one sentence naming the real consequence, including what did NOT
 *             happen ("no session is working on it").
 *   next    — the exact next call, runnable as printed, or a sentence saying
 *             that nothing is needed. Never a vague "you may want to…".
 *
 * Keep the strings SHORT: they ride on every write, and a paragraph nobody
 * reads is worse than a clause that lands.
 */

/**
 * The dispatch call, ready to run.
 *
 * `known` is false when the response body carries no session fields (the slim
 * PATCH/complete projections): the call is still the right next step, but
 * claiming "nothing is running" from a field the server never sent would be a
 * confident wrong answer.
 */
export function dispatchHint(taskId: string, known = true): string {
  const call = `walnut tools call task_start '{"id":"${taskId}","message":"..."}'`
  return known
    ? `Not started. Start when requested: ${call}`
    : `To start work, use ${call}. To continue existing work, use task_send.`
}

/** How a started/messaged session reports back — the anti-polling line. */
export const REPLY_ARRIVES_HINT =
  'Its reply arrives in your session on its own; do not poll. '
  + 'Only if you cannot continue without it: walnut wait <task-id | rq-id>.'

/** A message that carries no reply request (a note up the org, a fire-and-forget): nothing to wait for. */
export const NO_REPLY_ASKED =
  'It asks for no reply, so do not wait for one; the receiver answers only if it has something you must act on. '
  + 'To ask a question, send with expect_reply=true.'

/** What a parent hears about a subtask it started, beyond the reply (sessions/subtask-notices.ts). */
export const SUBTASK_WATCH_HINT =
  'A subtask of yours also tells you, through Walnut, whenever it stops, completes, errors or waits on the user, '
  + 'so there is nothing to check on.'

/**
 * Attach outcome/next to a result object. Both are plain strings so they render
 * identically in JSON (CLI), MCP content, and the gateway relay.
 */
export function withOutcome<T extends Record<string, unknown>>(
  result: T,
  outcome: string,
  next: string,
): T & { outcome: string; next: string } {
  return { ...result, outcome, next }
}

/**
 * An answer this host's own server gave while the Walnut server is away (a host's follower:
 * replica/away-calls.ts, away-triggers.ts): it says itself what it saved and what comes next
 * (the host daemon's words), so the op passes it on as it came. Null for any other answer.
 */
export function awayAnswer(body: unknown): Record<string, unknown> | null {
  const b = body as Record<string, unknown> | null | undefined;
  return b && typeof b === 'object' && b.offline === true && typeof b.outcome === 'string' && typeof b.next === 'string' ? b : null;
}

const BARE_AWAY_KEYS = new Set(['queued', 'offline', 'opId']);

/**
 * A write this host's own server journaled while the Walnut server is away and answered with nothing
 * else (src/replica/write-port.ts: `{ queued: true, offline: true, opId }`): it is saved here and
 * applied when the server is back. An answer with more (a task row, a placement, the host daemon's
 * own words) lets the op say what happened itself.
 */
export function isBareAwayQueued(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.queued === true && b.offline === true && Object.keys(b).every((k) => BARE_AWAY_KEYS.has(k));
}

/**
 * An op's result after `writes` of its writes were journaled on this host while the server is away
 * with nothing else in the answer (isBareAwayQueued): it says so in its outcome, in place of
 * what the op read from an answer that was never the server's (2026-11-23: board_project_set said
 * "removed" for a project it had just written, as the journaled answer carries no `project`).
 */
export function heldAwayResult(result: unknown, writes: number): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  return {
    ...r,
    queued: true,
    offline: true,
    outcome: `Saved on this host while the Walnut server is away: ${writes === 1 ? 'the write is' : `${writes} writes are`} journaled here, and Walnut applies ${writes === 1 ? 'it' : 'them'} when the server is back (its own checks decide again). Until then this answer cannot show what the server holds.`,
    next: 'Nothing else is required. Do not repeat the call; read it back once the server is back.',
  };
}

/**
 * What a message still waits on, for the agent that sent it: the words the user's bubble
 * shows, the next try Walnut makes by itself, and how to send it now. '' when nothing holds it.
 * (request_get and message_send_now; a fresh send says it in sendBehindSlowHostLine.)
 */
export function deliveryWaitLine(wait: unknown, sendNowId: unknown): string {
  const w = (wait ?? {}) as { reason?: unknown; retryAt?: unknown };
  if (typeof w.reason !== 'string' || !w.reason) return '';
  const at = typeof w.retryAt === 'string' ? Date.parse(w.retryAt) : NaN;
  const next = Number.isFinite(at)
    ? ` Walnut sends it again by itself at ${new Date(at).toISOString()} (in ${Math.max(0, Math.round((at - Date.now()) / 1000))} s).`
    : '';
  const now = typeof sendNowId === 'string' && sendNowId
    ? ` To send it now: message_send_now {"id":"${sendNowId}"}; never send the text again.` : '';
  return `${w.reason}${next}${now}`;
}

/**
 * A send to a session whose host did not take the last message in time. The send itself
 * tries again at once (every new message does), so there is no clock to quote yet: say what
 * happened last time and where to read how this one went.
 */
export function sendBehindSlowHostLine(wait: unknown, requestId: unknown, messageId: unknown): string {
  const w = (wait ?? {}) as { reason?: unknown };
  if (typeof w.reason !== 'string' || !w.reason) return '';
  const rq = typeof requestId === 'string' && requestId ? requestId : '';
  const id = rq || (typeof messageId === 'string' ? messageId : '');
  return `The host of that session did not answer the last message in time ("${w.reason}"). This send tries again now;`
    + ' if the host is still slow, it waits and goes out by itself.'
    + (rq ? ` request_get {"id":"${rq}"} says whether it went in and when the next try is.` : '')
    + (id ? ` message_send_now {"id":"${id}"} sends it at once. Never send the text again.` : '');
}
