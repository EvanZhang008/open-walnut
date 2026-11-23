/**
 * The sessions a start the leader handed this host names by their preassigned id
 * (session-channel/host-routes.ts start). Such a session is this host's from its first write: the
 * leader marked its seed row this host's before it sent the start (host-judged-runner.ts
 * handSeedToHost), but the host's copy of that row may still be an older version, from before the
 * mark, and may come down before or after the start (replication rounds). session-db.ts reads this
 * list to treat the row as this host's own in either order (claimStartingRow, applySessionCopy).
 *
 * Bounded: a claim lasts CLAIM_TTL_MS, long past any start; at most CLAIM_MAX are kept.
 */

export const CLAIM_TTL_MS = 10 * 60_000
const CLAIM_MAX = 2_000

interface Claim {
  at: number
  /** The row as the copy had it before the claim made it this host's (a raw store row), to put back if the start fails. */
  before?: Record<string, unknown>
  /** The payload the claim wrote, to tell whether anything wrote the row since. */
  wrote?: string
}

const claims = new Map<string, Claim>()

export function claimStart(sid: string, now = Date.now()): void {
  if (!sid) return
  claims.delete(sid)
  if (claims.size >= CLAIM_MAX) claims.delete(claims.keys().next().value!)
  claims.set(sid, { at: now })
}

export function isClaimed(sid: string, now = Date.now()): boolean {
  const c = claims.get(sid)
  if (!c) return false
  if (now - c.at > CLAIM_TTL_MS) { claims.delete(sid); return false }
  return true
}

/** The claim made `sid`'s copied row this host's: what it was, and what the claim wrote. */
export function noteClaimAdopted(sid: string, before: Record<string, unknown>, wrote: string): void {
  const c = claims.get(sid)
  if (c) { c.before = before; c.wrote = wrote }
}

/** The start is over without a session here: the claim goes, with what it adopted (if anything). */
export function releaseClaim(sid: string): Claim | null {
  const c = claims.get(sid) ?? null
  claims.delete(sid)
  return c
}

export function _resetStartingClaimsForTesting(): void {
  claims.clear()
}
