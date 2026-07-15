/**
 * /api/v1 session talk — CLOUD_MODE (REPLICA) behavior. Real
 * startServer({ port: 0 }) with the constants mock forcing CLOUD_MODE: true.
 *
 * Covers the additive image scope-cut: a cloud replica can't serve session
 * images (the CLI runs on another machine and can't read files saved on the
 * cloud box), so an image-bearing send is rejected with a clear 400 BEFORE the
 * daemon bridge is ever touched. Text-only sends are unaffected (they proceed
 * to cloudSend, which 503s here since no bridge is registered in the test).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-session-cloud', { CLOUD_MODE: true }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { createDevice, _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'

let server: HttpServer
let port: number
let deviceToken: string

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

// Cloud mode has no LAN bypass — every /api call needs a device Bearer token.
function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` }
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
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

describe('POST /api/v1/sessions/:id/messages (CLOUD_MODE)', () => {
  it('400 images_not_supported_cloud when images are attached', async () => {
    const res = await fetch(apiUrl('/api/v1/sessions/cloud-sid-0001/messages'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        text: 'look at this on the cloud',
        images: [{ data: TINY_PNG_BASE64, mediaType: 'image/png' }],
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string; message: string } }
    expect(body.error.code).toBe('images_not_supported_cloud')
    expect(typeof body.error.message).toBe('string')
  })

  it('a text-only send is NOT rejected by the image cut (proceeds to the bridge)', async () => {
    const res = await fetch(apiUrl('/api/v1/sessions/cloud-sid-0002/messages'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text: 'text only, no images' }),
    })
    // No bridge is registered in the test → cloudSend 404s (unknown session in
    // the projection) or 503s (no bridge). The point: it is NOT the image 400.
    expect(res.status).not.toBe(400)
    if (res.status !== 202) {
      const body = await res.json() as { error: { code: string } }
      expect(body.error.code).not.toBe('images_not_supported_cloud')
    }
  })
})
