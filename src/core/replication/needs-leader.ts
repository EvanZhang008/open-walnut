/**
 * A write a host replica must not make itself (docs/plan/walnut-replica-servers-impl.md,
 * sections 3 and 4, WP5): the store it would write is a copy of the Mac's
 * (config.yaml, ui prefs, favorites, routines, the Ask conversation list), so
 * the write waits for the Mac. The web error handler answers it as the
 * dispatcher answers a `needs-leader` row: `503 {error:{code:'needs_leader', why, retryAfter}}`.
 */

export const NEEDS_LEADER_MESSAGE = 'This needs your Mac, which is not answering right now.'

export class NeedsLeaderError extends Error {
  readonly code = 'needs_leader'
  readonly status = 503
  constructor(readonly why: string, message = NEEDS_LEADER_MESSAGE) {
    super(message)
    this.name = 'NeedsLeaderError'
  }
}

export function isNeedsLeaderError(err: unknown): err is NeedsLeaderError {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'needs_leader' && typeof (err as { why?: unknown }).why === 'string'
}

/** The 503 body, the same shape the replica dispatcher sends (replica/dispatch.ts); `message` is the refusal's own sentence. */
export function needsLeaderBody(why: string, message = NEEDS_LEADER_MESSAGE): { error: { code: 'needs_leader'; why: string; retryAfter: number; message: string } } {
  return { error: { code: 'needs_leader', why, retryAfter: 5, message: message || NEEDS_LEADER_MESSAGE } }
}

/**
 * The headers the dispatcher sends with its needs-leader 503 (replica/dispatch.ts
 * ANSWERED_VIA_HEADER, `retry-after`), so a client tells this 503 from the
 * dispatcher's by nothing (the offline header needs the dispatcher's device check).
 */
export const NEEDS_LEADER_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'retry-after': '5', 'x-walnut-answered-via': 'replica' })

const lastLogged = new Map<string, number>()

/** At most one log line per why a minute: a tab whose sync retries must not flood the replica log. */
export function shouldLogNeedsLeader(why: string, now = Date.now()): boolean {
  const at = lastLogged.get(why)
  if (at !== undefined && now - at < 60_000) return false
  lastLogged.set(why, now)
  return true
}
