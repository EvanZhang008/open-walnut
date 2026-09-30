/**
 * /api/v1/health/* on a cloud REPLICA: the relay contract.
 *
 * The replica keeps nothing. Every call is forwarded to the primary over the
 * `session.control` lane (bridge mocked at its module seam), the primary's answer
 * passes through verbatim (409 keeps its storeId), and every relay failure is 503
 * primary_unreachable so the phone keeps the batch queued. A call over the caps is
 * refused HERE with 413 without spending an RPC, and no health store ever appears
 * on the replica's disk.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const constants = vi.hoisted(() => ({ home: '' }))
vi.mock('../../../src/constants.js', async () => {
  const c = createMockConstants('walnut-health-v1-cloud', { CLOUD_MODE: true })
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

import { healthV1Router } from '../../../src/web/routes/health-v1.js'
import { healthRouter } from '../../../src/web/routes/health.js'
import { HEALTH_DEVICE_ONLY_MESSAGE } from '../../../src/web/middleware/health-access.js'
import { HEALTH_MAX_ITEMS_PER_SYNC, HEALTH_MAX_SYNC_BYTES } from '../../../src/core/health/catalog.js'
import { WATCH, bucketBatch, hrBuckets, rawBatch, sleepSample, uuid, watchNight } from '../../core/health/fixtures.js'

/**
 * Stands in for cloud auth (auth.ts cloudAuthMiddleware), which sets `deviceName`
 * for a paired device token and only `apiKeyName` for a legacy API key.
 */
function app(credential: 'device' | 'api_key' = 'device') {
  const server = express()
  server.use(express.json({ limit: '1mb' }))
  server.use((req, _res, next) => {
    const r = req as typeof req & { apiKeyName?: string; deviceName?: string }
    r.apiKeyName = credential === 'device' ? 'test-phone' : 'script'
    if (credential === 'device') r.deviceName = 'test-phone'
    next()
  })
  server.use('/api/v1', healthV1Router)
  server.use('/api/health', healthRouter)
  return server
}

const primaryAnswer = (status: number, body: Record<string, unknown>) => ({ ok: true, result: { status, body } })
const noStoreOnDisk = () => expect(fs.existsSync(path.join(constants.home, 'health'))).toBe(false)

beforeEach(() => { bridgeRequestMock.mockReset() })

