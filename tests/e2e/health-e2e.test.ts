/**
 * Apple Health end to end through a REAL server (startServer({ port: 0, dev: true })):
 * the phone's upload contract on /api/v1/health/*, then every health op through the
 * real registry (executeOp: zod args, HTTP binding, the internal /api/health reads),
 * day_review over the live endpoints, a paired phone's generic types (q. raw and
 * buckets, a unit mismatch) read back through health_status, health_samples and
 * health_series, the replica's relay entry point
 * (handleSessionControlRelay) answering on this primary, and the gate's bypass:
 * a REMOTE host's gateway `api` call for health reads, settings, the store delete
 * and a task delete, all refused, with the data proven still there, while a
 * session on this Mac (`__local__`) keeps working. Invented data only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { HEALTH_LOCAL_ONLY_MESSAGE, LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { addDays, localDate, zonedTime } from '../../src/core/health/day-key.js'
import { MARKER_HR, WATCH, uuid } from '../core/health/fixtures.js'
import { createDevice } from '../../src/core/device-auth.js'
import { notSyncingMessage } from '../../src/web/routes/health.js'

const TZ = 'America/New_York'
let server: HttpServer
let port = 0
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH
const url = (p: string): string => `http://127.0.0.1:${port}${p}`
const apiBase = (): string => `http://127.0.0.1:${port}`
const json = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(url(p), { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

const TODAY = localDate(Date.now(), TZ)
const D1 = addDays(TODAY, -1)
const iso = (date: string, h: number, m = 0): string => new Date(zonedTime(date, h, m, TZ)).toISOString()

/** A stage-capable night for wake date `date`: 23:00 the evening before to 07:00. */
function night(date: string) {
  const prev = addDays(date, -1)
  const s = (start: string, end: string, code: number) => ({ uuid: uuid('E'), start, end, code, source: WATCH, device: 'Watch' })
  return [
    s(iso(prev, 23), iso(date, 1), 3),
    s(iso(date, 1), iso(date, 2), 4),
    s(iso(date, 2), iso(date, 2, 10), 2),
    s(iso(date, 2, 10), iso(date, 3), 5),
    s(iso(date, 3), iso(date, 7), 3),
  ]
}
const device = { installId: 'install-e2e', model: 'iPhone', os: 'iOS 26' }
const sleepBatch = { device, tz: TZ, kind: 'raw', type: 'sleep', samples: [...night(addDays(TODAY, -3)), ...night(addDays(TODAY, -2)), ...night(D1)], deleted: [] }
const hrBatch = {
  device, tz: TZ, kind: 'buckets', metric: 'heart_rate',
  buckets: Array.from({ length: 24 * 12 }, (_, i) => ({ start: new Date(zonedTime(D1, 0, 0, TZ) + i * 300_000).toISOString(), intervalSec: 300, avg: MARKER_HR, min: 50, max: 70, count: 12 })),
}
const stepsBatch = {
  device, tz: TZ, kind: 'buckets', metric: 'steps',
  buckets: Array.from({ length: 24 }, (_, i) => ({ start: new Date(zonedTime(D1, 0, 0, TZ) + i * 3_600_000).toISOString(), intervalSec: 3600, sum: 400 })),
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  if (previousDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = previousDisableSearch
})

