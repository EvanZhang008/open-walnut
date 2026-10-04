/**
 * /api/devices/tailscale (the console's "Reach Walnut from anywhere" card)
 * through the real server and auth middleware: startServer({ port: 0 }) with
 * an isolated temp home.
 *
 * Faked: the interface list, the Tailscale CLI spawn (the JSON is the shape
 * `tailscale status --json` prints), and the install job's spawn / brew lookup /
 * `open` / platform (src/core/tailscale-install.ts seams). Nothing installs or
 * opens anything for real.
 *
 * Not covered here: the 404 on a cloud replica (CLOUD_MODE is a module constant
 * this file mocks off; the router's first middleware is the whole rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-devices-tailscale'))
vi.mock('../../../src/core/process-group-kill.js', () => ({
  safeKillProcessGroup: vi.fn(() => true),
  isSafeGroupPid: (pid: unknown) => typeof pid === 'number' && pid > 1,
}))

import { startServer, stopServer } from '../../../src/web/server.js'
import { _setTailscaleProbeForTesting } from '../../../src/core/tailnet.js'
import { _setTailscaleInstallForTesting, type InstallChild } from '../../../src/core/tailscale-install.js'
import { createDevice } from '../../../src/core/device-auth.js'

let server: HttpServer
let port = 0

const CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
type Ifaces = ReturnType<typeof os.networkInterfaces>
const WIFI = { en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.1.20/24' }] }
const TAILNET = { utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '255.192.0.0', mac: '00:00:00:00:00:00', cidr: '100.101.102.103/10' }] }

/** `tailscale status --json` on a connected Mac with three peers (trimmed). */
function runningJson(): string {
  return JSON.stringify({
    Version: '1.102.4', BackendState: 'Running', AuthURL: '',
    Self: { HostName: 'studio-mac', DNSName: 'studio-mac.tail1234.ts.net.', OS: 'macOS', TailscaleIPs: ['100.101.102.103'], Online: true },
    Peer: {
      'nodekey:aa': { HostName: 'build-box', DNSName: 'build-box.tail1234.ts.net.', OS: 'linux', Online: true, TailscaleIPs: ['100.70.0.2'] },
      // A real iPhone (Tailscale 1.9x, 2026-10-03): HostName is the literal "localhost",
      // the machine name is only in DNSName.
      'nodekey:bb': { HostName: 'localhost', DNSName: 'pocket-phone.tail1234.ts.net.', OS: 'iOS', Online: true, TailscaleIPs: ['100.70.0.3'] },
      'nodekey:cc': { HostName: 'old-tablet', DNSName: 'old-tablet.tail1234.ts.net.', OS: 'android', Online: false, TailscaleIPs: ['100.70.0.4'] },
    },
  })
}

let execCalls = 0
function fakeCli(stdout: () => string, { locate = async () => CLI as string | null, delayMs = 0 } = {}) {
  execCalls = 0
  _setTailscaleProbeForTesting({
    locate,
    exec: async () => {
      execCalls += 1
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      return { stdout: stdout(), stderr: '' }
    },
  })
}

class FakeChild extends EventEmitter implements InstallChild {
  pid = 515151
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
}
let children: FakeChild[] = []
let opened = 0
let brew: string | null = '/opt/homebrew/bin/brew'
let platform: NodeJS.Platform = 'darwin'

function installSeams() {
  _setTailscaleInstallForTesting({
    spawn: () => {
      const c = new FakeChild()
      children.push(c)
      return c
    },
    locateBrew: async () => brew,
    openApp: async () => { opened += 1 },
    platform,
    // isInstalled stays the real one: it reads the faked CLI through tailnet.ts.
  })
}

