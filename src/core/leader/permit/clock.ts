/**
 * The two clocks of the permission. Each side must err toward stopping:
 *
 * - The holder's clock must never run SLOW: its permission may only end early. A plain
 *   monotonic clock stops while the machine sleeps (macOS mach_absolute_time and Linux
 *   CLOCK_MONOTONIC leave suspend out), so a laptop that slept 90 s would wake with 90 s
 *   less counted and act on a permission that ran out on the witnesses. The holder takes
 *   the larger of the monotonic and the wall-clock time passed: sleep shows in the wall
 *   clock, a wall clock set back is covered by the monotonic one, and a wall clock set
 *   forward only ends the permission early.
 * - A witness's clock must never run FAST: it may only grant late. A plain monotonic
 *   clock does that; its pauses only make it wait longer.
 */
import type { ElapsedClock } from './types.js'

export interface ClockSources {
  monotonic: () => number
  wall: () => number
}

const realSources: ClockSources = { monotonic: () => performance.now(), wall: () => Date.now() }

/** How far the wall clock may fall behind the monotonic one in a step before it is distrusted. */
export const WALL_BACK_TOLERANCE_MS = 1_000
/** What a distrusted step counts: longer than any permission, so the one held now ends. */
export const DISTRUST_STEP_MS = 3_600_000

/**
 * Elapsed time that never runs slow, across sleep and wall-clock changes. A wall clock set
 * back while the machine slept would hide the sleep from both clocks (the monotonic one
 * stopped, the wall one went back), so a step where the wall clock fell behind the
 * monotonic one by more than WALL_BACK_TOLERANCE_MS counts DISTRUST_STEP_MS: whatever is
 * held now ends, and the next renew starts afresh (stress seed 3564 found it). The edge
 * left: a set-back of almost exactly the length of the sleep; see the doc.
 */
export function createHolderClock(src: ClockSources = realSources): ElapsedClock {
  let mono = src.monotonic()
  let wall = src.wall()
  let elapsed = 0
  return {
    now() {
      const m = src.monotonic()
      const w = src.wall()
      const dm = m - mono
      const dw = w - wall
      // Each step counts the larger of the two clocks' advance since the last read, so the
      // sum is never below the monotonic time passed and never misses a sleep the wall
      // clock saw.
      elapsed += dw < dm - WALL_BACK_TOLERANCE_MS ? DISTRUST_STEP_MS : Math.max(dm, dw, 0)
      mono = m
      wall = w
      return elapsed
    },
  }
}

/** Elapsed time that never runs fast: the monotonic clock alone. */
export function createWitnessClock(src: Pick<ClockSources, 'monotonic'> = realSources): ElapsedClock {
  return { now: () => src.monotonic() }
}
