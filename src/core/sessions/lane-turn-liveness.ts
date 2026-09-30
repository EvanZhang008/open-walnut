/**
 * Liveness rule for one lane turn: how long has the CLI been silent?
 *
 * A lane turn used to fail on a 10-minute WALL CLOCK. The 2026-09-26 phone
 * incident was a 16.7-minute turn doing steady work (a background-task event
 * every 20 to 60 s): the server declared "did not answer" at 10:00, persisted an
 * error row, released the agent queue, and the answer that arrived 6.7 minutes
 * later was attached to the NEXT turn. Duration is not a failure; silence is.
 *
 * The threshold (LANE_TURN_STALL_MS in lane-turn.ts) comes from measured
 * silence on real lane transcripts, 30 days, 8,831 model calls:
 *   - tool runs WITHOUT a heartbeat (Read, Edit, Grep, WebFetch, MCP tools):
 *     p99 10 s, max 30 s;
 *   - tool runs WITH a heartbeat (Bash, Agent, Skill, TaskOutput) emit a
 *     tool_progress line every 30 s, so they are never silent longer than that;
 *   - model latency, user line to next assistant line (an UPPER bound, since
 *     the stream carries deltas meanwhile): p99 60 s, p99.9 375 s.
 * Waiting on a human (AskUserQuestion) is the only legitimately unbounded
 * silence, and that turn is better failed and answered late than held forever.
 *
 * Sleep-aware: a tick that arrives far later than scheduled means this process
 * did not run (system sleep, a stopped process, a starved loop). That gap is
 * not the CLI's silence, so it is credited back instead of counted.
 */

/** A tick later than this multiple of the cadence is treated as a suspension. */
const SUSPEND_FACTOR = 3

export interface StallClock {
  /** Record progress at `at` (epoch ms). Older stamps are ignored. */
  progress(at: number): void
  /** Advance to `now` and return the sleep-corrected silence in ms. */
  tick(now: number): number
  /** Restart the silence window at `now` (a new phase begins). */
  reset(now: number): void
}

export function createStallClock(startAt: number, tickMs: number): StallClock {
  let progressAt = startAt
  let lastTickAt = startAt
  return {
    progress(at: number): void {
      if (at > progressAt) progressAt = at
    },
    tick(now: number): number {
      const gap = now - lastTickAt
      lastTickAt = now
      if (gap > tickMs * SUSPEND_FACTOR) {
        // Credit the suspended stretch: only one normal tick of it may count.
        progressAt = Math.min(now, progressAt + (gap - tickMs))
      }
      return Math.max(0, now - progressAt)
    },
    reset(now: number): void {
      progressAt = now
      lastTickAt = now
    },
  }
}
