/**
 * outcome.ts — every task/session write says WHAT CHANGED and WHAT COMES NEXT.
 *
 * Why this file exists (2026-09-01): an agent created a task, pinned it to
 * Focus, and reported the work as dispatched. Nothing in either result said
 * otherwise, and both statements were true on their own — the model's mistake
 * was in the MODEL of Walnut, not in the call. So the results now carry the
 * model:
 *
 *   a task is an inert record · a session is the thing that works ·
 *   pin/tier is human attention, never dispatch
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

/** The one-line mental model, quoted where an agent is most likely to be wrong. */
export const TASK_IS_INERT = 'A task is an inert record; only a session does work.'

/**
 * The dispatch call, ready to run.
 *
 * `known` is false when the response body carries no session fields (the slim
 * PATCH/complete projections): the call is still the right next step, but
 * claiming "nothing is running" from a field the server never sent would be a
 * confident wrong answer.
 */
export function dispatchHint(taskId: string, known = true): string {
  const call = `walnut tools call session_start '{"task":"${taskId}","message":"..."}'`
  return known
    ? `Nothing is running yet. Dispatch: ${call}`
    : `If no session is on it yet, dispatch: ${call}`
}

/** How a started/messaged session reports back — the anti-polling line. */
export const REPLY_ARRIVES_HINT =
  'Its reply arrives in your session on its own; do not poll. '
  + 'Only if you cannot continue without it: walnut wait <task-id | rq-id>.'

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
