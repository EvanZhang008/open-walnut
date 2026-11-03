/**
 * Claude Code processes that still run in a login session macOS has ended.
 *
 * When this server replaces a local daemon that lived in an ended session
 * (local-daemon.ts, login-session.ts), the new daemon adopts the CLIs the old one
 * started, and each of them keeps the old session's environment: no user lookup
 * (ssh fails), no DNS. They are never killed for it: the idle reaper stops each
 * one soon after its turn is over (ENDED_SESSION_IDLE_TIMEOUT_MS instead of an
 * hour, with every exemption the reaper has: background work, a /loop, a
 * pending permission), and the next message resumes it under the new daemon.
 * Keyed by session and pid, so a session that already runs a new process is no
 * longer one. In memory: a server restart forgets them, and they fall back to
 * the ordinary idle timeout.
 */

/** How long a marked CLI may sit idle after its turn before the reaper stops it. */
export const ENDED_SESSION_IDLE_TIMEOUT_MS = 60_000

const marked = new Map<string, number>()

export function markEndedSessionClis(clis: Iterable<{ claudeSessionId: string; pid?: number | null }>): number {
  let n = 0
  for (const c of clis) {
    if (typeof c.pid !== 'number' || c.pid <= 1) continue
    marked.set(c.claudeSessionId, c.pid)
    n++
  }
  return n
}

export function isEndedSessionCli(session: { claudeSessionId: string; pid?: number | null }): boolean {
  const pid = marked.get(session.claudeSessionId)
  if (pid === undefined) return false
  if (pid !== session.pid) { marked.delete(session.claudeSessionId); return false }
  return true
}

export function clearEndedSessionClisForTest(): void {
  marked.clear()
}
