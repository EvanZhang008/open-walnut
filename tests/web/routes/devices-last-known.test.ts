/**
 * GET /api/devices keeps showing what it last knew (src/core/devices/last-known.ts):
 * a cloud list read that fails answers the companion's last good list with the
 * reason and its time, a restart reads it back from disk, a phone removed there
 * leaves it, and a Tailscale probe still cold after a restart answers the last
 * probe's summary, marked stale. The user, 2026-11-04: "cache should cache for
 * long time until the real data come."
 *
 * A real startServer and a fake companion on loopback; the Tailscale summary is faked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { isolateFromRealSsh, type SshIsolation } from '../../helpers/isolate-ssh.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-last-known'))

const cloud = vi.hoisted(() => ({ origin: '', token: 'mac-cloud-token' }))
vi.mock('../../../src/core/pairing-targets.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/pairing-targets.js')>()),
  getCloudPairingEndpoint: () => (cloud.origin ? { origin: cloud.origin, token: cloud.token } : null),
}))
const ts = vi.hoisted(() => ({ summary: null as null | { installed: boolean; running: boolean; dnsName?: string } }))
vi.mock('../../../src/core/tailnet.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/tailnet.js')>()),
  tailscaleSummary: async () => ts.summary,
}))

import { startServer, stopServer } from '../../../src/web/server.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDevicesLastKnownForTesting, flushDevicesLastKnown } from '../../../src/core/devices/last-known.js'

let mode: 'ok' | 'down' | '401' = 'ok'
let phones = ['mac-primary', 'my-phone', 'old-phone']
/** Set to hold the next list GET (its answer as of when it arrived) until `release` runs. */
let holdNext: null | { arrived: () => void } = null
let release: (() => void) | null = null
const created = '2026-09-01T00:00:00.000Z'
const companion = http.createServer((req, res) => {
  if (mode === 'down') { res.writeHead(503).end(); return }
  if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid or revoked token"}'); return }
  if (req.method === 'DELETE') {
    phones = phones.filter((n) => `/api/devices/${n}` !== req.url)
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  const body = JSON.stringify({ devices: phones.map((name) => ({ name, createdAt: created })), caller: 'mac-primary' })
  const answer = () => res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  if (holdNext) {
    const h = holdNext
    holdNext = null
    release = answer
    h.arrived()
    return
  }
  answer()
})

let server: HttpServer
let port = 0
let companionOrigin = ''
let sshIsolation: SshIsolation | null = null
const cacheFile = () => path.join(WALNUT_HOME, 'cache', 'devices-last-known.json')

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
})

type Listed = {
  cloudDevices: Array<{ name: string; role: string }>
  cloudError?: string; cloudStale?: boolean; cloudDevicesAt?: string
  tailscale?: { installed: boolean; running: boolean; dnsName?: string }; tailscaleStale?: boolean; tailscaleAt?: string
}
const list = async (): Promise<Listed> => {
  const r = await fetch(`http://localhost:${port}/api/devices`)
  expect(r.status).toBe(200)
  return await r.json() as Listed
}
/** As a server restart does: the in-memory copy is gone, only the file is left. */
const restart = async () => { await flushDevicesLastKnown(); _resetDevicesLastKnownForTesting() }

describe('GET /api/devices keeps what it last knew', () => {
  it('a good read is plain; a failed one answers the last list with the reason and when it was read', async () => {
    const good = await list()
    expect(good.cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone', 'old-phone'])
    expect(good.cloudStale).toBeUndefined()
    expect(good.cloudDevicesAt).toBeUndefined()

    mode = 'down'
    const kept = await list()
    expect(kept.cloudDevices).toEqual([
      expect.objectContaining({ name: 'mac-primary', role: 'self' }),
      expect.objectContaining({ name: 'my-phone', role: 'phone' }),
      expect.objectContaining({ name: 'old-phone', role: 'phone' }),
    ])
    expect(kept.cloudError).toBe("The cloud companion could not answer just now, so the phones paired there can't be listed.")
    expect(kept.cloudStale).toBe(true)
    expect(Date.now() - Date.parse(kept.cloudDevicesAt!)).toBeLessThan(60_000)

    // A 401 keeps it too (the reason says the token is refused).
    mode = '401'
    expect((await list()).cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone', 'old-phone'])
  })

  it('after a restart the list is read back from disk', async () => {
    await restart()
    expect(fs.existsSync(cacheFile())).toBe(true)
    mode = 'down'
    const kept = await list()
    expect(kept.cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone', 'old-phone'])
    expect(kept.cloudStale).toBe(true)
  })

  it('a phone removed on the companion is gone from the kept list too', async () => {
    const r = await fetch(`http://localhost:${port}/api/devices/old-phone?target=cloud`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    await restart()
    mode = 'down'
    expect((await list()).cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone'])
  })

  it('a read that began before a removal and ends after it does not put the removed phone back', async () => {
    phones = ['mac-primary', 'my-phone', 'race-phone']
    await list()
    const arrived = new Promise<void>((r) => { holdNext = { arrived: r } })
    const slow = list()
    await arrived
    const r = await fetch(`http://localhost:${port}/api/devices/race-phone?target=cloud`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    release!()
    // That read still answers what the companion said when it was asked.
    expect((await slow).cloudDevices.map((d) => d.name)).toContain('race-phone')
    await restart()
    mode = 'down'
    expect((await list()).cloudDevices.map((d) => d.name)).toEqual(['mac-primary', 'my-phone'])
  })

  it('another companion never answers this one\'s list', async () => {
    cloud.origin = 'http://127.0.0.1:1'
    const body = await list()
    expect(body.cloudDevices).toEqual([])
    expect(body.cloudError).toMatch(/^Could not reach the cloud companion/)
    expect(body.cloudStale).toBeUndefined()
  })

  it('a cold Tailscale probe answers the last summary, marked with its time, until a fresh one lands', async () => {
    ts.summary = null
    _resetDevicesLastKnownForTesting({ file: path.join(WALNUT_HOME, 'cache', 'devices-last-known-ts.json') })
    expect((await list()).tailscale).toBeUndefined()

    ts.summary = { installed: true, running: true, dnsName: 'studio.tail0000.ts.net' }
    const fresh = await list()
    expect(fresh.tailscale).toEqual(ts.summary)
    expect(fresh.tailscaleStale).toBeUndefined()

    await restart()
    ts.summary = null
    const kept = await list()
    expect(kept.tailscale).toEqual({ installed: true, running: true, dnsName: 'studio.tail0000.ts.net' })
    expect(kept.tailscaleStale).toBe(true)
    expect(typeof kept.tailscaleAt).toBe('string')

    ts.summary = { installed: true, running: false }
    const again = await list()
    expect(again.tailscale).toEqual({ installed: true, running: false })
    expect(again.tailscaleStale).toBeUndefined()
    _resetDevicesLastKnownForTesting({ file: null })
  })
})
