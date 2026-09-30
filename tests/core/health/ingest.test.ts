/**
 * The health sync transaction on a real (temp) SQLite store: idempotency,
 * deletes, resync mark and sweep, store identity, caps, pause, and the rule that
 * no health value ever reaches a log line.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-ingest'))

const logLines: string[] = []
vi.mock('../../../src/logging/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/logging/logger.js')>()
  return { ...actual, writeLogEntry: (entry: unknown) => { logLines.push(JSON.stringify(entry)) } }
})

import { ingestHealthSync } from '../../../src/core/health/ingest.js'
import { closeHealthDb, destroyHealthDbFiles, getHealthDb, healthDbPath, materializedRev } from '../../../src/core/health/db.js'
import { drainMaterializeQueue, readDays, readNights, resetMaterializeQueue } from '../../../src/core/health/materialize.js'
import { healthSleep } from '../../../src/core/health/queries.js'
import { UNRECORDED_GAP_CAVEAT } from '../../../src/core/health/sleep-merge.js'
import { deleteHealthData, updateHealthSettings } from '../../../src/core/health/settings.js'
import { HEALTH_MAX_ITEMS_PER_SYNC } from '../../../src/core/health/catalog.js'
import { bus } from '../../../src/core/event-bus.js'
import { APP, MARKER_HR, MARKER_HRV, WATCH, bucketBatch, hrBuckets, rawBatch, sleepSample, uuid, watchNight } from './fixtures.js'

const NOW = Date.parse('2026-09-21T12:00:00-04:00')
const sync = (body: unknown, now = NOW) => ingestHealthSync(body, { now })
const ok = (body: unknown, now = NOW) => {
  const out = sync(body, now)
  expect(out.status, JSON.stringify(out.body)).toBe(200)
  return out.body as Record<string, any>
}
const count = (table: string): number => (getHealthDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

beforeEach(() => {
  resetMaterializeQueue()
  destroyHealthDbFiles()
})

afterAll(() => closeHealthDb())

describe('health sync ingest', () => {
  it('a batch posted twice is stored once (insert-or-ignore by HealthKit uuid)', async () => {
    const batch = rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'))
    const first = ok(batch)
    expect(first).toMatchObject({ accepted: 5, inserted: 5, deleted: 0, paused: false })
    expect(first.storeId).toMatch(/^hs-/)
    const second = ok(batch)
    expect(second).toMatchObject({ accepted: 5, inserted: 0 })
    expect(count('samples')).toBe(5)
    const night = (await readNights(['2026-09-21'])).get('2026-09-21')!
    expect(night.asleepMin).toBe(470)
  })

  it('a deleted uuid removes its row and the night is recomputed', async () => {
    const samples = watchNight('2026-09-20', '2026-09-21')
    ok(rawBatch('sleep', samples))
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.asleepMin).toBe(470)
    const out = ok(rawBatch('sleep', [], { deleted: [samples[4].uuid, 'F0000000-0000-4000-8000-00000000dead'] }))
    expect(out.deleted).toBe(1)
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.asleepMin).toBe(230)
  })

  it('resync: begin marks, a re-sent row clears its mark, end sweeps the rest', () => {
    const samples = watchNight('2026-09-20', '2026-09-21')
    ok(rawBatch('sleep', samples))
    const begin = ok(rawBatch('sleep', samples.slice(0, 2), { resync: { phase: 'begin', windowStart: '2026-09-01T00:00:00Z', generation: 7 } }))
    expect(begin.resync).toEqual({ phase: 'begin', generation: 7, marked: 5 })
    const end = ok(rawBatch('sleep', samples.slice(2, 3), { resync: { phase: 'end', generation: 7 } }))
    expect(end.resync).toEqual({ phase: 'end', generation: 7, swept: 2 })
    expect(count('samples')).toBe(3)
  })

  it('resync without an end sweeps nothing, and a stale end is refused', () => {
    const samples = watchNight('2026-09-20', '2026-09-21')
    ok(rawBatch('sleep', samples))
    ok(rawBatch('sleep', samples.slice(0, 1), { resync: { phase: 'begin', generation: 3 } }))
    ok(rawBatch('sleep', samples.slice(1, 2)))
    expect(count('samples')).toBe(5)
    const stale = ok(rawBatch('sleep', [], { resync: { phase: 'end', generation: 2 } }))
    expect(stale.resync).toMatchObject({ phase: 'end', swept: 0, stale: true })
    expect(count('samples')).toBe(5)
  })

  it('a resync only sweeps its own type and window', () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    ok(rawBatch('hrv_sdnn', [{ uuid: uuid('B'), start: '2026-09-21T03:00:00-04:00', end: '2026-09-21T03:01:00-04:00', value: MARKER_HRV, source: WATCH }]))
    ok(rawBatch('sleep', [], { resync: { phase: 'begin', windowStart: '2026-09-21T02:00:00-04:00', generation: 9 } }))
    const end = ok(rawBatch('sleep', [], { resync: { phase: 'end', generation: 9 } }))
    expect(end.resync.swept).toBe(3)
    expect(count('samples')).toBe(3)
  })

  it('a deleted store answers 409 store_mismatch with the new id; the new id is accepted', () => {
    const first = ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    const del = deleteHealthData({})
    expect(del.storeId).not.toBe(first.storeId)
    expect(fs.existsSync(healthDbPath())).toBe(true)
    const stale = sync(rawBatch('sleep', [], { storeId: first.storeId }))
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'store_mismatch' }, storeId: del.storeId })
    updateHealthSettings({ paused: false })
    expect(ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'), { storeId: del.storeId })).inserted).toBe(5)
  })

  it('over 500 items or 192 KB answers 413 and stores nothing', () => {
    const many = Array.from({ length: HEALTH_MAX_ITEMS_PER_SYNC + 1 }, (_, i) => sleepSample(
      new Date(NOW - (i + 2) * 60_000).toISOString(), new Date(NOW - (i + 1) * 60_000).toISOString(), 1))
    expect(sync(rawBatch('sleep', many)).status).toBe(413)
    const fat = rawBatch('sleep', watchNight('2026-09-20', '2026-09-21').map((x) => ({ ...x, meta: { activity: 'x'.repeat(40_000) } })))
    const out = sync(fat)
    expect(out.status).toBe(413)
    expect(out.body).toMatchObject({ error: { code: 'too_large' }, maxItems: 500, maxBytes: 192 * 1024 })
    expect(count('samples')).toBe(0)
  })

  it('paused stores nothing new, but deletions still apply', () => {
    const samples = watchNight('2026-09-20', '2026-09-21')
    ok(rawBatch('sleep', samples))
    updateHealthSettings({ paused: true })
    const out = ok(rawBatch('sleep', [sleepSample('2026-09-21T08:00:00-04:00', '2026-09-21T08:30:00-04:00', 1)], { deleted: [samples[0].uuid] }))
    expect(out).toMatchObject({ paused: true, accepted: 0, inserted: 0, deleted: 1 })
    expect(count('samples')).toBe(4)
  })

  it('a switched-off category and an unsupported type store nothing and say why', () => {
    updateHealthSettings({ categories: ['sleep'] })
    const off = ok(bucketBatch('heart_rate', hrBuckets(NOW - 3_600_000, 3)))
    expect(off).toMatchObject({ accepted: 0, categoryDisabled: true })
    const unknown = ok(rawBatch('blood_glucose', [{ uuid: uuid(), start: '2026-09-21T08:00:00Z', end: '2026-09-21T08:00:00Z', value: 5, source: APP }]))
    expect(unknown).toMatchObject({ accepted: 0, unsupported: true, rejected: 1 })
    expect(count('buckets') + count('samples')).toBe(0)
  })

  it('drops junk items into `rejected` instead of failing the batch', () => {
    const good = sleepSample('2026-09-21T01:00:00-04:00', '2026-09-21T02:00:00-04:00', 3)
    const out = ok(rawBatch('sleep', [good, { ...good, uuid: uuid(), code: 9 }, { ...good, uuid: 'bad uuid!' }, 'junk', { ...good, uuid: uuid(), end: 'soon' }]))
    expect(out).toMatchObject({ accepted: 1, inserted: 1, rejected: 4 })
  })

  it('buckets are replaced by key, and the day reflects the replacement', async () => {
    const start = Date.parse('2026-09-21T09:00:00-04:00')
    ok(bucketBatch('heart_rate', hrBuckets(start, 2, 60)))
    ok(bucketBatch('heart_rate', hrBuckets(start, 2, 70)))
    expect(count('buckets')).toBe(2)
    await drainMaterializeQueue()
    const day = (await readDays(['2026-09-21'])).get('2026-09-21')!
    expect(day.vitals.heartRate?.avg).toBe(70)
  })

  it('announces health:ingested with types and dates, never values', async () => {
    const seen: unknown[] = []
    bus.subscribe('test-health-ingested', (e) => { if (e.name === 'health:ingested') seen.push(e.data) }, { global: true })
    try {
      ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
      ok(bucketBatch('heart_rate', hrBuckets(Date.parse('2026-09-21T09:00:00-04:00'), 2)))
    } finally {
      bus.unsubscribe('test-health-ingested')
    }
    expect(seen).toEqual([
      { types: ['sleep'], dates: ['2026-09-21'] },
      { types: ['heart_rate'], dates: ['2026-09-21'] },
    ])
  })

  it('a new source order re-merges every night on the next read', async () => {
    ok(rawBatch('sleep', [...watchNight('2026-09-20', '2026-09-21'),
      sleepSample('2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1, APP)]))
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.primarySource?.bundleId).toBe(WATCH.bundleId)
    updateHealthSettings({ sleepSourceOrder: [APP.bundleId] })
    const night = (await readNights(['2026-09-21'])).get('2026-09-21')!
    expect(night.primarySource?.bundleId).toBe(APP.bundleId)
    expect(night.stages).toBeNull()
  })

  it('a category delete removes only that category and pauses', () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    ok(bucketBatch('heart_rate', hrBuckets(NOW - 3_600_000, 3)))
    const del = deleteHealthData({ categories: ['heart'] })
    expect(del).toMatchObject({ deleted: ['heart'], paused: true, removed: 3 })
    expect(count('buckets')).toBe(0)
    expect(count('samples')).toBe(5)
  })

  it('no health value, source name, sample time (any form) or wake date ever reaches a log line', async () => {
    logLines.length = 0
    const hrvAt = '2026-09-21T03:00:00-04:00'
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    ok(rawBatch('hrv_sdnn', [{ uuid: uuid('C'), start: hrvAt, end: '2026-09-21T03:01:00-04:00', value: MARKER_HRV, source: WATCH }]))
    ok(bucketBatch('heart_rate', hrBuckets(Date.parse('2026-09-21T01:00:00-04:00'), 5)))
    updateHealthSettings({ sleepSourceOrder: [APP.bundleId, WATCH.bundleId] })
    await drainMaterializeQueue()
    await readNights(['2026-09-21'])
    deleteHealthData({})
    expect(logLines.length).toBeGreaterThan(0)
    const joined = logLines.join('\n')
    const instants = [hrvAt, '2026-09-21T07:00:00-04:00', '2026-09-20T23:00:00-04:00'].map((t) => Date.parse(t))
    const markers = [
      String(MARKER_HR), String(MARKER_HRV), WATCH.name, APP.name, WATCH.bundleId,
      '2026-09-21T03:00', // local ISO
      ...instants.map(String), // epoch ms
      ...instants.map((ms) => new Date(ms).toISOString().slice(0, 16)), // UTC ISO
      ...instants.map((ms) => String(Math.floor(ms / 1000))), // epoch seconds
      '2026-09-21', '2026-09-20', // the wake date and its eve: when someone slept is personal too
    ]
    for (const marker of markers) {
      expect(joined, `log leaked ${marker}`).not.toContain(marker)
    }
  })

  it('a restart between commit and recompute never serves a stale night (dirty marks are durable)', async () => {
    const samples = watchNight('2026-09-20', '2026-09-21')
    ok(rawBatch('sleep', samples.slice(0, 2)))
    await drainMaterializeQueue()
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.asleepMin).toBe(180)
    ok(rawBatch('sleep', samples.slice(2)))
    // The commit landed; the drain has not run. The process dies here.
    expect(getHealthDb().prepare("SELECT date FROM dirty WHERE kind = 'night'").all()).toEqual([{ date: '2026-09-21' }])
    resetMaterializeQueue()
    closeHealthDb()
    // The next process reads the night: it must be the full one, not the stored half.
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.asleepMin).toBe(470)
    expect(getHealthDb().prepare("SELECT COUNT(*) AS n FROM dirty WHERE kind = 'night'").get()).toEqual({ n: 0 })
  })

  it('a source first seen in a later upload outranks one seen earlier, device or not', async () => {
    const t1 = Date.parse('2026-09-21T09:00:00-04:00')
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')), t1)
    ok(rawBatch('sleep', [sleepSample('2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1, APP)]), t1 + 3_600_000)
    const night = (await readNights(['2026-09-21'])).get('2026-09-21')!
    expect(night.primarySource?.bundleId).toBe(APP.bundleId)
    expect(night.stages).toBeNull()
  })

  it('a stored night with a recording gap carries it to the sleep read, with the caveat', async () => {
    ok(rawBatch('sleep', [
      sleepSample('2026-09-20T23:00:00-04:00', '2026-09-21T03:00:00-04:00', 3),
      sleepSample('2026-09-21T04:10:00-04:00', '2026-09-21T07:00:00-04:00', 3),
    ]))
    const out = await healthSleep({ from: '2026-09-21', to: '2026-09-21' }, NOW)
    expect(out.nights[0].unrecordedGaps).toEqual([expect.objectContaining({ side: 'after', min: 70, otherSleepMin: 170 })])
    expect(out.caveats).toContain(UNRECORDED_GAP_CAVEAT)
  })

  it('a later upload never moves a source\'s first-seen time, so a re-upload keeps its rank', async () => {
    const t1 = Date.parse('2026-09-21T09:00:00-04:00')
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')), t1)
    ok(rawBatch('sleep', [sleepSample('2026-09-20T22:30:00-04:00', '2026-09-21T07:30:00-04:00', 1, APP)]), t1 + 3_600_000)
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.primarySource?.bundleId).toBe(APP.bundleId)
    // The Watch uploads again, into the same night: it was still added FIRST.
    ok(rawBatch('sleep', [sleepSample('2026-09-21T04:00:00-04:00', '2026-09-21T04:05:00-04:00', 2)]), t1 + 7_200_000)
    const firstSeen = getHealthDb().prepare('SELECT first_seen_ms AS ms FROM sources WHERE bundle = ?').get(WATCH.bundleId) as { ms: number }
    expect(firstSeen.ms).toBe(t1)
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.primarySource?.bundleId).toBe(APP.bundleId)
  })

  it('an older sample that moves an existing source\'s first sample re-merges nights it did not touch', async () => {
    const t1 = Date.parse('2026-09-21T09:00:00-04:00')
    // Both first seen in one upload: the tie-break is the LATER first sample, here the app's.
    ok(rawBatch('sleep', [...watchNight('2026-09-20', '2026-09-21'),
      sleepSample('2026-09-20T23:30:00-04:00', '2026-09-21T07:30:00-04:00', 1, APP)]), t1)
    expect((await readNights(['2026-09-21'])).get('2026-09-21')!.primarySource?.bundleId).toBe(APP.bundleId)
    const rev = materializedRev()
    // An older app night arrives: the app's first sample is now the earlier one, so
    // the Watch ranks first, and the 21st (not in this batch) must merge again.
    ok(rawBatch('sleep', [sleepSample('2026-09-18T23:00:00-04:00', '2026-09-19T06:00:00-04:00', 1, APP)]), t1 + 3_600_000)
    expect(materializedRev()).toBe(rev + 1)
    const night = (await readNights(['2026-09-21'])).get('2026-09-21')!
    expect(night.primarySource?.bundleId).toBe(WATCH.bundleId)
    expect(night.stages).not.toBeNull()
  })
})
