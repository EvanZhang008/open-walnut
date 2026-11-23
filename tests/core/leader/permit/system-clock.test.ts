/**
 * The holder's clock that counts sleep (Linux CLOCK_BOOTTIME, macOS mach_continuous_time),
 * its fallback, and the mark it leaves on every record. The Linux reads are real (bun:ffi into
 * libc); the macOS path runs here against a stand-in libSystem only: this host cannot load the
 * real one, and no test here can make a machine sleep.
 */
import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMIT_PARAMS, DISTRUST_STEP_MS, PermitClient, createHolderClock, judge, loadSystemClocks, genesisConfigId,
  type Ffi, type PermitRecord, type WitnessState,
} from '../../../../src/core/leader/permit/index.js'
import { CALM, World, firstStart, pilot } from './sim.js'

const W = ['w1', 'w2', 'w3']
const onBunLinux = process.platform === 'linux' && typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

describe('the machine clocks through libc', () => {
  it.runIf(onBunLinux)('reads CLOCK_BOOTTIME on Linux: it matches /proc/uptime and never trails CLOCK_MONOTONIC', () => {
    const c = loadSystemClocks()
    expect(c?.kind).toBe('boottime')
    // /proc/uptime is the kernel's boot time (sleep included), to 10 ms.
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8')) * 1_000
    expect(Math.abs(c!.boot() - uptime)).toBeLessThan(50)
    const m = c!.mono()
    expect(c!.boot()).toBeGreaterThanOrEqual(m - 1)
  })

  it.runIf(onBunLinux)('advances with real time and costs well under a microsecond a read (no event loop stall)', () => {
    const c = loadSystemClocks()!
    const b0 = c.boot(), p0 = performance.now()
    // Real time passing is what is under test here: spin 60 ms of it.
    for (const end = performance.now() + 60; performance.now() < end;) { /* spin */ }
    const db = c.boot() - b0, dp = performance.now() - p0
    expect(Math.abs(db - dp)).toBeLessThan(15)
    const t = performance.now()
    for (let i = 0; i < 100_000; i++) c.boot()
    expect(performance.now() - t).toBeLessThan(500)
  })

  it('macOS: mach_continuous_time ticks become milliseconds by the timebase (stand-in libSystem)', () => {
    let ticks = 0n
    const fake: Ffi = {
      FFIType: { i32: 'i32', ptr: 'ptr', u64: 'u64' },
      ptr: (v) => v,
      dlopen: (lib) => {
        expect(lib).toBe('/usr/lib/libSystem.B.dylib')
        return {
          symbols: {
            // Apple silicon: 125/3 ns a tick.
            mach_timebase_info: (p: unknown) => { const a = p as Uint32Array; a[0] = 125; a[1] = 3; return 0 },
            mach_continuous_time: () => ticks + 24_000_000n,
            mach_absolute_time: () => ticks,
          },
        }
      },
    }
    const c = loadSystemClocks('darwin', () => fake)!
    expect(c.kind).toBe('continuous')
    ticks = 240_000n
    // 24,000,000 ticks of sleep = 1000 ms; 240,000 ticks = 10 ms.
    expect(c.boot() - c.mono()).toBeCloseTo(1_000, 6)
    expect(c.mono()).toBeCloseTo(10, 6)
  })

  it('falls back to nothing where libc cannot be loaded or the platform has no such clock', () => {
    expect(loadSystemClocks('linux', () => null)).toBeNull()
    expect(loadSystemClocks('linux', () => { throw new Error('no bun:ffi') })).toBeNull()
    expect(loadSystemClocks('win32', () => ({ FFIType: { i32: 0, ptr: 0, u64: 0 }, ptr: () => 0, dlopen: () => { throw new Error('x') } }))).toBeNull()
  })
})

