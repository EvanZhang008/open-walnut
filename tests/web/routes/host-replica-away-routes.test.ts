/**
 * A host replica answers a few console routes itself while the Mac is away
 * (its front forwards them while the Mac answers). Those answers must be a
 * replica's, never the Mac's branch run on the host:
 *
 *   GET /api/devices             no pairing targets of the host, no Tailscale
 *                                probe of the host kept as the Mac's, no
 *                                "this Mac" owner rights for a host-local caller
 *   GET /api/devices/tailscale   404, as on the companion (no "this Mac" card)
 *   GET /api/notifications       the Mac's feed from the copy the host keeps,
 *                                not the host's own store alone
 *
 * The routers are mounted on a bare express app; the role is the env a host
 * replica runs with (WALNUT_ROLE=replica). Faked: the Tailscale probe, the
 * pairing target lookup and the notifications copy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-replica-away-routes'))

const fakes = vi.hoisted(() => ({
  tailscaleSummary: vi.fn(async () => ({ installed: true, running: true, dnsName: 'build-box.tail.ts.net' })),
  tailscaleDetail: vi.fn(async () => ({ installed: true, running: true, peers: [] })),
  getPairingTargets: vi.fn(async () => [{ kind: 'lan', origin: 'http://10.0.0.5:3456', label: 'LAN' }]),
  copy: null as null | { feed: unknown[]; asOf: number },
}))

vi.mock('../../../src/core/tailnet.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/tailnet.js')>()),
  tailscaleSummary: fakes.tailscaleSummary,
  tailscaleDetail: fakes.tailscaleDetail,
}))
vi.mock('../../../src/core/pairing-targets.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/pairing-targets.js')>()),
  getPairingTargets: fakes.getPairingTargets,
}))
vi.mock('../../../src/core/replication/kinds/notifications.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/replication/kinds/notifications.js')>()),
  readNotificationsCopy: async () => fakes.copy,
}))

import { devicesRouter, actorOf } from '../../../src/web/routes/devices.js'
import { devicesTailscaleRouter } from '../../../src/web/routes/devices-tailscale.js'
import { notificationsRouter } from '../../../src/web/routes/notifications.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import { LOCAL_ACTOR } from '../../../src/core/device-actor.js'

let server: HttpServer
let base = ''

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.get('/who', (req, res) => { res.json({ local: actorOf(req) === LOCAL_ACTOR }) })
  app.use('/api/devices/tailscale', devicesTailscaleRouter)
  app.use('/api/devices', devicesRouter)
  app.use('/api/notifications', notificationsRouter)
  server = await new Promise<HttpServer>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const savedRole = process.env.WALNUT_ROLE
beforeEach(() => {
  process.env.WALNUT_ROLE = 'replica'
  _resetServerRoleForTesting()
  fakes.tailscaleSummary.mockClear()
  fakes.tailscaleDetail.mockClear()
  fakes.getPairingTargets.mockClear()
  fakes.copy = null
})
afterEach(() => {
  if (savedRole === undefined) delete process.env.WALNUT_ROLE
  else process.env.WALNUT_ROLE = savedRole
  _resetServerRoleForTesting()
})

describe('a host replica away from the Mac', () => {
  it('GET /api/devices offers no host address to pair with and never probes the host\'s Tailscale', async () => {
    const res = await fetch(`${base}/api/devices`)
    expect(res.status).toBe(200)
    const body = await res.json() as { targets: unknown[]; tailscale?: unknown; caller?: unknown }
    expect(body.targets).toEqual([])
    expect(body.tailscale).toBeUndefined()
    expect(body.caller).toBeUndefined()
    expect(fakes.getPairingTargets).not.toHaveBeenCalled()
    expect(fakes.tailscaleSummary).not.toHaveBeenCalled()
  })

  it('a host-local caller is not this Mac', async () => {
    expect(await (await fetch(`${base}/who`)).json()).toEqual({ local: false })
  })

  it('GET /api/devices/tailscale is 404, not the host\'s tailnet shown as this Mac', async () => {
    const res = await fetch(`${base}/api/devices/tailscale`)
    expect(res.status).toBe(404)
    expect(fakes.tailscaleDetail).not.toHaveBeenCalled()
  })

  it('GET /api/notifications answers the Mac\'s feed from the copy, marked offline', async () => {
    fakes.copy = {
      asOf: Date.now(),
      feed: [{ id: 'n-1', dedupKey: 'mac-card', title: 'From the Mac', timestamp: Date.now() - 1000, read: false, severity: 'info' }],
    }
    const res = await fetch(`${base}/api/notifications`)
    expect(res.status).toBe(200)
    const body = await res.json() as { feed: Array<{ dedupKey: string }>; unreadCount: number; offline?: boolean }
    expect(body.feed.map((n) => n.dedupKey)).toEqual(['mac-card'])
    expect(body.unreadCount).toBe(1)
    expect(body.offline).toBe(true)
  })
})

describe('the Mac (leader) is unchanged', () => {
  beforeEach(() => {
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
  })

  it('GET /api/devices still lists its own pairing targets and probes Tailscale', async () => {
    const body = await (await fetch(`${base}/api/devices`)).json() as { targets: Array<{ kind: string }>; tailscale?: unknown }
    expect(body.targets.map((t) => t.kind)).toEqual(['lan'])
    expect(body.tailscale).toBeTruthy()
    expect(fakes.tailscaleSummary).toHaveBeenCalled()
  })

  it('a loopback caller is this Mac', async () => {
    expect(await (await fetch(`${base}/who`)).json()).toEqual({ local: true })
  })

  it('GET /api/notifications reads its own store, never the copy', async () => {
    fakes.copy = { asOf: Date.now(), feed: [{ id: 'n-1', dedupKey: 'mac-card', title: 'x', timestamp: 1, read: false }] }
    const body = await (await fetch(`${base}/api/notifications`)).json() as { feed: unknown[]; offline?: boolean }
    expect(body.feed).toEqual([])
    expect(body.offline).toBeUndefined()
  })
})
