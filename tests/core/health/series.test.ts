/**
 * Recordings (s.Audiogram, s.HeartbeatSeries, s.WorkoutRoute): sanitize, store,
 * delete, relay guard, status and the health_recordings read, on a real (temp)
 * store. Invented data only; the coordinates are a made-up loop in open water.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-health-series'))

import { closeHealthDb, destroyHealthDbFiles, getHealthDb } from '../../../src/core/health/db.js'
import { ingestHealthSync } from '../../../src/core/health/ingest.js'
import { resetMaterializeQueue } from '../../../src/core/health/materialize.js'
import { healthStatus } from '../../../src/core/health/queries.js'
import { RELAY_GENERIC_FLAG, RELAY_SERIES_FLAG, runHealthAction } from '../../../src/core/health/relay.js'
import { relayPayload, sanitizeHealthSync } from '../../../src/core/health/sanitize.js'
import { samplesQuery } from '../../../src/core/health/samples.js'
import { recordingsQuery } from '../../../src/core/health/series-store.js'
import { deleteHealthData, updateHealthSettings } from '../../../src/core/health/settings.js'
import { APP, TZ, WATCH, rawBatch, uuid } from './fixtures.js'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const START = '2026-10-19T18:00:00-04:00'
const END = '2026-10-19T18:30:00-04:00'

/** A route of `n` points, one a second, walking north-east from a made-up point. */
function routePoints(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i * 1000, 10 + i * 0.00001, -30 + i * 0.00001, 5 + (i % 10), 4.5, 2.5])
}

/** Chunk items for one route; it ends at its last point (at least 30 minutes after START). */
function routeItems(id: string, points: number[][], perChunk: number, extra: Record<string, unknown> = {}) {
  const chunks = Math.ceil(points.length / perChunk)
  const last = points.length ? points[points.length - 1][0] : 0
  const end = last > 30 * 60_000 ? new Date(Date.parse(START) + last).toISOString() : END
  return Array.from({ length: chunks }, (_, c) => ({
    uuid: id, start: START, end, source: WATCH, device: 'Watch', chunk: c, chunks,
    points: points.slice(c * perChunk, (c + 1) * perChunk), ...extra,
  }))
}

const audiogram = (id = uuid('G')) => ({
  uuid: id, start: '2026-10-18T10:00:00-04:00', end: '2026-10-18T10:05:00-04:00', source: APP,
  points: [[500, 10, 15], [1000, 15, 20], [2000, 20, 25], [4000, 35, null], [8000, null, 40]],
})

const beats = (id = uuid('B')) => ({
  uuid: id, start: '2026-10-19T03:00:00-04:00', end: '2026-10-19T03:01:00-04:00', source: WATCH,
  // 1000 ms, 1000 ms, then a gap, then 800 ms.
  points: [[0, 0], [1000, 0], [2000, 0], [10_000, 1], [10_800, 0]],
})

function sync(body: unknown) {
  const out = ingestHealthSync(body, { now: NOW })
  expect(out.status).toBe(200)
  return out.body as Record<string, any>
}

beforeEach(() => {
  resetMaterializeQueue()
  destroyHealthDbFiles()
})

afterAll(() => closeHealthDb())

