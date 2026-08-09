/**
 * /api/v1 console reads — CLOUD_MODE (REPLICA) behavior: config still
 * projects locally (same allowlist — the no-secrets invariant holds on the
 * replica too), usage answers 501 (DB lives on the primary), and
 * slash-commands relays via the box-level `server.slash-commands` action.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-console-cloud', { CLOUD_MODE: true }))

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
import { consoleV1Router } from '../../../src/web/routes/console-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', consoleV1Router)
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

describe('config on a REPLICA', () => {
  it('projects locally, still allowlist-only (no secret leaks), cloud:true', async () => {
    await fs.writeFile(CONFIG_FILE, [
      'version: 1',
      'provider:',
      '  type: bedrock',
      '  bedrock_bearer_token: SECRET-CLOUD-BEARER',
    ].join('\n'))
    const res = await request(createApp()).get('/api/v1/config')
    expect(res.status).toBe(200)
    expect(res.body.cloud).toBe(true)
    expect(JSON.stringify(res.body)).not.toContain('SECRET-CLOUD-BEARER')
    expect(JSON.stringify(res.body)).not.toContain('bedrock_bearer_token')
  })
})

describe('usage on a REPLICA', () => {
  it('501 not_supported_cloud', async () => {
    const res = await request(createApp()).get('/api/v1/usage/overview')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })
})

describe('slash-commands on a REPLICA', () => {
  it('relays server.slash-commands with cwd/host/fresh', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { items: [] } })
    const res = await request(createApp()).get('/api/v1/slash-commands?cwd=/w&host=devbox&fresh=1')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.slash-commands', sessionId: '__server__', params: { cwd: '/w', host: 'devbox', fresh: true } },
      30_000,
    )
  })

  it('bridge offline → 503', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/slash-commands')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})
