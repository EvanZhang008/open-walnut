/**
 * The ONLY sanctioned way to signal a process GROUP (negative pid).
 *
 * Why this exists (2026-08-09 incident, six GUI-session massacres in one day)
 * --------------------------------------------------------------------------
 * `process.kill(-1, sig)` does NOT throw EPERM as one might assume. POSIX
 * defines pid -1 as a BROADCAST: the signal goes to every process the caller
 * may signal. A pid of 1 (or 0, or any garbage ≤ 1) reaching a group-kill —
 * from a corrupted registry entry, a stale .pgid file, or a test fixture —
 * therefore SIGKILLs the user's entire login session: every app, Dock,
 * Finder. That exact failure tore down the user's Mac session six times on
 * 2026-08-09 before it was traced.
 *
 * A real spawned child can never have pid ≤ 1 (0 = "current group", 1 =
 * launchd/init), so the floor guard rejects nothing legitimate. Callers get
 * `false` back and must treat it like "process already gone".
 *
 * The self-contained daemon twins (daemon-source.ts / daemon-standalone.ts /
 * acp-daemon.ts) cannot import this file; they carry the same inline guard.
 * Keep all of them in sync.
 */
import { log } from '../logging/index.js'

/** True when the pid is plausibly a real spawned child (group leader). */
export function isSafeGroupPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

/**
 * Signal an entire process group. Returns true if the signal was delivered.
 * Refuses (loudly) any pid that cannot be a real child — see file header.
 */
export function safeKillProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!isSafeGroupPid(pid)) {
    log.session.error('REFUSED group kill: pid is not a real child pid — a kill(-pid) here would broadcast to the whole user session', {
      pid: String(pid),
      signal,
      stack: new Error().stack,
    })
    return false
  }
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}
