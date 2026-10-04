/**
 * The agent's reads of generic Apple Health types on a real (temp) store:
 * health_status lists every stored generic type (unit, kind, first and last
 * instants) and says the server understands generic names; health_series folds a
 * q. type from raw samples or from buckets by its pinned agg; health_samples
 * returns rows newest first, bounded, with codes as sent, and a characteristic
 * whatever its age. Invented data only.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-generic-reads'))

import { ingestHealthSync } from '../../../src/core/health/ingest.js'
import { closeHealthDb, destroyHealthDbFiles } from '../../../src/core/health/db.js'
import { resetMaterializeQueue } from '../../../src/core/health/materialize.js'
import { HealthQueryError, healthSeries, healthStatus } from '../../../src/core/health/queries.js'
import { samplesQuery } from '../../../src/core/health/samples.js'
import { APP, WATCH, bucketBatch, rawBatch, uuid, watchNight } from './fixtures.js'

const NOW = Date.parse('2026-09-21T12:00:00-04:00')
const ok = (body: unknown, now = NOW): Record<string, any> => {
  const out = ingestHealthSync(body, { now })
  expect(out.status, JSON.stringify(out.body)).toBe(200)
  return out.body as Record<string, any>
}
const at = (iso: string, extra: Record<string, unknown>) => ({ uuid: uuid('R'), start: iso, end: iso, source: APP, ...extra })

beforeEach(() => {
  resetMaterializeQueue()
  destroyHealthDbFiles()
})

afterAll(() => closeHealthDb())

describe('health_status with generic types', () => {
  it('lists every stored generic type with its unit and kind, and says generic names are understood', () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    ok(rawBatch('q.BodyMass', [at('2026-09-19T08:00:00-04:00', { value: 72.4 }), at('2026-09-21T08:00:00-04:00', { value: 72.1 })], { unit: 'kg' }))
    ok(rawBatch('c.Headache', [at('2026-09-20T15:00:00-04:00', { code: 3 })]))
    ok(bucketBatch('q.FlightsClimbed', [{ start: '2026-09-21T00:00:00-04:00', intervalSec: 86_400, sum: 9 }], { unit: 'count', agg: 'sum' }))
    ok(rawBatch('q.FlightsClimbed', [at('2026-09-21T09:00:00-04:00', { value: 2 })], { unit: 'count' }))
    const st = healthStatus(NOW)
    expect(st.supported.generic).toMatchObject({ prefixes: ['q', 'c', 'x'], maxTypeLength: 64 })
    const generic = st.types.filter((t) => t.category === 'other')
    expect(generic).toEqual([
      { type: 'c.Headache', category: 'other', enabled: true, lastSampleAt: '2026-09-20T19:00:00.000Z', state: 'ok',
        firstSampleAt: '2026-09-20T19:00:00.000Z', unit: null, kind: 'raw' },
      { type: 'q.BodyMass', category: 'other', enabled: true, lastSampleAt: '2026-09-21T12:00:00.000Z', state: 'ok',
        firstSampleAt: '2026-09-19T12:00:00.000Z', unit: 'kg', kind: 'raw' },
      // Today's day bucket ends at tomorrow's midnight; the read caps it at now.
      { type: 'q.FlightsClimbed', category: 'other', enabled: true, lastSampleAt: new Date(NOW).toISOString(), state: 'ok',
        firstSampleAt: '2026-09-21T04:00:00.000Z', unit: 'count', kind: 'both', agg: 'sum' },
    ])
    expect(st.units).toMatchObject({ 'q.BodyMass': 'kg', 'q.FlightsClimbed': 'count', sleep: 'code' })
    expect(st.coverage.from).toBe('2026-09-19')
    // The catalog list is unchanged beside them.
    expect(st.types.find((t) => t.type === 'sleep')).toMatchObject({ state: 'ok', category: 'sleep' })
    expect(st.categories).toContain('other')
  })

  it('a store with no generic data lists none', () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    expect(healthStatus(NOW).types.filter((t) => t.category === 'other')).toEqual([])
  })
})

describe('health_series for a generic quantity type', () => {
  it('raw samples fold to avg, min, max and sum, in the pinned unit', async () => {
    ok(rawBatch('q.DietaryProtein', [
      at('2026-09-20T08:00:00-04:00', { value: 20 }), at('2026-09-20T13:00:00-04:00', { value: 35 }),
      at('2026-09-21T08:00:00-04:00', { value: 25 }),
    ], { unit: 'g' }))
    const s = await healthSeries({ metric: 'q.DietaryProtein', from: '2026-09-20', to: '2026-09-21', bucket: '1d' }, NOW)
    expect(s).toMatchObject({ metric: 'q.DietaryProtein', unit: 'g', sourceIntervalSec: 0 })
    expect(s.points).toEqual([
      { t: '2026-09-20', avg: 27.5, min: 20, max: 35, sum: 55, count: 2 },
      { t: '2026-09-21', avg: 25, min: 25, max: 25, sum: 25, count: 1 },
    ])
  })

  it('buckets fold by the agg pinned at the first bucket sync', async () => {
    ok(bucketBatch('q.FlightsClimbed', [
      { start: '2026-09-21T08:00:00-04:00', intervalSec: 3600, sum: 3 }, { start: '2026-09-21T09:00:00-04:00', intervalSec: 3600, sum: 4 },
    ], { unit: 'count', agg: 'sum' }))
    const s = await healthSeries({ metric: 'q.FlightsClimbed', from: '2026-09-21', to: '2026-09-21', bucket: '1d' }, NOW)
    expect(s).toMatchObject({ unit: 'count', agg: 'sum', sourceIntervalSec: 3600, points: [{ t: '2026-09-21', sum: 7, count: 0 }] })
    ok(bucketBatch('q.WalkingSpeed', [{ start: '2026-09-21T08:00:00-04:00', intervalSec: 3600, avg: 1.2, min: 0.9, max: 1.5, count: 4 }], { unit: 'm/s', agg: 'avg' }))
    const w = await healthSeries({ metric: 'q.WalkingSpeed', from: '2026-09-21', to: '2026-09-21', bucket: '1d' }, NOW)
    expect(w.points).toEqual([{ t: '2026-09-21', avg: 1.2, min: 0.9, max: 1.5, count: 4 }])
  })

  it('a covered name reads its catalog metric; a category type or a junk name is a 400', async () => {
    ok(bucketBatch('steps', [{ start: '2026-09-21T09:00:00-04:00', intervalSec: 3600, sum: 500 }]))
    const s = await healthSeries({ metric: 'q.StepCount', from: '2026-09-21', to: '2026-09-21', bucket: '1d' }, NOW)
    expect(s).toMatchObject({ metric: 'steps', requested: 'q.StepCount', points: [{ sum: 500 }] })
    await expect(healthSeries({ metric: 'c.Headache' }, NOW)).rejects.toThrow(/health_samples/)
    await expect(healthSeries({ metric: 'sleep' }, NOW)).rejects.toBeInstanceOf(HealthQueryError)
    await expect(healthSeries({ metric: 'q.bad name' }, NOW)).rejects.toBeInstanceOf(HealthQueryError)
    // A well-formed type with no data is an empty series, not an error.
    expect(await healthSeries({ metric: 'q.BloodGlucose' }, NOW)).toMatchObject({ unit: null, points: [] })
  })
})

describe('health_samples', () => {
  it('returns rows newest first with value, code, unit, source and meta, bounded by limit', async () => {
    ok(rawBatch('q.BloodPressureSystolic', [
      at('2026-09-19T08:00:00-04:00', { value: 121, meta: { userEntered: true } }),
      at('2026-09-20T08:00:00-04:00', { value: 118, device: 'Cuff' }),
      at('2026-09-21T08:00:00-04:00', { value: 125, tz: 'Asia/Tokyo' }),
    ], { unit: 'mmHg' }))
    const all = await samplesQuery({ type: 'q.BloodPressureSystolic' }, NOW)
    expect(all).toMatchObject({ type: 'q.BloodPressureSystolic', unit: 'mmHg', truncated: false })
    expect(all.rows.map((r) => r.value)).toEqual([125, 118, 121])
    expect(all.rows[0]).toEqual({
      start: '2026-09-21T21:00:00+09:00', end: '2026-09-21T21:00:00+09:00', value: 125, code: null, unit: 'mmHg',
      source: APP.name, device: null, tz: 'Asia/Tokyo', meta: null,
    })
    expect(all.rows[1]).toMatchObject({ device: 'Cuff', start: '2026-09-20T08:00:00-04:00' })
    expect(all.rows[2].meta).toEqual({ userEntered: true })
    const two = await samplesQuery({ type: 'q.BloodPressureSystolic', limit: '2' }, NOW)
    expect(two).toMatchObject({ truncated: true })
    expect(two.rows.map((r) => r.value)).toEqual([125, 118])
    const window = await samplesQuery({ type: 'q.BloodPressureSystolic', from: '2026-09-20', to: '2026-09-20' }, NOW)
    expect(window.rows.map((r) => r.value)).toEqual([118])
  })

  it('category codes and an ECG come back as sent', async () => {
    ok(rawBatch('c.MenstrualFlow', [at('2026-09-20T07:00:00-04:00', { code: 3 })]))
    ok(rawBatch('x.Electrocardiogram', [{ ...at('2026-09-21T07:00:00-04:00', { code: 1, value: 64 }), end: '2026-09-21T07:00:30-04:00' }], { unit: 'count/min' }))
    expect((await samplesQuery({ type: 'c.MenstrualFlow' }, NOW)).rows).toMatchObject([{ code: 3, value: null, unit: null }])
    expect((await samplesQuery({ type: 'x.Electrocardiogram' }, NOW)).rows).toMatchObject([{ code: 1, value: 64, unit: 'count/min', end: '2026-09-21T07:00:30-04:00' }])
  })

  it('a characteristic ignores the window: blood type read once months ago is still the answer', async () => {
    const readAt = Date.parse('2026-04-01T12:00:00Z')
    ok(rawBatch('x.BloodType', [{ uuid: 'characteristic-BloodType', start: '2026-04-01T12:00:00Z', end: '2026-04-01T12:00:00Z', code: 7, source: APP }]), readAt)
    const out = await samplesQuery({ type: 'x.BloodType', from: '2026-09-21', to: '2026-09-21' }, NOW)
    expect(out.rows).toMatchObject([{ code: 7 }])
    expect(out).not.toHaveProperty('from')
  })

  it('reads catalog raw types too, with the sleep code legend; buckets-only types and junk are a 400', async () => {
    ok(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    const sleep = await samplesQuery({ type: 'sleep', limit: 2 }, NOW)
    expect(sleep).toMatchObject({ unit: 'code', truncated: true, codes: { asleepDeep: 4 } })
    expect(sleep.rows.map((r) => [r.code, r.source])).toEqual([[3, WATCH.name], [5, WATCH.name]])
    await expect(samplesQuery({ type: 'steps' }, NOW)).rejects.toThrow(/health_series/)
    await expect(samplesQuery({ type: 'blood_glucose' }, NOW)).rejects.toBeInstanceOf(HealthQueryError)
    for (const limit of ['0', '501', 'ten', 2.5]) {
      await expect(samplesQuery({ type: 'sleep', limit }, NOW), String(limit)).rejects.toThrow(/limit/)
    }
    await expect(samplesQuery({ type: 'sleep', from: '2026-01-01', to: '2026-09-21' }, NOW)).rejects.toThrow(/at most 90 days/)
  })

  it('a quantity stored only as buckets says where to read it', async () => {
    ok(bucketBatch('q.FlightsClimbed', [{ start: '2026-09-21T00:00:00-04:00', intervalSec: 86_400, sum: 9 }], { unit: 'count', agg: 'sum' }))
    const out = await samplesQuery({ type: 'q.FlightsClimbed' }, NOW)
    expect(out.rows).toEqual([])
    expect(out.note).toMatch(/health_series/)
  })
})