describe('Apple Health through a real server', () => {
  it('reads before any upload answer not connected and leave no store behind', async () => {
    const r = await executeOp('health_sleep', { last_nights: 3 }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(r.ok).toBe(true)
    expect((r as any).result).toMatchObject({ connected: false })
    // The agent is told the phone asks by itself, never to send the user through Settings.
    expect((r as any).result.message).toMatch(/asks for access by itself/)
    expect((r as any).result.message).not.toMatch(/Settings, Apple Health/)
    expect(fs.existsSync(path.join(WALNUT_HOME, 'health'))).toBe(false)
  })

  it('a store the phone never synced into says the same thing on health_status', async () => {
    expect((await json('GET', '/api/v1/health/status')).status).toBe(200)
    const st = await executeOp('health_status', {}, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect((st as any).result).toMatchObject({ connected: false, lastUploadAt: null })
    expect((st as any).result.message).toMatch(/asks for access by itself/)
    expect(notSyncingMessage('2026-09-17T12:00:00.000Z')).toMatch(/^Nothing has synced from the iPhone since 2026-09-17\./)
  })

  it('accepts the phone batches, and a re-post stores nothing twice', async () => {
    const first = await json('POST', '/api/v1/health/sync', sleepBatch)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ accepted: 15, inserted: 15, deleted: 0, paused: false })
    expect(first.body.storeId).toMatch(/^hs-/)
    expect((await json('POST', '/api/v1/health/sync', sleepBatch)).body).toMatchObject({ accepted: 15, inserted: 0 })
    expect((await json('POST', '/api/v1/health/sync', hrBatch)).status).toBe(200)
    expect((await json('POST', '/api/v1/health/sync', stepsBatch)).status).toBe(200)
    const status = await json('GET', '/api/v1/health/status')
    expect(status.status).toBe(200)
    expect(status.body).toMatchObject({ storeId: first.body.storeId, paused: false })
  })

  it('serves every health op through the real registry', async () => {
    const st = await executeOp('health_status', {}, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(st.ok, JSON.stringify(st)).toBe(true)

    const sleep = await executeOp('health_sleep', { last_nights: 3 }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(sleep.ok, JSON.stringify(sleep)).toBe(true)
    const nights = (sleep as any).result.nights as Array<Record<string, any>>
    const last = nights.find((n) => n.date === D1)!
    expect(last).toMatchObject({ status: 'ok', asleepMin: 470, awakeMin: 10 })
    expect(last.stages).toMatchObject({ deepMin: 60, remMin: 50 })
    expect(last.sleepingHr).toBe(57.1)

    const daily = await executeOp('health_daily', { from: D1, to: D1 }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(daily.ok, JSON.stringify(daily)).toBe(true)
    const day = (daily as any).result.days[0]
    expect(day.activity.steps).toBe(9600)
    expect(day.vitals.heartRate).toMatchObject({ avg: 57.1, min: 50, max: 70 })

    const series = await executeOp('health_series', { metric: 'heart_rate', from: D1, to: D1, bucket: '1h' }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(series.ok, JSON.stringify(series)).toBe(true)
    expect((series as any).result.points).toHaveLength(24)

    const bad = await executeOp('health_sleep', { last_nights: 500 }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(bad.ok).toBe(false)
  })

  it('a paired phone syncs generic types, and the agent finds them in status and reads them', async () => {
    const { token } = await createDevice('e2e-phone')
    const phone = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(url(p), {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }
    const before = await phone('GET', '/api/v1/health/status')
    expect(before.status).toBe(200)
    expect(before.body.supported.generic).toMatchObject({ prefixes: ['q', 'c', 'x'], maxTypeLength: 64 })

    const mass = (h: number, value: number) => ({ uuid: uuid('M'), start: iso(D1, h), end: iso(D1, h), value, source: WATCH, device: 'Scale' })
    const raw = { device, tz: TZ, kind: 'raw', type: 'q.BodyMass', unit: 'kg', samples: [mass(8, 72.4), mass(20, 72)], deleted: [] }
    expect((await phone('POST', '/api/v1/health/sync', raw)).body).toMatchObject({ accepted: 2, inserted: 2, paused: false })
    const flights = {
      device, tz: TZ, kind: 'buckets', metric: 'q.FlightsClimbed', unit: 'count', agg: 'sum',
      buckets: Array.from({ length: 24 }, (_, i) => ({ start: new Date(zonedTime(D1, 0, 0, TZ) + i * 3_600_000).toISOString(), intervalSec: 3600, sum: 2 })),
    }
    expect((await phone('POST', '/api/v1/health/sync', flights)).body).toMatchObject({ accepted: 24 })
    // Another unit for the same type: nothing stored, the phone keeps its anchor.
    const pounds = await phone('POST', '/api/v1/health/sync', { ...raw, unit: 'lb', samples: [mass(21, 158)] })
    expect(pounds.status).toBe(200)
    expect(pounds.body).toMatchObject({ accepted: 0, unitMismatch: { type: 'q.BodyMass', field: 'unit', stored: 'kg', sent: 'lb' } })

    const status = await phone('GET', '/api/v1/health/status')
    expect(status.body.types).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'q.BodyMass', category: 'other', unit: 'kg', state: 'ok', kind: 'raw', lastSampleAt: iso(D1, 20) }),
      expect.objectContaining({ type: 'q.FlightsClimbed', category: 'other', unit: 'count', state: 'ok', kind: 'buckets', agg: 'sum' }),
    ]))

    const local = { apiBase: apiBase(), origin: LOCAL_ORIGIN }
    const st = await executeOp('health_status', {}, local)
    expect(st.ok, JSON.stringify(st)).toBe(true)
    expect((st as any).result.types.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['q.BodyMass', 'q.FlightsClimbed']))
    const samples = await executeOp('health_samples', { type: 'q.BodyMass', limit: 10 }, local)
    expect(samples.ok, JSON.stringify(samples)).toBe(true)
    expect((samples as any).result).toMatchObject({ type: 'q.BodyMass', unit: 'kg', truncated: false })
    expect((samples as any).result.rows.map((r: { value: number; device: string }) => [r.value, r.device])).toEqual([[72, 'Scale'], [72.4, 'Scale']])
    const climbed = await executeOp('health_series', { metric: 'q.FlightsClimbed', from: D1, to: D1, bucket: '1d' }, local)
    expect(climbed.ok, JSON.stringify(climbed)).toBe(true)
    expect((climbed as any).result).toMatchObject({ unit: 'count', agg: 'sum', points: [{ t: D1, sum: 48 }] })
    const weight = await executeOp('health_series', { metric: 'q.BodyMass', from: D1, to: D1, bucket: '1d' }, local)
    expect((weight as any).result.points).toEqual([{ t: D1, avg: 72.2, min: 72, max: 72.4, sum: 144.4, count: 2 }])
    // A malformed name is the route's 400, not a crash.
    const bad = await executeOp('health_samples', { type: 'q.no such' }, local)
    expect(bad.ok).toBe(false)
  })

  it('day_review reads the live endpoints and lists what is missing', async () => {
    // Every section but calendar: its first read on a fresh home compiles and signs
    // the native EventKit helper, which a test must not do (the unit test covers it).
    const sections = 'tasks,time,apps,screentime,focus,sleep,activity'
    const r = await executeOp('day_review', { date: D1, sections }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const out = (r as any).result
    expect(out.date).toBe(D1)
    expect(out.sections.sleep).toMatchObject({ asleepMin: 470 })
    expect(out.sections.sleep).not.toHaveProperty('hypnogram')
    expect(out.sections.activity.activity.steps).toBe(9600)
    expect(out.sections.tasks).toMatchObject({ completed: 0 })
    // No Rhythm plugin on a fresh test home: reported, not invented.
    const missing = out.unavailable.map((u: { section: string }) => u.section)
    expect(missing).toEqual(expect.arrayContaining(['focus']))
    expect(out.sections).not.toHaveProperty('calendar')
    for (const u of out.unavailable) expect(typeof u.reason).toBe('string')
  })

  it('answers the replica relay actions on this primary', async () => {
    const r = await handleSessionControlRelay('server.health.status', '__server__', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ status: 200, body: { paused: false } })
    const bad = await handleSessionControlRelay('server.health.nope', '__server__', {})
    expect(bad.ok).toBe(false)
  })

  it('a remote host cannot read, change or delete health, or delete a task, through the gateway api op', async () => {
    // A fresh throttle per call: the gateway's write budget would otherwise answer
    // `throttled` part way through, and a throttled call proves nothing either way.
    const gateway = (host: string, name: string, args: Record<string, unknown>) =>
      handleGatewayCapability('tools.call', 'sid-e2e-caller', { name, args }, host, { throttle: new PeerThrottle(), cloudMode: false })
    const created = await json('POST', '/api/tasks', { title: 'origin probe task' })
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
    const taskId = String(created.body.task?.id ?? created.body.id)
    const storeBefore = (await json('GET', '/api/v1/health/status')).body.storeId

    const attempts: Array<[string, string, Record<string, unknown>?]> = [
      ['GET', '/api/health/status'],
      ['GET', `/api/health/sleep?from=${D1}&to=${D1}`],
      ['GET', '/api/health/samples?type=q.BodyMass'],
      ['GET', '/api/v1/health/status'],
      ['PUT', '/api/v1/health/settings', { paused: true }],
      ['DELETE', '/api/v1/health/data', {}],
      ['DELETE', '/api/v1/../v1/health/data', {}],
      ['DELETE', `/api/tasks/${taskId}`],
      ['DELETE', `/api/v1/tasks/${taskId}`],
      ['POST', '/api/v1/actions/invoke', { tool: 'task_delete', args: { id: taskId }, confirmed: true }],
      ['POST', '/api/v1/actions/invoke', { tool: 'health_sleep', args: { last_nights: 3 } }],
    ]
    for (const [method, path, body] of attempts) {
      const r = await gateway('remote-dev', 'api', { method, path, ...(body ? { body } : {}) })
      expect(r.ok, `${method} ${path}: ${JSON.stringify(r)}`).toBe(false)
      expect(JSON.stringify(r), `${method} ${path}`).toMatch(/Health data is only available to sessions on this Mac|runs only for callers on this Mac|runs only from the console on this Mac/)
    }
    for (const [name, args] of [['health_status', {}], ['health_sleep', {}], ['health_samples', { type: 'q.BodyMass' }], ['day_review', {}]] as const) {
      const r = await gateway('remote-dev', name, args)
      expect(r).toMatchObject({ ok: false, error: { message: `${name} refused: ${HEALTH_LOCAL_ONLY_MESSAGE}` } })
    }

    // Nothing moved: the store, its settings and the task are all still there.
    const status = await json('GET', '/api/v1/health/status')
    expect(status.body).toMatchObject({ storeId: storeBefore, paused: false, connected: true })
    expect((await json('GET', `/api/tasks/${taskId}`)).status).toBe(200)

    // A session on this Mac still reads health through the same gateway.
    const local = await gateway('__local__', 'health_sleep', { last_nights: 3 })
    expect(local.ok, JSON.stringify(local)).toBe(true)
    const localApi = await gateway('__local__', 'api', { method: 'GET', path: '/api/health/status' })
    expect(localApi.ok, JSON.stringify(localApi)).toBe(true)
  })

  it('pause, delete, rotated store id, and the stale phone gets 409', async () => {
    const before = (await json('GET', '/api/v1/health/status')).body.storeId
    const paused = await json('PUT', '/api/v1/health/settings', { paused: true })
    expect(paused.status).toBe(200)
    expect((await json('POST', '/api/v1/health/sync', { ...sleepBatch, samples: night(TODAY) })).body).toMatchObject({ paused: true, accepted: 0 })
    const bad = await json('PUT', '/api/v1/health/settings', { sleepSourceOrder: 'not-a-list' })
    expect(bad.status).toBe(400)

    const del = await json('DELETE', '/api/v1/health/data', {})
    expect(del.status).toBe(200)
    expect(del.body.storeId).not.toBe(before)
    expect(del.body.paused).toBe(true)
    const stale = await json('POST', '/api/v1/health/sync', { ...sleepBatch, storeId: before })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'store_mismatch' }, storeId: del.body.storeId })
    const sleep = await executeOp('health_sleep', { last_nights: 3 }, { apiBase: apiBase(), origin: LOCAL_ORIGIN })
    expect(((sleep as any).result.nights as Array<{ status: string }>).every((n) => n.status !== 'ok')).toBe(true)
  })
})
