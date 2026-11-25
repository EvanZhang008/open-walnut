/**
 * A feature here that refuses or degrades without a daemon capability asks for it through
 * `needCapability`, never a bare `hasCapability`: a daemon that lacks it is then updated now,
 * past the update gap (daemon-update-gap.ts), instead of leaving the feature cut off for up to
 * 2 hours. A plain check with a fallback that works (an optional probe) stays `hasCapability`,
 * which is only a read.
 *
 * tests/providers/daemon-capability-need-ratchet.test.ts finds every refusal of a missing daemon
 * capability in the source (DaemonNeedsUpgradeError, the daemon_needs_upgrade and daemon_upgrade
 * answers, the PTY's "needs an update" sentence, and the "is older than this Walnut" / "too old
 * for" words) and fails on one whose capability check is a bare `hasCapability`.
 */

/** A link to a daemon; `noteCapabilityNeed` is DaemonConnection's (a test's fake may have none). */
export interface CapabilityLink {
  hasCapability(cap: string): boolean
  noteCapabilityNeed?(cap: string): void
}

/** Whether the daemon has `cap`; when it does not, the link notes the need (once per running build). */
export function needCapability(conn: CapabilityLink, cap: string): boolean {
  if (conn.hasCapability(cap)) return true
  conn.noteCapabilityNeed?.(cap)
  return false
}

/**
 * The first link that has `cap`; when none of them has it, each notes the need. Never a need noted
 * on one link while a later one has it (a host reached two ways, one already updated).
 */
export function firstWithCapability<T extends CapabilityLink>(conns: readonly T[], cap: string): T | undefined {
  const able = conns.find((c) => c.hasCapability(cap))
  if (!able) for (const c of conns) needCapability(c, cap)
  return able
}
