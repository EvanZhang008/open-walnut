/**
 * host.vitals (host-vitals-core.ts): the readings, the minute ledger it writes,
 * and the fold of that ledger into shares, outages and boots. The clock, the
 * CPU counters and the ledger directory are the test's own, so every number is
 * exact.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHostVitals, type HostVitalsDeps } from '../../src/providers/host-vitals-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-vitals-')))
afterAll(() => { if (tmp.includes('walnut-host-vitals-')) fs.rmSync(tmp, { recursive: true, force: true }) })
afterEach(() => { vi.useRealTimers() })

const MIN = 60_000
const DAY = 1440
// 2026-10-20T00:00:00Z, a whole UTC day.
const T0 = Date.UTC(2026, 9, 20)
let dirN = 0

function rig(over: Partial<HostVitalsDeps> = {}) {
  const clock = { t: T0 + 12 * 60 * MIN }
  const cpu = { idle: 0, total: 0 }
  const state = { linked: true, running: 3 }
  const dir = path.join(tmp, `d${++dirN}`)
  const deps: HostVitalsDeps = {
    fs,
    os: {
      cpus: () => [{ times: { user: cpu.total - cpu.idle, nice: 0, sys: 0, irq: 0, idle: cpu.idle } }, { times: { user: 0, nice: 0, sys: 0, irq: 0, idle: 0 } }] as never,
      totalmem: () => 16 * 1024 ** 3,
      freemem: () => 1024 ** 3,
      loadavg: () => [1.234, 2, 3],
      uptime: () => 3 * 3600,
    },
    execFile: () => null,
    platform: 'test',
    dir,
    startedAt: T0,
    linked: () => state.linked,
    running: () => state.running,
    now: () => clock.t,
    ...over,
  }
  return { v: createHostVitals(deps), clock, cpu, state, dir }
}

/** Write ledger lines straight to disk: [minute offset from T0, linked]. */
function seed(dir: string, minutes: Array<[number, 0 | 1, Partial<Record<string, number>>?]>) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [off, c, extra] of minutes) {
    const m = T0 / MIN + off
    const name = new Date(m * MIN).toISOString().slice(0, 10) + '.jsonl'
    fs.appendFileSync(path.join(dir, name), JSON.stringify({ m, b: T0 / MIN - 180, d: T0 / MIN, c, s: 2, u: 10, a: 50, ...extra }) + '\n')
  }
}

describe('readings', () => {
  it('parses Linux MemAvailable and macOS vm_stat', () => {
    const { v } = rig()
    expect(v.parseMeminfo('MemTotal: 100 kB\nMemFree: 5 kB\nMemAvailable:   2048 kB\n')).toBe(2048 * 1024)
    expect(v.parseMeminfo('MemTotal: 100 kB\n')).toBeNull()
    const vm = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      100.\nPages active:    999.\nPages inactive:   50.\nPages speculative: 10.\n'
    expect(v.parseVmStat(vm)).toBe(160 * 16384)
    expect(v.parseVmStat('garbage')).toBeNull()
  })

  it('measures CPU use between two readings and falls back to os.freemem', async () => {
    const { v, clock, cpu } = rig()
    cpu.total = 1000; cpu.idle = 800
    const first = await v.stats() // no earlier reading: two readings 250 ms apart, same counters
    expect(first.cpuUtil).toBeNull()
    clock.t += 10_000
    cpu.total = 2000; cpu.idle = 1300 // 1000 more, 500 idle: 50% busy
    const s = await v.stats()
    expect(s.cpuUtil).toBe(0.5)
    expect(s.memAvailBytes).toBe(1024 ** 3)
    expect(s.memTotalBytes).toBe(16 * 1024 ** 3)
    expect(s.load).toEqual([1.23, 2, 3])
    expect(s.bootedAt).toBe(clock.t - 3 * 3600 * 1000)
    expect(s).toMatchObject({ cpus: 2, linked: true, running: 3, daemonStartedAt: T0 })
  })

  it('a reading that throws is null, never a failed call', async () => {
    const { v } = rig({
      os: { cpus: () => { throw new Error('no') }, totalmem: () => 0, freemem: () => { throw new Error('no') }, loadavg: () => { throw new Error('no') }, uptime: () => 5 },
      linked: () => { throw new Error('no') },
    })
    const s = await v.stats()
    expect(s).toMatchObject({ cpuUtil: null, memAvailBytes: null, load: null, linked: false, cpus: 0 })
  })
})

