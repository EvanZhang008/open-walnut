/**
 * /api/v1 session control — CLOUD_MODE (REPLICA) behavior. Session records +
 * live CLIs live on the primary box, so all four endpoints RELAY through the
 * primary's daemon bridge: narrow `session.control` command → `control-request`
 * event → the primary's walnut server runs the shared session-controls core.
 *
 * Bridge mocked at its module seam (same pattern as
 * session-launch-v1-cloud.test.ts). Covers: relay payload shape per action,
 * success passthrough, and the failure ladder (old daemon → 400
 * session_control_needs_upgrade, bridge down / primary down → 503
 * bridge_offline, errorKind → HTTP status passthrough).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-sessionctl-cloud', { CLOUD_MODE: true }))

// Bridge seam: the cloud route talks to the primary's daemon exclusively
// through bridgeRequest(). Keep the real BridgeOfflineError shape.
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
import { sessionControlV1Router } from '../../../src/web/routes/session-control-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { getLaunchSeed, _resetLaunchSeedsForTesting } from '../../../src/core/sessions/launch-seed.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionControlV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
  _resetLaunchSeedsForTesting()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const SID = 'cloud-ctl-session-1'

describe('session control relay payloads on a REPLICA', () => {
  it('GET model-options relays action model-options (no params)', async () => {
    const options = { models: [{ id: 'opus', label: 'Opus' }], current: 'opus', currentEffort: 'high' }
    bridgeRequestMock.mockResolvedValue({ ok: true, result: options })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/model-options`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(options)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'model-options', sessionId: SID },
      30_000,
    )
  })

  it('POST model relays action model with params', async () => {
    const result = { model: 'opus-1m', cliModel: 'opus[1m]', appliedLive: true, effectiveModel: 'claude-opus-4-8[1m]' }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/model`)
      .send({ model: 'opus-1m' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(result)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'model', sessionId: SID, params: { model: 'opus-1m' } },
      30_000,
    )
  })

  it('POST effort relays action effort with params', async () => {
    const result = { effort: 'high', appliedLive: true, effectiveEffort: 'high', overridden: false }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/effort`)
      .send({ effort: 'high' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(result)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'effort', sessionId: SID, params: { effort: 'high' } },
      30_000,
    )
  })

  it('POST fork relays action fork with sanitized params and returns 201', async () => {
    const result = {
      status: 'pending', sourceSessionId: SID, sessionId: 'fork-sid-1',
      taskId: 'task-f1', title: 'Fork of source', childTaskCreated: true,
    }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/fork`)
      .send({ create_child_task: true, message: 'try B', unknown_field: 'dropped' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual(result)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'fork', sessionId: SID, params: { create_child_task: true, message: 'try B' } },
      30_000,
    )
  })

  it('seeds the fork sessionId→host mapping so the next v1 calls do not 404 (P1-2)', async () => {
    const result = {
      status: 'pending', sourceSessionId: SID, sessionId: 'fork-sid-seed',
      taskId: 'task-f2', title: 'Fork of source', host: 'clouddev',
    }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/fork`)
      .send({ create_child_task: true })
    expect(res.status).toBe(201)
    expect(getLaunchSeed('fork-sid-seed')).toEqual({ host: 'clouddev', cwd: undefined, model: undefined })
  })

  it('maps an empty fork host to __local__ in the launch seed (primary alias)', async () => {
    const result = {
      status: 'pending', sourceSessionId: SID, sessionId: 'fork-sid-local',
      taskId: 'task-f3', title: 'Fork of source',
    }
    bridgeRequestMock.mockResolvedValue({ ok: true, result })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/fork`)
      .send({ create_child_task: true })
    expect(res.status).toBe(201)
    expect(getLaunchSeed('fork-sid-local')?.host).toBe('__local__')
  })

  it('does NOT seed on model/effort actions', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { model: 'opus', sessionId: 'not-a-fork' } })
    await request(createApp()).post(`/api/v1/sessions/${SID}/model`).send({ model: 'opus' })
    expect(getLaunchSeed('not-a-fork')).toBeNull()
  })

  it('rejects an unsafe session id locally without a bridge round trip', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/..%2Fetc/model-options')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})

describe('failure ladder', () => {
  it('400 session_control_needs_upgrade on a pre-session.control daemon (unknown command)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'unknown command: session.control' })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/model`)
      .send({ model: 'opus' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('400 session_control_needs_upgrade when the daemon allowlist rejects the command', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'command not permitted over bridge: session.control' })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/model-options`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('503 bridge_offline when no live bridge to the primary', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/effort`)
      .send({ effort: 'high' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('503 bridge_offline when the primary server is disconnected from its daemon', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session.control: no primary server connected' })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/fork`)
      .send({ create_child_task: true })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('passes the primary validation errors through with their errorKind status', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session not found', errorKind: 'not_found' })
    const res = await request(createApp())
      .post(`/api/v1/sessions/${SID}/model`)
      .send({ model: 'opus' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')

    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Target task already has a session', errorKind: 'conflict' })
    const res409 = await request(createApp())
      .post(`/api/v1/sessions/${SID}/fork`)
      .send({ task_id: 'task-x' })
    expect(res409.status).toBe(409)
    expect(res409.body.error.code).toBe('conflict')

    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'boom', errorKind: 'internal' })
    const res500 = await request(createApp())
      .post(`/api/v1/sessions/${SID}/effort`)
      .send({ effort: 'high' })
    expect(res500.status).toBe(500)
    expect(res500.body.error.code).toBe('internal')
  })
})
