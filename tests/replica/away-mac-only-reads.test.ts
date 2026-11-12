/**
 * Reads only the Mac can answer, on a host replica while the Mac is away
 * (src/replica/route-table.ts): before their rows each ran on the replica and
 * answered 200 with the replica's own facts in the Mac's place (who leads, every
 * host idle, the replica's own ssh key and routes, a session's row text gone,
 * "not registered" for push, the phone's notification feed from its own store,
 * devices and the Tailscale card,
 * an empty plugin runtime). Now each answers 503 needs_leader with a reason the
 * console has words for, through the real dispatcher. While the Mac answers they
 * are forwarded as before (class leader).
 *
 * Also: a replica's diagnostics never run the dtach probe (it may install dtach).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type net from 'node:net'
import { classify } from '../../src/replica/route-table.js'
import { createDispatcher, type DispatchDeps } from '../../src/replica/dispatch.js'
import { NEEDS_LEADER_REASONS } from '../../web/src/api/leader-presence.js'
import { serverDiagnosticsOptions } from '../../src/web/routes/diagnostics.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'

const MAC_ONLY_READS: Array<[path: string, why: string]> = [
  ['/api/leader', 'fleet_needs_mac'],
  ['/api/hosts/status', 'fleet_needs_mac'],
  ['/api/hosts/devbox/ssh-key', 'other_hosts_need_mac'],
  ['/api/v1/routes', 'needs_mac'],
  ['/api/v1/activity/detail', 'needs_mac'],
  ['/api/push/status', 'needs_mac'],
  ['/api/v1/notifications', 'needs_mac'],
  ['/api/devices', 'needs_mac'],
  ['/api/devices/tailscale', 'needs_mac'],
  ['/api/plugin-runtime', 'plugins_need_mac'],
  ['/api/plugin-runtime/acme/web-module', 'plugins_need_mac'],
  ['/api/plugin-runtime/registry', 'plugins_need_mac'],
  ['/api/plugin-updates', 'plugins_need_mac'],
]

describe('the route table', () => {
  it.each(MAC_ONLY_READS)('GET %s needs the Mac while away (%s), forwarded while it answers', (p, why) => {
    const d = classify('GET', p)
    expect(d).toMatchObject({ cls: 'leader', away: 'needs-leader', why })
    expect(NEEDS_LEADER_REASONS[why], why).toBeTruthy()
  })

  it('the plugin runtime and updates writes need the Mac too, with the plugins reason', () => {
    expect(classify('POST', '/api/plugin-runtime/acme/reload')).toMatchObject({ away: 'needs-leader', why: 'plugins_need_mac' })
    expect(classify('POST', '/api/plugin-updates/acme/apply')).toMatchObject({ away: 'needs-leader', why: 'plugins_need_mac' })
  })

  it('the rows leave their neighbours as they were', () => {
    // The status read still runs on the replica (it says REPLICA there), and so does the instance probe.
    expect(classify('GET', '/api/v1/status').away).toBe('read')
    expect(classify('GET', '/api/v1/instance').away).toBe('read')
    // A signed-in browser's cookie is this address's.
    expect(classify('GET', '/api/devices/browser-session')).toMatchObject({ cls: 'local' })
    // A device revoke still journals; a host's own bridge ping keeps the default read.
    expect(classify('DELETE', '/api/devices/Acme%20tablet').away).toBe('host-write')
    expect(classify('GET', '/api/hosts/devbox/status').away).toBe('read')
    expect(classify('GET', '/api/notifications/other').away).toBe('read')
    // The console's feed reads the Mac's notifications copy here (routes/notifications.ts).
    expect(classify('GET', '/api/notifications')).toMatchObject({ away: 'read', row: { pattern: '/api/notifications' } })
  })
})

describe('through the dispatcher, the Mac away', () => {
  const servers: http.Server[] = []
  let port = 0
  beforeAll(async () => {
    const deps: DispatchDeps = {
      route: () => ({ kind: 'alone', why: 'mac-away' }),
      asOf: () => 1_750_000_000_000,
      connect: async () => { throw new Error('the Mac is asleep') },
      suspect: () => {},
      ownUpgrade: (_req, socket) => { socket.end('HTTP/1.1 418 I am the replica\r\n\r\n') },
      log: () => {},
    }
    const dispatcher = createDispatcher(deps)
    // The replica's own app: what these routes answered before (200, its own facts).
    const server = http.createServer((req, res) => dispatcher.middleware(req, res, () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"role":"primary","hosts":[]}')
    }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) })

  function get(p: string): Promise<{ status: number; json: { error?: { code?: string; why?: string } } }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', agent: false, headers: { accept: 'application/json' } }, (res) => {
        let text = ''
        res.on('data', (c) => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it.each(MAC_ONLY_READS)('GET %s answers 503 needs_leader (%s), not the replica\'s own 200', async (p, why) => {
    const r = await get(p)
    expect(r.status).toBe(503)
    expect(r.json.error).toMatchObject({ code: 'needs_leader', why })
  })
})

describe('diagnostics on a replica', () => {
  const saved = process.env.WALNUT_ROLE
  afterEach(() => {
    if (saved === undefined) delete process.env.WALNUT_ROLE
    else process.env.WALNUT_ROLE = saved
    _resetServerRoleForTesting()
  })

  it('a host replica runs no dtach probe; the Mac does', () => {
    process.env.WALNUT_ROLE = 'replica'
    _resetServerRoleForTesting()
    expect(serverDiagnosticsOptions().probes).not.toHaveProperty('dtach')
    delete process.env.WALNUT_ROLE
    _resetServerRoleForTesting()
    expect(serverDiagnosticsOptions().probes).toHaveProperty('dtach')
  })
})
