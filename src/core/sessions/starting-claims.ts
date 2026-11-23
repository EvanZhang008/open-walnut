/**
 * The sessions a start the leader handed this host names by their preassigned id
 * (session-channel/host-routes.ts start). Such a session is this host's from its first write: the
 * leader marked its seed row this host's before it sent the start (host-judged-runner.ts
 * handSeedToHost), but the host's copy of that row may still be an older version, from before the
 * mark, and may come down before or after the start (replication rounds). session-db.ts reads this
 * list to treat the row as this host's own in either order (claimStartingRow, applySessionCopy), and the
 * sweep that gives a row back to the leader leaves a claimed one alone (stranded-own-rows.ts).
 *
 * Bounded: a claim lasts CLAIM_TTL_MS, long past any start; at most CLAIM_MAX are kept.
 */

export const CLAIM_TTL_MS = 10 * 60_000
const CLAIM_MAX = 2_000

const claims = new Map<string, { at: number }>()

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

/**
 * The start is over without a session here: the claim goes. What it adopted is given back by the
 * sweep of rows the leader disowns (stranded-own-rows.ts), from the leader version kept on disk.
 */
export function releaseClaim(sid: string): void {
  claims.delete(sid)
}

export function _resetStartingClaimsForTesting(): void {
  claims.clear()
}