describe('recording sanitize', () => {
  it('keeps valid chunks and drops a chunk with one junk point, a duplicate chunk, or too many points', () => {
    const id = uuid('R')
    const good = routeItems(id, routePoints(10), 5)
    const junk = { ...good[0], uuid: uuid('R'), points: [[0, 91, 0, null, null, null]] }
    const dup = good[1]
    const tooMany = routeItems(uuid('R'), routePoints(2001), 2001)[0]
    const out = sanitizeHealthSync(rawBatch('s.WorkoutRoute', [...good, junk, dup, tooMany]), NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.batch.series?.map((s) => `${s.uuid}#${s.chunk}`)).toEqual([`${id}#0`, `${id}#1`])
    expect(out.rejected).toBe(3)
    expect(out.batch.samples).toEqual([])
  })

  it('rejects a bad chunk index, an offset past the end, and a non-finite or out-of-range value', () => {
    const base = { uuid: uuid('B'), start: START, end: END, source: WATCH }
    const items = [
      { ...base, chunk: 2, chunks: 2, points: [[0, 0]] },
      { ...base, uuid: uuid('B'), chunks: 21, points: [[0, 0]] },
      { ...base, uuid: uuid('B'), points: [[40 * 60_000, 0]] },
      { ...base, uuid: uuid('B'), points: [[0, 2]] },
      { ...base, uuid: uuid('B'), points: [[0, 0]] },
    ]
    const out = sanitizeHealthSync(rawBatch('s.HeartbeatSeries', items), NOW)
    expect(out.ok && out.batch.series?.length).toBe(1)
    const ear = sanitizeHealthSync(rawBatch('s.Audiogram', [{ ...audiogram(), points: [[1000, null, null]] }]), NOW)
    expect(ear.ok && ear.batch.series?.length).toBe(0)
  })

  it('a route reading out of range becomes null instead of dropping the chunk', () => {
    const item = { ...routeItems(uuid('R'), routePoints(2), 10)[0], points: [[0, 10, -30, 11_500, 20_000, 400], [1000, 10, -30, 5, 4, 2]] }
    const out = sanitizeHealthSync(rawBatch('s.WorkoutRoute', [item]), NOW)
    expect(out.ok && out.batch.series?.[0].points).toEqual([[0, 10, -30, 11_500, null, null], [1000, 10, -30, 5, 4, 2]])
    const nan = { ...item, uuid: uuid('R'), points: [[0, 10, -30, Number.NaN, null, null]] }
    // Not a number at all is still junk (JSON cannot carry one; a client bug).
    const junk = sanitizeHealthSync(rawBatch('s.WorkoutRoute', [nan]), NOW)
    expect(junk.ok && junk.batch.series).toEqual([])
  })

  it('a long route summarizes without a stack overflow', () => {
    const id = uuid('R')
    const pts = routePoints(150_000)
    const items = routeItems(id, pts, 2000)
    for (const item of items) sync(rawBatch('s.WorkoutRoute', [item]))
    // 150 000 s from START ends the next day, after NOW's "today".
    const row = recordingsQuery({ type: 's.WorkoutRoute', to: '2026-10-21' }, NOW).recordings[0]
    expect(row.complete).toBe(true)
    expect((row.summary as Record<string, number>).maxSpeedMps).toBe(2.5)
  })

  it('an unknown s. name and a bucket call are unsupported', () => {
    for (const body of [rawBatch('s.Nope', [audiogram()]), { ...rawBatch('s.Audiogram', []), kind: 'buckets', metric: 's.Audiogram', buckets: [{}] }]) {
      const out = sanitizeHealthSync(body, NOW)
      expect(out.ok && out.unsupported).toBe(true)
    }
  })

  it('narrowing is idempotent: a relayed payload sanitizes to the same batch', () => {
    const first = sanitizeHealthSync(rawBatch('s.WorkoutRoute', routeItems(uuid('R'), routePoints(30), 10)), NOW)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const again = sanitizeHealthSync(relayPayload(first.batch), NOW)
    expect(again.ok && again.batch).toEqual(first.batch)
  })
})

