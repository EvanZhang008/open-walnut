/**
 * /api/devices console pairing route — real startServer({ port: 0 }) with an
 * isolated temp OPEN_WALNUT_HOME. Covers: create (token + wn://pair URI shown
 * once), list (no secrets), revoke, duplicate/invalid names.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-test'))

import { startServer, stopServer } from '../../../src/web/server.js'

let server: HttpServer
let port: number

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
})

afterAll(async () => {
  await stopServer()
})

describe('GET /api/devices hides plumbing', () => {
  it('never lists daemon bridge credentials as pairable devices', async () => {
    // kind:'machine' is a daemon bridge credential. Listing these beside a
    // "Show QR" button made a 2-phone setup render as 9 rows (2026-07-29) and
    // invited pairing a phone against daemon plumbing.
    const res = await fetch(apiUrl('/api/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bridge-somehost', kind: 'machine' }),
    })
    expect(res.status).toBe(201)

    const list = await fetch(apiUrl('/api/devices'))
    const body = await list.json() as { devices: Array<{ name: string }> }
    expect(body.devices.map((d) => d.name)).not.toContain('bridge-somehost')

    await fetch(apiUrl('/api/devices/bridge-somehost'), { method: 'DELETE' })
  })
})

describe('POST/GET/DELETE /api/devices', () => {
  it('creates a device with a one-time token + pairing URI carrying the server origin', async () => {
    const res = await fetch(apiUrl('/api/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-iphone' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string; token: string; pairingURI: string }
    expect(body.name).toBe('test-iphone')
    expect(body.token).toMatch(/^[0-9a-f]{32}$/)
    expect(body.pairingURI).toContain('wn://pair?name=test-iphone')
    expect(body.pairingURI).toContain(`&token=${body.token}`)
    // The QR must never carry an address only THIS machine can reach.
    // `localhost` would resolve to the phone itself (2026-07-28 regression).
    // On a host with no LAN/cloud address, `server` is omitted entirely so the
    // app prompts — either way, never loopback.
    const server = new URL(body.pairingURI.replace('wn://', 'https://')).searchParams.get('server')
    if (server !== null) {
      expect(new URL(server).hostname).not.toMatch(/^(localhost|127\.0\.0\.1|::1)$/)
    }

    // List shows the device but never the token.
    const list = await fetch(apiUrl('/api/devices'))
    const listBody = await list.json() as { devices: Array<Record<string, unknown>> }
    const mine = listBody.devices.find((d) => d.name === 'test-iphone')!
    expect(mine).toBeDefined()
    expect(JSON.stringify(mine)).not.toContain(body.token)

    // Duplicate name → 400.
    const dup = await fetch(apiUrl('/api/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-iphone' }),
    })
    expect(dup.status).toBe(400)

    // replace:true re-pairs the SAME name with a FRESH token — the "Show QR"
    // path for a phone that lost its pairing (app reinstall wipes the app's
    // stored server URL, and tokens are unrecoverable by design).
    const rePair = await fetch(apiUrl('/api/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-iphone', replace: true }),
    })
    expect(rePair.status).toBe(201)
    const rotated = await rePair.json() as { name: string; token: string }
    expect(rotated.name).toBe('test-iphone')
    expect(rotated.token).not.toBe(body.token) // old credential is dead
    // Still exactly one entry — rotate must not duplicate the device.
    const afterRotate = await fetch(apiUrl('/api/devices'))
    const rotateList = await afterRotate.json() as { devices: Array<{ name: string }> }
    expect(rotateList.devices.filter((d) => d.name === 'test-iphone')).toHaveLength(1)

    // Revoke → gone from the list.
    const del = await fetch(apiUrl('/api/devices/test-iphone'), { method: 'DELETE' })
    expect(del.status).toBe(200)
    const after = await fetch(apiUrl('/api/devices'))
    const afterBody = await after.json() as { devices: Array<{ name: string }> }
    expect(afterBody.devices.map((d) => d.name)).not.toContain('test-iphone')

    // Revoking again → 404; invalid name → 400.
    const again = await fetch(apiUrl('/api/devices/test-iphone'), { method: 'DELETE' })
    expect(again.status).toBe(404)
    const bad = await fetch(apiUrl('/api/devices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad name with spaces!!' }),
    })
    expect(bad.status).toBe(400)
  })
})
