/**
 * Memory pressure monitor (src/core/memory-pressure.ts): level parsing, the
 * shedding hysteresis and its hold backoff, who hears a flip, the kill switch,
 * and the history cache budget that shrinks under pressure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  levelFromDarwin,
  levelFromPsi,
  nextShedState,
  initialShedState,
  HOLD_BACKOFF_MAX_FACTOR,
  type ShedState,
  applyPressureReading,
  applyMemoryReading,
  memoryPressureSnapshot,
  memoryPressureShedding,
  memoryPressureLevel,
  onMemoryPressureChange,
  startMemoryPressureMonitor,
  _resetMemoryPressureForTest,
  _setPressureHoldMsForTest,
} from '../../src/core/memory-pressure.js'
import {
  setHistoryCacheShedding,
  _historyCacheSetForTesting,
  _historyCacheStateForTesting,
  _resetHistoryCacheForTesting,
} from '../../src/core/session-history.js'
import { log } from '../../src/logging/index.js'

describe('level parsing', () => {
  it('maps the macOS kernel level (1 normal, 2 warn, 4 critical)', () => {
    expect(levelFromDarwin(1)).toBe('normal')
    expect(levelFromDarwin(2)).toBe('warn')
    expect(levelFromDarwin(4)).toBe('critical')
    expect(levelFromDarwin(0)).toBe('normal')
  })
  it('maps Linux PSI: some stall >= 10% is warn, full stall >= 10% is critical', () => {
    const psi = (some: number, full: number) =>
      `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`
    expect(levelFromPsi(psi(0.5, 0))).toBe('normal')
    expect(levelFromPsi(psi(12.3, 2))).toBe('warn')
    expect(levelFromPsi(psi(40, 11))).toBe('critical')
    expect(levelFromPsi('garbage')).toBe('normal')
  })
})

describe('shedding hysteresis', () => {
  const HOLD = 600_000
  it('starts at warn, holds through a normal reading, and ends after the hold', () => {
    let s = initialShedState(HOLD)
    s = nextShedState(s, 'normal', 1_000, HOLD)
    expect(s.shedding).toBe(false)
    s = nextShedState(s, 'warn', 2_000, HOLD)
    expect(s).toEqual({ shedding: true, lastPressuredAt: 2_000, holdMs: HOLD, clearedAt: 0 })
    s = nextShedState(s, 'normal', 2_000 + HOLD - 1, HOLD)
    expect(s.shedding).toBe(true)
    // A flap back to warn restarts the hold.
    s = nextShedState(s, 'critical', 300_000, HOLD)
    s = nextShedState(s, 'normal', 300_000 + HOLD - 1, HOLD)
    expect(s.shedding).toBe(true)
    s = nextShedState(s, 'normal', 300_000 + HOLD, HOLD)
    expect(s).toEqual({ shedding: false, lastPressuredAt: 300_000, holdMs: HOLD, clearedAt: 300_000 + HOLD })
  })
})

describe('hold backoff: pressure that comes back right after a clear', () => {
  const MIN = 60_000
  const BASE = 10 * MIN
  /** Readings every 30 s from `from`: pressured while `pressured(t)`, else normal. */
  function drive(s: ShedState, from: number, to: number, pressured: (t: number) => boolean, backoff = true) {
    const episodes: Array<{ on: number; off: number | null; holdMs: number }> = []
    for (let t = from; t < to; t += 30_000) {
      const next = nextShedState(s, pressured(t) ? 'warn' : 'normal', t, BASE, backoff)
      if (next.shedding && !s.shedding) episodes.push({ on: t, off: null, holdMs: next.holdMs })
      if (!next.shedding && s.shedding) episodes[episodes.length - 1]!.off = t
      s = next
    }
    return { s, episodes }
  }

  it('doubles the hold each time pressure returns within 10 minutes of a clear: 10, 20, 40, 60, 60', () => {
    // One warn reading, then pressure again 60 s after every clear (the reload
    // that the clear allowed is what brings it back).
    let s = initialShedState(BASE)
    const holds: number[] = []
    let t = 0
    for (let i = 0; i < 5; i++) {
      s = nextShedState(s, 'warn', t, BASE)
      holds.push(s.holdMs)
      // Normal readings until the episode clears.
      while (s.shedding) { t += 30_000; s = nextShedState(s, 'normal', t, BASE) }
      expect(t - s.lastPressuredAt).toBe(s.holdMs)
      t += MIN
    }
    expect(holds).toEqual([10, 20, 40, 60, 60].map((m) => m * MIN))
    expect(HOLD_BACKOFF_MAX_FACTOR * BASE).toBe(60 * MIN)
  })

  it('pressure back 10 minutes or more after a clear is a new episode at the base hold', () => {
    let s = initialShedState(BASE)
    const shedOnce = (at: number) => {
      s = nextShedState(s, 'warn', at, BASE)
      const hold = s.holdMs
      s = nextShedState(s, 'normal', at + hold, BASE)
      expect(s.shedding).toBe(false)
      return hold
    }
    expect(shedOnce(0)).toBe(10 * MIN)
    expect(shedOnce(s.clearedAt + 2 * MIN)).toBe(20 * MIN)      // 2 min after the clear: doubled
    expect(shedOnce(s.clearedAt + 10 * MIN - 1)).toBe(40 * MIN) // just inside the window: doubled
    expect(shedOnce(s.clearedAt + 10 * MIN)).toBe(10 * MIN)     // the window passed: the base
    expect(shedOnce(s.clearedAt + 30 * MIN)).toBe(10 * MIN)
  })

  it('a burst inside one episode never grows the hold, only a new episode can', () => {
    let s = initialShedState(BASE)
    s = nextShedState(s, 'warn', 0, BASE)
    for (let t = 30_000; t < 5 * MIN; t += 30_000) s = nextShedState(s, t % MIN === 0 ? 'critical' : 'normal', t, BASE)
    expect(s.shedding).toBe(true)
    expect(s.holdMs).toBe(BASE)
  })

  it('turns a reload-pressure cycle of one every 11 minutes into a few per 3 hours, never off for more than an hour', () => {
    // The 2026-10-02 isolated-server cycle: every resume reloads the model and
    // the kernel reads warn about a minute later, for 3 hours.
    const run = (backoff: boolean) => {
      let s = initialShedState(BASE)
      let reloadAt = -1
      const episodes: Array<{ on: number; off: number | null }> = []
      for (let t = 0; t < 180 * MIN; t += 30_000) {
        const pressured = t === 0 || (reloadAt >= 0 && t - reloadAt >= MIN && t - reloadAt < MIN + 30_000)
        const next = nextShedState(s, pressured ? 'warn' : 'normal', t, BASE, backoff)
        if (next.shedding && !s.shedding) episodes.push({ on: t, off: null })
        if (!next.shedding && s.shedding) { episodes[episodes.length - 1]!.off = t; reloadAt = t }
        s = next
      }
      return episodes
    }
    const fixed = run(false)
    const backed = run(true)
    expect(fixed.length).toBeGreaterThanOrEqual(16)
    expect(backed.length).toBeLessThanOrEqual(5)
    for (const e of backed) if (e.off !== null) expect(e.off - e.on).toBeLessThanOrEqual(60 * MIN)
  })

  it('backoff off keeps every hold at the base', () => {
    const { episodes } = drive(initialShedState(BASE), 0, 120 * MIN, (t) => t % (11 * MIN) === 0, false)
    expect(episodes.length).toBeGreaterThan(5)
    expect(new Set(episodes.map((e) => e.holdMs))).toEqual(new Set([BASE]))
  })

  it('sparse pressure (an episode every 90 minutes) stays at the base hold', () => {
    const { episodes } = drive(initialShedState(BASE), 0, 600 * MIN, (t) => t % (90 * MIN) === 0)
    expect(episodes).toHaveLength(7)
    expect(new Set(episodes.map((e) => e.holdMs))).toEqual(new Set([BASE]))
  })
})