describe('recording ingest', () => {
  it('stores a route across calls, completes it with the last chunk, and a resend stores nothing twice', () => {
    const id = uuid('R')
    const items = routeItems(id, routePoints(2500), 1000)
    const a = sync(rawBatch('s.WorkoutRoute', items.slice(0, 2)))
    expect(a).toMatchObject({ accepted: 2, inserted: 2 })
    expect(a.completed).toBeUndefined()
    let list = recordingsQuery({ type: 's.WorkoutRoute' }, NOW)
    expect(list.recordings[0]).toMatchObject({ id, complete: false, chunksReceived: 2, chunks: 3, summary: null })

    const b = sync(rawBatch('s.WorkoutRoute', items.slice(2)))
    expect(b).toMatchObject({ accepted: 1, inserted: 1, completed: 1 })
    const again = sync(rawBatch('s.WorkoutRoute', items))
    expect(again).toMatchObject({ accepted: 3, inserted: 0 })
    expect(again.completed).toBeUndefined()

    list = recordingsQuery({ type: 's.WorkoutRoute' }, NOW)
    expect(list.recordings).toHaveLength(1)
    const summary = list.recordings[0].summary as Record<string, number>
    expect(list.recordings[0].complete).toBe(true)
    expect(summary.points).toBe(2500)
    // 2499 steps of 0.00001° north and east at 10°N: 1.5605 m each.
    expect(summary.distanceM).toBeGreaterThan(3880)
    expect(summary.distanceM).toBeLessThan(3920)
    expect(summary.durationMin).toBeCloseTo(41.7, 1)

    const detail = recordingsQuery({ type: 's.WorkoutRoute', id }, NOW)
    expect(detail.columns).toEqual(['offsetMs', 'lat', 'lon', 'altitudeM', 'hAccuracyM', 'speedMps'])
    expect(detail.points).toHaveLength(2000)
    expect(detail.points[0]).toEqual(routePoints(1)[0])
    expect(detail.points[1999][0]).toBe(2499_000)
    expect(detail.thinned).toEqual({ from: 2500, to: 2000 })
  })

  it('a chunk count that changed replaces the recording instead of mixing two chunkings', () => {
    const id = uuid('R')
    const pts = routePoints(40)
    sync(rawBatch('s.WorkoutRoute', routeItems(id, pts, 10).slice(0, 3)))
    const out = sync(rawBatch('s.WorkoutRoute', routeItems(id, pts, 20)))
    expect(out).toMatchObject({ inserted: 2, completed: 1 })
    expect(recordingsQuery({ type: 's.WorkoutRoute', id }, NOW).points).toHaveLength(40)
    const chunks = getHealthDb().prepare('SELECT COUNT(*) AS n FROM series_chunks WHERE uuid = ?').get(id) as { n: number }
    expect(chunks.n).toBe(2)
  })

  it('summarizes an audiogram and a heartbeat series', () => {
    sync(rawBatch('s.Audiogram', [audiogram()]))
    sync(rawBatch('s.HeartbeatSeries', [beats()]))
    const ear = recordingsQuery({ type: 's.Audiogram' }, NOW).recordings[0].summary as Record<string, unknown>
    expect(ear).toMatchObject({ points: 5, leftPureToneAverageDbHL: 20, rightPureToneAverageDbHL: null })
    const hb = recordingsQuery({ type: 's.HeartbeatSeries' }, NOW).recordings[0].summary as Record<string, unknown>
    // Intervals 1000, 1000, 800 (the gap is skipped): mean 933.3 ms = 64.3 bpm.
    expect(hb).toMatchObject({ beats: 5, gaps: 1, meanIntervalMs: 933.3, meanHeartRate: 64.3 })
    expect(hb.rmssdMs).toBeCloseTo(141.4, 1)
  })

  it('a deleted uuid removes the recording and every chunk; deletions apply while paused', () => {
    const id = uuid('R')
    sync(rawBatch('s.WorkoutRoute', routeItems(id, routePoints(20), 10)))
    updateHealthSettings({ paused: true })
    const out = sync(rawBatch('s.WorkoutRoute', [], { deleted: [id] }))
    expect(out).toMatchObject({ paused: true, deleted: 1, accepted: 0 })
    expect(recordingsQuery({ type: 's.WorkoutRoute' }, NOW).recordings).toEqual([])
    expect((getHealthDb().prepare('SELECT COUNT(*) AS n FROM series_chunks').get() as { n: number }).n).toBe(0)
  })

  it('a switched-off category stores nothing and says so', () => {
    updateHealthSettings({ categories: ['sleep', 'heart', 'activity', 'vitals', 'mind', 'audio', 'other'] })
    const out = sync(rawBatch('s.WorkoutRoute', routeItems(uuid('R'), routePoints(5), 10)))
    expect(out).toMatchObject({ accepted: 0, categoryDisabled: true })
    expect(sync(rawBatch('s.Audiogram', [audiogram()]))).toMatchObject({ accepted: 1 })
  })

  it('a category delete removes only that category\'s recordings; a full delete removes all', () => {
    sync(rawBatch('s.WorkoutRoute', routeItems(uuid('R'), routePoints(5), 10)))
    sync(rawBatch('s.Audiogram', [audiogram()]))
    sync(rawBatch('s.HeartbeatSeries', [beats()]))
    const scoped = deleteHealthData({ categories: ['workouts'] })
    expect(scoped.removed).toBeGreaterThanOrEqual(1)
    expect(recordingsQuery({ type: 's.WorkoutRoute' }, NOW).recordings).toEqual([])
    expect(recordingsQuery({ type: 's.Audiogram' }, NOW).recordings).toHaveLength(1)
    expect((getHealthDb().prepare('SELECT COUNT(*) AS n FROM series_chunks').get() as { n: number }).n).toBe(2)
    const all = deleteHealthData({})
    expect(all.removed).toBe(2)
    expect(recordingsQuery({ type: 's.HeartbeatSeries' }, NOW).recordings).toEqual([])
  })

  it('the stale store id is refused before anything is stored', () => {
    const before = healthStatus(NOW).storeId
    deleteHealthData({})
    const out = ingestHealthSync(rawBatch('s.Audiogram', [audiogram()], { storeId: before }), { now: NOW })
    expect(out.status).toBe(409)
  })

  it('a route is matched to the workout it was recorded in', () => {
    sync(rawBatch('workout', [{ uuid: uuid('W'), start: START, end: END, value: 30, source: WATCH, meta: { activity: 'running' } }]))
    sync(rawBatch('s.WorkoutRoute', routeItems(uuid('R'), routePoints(5), 10)))
    const row = recordingsQuery({ type: 's.WorkoutRoute' }, NOW).recordings[0] as Record<string, any>
    expect(row.workout).toMatchObject({ activity: 'running', minutes: 30 })
  })
})

