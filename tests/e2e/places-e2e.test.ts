/**
 * Places end to end through a REAL server (startServer({ port: 0, dev: true })):
 * the phone's contract on /api/v1/places/*, both places ops through the real
 * registry (executeOp: zod args, HTTP binding, the internal /api/places reads),
 * the replica's relay entry point (handleSessionControlRelay) answering on this
 * primary, a paired phone's device token accepted, and a
 * REMOTE host's gateway refused for every places path and op while a session on
 * this Mac keeps working. Invented places only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-places-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/index.js'
import { handleSessionControlRelay } from '../../src/core/sessions/session-controls.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { LOCAL_ORIGIN, PLACES_LOCAL_ONLY_MESSAGE } from '../../src/lib/caller-origin.js'
import { createDevice } from '../../src/core/device-auth.js'

const TZ = 'Europe/Lisbon'
let server: HttpServer
let port = 0
const previousDisableSearch = process.env.WALNUT_DISABLE_SEARCH
const url = (p: string): string => `http://127.0.0.1:${port}${p}`
const apiBase = (): string => `http://127.0.0.1:${port}`
const json = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(url(p), { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}
const local = () => ({ apiBase: apiBase(), origin: LOCAL_ORIGIN })
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString()
const PARK = { lat: 38.7139, lon: -9.1394 }

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

describe('Places through a real server', () => {
  it('before the user turns Places on, both ops say it is off and no store appears', async () => {
    for (const [name, args] of [['places_status', {}], ['places_visits', { last_days: 3 }]] as const) {
      const r = await executeOp(name, args, local())
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect((r as any).result).toMatchObject({ recording: false, visitCount: 0 })
      expect((r as any).result.message).toMatch(/only after they turn Places on, and only from then on/)
    }
    expect((await json('GET', '/api/v1/places/status')).body).toMatchObject({ recording: false })
    expect(fs.existsSync(path.join(WALNUT_HOME, 'places'))).toBe(false)
  })

  it('a paired phone turns Places on and sends a visit twice; the agent reads one visit', async () => {
    const { token } = await createDevice('places-phone')
    const phone = { Authorization: `Bearer ${token}` }
    const on = await json('POST', '/api/v1/places/sync', { tz: TZ, state: { enabled: true, access: 'always' }, visits: [] }, phone)
    expect(on).toMatchObject({ status: 200, body: { accepted: 0 } })
    const arrival = hoursAgo(5)
    expect((await json('POST', '/api/v1/places/sync', { tz: TZ, visits: [{ id: 'v-park', arrival, ...PARK, accuracyM: 40 }] }, phone)).body)
      .toMatchObject({ accepted: 1, inserted: 1 })
    expect((await json('POST', '/api/v1/places/sync', {
      tz: TZ, visits: [{ id: 'v-park', arrival, departure: hoursAgo(3), ...PARK, name: 'Jardim Botanico', address: 'Lisbon' }],
    }, phone)).body).toMatchObject({ accepted: 1, inserted: 0, updated: 1 })

    const read = await executeOp('places_visits', { last_days: 2 }, local())
    expect(read.ok, JSON.stringify(read)).toBe(true)
    const result = (read as any).result
    expect(result.visits).toEqual([expect.objectContaining({ id: 'v-park', status: 'ended', durationMin: 120, name: 'Jardim Botanico' })])
    expect(result.places).toEqual([expect.objectContaining({ name: 'Jardim Botanico', visits: 1, totalMin: 120 })])
    expect(result.recording).toBe(true)
    expect(result.message).toBeUndefined()
    const st = await executeOp('places_status', {}, local())
    expect((st as any).result).toMatchObject({ recording: true, visitCount: 1, phone: { enabled: true, access: 'always' } })

    const filtered = await executeOp('places_visits', { last_days: 2, place: 'nowhere' }, local())
    expect((filtered as any).result.visits).toEqual([])
    const bad = await executeOp('places_visits', { last_days: 500 }, local())
    expect(bad.ok).toBe(false)
    const badRange = await json('GET', '/api/places/visits?from=2026-01-01&to=2026-09-01')
    expect(badRange.status).toBe(400)
  })

  it('the replica relay lands on the same functions', async () => {
    const status = await handleSessionControlRelay('server.places.status', '__server__', {})
    expect(status.ok).toBe(true)
    if (!status.ok) return
    expect(status.result).toMatchObject({ status: 200, body: { visitCount: 1, recording: true } })
    const synced = await handleSessionControlRelay('server.places.sync', '__server__', {
      body: { tz: TZ, visits: [{ id: 'v-cafe', arrival: hoursAgo(2), ...PARK }] },
    })
    expect(synced.ok && synced.result).toMatchObject({ status: 200, body: { inserted: 1 } })
    const bad = await handleSessionControlRelay('server.places.nope', '__server__', {})
    expect(bad.ok).toBe(false)
  })

  it('a remote host cannot read or delete places, through an op or the api passthrough', async () => {
    const gateway = (host: string, name: string, args: Record<string, unknown>) =>
      handleGatewayCapability('tools.call', 'sid-places-caller', { name, args }, host, { throttle: new PeerThrottle(), cloudMode: false })
    for (const [method, p] of [
      ['GET', '/api/places/status'],
      ['GET', '/api/places/visits?last_days=7'],
      ['GET', '/api/v1/places/status'],
      ['DELETE', '/api/v1/places/data'],
      ['DELETE', '/api/v1/../v1/places/data'],
      ['GET', '/API/Places/Visits'],
    ] as const) {
      const r = await gateway('remote-dev', 'api', { method, path: p })
      expect(r.ok, `${method} ${p}: ${JSON.stringify(r)}`).toBe(false)
      // A differently cased prefix never even reaches the server: the passthrough refuses it first.
      expect(JSON.stringify(r)).toMatch(/Places data is only available to sessions on this Mac|only accepts paths starting with \/api\//)
    }
    for (const name of ['places_status', 'places_visits']) {
      const r = await gateway('remote-dev', name, {})
      expect(r).toMatchObject({ ok: false, error: { message: `${name} refused: ${PLACES_LOCAL_ONLY_MESSAGE}` } })
    }
    expect((await json('GET', '/api/v1/places/status')).body.visitCount).toBe(2)
    const mine = await gateway('__local__', 'places_visits', { last_days: 1 })
    expect(mine.ok, JSON.stringify(mine)).toBe(true)
  })

  it('delete removes every visit and the files, and the ops say Places is off again', async () => {
    const del = await json('DELETE', '/api/v1/places/data')
    expect(del).toMatchObject({ status: 200, body: { removed: 2 } })
    expect(fs.existsSync(path.join(WALNUT_HOME, 'places', 'places.sqlite'))).toBe(false)
    const st = await executeOp('places_status', {}, local())
    expect((st as any).result).toMatchObject({ recording: false, visitCount: 0 })
    // The phone's Turn Off after a delete leaves nothing behind either.
    expect((await json('POST', '/api/v1/places/sync', { tz: TZ, state: { enabled: false, access: 'always' }, visits: [] })).status).toBe(200)
    expect(fs.existsSync(path.join(WALNUT_HOME, 'places', 'places.sqlite'))).toBe(false)
  })
})
