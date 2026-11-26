/**
 * A 503 whose body says `host_reconnecting` (HOST_RECONNECTING, core/hosts/remote-read-bound.ts):
 * the route's designed answer that the host it reads through is not reachable now. Every route
 * that answers one carries that code (link-failure-answer.ts, the history, files and session
 * routes), in `code` or in a v1 `error.code`, so it is recognized here once, from the body,
 * whichever route sent it. Real use counts such an answer as unreachable, as an op call's is,
 * never as the route's own server error; any other 503 stays one (2026-11-23: deploys cut the
 * clouddev link and the history route's "Reconnecting" answers rang as its server errors).
 */
import type { Response } from 'express'
import { HOST_RECONNECTING } from '../../core/hosts/remote-read-bound.js'

const HOST_UNREACHABLE = Symbol('walnut.hostUnreachableAnswer')
type Marked = Response & { [HOST_UNREACHABLE]?: true }

/**
 * Every 503 code that says the machine the answer lives on is not reachable now: this host's own
 * (HOST_RECONNECTING) and a replica's words for its Mac or its bridge being away. Each literal 503 a
 * route answers is either one of these or listed as the route's own (tests/web/host-away-503-ratchet.test.ts),
 * so a new route's host-away answer cannot ring as its server error (2026-11-26: the budget route).
 */
export const HOST_AWAY_CODES: ReadonlySet<string> = new Set([
  HOST_RECONNECTING, 'bridge_offline', 'bridge_unavailable', 'bridge_unconfirmed', 'primary_unreachable', 'primary_unavailable', 'primary_only',
  'leader_only', 'needs_leader', 'vault_not_here', 'not_here',
])

function saysHostAway(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false
  const b = body as { code?: unknown; error?: unknown }
  if (typeof b.code === 'string' && HOST_AWAY_CODES.has(b.code)) return true
  const inner = !!b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : undefined
  return typeof inner === 'string' && HOST_AWAY_CODES.has(inner)
}

/** Watch this response's JSON body for a host-unreachable 503 (the request logger calls it once per request). */
export function watchHostUnreachableAnswer(res: Response): void {
  // A response with no JSON writer (a bare stub) has no body to read: nothing to watch.
  if (typeof res.json !== 'function') return
  const json = res.json.bind(res)
  res.json = ((body?: unknown) => {
    if (res.statusCode === 503 && saysHostAway(body)) (res as Marked)[HOST_UNREACHABLE] = true
    return json(body)
  }) as Response['json']
}

/** True when this response was a 503 saying its host is not reachable now. */
export function isHostUnreachableAnswer(res: Response): boolean {
  return res.statusCode === 503 && (res as Marked)[HOST_UNREACHABLE] === true
}
