/**
 * Early memory signals (src/core/memory-signals.ts): parsing the real sysctl
 * and /proc formats, the swap-out rate window, the two hysteresis bands, and
 * that the bands plus the 10 minute shedding hold cannot flap.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  initialSignalState,
  nextSignal,
  parseDarwinSysctl,
  parseLinuxProc,
  type MemoryReading,
  type SignalState,
  type SignalThresholds,
} from '../../src/core/memory-signals.js'
import { initialShedState, levelFromDarwin, nextShedState, type ShedState } from '../../src/core/memory-pressure.js'

const MB = 1024 * 1024
const GB = 1024 * MB
const PAGE = 16384
const RAM = 48 * GB
const T: SignalThresholds = {
  compressorEnter: 0.5,
  compressorExit: 0.4,
  swapoutEnterBytesPerMin: 128 * MB,
  swapoutExitBytesPerMin: 16 * MB,
  swapoutWindowMs: 120_000,
}

/** A seeded generator, so every run walks the same "noisy" trace. */
function rng(seed: number): () => number {
  let s = seed
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
}

/** Feeds a trace of per-interval swap-out MB and compressor shares through the bands. */
function run(trace: Array<{ swapMb: number; share: number; kernel?: MemoryReading['kernel'] }>, stepMs = 30_000, t = T) {
  let st: SignalState = initialSignalState()
  let pages = 1_000_000
  const out: Array<{ at: number; level: string; cause: string | null; rate: number | null }> = []
  trace.forEach((x, i) => {
    pages += Math.round((x.swapMb * MB) / PAGE)
    const v = nextSignal(st, { at: i * stepMs, kernel: x.kernel ?? 'normal', memBytes: RAM, compressorBytes: x.share * RAM, swapoutPages: pages, pageBytes: PAGE }, t)
    st = v.state
    out.push({ at: i * stepMs, level: v.level, cause: v.cause, rate: v.swapoutBytesPerMin })
  })
  return out
}

const flips = (xs: Array<{ level: string }>) => xs.reduce((n, x, i) => n + (i > 0 && (x.level === 'normal') !== (xs[i - 1].level === 'normal') ? 1 : 0), 0)

describe('parsing', () => {
  it('reads the macOS sysctl output by name, skipping lines it does not know', () => {
    const text = [
      'kern.memorystatus_vm_pressure_level: 1',
      'hw.memsize: 51539607552',
      'hw.pagesize: 16384',
      'vm.compressor_bytes_used: 12187353088',
      'vm.swapusage: total = 5120.00M  used = 4012.81M  free = 1107.19M  (encrypted)',
      'vm.compressor.swapper.swapouts_total: 8350533',
      'vm.loadavg: { 388.22 360.46 266.50 }',
      'sysctl: unknown oid \'vm.not_here\'',
    ].join('\n')
    const r = parseDarwinSysctl(text, 5, levelFromDarwin)
    expect(r).toEqual({
      at: 5,
      kernel: 'normal',
      memBytes: 51539607552,
      pageBytes: 16384,
      compressorBytes: 12187353088,
      swapTotalBytes: 5120 * MB,
      swapUsedBytes: Math.round(4012.81 * MB),
      swapoutPages: 8350533,
    })
    expect(parseDarwinSysctl('kern.memorystatus_vm_pressure_level: 4\n', 1, levelFromDarwin).kernel).toBe('critical')
  })

  it('a reading with missing names keeps them undefined (older systems, a failed child)', () => {
    const r = parseDarwinSysctl('hw.memsize: 1024\n', 1, levelFromDarwin)
    expect(r.kernel).toBeNull()
    expect(r.swapoutPages).toBeUndefined()
    expect(r.compressorBytes).toBeUndefined()
    expect(parseDarwinSysctl('', 1, levelFromDarwin)).toEqual({ at: 1, kernel: null })
  })

  it('reads Linux pswpout and swap from /proc', () => {
    const vmstat = 'pgpgin 1\npswpin 77\npswpout 12345\npgfault 9\n'
    const meminfo = 'MemTotal:       16384000 kB\nMemFree:  100 kB\nSwapTotal:       2097148 kB\nSwapFree:        1048574 kB\n'
    const r = parseLinuxProc(vmstat, meminfo, 3, 'warn')
    expect(r).toEqual({
      at: 3, kernel: 'warn', pageBytes: 4096, swapoutPages: 12345,
      memBytes: 16384000 * 1024, swapTotalBytes: 2097148 * 1024, swapUsedBytes: (2097148 - 1048574) * 1024,
    })
    expect(parseLinuxProc('', '', 1, null).swapoutPages).toBeUndefined()
  })
})

