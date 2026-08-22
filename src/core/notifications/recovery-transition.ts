/**
 * Failure→success edge detector for error-notification recovery.
 *
 * Every success point that can retire an error card is a POLL: git auto-commit
 * every 30s, plugin sync every 30s per plugin, the backup scheduler every 60s.
 * "Signal recovery whenever things are fine" would therefore mean a locked
 * read-modify-write scan of notifications.json forever, on a healthy box, to
 * change nothing. Recovery is an EDGE, and this is the per-key memory of which
 * side of it we were on.
 *
 * Its own leaf module (no imports at all) so the edge logic is unit-testable
 * without booting the poll loops — or the server — that it lives in.
 */

export interface RecoveryTransitionTracker {
  /**
   * Record the current health of `key`. Returns true exactly on the
   * failing→healthy edge, which is the caller's cue to signal recovery.
   */
  observe: (key: string, failing: boolean) => boolean;
  /** Forget all keys (tests, or a subsystem restarting). */
  reset: () => void;
}

export function createRecoveryTransitionTracker(): RecoveryTransitionTracker {
  const failing = new Map<string, boolean>();
  return {
    observe(key, isFailing) {
      const wasFailing = failing.get(key) === true;
      failing.set(key, isFailing);
      // Only failing → healthy fires. A first-ever healthy observation does NOT
      // (a box that has never failed has nothing to retire, and firing on boot
      // would scan the store on every restart), and a long run of healthy ticks
      // fires exactly once.
      return wasFailing && !isFailing;
    },
    reset() { failing.clear(); },
  };
}
