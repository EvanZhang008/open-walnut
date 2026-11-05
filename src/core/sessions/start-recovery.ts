/**
 * Start recovery: a session process that ended before it read its first line.
 *
 * 2026-11-05: under load 300 on the Mac, four sessions were killed while they
 * booted, and six tasks were started while clouddev's certificate had expired so
 * their start never reached the host. Each read as an error asking for a Retry,
 * its asker was told it errored, and the line it carried never ran. The runner
 * (claude-code-session.ts) knows, at the death and before it reports it, that the
 * process never read its line; restart recovery (session-auto-recover.ts
 * noteStartDied) takes the death on and starts the session again by itself. The
 * line itself stays a queue row (session-queue-park.ts START_RECOVERY_HELD_REASON),
 * so it keeps its id, its source and its words, and is never sent as a copy.
 *
 * Zero imports on purpose: the runner calls this synchronously from its exit
 * path, and the recovery registers the handler when it starts.
 */

export interface StartDeathHandler {
  /** Whether restart recovery takes the death on (it then starts the session again by itself). */
  take(sessionId: string): boolean
  /** The process did read its line after all (its init landed after its exit): no new start. */
  withdraw(sessionId: string): void
  /** Recovery still owns this death (it will release or park the held rows itself). */
  owns(sessionId: string): boolean
}

let handler: StartDeathHandler | null = null
let unreadProbe: ((sessionId: string) => boolean) | null = null

/** The recovery's entry (startSessionAutoRecover); null when it stops. */
export function setStartDeathHandler(next: StartDeathHandler | null): void {
  handler = next
}

/** Whether restart recovery took the death on. Never throws: false keeps the old error path. */
export function offerStartDeath(sessionId: string): boolean {
  try {
    return handler?.take(sessionId) ?? false
  } catch {
    return false
  }
}

/** A death offered above whose line was read after all. Never throws. */
export function withdrawStartDeath(sessionId: string): void {
  try { handler?.withdraw(sessionId) } catch { /* recovery then starts it again; the CLI skips a line it has (its uuid) */ }
}

/** Whether restart recovery still owns this session's start death. Never throws; false when no recovery runs. */
export function startRecoveryOwns(sessionId: string): boolean {
  try {
    return handler?.owns(sessionId) ?? false
  } catch {
    return false
  }
}

/**
 * The runner's view, for a death that reaches Walnut first as the daemon's dead
 * snapshot (before the runner's exit event): does this session's process still hold
 * a first line it never read, not yet offered? Hand-backs wait for the offer then.
 */
export function setUnreadFirstLineProbe(next: ((sessionId: string) => boolean) | null): void {
  unreadProbe = next
}

export function hasUnreadFirstLine(sessionId: string): boolean {
  try {
    return unreadProbe?.(sessionId) ?? false
  } catch {
    return false
  }
}
