/**
 * The sync body narrowing that runs on both boxes: caps, junk counting, the
 * unsupported answer, idempotence on its own output, and a relayed batch that
 * can only shrink (so a max-size call stays under the 256 KB bridge frame).
 */
import { describe, it, expect } from 'vitest'
import {
  relayPayload, sanitizeHealthSync, serializedBytes,
} from '../../../src/core/health/sanitize.js'
import { HEALTH_MAX_ITEMS_PER_SYNC, HEALTH_MAX_SYNC_BYTES, supportedTypes } from '../../../src/core/health/catalog.js'
import { WATCH, hrBuckets, rawBatch, bucketBatch, sleepSample, uuid } from './fixtures.js'

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
