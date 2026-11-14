/**
 * The upload pace a host's connection learns (src/lib/adaptive-pace.ts), with no setting:
 *
 *   - no memory is unpaced; a plain host never cut stays unpaced however much it uploads;
 *   - a cut while uploading paces at a third of the rate it came at, and a relay like the
 *     measured one ("cut above 20 KB/s") is met within at most 5 cuts from 500 KB/s;
 *   - only demand probes up (+20% per 10 minutes of it), under 0.8 x the ceiling while the cut
 *     is within 24 h; after that the ceiling is forgotten and probing goes on to unpaced;
 *   - a close with no upload in flight, a stop by Walnut, or a close while the host's whole
 *     link dropped teach nothing;
 *   - kept memory that is not this shape reads as none.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PACE_RULES, cutTeaches, learnFromCut, noteDemand, paceLimits, validPaceMemory, type PaceMemory, type PaceRules,
} from '../../src/lib/adaptive-pace.js'
import { CHANNEL_RULES } from '../../src/providers/upload-pace.js'

const KB = 1024
const MIN = 60_000
const HOUR = 60 * MIN

/** A connection that offers `offered` B/s and is held to the pace; the relay cuts it above `cutAbove`. */
function runAgainstRelay(rules: PaceRules, offered: number, cutAbove: number, maxConnections = 20) {
  let mem: PaceMemory | null = null
  let cuts = 0
  for (let i = 0; i < maxConnections; i++) {
    const limits = paceLimits(mem, rules)
    const reached = Math.min(offered, limits?.bytesPerSec ?? Infinity)
    if (reached <= cutAbove) return { mem, cuts, reached }
    cuts++
    mem = learnFromCut(mem, { at: i * 1000, measured: reached, cap: limits?.bytesPerSec ?? null }, rules)
  }
  return { mem, cuts, reached: NaN }
}

