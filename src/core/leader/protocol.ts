/**
 * Names and numbers both boxes agree on (docs/plan/walnut-control-plane.md).
 * No imports: the routes layer reads these at module load.
 */

/** The primary's heartbeat, a `mobile-event` frame down its own bridge to the companion. */
export const LEADER_HEARTBEAT_KIND = 'leader-heartbeat'

/** How often the primary sends it. The takeover window (60s by default) is four of these. */
export const LEADER_HEARTBEAT_MS = 15_000

/** How long a restart notice holds the takeover off: a deploy is back well within it. */
export const LEADER_RESTART_GRACE_MS = 5 * 60_000

/** What a heartbeat carries. */
export interface LeaderHeartbeatFrame {
  /** The primary's instance id: the name of the Walnut on every host's leader book. */
  walnutId: string
  /** The user lets the companion lead while the primary is away. */
  backup: boolean
  /** Set on the last heartbeat before a planned restart (a deploy). */
  restartingMs?: number
}
