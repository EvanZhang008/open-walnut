/**
 * The ONE human sentence every /api/v1 route uses when the primary box's bridge
 * is not there. Extracted from session-launch-v1.ts (which owned it first) so
 * the phone reads the same answer on a launch, a control action and a relayed
 * lifecycle call: three routes used to answer the identical outage with three
 * different sentences, one of which said nothing at all about how long it had
 * been going on.
 *
 * Copy only. The frozen v1 error code stays `bridge_offline` and no caller's
 * status, timing or retry behaviour belongs in here.
 */

/** `3` → `3 seconds`, `1` → `1 minute`. */
function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/**
 * Coarse, phone-readable elapsed time. Null when there is nothing worth saying
 * (a sub-second value, or a clock that ran backwards) — a wrong duration is
 * worse than none.
 */
export function humanizeElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1_000) return null
  const secs = Math.round(ms / 1_000)
  if (secs < 60) return plural(secs, 'second')
  const mins = Math.round(secs / 60)
  if (mins < 60) return plural(mins, 'minute')
  return plural(Math.round(mins / 60), 'hour')
}

/**
 * The 503 body when the primary's bridge is not there. The code is frozen
 * (`bridge_offline`); this is only the human sentence, and it is the whole point
 * of the change: the 2026-09-17 report was a MacBook asleep with the lid shut,
 * unreachable in 8-to-15-minute stretches, and "try again when it reconnects"
 * reads identically to a 2-second redial hole. With a known duration the user can
 * tell the two apart and act ("open the lid"); without one we stay vague rather
 * than invent a number. `waitedMs` is 0 when no wait happened, because claiming
 * a wait we did not do is the same kind of lie in the other direction.
 *
 * Plain sentences, no dashes: this string is read on a phone.
 */
export function bridgeOfflineMessage(lastLossAt: number | null, waitedMs: number): string {
  const downFor = lastLossAt === null ? null : humanizeElapsed(Date.now() - lastLossAt)
  const waited = waitedMs > 0 ? ` Waited ${Math.round(waitedMs / 1000)}s for it to reconnect.` : ''
  if (!downFor) {
    return `No live bridge to the primary box. Your primary box (Mac) is asleep or offline.${waited}`
  }
  return `Your primary box (Mac) has been unreachable for ${downFor}. `
    + `It may be asleep (open the lid) or offline.${waited}`
}
