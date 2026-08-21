/**
 * /api/v1 file browsing — CLOUD_MODE (REPLICA) behavior. list / resolve-path
 * relay as box-level `server.files.*` actions (names-only metadata).
 *
 * file-content READS relay to the target host's daemon over the bridge via
 * the narrow `fs.readBounded` command (2MB cap + path sandbox enforced
 * HOST-SIDE — see src/web/routes/file-content-bridge.ts). The threat model
 * pinned here: traversal/secret paths refuse WITHOUT touching the bridge,
 * oversize → 413 too_large, bridge down → 503 bridge_offline, an old daemon
 * (no fs.readBounded) → 501 not_supported_cloud, and '' / absent host targets
 * the PRIMARY ('__local__'). WRITES still never ride the bridge.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
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

/** One daemon-style fs.readBounded success reply. */
function daemonOk(content: string | Buffer) {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content
  return { ok: true, data: buf.toString('base64'), encoding: 'base64', size: buf.length }
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

describe('file-content bounded relay on a REPLICA', () => {
  it('remote-host JSON read relays fs.readBounded to that host and serves the payload', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('# hello from devbox\n'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/readme.md&host=devbox')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('# hello from devbox\n')
    expect(res.body.binary).toBe(false)
    expect(res.body.truncated).toBe(false)
    expect(typeof res.body.contentHash).toBe('string')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      'devbox', 'fs.readBounded', { path: '/w/readme.md' }, expect.any(Number),
    )
  })

  it('raw=1 HTML read serves the bytes with text/html (the phone WKWebView path)', async () => {
    const html = '<!doctype html><h1>chart</h1>'
    bridgeRequestMock.mockResolvedValue(daemonOk(html))
    const res = await request(createApp()).get('/api/v1/file-content?path=/tmp/x/index.html&host=devbox&raw=1')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.text).toBe(html)
  })

  it("'' / absent host targets the PRIMARY ('__local__') daemon", async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk('mac file'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/Users/me/notes.txt')
    expect(res.status).toBe(200)
    expect(res.body.content).toBe('mac file')
    expect(bridgeRequestMock).toHaveBeenCalledWith(
      '__local__', 'fs.readBounded', { path: '/Users/me/notes.txt' }, expect.any(Number),
    )
  })

  it('daemon EFBIG (over the 2MB cap) → 413 too_large with the friendly copy', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'fs.readBounded: too large (EFBIG)' })
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/whale.html&host=devbox&raw=1')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('too_large')
    expect(res.body.error.message).toContain('open it on your Mac')
  })

  it('bridge offline → 503 bridge_offline (degraded, never a hang)', async () => {
    bridgeRequestMock.mockRejectedValue(new BridgeOfflineError('devbox'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.md&host=devbox')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('bridge request timeout → 503 bridge_offline too', async () => {
    bridgeRequestMock.mockRejectedValue(new Error('bridge request timed out: fs.readBounded → devbox'))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.md&host=devbox')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('bridge_offline')
  })

  it('old daemon (unknown command / bridge allowlist refusal) → 501 not_supported_cloud', async () => {
    for (const error of [
      'unknown command: fs.readBounded',
      'command not permitted over bridge: fs.readBounded',
    ]) {
      bridgeRequestMock.mockResolvedValueOnce({ ok: false, error })
      const res = await request(createApp()).get('/api/v1/file-content?path=/w/x.html&host=devbox&raw=1')
      expect(res.status).toBe(501)
      expect(res.body.error.code).toBe('not_supported_cloud')
    }
  })

  it('daemon EDENIED (host-side sandbox) → 403 not_supported_cloud', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: 'fs.readBounded: path not permitted (EDENIED)' })
    const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent('/home/user/keys.txt')}&host=devbox`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
  })

  it('daemon ENOENT → the legacy 200-with-error viewer payload (JSON) and 404 (raw)', async () => {
    bridgeRequestMock.mockResolvedValue({ ok: false, error: "fs.readBounded failed: ENOENT: no such file or directory, realpath '/w/gone.md' (ENOENT)" })
    const app = createApp()
    const json = await request(app).get('/api/v1/file-content?path=/w/gone.md&host=devbox')
    expect(json.status).toBe(200)
    expect(json.body.error).toBe('File not found')
    expect(json.body.content).toBeNull()
    const raw = await request(app).get('/api/v1/file-content?path=/w/gone.md&host=devbox&raw=1')
    expect(raw.status).toBe(404)
  })

  it('traversal attempt refuses WITHOUT touching the bridge', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/w/../../etc/passwd')}&host=devbox`)
    expect(res.status).toBe(400)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('replica-side secret pre-check refuses config.yaml WITHOUT touching the bridge', async () => {
    const res = await request(createApp())
      .get(`/api/v1/file-content?path=${encodeURIComponent('/w/config.yaml')}&host=devbox`)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })

  it('a replica-side oversized daemon reply is capped to 413 (stale-twin backstop)', async () => {
    // A daemon that somehow returns > 2MB must not be forwarded to the phone.
    bridgeRequestMock.mockResolvedValue(daemonOk(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/big.txt&host=devbox')
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('too_large')
  })

  it('binary bytes from the daemon come back as the binary viewer payload (JSON mode)', async () => {
    bridgeRequestMock.mockResolvedValue(daemonOk(Buffer.from([0x00, 0x01, 0x02, 0x03])))
    const res = await request(createApp()).get('/api/v1/file-content?path=/w/blob.bin&host=devbox')
    expect(res.status).toBe(200)
    expect(res.body.binary).toBe(true)
    expect(res.body.content).toBeNull()
  })

  it('a no-host read of a locally-present safe-root file stays LOCAL (no bridge hop)', async () => {
    const dir = path.join('/tmp/open-walnut', 'files-cloud-test')
    const p = path.join(dir, 'local.txt')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(p, 'replica-local bytes', 'utf-8')
    try {
      const res = await request(createApp()).get(`/api/v1/file-content?path=${encodeURIComponent(p)}`)
      expect(res.status).toBe(200)
      expect(res.body.content).toBe('replica-local bytes')
      expect(bridgeRequestMock).not.toHaveBeenCalled()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('file-content WRITE threat model on a REPLICA (unchanged)', () => {
  it('remote-host write still answers 501, never touches the bridge', async () => {
    const res = await request(createApp())
      .put('/api/v1/file-content')
      .send({ path: '/w/x.md', host: 'devbox', content: 'overwrite' })
    expect(res.status).toBe(501)
    expect(res.body.error.code).toBe('not_supported_cloud')
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})