describe('status, reads and the relay guard', () => {
  it('status always lists the three recordings and supported.series', () => {
    let status = healthStatus(NOW)
    const rec = status.types.filter((t) => t.type.startsWith('s.'))
    expect(rec.map((t) => t.type)).toEqual(['s.Audiogram', 's.HeartbeatSeries', 's.WorkoutRoute'])
    expect(rec.every((t) => t.lastSampleAt === null && t.state === 'unknown_or_denied')).toBe(true)
    expect(status.supported.series.types).toEqual(['s.Audiogram', 's.HeartbeatSeries', 's.WorkoutRoute'])
    sync(rawBatch('s.Audiogram', [audiogram()]))
    status = healthStatus(NOW)
    expect(status.types.find((t) => t.type === 's.Audiogram')).toMatchObject({ category: 'audio', state: 'ok', lastSampleAt: '2026-10-18T14:05:00.000Z' })
    // Recordings are not days of data.
    expect(status.coverage.from).toBeNull()
  })

  it('health_samples points a recording at health_recordings; an unknown type or id is a clear error', async () => {
    await expect(samplesQuery({ type: 's.WorkoutRoute' })).rejects.toThrow(/health_recordings/)
    expect(() => recordingsQuery({ type: 's.Nope' }, NOW)).toThrow(/type must be one of/)
    expect(() => recordingsQuery({ type: 's.Audiogram', id: 'missing' }, NOW)).toThrow(/no s.Audiogram recording/)
  })

  it('a relay that predates recordings is declined and its status hides supported.series; a stamped one stores', async () => {
    const body = rawBatch('s.Audiogram', [audiogram()])
    const old = await runHealthAction('sync', { body, [RELAY_GENERIC_FLAG]: true })
    expect(old.body).toMatchObject({ accepted: 0, unsupported: true })
    const oldStatus = await runHealthAction('status', { body: undefined, [RELAY_GENERIC_FLAG]: true })
    expect(oldStatus.body.supported).not.toHaveProperty('series')
    expect(oldStatus.body.supported).toHaveProperty('generic')
    const fresh = await runHealthAction('sync', { body, [RELAY_GENERIC_FLAG]: true, [RELAY_SERIES_FLAG]: true })
    expect(fresh.body).toMatchObject({ accepted: 1, inserted: 1, completed: 1 })
    const direct = await runHealthAction('status', { body: undefined }, { direct: true })
    expect(direct.body.supported).toHaveProperty('series')
  })

  it('an unstamped relay still applies a recording deletion', async () => {
    const id = uuid('G')
    sync(rawBatch('s.Audiogram', [audiogram(id)]))
    const out = await runHealthAction('sync', { body: { tz: TZ, kind: 'raw', type: 's.Audiogram', samples: [], deleted: [id] }, [RELAY_GENERIC_FLAG]: true })
    expect(out.body).toMatchObject({ deleted: 1, unsupported: true })
  })

  it('a full-size route call fits the per-call byte cap', () => {
    const items = routeItems(uuid('R'), routePoints(4000), 1000)
    const bytes = Buffer.byteLength(JSON.stringify(rawBatch('s.WorkoutRoute', items.slice(0, 2))))
    expect(bytes).toBeLessThan(192 * 1024)
    expect(sync(rawBatch('s.WorkoutRoute', items.slice(0, 2)))).toMatchObject({ accepted: 2 })
  })
})
