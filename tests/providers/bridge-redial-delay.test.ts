/**
 * The daemon's cloud bridge redial schedule (daemon-core.ts; mirrored inline in
 * daemon-source.ts): bridgeRedialStep, armsBridgeFastWindow and envTimerMs.
 *
 * Context:
 *  - matrix R1 (2026-10-02): the companion was down 32 s and came back, but the
 *    plain exponential backoff had already reached 32 s, so the next dial came
 *    34.5 s after it was up again. A drop of a healthy link now keeps redials
 *    short for a while.
 *  - gate P2 (2026-10-03): that window rearmed on every drop, so a flapping link
 *    stayed in it for good (8.5 to 9.7 dials a minute against 2.2 to 4.3), and
 *    its edge was a step (a 200 s outage waited longer than on the plain
 *    backoff). Only a link that had been up a while (or the first one lost)
 *    arms it, and the backoff resumes doubling from the fast cap.
 *  - gate P7: a negative test knob made a timer spin; knobs have a floor.
 */
import { describe, it, expect } from 'vitest'
import { bridgeRedialStep, armsBridgeFastWindow, envTimerMs, type BridgeRedialState } from '../../src/providers/daemon-core.js'

const MAX = 60_000
const FAST_MAX = 5_000
const WINDOW = 180_000
const ARM_UPTIME = 120_000

function state(overrides: Partial<BridgeRedialState>): BridgeRedialState {
  return { backoffMs: 1000, maxMs: MAX, jitter: 1, sinceDropMs: null, fastWindowMs: WINDOW, fastMaxMs: FAST_MAX, ...overrides }
}

/** The waits a run of refused dials gets, threading the backoff as scheduleBridgeRedial does. */
function schedule(armed: boolean, n: number, jitter = 1): number[] {
  const out: number[] = []
  let backoff = 1000
  let elapsed = 0
  for (let i = 0; i < n; i++) {
    const step = bridgeRedialStep(state({ backoffMs: backoff, jitter, sinceDropMs: armed ? elapsed : null }))
    out.push(step.delayMs)
    elapsed += step.delayMs
    backoff = step.nextBackoffMs
  }
  return out
}

/** How long after the companion is back (refused dials until then) the next dial lands. */
function lagAfter(outageMs: number, armed: boolean): number {
  let t = 0
  for (const d of schedule(armed, 400)) { t += d; if (t >= outageMs) return t - outageMs }
  throw new Error('never redialed')
}

