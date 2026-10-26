/**
 * Where the tunnel runs, on a real server (src/core/expose/placement.ts): a
 * provider that names always-on hosts puts this Walnut's tunnel on the server
 * kept on such a host, and none runs here; picking This computer runs it here
 * and lets the host go; a host that would take the same address is held back.
 *
 * Real server, real child process for the tunnel here (a fake CLI that prints
 * its address), registered the way a plugin registers. The host is named in
 * config.yaml and never connects (a made-up hostname), so its server waits for
 * it: the host's half (a host server running the tunnel it is given) is
 * tests/core/host-server-*.test.ts and tests/host-server/.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'
import { registerExposeProvider } from '../../src/core/expose/registry.js'
import { getHostServerManager } from '../../src/core/host-server/index.js'

let server: HttpServer
let port: number
let pidFile: string
let registration: { dispose(): void }

const FAKE_TUNNEL = `
const fs = require('node:fs')
fs.writeFileSync(process.argv[3], String(process.pid))
console.log('Public: https://someone-' + process.argv[2] + '.acme-tunnel.example')
setTimeout(() => console.log('Connected!'), 200)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

async function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}
const put = (body: unknown) => api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const putHost = (key: string, body: unknown) => api(`/api/host-servers/${key}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const expose = async () => (await (await api('/api/expose')).json()) as Record<string, any>
const hostEntry = async (key: string) => ((await (await api('/api/host-servers')).json()).hosts as Array<Record<string, any>>).find((h) => h.hostKey === key)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function tunnelPid(): Promise<number | null> {
  const raw = await fs.readFile(pidFile, 'utf8').catch(() => '')
  return raw ? Number(raw) : null
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const fakeTunnel = path.join(WALNUT_HOME, 'fake-tunnel.cjs')
  pidFile = path.join(WALNUT_HOME, 'fake-tunnel.pid')
  await fs.writeFile(fakeTunnel, FAKE_TUNNEL)
  await updateConfig({
    hosts: {
      // Its server already on: the tunnel follows the provider only to a host that runs Walnut.
      devbox: { label: 'Dev box', hostname: 'always-on-devbox.invalid', user: 'someone', server: { enabled: true } },
      // An always-on host with no server: offered, never picked by itself.
      spare: { label: 'Spare box', hostname: 'always-on-spare.invalid', user: 'someone' },
      laptop: { hostname: 'laptop.invalid', user: 'someone' },
    } as never,
  })
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  // The host servers' manager exists from boot on a real Mac: the primary links its own
  // daemon with no session needed (284df511e), and that connect sets the manager up. The
  // boot does not wait for that link, so set it up here, before the provider arrives, in
  // the same order every run.
  getHostServerManager()
  registration = registerExposeProvider('acme-plugin', {
    id: 'acme-tunnel',
    title: 'Acme Tunnel',
    command: process.execPath,
    args: [fakeTunnel, '{name}', pidFile],
    options: [{ key: 'name', label: 'Tunnel name', default: 'walnut', pattern: '[a-z0-9-]{1,40}' }],
    urlPattern: 'https://[a-z0-9.-]+\\.acme-tunnel\\.example',
    readyPattern: 'connected!',
    probe: false,
    alwaysOnHostPattern: '^always-on-',
  })
}, 60_000)

afterAll(async () => {
  registration?.dispose()
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the tunnel on an always-on host by default', () => {
  it('lists where it can run, and says it would run on the always-on host', async () => {
    // Its server is on and the host never connects: the provider's arrival made the manager look, and it waits for it.
    const devbox = await waitFor(async () => { const h = await hostEntry('devbox'); return h?.view?.phase === 'waiting-for-host' ? h : null })
    expect(devbox.settings).toMatchObject({ enabled: true })
    expect(devbox.settings.carriesTunnel).toBeUndefined()
    expect((await hostEntry('spare'))?.view.phase).toBe('off')
    const body = await expose()
    expect(body.places).toEqual([
      { id: 'devbox', label: 'Dev box', alwaysOn: true },
      { id: 'spare', label: 'Spare box', alwaysOn: true },
      { id: 'here', label: 'This computer', alwaysOn: false },
    ])
    expect(body.settings).toMatchObject({ enabled: false, runOn: null, placedOn: 'devbox' })
    expect(body.status).toMatchObject({ enabled: false, state: 'off' })
  })

  it('turned on, it runs on the host: none here, the host\'s server is on and carries it', async () => {
    expect((await put({ enabled: true, provider: 'acme-tunnel' })).status).toBe(200)
    const status = (await expose()).status
    expect(status).toMatchObject({ enabled: true, provider: 'acme-tunnel', state: 'starting', runsOn: { hostKey: 'devbox', label: 'Dev box', auto: true } })
    expect(status.lastError).toMatch(/Dev box/)
    // Nothing ran here.
    await new Promise((r) => setTimeout(r, 500))
    expect(await tunnelPid()).toBeNull()
    // The host's server is set up when the host connects (it never does here).
    const host = await waitFor(async () => { const h = await hostEntry('devbox'); return h?.view?.phase === 'waiting-for-host' ? h : null })
    expect(host.settings).toMatchObject({ enabled: true, carriesTunnel: true })
    expect((await expose()).status.lastError).toBe('Waiting to connect to Dev box.')
    expect((await hostEntry('laptop'))?.settings.enabled).toBe(false)
    expect((await hostEntry('spare'))?.settings.enabled).toBe(false)
    // The sign-in code lists no address of this computer: its tunnel is the host's.
    const code = await (await api('/api/devices/browser-code', { method: 'POST' })).json()
    expect(code.addresses.filter((a: { where: string }) => a.where === 'this-computer')).toEqual([])
  })

  it('picking This computer runs it here and lets the host go', async () => {
    expect((await put({ run_on: 'here' })).status).toBe(200)
    const status = await waitFor(async () => { const s = (await expose()).status; return s.state === 'connected' ? s : null })
    expect(status.url).toBe('https://someone-walnut.acme-tunnel.example')
    expect(status.runsOn).toBeUndefined()
    const pid = await waitFor(tunnelPid)
    expect(alive(pid)).toBe(true)
    expect((await expose()).settings).toMatchObject({ runOn: 'here', placedOn: 'here' })
    expect((await getConfig()).expose?.run_on).toBe('here')
    // Its own server stays as it was set (on); it no longer carries the tunnel.
    const host = await waitFor(async () => { const h = await hostEntry('devbox'); return h && !h.settings.carriesTunnel ? h : null })
    expect(host.settings.enabled).toBe(true)
    const code = await (await api('/api/devices/browser-code', { method: 'POST' })).json()
    expect(code.addresses.map((a: { where: string }) => a.where)).toEqual(['this-computer'])
  })

  it('picking the host again stops the one here', async () => {
    const pid = (await tunnelPid())!
    await fs.rm(pidFile, { force: true })
    expect((await put({ run_on: 'devbox' })).status).toBe(200)
    await waitFor(async () => !alive(pid))
    expect((await expose()).status).toMatchObject({ state: 'starting', runsOn: { hostKey: 'devbox', auto: false } })
    expect(await tunnelPid()).toBeNull()
  })

  it('refuses a place that is not here or a host', async () => {
    for (const bad of ['nowhere', 7, '']) {
      const res = await put({ run_on: bad })
      expect(res.status, String(bad)).toBe(400)
    }
    expect((await getConfig()).expose?.run_on).toBe('devbox')
  })

  it('null follows the provider again; a host whose server was turned off by hand is passed over', async () => {
    expect((await put({ run_on: null })).status).toBe(200)
    expect((await getConfig()).expose?.run_on).toBeUndefined()
    expect((await expose()).status.runsOn).toMatchObject({ hostKey: 'devbox', auto: true })
    // Its server turned off in Settings (Walnut on a host): the runtime follows the hosts.
    expect((await putHost('devbox', { enabled: false })).status).toBe(200)
    const status = await waitFor(async () => { const s = (await expose()).status; return s.state === 'connected' && !s.runsOn ? s : null })
    expect(status.url).toBe('https://someone-walnut.acme-tunnel.example')
    expect((await expose()).settings.placedOn).toBe('here')
  })

  it('a host\'s own tunnel that would take this computer\'s address is held back, with the reason', async () => {
    expect((await putHost('devbox', { enabled: true, expose: { enabled: true, provider: 'acme-tunnel', options: {} } })).status).toBe(200)
    expect((await put({ run_on: 'here' })).status).toBe(200)
    const host = await hostEntry('devbox')
    // Shown as set (its switch on), with why it does not run.
    expect(host?.settings.expose).toMatchObject({ enabled: true, blocked: expect.stringMatching(/same address/) })
    // Another name is its own address.
    expect((await putHost('devbox', { expose: { options: { name: 'devbox' } } })).status).toBe(200)
    expect((await hostEntry('devbox'))?.settings.expose).toMatchObject({ enabled: true, options: { name: 'devbox' } })
    expect((await hostEntry('devbox'))?.settings.expose.blocked).toBeUndefined()
  })
})
