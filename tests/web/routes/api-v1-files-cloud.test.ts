/**
 * /api/v1 file browsing — CLOUD_MODE (REPLICA) behavior. list / resolve-path
 * relay as box-level `server.files.*` actions (names-only metadata); the
 * file-content THREAT MODEL is pinned here: a remote-host content read
 * answers 501 (the bridge deliberately has no arbitrary-read channel), and a
 * replica-local read is confined to the safe /tmp roots by the shared core's
 * CLOUD_MODE guard (secret paths + out-of-root paths → 403 mapped to
 * not_supported_cloud).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-files-cloud', { CLOUD_MODE: true }))

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
import { filesV1Router } from '../../../src/web/routes/files-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', filesV1Router)
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

describe('files list/resolve relay on a REPLICA', () => {
  it('list relays server.files.list with path/host/showHidden', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { path: '/w', entries: [] } })
    const res = await request(createApp()).get('/api/v1/files/list?path=/w&host=devbox&showHidden=1')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.files.list', sessionId: '__server__', params: { path: '/w', host: 'devbox', showHidden: true } },
      30_000,
    )
  })

  it('resolve-path relays server.files.resolve', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: true, result: { path: '/w/x.md', resolved: true } })
    const res = await request(createApp()).get('/api/v1/files/resolve-path?rel=x.md&cwd=/w')
    expect(res.status).toBe(200)
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'session.control',
      { action: 'server.files.resolve', sessionId: '__server__', params: { rel: 'x.md', cwd: '/w' } },
      30_000,
    )
  })

  it('bridge offline → 503 bridge_offline', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('__local__'))
    const res = await request(createApp()).get('/api/v1/files/list?path=/w')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })
})

describe('file-content THREAT MODEL on a REPLICA', () => {
  it('remote-host content read → 501 not_supported_cloud, never touches the bridge', async () => {
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/secret.md&host=devbox')
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('local read outside the safe roots → 403 mapped to not_supported_cloud', async () => {
    const res = await request(createApp()).get('/api/v1/file-content?path=/etc/passwd')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })

  it('secret paths refuse even inside a permitted root (config.yaml pattern)', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/tmp/open-walnut/config.yaml')}`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })
})