describe('/api/v1/health on a REPLICA', () => {
  it('relays a sync to the primary and answers its 200 once the primary committed', async () => {
    bridgeRequestMock.mockResolvedValue(primaryAnswer(200, { accepted: 5, deleted: 0, storeId: 'hs-one', paused: false }))
    const res = await request(app()).post('/api/v1/health/sync').send(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: 5, deleted: 0, storeId: 'hs-one', paused: false })
    const [alias, command, payload, timeout] = bridgeRequestMock.mock.calls[0]!
    expect(alias).toBe('__local__')
    expect(command).toBe('session.control')
    expect(payload).toMatchObject({ action: 'server.health.sync', sessionId: '__server__' })
    expect((payload as any).params.body.samples).toHaveLength(5)
    expect(timeout).toBeLessThanOrEqual(30_000)
    noStoreOnDisk()
  })

  it('answers 503 primary_unreachable when the bridge is down, and writes nothing locally', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const calls = [
      () => request(app()).post('/api/v1/health/sync').send(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'))),
      () => request(app()).get('/api/v1/health/status'),
      () => request(app()).put('/api/v1/health/settings').send({ paused: true }),
      () => request(app()).delete('/api/v1/health/data').send({}),
    ]
    for (const call of calls) {
      const res = await call()
      expect(res.status).toBe(503)
      expect(res.body).toEqual({ error: { code: 'primary_unreachable', message: expect.any(String) } })
    }
    expect(bridgeRequestMock).toHaveBeenCalledTimes(4)
    noStoreOnDisk()
  })

  it('answers 503 for a primary that predates the action (retry, never drop)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.health.sync', errorKind: 'bad_request' })
    const res = await request(app()).post('/api/v1/health/sync').send(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21')))
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('primary_unreachable')
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { banked: 1 } })
    expect((await request(app()).get('/api/v1/health/status')).status).toBe(503)
  })

  it('passes a 409 store_mismatch through with the new storeId', async () => {
    bridgeRequestMock.mockResolvedValue(primaryAnswer(409, { error: { code: 'store_mismatch', message: 'x' }, storeId: 'hs-two' }))
    const res = await request(app()).post('/api/v1/health/sync').send(rawBatch('sleep', [], { storeId: 'hs-one' }))
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: { code: 'store_mismatch' }, storeId: 'hs-two' })
  })

  it('refuses an oversize call locally with 413, spending no RPC', async () => {
    const many = { kind: 'raw', type: 'sleep', samples: [], deleted: Array.from({ length: HEALTH_MAX_ITEMS_PER_SYNC + 1 }, () => uuid()) }
    const res = await request(app()).post('/api/v1/health/sync').send(many)
    expect(res.status).toBe(413)
    expect(res.body).toMatchObject({ error: { code: 'too_large' }, maxItems: 500, maxBytes: HEALTH_MAX_SYNC_BYTES })
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('narrows the batch: junk is counted, unknown fields dropped, the frame stays under 256 KB', async () => {
    bridgeRequestMock.mockResolvedValue(primaryAnswer(200, { accepted: 1, deleted: 0, storeId: 'hs-one', paused: false }))
    const good = sleepSample('2026-09-21T01:00:00-04:00', '2026-09-21T02:00:00-04:00', 3)
    await request(app()).post('/api/v1/health/sync').send(rawBatch('sleep', [
      { ...good, junk: 'y'.repeat(4096), source: { ...WATCH, extra: 'z'.repeat(1000) } },
      { ...good, uuid: uuid(), code: 42 },
      'nope',
    ], { stray: 'q'.repeat(2000) })).expect(200)
    const payload = bridgeRequestMock.mock.calls[0]![2] as any
    expect(payload.params.rejected).toBe(2)
    expect(payload.params.body.samples).toHaveLength(1)
    expect(payload.params.body.samples[0]).not.toHaveProperty('junk')
    expect(payload.params.body.samples[0].source).toEqual(WATCH)
    expect(payload.params.body).not.toHaveProperty('stray')

    bridgeRequestMock.mockClear()
    const buckets = hrBuckets(Date.now() - 600 * 300_000, HEALTH_MAX_ITEMS_PER_SYNC)
    await request(app()).post('/api/v1/health/sync').send(bucketBatch('heart_rate', buckets)).expect(200)
    const frame = JSON.stringify(bridgeRequestMock.mock.calls[0]![2])
    expect(Buffer.byteLength(frame)).toBeLessThan(256 * 1024)
  })

  it('forwards settings and delete bodies and passes the primary answer through', async () => {
    bridgeRequestMock.mockResolvedValue(primaryAnswer(200, { storeId: 'hs-three', paused: true, deleted: 'all' }))
    const res = await request(app()).delete('/api/v1/health/data').send({ categories: ['sleep'] })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ storeId: 'hs-three', paused: true })
    expect((bridgeRequestMock.mock.calls[0]![2] as any)).toMatchObject({ action: 'server.health.delete', params: { body: { categories: ['sleep'] } } })
  })

  it('the internal /api/health reads are primary only (501 here)', async () => {
    for (const p of ['/api/health/status', '/api/health/sleep', '/api/health/daily', '/api/health/series?metric=steps']) {
      const res = await request(app()).get(p)
      expect(res.status, p).toBe(501)
    }
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    noStoreOnDisk()
  })

  it('takes a paired device token only: an API key is refused on every route, and nothing is relayed', async () => {
    bridgeRequestMock.mockResolvedValue(primaryAnswer(200, { storeId: 'hs-four', paused: false }))
    const calls = [
      () => request(app('api_key')).post('/api/v1/health/sync').send(rawBatch('sleep', watchNight('2026-09-20', '2026-09-21'))),
      () => request(app('api_key')).get('/api/v1/health/status'),
      () => request(app('api_key')).put('/api/v1/health/settings').send({ paused: true }),
      () => request(app('api_key')).delete('/api/v1/health/data').send({}),
    ]
    for (const call of calls) {
      const res = await call()
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: { code: 'forbidden', message: HEALTH_DEVICE_ONLY_MESSAGE } })
    }
    expect(bridgeRequestMock).not.toHaveBeenCalled()
    // The same call with the phone's device token goes through.
    expect((await request(app('device')).get('/api/v1/health/status')).status).toBe(200)
  })
})