describe('monitor state and listeners', () => {
  beforeEach(() => {
    _resetMemoryPressureForTest()
    _setPressureHoldMsForTest(1_000)
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    _resetMemoryPressureForTest()
    delete process.env.WALNUT_MEMORY_PRESSURE_SHED
    vi.restoreAllMocks()
  })

  it('tells listeners once per flip, never per reading', () => {
    const seen: Array<[boolean, string]> = []
    const off = onMemoryPressureChange((shedding, level) => { seen.push([shedding, level]) })
    applyPressureReading('normal', 0)
    applyPressureReading('warn', 10)
    applyPressureReading('critical', 20)
    applyPressureReading('normal', 500) // still inside the hold
    expect(memoryPressureShedding()).toBe(true)
    applyPressureReading('normal', 1_100)
    expect(memoryPressureShedding()).toBe(false)
    expect(memoryPressureLevel()).toBe('normal')
    expect(seen).toEqual([[true, 'warn'], [false, 'normal']])
    off()
    applyPressureReading('warn', 2_000)
    expect(seen).toHaveLength(2)
  })

  it('a listener that subscribes while shedding hears it at once', () => {
    applyPressureReading('warn', 10)
    const seen: boolean[] = []
    onMemoryPressureChange((s) => { seen.push(s) })
    expect(seen).toEqual([true])
  })

  it('a throwing listener does not stop the others', () => {
    const seen: boolean[] = []
    onMemoryPressureChange(() => { throw new Error('boom') })
    onMemoryPressureChange((s) => { seen.push(s) })
    applyPressureReading('warn', 10)
    expect(seen).toEqual([true])
  })

  it('WALNUT_MEMORY_PRESSURE_SHED=0 reads the level but never sheds', () => {
    process.env.WALNUT_MEMORY_PRESSURE_SHED = '0'
    applyPressureReading('critical', 10)
    expect(memoryPressureLevel()).toBe('critical')
    expect(memoryPressureShedding()).toBe(false)
  })

  it('does not poll inside the test runner unless forced', () => {
    expect(startMemoryPressureMonitor()).toBe(false)
  })
})

