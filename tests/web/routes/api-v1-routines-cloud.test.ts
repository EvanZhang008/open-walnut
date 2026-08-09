/**
 * /api/v1 routines — CLOUD_MODE (REPLICA) behavior. The primary's cron
 * engine is the single writer of cron-jobs.json, so EVERY routines call
 * relays via the box-level `server.routines.*` actions ('__server__'
 * placeholder sessionId). Bridge mocked at its module seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-routines-cloud', { CLOUD_MODE: true }))

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
import { routinesV1Router } from '../../../src/web/routes/routines-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', routinesV1Router)
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

describe('routines relay payloads on a REPLICA', () => {
  it('GET /routines relays server.routines with includeDisabled', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { jobs: [] } })
    const res = await request(createApp()).get('/api/v1/routines?includeDisabled=true')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ jobs: [] })
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines', sessionId: '__server__', params: { includeDisabled: true } },
      30_000,
    )
  })

  it('POST /routines relays server.routines.create with the body and answers 201', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { job: { id: 'r1' } } })
    const body = { name: 'X', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent', text: 'x' } }
    const res = await request(createApp()).post('/api/v1/routines').send(body)
    expect(res.status).toBe(201)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines.create', sessionId: '__server__', params: { body } },
      30_000,
    )
  })

  it('toggle / run / delete relay their id', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { job: { id: 'r2' } } })
    const app = createApp()
    await request(app).post('/api/v1/routines/r2/toggle')
    expect(bridgeRequestMock).toHaveBeenLastCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines.toggle', sessionId: '__server__', params: { id: 'r2' } },
      30_000,
    )
    await request(app).post('/api/v1/routines/r2/run')
    expect(bridgeRequestMock).toHaveBeenLastCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines.run', sessionId: '__server__', params: { id: 'r2' } },
      30_000,
    )
    await request(app).delete('/api/v1/routines/r2')
    expect(bridgeRequestMock).toHaveBeenLastCalledWith(
      '__local__', 'session.control',
      { action: 'server.routines.delete', sessionId: '__server__', params: { id: 'r2' } },
      30_000,
    )
  })

  it('old primary → 400 session_control_needs_upgrade', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.routines' })
    const res = await request(createApp()).get('/api/v1/routines')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/routines/status')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('errorKind passthrough: not_found → 404', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Cron job not found: nope', errorKind: 'not_found' })
    const res = await request(createApp()).get('/api/v1/routines/nope')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})
