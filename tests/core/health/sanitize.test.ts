/**
 * The sync body narrowing that runs on both boxes: caps, junk counting, the
 * unsupported answer, idempotence on its own output, and a relayed batch that
 * can only shrink (so a max-size call stays under the 256 KB bridge frame), and the
 * generic types: names, unit and agg, value and code bounds, the covered names.
 */
import { describe, it, expect } from 'vitest'
import {
  relayPayload, sanitizeHealthSync, serializedBytes,
} from '../../../src/core/health/sanitize.js'
import { HEALTH_MAX_ITEMS_PER_SYNC, HEALTH_MAX_SYNC_BYTES, supportedTypes } from '../../../src/core/health/catalog.js'
import { APP, WATCH, hrBuckets, rawBatch, bucketBatch, sleepSample, uuid } from './fixtures.js'

const NOW = Date.parse('2026-09-21T12:00:00-04:00')

describe('sanitizeHealthSync', () => {
  it('pins the per-call caps the iOS client will be tested against', () => {
    expect(HEALTH_MAX_ITEMS_PER_SYNC).toBe(500)
    expect(HEALTH_MAX_SYNC_BYTES).toBe(196_608)
  })

  it('refuses a call over the item cap or the byte cap with 413, whatever the content', () => {
    const tooMany = { kind: 'raw', type: 'sleep', samples: [], deleted: Array.from({ length: 501 }, () => uuid()) }
    expect(sanitizeHealthSync(tooMany, NOW)).toMatchObject({ ok: false, status: 413, code: 'too_large' })
    const tooBig = { kind: 'raw', type: 'sleep', samples: [{ junk: 'x'.repeat(HEALTH_MAX_SYNC_BYTES) }] }
    expect(sanitizeHealthSync(tooBig, NOW)).toMatchObject({ ok: false, status: 413 })
  })

  it('keeps known fields only, bounds strings and counts every dropped item', () => {
    const good = sleepSample('2026-09-21T01:00:00-04:00', '2026-09-21T02:00:00-04:00', 4)
    const out = sanitizeHealthSync(rawBatch('sleep', [
      { ...good, extra: 'y'.repeat(5000), source: { bundleId: 'b'.repeat(500), name: 'n'.repeat(500) } },
      { ...good, uuid: uuid(), start: '2026-09-21T03:00:00-04:00' }, // end before start
      { ...good, uuid: uuid(), end: '2030-01-01T00:00:00Z' },       // far future
    ], { deleted: ['ok-uuid-1', '../bad'] }), NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.rejected).toBe(3)
    expect(out.batch.deleted).toEqual(['ok-uuid-1'])
    const [s] = out.batch.samples
    expect(Object.keys(s).sort()).toEqual(['code', 'device', 'end', 'source', 'start', 'tz', 'uuid'])
    expect(s.source.bundleId).toHaveLength(200)
    expect(s.source.name).toHaveLength(100)
  })

  it('rejects out-of-range values instead of storing a broken sensor reading', () => {
    const base = { uuid: uuid(), start: '2026-09-21T01:00:00Z', end: '2026-09-21T01:00:00Z', source: WATCH }
    const out = sanitizeHealthSync(rawBatch('heart_rate', [{ ...base, value: 72 }, { ...base, uuid: uuid(), value: 900 }, { ...base, uuid: uuid(), value: Number.NaN }]), NOW)
    expect(out.ok && out.batch.samples.map((x) => x.value)).toEqual([72])
    expect(out.ok && out.rejected).toBe(2)
  })

  it('answers unsupported for a type the catalog does not know, keeping nothing', () => {
    const out = sanitizeHealthSync(rawBatch('blood_glucose', [sleepSample('2026-09-21T01:00:00Z', '2026-09-21T01:00:00Z', 1)]), NOW)
    expect(out).toMatchObject({ ok: true, unsupported: true, rejected: 1 })
    expect(supportedTypes().raw).toContain('sleep')
    expect(supportedTypes().buckets).toContain('heart_rate')
    expect(supportedTypes().raw).not.toContain('steps')
  })

  it('is idempotent on its own output, and the relayed form only shrinks', () => {
    const samples = Array.from({ length: 400 }, (_, i) => sleepSample(
      new Date(NOW - (i + 2) * 60_000).toISOString(), new Date(NOW - (i + 1) * 60_000).toISOString(), 3,
      { bundleId: WATCH.bundleId, name: 'W'.repeat(100) }, { device: 'D'.repeat(100) }))
    const body = rawBatch('sleep', samples)
    const first = sanitizeHealthSync(body, NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const relayed = relayPayload(first.batch)
    expect(serializedBytes(relayed)).toBeLessThanOrEqual(serializedBytes(body))
    const second = sanitizeHealthSync(relayed, NOW)
    expect(second.ok && second.batch).toEqual(first.batch)
    expect(second.ok && second.rejected).toBe(0)
  })

  it('tells a phone how to name generic types, and which names the catalog already covers', () => {
    expect(supportedTypes().generic).toEqual({
      prefixes: ['q', 'c', 'x'], maxTypeLength: 64, bucketPrefixes: ['q'], covered: expect.arrayContaining(['q.HeartRate', 'c.SleepAnalysis']),
    })
    expect(supportedTypes().generic.covered).toHaveLength(19)
  })
})

describe('sanitizeHealthSync: generic types', () => {
  const at = '2026-09-21T08:00:00-04:00'
  const item = (extra: Record<string, unknown>) => ({ uuid: uuid('G'), start: at, end: at, source: APP, ...extra })
  const accepted = (out: ReturnType<typeof sanitizeHealthSync>) => (out.ok ? out.batch.samples.length : -1)

  it('stores a quantity with its unit, a zero-length span included, value within ±1e9', () => {
    const out = sanitizeHealthSync(rawBatch('q.BodyMass', [
      item({ value: 72.4 }),
      item({ value: -1e9 }),
      item({ value: 1e9 }),
      item({ value: 1e9 + 1 }),
      item({ value: Number.POSITIVE_INFINITY }),
      item({ value: 'heavy' }),
      item({}), // neither value nor code
    ], { unit: 'kg' }), NOW)
    expect(out).toMatchObject({ ok: true, rejected: 4 })
    if (!out.ok) return
    expect(out.batch).toMatchObject({ type: 'q.BodyMass', unit: 'kg' })
    expect(out.batch.samples.map((s) => s.value)).toEqual([72.4, -1e9, 1e9])
    expect(out.batch.samples[0].start).toBe(out.batch.samples[0].end)
  })

  it('takes integer codes from 0 to 99,999,999, a category with code only and no unit', () => {
    const out = sanitizeHealthSync(rawBatch('c.MenstrualFlow', [
      item({ code: 0 }), item({ code: 99_999_999 }), item({ code: 3, value: 1 }),
      item({ code: -1 }), item({ code: 100_000_000 }), item({ code: 2.5 }), item({ code: '3' }),
    ]), NOW)
    expect(out).toMatchObject({ ok: true, rejected: 4 })
    if (!out.ok) return
    expect(out.batch.unit).toBeUndefined()
    expect(out.batch.samples.map((s) => [s.code, s.value])).toEqual([[0, undefined], [99_999_999, undefined], [3, 1]])
  })

  it('a quantity call with no unit, or a malformed one, stores nothing and says why; its resync is dropped', () => {
    for (const unit of [undefined, '', 'kg;drop', 'x'.repeat(33), 42]) {
      const out = sanitizeHealthSync(rawBatch('q.BodyMass', [item({ value: 70 })], {
        ...(unit === undefined ? {} : { unit }), deleted: ['gone-1'], resync: { phase: 'end', generation: 3 },
      }), NOW)
      expect(out, String(unit)).toMatchObject({ ok: true, rejected: 1, refused: { field: 'unit' } })
      if (!out.ok) continue
      expect(out.batch.samples).toEqual([])
      expect(out.batch.resync).toBeUndefined()
      expect(out.batch.deleted).toEqual(['gone-1'])
    }
    // Unit syntax HealthKit uses passes.
    for (const unit of ['mg/dL', 'mL/(kg·min)', 'kcal/hr·kg', 'count/min', '%', 'mmHg', 'degC', 'kcal', 'cm^3', 'm/s']) {
      expect(sanitizeHealthSync(rawBatch('q.Generic', [item({ value: 1 })], { unit }), NOW), unit).toMatchObject({ ok: true, rejected: 0 })
    }
  })

  it('a generic name the catalog covers is unsupported, so nothing is stored twice', () => {
    expect(sanitizeHealthSync(rawBatch('q.HeartRate', [item({ value: 60 })], { unit: 'count/min' }), NOW))
      .toMatchObject({ ok: true, unsupported: true, rejected: 1 })
    expect(sanitizeHealthSync(rawBatch('c.SleepAnalysis', [item({ code: 3 })]), NOW)).toMatchObject({ unsupported: true })
    expect(sanitizeHealthSync(bucketBatch('q.StepCount', [{ start: at, intervalSec: 3600, sum: 10 }], { unit: 'count', agg: 'sum' }), NOW))
      .toMatchObject({ unsupported: true })
  })

  it('names: the generic shape up to 64 characters, never cut to fit', () => {
    const name64 = `q.A${'b'.repeat(61)}`
    expect(name64).toHaveLength(64)
    expect(accepted(sanitizeHealthSync(rawBatch(name64, [item({ value: 1 })], { unit: 'kg' }), NOW))).toBe(1)
    // 65 characters: refused whole, not cut down to a different valid name.
    const out = sanitizeHealthSync(rawBatch(`${name64}c`, [item({ value: 1 })], { unit: 'kg' }), NOW)
    expect(out).toMatchObject({ ok: true, unsupported: true })
    for (const bad of ['q.bodyMass', 'z.BodyMass', 'q.B', 'q.Body-Mass', 'Q.BodyMass', 'q..BodyMass']) {
      expect(sanitizeHealthSync(rawBatch(bad, [item({ value: 1 })], { unit: 'kg' }), NOW), bad).toMatchObject({ unsupported: true })
    }
    expect(accepted(sanitizeHealthSync(rawBatch('x.GAD7', [item({ code: 12 })]), NOW))).toBe(1)
  })

  it('keeps the span checks, except for a characteristic, whose times only say when it was read', () => {
    const long = item({ value: 1, start: '2026-09-17T08:00:00-04:00', end: '2026-09-21T08:00:00-04:00' })
    expect(accepted(sanitizeHealthSync(rawBatch('q.Generic', [long], { unit: 'kg' }), NOW))).toBe(0)
    expect(accepted(sanitizeHealthSync(rawBatch('q.Generic', [item({ value: 1, end: '2026-09-21T07:00:00-04:00' })], { unit: 'kg' }), NOW))).toBe(0)
    const reversed = item({ code: 2, start: '2026-09-21T08:00:00-04:00', end: '2026-09-01T08:00:00-04:00' })
    const out = sanitizeHealthSync(rawBatch('x.BloodType', [reversed, { ...long, uuid: uuid('G'), value: undefined, code: 1 }]), NOW)
    expect(out).toMatchObject({ ok: true, rejected: 0 })
    if (!out.ok) return
    expect(out.batch.samples[0].start).toBeLessThan(out.batch.samples[0].end)
    // Still inside the plausible window: a broken clock is still junk.
    expect(accepted(sanitizeHealthSync(rawBatch('x.BloodType', [item({ code: 1, start: '2009-01-01T00:00:00Z' })]), NOW))).toBe(0)
  })

  it('buckets: quantity types only, with an agg, and the field the agg names on every bucket', () => {
    const b = (extra: Record<string, unknown>) => ({ start: at, intervalSec: 3600, ...extra })
    const out = sanitizeHealthSync(bucketBatch('q.FlightsClimbed', [
      b({ sum: 4 }), b({ start: '2026-09-21T09:00:00-04:00', sum: -2e9 }), b({ start: '2026-09-21T10:00:00-04:00', avg: 3 }),
      b({ start: '2026-09-21T11:00:00-04:00', sum: 5, intervalSec: 60 }),
    ], { unit: 'count', agg: 'sum' }), NOW)
    expect(out).toMatchObject({ ok: true, rejected: 3 })
    if (!out.ok) return
    expect(out.batch).toMatchObject({ unit: 'count', agg: 'sum', buckets: [{ sum: 4, intervalSec: 3600 }] })
    expect(sanitizeHealthSync(bucketBatch('q.FlightsClimbed', [b({ sum: 4 })], { unit: 'count' }), NOW))
      .toMatchObject({ ok: true, rejected: 1, refused: { field: 'agg' } })
    expect(sanitizeHealthSync(bucketBatch('q.FlightsClimbed', [b({ sum: 4 })], { unit: 'count', agg: 'max' }), NOW))
      .toMatchObject({ refused: { field: 'agg' } })
    expect(sanitizeHealthSync(bucketBatch('q.FlightsClimbed', [b({ sum: 4 })], { agg: 'sum' }), NOW)).toMatchObject({ refused: { field: 'unit' } })
    expect(sanitizeHealthSync(bucketBatch('c.Headache', [b({ avg: 2 })], { agg: 'avg' }), NOW)).toMatchObject({ unsupported: true, rejected: 1 })
  })

  it('a generic batch survives the relay: unit and agg cross, and a second pass changes nothing', () => {
    for (const body of [
      rawBatch('q.BloodGlucose', [item({ value: 101 }), item({ value: 97, tz: 'Asia/Tokyo' })], { unit: 'mg/dL' }),
      bucketBatch('q.DietaryEnergyConsumed', [{ start: at, intervalSec: 86_400, sum: 2100, count: 4 }], { unit: 'kcal', agg: 'sum' }),
    ]) {
      const first = sanitizeHealthSync(body, NOW)
      expect(first.ok).toBe(true)
      if (!first.ok) return
      const second = sanitizeHealthSync(relayPayload(first.batch), NOW)
      expect(second.ok && second.batch).toEqual(first.batch)
    }
  })
})

describe('sanitizeHealthSync: frame budget', () => {
  it('a maximal legal call relays under the 256 KB bridge frame', () => {
    // 500 buckets padded to just under the byte cap: the narrowed payload must fit a frame.
    const buckets = hrBuckets(NOW - 600 * 300_000, 500)
    const body = bucketBatch('heart_rate', buckets, { pad: 'p'.repeat(HEALTH_MAX_SYNC_BYTES - serializedBytes(bucketBatch('heart_rate', buckets)) - 64) })
    expect(serializedBytes(body)).toBeLessThanOrEqual(HEALTH_MAX_SYNC_BYTES)
    const out = sanitizeHealthSync(body, NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const frame = { action: 'server.health.sync', sessionId: '__server__', params: { body: relayPayload(out.batch), rejected: out.rejected } }
    expect(serializedBytes(frame)).toBeLessThan(256 * 1024)
  })
})
