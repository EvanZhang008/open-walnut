/**
 * One rule for every replica (core/server-role.ts: the companion over its bridge, a host replica
 * over its daemon's link): a read of bytes only the leader has (a file of the Mac's) whose link
 * to the leader just dropped waits for the link and tries again, inside one deadline and a few
 * tries, before it answers that the leader is out of reach. A read is safe to repeat; a write
 * never takes this path. Callers: the companion's file relay (web/routes/file-content-bridge.ts
 * readBridgeFile) and a host replica's dispatcher (replica/dispatch.ts, rows marked leaderRead).
 * 2026-11-10: a bridge redial and a Mac deploy each cut a phone's read for a few seconds, and the
 * phone's retry met the gap.
 */

/**
 * The waits of one read for the link: no wait goes past it, and no try starts after it. A try
 * started just before it still has its own open and read time.
 */
export const LEADER_READ_DEADLINE_MS = 15_000
/** Tries of one read, the first included: every request to the leader counts, a resend on a dropped link too. */
export const LEADER_READ_MAX_TRIES = 3

/**
 * Whether a read that just failed on a dropped link may try again. `dropRecent`: the link to
 * the leader is back, or it dropped inside the deadline (a leader that was gone longer is away,
 * and the read answers at once).
 */
export function mayTryLeaderReadAgain(
  o: { tries: number; startedAt: number; now: number; dropRecent: boolean },
  deadlineMs = LEADER_READ_DEADLINE_MS,
): boolean {
  return o.dropRecent && o.tries < LEADER_READ_MAX_TRIES && o.now - o.startedAt < deadlineMs
}