describe('GPU and disk', () => {
  it('parses macOS ioreg accelerator statistics and nvidia-smi', () => {
    const { v } = rig()
    const ioreg = '+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X>\n  "PerformanceStatistics" = {"In use system memory"=123,"Device Utilization %"=37,"Renderer Utilization %"=30}\n'
    expect(v.parseIoreg(ioreg)).toBe(0.37)
    expect(v.parseIoreg(ioreg + '"Device Utilization %"=81')).toBe(0.81) // the busiest of two
    expect(v.parseIoreg('no accelerator here')).toBeNull()
    expect(v.parseNvidiaSmi('40\n60\n')).toBe(0.5)
    expect(v.parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toBeNull()
  })

  type Exec = (file: string, args: string[], o: unknown, cb: (e: Error | null, out: string) => void) => void
  const vmStat = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 10.\n'

  it('reads the GPU on a Mac at most every 20 s, and the disk of HOME', async () => {
    const calls: string[] = []
    const { v, clock } = rig({
      platform: 'darwin', diskPath: tmp,
      execFile: ((file, _a, _o, cb) => { calls.push(file); cb(null, file === 'vm_stat' ? vmStat : '"Device Utilization %"=12') }) as Exec as never,
    })
    const s = await v.stats()
    expect(s.gpuUtil).toBe(0.12)
    expect(s.disk!.totalBytes).toBeGreaterThan(0)
    expect(s.disk!.freeBytes).toBeLessThanOrEqual(s.disk!.totalBytes)
    clock.t += 10_000
    await v.tick()
    expect(calls.filter((c) => c === 'ioreg')).toHaveLength(1) // within 20 s: the same reading
    clock.t += MIN
    await v.tick()
    expect(calls.filter((c) => c === 'ioreg')).toHaveLength(2)
  })

  it('a host that shows no GPU is asked again only an hour later', async () => {
    const calls: string[] = []
    const { v, clock } = rig({ platform: 'darwin', execFile: ((file, _a, _o, cb) => { calls.push(file); cb(null, file === 'vm_stat' ? vmStat : 'no accelerator') }) as Exec as never })
    expect((await v.stats()).gpuUtil).toBeNull()
    clock.t += 30 * MIN
    await v.tick()
    expect(calls.filter((c) => c === 'ioreg')).toHaveLength(1)
    clock.t += 31 * MIN
    await v.tick()
    expect(calls.filter((c) => c === 'ioreg')).toHaveLength(2)
  })

  it('a GPU read that runs out of time keeps the last value and no hour of silence', async () => {
    let mode: 'ok' | 'slow' = 'ok'
    const calls: string[] = []
    const { v, clock } = rig({
      platform: 'linux',
      execFile: ((file, _a, _o, cb) => {
        calls.push(file)
        if (file !== 'nvidia-smi') return cb(new Error('no'), '')
        if (mode === 'slow') return cb(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }), '')
        cb(null, '40\n60\n')
      }) as Exec as never,
    })
    await v.tick()
    expect((await v.stats()).gpuUtil).toBe(0.5)
    mode = 'slow'
    clock.t += MIN
    await v.tick()
    expect((await v.stats()).gpuUtil).toBe(0.5)
    mode = 'ok'
    clock.t += MIN
    await v.tick()
    expect(calls.filter((c) => c === 'nvidia-smi')).toHaveLength(3) // asked again the next minute, not an hour later
  })

  it('a GPU tool that never answers waits 10 minutes between tries', async () => {
    const calls: string[] = []
    const { v, clock } = rig({ platform: 'linux', execFile: ((file: string) => { calls.push(file) }) as never })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const first = v.tick()
    await vi.advanceTimersByTimeAsync(9000)
    await first
    for (let i = 0; i < 9; i++) { clock.t += MIN; const t = v.tick(); await vi.advanceTimersByTimeAsync(9000); await t }
    expect(calls.filter((c) => c === 'nvidia-smi')).toHaveLength(1)
    clock.t += 2 * MIN
    const later = v.tick()
    await vi.advanceTimersByTimeAsync(9000)
    await later
    expect(calls.filter((c) => c === 'nvidia-smi')).toHaveLength(2)
  })

  it('an asker gets the last GPU reading at once while a fresh one is read', async () => {
    let release: (() => void) | null = null
    let freshAnswered = false
    const { v, clock } = rig({
      platform: 'linux',
      execFile: ((file, _a, _o, cb) => {
        if (file !== 'nvidia-smi') return cb(new Error('no'), '')
        if (release === null) return cb(null, '30\n')
        const r = release; release = () => {}; void r
        setTimeout(() => { cb(null, '90\n'); freshAnswered = true }, 50)
      }) as Exec as never,
    })
    await v.tick()
    release = () => {}
    clock.t += 30_000
    const s = await v.stats()
    expect(s.gpuUtil).toBe(0.3) // the last one, at once
    await vi.waitFor(() => { expect(freshAnswered).toBe(true) }, { timeout: 10_000, interval: 10 })
    clock.t += 10_000
    expect((await v.stats()).gpuUtil).toBe(0.9)
  })

  it('a Linux host with no nvidia-smi has no GPU reading', async () => {
    const { v } = rig({ platform: 'linux', execFile: ((_f: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(new Error('ENOENT'), '')) as never })
    expect((await v.stats()).gpuUtil).toBeNull()
  })
})

