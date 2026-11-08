/**
 * When each host's link last dropped, so a host whose link keeps falling and coming back
 * reads as unstable instead of "Connected" (2026-11-08: a laptop on the host network dropped
 * every 30 s for hours; Hosts, the banner and host_list all said Connected between drops).
 *
 * Kept per host at module level, like daemon-reconnect-cause.ts: the pool replaces a
 * DaemonConnection instance (poolSet), and the count must outlive it. Only a link that was
 * up and fell counts; a planned daemon swap and a deliberate disconnect do not.
 */

/** How far back drops are kept (the flapping rule in host-problem.ts reads a shorter window). */
export const LINK_DROPS_KEEP_MS = 60 * 60_000
/** At most this many drops per host are kept (newest last). */
export const LINK_DROPS_MAX = 50

const drops = new Map<string, number[]>()

export function noteLinkDrop(host: string, at = Date.now()): void {
  const kept = (drops.get(host) ?? []).filter((t) => at - t < LINK_DROPS_KEEP_MS)
  kept.push(at)
  drops.set(host, kept.slice(-LINK_DROPS_MAX))
}

/** The host's link drops of the last hour (epoch ms, oldest first), or undefined when none. */
export function recentLinkDrops(host: string, now = Date.now()): number[] | undefined {
  const kept = (drops.get(host) ?? []).filter((t) => now - t < LINK_DROPS_KEEP_MS && t <= now)
  if (!kept.length) {
    drops.delete(host)
    return undefined
  }
  drops.set(host, kept)
  return kept
}

/** Forget a host's drops (it was removed from config). */
export function clearLinkDrops(host: string): void {
  drops.delete(host)
}

/** Test seam. */
export function resetLinkDropsForTest(): void {
  drops.clear()
}
