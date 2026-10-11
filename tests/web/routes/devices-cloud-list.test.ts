/**
 * The Mac's GET /api/devices, cloud half: which cloud row is THIS Mac, and what
 * the console hears when the companion's list cannot load.
 *
 * The 2026-10-01 gate saw the Mac's own cloud record listed as a phone (Show QR,
 * Remove): the Mac looked its cloud token up in its LOCAL auth.json, which never
 * holds that record. One Remove click unpaired the Mac, and the list then said
 * "No phones paired yet." because the companion's 401 read as an empty list.
 * Now the companion names the record the token matched (`caller`), and a list
 * that cannot load comes back with `cloudError`.
 *
 * A real startServer (not cloud mode) and a fake companion on loopback; only
 * the cloud endpoint (the git remote's credentials) is pointed at the fake.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-cloud-list'))

const cloud = vi.hoisted(() => ({ origin: '', token: 'mac-cloud-token' }))
vi.mock('../../../src/core/pairing-targets.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/pairing-targets.js')>()),
  getCloudPairingEndpoint: () => (cloud.origin ? { origin: cloud.origin, token: cloud.token } : null),
}))

import { startServer, stopServer } from '../../../src/web/server.js'

type Mode = 'ok' | 'old' | '401' | '500'
let mode: Mode = 'ok'
const seen: string[] = []
const created = '2026-09-01T00:00:00.000Z'
const companion = http.createServer((req, res) => {
  seen.push(`${req.method} ${req.url} ${String(req.headers.authorization)}`)
  if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid or revoked token"}'); return }
  if (mode === '500') { res.writeHead(500).end(); return }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    devices: [
      { name: 'mac-primary', createdAt: created },
      { name: 'my-phone', createdAt: created, info: { model: 'iPhone17,1', os: 'iOS 26.1' } },
      { name: 'bridge-local', createdAt: created, kind: 'machine' },
    ],
    ...(mode === 'ok' ? { caller: 'mac-primary' } : {}),
    targets: [],
  }))
})

let server: HttpServer
let port = 0
let companionOrigin = ''

// A server under test sweeps the hosts in ~/.ssh/config over ssh: never the real ones.
let sshIsolation: SshIsolation | null = null

beforeAll(async () => {
  sshIsolation = isolateFromRealSsh()
  await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
  companionOrigin = `http://127.0.0.1:${(companion.address() as AddressInfo).port}`
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(async () => {
  await stopServer()
  await new Promise<void>((r) => companion.close(() => r()))
  sshIsolation?.restore()
})

beforeEach(() => {
  cloud.origin = companionOrigin
  mode = 'ok'
  seen.length = 0
})

type Listed = { devices: unknown[]; cloudDevices: Array<{ name: string; role: string }>; cloudError?: string }
const list = async (): Promise<Listed> => {
  const r = await fetch(`http://localhost:${port}/api/devices`)
  expect(r.status).toBe(200)
  return await r.json() as Listed
}

describe('the cloud half of the Mac\'s device list', () => {
  it('marks the record this Mac\'s token matched as self, by the companion\'s word, and asks with that token', async () => {
    const body = await list()
    expect(body.cloudDevices).toEqual([
      expect.objectContaining({ name: 'mac-primary', role: 'self' }),
      expect.objectContaining({ name: 'my-phone', role: 'phone' }),
    ])
    expect(body.cloudError).toBeUndefined()
    expect(seen).toEqual(['GET /api/devices Bearer mac-cloud-token'])
  })

  it('an older companion that does not say which record is the caller marks none as self', async () => {
    mode = 'old'
    expect((await list()).cloudDevices.map((d) => d.role)).toEqual(['phone', 'phone'])
  })

  it('a 401 says the companion no longer accepts this Mac\'s token, instead of an empty list', async () => {
    mode = '401'
    const body = await list()
    expect(body.cloudDevices).toEqual([])
    expect(body.cloudError).toBe("The cloud companion no longer accepts this Mac's token, so the phones paired there can't be listed (this Mac may have been unpaired there).")
    // A 401 this Mac did not cause (no removal of its own just before) is not
    // taken for "unpaired": the next list asks the companion again.
    mode = 'ok'
    expect((await list()).cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone'])
    expect(seen).toHaveLength(2)
  })

  it('any other failed answer says so too', async () => {
    mode = '500'
    expect((await list()).cloudError).toBe("The cloud companion could not answer just now, so the phones paired there can't be listed.")
  })

  it('an unreachable companion says it could not be reached', async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    cloud.origin = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
    await new Promise<void>((r) => closed.close(() => r()))
    const body = await list()
    expect(body.cloudDevices).toEqual([])
    expect(body.cloudError).toMatch(/^Could not reach the cloud companion \(.+\), so the phones paired there can't be listed\.$/)
  })

  it('no companion configured: no cloud half and nothing to report', async () => {
    cloud.origin = ''
    const body = await list()
    expect(body.cloudDevices).toEqual([])
    expect('cloudError' in body).toBe(false)
    expect(seen).toEqual([])
  })
})