describe('parsed history cache under pressure', () => {
  const entry = (chars: number) => ({ messages: [], mtimeMs: 1, approxChars: chars }) as unknown as Parameters<typeof _historyCacheSetForTesting>[1]
  beforeEach(() => _resetHistoryCacheForTesting())
  afterEach(() => _resetHistoryCacheForTesting())

  it('drops the least recent entries down to a quarter of the budget, keeping the newest', () => {
    const M = 1024 * 1024
    for (let i = 0; i < 6; i++) _historyCacheSetForTesting(`s${i}`, entry(10 * M))
    expect(_historyCacheStateForTesting().chars).toBe(60 * M)
    const r = setHistoryCacheShedding(true)
    const st = _historyCacheStateForTesting()
    expect(st.chars).toBeLessThanOrEqual(16 * M)
    expect(st.keys).toContain('s5')
    expect(r.dropped).toBe(5)
    // While shedding, a new entry still evicts to the smaller budget.
    _historyCacheSetForTesting('s6', entry(10 * M))
    _historyCacheSetForTesting('s7', entry(10 * M))
    expect(_historyCacheStateForTesting().keys).toEqual(['s7'])
    // Pressure gone: the full budget is back.
    setHistoryCacheShedding(false)
    _historyCacheSetForTesting('s8', entry(10 * M))
    expect(_historyCacheStateForTesting().keys).toEqual(['s7', 's8'])
  })

  it('keeps a lone whale entry even when it alone exceeds the shrunken budget', () => {
    _historyCacheSetForTesting('whale', entry(40 * 1024 * 1024))
    const r = setHistoryCacheShedding(true)
    expect(r.dropped).toBe(0)
    expect(_historyCacheStateForTesting().keys).toEqual(['whale'])
  })
})

