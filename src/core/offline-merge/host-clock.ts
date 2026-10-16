/**
 * Each host's clock as measured on its daemon link (docs/plan/walnut-replica-servers-impl.md
 * section 5, "Clock"): `offline.drain` answers `{now}` (the daemon's wall clock), and this
 * server keeps `offset = macNow - daemonNow - rtt/2`, so a host time plus the offset is
 * the same instant on this server's clock.
 *
 * Two readers: the drain shifts every record's `at` by it (a replayed field write stamps
 * the shifted time as `field_at`), and the op-id middleware judges a forwarded write's
 * `x-walnut-forwarded-at` with it. No measurement for a host = null: the middleware then
 * never refuses on age, and the drain uses the record's own time.
 */

export interface HostClock {
  /** Add to a host time to get this server's time. */
  offsetMs: number;
  /** The round trip of the measuring call. */
  rttMs: number;
  /** When it was measured (this server's clock). */
  at: number;
}

const clocks = new Map<string, HostClock>();

/**
 * Record one measurement: `sentAt` and `receivedAt` on this server's clock around the call,
 * `daemonNow` the host's clock in the reply. A reply with no usable time records nothing.
 */
export function measureHostClock(hostKey: string, sentAt: number, receivedAt: number, daemonNow: unknown): HostClock | null {
  if (!hostKey || typeof daemonNow !== 'number' || !Number.isFinite(daemonNow) || daemonNow <= 0) return null;
  const rttMs = Math.max(0, receivedAt - sentAt);
  const offsetMs = Math.round(receivedAt - daemonNow - rttMs / 2);
  const clock: HostClock = { offsetMs, rttMs, at: receivedAt };
  const prev = clocks.get(hostKey);
  // A slow round trip measures worse: keep the earlier reading when it is recent and tighter.
  if (prev && prev.rttMs < rttMs && receivedAt - prev.at < 5 * 60_000) return prev;
  clocks.set(hostKey, clock);
  return clock;
}

/** The host's measured offset, or null when this server never measured it. */
export function hostClockOffset(hostKey: string): number | null {
  return clocks.get(hostKey)?.offsetMs ?? null;
}

/** A host time on this server's clock (unshifted when the host was never measured). */
export function shiftHostTime(hostKey: string, hostAt: number): number {
  const off = hostClockOffset(hostKey);
  return off === null ? hostAt : hostAt + off;
}

/** Tests only. */
export function _setHostClockForTesting(hostKey: string, offsetMs: number | null): void {
  if (offsetMs === null) clocks.delete(hostKey);
  else clocks.set(hostKey, { offsetMs, rttMs: 0, at: Date.now() });
}

/** Tests only. */
export function _resetHostClocksForTesting(): void {
  clocks.clear();
}
