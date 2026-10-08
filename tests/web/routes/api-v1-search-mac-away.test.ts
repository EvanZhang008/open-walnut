/**
 * The phone's global search on the cloud companion while the Mac is away
 * (search-memory-v1.ts): the real route, the real task store of this box, the
 * real forward's view of the Mac; the bridge and the backup leader are
 * stand-ins.
 *
 *   - the Mac away (silent): a keyword search of this box's copy at once, the
 *     Mac not asked;
 *   - the Mac answering: asked as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-search-away', { CLOUD_MODE: true }))

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

const leader = vi.hoisted(() => ({ lastSeenAt: 0 }))
vi.mock('../../../src/core/leader/backup-leader.js', () => ({
  getBackupLeader: async () => ({
    status: () => ({
      leading: [], primaryLastSeenAt: leader.lastSeenAt, primaryHeard: true, backupAllowed: true,
      restartingUntil: null, lastDecision: null, takeoverMs: 60_000,
    }),
    leadFor: () => null,
    lostHost: () => {},
  }),
}))

import express from 'express'
import request from 'supertest'
import { searchMemoryV1Router } from '../../../src/web/routes/search-memory-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetV1ForwardForTesting } from '../../../src/web/v1-forward/proxy.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', searchMemoryV1Router)
  app.use(errorHandler)
  return app
}

let releaseId = ''

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  _resetV1ForwardForTesting()
  leader.lastSeenAt = Date.now()
  const { addTask, completeTask } = await import('../../../src/core/task-manager.js')
  releaseId = (await addTask({ title: 'Release notes for Friday', project: 'Acme', description: 'After the rollback drill.' })).task.id
  const done = (await addTask({ title: 'Old release notes', project: 'Acme' })).task
  await completeTask(done.id)
  await addTask({ title: '\u5348\u996d plans', project: 'Home' })
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('global search while the Mac is away', () => {
  it('the Mac silent: this box\'s copy answers at once, the Mac not asked', async () => {
    leader.lastSeenAt = Date.now() - 120_000
    const res = await request(createApp()).get('/api/v1/search?q=release%20notes&types=task')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ offline: true, degraded: 'offline-keyword' })
    // The open task first, the finished one after it.
    expect(res.body.results[0]).toMatchObject({ type: 'task', taskId: releaseId, title: 'Release notes for Friday' })
    expect(res.body.results.length).toBeGreaterThanOrEqual(2)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a description hit and a CJK title are found', async () => {
    leader.lastSeenAt = Date.now() - 120_000
    const drill = await request(createApp()).get('/api/v1/search?q=rollback')
    expect(drill.body.results.map((r: { taskId?: string }) => r.taskId)).toContain(releaseId)
    const cjk = await request(createApp()).get(`/api/v1/search?q=${encodeURIComponent('\u5348\u996d')}`)
    expect(cjk.body.results[0]?.title).toBe('\u5348\u996d plans')
  })

  it('the Mac answering: asked as before', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { results: [{ type: 'task', id: 't1', title: 'From the Mac' }] } })
    const res = await request(createApp()).get('/api/v1/search?q=release')
    expect(res.body).toEqual({ results: [{ type: 'task', id: 't1', title: 'From the Mac' }] })
    expect(bridgeRequestMock).toHaveBeenCalledTimes(1)
  })

  it('the phone\'s extras: the Mac is asked for them, and the copy carries the named tasks', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { results: [] } })
    await request(createApp()).get('/api/v1/search?q=release&types=task,session&limit=80&tasks=1&semanticWaitMs=1500')
    expect(bridgeRequestMock.mock.calls[0]![2]).toMatchObject({
      action: 'server.search',
      params: { q: 'release', types: ['task', 'session'], limit: 80, semanticWaitMs: 1500, tasks: true },
    })

    // The Mac away: the copy's own tasks, the completed one included, so the phone
    // can draw and open a task its 14-day list does not hold.
    leader.lastSeenAt = Date.now() - 120_000
    const res = await request(createApp()).get('/api/v1/search?q=release%20notes&types=task&tasks=1')
    expect(res.body).toMatchObject({ offline: true, degraded: 'offline-keyword' })
    // (The task store outlives each test's data dir, so earlier seeds are in it too.)
    const named = res.body.tasks as Array<{ id: string; title: string; status: string }>
    const rowIds = (res.body.results as Array<{ taskId?: string }>).map((r) => r.taskId)
    expect(named.map((t) => t.id)).toEqual([...new Set(rowIds)])
    expect(named.map((t) => t.id)).toContain(releaseId)
    expect(named.some((t) => t.title === 'Old release notes' && t.status === 'done')).toBe(true)
  })
})
