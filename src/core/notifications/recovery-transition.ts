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
  /**
   * Whether `key` is currently on the failing side.
   *
   * For callers on a genuinely HOT path — the HTTP request logger runs per
   * request, the session-result handler per turn — where `observe(key, false)`
   * would otherwise insert a healthy entry for every key that has never failed.
   * That map would then grow with the route table and with every session id the
   * box ever saw, to remember something that can never fire. Pre-check with this
   * and only observe when there is an edge to detect.
   */
  isFailing: (key: string) => boolean;
  /**
   * Drop `key` entirely. For an unbounded key SPACE (session ids): after the
   * recovery edge has fired there is nothing left to remember, and keeping a
   * healthy entry per session would leak for the life of the process. A later
   * failure re-arms it from scratch.
   */
  forget: (key: string) => void;
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
    isFailing(key) { return failing.get(key) === true; },
    forget(key) { failing.delete(key); },
    reset() { failing.clear(); },
  };
}