describe('the holder clock on the sleep-counting clock', () => {
  /** A machine: monotonic stops while asleep, the boot clock never does, the wall may be set. */
  function machine() {
    const t = { real: 0, slept: 0, wallShift: 0 }
    return {
      t,
      monotonic: () => t.real - t.slept,
      wall: () => 1_700_000_000_000 + t.real + t.wallShift,
      boot: () => t.real,
    }
  }

  it('counts a 90 s sleep even when the wall clock was set back by the same 90 s during it', () => {
    const m = machine()
    const withBoot = createHolderClock({ monotonic: m.monotonic, wall: m.wall, boot: { kind: 'boottime', now: m.boot } })
    const fallback = createHolderClock({ monotonic: m.monotonic, wall: m.wall })
    expect([withBoot.kind, fallback.kind]).toEqual(['boottime', 'mono-wall'])
    const a = withBoot.now(), b = fallback.now()
    m.t.real += 90_000
    m.t.slept += 90_000
    m.t.wallShift -= 90_000
    expect(withBoot.now() - a).toBe(90_000)
    // The fallback's known edge (docs): the sleep hides behind the set-back.
    expect(fallback.now() - b).toBe(0)
  })

  it('a wall clock set back two hours changes nothing; the fallback distrusts the step', () => {
    const m = machine()
    const c = createHolderClock({ monotonic: m.monotonic, wall: m.wall, boot: { kind: 'boottime', now: m.boot } })
    const f = createHolderClock({ monotonic: m.monotonic, wall: m.wall })
    const a = c.now(), b = f.now()
    m.t.real += 1_000
    m.t.wallShift -= 7_200_000
    expect(c.now() - a).toBe(1_000)
    expect(f.now() - b).toBe(DISTRUST_STEP_MS)
  })

  it('a virtual machine paused 90 s that its boot clock missed: the wall clock going forward counts it (review round 3 S-5)', () => {
    // In a guest whose host was suspended, the boot and monotonic clocks may both stand still
    // while the wall clock is put right after the pause.
    let mono = 0, boot = 0, wall = 1_700_000_000_000
    const c = createHolderClock({ monotonic: () => mono, wall: () => wall, boot: { kind: 'boottime', now: () => boot } })
    const a = c.now()
    mono += 1_000; boot += 1_000; wall += 1_000
    expect(c.now() - a).toBe(1_000)
    wall += 90_000
    expect(c.now() - a).toBe(91_000)
    // Set forward an hour: the permission only ends early.
    wall += 3_600_000
    expect(c.now() - a).toBe(3_691_000)
  })

  it('distrusts a boot clock that falls behind the monotonic one (it never should)', () => {
    let mono = 0, boot = 0
    const c = createHolderClock({ monotonic: () => mono, wall: () => 0, boot: { kind: 'boottime', now: () => boot } })
    const a = c.now()
    mono += 5_000
    boot -= 1
    expect(c.now() - a).toBe(DISTRUST_STEP_MS)
  })
})

describe('the clock a holder counts on is marked on its records', () => {
  const P = DEFAULT_PERMIT_PARAMS
  const client = (boot: boolean) => new PermitClient({
    id: 'A', list: W, params: P, transport: { send: () => {} },
    clock: createHolderClock({ monotonic: () => 0, wall: () => 0, ...(boot ? { boot: { kind: 'continuous' as const, now: () => 0 } } : {}) }),
  })

  it('names the sleep-counting clock, or the fallback', () => {
    expect(client(true).requestGrant().clock).toBe('continuous')
    expect(client(false).requestGrant().clock).toBe('mono-wall')
  })

  it('a witness takes a clock mark it does not know yet (a newer holder), and refuses only a malformed one (review round 3 N-6)', () => {
    const s: WitnessState = { held: null, acceptedAt: 0, list: W, joint: null, cfg: genesisConfigId(W), epoch: 0, progress: null, ops: [] }
    const grant = client(false).requestGrant()
    expect(judge(s, 'w1', { ...grant, clock: 'sundial' }, 0, P).ok).toBe(true)
    for (const clock of [7, '', 'x'.repeat(33)]) {
      expect(judge(s, 'w1', { ...grant, clock } as unknown as PermitRecord, 0, P)).toEqual({ ok: false, reason: 'bad-clock' })
    }
  })
})

