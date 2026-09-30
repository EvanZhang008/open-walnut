/**
 * What the phones are told about a host's bridge: debounced, and never replayed.
 *
 * Why (replica, 2026-09-24 to 09-26): the Mac's bridge dropped and redialed
 * 222 times in three days, and most holes were shorter than two seconds
 * (median 1.4s; 189 of the 222 closed within 6s). Every drop
 * sent `bridge-offline` to every open session page and every redial sent
 * `bridge-online`, and both went into the session channel's replay buffer.
 * A phone that reconnected its stream later was replayed every one of them,
 * and the app treats each replayed `bridge-online` as a reason to refetch the
 * transcript (the fresh reads themselves are coalesced in bridge-read-history.ts).
 *
 * Rules:
 *   - `bridge-offline` goes out only after OFFLINE_ANNOUNCE_DELAY_MS of
 *     continuous absence; a redial inside that window says nothing at all;
 *   - `bridge-online` goes only to a page that was actually told offline;
 *   - both are live-only frames (`buffer: false`): presence is a current
 *     state, and a stream's attach frame already carries the current state;
 *   - a phone that opens a stream during the grace window is told online and
 *     joins the set the announcement (if it comes) will reach.
 */

import { emitSse, sseConnCount } from '../sse-channels.js'

export const OFFLINE_ANNOUNCE_DELAY_MS = 6_000

export function sessionChannelKey(sessionId: string): string {
  return `session:${sessionId}`
}

const offlineTimers = new Map<string, NodeJS.Timeout>()
/** Sessions per host whose pages were told `bridge-offline` and not yet `bridge-online`. */
const announcedOffline = new Map<string, Set<string>>()

function announced(host: string): Set<string> {
  let set = announcedOffline.get(host)
  if (!set) { set = new Set(); announcedOffline.set(host, set) }
  return set
}

/**
 * The host's bridge went away. Announce it once it has stayed away for the
 * grace window. `interested` is read when the timer fires, so pages that
 * attached during the window are included.
 */
export function scheduleOfflineAnnouncement(
  host: string,
  opts: { isConnected: () => boolean; interested: () => Iterable<string>; delayMs?: number },
): void {
  if (offlineTimers.has(host)) return
  const timer = setTimeout(() => {
    offlineTimers.delete(host)
    if (opts.isConnected()) return
    const told = announced(host)
    for (const sid of opts.interested()) {
      if (told.has(sid)) continue
      if (sseConnCount(sessionChannelKey(sid)) === 0) continue
      told.add(sid)
      emitSse(sessionChannelKey(sid), 'bridge-offline', {}, { buffer: false })
    }
  }, opts.delayMs ?? OFFLINE_ANNOUNCE_DELAY_MS)
  timer.unref?.()
  offlineTimers.set(host, timer)
}

/** The host is back (or being torn down on purpose): nothing left to announce. */
export function cancelOfflineAnnouncement(host: string): void {
  const timer = offlineTimers.get(host)
  if (timer) clearTimeout(timer)
  offlineTimers.delete(host)
}

/** Inside the grace window: the bridge is gone but the phones were not told. */
export function offlineAnnouncementPending(host: string): boolean {
  return offlineTimers.has(host)
}

/** A page attached while the host was already announced offline (its attach frame said so). */
export function markAnnouncedOffline(host: string, sessionId: string): void {
  announced(host).add(sessionId)
}

/** Tell one page the bridge is back, only if it was told it was gone. */
export function announceOnline(host: string, sessionId: string): boolean {
  const told = announcedOffline.get(host)
  if (!told?.delete(sessionId)) return false
  if (told.size === 0) announcedOffline.delete(host)
  emitSse(sessionChannelKey(sessionId), 'bridge-online', {}, { buffer: false })
  return true
}

/** A page's last stream closed: forget what it was told. */
export function forgetPresence(host: string, sessionId: string): void {
  const told = announcedOffline.get(host)
  told?.delete(sessionId)
  if (told && told.size === 0) announcedOffline.delete(host)
}

/** Shutdown / tests. */
export function clearBridgePresence(): void {
  for (const timer of offlineTimers.values()) clearTimeout(timer)
  offlineTimers.clear()
  announcedOffline.clear()
}
