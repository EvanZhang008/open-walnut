/**
 * GET/PUT /api/v1/tasks/meta/tag-display on a cloud REPLICA. The user's rules live in the
 * primary's config.yaml and plugin defaults (a ticket plugin's `ticket:*` value + link) in its
 * memory, so a replica answering from its own store would show a phone every ticket tag whole
 * and unlinked. It relays `server.tag-display` / `server.tag-display.set` to the primary (bridge
 * mocked at its module seam); a read that cannot reach the Mac answers Walnut's own rules.
 * The primary half (handleSessionControlRelay) runs for real in the last block.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-tag-display-cloud', { CLOUD_MODE: true }))

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
import { taskExtrasV1Router } from '../../../src/web/routes/task-extras-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { _resetTagDisplayForTesting, setPluginTagDisplay, setPluginTagLink } from '../../../src/core/tag-display.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', taskExtrasV1Router)
  app.use(errorHandler)
  return app
}

const PRIMARY_STATE = {
  rules: [
    { pattern: 'walnut:*', display: 'hidden', source: 'builtin' },
    { pattern: 'ticket:*', display: 'value', source: 'plugin', pluginId: 'tickets', pluginName: 'Tickets' },
    { pattern: 'label:*', display: 'value', source: 'default' },
  ],
  links: [{ pattern: 'ticket:*', link: 'https://tracker.example.com/{value}', source: 'plugin', pluginId: 'tickets', pluginName: 'Tickets' }],
}

const savedGrace = process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
beforeEach(async () => {
  bridgeRequestMock.mockReset()
  process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = '0'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetTagDisplayForTesting()
})
afterEach(async () => {
  if (savedGrace === undefined) delete process.env.WALNUT_BRIDGE_BLIP_GRACE_MS
  else process.env.WALNUT_BRIDGE_BLIP_GRACE_MS = savedGrace
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/v1/tasks/meta/tag-display on a REPLICA', () => {
  it("relays server.tag-display and answers the primary's rules and links", async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: PRIMARY_STATE })
    const res = await request(createApp()).get('/api/v1/tasks/meta/tag-display')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(PRIMARY_STATE)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.tag-display', sessionId: '__server__', params: {} },
      8_000,
    )
  })

  it("answers its own rules (Walnut's, never an error) when the Mac cannot be reached", async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/tasks/meta/tag-display')
    expect(res.status).toBe(200)
    expect(res.body.rules).toContainEqual({ pattern: 'walnut:*', display: 'hidden', source: 'builtin' })
    expect(res.body.rules).toContainEqual({ pattern: 'label:*', display: 'value', source: 'default' })
    expect(res.body.links).toEqual([])
  })

  it('answers its own rules when the primary predates the action', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'Unknown control action: server.tag-display', errorKind: 'bad_request' })
    const res = await request(createApp()).get('/api/v1/tasks/meta/tag-display')
    expect(res.status).toBe(200)
    expect(res.body.rules.some((rule: { source: string }) => rule.source === 'default')).toBe(true)
  })
})

describe('PUT /api/v1/tasks/meta/tag-display on a REPLICA', () => {
  it('relays the change to the primary and answers what it answers', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: PRIMARY_STATE })
    const res = await request(createApp()).put('/api/v1/tasks/meta/tag-display').send({ pattern: 'ticket:*', link: '' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual(PRIMARY_STATE)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.tag-display.set', sessionId: '__server__', params: { pattern: 'ticket:*', link: '' } },
      30_000,
    )
  })

  it("passes the primary's 400 through", async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'display must be "shown", "value" or "hidden".', errorKind: 'bad_request' })
    const res = await request(createApp()).put('/api/v1/tasks/meta/tag-display').send({ pattern: 'ticket:*', display: 'maybe' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/display must be/)
  })

  it('503 when the Mac cannot be reached: a change is never kept on the replica', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).put('/api/v1/tasks/meta/tag-display').send({ pattern: 'ticket:*', display: 'hidden' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})

describe('the primary half: server.tag-display actions', () => {
  it('server.tag-display answers the rules and links in force, plugin defaults included', async () => {
    setPluginTagDisplay('tickets', 'ticket:*', 'value', 'Tickets')
    setPluginTagLink('tickets', 'ticket:*', 'https://tracker.example.com/{value}', 'Tickets')
    const out = await handleSessionControlRelay('server.tag-display', '__server__', {}) as { ok: true; result: typeof PRIMARY_STATE }
    expect(out.ok).toBe(true)
    expect(out.result.rules).toContainEqual(expect.objectContaining({ pattern: 'ticket:*', display: 'value', source: 'plugin' }))
    expect(out.result.links).toContainEqual(expect.objectContaining({ pattern: 'ticket:*', link: 'https://tracker.example.com/{value}', source: 'plugin' }))
  })

  it("server.tag-display.set writes the user's rule; a bad one is a bad_request, not an internal error", async () => {
    const set = await handleSessionControlRelay('server.tag-display.set', '__server__', { pattern: 'ticket:*', link: '' }) as { ok: true; result: typeof PRIMARY_STATE }
    expect(set.ok).toBe(true)
    expect(set.result.links).toContainEqual({ pattern: 'ticket:*', link: '', source: 'user' })
    const bad = await handleSessionControlRelay('server.tag-display.set', '__server__', { pattern: 'ticket:*', display: 'maybe' })
    expect(bad).toMatchObject({ ok: false, errorKind: 'bad_request' })
    const machine = await handleSessionControlRelay('server.tag-display.set', '__server__', { pattern: 'walnut:*', display: 'shown' })
    expect(machine).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})
