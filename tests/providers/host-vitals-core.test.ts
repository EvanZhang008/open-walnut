/**
 * host.vitals (host-vitals-core.ts): the readings, the minute ledger it writes,
 * and the fold of that ledger into shares, outages and boots. The clock, the
 * CPU counters and the ledger directory are the test's own, so every number is
 * exact.
 */
import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHostVitals, type HostVitalsDeps } from '../../src/providers/host-vitals-core.js'

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-vitals-')))
afterAll(() => { if (tmp.includes('walnut-host-vitals-')) fs.rmSync(tmp, { recursive: true, force: true }) })

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
