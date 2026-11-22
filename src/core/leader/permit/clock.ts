/**
 * The two clocks of the permission. Each side must err toward stopping:
 *
 * - The holder's clock must never run SLOW: its permission may only end early. A plain
 *   monotonic clock stops while the machine sleeps (macOS mach_absolute_time and Linux
 *   CLOCK_MONOTONIC leave suspend out), so a laptop that slept 90 s would wake with 90 s
 *   less counted and act on a permission that ran out on the witnesses. The holder counts
 *   on the machine's clock that includes sleep (Linux CLOCK_BOOTTIME, macOS
 *   mach_continuous_time: system-clock.ts), and counts the wall clock going forward too
 *   (a virtual machine's boot clock may miss a pause of its host). Where that cannot be read it takes the larger
 *   of the monotonic and the wall-clock time passed (kind 'mono-wall', marked on every
 *   record): sleep shows in the wall clock, a wall clock set back is covered by the
 *   monotonic one, and a wall clock set forward only ends the permission early.
 * - A witness's clock must never run FAST: it may only grant late. A plain monotonic
 *   clock does that; its pauses only make it wait longer.
 */
import type { ElapsedClock, HolderClockKind } from './types.js'
import { systemClocks } from './system-clock.js'

export interface ClockSources {
  monotonic: () => number
  wall: () => number
  /** The machine's clock that counts sleep (system-clock.ts), when it can be read. */
  boot?: { kind: 'boottime' | 'continuous'; now: () => number }
}

const realSources: ClockSources = { monotonic: () => performance.now(), wall: () => Date.now() }

/** The real sources: with the machine's sleep-counting clock where it can be read. */
export function systemClockSources(): ClockSources {
  const sys = systemClocks()
  return sys ? { ...realSources, boot: { kind: sys.kind, now: sys.boot } } : realSources
}

/** How far the wall clock may fall behind the monotonic one in a step before it is distrusted. */
export const WALL_BACK_TOLERANCE_MS = 1_000
/** What a distrusted step counts: longer than any permission, so the one held now ends. */
export const DISTRUST_STEP_MS = 3_600_000

/**
 * Elapsed time that never runs slow, across sleep and wall-clock changes.
 *
 * With the sleep-counting clock (src.boot), each step counts the largest of its advance, the
 * monotonic one's and the wall clock's advance when that went forward. The wall clock counts
 * only forward: inside a virtual machine whose host was suspended or paused, the guest's boot
 * clock may not count the pause, while the wall clock (put right after the pause) does. A wall
 * clock set forward then only ends the permission early; one set back changes nothing. A step
 * where the boot clock fell behind the monotonic one by more than WALL_BACK_TOLERANCE_MS (it
 * never should) counts DISTRUST_STEP_MS.
 *
 * Without it ('mono-wall'), each step counts the larger of the monotonic and the wall clock's
 * advance. A wall clock set back while the machine slept would hide the sleep from both (the
 * monotonic one stopped, the wall one went back), so a step where the wall clock fell behind
 * the monotonic one by more than WALL_BACK_TOLERANCE_MS counts DISTRUST_STEP_MS: whatever is
 * held now ends, and the next renew starts afresh (stress seed 3564 found it). The edge left
 * there: a set-back of almost exactly the length of the sleep; see the doc.
 */
export function createHolderClock(src: ClockSources = systemClockSources()): ElapsedClock & { kind: HolderClockKind } {
  const boot = src.boot
  let mono = src.monotonic()
  let wall = src.wall()
  let b = boot ? boot.now() : 0
  let elapsed = 0
  return {
    kind: boot ? boot.kind : 'mono-wall',
    now() {
      const m = src.monotonic()
      const w = src.wall()
      const dm = m - mono
      const dw = w - wall
      if (boot) {
        const x = boot.now()
        const db = x - b
        b = x
        elapsed += db < dm - WALL_BACK_TOLERANCE_MS ? DISTRUST_STEP_MS : Math.max(dm, db, dw, 0)
      } else {
        // Each step counts the larger of the two clocks' advance since the last read, so the
        // sum is never below the monotonic time passed and never misses a sleep the wall
        // clock saw.
        elapsed += dw < dm - WALL_BACK_TOLERANCE_MS ? DISTRUST_STEP_MS : Math.max(dm, dw, 0)
      }
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
