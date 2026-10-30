/**
 * How long a daemon link has been down while this machine was AWAKE.
 *
 * "Disconnected for more than 5 minutes" is when a session behind the link is
 * given up as dead. Measured on the wall clock, a Mac that sleeps with the link
 * down wakes up already past it: 2026-10-30 03:20 UTC the local daemon's link
 * closed as the Mac went to sleep, the Mac woke for a few seconds at 03:36, and
 * every local session's liveness check read 16 minutes "down" and declared its
 * live CLI dead. Nine tasks were handed back to the user mid-work, their leads
 * were told the turns had ended, and at 03:56 every one of them came back.
 *
 * No clock here skips sleep (hrtime keeps counting through it on Apple
 * Silicon; see core/event-loop-monitor.ts), so the down time is summed from
 * the checks themselves: each step between two looks at the link counts at
 * most STEP_CAP_MS. Awake, the liveness checks look every few seconds and the
 * sum follows the real time; across a sleep the gap counts one capped step.
 */
export const AWAKE_STEP_CAP_MS = 30_000

export class AwakeDownClock {
  private downMs = 0
  private lastAt: number | null = null

  /** The link went down at `at`. */
  start(at: number): void {
    this.downMs = 0
    this.lastAt = at
  }

  /** The link is up again. */
  reset(): void {
    this.downMs = 0
    this.lastAt = null
  }

  /** Awake time down so far, counting up to `now`. 0 while the link is up. */
  sample(now: number): number {
    if (this.lastAt === null) return 0
    this.downMs += Math.min(Math.max(0, now - this.lastAt), AWAKE_STEP_CAP_MS)
    this.lastAt = Math.max(this.lastAt, now)
    return this.downMs
  }
}
