/**
 * Real data density: 90 days of 5-minute heart-rate buckets (25,920 rows) plus a
 * sleep night per day, posted in max-size calls, then read back through the
 * series and daily queries. Pins the event-loop budget: each call's synchronous
 * work stays small, recomputes drain one date per tick, and a 90-day series moves
 * at most 2000 points. The budgets are asserted on CPU time (process.cpuUsage),
 * which a loaded box cannot inflate the way it inflates wall time; wall numbers
 * are printed for the record. The first call is reported apart: it opens and
 * creates the store. The second case is the cold rebuild a source-order change
 * causes: every stored night is stale, and the next read recomputes 118 of them
 * while yielding the loop between each one. Its gaps are judged twice: on CPU time
 * (this code's work) and on wall time against an idle control (a hold that burns
 * no CPU, such as a sync wait, shows only there).
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-perf'))

import { ingestHealthSync } from '../../../src/core/health/ingest.js'
import { closeHealthDb, destroyHealthDbFiles, getHealthDb, materializedRev } from '../../../src/core/health/db.js'
import { computeDay, computeNight, drainMaterializeQueue, pendingRecomputes } from '../../../src/core/health/materialize.js'
import { healthDaily, healthSeries, healthSleep } from '../../../src/core/health/queries.js'
import { HEALTH_MAX_ITEMS_PER_SYNC } from '../../../src/core/health/catalog.js'
import { updateHealthSettings } from '../../../src/core/health/settings.js'
import { APP, WATCH, bucketBatch, hrBuckets, rawBatch, watchNight } from './fixtures.js'
import { addDays } from '../../../src/core/health/day-key.js'

const DAYS = 90
const TODAY = '2026-09-21'
const NOW = Date.parse(`${TODAY}T12:00:00-04:00`)
const FIRST = addDays(TODAY, -(DAYS - 1))

afterAll(() => closeHealthDb())

/** CPU ms (user + system) spent by `fn`, and its wall ms. */
function measure<T>(fn: () => T): { value: T; cpuMs: number; wallMs: number } {
  const c0 = process.cpuUsage()
  const t0 = performance.now()
  const value = fn()
  const wallMs = performance.now() - t0
  const c = process.cpuUsage(c0)
  return { value, cpuMs: (c.user + c.system) / 1000, wallMs }
}
/**
 * A beat on every loop turn (setImmediate): how many turns other work got, and the
 * longest wall and CPU time between two of them.
 */
function heartbeat(): { stop: () => { beats: number; maxGapWallMs: number; maxGapCpuMs: number } } {
  let beats = 0
  let running = true
  let lastWall = performance.now()
  let lastCpu = process.cpuUsage()
  let maxGapWallMs = 0
  let maxGapCpuMs = 0
  const beat = (): void => {
    const now = performance.now()
    const d = process.cpuUsage(lastCpu)
    maxGapWallMs = Math.max(maxGapWallMs, now - lastWall)
    maxGapCpuMs = Math.max(maxGapCpuMs, (d.user + d.system) / 1000)
    lastWall = now
    lastCpu = process.cpuUsage()
    beats++
    if (running) setImmediate(beat)
  }
  setImmediate(beat)
  return {
    stop: () => {
      running = false
      return { beats, maxGapWallMs, maxGapCpuMs }
    },
  }
}
const pct = (xs: number[], p: number): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

