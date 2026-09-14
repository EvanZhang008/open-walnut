/**
 * A 5xx the route EXPECTED and already reported to the user is not an endpoint incident.
 *
 * `POST .../linked/update` answers 502 when the user's own git remote refuses the fetch and
 * 504 when git outruns its deadline. The status is honest (an upstream failed), and the row
 * in Settings, Plugins already says so in one sentence with a Details fold. But the request
 * logger turns every 5xx except 501 into a red incident card plus an inbox notification with
 * an "Ask AI to fix" button, for a condition Walnut cannot fix (N3-1). One place says it: the
 * row. A route that has handled its failure marks the response with this header and the
 * logger treats it like a 4xx: in the request log at warn, never a card.
 *
 * A header rather than `res.locals` so the same contract holds through a proxy or a bridge
 * relay, and so a test can read it off the response.
 */
import type { Response } from 'express'

export const HANDLED_FAILURE_HEADER = 'x-walnut-handled-failure'

export function markHandledFailure(res: Response): Response {
  res.setHeader(HANDLED_FAILURE_HEADER, '1')
  return res
}

/** True when the route said the failure is its own designed answer (see markHandledFailure). */
export function isHandledFailure(res: Pick<Response, 'getHeader'>): boolean {
  return res.getHeader(HANDLED_FAILURE_HEADER) === '1'
}