describe('early signals in the monitor', () => {
  const MB = 1024 * 1024
  const PAGE = 16384
  const reading = (at: number, swapoutPages: number, share = 0.2) => ({
    at, kernel: 'normal' as const, memBytes: 48 * 1024 * MB, compressorBytes: share * 48 * 1024 * MB, swapoutPages, pageBytes: PAGE,
  })
  beforeEach(() => {
    _resetMemoryPressureForTest()
    _setPressureHoldMsForTest(600_000)
    vi.spyOn(log.web, 'info').mockImplementation(() => {})
    vi.spyOn(log.web, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    _resetMemoryPressureForTest()
    delete process.env.WALNUT_MEMORY_PRESSURE_EARLY
    vi.restoreAllMocks()
  })

  it('a swap-out burst sheds while the kernel still reads normal, and says why', () => {
    const seen: boolean[] = []
    onMemoryPressureChange((s) => { seen.push(s) })
    const perReading = Math.round((200 * MB) / PAGE)
    for (let i = 0; i < 4; i++) applyMemoryReading(reading(i * 30_000, 1_000 + i * 10))
    expect(memoryPressureShedding()).toBe(false)
    for (let i = 4; i < 8; i++) applyMemoryReading(reading(i * 30_000, 1_030 + (i - 3) * perReading))
    expect(memoryPressureShedding()).toBe(true)
    const snap = memoryPressureSnapshot()
    expect(snap).toMatchObject({ level: 'warn', cause: 'swapout', shedding: true, compressorPct: 20 })
    expect(snap.swapoutMbPerMin).toBeGreaterThan(128)
    expect(seen).toEqual([true])
    const warn = vi.mocked(log.web.warn).mock.calls.find((c) => String(c[0]).startsWith('memory pressure: shedding'))
    expect(warn?.[1]).toMatchObject({ cause: 'swapout', level: 'warn' })
  })

  it('WALNUT_MEMORY_PRESSURE_EARLY=0 listens to the kernel alone', () => {
    process.env.WALNUT_MEMORY_PRESSURE_EARLY = '0'
    applyMemoryReading(reading(0, 0, 0.7))
    applyMemoryReading(reading(30_000, Math.round((900 * MB) / PAGE), 0.7))
    expect(memoryPressureShedding()).toBe(false)
    expect(memoryPressureSnapshot().cause).toBeNull()
    applyMemoryReading({ ...reading(60_000, 0), kernel: 'warn' })
    expect(memoryPressureSnapshot()).toMatchObject({ level: 'warn', cause: 'kernel', shedding: true })
  })

  it('the flight record snapshot carries the level, the cause and both signals', () => {
    applyMemoryReading(reading(0, 0, 0.55))
    expect(memoryPressureSnapshot()).toEqual({ level: 'warn', cause: 'compressor', shedding: true, holdMs: 600_000, compressorPct: 55 })
  })

  it('the monitor applies the backoff, logs the hold, and WALNUT_MEMORY_PRESSURE_BACKOFF=0 turns it off', () => {
    const shedLines = () => vi.mocked(log.web.warn).mock.calls
      .filter((c) => String(c[0]).startsWith('memory pressure: shedding')).map((c) => c[1] as { holdMs: number; baseHoldMs: number })
    applyPressureReading('warn', 0)
    applyPressureReading('normal', 600_000)              // clears after the 10 min hold
    expect(memoryPressureShedding()).toBe(false)
    applyPressureReading('warn', 660_000)                // back a minute later
    expect(memoryPressureSnapshot()).toMatchObject({ shedding: true, holdMs: 1_200_000 })
    applyPressureReading('normal', 660_000 + 600_000)    // the old hold is not enough now
    expect(memoryPressureShedding()).toBe(true)
    applyPressureReading('normal', 660_000 + 1_200_000)
    expect(memoryPressureShedding()).toBe(false)
    expect(shedLines()).toEqual([
      expect.objectContaining({ holdMs: 600_000, baseHoldMs: 600_000 }),
      expect.objectContaining({ holdMs: 1_200_000, baseHoldMs: 600_000 }),
    ])

    process.env.WALNUT_MEMORY_PRESSURE_BACKOFF = '0'
    try {
      applyPressureReading('warn', 1_900_000)            // 40 s after the clear
      expect(memoryPressureSnapshot().holdMs).toBe(600_000)
    } finally {
      delete process.env.WALNUT_MEMORY_PRESSURE_BACKOFF
    }
  })
})