async function get(p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`)
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function post(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' })
  return { status: r.status, body: await r.json().catch(() => null) }
}

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as AddressInfo).port
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  _setTailscaleProbeForTesting(null)
  _setTailscaleInstallForTesting(null)
  await stopServer()
})

beforeEach(() => {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(WIFI as unknown as Ifaces)
  children = []
  opened = 0
  brew = '/opt/homebrew/bin/brew'
  platform = 'darwin'
  installSeams()
  fakeCli(() => '', { locate: async () => null })
})

describe('GET /api/devices/tailscale', () => {
  it('not installed: nothing running, no address, no peers, Homebrew offered', async () => {
    const r = await get('/api/devices/tailscale')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ installed: false, running: false, peers: [], install: { brew: true, macOS: true, job: null } })
    expect(execCalls).toBe(0)
  })

  it('running: the MagicDNS name, the tailnet address, peers with only hostName/os/online (online phones first, named by their machine name)', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ ...WIFI, ...TAILNET } as unknown as Ifaces)
    fakeCli(runningJson)
    const r = await get('/api/devices/tailscale')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      installed: true,
      running: true,
      dnsName: 'studio-mac.tail1234.ts.net',
      address: '100.101.102.103',
      peers: [
        { hostName: 'pocket-phone', os: 'iOS', online: true },
        { hostName: 'build-box', os: 'linux', online: true },
        { hostName: 'old-tablet', os: 'android', online: false },
      ],
      install: { brew: true, macOS: true, job: null },
    })
    // A phone's routes carry the same summary, so it can say which side still needs Tailscale.
    const routes = await get('/api/v1/routes')
    expect(routes.body.tailscale).toEqual({ installed: true, running: true, dnsName: 'studio-mac.tail1234.ts.net' })
  })

  it('NeedsLogin: the sign-in link when the CLI printed an https one, never anything else; a busy tailnet is cut at 50', async () => {
    const peers = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`nodekey:${i}`, { HostName: `node-${String(i).padStart(2, '0')}`, OS: 'linux', Online: false }]))
    peers['nodekey:phone'] = { HostName: 'late-phone', OS: 'iOS', Online: true }
    let authUrl = 'https://login.tailscale.com/a/1a2b3c4d'
    fakeCli(() => JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: authUrl, Self: { HostName: 'studio-mac' }, Peer: peers }))
    const r = await get('/api/devices/tailscale')
    expect(r.body).toMatchObject({ installed: true, running: false, loginUrl: 'https://login.tailscale.com/a/1a2b3c4d' })
    expect(r.body.peers).toHaveLength(50)
    expect(r.body.peers[0]).toEqual({ hostName: 'late-phone', os: 'iOS', online: true })
    expect(Object.keys(r.body.peers[1]).sort()).toEqual(['hostName', 'online', 'os'])

    authUrl = 'javascript:alert(1)'
    fakeCli(() => JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: authUrl, Self: {} }))
    expect((await get('/api/devices/tailscale')).body).not.toHaveProperty('loginUrl')
    // Running: no sign-in link even if one was printed.
    fakeCli(() => JSON.stringify({ BackendState: 'Running', AuthURL: 'https://login.tailscale.com/a/x', Self: {} }))
    expect((await get('/api/devices/tailscale')).body).not.toHaveProperty('loginUrl')
  })

  it('the CLI\'s answer beats the interface scan: another VPN\'s 100.x (Cloudflare WARP) never reads as connected', async () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ ...WIFI, utun5: [{ ...TAILNET.utun3[0], address: '100.96.0.12' }] } as unknown as Ifaces)
    fakeCli(() => JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/feed', Self: {} }))
    const r = await get('/api/devices/tailscale')
    expect(r.body).toEqual({
      installed: true, running: false, loginUrl: 'https://login.tailscale.com/a/feed', peers: [], install: { brew: true, macOS: true, job: null },
    })
    expect((await get('/api/v1/routes')).body.tailscale).toEqual({ installed: true, running: false })
    // No Tailscale CLI at all: the 100.x is the only evidence, so it counts (Headscale, Netbird).
    fakeCli(() => '', { locate: async () => null })
    expect((await get('/api/devices/tailscale')).body).toMatchObject({ installed: false, running: true, address: '100.96.0.12' })
  })

  it('refresh=1 asks the CLI again, but at most every 3s, and concurrent callers share one probe', async () => {
    fakeCli(runningJson, { delayMs: 50 })
    await Promise.all([1, 2, 3].map(() => get('/api/devices/tailscale?refresh=1')))
    expect(execCalls).toBe(1)
    await get('/api/devices/tailscale?refresh=1')
    await get('/api/devices/tailscale')
    expect(execCalls).toBe(1) // inside the 3s floor, and inside the 60s cache
    await new Promise((r) => setTimeout(r, 3_100))
    await get('/api/devices/tailscale')
    expect(execCalls).toBe(1) // a plain read still takes the 60s cache
    await Promise.all([get('/api/devices/tailscale?refresh=1'), get('/api/devices/tailscale?refresh=1')])
    expect(execCalls).toBe(2)
  }, 15_000)
})

describe('POST /api/devices/tailscale/install', () => {
  it('400 without Homebrew, nothing spawned', async () => {
    brew = null
    installSeams()
    const r = await post('/api/devices/tailscale/install')
    expect(r).toEqual({ status: 400, body: { error: 'Homebrew is not installed on this Mac; get Tailscale from the App Store instead.' } })
    expect(children).toHaveLength(0)
    expect((await get('/api/devices/tailscale')).body.install).toEqual({ brew: false, macOS: true, job: null })
  })

  it('400 when Tailscale is already installed', async () => {
    fakeCli(() => JSON.stringify({ BackendState: 'Stopped', Self: {} }))
    const r = await post('/api/devices/tailscale/install')
    expect(r).toEqual({ status: 400, body: { error: 'Tailscale is already installed on this Mac.' } })
    expect(children).toHaveLength(0)
  })

  it('202 with the running job, 409 for a second one, then done: the status says installed and the app opened once', async () => {
    let cli: string | null = null
    fakeCli(() => JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), { locate: async () => cli })
    const r = await post('/api/devices/tailscale/install')
    expect(r.status).toBe(202)
    expect(r.body).toEqual({ job: { state: 'running', startedAt: expect.any(String), log: [] } })
    expect((await post('/api/devices/tailscale/install'))).toEqual({ status: 409, body: { error: 'Tailscale is already being installed.' } })
    expect(children).toHaveLength(1)

    const child = children[0]
    child.stdout.write('==> Downloading Tailscale\n==> Installing Cask tailscale-app\n')
    await new Promise((r) => setTimeout(r, 20))
    const mid = await get('/api/devices/tailscale')
    expect(mid.body.installed).toBe(false)
    expect(mid.body.install.job).toMatchObject({ state: 'running', log: ['==> Downloading Tailscale', '==> Installing Cask tailscale-app'] })

    cli = CLI
    child.stdout.end()
    child.stderr.end()
    await new Promise((r) => setImmediate(r))
    child.emit('close', 0, null)
    const after = await get('/api/devices/tailscale')
    expect(after.body.installed).toBe(true) // the 60s cache was dropped, not waited out
    expect(after.body.install.job.state).toBe('done')
    expect(opened).toBe(1)
  })
})

describe('a paired phone may read, never install or open', () => {
  // X-Forwarded-For marks the request as not from this machine (local-trust.ts), the
  // way a phone's request over the LAN arrives.
  it('403 on both POSTs with a device token, nothing spawned or opened; the GET still answers', async () => {
    const { token } = await createDevice('tailscale-curious-phone')
    const phone = { 'x-forwarded-for': '192.168.1.44', authorization: `Bearer ${token}` }
    const refused = { status: 403, body: { error: 'Only the Walnut console on this machine can install or open Tailscale.' } }
    expect(await post('/api/devices/tailscale/install', phone)).toEqual(refused)
    expect(await post('/api/devices/tailscale/open', phone)).toEqual(refused)
    expect(children).toHaveLength(0)
    expect(opened).toBe(0)
    const r = await fetch(`http://127.0.0.1:${port}/api/devices/tailscale`, { headers: phone })
    expect(r.status).toBe(200)
  })

  it('off macOS the install state says so and offers no Homebrew', async () => {
    platform = 'linux'
    installSeams()
    expect((await get('/api/devices/tailscale')).body.install).toEqual({ brew: false, macOS: false, job: null })
  })
})

describe('POST /api/devices/tailscale/open', () => {
  it('opens the app on macOS', async () => {
    expect(await post('/api/devices/tailscale/open')).toEqual({ status: 200, body: { opened: true } })
    expect(opened).toBe(1)
  })

  it('501 off macOS, with one sentence', async () => {
    platform = 'linux'
    installSeams()
    expect(await post('/api/devices/tailscale/open')).toEqual({
      status: 501,
      body: { error: 'Opening Tailscale from here works only on macOS; on this machine run tailscale up in a terminal.' },
    })
    expect(opened).toBe(0)
  })
})