describe('swap-out rate', () => {
  it('steady churn far below the band never warns; a burst does, by its second reading', () => {
    const quiet = run(Array.from({ length: 40 }, () => ({ swapMb: 3, share: 0.2 })))
    expect(quiet.every((x) => x.level === 'normal')).toBe(true)
    expect(quiet.at(-1)!.rate).toBeCloseTo(6 * MB, -4) // 3 MB per 30 s
    // 1.84 GB in five minutes (2026-10-02 07:02Z): about 184 MB per reading.
    const burst = run([...Array.from({ length: 10 }, () => ({ swapMb: 3, share: 0.2 })), ...Array.from({ length: 10 }, () => ({ swapMb: 184, share: 0.2 }))])
    // The rate is a 2 minute average, so the first burst reading reads half of it.
    expect(burst[10].level).toBe('normal')
    expect(burst[11]).toMatchObject({ level: 'warn', cause: 'swapout' })
  })

  it('stays raised until the window has drained below the exit rate', () => {
    const trace = [
      ...Array.from({ length: 4 }, () => ({ swapMb: 0, share: 0.2 })),
      ...Array.from({ length: 4 }, () => ({ swapMb: 150, share: 0.2 })),
      ...Array.from({ length: 12 }, () => ({ swapMb: 2, share: 0.2 })),
    ]
    const out = run(trace)
    const firstWarn = out.findIndex((x) => x.level === 'warn')
    const lastWarn = out.map((x) => x.level).lastIndexOf('warn')
    expect(firstWarn).toBe(5)
    // The burst leaves the 2 minute window four readings after it ends.
    expect(lastWarn).toBe(10)
    expect(flips(out)).toBe(2)
  })

  it('a long gap (a sleep) dilutes the rate instead of spiking it', () => {
    let st = initialSignalState()
    st = nextSignal(st, { at: 0, kernel: 'normal', swapoutPages: 0, pageBytes: PAGE }, T).state
    const v = nextSignal(st, { at: 3_600_000, kernel: 'normal', swapoutPages: Math.round((600 * MB) / PAGE), pageBytes: PAGE }, T)
    expect(v.swapoutBytesPerMin).toBeLessThan(11 * MB)
    expect(v.level).toBe('normal')
  })

  it('a counter that went backwards starts over, never a negative or a spike', () => {
    let st = initialSignalState()
    st = nextSignal(st, { at: 0, kernel: 'normal', swapoutPages: 9_000_000, pageBytes: PAGE }, T).state
    const v = nextSignal(st, { at: 30_000, kernel: 'normal', swapoutPages: 10, pageBytes: PAGE }, T)
    expect(v.swapoutBytesPerMin).toBeNull()
    expect(v.level).toBe('normal')
    const w = nextSignal(v.state, { at: 60_000, kernel: 'normal', swapoutPages: 20, pageBytes: PAGE }, T)
    expect(w.swapoutBytesPerMin).toBeCloseTo((10 * PAGE) / 0.5, -1)
  })
})

describe('compressor share', () => {
  it('enters at the high mark and leaves only below the low one', () => {
    const out = run([0.3, 0.49, 0.5, 0.45, 0.41, 0.405, 0.39, 0.45, 0.49, 0.5].map((share) => ({ swapMb: 0, share })))
    expect(out.map((x) => x.level)).toEqual(['normal', 'normal', 'warn', 'warn', 'warn', 'warn', 'normal', 'normal', 'normal', 'warn'])
    expect(out[2].cause).toBe('compressor')
  })

  it('a kernel warn wins and is reported as the kernel', () => {
    const out = run([{ swapMb: 400, share: 0.6, kernel: 'warn' }, { swapMb: 400, share: 0.6, kernel: 'critical' }])
    expect(out.map((x) => [x.level, x.cause])).toEqual([['warn', 'kernel'], ['critical', 'kernel']])
  })
})

describe('no flapping', () => {
  it('a value hovering at a threshold flips its band at most once', () => {
    const r = rng(11)
    // Swap-out between 100 and 160 MB per minute: around the 128 MB enter mark.
    const swap = run(Array.from({ length: 2_000 }, () => ({ swapMb: (100 + r() * 60) / 2, share: 0.2 })))
    expect(flips(swap)).toBe(1)
    // Compressor between 44% and 52%: around the enter mark, above the exit mark.
    const share = run(Array.from({ length: 2_000 }, () => ({ swapMb: 0, share: 0.44 + r() * 0.08 })))
    expect(flips(share)).toBeLessThanOrEqual(1)
  })

  it('with the 10 minute hold, every shed episode lasts at least the hold and never restarts within a reading', () => {
    // Four hours of 30 s readings: noisy quiet churn, and a burst of about
    // 3.5 minutes every 48.5 minutes (five of them).
    const r = rng(5)
    const trace = Array.from({ length: 480 }, (_, i) => {
      const burst = (i % 97) < 6 + (i % 7)
      return { swapMb: burst ? 60 + r() * 120 : r() * 8, share: 0.3 + r() * 0.1 }
    })
    const levels = run(trace)
    const HOLD = 600_000
    let shed: ShedState = initialShedState(HOLD)
    const on: number[] = []
    const off: number[] = []
    for (const x of levels) {
      const next = nextShedState(shed, x.level as 'normal' | 'warn' | 'critical', x.at, HOLD)
      if (next.shedding && !shed.shedding) on.push(x.at)
      if (!next.shedding && shed.shedding) off.push(x.at)
      shed = next
    }
    // One episode per burst, each at least the hold long, none started twice.
    expect(on.length).toBe(5)
    expect(off.length).toBe(5)
    for (let i = 0; i < off.length; i++) expect(off[i] - on[i]).toBeGreaterThanOrEqual(HOLD)
    for (let i = 1; i < on.length; i++) expect(on[i]).toBeGreaterThan(off[i - 1])
  })

  it('the defaults keep a gap between the enter and exit marks', () => {
    expect(DEFAULT_THRESHOLDS.compressorExit).toBeLessThan(DEFAULT_THRESHOLDS.compressorEnter)
    expect(DEFAULT_THRESHOLDS.swapoutExitBytesPerMin).toBeLessThan(DEFAULT_THRESHOLDS.swapoutEnterBytesPerMin / 2)
  })
})
