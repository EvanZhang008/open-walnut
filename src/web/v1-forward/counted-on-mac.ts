/**
 * Which of the companion's answers the Mac counts in its real use (core/usage-watch), so the
 * companion's own count (usage-watch/companion-uses.ts) leaves them out.
 *
 * The Mac counts every request it runs through its Express (v1-forward/target.ts, stream-door.ts).
 * On the companion:
 *   - an answer the Mac gave carries `X-Walnut-Answered-By: primary` (proxy.ts, stream-forward.ts,
 *     routes/favorites.ts), whether a middleware or a route handler forwarded it (2026-11-24 review:
 *     the console's search forwards from inside its route, and was counted on both boxes);
 *   - a call that reached the Mac and whose answer did not come back (too large to carry, or none in
 *     time) ran there too: the companion's own answer after it is marked here.
 * A call that never reached the Mac is the companion's to count.
 */
import type { Response } from 'express'

const MARK = 'walnutCountedOnMac'

/** The Mac ran this call; what the companion answers now is not counted a second time. */
export function markCountedOnMac(res: Response): void {
  res.locals[MARK] = true
}

export function countedOnMac(res: Response): boolean {
  return res.getHeader('x-walnut-answered-by') === 'primary' || res.locals?.[MARK] === true
}
