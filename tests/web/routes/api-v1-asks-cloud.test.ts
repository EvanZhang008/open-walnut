/**
 * GET /api/v1/asks on a cloud REPLICA: B-class relay. The pushed task projection
 * carries no ask stamp, activity stamp or session id, so the replica must NOT
 * compute a list of its own (it would silently disagree with the Mac); it relays
 * `server.asks` to the primary (bridge mocked at its module seam) and answers
 * the frozen errors when it cannot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-asks-cloud', { CLOUD_MODE: true }))

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
import { asksV1Router } from '../../../src/web/routes/asks-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', asksV1Router)
  app.use(errorHandler)
  return app
}

const savedGrace = process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
beforeEach(() => {
  bridgeRequestMock.mockReset()
  process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = '0'
})
afterEach(() => {
  if (savedGrace === undefined) delete process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
  else process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = savedGrace
})

describe('GET /api/v1/asks on a REPLICA', () => {
  it("relays server.asks with the validated query and returns the primary's answer verbatim", async () => {
    const answer = {
      agentId: 'mentor', project: 'Ask Mentor', total: 1,
      asks: [{ id: 't1', title: 'Weekly reflection', state: 'idle', activityAt: '2026-09-20T09:00:00.000Z', createdAt: '2026-09-12T09:00:00.000Z', sessionId: 's1' }],
    }
    bridgeRequestMock.mockResolvedValue({ ok: true, result: answer })
    const res = await request(createApp()).get('/api/v1/asks?agentId=mentor&q=%20weekly%20&limit=5000')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(answer)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.asks', sessionId: '__server__', params: { agentId: 'mentor', q: 'weekly', limit: 1000 } },
      30_000,
    )
  })

  it('503 bridge_offline when the Mac cannot be reached (never a list of its own)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/asks')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('400 session_control_needs_upgrade when the primary predates server.asks', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.asks', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/asks')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('session_control_needs_upgrade')
  })

  it("passes the primary's 404 through for an unknown agent", async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Agent not found: ghost', errorKind: 'not_found' })
    const res = await request(createApp()).get('/api/v1/asks?agentId=ghost')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('refuses a malformed agent id before any relay', async () => {
    const res = await request(createApp()).get('/api/v1/asks?agentId=..%2Fetc')
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('refuses an agentId or q given twice before any relay (it used to relay Walnut\'s list)', async () => {
    for (const qs of ['agentId=mentor&agentId=general', 'q=a&q=b']) {
      const res = await request(createApp()).get(`/api/v1/asks?${qs}`)
      expect(res.status, qs).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
    }
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('relays a limit too large for a number as the cap', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { agentId: 'general', project: 'Ask Walnut', total: 0, launch: true, asks: [] } })
    const res = await request(createApp()).get('/api/v1/asks?limit=99999999999999999999')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock.mock.calls[0][2]).toMatchObject({ params: { limit: 1000 } })
  })
})