describe('the simulation checks the invariant at the instant a machine wakes (review round 3 N-7)', () => {
  it('a wake is an event of its own', () => {
    const w = new World(DEFAULT_PERMIT_PARAMS, { ...CALM }, 3)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    const a = w.addMachine('A', W, { bootClock: true })
    a.c.requestGrant()
    w.run(1_000)
    // Asleep from 2 s to 9 s: short of its lease, so it wakes still holding.
    a.clock.sleeps.push([2_000, 9_000])
    w.at(5_000, () => {})
    w.run(20_000)
    expect(w.timeline.filter(([t]) => t >= 2_000)).toEqual([[5_000, []], [9_000, ['A']]])
  })
})

describe('a holder that sleeps 90 s while its wall clock is set back by as much', () => {
  /** `setBackMs`: how far the wall clock is set back, `afterMs` into the sleep (the sleep is 30 s to 120 s). */
  function run(bootClock: boolean, setBackMs = 90_000, afterMs = 1) {
    const w = new World(DEFAULT_PERMIT_PARAMS, { ...CALM }, 7)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    const a = w.addMachine('A', W, { bootClock })
    a.c.requestGrant()
    w.run(1_000)
    w.addMachine('B', W)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    pilot(w, 'B', { wantsLead: true, tickMs: 250, backoff: false })
    w.run(30_000)
    a.clock.sleeps.push([30_000, 120_000])
    a.clock.wallJumps.push([30_000 + afterMs, -setBackMs])
    let atWake: boolean | null = null
    w.at(120_000, () => { atWake = a.c.mayAct() })
    w.run(200_000)
    return { w, atWake }
  }

  it('on the boot clock: wakes with mayAct() false, and B took over meanwhile', () => {
    const { w, atWake } = run(true)
    expect(atWake).toBe(false)
    expect(w.violations).toEqual([])
    expect(firstStart(w, 'B')).not.toBeNull()
  })

  it('negative control: on the fallback (monotonic and wall) it wakes still acting, beside B', () => {
    const { w, atWake } = run(false)
    expect(atWake).toBe(true)
    expect(w.violations.length).toBeGreaterThan(0)
  })

  // Found by a random schedule (model-check seed 65 of the 'instant they may' chunk): a 90 s sleep with the wall
  // clock set back by 77 s, 68 s into the sleep. The fallback counts max(monotonic advance, wall advance) per step; the
  // monotonic one stood still and the wall one went forward by 90 - 77 = 13 s, which is not behind the monotonic one, so
  // the "set back by more than 1 s in one step" distrust never fires. 77 of the 90 sleeping seconds vanish.
  // Today's behaviour, asserted as it is: ANY set-back during a sleep hides that much of it from the fallback clock, not only one
  // within 1 s of the sleep's length (docs/reference/leader-write-permission.md assumption (2) says the latter). It breaks
  // "at no instant do two machines act": A wakes with 13 s counted of 90, still inside its record, while B has held since
  // the witnesses' record of A ran out.
  describe('a set-back of 77 s, 68 s into the sleep', () => {
    it('on the boot clock: wakes with mayAct() false, and B took over meanwhile', () => {
      const { w, atWake } = run(true, 77_000, 68_000)
      expect(atWake).toBe(false)
      expect(w.violations).toEqual([])
    })

    it('on the fallback: it wakes still acting beside B (the invariant breaks; the core is not changed for it)', () => {
      const { w, atWake } = run(false, 77_000, 68_000)
      expect(atWake).toBe(true)
      expect(w.violations.length).toBeGreaterThan(0)
    })

    it('a set-back small enough that the sleep still counts past the lease is safe on the fallback (10 s)', () => {
      const { w, atWake } = run(false, 10_000, 68_000)
      expect(atWake).toBe(false)
      expect(w.violations).toEqual([])
    })
  })
})
