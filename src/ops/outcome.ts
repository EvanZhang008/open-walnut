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