describe('bridgeRedialStep', () => {
  it('with no fast window armed it is the plain capped exponential backoff', () => {
    expect(schedule(false, 10)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
  })

  it('inside the window the backoff stops doubling at the fast cap', () => {
    let backoff = 1000
    let elapsed = 0
    const seen: number[] = []
    while (elapsed < WINDOW) {
      const step = bridgeRedialStep(state({ backoffMs: backoff, jitter: 1.25, sinceDropMs: elapsed }))
      expect(step.delayMs).toBeLessThanOrEqual(FAST_MAX * 1.25)
      expect(step.nextBackoffMs).toBeLessThanOrEqual(FAST_MAX)
      seen.push(step.nextBackoffMs)
      elapsed += step.delayMs
      backoff = step.nextBackoffMs
    }
    expect(seen.slice(0, 4)).toEqual([2000, 4000, 5000, 5000])
  })

  it('past the window the backoff doubles on from the fast cap, with no jump at the edge', () => {
    const delays = schedule(true, 60)
    let elapsed = 0
    const after: number[] = []
    for (const d of delays) { if (elapsed >= WINDOW) after.push(d); elapsed += d }
    expect(after.slice(0, 6)).toEqual([5000, 10000, 20000, 40000, 60000, 60000])
  })

  it('a companion back within the window is redialed within one fast wait, and just past it sooner than on the plain backoff', () => {
    for (let outage = 1_000; outage < WINDOW; outage += 1_000) {
      expect(lagAfter(outage, true)).toBeLessThanOrEqual(FAST_MAX)
    }
    // R1: 32 s down. The plain backoff waited 31 s more.
    expect(lagAfter(32_000, false)).toBeGreaterThan(30_000)
    // Gate P2's step: 200 s down (just past the window) waited longer than on the plain backoff.
    expect(lagAfter(200_000, true)).toBeLessThanOrEqual(20_000)
    expect(lagAfter(200_000, true)).toBeLessThan(lagAfter(200_000, false))
  })

  it('the window costs a bounded number of dials (no storm)', () => {
    const delays = schedule(true, 200)
    let elapsed = 0
    let inWindow = 0
    for (const d of delays) { if (elapsed < WINDOW) inWindow++; elapsed += d }
    expect(inWindow).toBeLessThanOrEqual(Math.ceil(WINDOW / FAST_MAX) + 3)
  })

  it('jitter scales the capped wait and the result is a whole number of ms', () => {
    expect(bridgeRedialStep(state({ backoffMs: 32_000, sinceDropMs: 1000, jitter: 0.75 }))).toEqual({ delayMs: 3750, nextBackoffMs: 5000 })
    expect(bridgeRedialStep(state({ backoffMs: 32_000, sinceDropMs: null, jitter: 0.75 }))).toEqual({ delayMs: 24000, nextBackoffMs: 60000 })
    expect(bridgeRedialStep(state({ backoffMs: 1000, sinceDropMs: 1000, jitter: 0.8333 })).delayMs).toBe(833)
  })

  it('the fast cap never raises a wait above the normal cap', () => {
    expect(bridgeRedialStep(state({ backoffMs: 60_000, maxMs: 2000, sinceDropMs: 0 }))).toEqual({ delayMs: 2000, nextBackoffMs: 2000 })
  })
})

describe('armsBridgeFastWindow', () => {
  it('a link that had been up a while arms it, a short-lived one does not, and the first one lost always does', () => {
    expect(armsBridgeFastWindow({ uptimeMs: ARM_UPTIME, firstDrop: false, armUptimeMs: ARM_UPTIME })).toBe(true)
    expect(armsBridgeFastWindow({ uptimeMs: 3 * 3600_000, firstDrop: false, armUptimeMs: ARM_UPTIME })).toBe(true)
    expect(armsBridgeFastWindow({ uptimeMs: ARM_UPTIME - 1, firstDrop: false, armUptimeMs: ARM_UPTIME })).toBe(false)
    expect(armsBridgeFastWindow({ uptimeMs: 1000, firstDrop: true, armUptimeMs: ARM_UPTIME })).toBe(true)
  })

  // Gate P2's model: the link stays up `upMs`, drops, and dials are refused for
  // `downMs`; an open resets the backoff. Dials per hour against the plain backoff.
  function flapDialsPerHour(upMs: number, downMs: number, withWindow: boolean): number {
    const H = 3600_000
    let t = upMs
    let dials = 0
    let backoff = 1000
    let first = true
    let armedAt: number | null = null
    const drop = () => {
      armedAt = withWindow && armsBridgeFastWindow({ uptimeMs: upMs, firstDrop: first, armUptimeMs: ARM_UPTIME }) ? t : null
      first = false
    }
    drop()
    let outageEnd = t + downMs
    while (t < H) {
      const step = bridgeRedialStep(state({ backoffMs: backoff, sinceDropMs: armedAt != null ? t - armedAt : null }))
      backoff = step.nextBackoffMs
      t += step.delayMs
      dials++
      if (t >= outageEnd) { backoff = 1000; t += upMs; drop(); outageEnd = t + downMs }
    }
    return dials
  }

  it('a flapping link redials as often as on the plain backoff, give or take its first drop', () => {
    for (const [up, down] of [[20_000, 0], [20_000, 40_000], [60_000, 120_000]]) {
      const plain = flapDialsPerHour(up, down, false)
      const now = flapDialsPerHour(up, down, true)
      expect(now).toBeLessThanOrEqual(plain + Math.ceil(WINDOW / FAST_MAX))
      expect(now).toBeLessThanOrEqual(plain * 1.15)
    }
  })
})

describe('envTimerMs', () => {
  it('unset, junk and non-positive values give the default; anything else has a floor', () => {
    expect(envTimerMs(undefined, 15_000, 100)).toBe(15_000)
    expect(envTimerMs('', 15_000, 100)).toBe(15_000)
    expect(envTimerMs('fast', 15_000, 100)).toBe(15_000)
    expect(envTimerMs('-1', 15_000, 100)).toBe(15_000)
    expect(envTimerMs('0', 15_000, 100)).toBe(15_000)
    expect(envTimerMs('1', 15_000, 100)).toBe(100)
    expect(envTimerMs('250', 15_000, 100)).toBe(250)
  })
  // Gate 2026-10-04: parseInt read "1e9" as 1, so a knob meant to park a timer
  // ran it at the floor instead.
  it('reads the whole number: exponents count, a unit suffix is junk', () => {
    expect(envTimerMs('1e9', 15_000, 100)).toBe(1_000_000_000)
    expect(envTimerMs('2.5e3', 15_000, 100)).toBe(2_500)
    expect(envTimerMs('15s', 15_000, 100)).toBe(15_000)
    expect(envTimerMs(' 300 ', 15_000, 100)).toBe(300)
    expect(envTimerMs('100.6', 15_000, 100)).toBe(101)
    expect(envTimerMs('0.4', 15_000, 100)).toBe(15_000)
    expect(envTimerMs('Infinity', 15_000, 100)).toBe(15_000)
  })
  it('never goes above the longest delay a timer takes (Node runs a longer one after 1 ms)', () => {
    expect(envTimerMs('1e12', 15_000, 100)).toBe(2 ** 31 - 1)
    expect(envTimerMs(String(2 ** 31 - 1), 15_000, 100)).toBe(2 ** 31 - 1)
  })
})
