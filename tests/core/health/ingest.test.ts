/**
 * The health sync transaction on a real (temp) SQLite store: idempotency,
 * deletes, resync mark and sweep, store identity, caps, pause, and the rule that
 * no health value ever reaches a log line. Generic types: the unit and agg pins
 * and their mismatch answer, a missing unit, characteristics, and category `other`.
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

  it('no generic type name reaches a log line, only its prefix', () => {
    logLines.length = 0
    ok(rawBatch('c.Pregnancy', [{ uuid: uuid('L'), start: '2026-09-21T08:00:00-04:00', end: '2026-09-21T08:00:00-04:00', code: 0, source: APP }]))
    ok(rawBatch('q.BodyMass', [{ uuid: uuid('L'), start: '2026-09-21T08:00:00-04:00', end: '2026-09-21T08:00:00-04:00', value: 70, source: APP }], { unit: 'kg' }))
    ok(rawBatch('q.BodyMass', [], { unit: 'lb' }))
    const joined = logLines.join('\n')
    expect(joined).toContain('health sync applied')
    for (const marker of ['Pregnancy', 'BodyMass', '"kg"', '"lb"']) expect(joined, `log leaked ${marker}`).not.toContain(marker)
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

describe('health sync ingest: generic types', () => {
  const at = '2026-09-21T08:00:00-04:00'
  const sample = (extra: Record<string, unknown>) => ({ uuid: uuid('Q'), start: at, end: at, source: APP, ...extra })
  const meta = (key: string): string | undefined =>
    (getHealthDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const rows = (type: string): number => (getHealthDb().prepare('SELECT COUNT(*) AS n FROM samples WHERE type = ?').get(type) as { n: number }).n

  it('stores generic raw samples, pins the first unit, and a resend is a no-op', () => {
    const batch = rawBatch('q.BodyMass', [sample({ value: 72.4 }), sample({ value: 72.1 })], { unit: 'kg' })
    expect(ok(batch)).toMatchObject({ accepted: 2, inserted: 2 })
    expect(ok(batch)).toMatchObject({ accepted: 2, inserted: 0 })
    expect(rows('q.BodyMass')).toBe(2)
    expect(meta('unit:q.BodyMass')).toBe('kg')
    // A category type takes codes and no unit; nothing is pinned for it.
    expect(ok(rawBatch('c.Headache', [sample({ code: 3 })]))).toMatchObject({ accepted: 1, inserted: 1 })
    expect(meta('unit:c.Headache')).toBeUndefined()
  })

  it('a later call in another unit stores nothing, answers unitMismatch, and still applies its deletions', () => {
    const first = sample({ value: 72.4 })
    ok(rawBatch('q.BodyMass', [first], { unit: 'kg' }))
    const out = ok(rawBatch('q.BodyMass', [sample({ value: 160 })], { unit: 'lb', deleted: [first.uuid] }))
    expect(out).toMatchObject({ accepted: 0, inserted: 0, deleted: 1, unitMismatch: { type: 'q.BodyMass', field: 'unit', stored: 'kg', sent: 'lb' } })
    // Not junk: the phone keeps its anchor and sends it again in the stored unit.
    expect(out.rejected).toBeUndefined()
    expect(rows('q.BodyMass')).toBe(0)
    expect(meta('unit:q.BodyMass')).toBe('kg')
    expect(ok(rawBatch('q.BodyMass', [sample({ value: 72.6 })], { unit: 'kg' }))).toMatchObject({ inserted: 1 })
  })

  it('a mismatched call never resyncs: its end would sweep every row of the type', () => {
    ok(rawBatch('q.BodyMass', [sample({ value: 70 }), sample({ value: 71 })], { unit: 'kg' }))
    expect(ok(rawBatch('q.BodyMass', [], { unit: 'kg', resync: { phase: 'begin', generation: 4 } })).resync).toMatchObject({ marked: 2 })
    const end = ok(rawBatch('q.BodyMass', [], { unit: 'lb', resync: { phase: 'end', generation: 4 } }))
    expect(end.unitMismatch).toMatchObject({ field: 'unit' })
    expect(end.resync).toBeUndefined()
    expect(rows('q.BodyMass')).toBe(2)
  })

  it('a quantity call without a unit stores nothing, sweeps nothing and says which field', () => {
    ok(rawBatch('q.BodyMass', [sample({ value: 70 })], { unit: 'kg' }))
    expect(ok(rawBatch('q.BodyMass', [], { unit: 'kg', resync: { phase: 'begin', generation: 5 } })).resync).toMatchObject({ marked: 1 })
    const out = ok(rawBatch('q.BodyMass', [sample({ value: 71 })], { resync: { phase: 'end', generation: 5 } }))
    expect(out).toMatchObject({ accepted: 0, rejected: 1, refused: { field: 'unit' } })
    expect(out.resync).toBeUndefined()
    expect(rows('q.BodyMass')).toBe(1)
  })

  it('buckets: the agg is pinned with the unit, and a different agg is a mismatch', async () => {
    const day = (d: string, sum: number) => ({ start: `${d}T00:00:00-04:00`, intervalSec: 86_400, sum })
    expect(ok(bucketBatch('q.FlightsClimbed', [day('2026-09-20', 8), day('2026-09-21', 11)], { unit: 'count', agg: 'sum' })))
      .toMatchObject({ accepted: 2 })
    expect(meta('agg:q.FlightsClimbed')).toBe('sum')
    expect(meta('unit:q.FlightsClimbed')).toBe('count')
    const avg = ok(bucketBatch('q.FlightsClimbed', [{ start: '2026-09-21T00:00:00-04:00', intervalSec: 86_400, avg: 3 }], { unit: 'count', agg: 'avg' }))
    expect(avg).toMatchObject({ accepted: 0, unitMismatch: { type: 'q.FlightsClimbed', field: 'agg', stored: 'sum', sent: 'avg' } })
    // A replaced bucket keeps its key.
    ok(bucketBatch('q.FlightsClimbed', [day('2026-09-21', 12)], { unit: 'count', agg: 'sum' }))
    expect(count('buckets')).toBe(2)
  })

  it('a generic sync marks no derived day or night stale, and still announces its dates', async () => {
    const seen: unknown[] = []
    bus.subscribe('test-health-generic', (e) => { if (e.name === 'health:ingested') seen.push(e.data) }, { global: true })
    try {
      ok(rawBatch('q.BloodGlucose', [sample({ value: 101 })], { unit: 'mg/dL' }))
      ok(bucketBatch('q.FlightsClimbed', [{ start: '2026-09-21T00:00:00-04:00', intervalSec: 86_400, sum: 9 }], { unit: 'count', agg: 'sum' }))
    } finally {
      bus.unsubscribe('test-health-generic')
    }
    expect(count('dirty')).toBe(0)
    expect(seen).toEqual([{ types: ['q.BloodGlucose'], dates: ['2026-09-21'] }, { types: ['q.FlightsClimbed'], dates: ['2026-09-21'] }])
    // A day summary never folds them: it reads catalog rows only.
    ok(bucketBatch('steps', [{ start: '2026-09-21T09:00:00-04:00', intervalSec: 3600, sum: 500 }]))
    await drainMaterializeQueue()
    const d = (await readDays(['2026-09-21'])).get('2026-09-21')!
    expect(d.activity.steps).toBe(500)
  })

  it('a covered generic name is unsupported and stores nothing', () => {
    const out = ok(rawBatch('q.HeartRate', [sample({ value: 60 })], { unit: 'count/min' }))
    expect(out).toMatchObject({ accepted: 0, unsupported: true, rejected: 1 })
    expect(count('samples')).toBe(0)
  })

  it('a characteristic re-sent under its uuid replaces the stored value', () => {
    const id = 'characteristic-ActivityMoveMode'
    ok(rawBatch('x.ActivityMoveMode', [{ uuid: id, start: at, end: at, code: 1, source: APP }]))
    const again = ok(rawBatch('x.ActivityMoveMode', [{ uuid: id, start: '2026-09-21T09:00:00-04:00', end: '2026-09-21T09:00:00-04:00', code: 2, source: APP }]))
    expect(again).toMatchObject({ accepted: 1, inserted: 0 })
    expect(getHealthDb().prepare('SELECT code FROM samples WHERE uuid = ?').all(id)).toEqual([{ code: 2 }])
    // A quantity resent under the same uuid is still insert-or-ignore.
    const q = sample({ value: 70 })
    ok(rawBatch('q.BodyMass', [q], { unit: 'kg' }))
    ok(rawBatch('q.BodyMass', [{ ...q, value: 99 }], { unit: 'kg' }))
    expect(getHealthDb().prepare('SELECT value FROM samples WHERE uuid = ?').all(q.uuid)).toEqual([{ value: 70 }])
    // The uuid is global: a characteristic never overwrites another type's row.
    ok(rawBatch('x.BloodType', [{ ...q, code: 7, value: undefined }]))
    expect(getHealthDb().prepare('SELECT type, value, code FROM samples WHERE uuid = ?').all(q.uuid)).toEqual([{ type: 'q.BodyMass', value: 70, code: null }])
  })

  it('a characteristic the way the phone sends it: a changed value is a new uuid, the old one deleted in the same call', () => {
    const health = { bundleId: 'com.apple.Health', name: 'Health' }
    const char = (code: number, when: string) => ({ uuid: `char-wheelchairuse-${code}`, start: when, end: when, code, source: health })
    ok(rawBatch('x.WheelchairUse', [char(1, '2026-09-20T08:00:00-04:00')]))
    const changed = ok(rawBatch('x.WheelchairUse', [char(2, at)], { deleted: ['char-wheelchairuse-1'] }))
    expect(changed).toMatchObject({ accepted: 1, inserted: 1, deleted: 1 })
    expect(getHealthDb().prepare("SELECT uuid, code FROM samples WHERE type = 'x.WheelchairUse'").all()).toEqual([{ uuid: 'char-wheelchairuse-2', code: 2 }])
    // A cleared value sends only the deletion.
    expect(ok(rawBatch('x.WheelchairUse', [], { deleted: ['char-wheelchairuse-2'] }))).toMatchObject({ deleted: 1 })
    expect(rows('x.WheelchairUse')).toBe(0)
  })

  it('category `other` holds every generic type: switch it off, and a list saved before it existed keeps it on', () => {
    // Saved before `other` existed: no categoriesKnown beside it.
    getHealthDb().prepare("INSERT INTO meta (key, value) VALUES ('categories', ?)").run(JSON.stringify(['sleep', 'heart']))
    expect(ok(rawBatch('q.BodyMass', [sample({ value: 70 })], { unit: 'kg' }))).toMatchObject({ accepted: 1 })
    expect(ok(bucketBatch('steps', [{ start: at, intervalSec: 3600, sum: 10 }]))).toMatchObject({ categoryDisabled: true })
    updateHealthSettings({ categories: ['sleep', 'heart'] })
    expect(ok(rawBatch('q.BodyMass', [sample({ value: 71 })], { unit: 'kg' }))).toMatchObject({ accepted: 0, categoryDisabled: true })
    updateHealthSettings({ categories: ['sleep', 'other'] })
    expect(ok(rawBatch('q.BodyMass', [sample({ value: 72 })], { unit: 'kg' }))).toMatchObject({ accepted: 1 })
  })

  it('deleting category `other` removes every generic row and its pins, and nothing else', () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    ok(rawBatch('q.BodyMass', [sample({ value: 70 })], { unit: 'kg' }))
    ok(rawBatch('c.Headache', [sample({ code: 2 })]))
    ok(bucketBatch('q.FlightsClimbed', [{ start: '2026-09-21T00:00:00-04:00', intervalSec: 86_400, sum: 9 }], { unit: 'count', agg: 'sum' }))
    ok(rawBatch('q.BloodGlucose', [], { unit: 'mg/dL', resync: { phase: 'begin', generation: 2 } }))
    const del = deleteHealthData({ categories: ['other'] })
    expect(del).toMatchObject({ deleted: ['other'], paused: true, removed: 3 })
    expect(count('samples')).toBe(5)
    expect(count('buckets')).toBe(0)
    const keys = (getHealthDb().prepare("SELECT key FROM meta WHERE key GLOB 'unit:*' OR key GLOB 'agg:*' OR key GLOB 'resync:*'").all() as Array<{ key: string }>)
    expect(keys).toEqual([])
    // A fresh sync may pin a new unit.
    updateHealthSettings({ paused: false, categories: ['sleep', 'other'] })
    expect(ok(rawBatch('q.BodyMass', [sample({ value: 160 })], { unit: 'lb', storeId: del.storeId }))).toMatchObject({ accepted: 1 })
  })
})
