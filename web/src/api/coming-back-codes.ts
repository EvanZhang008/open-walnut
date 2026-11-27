/**
 * Error codes that say the answer is coming back by itself: the machine it lives on is not
 * reachable now (the server's HOST_AWAY_CODES, src/web/middleware/host-unreachable-answer.ts),
 * Walnut itself is not reachable, or a plugin is still starting after a restart. A page that gets
 * one keeps what it shows and asks again; it is not a failure of the page. The API client logs such
 * an answer as a warning, so the browser error log (and the audits that read it) never counts the
 * few seconds of every server restart (2026-11-27: 218 "history unavailable" errors in one day).
 * tests/web/coming-back-codes.test.ts keeps this list equal to the server's.
 */
export const COMING_BACK_CODES: ReadonlySet<string> = new Set([
  'host_reconnecting', 'bridge_offline', 'bridge_unavailable', 'bridge_unconfirmed', 'primary_unreachable',
  'primary_unavailable', 'primary_only', 'leader_only', 'needs_leader', 'vault_not_here', 'not_here',
  'walnut_unreachable', 'plugin_starting',
])

/** The code of an error body, in either shape a route answers: `{ code }` or `{ error: { code } }`. */
export function errorBodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as { code?: unknown; error?: unknown }
  if (typeof b.code === 'string') return b.code
  const inner = b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : undefined
  return typeof inner === 'string' ? inner : undefined
}

/** A 503 whose body says its answer is coming back by itself. */
export function isComingBackAnswer(status: number, body: unknown): boolean {
  const code = errorBodyCode(body)
  return status === 503 && code !== undefined && COMING_BACK_CODES.has(code)
}
