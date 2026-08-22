/**
 * /api/v1 search + notifications — CLOUD_MODE (REPLICA) behavior.
 * Global search is C-class (the QMD store never initializes on the cloud
 * box) → explicit 501 not_supported_cloud. Notifications are B-class: the
 * durable store lives on the primary, so the replica relays through the
 * `session.control` command's `server.*` action family (bridge mocked at its
 * module seam). Notes search stays local (its semantic leg self-gates on
 * CLOUD_MODE inside performNotesSearch — string leg answers).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-searchmem-cloud', { CLOUD_MODE: true }))

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

import express from 'express'
import request from 'supertest'
import { searchMemoryV1Router } from '../../../src/web/routes/search-memory-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', searchMemoryV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})

afterEach(async () => {
  const { resetIndexBootstrap } = await import('../../../src/web/routes/notes-v2.js')
  resetIndexBootstrap()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('global search B-relay on a REPLICA', () => {
  it('GET /search relays server.search to the primary and returns its results', async () => {
    bridgeRequestMock.mockResolvedValue({
      ok: true,
      result: { results: [{ type: 'task', id: 't1', title: 'NVDA research' }] },
    })
    const res = await request(createApp()).get('/api/v1/search?q=NVDA&types=task&limit=5')
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0].title).toBe('NVDA research')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      expect.objectContaining({
        action: 'server.search', sessionId: '__server__',
        params: { q: 'NVDA', types: ['task'], limit: 5 },
      }),
      expect.any(Number),
    )
  })

  it('GET /search → 501 not_supported_cloud when the bridge is down (honest degraded state)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/search?q=anything')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })

  it('GET /search → 501 not_supported_cloud when the primary predates server.search', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.search', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/search?q=anything')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })

  it('GET /search without q → 400 before any relay', async () => {
    const res = await request(createApp()).get('/api/v1/search?q=')
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('GET /notes/search still answers locally (string leg; semantic self-gated)', async () => {
    const res = await request(createApp()).get('/api/v1/notes/search?q=zebra')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.results)).toBe(true)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('notifications B-relay on a REPLICA', () => {
  it('GET /notifications relays server.notifications', async () => {
    const result = { feed: [{ id: 'n1', title: 'Hello' }], unreadCount: 1 }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp()).get('/api/v1/notifications')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(result)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.notifications', sessionId: '__server__' },
      30_000,
    )
  })

  it('POST /notifications/mark-read relays ids', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { unreadCount: 0 } })
    const res = await request(createApp()).post('/api/v1/notifications/mark-read').send({ ids: ['n1'] })
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.notifications.mark-read', sessionId: '__server__', params: { ids: ['n1'] } },
      30_000,
    )
  })

  it('POST /notifications/dismiss relays ids + dedupKeys', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { unreadCount: 0, removed: 2 } })
    const res = await request(createApp())
      .post('/api/v1/notifications/dismiss')
      .send({ ids: ['n1'], dedupKeys: ['perm:x'] })
    expect(res.status).toBe(200)
    expect(res.body.removed).toBe(2)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.notifications.dismiss', sessionId: '__server__', params: { ids: ['n1'], dedupKeys: ['perm:x'] } },
      30_000,
    )
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/notifications')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('old primary (Unknown control action) → 400 session_control_needs_upgrade', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.notifications', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/notifications')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })
})