describe('the ledger', () => {
  it('writes one line a minute, a new file each UTC day, and prunes past retention', async () => {
    const { v, clock, dir, state } = rig({ retentionDays: 2 })
    seed(dir, [[-5 * DAY, 1]]) // older than retention
    await v.tick()
    await v.tick() // same minute: no second line
    clock.t += 30_000
    await v.tick() // still minute 720
    clock.t += 30_000
    state.linked = false
    await v.tick()
    const today = fs.readFileSync(path.join(dir, '2026-10-20.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(today.map((l) => l.m)).toEqual([T0 / MIN + 720, T0 / MIN + 721])
    expect(today.map((l) => l.c)).toEqual([1, 0])
    expect(today[0]).toMatchObject({ d: T0 / MIN, s: 3, b: T0 / MIN + 720 - 180 })
    expect(fs.existsSync(path.join(dir, '2026-10-15.jsonl'))).toBe(false)
    clock.t = T0 + DAY * MIN + 5 * MIN
    await v.tick()
    expect(fs.readFileSync(path.join(dir, '2026-10-21.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
    const fresh = rig()
    await fresh.v.tick()
    expect(fs.statSync(fresh.dir).mode & 0o777).toBe(0o700)
  })

  it('a write that fails is counted, not thrown, and the next one recovers', async () => {
    const file = path.join(tmp, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    const { v, clock } = rig({ dir: path.join(file, 'sub') })
    await v.tick()
    const r = await v.vitals()
    expect(r.ledger.writeErrors).toBe(1)
    expect(r.ledger.lastError).toBeTruthy()
    expect(r.history.coverageFrom).toBeNull()
    expect(r.history.windows[0].online).toBeNull()
    clock.t += MIN
    await v.tick()
    expect((await v.vitals()).ledger.writeErrors).toBe(2)
  })
})

describe('the fold', () => {
  it('an empty ledger covers nothing and claims no outage', async () => {
    const { v } = rig()
    const r = await v.vitals({ days: 7 })
    expect(r.history.coverageFrom).toBeNull()
    expect(r.history.outages).toEqual([])
    expect(r.history.windows.map((w) => w.online)).toEqual([null, null])
    expect(r.history.buckets).toHaveLength(7)
    expect(r.history.buckets.every((b) => b.minutes === 0)).toBe(true)
  })

  it('counts up and linked minutes from where the ledger starts, with downs, drops and boots', async () => {
    const { v, clock, dir } = rig()
    clock.t = T0 + 2 * DAY * MIN // two days after T0, at 00:00
    const lines: Array<[number, 0 | 1, Partial<Record<string, number>>?]> = []
    for (let m = 0; m < 2 * DAY; m++) {
      if (m >= 600 && m < 660) continue // an hour down
      if (m === 900) continue // one missed minute is not an outage
      const linked: 0 | 1 = m >= 1000 && m < 1030 ? 0 : 1 // 30 minutes with no server
      lines.push([m, linked, m >= 660 ? { b: T0 / MIN + 655, d: T0 / MIN + 658 } : undefined])
    }
    seed(dir, lines)
    // A second daemon wrote some minutes again during an upgrade, one of them linked.
    seed(dir, [[1000, 1], [1001, 0], [1500, 1]])
    const r = await v.vitals({ days: 2 })
    const day1 = r.history.windows.find((w) => w.days === 1)!
    expect(day1).toMatchObject({ minutes: DAY, up: DAY, downs: 0, drops: 0, online: 1 })
    const week = r.history.windows.find((w) => w.days === 7)!
    // Coverage starts at T0, so the week is the two days the ledger has.
    expect(week.minutes).toBe(2 * DAY)
    expect(week.up).toBe(2 * DAY - 61)
    expect(week.downs).toBe(1)
    expect(week.drops).toBe(1) // minute 1000 was linked by the other daemon: 1001..1029 is still one drop
    expect(week.linked).toBe(2 * DAY - 61 - 29)
    expect(week.online).toBeCloseTo((2 * DAY - 61) / (2 * DAY), 4)
    expect(r.history.coverageFrom).toBe(T0)
    expect(r.history.outages.map((o) => [o.kind, (o.from - T0) / MIN, o.minutes])).toEqual([
      ['unlinked', 1001, 29],
      ['down', 600, 60],
    ])
    // A boot before the range (the host ran since then) is not one of its boots.
    expect(r.history.boots).toEqual([T0 + 655 * MIN])
    expect(r.history.daemonStarts).toBe(2)
    expect(day1).toMatchObject({ daemonStarts: 0, boots: 0 })
    expect(week).toMatchObject({ daemonStarts: 2, boots: 2 }) // the earlier boot is 3 h before T0, inside the week
    expect(r.history.buckets).toHaveLength(2)
    expect(r.history.buckets[0]).toMatchObject({ start: T0, minutes: DAY, up: DAY - 61, cpu: 0.1, mem: 0.5, sessionsMax: 2 })
  })

  it('hourly buckets for one day, and a corrupt line or a future minute is ignored', async () => {
    const { v, clock, dir } = rig()
    clock.t = T0 + DAY * MIN
    seed(dir, [[DAY - 30, 1], [DAY - 29, 1], [DAY + 500, 1]])
    fs.appendFileSync(path.join(dir, '2026-10-20.jsonl'), '{not json\n{"m":"x"}\n')
    const r = await v.vitals({ days: 1 })
    expect(r.history.bucketMinutes).toBe(60)
    expect(r.history.buckets).toHaveLength(24)
    const last = r.history.buckets[23]
    expect(last).toMatchObject({ minutes: 30, up: 2 })
    expect(r.history.windows.find((w) => w.days === 1)).toMatchObject({ minutes: 30, up: 2, downs: 1 })
  })

  it('a fine ask gets at most 2000 buckets', async () => {
    const { v } = rig()
    const r = await v.vitals({ days: 31, bucketMinutes: 5 })
    expect(r.history.buckets.length).toBeLessThanOrEqual(2000)
    expect(r.history.bucketMinutes).toBe(Math.ceil((31 * DAY) / 2000))
  })

  it('a page asking every few seconds does not shorten what a ledger minute measures', async () => {
    const { v, clock, cpu, dir } = rig()
    cpu.total = 1000; cpu.idle = 1000
    await v.tick() // baseline for the minute
    clock.t += 50_000
    cpu.total = 2000; cpu.idle = 1000 // fully busy for 50 s
    await v.stats() // an asker reads in between
    clock.t += 10_000
    cpu.total = 2100; cpu.idle = 1100 // idle for the last 10 s
    await v.tick()
    const lines = fs.readFileSync(path.join(dir, '2026-10-20.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[1].u).toBe(Math.round((1 - 100 / 1100) * 100)) // the whole minute, not the last 10 s
  })

  it('reads a past day once, and today again as it grows', async () => {
    const { v, clock, dir } = rig()
    clock.t = T0 + DAY * MIN + 10 * MIN
    seed(dir, [[DAY - 1, 1], [DAY + 1, 1]])
    const read = fs.promises.readFile
    let reads = 0
    fs.promises.readFile = ((...a: Parameters<typeof read>) => { reads++; return read(...a) }) as typeof read
    try {
      await v.vitals({ days: 2 })
      const first = reads
      seed(dir, [[DAY + 2, 1]])
      const r = await v.vitals({ days: 2 })
      expect(reads - first).toBe(1) // only today's file
      expect(r.history.windows.find((w) => w.days === 1)!.up).toBe(3)
    } finally {
      fs.promises.readFile = read
    }
  })
})

describe('the last 12 hours', () => {
  it('folds 15 minute steps of CPU, memory in use, GPU, disk and sessions, broken where the host was down', async () => {
    const { v, dir } = rig()
    const lines: Array<[number, 0 | 1, Partial<Record<string, number>>?]> = []
    for (let m = 0; m < 720; m++) {
      if (m >= 300 && m < 330) continue // down for two steps
      lines.push([m, 1, { u: m < 360 ? 20 : 60, a: 75, g: m < 360 ? -1 : 40, k: 55, s: m >= 700 ? 7 : 2 }])
    }
    seed(dir, lines)
    const r = (await v.vitals({ days: 30 })).history.recent!
    expect(r.stepMinutes).toBe(15)
    expect(r.from).toBe(T0)
    expect(r.cpu).toHaveLength(48)
    expect(r.cpu[0]).toBe(0.2)
    expect(r.cpu[47]).toBe(0.6)
    expect(r.mem[0]).toBe(0.25) // 75% available is 25% in use
    expect(r.cpu[20]).toBeNull() // minutes 300 to 329: down
    expect(r.cpu[21]).toBeNull()
    expect(r.up[20]).toBe(0)
    expect(r.up[0]).toBe(15)
    expect(r.gpu![0]).toBeNull() // no GPU reading before minute 360
    expect(r.gpu![24]).toBe(0.4)
    expect(r.disk[5]).toBe(0.55)
    expect(r.sessions[47]).toBe(7)
    expect(r.sessions[0]).toBe(2)
  })

  it('a host that never reported a GPU has none, and older ledger lines read as no GPU and no disk', async () => {
    const { v, dir } = rig()
    seed(dir, Array.from({ length: 30 }, (_, i) => [690 + i, 1] as [number, 1]))
    const r = (await v.vitals()).history.recent!
    expect(r.gpu).toBeNull()
    expect(r.disk[47]).toBeNull()
    expect(r.cpu[47]).toBe(0.1)
  })

  it('a tick writes the GPU and disk of its reading', async () => {
    const { v, dir } = rig({ diskPath: tmp })
    await v.tick()
    const line = JSON.parse(fs.readFileSync(path.join(dir, '2026-10-20.jsonl'), 'utf8').trim())
    expect(line.g).toBe(-1) // no GPU on this test platform
    expect(line.k).toBeGreaterThanOrEqual(0)
    expect(line.k).toBeLessThanOrEqual(100)
  })
})

describe('a cached reading', () => {
  it('reuses CPU and memory for 5 s but reads the link and the sessions live', async () => {
    const { v, state } = rig()
    const a = await v.stats()
    state.linked = false
    state.running = 7
    const b = await v.stats()
    expect(b.sampledAt).toBe(a.sampledAt)
    expect(b).toMatchObject({ linked: false, running: 7 })
  })
})
