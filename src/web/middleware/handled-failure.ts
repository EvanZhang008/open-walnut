/**
 * A 5xx the route EXPECTED and already reported to the user is not an endpoint incident.
 *
 * `POST .../linked/update` answers 502 when the user's own git remote refuses the fetch and
 * 504 when git outruns its deadline. The status is honest (an upstream failed), and the row
 * in Apps already says so in one sentence with a Details fold. But the request
 * logger turns every 5xx except 501 into a red incident card plus an inbox notification with
 * an "Ask AI to fix" button, for a condition Walnut cannot fix (N3-1). One place says it: the
 * row. A route that has handled its failure marks the response with this header and the
 * logger treats it like a 4xx: in the request log at warn, never a card.
 *
 * A header rather than `res.locals` so the same contract holds through a proxy or a bridge
 * relay, and so a test can read it off the response.
 */
import type { Request, Response } from 'express'
import { noteFinalAnswer } from '../../core/hosts/repeat-answers.js'

export const HANDLED_FAILURE_HEADER = 'x-walnut-handled-failure'

export function markHandledFailure(res: Response): Response {
  res.setHeader(HANDLED_FAILURE_HEADER, '1')
  return res
}

/** True when the route said the failure is its own designed answer (see markHandledFailure). */
export function isHandledFailure(res: Pick<Response, 'getHeader'>): boolean {
  return res.getHeader(HANDLED_FAILURE_HEADER) === '1'
}

/**
 * A 4xx that repeats an answer the same caller already got for the same thing (a poll loop reading a
 * job the host does not hold: host-exec-jobs.ts unknownJob) logs at info, not warn: the first one is
 * the signal, and one stale id should be one warn line, not one per poll (2026-11-22: a session's
 * loop of 404 reads rang the log-spike alarm). The response itself is unchanged.
 */
export const REPEAT_ANSWER_HEADER = 'x-walnut-repeat-answer'

export function markRepeatAnswer(res: Response): Response {
  res.setHeader(REPEAT_ANSWER_HEADER, '1')
  return res
}

/** True when the route said this answer repeats one the caller already had (see markRepeatAnswer). */
export function isRepeatAnswer(res: Pick<Response, 'getHeader'>): boolean {
  return res.getHeader(REPEAT_ANSWER_HEADER) === '1'
}

/** Mark the response as a repeat when the answer's data counts earlier ones (core/hosts/repeat-answers.ts). */
export function markRepeatAnswerIf(res: Response, data: Record<string, unknown>): void {
  if (typeof data.repeats === 'number' && data.repeats > 0) markRepeatAnswer(res)
}

/**
 * The mark for a host route's refusal (host_exec, host_mcp_call, host_http, host_copy): a repeat
 * the answer's data counts (above), or a 429 "no slot free, nothing ran" for an op call that was
 * already refused that way. A busy call is asked again under its own op id (`x-walnut-op-id`):
 * the host's gateway resends it every few seconds until its time runs out (gateway-core.ts
 * busyRelayAgainMs), and each resend waits about 4 s for a slot first. 2026-11-23: the land link
 * relay's runs on clouddev filled its task's four places for ten minutes, and eight waiting calls
 * logged 92 warn lines, about twelve each, until the log-spike alarm rang. The first refusal of a
 * call is the signal (warn); its resends log at info, so a call that stays stuck reads as one warn
 * until an hour passes with no resend. A call with no op id stays a warn each.
 */
export function markHostRefusalRepeat(req: Pick<Request, 'method' | 'path' | 'headers'>, res: Response, err: { code: string; data: Record<string, unknown> }): void {
  markRepeatAnswerIf(res, err.data)
  const opId = req.headers['x-walnut-op-id']
  if (err.code !== 'busy' || typeof opId !== 'string' || !opId) return
  if (noteFinalAnswer(`busy\u0000${req.method} ${req.path}\u0000${opId.slice(0, 80)}`) > 0) markRepeatAnswer(res)
}
