/**
 * /api/v1 session extras — CLOUD_MODE (REPLICA) relay behavior. Every Wave-2
 * session-extras endpoint relays through the primary's daemon bridge as a NEW
 * action on the existing `session.control` command; list-dirs rides the
 * box-level `server.list-dirs` action ('__server__' placeholder). Bridge
 * mocked at its module seam. Also pins workflow's { workflow: null } → 204
 * unwrap and the standard failure ladder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-sessionextras-cloud', { CLOUD_MODE: true }))

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
import { sessionExtrasV1Router } from '../../../src/web/routes/session-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', sessionExtrasV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  bridgeRequestMock.mockReset()
})

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const SID = 'cloud-se-session-1'

function expectRelay(action: string, params?: Record<string, unknown>, sessionId = SID) {
  expect(bridgeRequestMock).toHaveBeenLastCalledWith(
    '__local__', 'session.control',
    { action, sessionId, ...(params !== undefined ? { params } : {}) },
    30_000,
  )
}

describe('session-extras relay payloads on a REPLICA', () => {
  it('controls GET/POST relay', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { engine: 'claude', controls: [] } })
    const app = createApp()
    expect((await request(app).get(`/api/v1/sessions/${SID}/controls`)).status).toBe(200)
    expectRelay('controls')
    await request(app).post(`/api/v1/sessions/${SID}/controls`).send({ id: 'mode', value: 'plan' })
    expectRelay('controls.apply', { id: 'mode', value: 'plan' })
  })

  it('settings relays with details only when requested', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { live: false } })
    const app = createApp()
    await request(app).get(`/api/v1/sessions/${SID}/settings`)
    expectRelay('settings')
    await request(app).get(`/api/v1/sessions/${SID}/settings?details=1`)
    expectRelay('settings', { details: true })
  })

  it('side-question family relays', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { sideQuestions: [] } })
    const app = createApp()
    await request(app).get(`/api/v1/sessions/${SID}/side-questions`)
    expectRelay('side-questions')
    await request(app).post(`/api/v1/sessions/${SID}/side-question`).send({ question: 'why?' })
    expectRelay('side-question.ask', { question: 'why?' })
    await request(app).post(`/api/v1/sessions/${SID}/side-question/sq-1/promote`)
    expectRelay('side-question.promote', { id: 'sq-1' })
    await request(app).delete(`/api/v1/sessions/${SID}/side-question/sq-1`)
    expectRelay('side-question.delete', { id: 'sq-1' })
  })

  it('workflow: envelope { workflow: null } unwraps to 204; a payload passes through', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { workflow: null } })
    const app = createApp()
    const none = await request(app).get(`/api/v1/sessions/${SID}/workflow`)
    expect(none.status).toBe(204)
    expectRelay('workflow')

    bridgeRequestMock.mockResolvedValue({ ok: true, result: { workflow: { steps: [1, 2] } } })
    const some = await request(app).get(`/api/v1/sessions/${SID}/workflow`)
    expect(some.status).toBe(200)
    expect(some.body).toEqual({ steps: [1, 2] })
  })

  it('plan / subagent-history / execute-compact relay', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { content: 'plan' } })
    const app = createApp()
    await request(app).get(`/api/v1/sessions/${SID}/plan`)
    expectRelay('plan')
    await request(app).get(`/api/v1/sessions/${SID}/subagent/agent-1/history?workflow=1`)
    expectRelay('subagent-history', { agentId: 'agent-1', workflow: true })
    await request(app).post(`/api/v1/sessions/${SID}/execute-compact`).send({ task_id: 't-1' })
    expectRelay('execute-compact', {
      task_id: 't-1', working_directory: undefined, instructions: undefined, mode: undefined,
    })
  })

  it('queue family relays', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { messages: [] } })
    const app = createApp()
    await request(app).get(`/api/v1/sessions/${SID}/queue`)
    expectRelay('queue')
    await request(app).patch(`/api/v1/sessions/${SID}/queue/qm-1`).send({ text: 'edited' })
    expectRelay('queue.edit', { messageId: 'qm-1', text: 'edited' })
    await request(app).delete(`/api/v1/sessions/${SID}/queue/qm-1`)
    expectRelay('queue.delete', { messageId: 'qm-1' })
  })

  it('list-dirs rides the __server__ placeholder', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { dirs: [], parent: '/', exists: true } })
    await request(createApp()).get('/api/v1/sessions/list-dirs?prefix=/tmp/&depth=2')
    expectRelay('server.list-dirs', { prefix: '/tmp/', depth: 2 }, '__server__')
  })
})

describe('failure ladder', () => {
  it('old primary → 400 session_control_needs_upgrade', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: controls' })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/controls`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('bridge offline → 503 bridge_offline (workflow uses the shared drive)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/workflow`)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('errorKind passthrough: not_found → 404', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'session not found', errorKind: 'not_found' })
    const res = await request(createApp()).get(`/api/v1/sessions/${SID}/settings`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('invalid session id is rejected locally (never relays)', async () => {
    const res = await request(createApp()).get('/api/v1/sessions/..%2Fetc/controls')
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})
