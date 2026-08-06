/**
 * /api/v1 session talk — CLOUD_MODE (REPLICA) behavior. Real
 * startServer({ port: 0 }) with the constants mock forcing CLOUD_MODE: true,
 * and the bridge registry mocked at its module seam (the daemon lives on
 * another machine; the real bridge protocol is covered by
 * tests/e2e/daemon-bridge-image-save-e2e.test.ts against the real daemon).
 *
 * Covers the cloud image path: an image-bearing send now rides the narrow
 * bridge-allowlisted `image.save` daemon command — saved on the SESSION'S
 * host, referenced by path in the augmented text (same "[Images attached …]"
 * format as the primary box) — plus the failure ladder: old daemon → 400
 * images_need_daemon_upgrade, save refused → 400 image_upload_failed, bridge
 * down → 503 bridge_offline. Never a silent drop.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-session-cloud', { CLOUD_MODE: true }))

// Bridge seam: the route talks to the daemon exclusively through
// bridgeRequest(). Keep the real BridgeOfflineError shape (instanceof check).
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
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

const SID = 'cloud-sid-0001'
const HOST = 'devbox'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

// Cloud mode has no LAN bypass — every /api call needs a device Bearer token.
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Happy-path daemon: alive session, image.save returns a host path. */
function daemonAnswers(overrides: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {}) {
  let imageCounter = 0
  bridgeRequestMock.mockImplementation(async (_host: string, cmd: string, params: Record<string, unknown> = {}) => {
    if (overrides[cmd]) return overrides[cmd](params)
    switch (cmd) {
      case 'status': return { ok: true, exists: true, alive: true }
      case 'appendUserMarker': return { ok: true }
      case 'send': return { ok: true }
      case 'image.save': return { ok: true, path: `/tmp/open-walnut/images/mobile/17000000${imageCounter++}-abcd1234.png`, size: 68 }
      default: return { ok: true }
    }
  })
}

async function postMessage(body: Record<string, unknown>): Promise<Response> {
  return fetch(apiUrl(`/api/v1/sessions/${SID}/messages`), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
  // The cloud route resolves the session's host from the git-synced projection.
  await fs.mkdir(path.join(WALNUT_HOME, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'sessions', 'projection.json'), JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: [{
      id: SID, host: HOST, process_status: 'running',
      started_at: new Date().toISOString(), last_active_at: new Date().toISOString(),
      message_count: 1, cwd: '/home/user/repo',
    }],
  }))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const device = await createDevice('cloud-image-test-phone')
  deviceToken = device.token
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  bridgeRequestMock.mockReset()
})

describe('POST /api/v1/sessions/:id/messages with images (CLOUD_MODE)', () => {
  it('saves each image on the session host via image.save and sends the augmented text', async () => {
    daemonAnswers()
    const res = await postMessage({
      text: 'look at these on the cloud',
      images: [
        { data: TINY_PNG_BASE64, mediaType: 'image/png' },
        { data: TINY_PNG_BASE64, mediaType: 'image/jpeg' },
      ],
    })
    expect(res.status).toBe(202)
    const body = await res.json() as { messageId: string }
    expect(body.messageId).toMatch(/^qm-mobile-/)

    // image.save went to the SESSION'S host, once per image, no path params.
    const saves = bridgeRequestMock.mock.calls.filter((c) => c[1] === 'image.save')
    expect(saves.length).toBe(2)
    for (const call of saves) {
      expect(call[0]).toBe(HOST)
      expect(call[2]).toEqual({ data: TINY_PNG_BASE64, mediaType: expect.stringMatching(/^image\//) })
    }

    // The FIFO send carries the augmented text: image-path list + original text,
    // same format the primary box uses (CLI reads the files with its Read tool).
    const send = bridgeRequestMock.mock.calls.find((c) => c[1] === 'send')
    expect(send).toBeDefined()
    const sentText = (send![2] as { message: string }).message
    expect(sentText).toContain('[Images attached — use the Read tool to view them]')
    expect(sentText).toMatch(/- \/tmp\/open-walnut\/images\/mobile\/\d+-abcd1234\.png/)
    expect(sentText.endsWith('look at these on the cloud')).toBe(true)
    // The marker (transcript echo) carries the same augmented text.
    const marker = bridgeRequestMock.mock.calls.find((c) => c[1] === 'appendUserMarker')
    expect((marker![2] as { message: string }).message).toBe(sentText)
    // Images must be saved BEFORE the liveness precheck/send sequence runs.
    const firstSaveIdx = bridgeRequestMock.mock.calls.findIndex((c) => c[1] === 'image.save')
    const sendIdx = bridgeRequestMock.mock.calls.findIndex((c) => c[1] === 'send')
    expect(firstSaveIdx).toBeLessThan(sendIdx)
  })

  it('old daemon (unknown command) → 400 images_need_daemon_upgrade, nothing sent', async () => {
    daemonAnswers({
      'image.save': () => ({ ok: false, error: 'unknown command: image.save' }),
    })
    const res = await postMessage({
      text: 'picture for an old daemon',
      images: [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }],
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('images_need_daemon_upgrade')
    // Never a text-only turn that silently dropped the pictures.
    expect(bridgeRequestMock.mock.calls.some((c) => c[1] === 'send')).toBe(false)
    expect(bridgeRequestMock.mock.calls.some((c) => c[1] === 'appendUserMarker')).toBe(false)
  })

  it('daemon refuses the payload → 400 image_upload_failed, nothing sent', async () => {
    daemonAnswers({
      'image.save': () => ({ ok: false, error: 'image.save: too large (EFBIG)' }),
    })
    const res = await postMessage({
      text: 'oversized picture',
      images: [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }],
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('image_upload_failed')
    expect(body.error.message).toContain('EFBIG')
    expect(bridgeRequestMock.mock.calls.some((c) => c[1] === 'send')).toBe(false)
  })

  it('bridge down → 503 bridge_offline (clean error, not a crash)', async () => {
    bridgeRequestMock.mockImplementation(async (host: string) => {
      throw new BridgeOfflineError(host)
    })
    const res = await postMessage({
      text: 'picture with no bridge',
      images: [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }],
    })
    expect(res.status).toBe(503)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('bridge_offline')
  })

  it('a text-only send never touches image.save (unchanged path)', async () => {
    daemonAnswers()
    const res = await postMessage({ text: 'text only, no images' })
    expect(res.status).toBe(202)
    expect(bridgeRequestMock.mock.calls.some((c) => c[1] === 'image.save')).toBe(false)
    const send = bridgeRequestMock.mock.calls.find((c) => c[1] === 'send')
    expect((send![2] as { message: string }).message).toBe('text only, no images')
  })

  it('unknown session → 404 before any bridge traffic', async () => {
    daemonAnswers()
    const res = await fetch(apiUrl('/api/v1/sessions/no-such-session/messages'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'hi', images: [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }] }),
    })
    expect(res.status).toBe(404)
    expect(bridgeRequestMock).not.toHaveBeenCalled()
  })
})
