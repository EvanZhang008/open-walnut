/**
 * /api/v1 search + notifications — CLOUD_MODE (REPLICA) behavior.
 * Global search is relayed to the primary (the search index never initializes
 * on the cloud box); when the primary cannot answer, the replica answers with a
 * keyword search of its own copies, marked offline. Notifications are B-class: the
 * durable store lives on the primary, so the replica relays through the
 * `session.control` command's `server.*` action family (bridge mocked at its
 * module seam). Notes search stays on the companion: its string leg searches its
 * copy of the Mac's notes (stage 4d; it keeps no notes index of its own), so with no
 * copy yet it needs the Mac.
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
      result: { results: [{ type: 'task', id: 't1', title: 'Garden research' }] },
    })
    const res = await request(createApp()).get('/api/v1/search?q=garden&types=task&limit=5')
    expect(res.status).toBe(200)
    expect(res.body.results).toHaveLength(1)
    expect(res.body.results[0].title).toBe('Garden research')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      expect.objectContaining({
        action: 'server.search', sessionId: '__server__',
        params: { q: 'garden', types: ['task'], limit: 5 },
      }),
      expect.any(Number),
    )
  })

  it('GET /search with the bridge down: a keyword search of this box\'s task copy, marked offline', async () => {
    const { addTask } = await import('../../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Rollback drill checklist', project: 'Acme', description: 'Smoke, tag, notes.' })
    await addTask({ title: 'Unrelated groceries', project: 'Home' })
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/search?q=rollback%20drill&types=task')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ offline: true, degraded: 'offline-keyword' })
    expect(res.body.results.map((r: { taskId?: string }) => r.taskId)).toEqual([task.id])
  })

  it('GET /search when the primary predates server.search: the same keyword search', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.search', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/search?q=anything')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ results: [], offline: true })
  })

  it('GET /search without q → 400 before any relay', async () => {
    const res = await request(createApp()).get('/api/v1/search?q=')
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('GET /notes/search with no copy of the notes yet needs the Mac (never the box\'s disk index)', async () => {
    const res = await request(createApp()).get('/api/v1/notes/search?q=zebra')
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: { code: 'needs_leader', why: 'kind_not_copied' } })
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('notifications B-relay on a REPLICA', () => {
  it('GET /notifications relays server.notifications', async () => {
    const result = { feed: [{ id: 'n1', kind: 'cron', severity: 'info', title: 'Hello', dedupKey: 'cron:n1', timestamp: 1_000, read: false }], unreadCount: 1 }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp()).get('/api/v1/notifications')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(result)
    expect(res.headers['x-walnut-copy-as-of']).toBeUndefined()
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.notifications', sessionId: '__server__' },
      8_000,
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

  // Stage 4d: the feed the box has (the Mac's copy, none here, and its own cards), marked offline, never a 503.
  it('bridge offline: the box\'s away feed, marked offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/notifications')
    expect([res.status, res.body.offline, res.body.feed]).toEqual([200, true, []])
  })

  it('old primary (Unknown control action): the box\'s away feed, marked offline', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.notifications', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/notifications')
    expect([res.status, res.body.offline]).toEqual([200, true])
  })
})
