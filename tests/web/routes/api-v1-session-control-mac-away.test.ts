/**
 * The phone's model picker on the cloud companion while the Mac is away
 * (session-control-v1.ts + core/sessions/model-options-copy.ts): the real
 * routes, the real projection copy on disk, the real forward's view of the Mac;
 * the bridge and the backup leader are stand-ins.
 *
 *   - the Mac away (silent, or a forward since its last beat went unanswered):
 *     model-options answers from the copy at once, the Mac is not asked;
 *   - the Mac answering, or a session the copy does not list: asked as before;
 *   - the companion leading the session's host: a model or effort change goes
 *     to that host (`leader.settings` at the lead's epoch), and the picker
 *     shows it; not leading: relayed to the Mac as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-sessionctl-away', { CLOUD_MODE: true }))

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

const leader = vi.hoisted(() => ({
  lastSeenAt: 0,
  leads: new Map<string, { walnutId: string; epoch: number }>(),
}))
vi.mock('../../../src/core/leader/backup-leader.js', () => ({
  getBackupLeader: async () => ({
    status: () => ({
      leading: [...leader.leads].map(([host, l]) => ({ host, epoch: l.epoch, since: 0 })),
      primaryLastSeenAt: leader.lastSeenAt, primaryHeard: true, backupAllowed: true,
      restartingUntil: null, lastDecision: null, takeoverMs: 60_000,
    }),
    leadFor: (host: string) => leader.leads.get(host) ?? null,
    lostHost: (host: string) => { leader.leads.delete(host) },
  }),
}))

import express from 'express'
import request from 'supertest'
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { writeProjectionCache } from '../../../src/core/projection-cache.js'
import { _resetV1ForwardForTesting } from '../../../src/web/v1-forward/proxy.js'
import { _resetModelCopyForTesting } from '../../../src/core/sessions/model-options-copy.js'

const B = 'bbbbbbbb-2222-4222-8222-222222222222'
const M = 'cccccccc-3333-4333-8333-333333333333'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionControlV1Router)
  app.use(errorHandler)
  return app
}

async function writeCopy(exportedAt = new Date(Date.now() - 60_000).toISOString()) {
  await writeProjectionCache('sessions', {
    version: 1, exportedAt,
    sessions: [
      { id: B, host: 'devbox', process_status: 'idle', started_at: '', last_active_at: '', message_count: 2, cli_model: 'sonnet[1m]', effort: 'medium' },
      { id: M, host: '', process_status: 'idle', started_at: '', last_active_at: '', message_count: 1, model: 'opus' },
    ],
    host_model_catalogs: {
      devbox: {
        fetchedAt: '2026-10-07T20:00:00Z',
        models: [
          { value: 'sonnet[1m]', displayName: 'Sonnet (1M)', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
          { value: 'haiku', displayName: 'Haiku', supportsEffort: false, supportedEffortLevels: [] },
        ],
      },
    },
  })
}

const macCalls = () => bridgeRequestMock.mock.calls.filter((c) => c[0] === '__local__')
const hostCalls = (host: string) => bridgeRequestMock.mock.calls.filter((c) => c[0] === host)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  leader.lastSeenAt = Date.now()
  leader.leads.clear()
  _resetV1ForwardForTesting()
  _resetModelCopyForTesting()
  await writeCopy()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('model-options while the Mac is away', () => {
  it('the Mac silent: answered from the copy at once, the Mac not asked', async () => {
    leader.lastSeenAt = Date.now() - 120_000
    const res = await request(createApp()).get(`/api/v1/sessions/${B}/model-options`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ current: 'sonnet[1m]', currentEffort: 'medium', offline: true })
    expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(['sonnet[1m]', 'haiku'])
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('the Mac answering: asked as before', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { models: [{ id: 'opus', label: 'Opus' }], current: 'opus', currentEffort: null } })
    const res = await request(createApp()).get(`/api/v1/sessions/${B}/model-options`)
    expect(res.body).toEqual({ models: [{ id: 'opus', label: 'Opus' }], current: 'opus', currentEffort: null })
    expect(macCalls()).toHaveLength(1)
  })

  it('the Mac away but the copy does not list the session: asked as before', async () => {
    leader.lastSeenAt = Date.now() - 120_000
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { models: [], current: null, currentEffort: null } })
    await request(createApp()).get('/api/v1/sessions/dddddddd-4444-4444-8444-444444444444/model-options')
    expect(macCalls()).toHaveLength(1)
  })
})

describe('a change while the companion leads the session\'s host', () => {
  beforeEach(() => {
    leader.lastSeenAt = Date.now() - 120_000
    leader.leads.set('devbox', { walnutId: 'wtest', epoch: 3 })
  })

  it('a model change goes to the host at the lead\'s epoch, and the picker shows it', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, appliedLive: true })
    const app = createApp()
    const res = await request(app).post(`/api/v1/sessions/${B}/model`).send({ model: 'haiku' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ model: 'haiku', cliModel: 'haiku', appliedLive: true, viaCompanion: true })
    expect(hostCalls('devbox')).toEqual([['devbox', 'leader.settings', { walnutId: 'wtest', epoch: 3, sid: B, model: 'haiku' }, 15_000]])
    expect(macCalls()).toHaveLength(0)
    const options = await request(app).get(`/api/v1/sessions/${B}/model-options`)
    expect(options.body.current).toBe('haiku')
  })

  it('an effort change too, checked against the model', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, appliedLive: true })
    const ok = await request(createApp()).post(`/api/v1/sessions/${B}/effort`).send({ effort: 'low' })
    expect(ok.body).toEqual({ effort: 'low', appliedLive: true, overridden: false, viaCompanion: true })
    const refused = await request(createApp()).post(`/api/v1/sessions/${B}/effort`).send({ effort: 'max' })
    expect(refused.status).toBe(409)
    expect(hostCalls('devbox')).toHaveLength(1)
  })

  it('a session on the Mac itself is not the host\'s: relayed to the Mac as before', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).post(`/api/v1/sessions/${M}/model`).send({ model: 'haiku' })
    expect(res.status).toBe(503)
    expect(hostCalls('devbox')).toHaveLength(0)
  })
})

describe('a change while nothing leads the host', () => {
  it('relayed to the Mac as before', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { model: 'haiku', cliModel: 'haiku', appliedLive: true } })
    const res = await request(createApp()).post(`/api/v1/sessions/${B}/model`).send({ model: 'haiku' })
    expect(res.body).toMatchObject({ model: 'haiku', appliedLive: true })
    expect(macCalls()).toHaveLength(1)
    expect(hostCalls('devbox')).toHaveLength(0)
  })
})