describe('health at 90 days of 5-minute heart rate', () => {
  it('ingests, materializes and reads inside the event-loop budget', async () => {
    destroyHealthDbFiles()
    const start = Date.parse(`${FIRST}T00:00:00-04:00`)
    const all = hrBuckets(start, DAYS * 288)
    const cpu: number[] = []
    const wall: number[] = []
    for (let i = 0; i < all.length; i += HEALTH_MAX_ITEMS_PER_SYNC) {
      const m = measure(() => ingestHealthSync(bucketBatch('heart_rate', all.slice(i, i + HEALTH_MAX_ITEMS_PER_SYNC)), { now: NOW }))
      expect(m.value.status).toBe(200)
      cpu.push(m.cpuMs)
      wall.push(m.wallMs)
    }
    for (let d = 1; d < DAYS; d++) {
      const date = addDays(FIRST, d)
      const m = measure(() => ingestHealthSync(rawBatch('sleep', watchNight(addDays(date, -1), date)), { now: NOW }))
      expect(m.value.status).toBe(200)
      cpu.push(m.cpuMs)
      wall.push(m.wallMs)
    }
    expect((getHealthDb().prepare('SELECT COUNT(*) AS n FROM buckets').get() as { n: number }).n).toBe(DAYS * 288)
    const [coldCpu, ...warmCpu] = cpu
    const [coldWall, ...warmWall] = wall

    const loop = monitorEventLoopDelay({ resolution: 5 })
    loop.enable()
    const queued = pendingRecomputes()
    const t0 = performance.now()
    await drainMaterializeQueue()
    const drainMs = performance.now() - t0
    loop.disable()
    const maxBlockMs = loop.max / 1e6

    // The drain runs one date per tick, so one date's recompute IS the longest
    // the loop is held. Measure each directly on CPU time.
    const stepCpu: number[] = []
    for (let d = 0; d < DAYS; d++) {
      const date = addDays(FIRST, d)
      stepCpu.push(measure(() => computeNight(date)).cpuMs, measure(() => computeDay(date)).cpuMs)
    }

    const r0 = performance.now()
    const series = await healthSeries({ metric: 'heart_rate', from: FIRST, to: TODAY, bucket: '1h' }, NOW)
    const seriesMs = performance.now() - r0
    const d0 = performance.now()
    const daily = await healthDaily({ lastDays: DAYS }, NOW)
    const dailyMs = performance.now() - d0
    const s0 = performance.now()
    const sleep = await healthSleep({ lastNights: DAYS }, NOW)
    const sleepMs = performance.now() - s0

    console.log(`[health-perf] calls=${cpu.length} cold=${coldCpu.toFixed(1)}cpu/${coldWall.toFixed(1)}wall ms `
      + `warm p50=${pct(warmCpu, 0.5).toFixed(1)} p99=${pct(warmCpu, 0.99).toFixed(1)} max=${Math.max(...warmCpu).toFixed(1)} cpu ms `
      + `(wall p50=${pct(warmWall, 0.5).toFixed(1)} max=${Math.max(...warmWall).toFixed(1)}) `
      + `recomputes=${queued} drain=${drainMs.toFixed(0)}ms stepMax=${Math.max(...stepCpu).toFixed(1)}cpu ms `
      + `loopMax=${maxBlockMs.toFixed(1)}ms series=${seriesMs.toFixed(1)}ms daily90=${dailyMs.toFixed(1)}ms sleep90=${sleepMs.toFixed(1)}ms`)

    expect(series.points).toHaveLength(2000)
    expect(series.truncated).toBe(true)
    expect(series.points[series.points.length - 1].count).toBe(12 * 12)
    expect(daily.days.filter((d) => d.status === 'ok')).toHaveLength(DAYS)
    expect(sleep.nights.filter((n) => n.status === 'ok')).toHaveLength(DAYS - 1)
    expect(sleep.nights[sleep.nights.length - 1].sleepingHr).toBe(57.1)

    // Budgets on CPU time: a max-size call is one short transaction, one date's
    // recompute is small, and the cold call that creates the store stays bounded.
    expect(pct(warmCpu, 0.5)).toBeLessThan(20)
    expect(pct(warmCpu, 0.99)).toBeLessThan(60)
    expect(Math.max(...stepCpu)).toBeLessThan(40)
    expect(coldCpu).toBeLessThan(500)
    expect(seriesMs).toBeLessThan(1000)
  }, 120_000)

  it('a cold rebuild after a source-order change yields the loop between nights', async () => {
    // Runs on the store the case above built: 90 nights and 28 baseline dates, all current.
    const currentRows = (): number =>
      (getHealthDb().prepare('SELECT COUNT(*) AS n FROM nights WHERE rev = ?').get(materializedRev()) as { n: number }).n

    /** Make every night stale with a new order, then time an idle control and the rebuild the same way. */
    const rebuild = async (order: string[]) => {
      const staleRev = materializedRev()
      updateHealthSettings({ sleepSourceOrder: order })
      expect(materializedRev()).toBe(staleRev + 1)
      expect(currentRows()).toBe(0)
      // The idle control: on a loaded box the loop is late even with nothing to do,
      // and that lateness is not this code's.
      const idleBeat = heartbeat()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const idle = idleBeat.stop()
      const loop = monitorEventLoopDelay({ resolution: 5 })
      loop.enable()
      const busyBeat = heartbeat()
      const t0 = performance.now()
      const sleep = await healthSleep({ lastNights: DAYS }, NOW)
      const rebuildMs = performance.now() - t0
      const busy = busyBeat.stop()
      loop.disable()
      const recomputed = currentRows()
      console.log(`[health-perf] cold rebuild recomputed=${recomputed} beats=${busy.beats} wall=${rebuildMs.toFixed(0)}ms `
        + `maxWallGap=${busy.maxGapWallMs.toFixed(1)}ms maxCpuGap=${busy.maxGapCpuMs.toFixed(1)}ms loopMax=${(loop.max / 1e6).toFixed(1)}ms `
        + `idle: beats=${idle.beats} maxWallGap=${idle.maxGapWallMs.toFixed(1)}ms`)
      return { idle, busy, sleep, recomputed }
    }

    const first = await rebuild([APP.bundleId, WATCH.bundleId])
    // One recompute per loop turn: the heartbeat ran at least once per night rebuilt
    // (the 90 nights asked for and the 28-night baseline before them).
    expect(first.busy.beats).toBeGreaterThanOrEqual(DAYS + 28)
    // At most 50ms of this process's CPU between two loop turns, i.e. one night's work.
    // A loaded box cannot inflate this number.
    expect(first.busy.maxGapCpuMs).toBeLessThan(50)
    expect(first.sleep.nights.filter((n) => n.status === 'ok')).toHaveLength(DAYS - 1)
    // Every date is stored at the new rev, the empty baseline dates too.
    expect(first.recomputed).toBe(DAYS + 28)

    // CPU alone misses a hold that burns none (a sync wait on a lock or a file): the
    // WALL gap between two turns, judged against the idle control's own worst gap. A
    // loaded box can stall this process at random once, so a miss is measured again
    // on a fresh rebuild; a hold in the code is there every time.
    const wallOk = (r: typeof first): boolean => r.busy.maxGapWallMs < r.idle.maxGapWallMs + 100
    let judged = first
    if (!wallOk(first)) judged = await rebuild([WATCH.bundleId, APP.bundleId])
    expect(judged.busy.maxGapWallMs).toBeLessThan(judged.idle.maxGapWallMs + 100)
  }, 120_000)
})