describe('adaptive upload pace', () => {
  it('a host with no memory is unpaced', () => {
    expect(paceLimits(null)).toBeNull()
  })

  it('a cut at about 500 KB/s meets a relay that cuts above 20 KB/s within at most 5 cuts, on both channels', () => {
    for (const rules of [CHANNEL_RULES.bulk, CHANNEL_RULES.lane]) {
      const r = runAgainstRelay(rules, 500 * KB, 20 * KB)
      expect(r.cuts).toBeGreaterThan(0)
      expect(r.cuts).toBeLessThanOrEqual(5)
      expect(r.reached).toBeLessThanOrEqual(20 * KB)
      const limits = paceLimits(r.mem, rules)!
      // A small burst: 1.5 s of the pace, at least 16 KB.
      expect(limits.burstBytes).toBe(Math.max(16 * KB, Math.round(limits.bytesPerSec * 1.5)))
    }
  })

  it('a plain host never cut stays unpaced, however long it uploads', () => {
    const r = runAgainstRelay(DEFAULT_PACE_RULES, 50 * 1024 * KB, Infinity)
    expect(r.cuts).toBe(0)
    expect(r.mem).toBeNull()
    // Demand on no memory changes nothing.
    expect(noteDemand(null, { at: 10 * HOUR, ms: 10 * HOUR })).toEqual({ mem: null, changed: false })
  })

  it('a cut paces at a third of the lower of the measured rate and the cap, never under the floor', () => {
    const first = learnFromCut(null, { at: 0, measured: 300 * KB, cap: null })!
    expect(first.ceiling).toBe(300 * KB)
    expect(first.rate).toBe(100 * KB)
    // Measured above the cap (bytes sitting in buffers): the cap is the rate reached.
    const second = learnFromCut(first, { at: 1, measured: 900 * KB, cap: 30 * KB })!
    expect(second.ceiling).toBe(30 * KB)
    expect(second.rate).toBe(10 * KB)
    const third = learnFromCut(second, { at: 2, measured: 6 * KB, cap: 10 * KB })!
    expect(third.rate).toBe(DEFAULT_PACE_RULES.floor)
    // The bulk channel's floor keeps a 1 MB frame under the daemon's keepalive.
    expect(learnFromCut(null, { at: 0, measured: 3 * KB, cap: null }, CHANNEL_RULES.bulk)!.rate).toBe(CHANNEL_RULES.bulk.floor)
    // A cut never raises the pace: one from a connection that began at an older, higher pace.
    expect(learnFromCut(second, { at: 3, measured: 600 * KB, cap: 300 * KB })!.rate).toBe(10 * KB)
    // A cut whose last seconds carried little (a pause between frames) still counts half the pace
    // in force: the ceiling never falls under it, so the pace is not pinned at the floor.
    const paused = learnFromCut(first, { at: 4, measured: 1 * KB, cap: 100 * KB })!
    expect(paused.ceiling).toBe(50 * KB)
    expect(paused.rate).toBeCloseTo(50 * KB / 3)
    // A cut with no rate to read (nothing measured, unpaced) teaches nothing.
    expect(learnFromCut(null, { at: 0, measured: 0, cap: null })).toBeNull()
  })

  it('probes up only with demand: +20% per 10 minutes of it, under 0.8 x the ceiling while the cut is recent', () => {
    let mem: PaceMemory | null = learnFromCut(null, { at: 0, measured: 30 * KB, cap: null })!
    expect(mem.rate).toBe(10 * KB)
    // Time alone does nothing: only noteDemand moves it, and 9 minutes of it is not enough.
    let r = noteDemand(mem, { at: 5 * HOUR, ms: 9 * MIN })
    expect(r.changed).toBe(false)
    expect(r.mem!.rate).toBe(10 * KB)
    r = noteDemand(r.mem, { at: 5 * HOUR, ms: MIN })
    expect(r.changed).toBe(true)
    expect(r.mem!.rate).toBeCloseTo(12 * KB)
    mem = r.mem
    const rates: number[] = []
    for (let i = 0; i < 10; i++) { mem = noteDemand(mem, { at: 6 * HOUR + i * 10 * MIN, ms: 10 * MIN }).mem; rates.push(mem!.rate) }
    expect(Math.max(...rates)).toBeCloseTo(0.8 * 30 * KB)
    expect(mem!.ceiling).toBe(30 * KB)
  })

  it('after 24 h with no cut the ceiling is forgotten and probing goes on until unpaced', () => {
    let mem: PaceMemory | null = learnFromCut(null, { at: 0, measured: 30 * KB, cap: null })!
    let r = noteDemand(mem, { at: 24 * HOUR, ms: MIN })
    expect(r.changed).toBe(true)
    expect(r.mem!.ceiling).toBeNull()
    expect(r.mem!.rate).toBe(10 * KB)
    mem = r.mem
    let probes = 0
    while (mem && probes < 50) { mem = noteDemand(mem, { at: 25 * HOUR + probes * 10 * MIN, ms: 10 * MIN }).mem; probes++ }
    expect(mem).toBeNull()
    expect(paceLimits(mem)).toBeNull()
    // Doubling from 10 KB/s past 1 MB/s: 7 probes, about 70 minutes of demand.
    expect(probes).toBe(7)
  })

  it('only a connection that ended by itself while uploading teaches', () => {
    const base = { byWalnut: false, sinceSentMs: 200, queuedBytes: 0, hostLinkDropped: false }
    expect(cutTeaches(base)).toBe(true)
    expect(cutTeaches({ ...base, sinceSentMs: null, queuedBytes: 64 * KB })).toBe(true)
    // No upload in flight: its last byte went long before, nothing waited.
    expect(cutTeaches({ ...base, sinceSentMs: 60_000 })).toBe(false)
    expect(cutTeaches({ ...base, sinceSentMs: null })).toBe(false)
    // Walnut stopped it (a redial, a teardown).
    expect(cutTeaches({ ...base, byWalnut: true, queuedBytes: 64 * KB })).toBe(false)
    // The host's whole link went down too (sleep, network loss).
    expect(cutTeaches({ ...base, hostLinkDropped: true, queuedBytes: 64 * KB })).toBe(false)
  })

  it('kept memory of another shape reads as none', () => {
    expect(validPaceMemory(learnFromCut(null, { at: 1, measured: 30 * KB, cap: null }))).toBe(true)
    for (const bad of [null, 'x', 42, [], {}, { rate: 'fast' }, { rate: -1, ceiling: null, cutAt: 1, at: 1, demandMs: 0 },
      { rate: 10, ceiling: 0, cutAt: 1, at: 1, demandMs: 0 }, { rate: 10, ceiling: null, cutAt: 'x', at: 1, demandMs: 0 }]) {
      expect(validPaceMemory(bad)).toBe(false)
    }
  })
})
