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

/** Elapsed time that never runs slow, across sleep and wall-clock changes. */
export function createHolderClock(src: ClockSources = realSources): ElapsedClock {
  let mono = src.monotonic()
  let wall = src.wall()
  let elapsed = 0
  return {
    now() {
      const m = src.monotonic()
      const w = src.wall()
      // Each step counts the larger of the two clocks' advance since the last read, so the
      // sum is never below the monotonic time passed (a wall clock set back costs nothing)
      // and never misses a sleep the wall clock saw.
      elapsed += Math.max(m - mono, w - wall, 0)
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
