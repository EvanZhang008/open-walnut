/**
 * /api/v1/places/* on a cloud REPLICA: the relay contract.
 *
 * The replica keeps nothing. Every call is forwarded to the primary over the
 * `session.control` lane (bridge mocked at its module seam), the primary's answer
 * passes through verbatim, and every relay failure is 503 primary_unreachable so
 * the phone keeps its visits queued. A call over the caps is refused HERE with 413,
 * an API key is refused outright, the internal reads answer 501, and no places
 * store ever appears on the replica's disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constants = vi.hoisted(() => ({ home: '' }))
vi.mock('../../../src/constants.js', async () => {
  const c = createMockConstants('walnut-places-v1-cloud', { CLOUD_MODE: true })
  constants.home = c.WALNUT_HOME as string
  return c
})

const bridgeRequestMock = vi.fn()
class BridgeOfflineError extends Error {
  constructor(hostAlias: string) { super(`No live bridge for host: ${hostAlias}`) }
}
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridgeRequestMock,
  BridgeOfflineError,
  bridgeForHost: () => ({ connected: true }),
  bridgeHosts: () => [],
  bridgeAttachSession: async () => {},
  bridgeDetachSession: () => {},
  attachBridge: () => {},
  closeAllBridges: () => {},
  setMobileEventHandler: () => {},
}))

import { placesV1Router, PLACES_DEVICE_ONLY_MESSAGE } from '../../../src/web/routes/places-v1.js'
import { placesRouter } from '../../../src/web/routes/places.js'
import { PLACES_MAX_VISITS_PER_SYNC } from '../../../src/core/places/ingest.js'

/** Stands in for cloud auth: `deviceName` only for a paired device token. */
function app(credential: 'device' | 'api_key' = 'device') {
  const server = express()
  server.use(express.json({ limit: '1mb' }))
  server.use((req, _res, next) => {
    const r = req as typeof req & { apiKeyName?: string; deviceName?: string }
    r.apiKeyName = credential === 'device' ? 'test-phone' : 'script'
    if (credential === 'device') r.deviceName = 'test-phone'
    next()
  })
  server.use('/api/v1', placesV1Router)
  server.use('/api/places', placesRouter)
  return server
}

const visit = { id: 'v-1', arrival: '2026-10-03T09:00:00+01:00', lat: 38.7, lon: -9.1 }
const noStoreOnDisk = () => expect(fs.existsSync(path.join(constants.home, 'places'))).toBe(false)

beforeEach(() => { bridgeRequestMock.mockReset() })

describe('/api/v1/places on a REPLICA', () => {
  it('relays a sync to the primary and passes its answer through', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { status: 200, body: { accepted: 1, inserted: 1, updated: 0, rejected: 0 } } })
    const res = await request(app()).post('/api/v1/places/sync').send({ tz: 'Europe/Lisbon', visits: [visit] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: 1, inserted: 1, updated: 0, rejected: 0 })
    const [alias, command, payload] = bridgeRequestMock.mock.calls[0]!
    expect(alias).toBe('__local__')
    expect(command).toBe('session.control')
    expect(payload).toMatchObject({ action: 'server.places.sync', sessionId: '__server__', params: { body: { visits: [visit] } } })
    noStoreOnDisk()
  })

  it('answers 503 when the bridge is down or the primary predates the action, and writes nothing', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    for (const call of [
      () => request(app()).post('/api/v1/places/sync').send({ visits: [visit] }),
      () => request(app()).get('/api/v1/places/status'),
      () => request(app()).delete('/api/v1/places/data'),
    ]) {
      const res = await call()
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('primary_unreachable')
    }
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.places.sync', errorKind: 'bad_request' })
    expect((await request(app()).post('/api/v1/places/sync').send({ visits: [visit] })).status).toBe(503)
    noStoreOnDisk()
  })

  it('refuses an oversize call locally with 413, spending no RPC', async () => {
    const many = Array.from({ length: PLACES_MAX_VISITS_PER_SYNC + 1 }, (_, i) => ({ ...visit, id: `v-${i}` }))
    const res = await request(app()).post('/api/v1/places/sync').send({ visits: many })
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: { code: 'too_large' }, maxItems: PLACES_MAX_VISITS_PER_SYNC })
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('an API key is refused, and the internal reads are not served here', async () => {
    const res = await request(app('api_key')).get('/api/v1/places/status')
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: { code: 'forbidden', message: PLACES_DEVICE_ONLY_MESSAGE } })
    expect((await request(app()).get('/api/places/visits')).status).toBe(501)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    noStoreOnDisk()
  })
})
