/**
 * The tunnel handover to a host, on a real server (src/web/expose-runtime.ts,
 * src/core/expose/placement.ts hostHolds), with the host's side running the real
 * host code (src/host-server/expose.ts createHostExpose + followExposeSettings and
 * the supervisor), and both tunnels real child processes in front of a fake tunnel
 * service that behaves like the real ones: a name goes to whoever connected last,
 * and an older connection keeps saying "connected" while it gets nothing.
 *
 *   - placed on a host that is not up yet, the tunnel runs here, the status says
 *     `movingTo` with what the host is doing (installing its CLI);
 *   - the host connects while this computer is away, this computer reconnects (now
 *     the newest), then the handover: the one here stops first, the host connects
 *     again (its supervisor restarts the CLI), then it is recorded; the service
 *     routes the name to the host, and the host's listener answers the probe;
 *   - with the record, a restart here (after a retry bumped the count) starts
 *     nothing here, and the host's tunnel is not restarted;
 *   - other options (another name) clear it and hand the new one over;
 *   - a restart without the record, the host holding it from before: the one here
 *     runs (newest), then the same handover;
 *   - moving back here, or turning it off, clears the record.
 *
 * Real server, the real host-server manager (core/host-server/), and a fake host
 * daemon: it answers what the manager asks and runs the host server's tunnel code in
 * this process (one "server process" per configure from nothing, as its daemon runs
 * one), on a clock an hour behind this one. A local app dir stands in for an install
 * there (WALNUT_HOST_SERVER_APP_DIR). The host's view refreshes when the test
 * reconciles it (the manager's own poll is every 30 s).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import type net from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { registerExposeProvider } from '../../src/core/expose/registry.js'
import { tunnelKey } from '../../src/core/expose/placement.js'
import { answerTunnelProbe, httpProbe } from '../../src/core/expose/probe.js'
import { nodeSpawn } from '../../src/core/expose/supervisor.js'
import type { ExposeProviderDefinition } from '../../src/core/expose/types.js'
import { getHostServerManager, hostServerConnected, _resetHostServerManagerForTesting } from '../../src/core/host-server/index.js'
import type { HostServerHost } from '../../src/core/host-server/manager.js'
import { createHostExpose, followExposeSettings, type HostExpose } from '../../src/host-server/expose.js'
import { getExposeRuntime } from '../../src/web/expose-runtime.js'

let server: HttpServer
let port: number
let pidFile: string
let hostPidFile: string
let fakeTunnel: string
let registration: { dispose(): void } | null = null

/**
 * The tunnel CLI: holds a connection to the service for its name, pointing at the port it
 * was given, prints its address, and on SIGUSR2 reconnects (a laptop that woke up).
 */
const FAKE_TUNNEL = `
const fs = require('node:fs')
const http = require('node:http')
const [name, pidFile, servicePort, target] = process.argv.slice(2)
fs.writeFileSync(pidFile, String(process.pid))
let current = null
function hold() {
  const req = http.get({ host: '127.0.0.1', port: Number(servicePort), path: '/hold?name=' + name + '&target=' + target, agent: false }, (res) => {
    const old = current
    current = req
    if (old) old.destroy()
    console.log('Public: http://127.0.0.1:' + servicePort + '/t/' + name)
    setTimeout(() => console.log('Connected!'), 100)
    res.on('data', () => {})
  })
  req.on('error', () => { if (current === req || current === null) process.exit(1) })
}
hold()
process.on('SIGUSR2', hold)
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

/** The tunnel service: a name goes to its newest connection; when that one closes, nobody gets it. */
const service = {
  server: null as http.Server | null,
  port: 0,
  route: new Map<string, { id: number; target: number }>(),
  log: [] as string[],
  seq: 0,
}

function startService(): Promise<void> {
  service.server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://service')
    if (u.pathname === '/hold') {
      const id = ++service.seq
      const name = u.searchParams.get('name')!
      const target = Number(u.searchParams.get('target'))
      service.route.set(name, { id, target })
      service.log.push(`open ${name} ${who(target)}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('held\n')
      res.on('close', () => {
        service.log.push(`close ${name} ${who(target)}`)
        if (service.route.get(name)?.id === id) service.route.delete(name)
      })
      return
    }
    const m = u.pathname.match(/^\/t\/([a-z0-9-]+)(\/.*)?$/)
    const r = m ? service.route.get(m[1]!) : undefined
    if (!m || !r) { res.writeHead(502); res.end('no connection for this name'); return }
    const fwd = http.request({ host: '127.0.0.1', port: r.target, path: (m[2] || '/') + u.search, method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    fwd.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('the connection failed') })
    req.pipe(fwd)
  })
  return new Promise((r) => service.server!.listen(0, '127.0.0.1', () => { service.port = (service.server!.address() as net.AddressInfo).port; r() }))
}

/** Which machine a target port is. */
function who(target: number): string {
  if (target === hostPublicPort) return 'host'
  if (target === getExposeRuntime()?.openPort()) return 'mac'
  return `port-${target}`
}

const urlOf = (name: string) => `http://127.0.0.1:${service.port}/t/${name}`

function definition(): ExposeProviderDefinition {
  return {
    id: 'acme-tunnel',
    title: 'Acme Tunnel',
    command: process.execPath,
    args: [fakeTunnel, '{name}', pidFile, String(service.port), '{port}'],
    options: [{ key: 'name', label: 'Tunnel name', default: 'acme-demo', pattern: '[a-z0-9-]{1,40}' }],
    urlPattern: 'http://127\\.0\\.0\\.1:\\d+/t/[a-z0-9-]+',
    readyPattern: 'connected!',
    probe: false,
    alwaysOnHostPattern: '^always-on-',
    // Travels to the host with the definition: the server there installs its CLI.
    installCommand: 'echo installing the acme tunnel CLI',
  }
}

/** The host's clock is an hour behind this one: only its own differences may count. */
const HOST_CLOCK = -3_600_000

/** The host: its daemon's spec, and the host server it runs (the real tunnel code). */
const there = {
  spec: null as Record<string, any> | null,
  configures: 0,
  /** The server process the daemon runs (null: none). */
  proc: null as null | { expose: HostExpose; follow: (s: Record<string, unknown>) => void },
  /** The tunnel CLI is on the host (until then a start finds no command and installs it). */
  cliInstalled: false,
  releaseInstall: null as null | (() => void),
}
let hostPublic: http.Server
let hostPublicPort = 0

/** A host server process starts: its tunnel code reads what it kept, then follows the Mac's settings. */
function startHostProcess() {
  const expose = createHostExpose({
    port: hostPublicPort,
    stateFile: path.join(WALNUT_HOME, 'fake-host', 'host-expose.json'),
    log: { info() {}, warn() {} },
    deps: {
      now: () => Date.now() + HOST_CLOCK,
      // The same definition the Mac runs, with the host's own pid file; no CLI until it is installed.
      spawn: (command, args, env) => there.cliInstalled
        ? nodeSpawn(command, args.map((a) => (a === pidFile ? hostPidFile : a)), env)
        : nodeSpawn(path.join(WALNUT_HOME, 'fake-host', 'no-cli-yet'), args, env),
      install: () => new Promise((resolve) => {
        there.releaseInstall = () => { there.cliInstalled = true; resolve({ ok: true, output: 'installed' }) }
      }),
    },
  })
  there.proc = { expose, follow: followExposeSettings(expose, () => {}) }
}

async function stopHostProcess() {
  const proc = there.proc
  there.proc = null
  await proc?.expose.stop()
}

const host: HostServerHost = {
  hostKey: 'devbox',
  connected: true,
  hasCapability: (cap) => ['host-server-v1', 'follower-v1', 'stream-relay-v1'].includes(cap),
  async send(cmd, params) {
    if (cmd === 'host.preflight') return { ok: true, result: { nodeDir: '/opt/node24/bin' } }
    if (cmd === 'server.configure') {
      there.configures++
      const spec = (params?.spec as Record<string, any> | null) ?? null
      there.spec = spec
      if (!spec) await stopHostProcess()
      else {
        if (!there.proc) startHostProcess()
        there.proc!.follow(spec.settings ?? {})
      }
      return { ok: true, status: { state: spec ? 'running' : 'off', since: 0, restarts: 0, pid: 4242 } }
    }
    if (cmd === 'server.status') {
      if (!there.spec || !there.proc) return { ok: true, status: { state: 'off', since: 0, restarts: 0 } }
      const reportAgeMs = 300
      return {
        ok: true,
        status: {
          state: 'running', since: 0, restarts: 0, pid: 4242,
          report: { route: { kind: 'leader' }, expose: there.proc.expose.status() },
          reportedAt: Date.now() + HOST_CLOCK - reportAgeMs, reportAgeMs,
        },
      }
    }
    return { ok: false, error: 'unknown' }
  },
  async runRemoteScript(script) {
    if (script.includes(' -v 2>&1')) return 'v24.3.0'
    if (script === 'printf %s "$HOME"') return '/home/someone'
    if (script.includes('require("net")')) return script.split(' ').filter((w) => /^\d{5}$/.test(w)).map((p) => `${p}:free`).join('\n')
    throw new Error('unexpected script: ' + script.slice(0, 80))
  },
  async uploadFile() { throw new Error('no upload: the app dir stands in for an install') },
  async openStream() { throw new Error('no stream in this test') },
}

async function api(pathname: string, init?: RequestInit) {
  return fetch(`http://localhost:${port}${pathname}`, init)
}
const put = (body: unknown) => api('/api/expose', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const status = async () => ((await (await api('/api/expose')).json()) as { status: Record<string, any> }).status
const hostEntry = async (key: string) => ((await (await api('/api/host-servers')).json()).hosts as Array<Record<string, any>>).find((h) => h.hostKey === key)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function pidOf(file: string): Promise<number | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  return raw ? Number(raw) : null
}
const tunnelPid = () => pidOf(pidFile)
const hostTunnelPid = () => pidOf(hostPidFile)
const handoverFile = () => path.join(WALNUT_HOME, 'local', 'expose-handover.json')
async function record(): Promise<{ hostKey: string; key: string; url?: string } | null> {
  try { return JSON.parse(await fs.readFile(handoverFile(), 'utf8')) } catch { return null }
}
/** What the host's server reports, read again (the manager polls every 30 s on its own). */
const refresh = () => getHostServerManager()!.reconcile('devbox')
/** The tunnel here, connected at `url`. */
const connectedHere = (url: string) => waitFor(async () => { const s = await status(); return s.state === 'connected' && !s.runsOn && s.url === url ? s : null })
/** The host's tunnel (its real supervisor), connected. */
const hostConnected = () => waitFor(() => there.proc?.expose.status().state === 'connected' ? there.proc.expose.status() : null)
/** Which machine the service gives `name` to now. */
const routedTo = (name: string) => { const r = service.route.get(name); return r ? who(r.target) : null }

async function boot(): Promise<void> {
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
  registration = registerExposeProvider('acme-plugin', definition())
}

/**
 * This computer restarts, in the order a real stop takes: the server stops (its plugins
 * go while the hosts' links are still up, and the provider with them), then the process
 * with its host-server manager; the next one boots and its plugin registers again. The
 * host's daemon keeps its server running throughout.
 */
async function restart(between?: () => Promise<void>): Promise<void> {
  await stopServer()
  registration?.dispose()
  registration = null
  // Give a reconcile the provider's going would start the time to reach the host.
  await sleep(300)
  _resetHostServerManagerForTesting()
  await between?.()
  await boot()
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.join(WALNUT_HOME, 'fake-host'), { recursive: true })
  fakeTunnel = path.join(WALNUT_HOME, 'fake-tunnel.cjs')
  pidFile = path.join(WALNUT_HOME, 'fake-tunnel.pid')
  hostPidFile = path.join(WALNUT_HOME, 'fake-host', 'fake-tunnel.pid')
  await fs.writeFile(fakeTunnel, FAKE_TUNNEL)
  await startService()
  // The host server's public port: its tunnel probe answer first, then (here) a page of its own.
  hostPublic = http.createServer((req, res) => {
    if (there.proc && answerTunnelProbe(req, res, there.proc.expose.probeToken)) return
    res.end('the host server')
  })
  await new Promise<void>((r) => hostPublic.listen(0, '127.0.0.1', () => r()))
  hostPublicPort = (hostPublic.address() as net.AddressInfo).port
  process.env.WALNUT_HOST_SERVER_APP_DIR = '/work/walnut-tree'
  // No server set up there yet: following the provider turns one on.
  await updateConfig({ hosts: { devbox: { label: 'Dev box', hostname: 'always-on-devbox.invalid', user: 'someone' } } as never })
  await boot()
}, 60_000)

afterAll(async () => {
  registration?.dispose()
  _resetHostServerManagerForTesting()
  await stopServer()
  await stopHostProcess()
  for (const pid of [await tunnelPid(), await hostTunnelPid()]) { try { if (pid && pid > 1) process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  hostPublic?.close()
  service.server?.closeAllConnections?.()
  service.server?.close()
  delete process.env.WALNUT_HOST_SERVER_APP_DIR
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('moving the tunnel to a host without a fight', () => {
  it('turned on, placed on a host with no server yet: it runs here meanwhile, and the host\'s server is turned on', async () => {
    // The host servers' manager exists from the first host connect on a real Mac; here, from this read.
    expect((await hostEntry('devbox'))?.settings.enabled).toBe(false)
    expect((await put({ enabled: true, provider: 'acme-tunnel' })).status).toBe(200)
    const here = await connectedHere(urlOf('acme-demo'))
    expect(here.movingTo).toMatchObject({ hostKey: 'devbox', label: 'Dev box' })
    await waitFor(async () => (await status()).movingTo?.note === 'Waiting to connect to Dev box.')
    expect(alive((await waitFor(tunnelPid))!)).toBe(true)
    expect(routedTo('acme-demo')).toBe('mac')
    expect((await hostEntry('devbox'))?.settings).toMatchObject({ enabled: true, carriesTunnel: true })
    expect(await record()).toBeNull()
  })

  it('the host connects and its server (the real host code) installs the tunnel CLI: still here, and the status says so', async () => {
    await hostServerConnected(host)
    expect(getHostServerManager()!.view('devbox').phase).toBe('running')
    expect(there.spec?.settings.expose).toMatchObject({ enabled: true, definition: { id: 'acme-tunnel', installCommand: 'echo installing the acme tunnel CLI' } })
    await waitFor(() => there.releaseInstall)
    expect(there.proc!.expose.status()).toMatchObject({ state: 'starting', activity: 'Installing Acme Tunnel...' })
    await refresh()
    const s = await waitFor(async () => { const v = await status(); return v.movingTo?.note === 'Installing Acme Tunnel...' ? v : null })
    expect(s).toMatchObject({ state: 'connected', url: urlOf('acme-demo') })
    expect(routedTo('acme-demo')).toBe('mac')
    expect(await record()).toBeNull()
  })

  it('the host connects while this computer is away, this one reconnects (the newest again): here stops first, the host connects again, then the record', async () => {
    const macPid = (await tunnelPid())!
    // The CLI arrives on the host: its supervisor starts it, and it takes the name.
    there.releaseInstall!()
    const first = await hostConnected()
    expect(first.url).toBe(urlOf('acme-demo'))
    const firstHostPid = (await waitFor(hostTunnelPid))!
    expect(routedTo('acme-demo')).toBe('host')
    // This computer wakes up before it saw that: its CLI reconnects and is the newest.
    process.kill(macPid, 'SIGUSR2')
    await waitFor(() => routedTo('acme-demo') === 'mac')
    service.log = []
    // Now this computer sees the host connected: the handover.
    await refresh()
    const s = await waitFor(async () => { const v = await status(); return v.runsOn ? v : null })
    expect(s).toMatchObject({ url: urlOf('acme-demo'), runsOn: { hostKey: 'devbox', label: 'Dev box', auto: true } })
    expect(s.movingTo).toBeUndefined()
    expect(s.tunnelKey).toBeUndefined()
    await waitFor(async () => !alive(macPid))
    // The host's supervisor started its CLI again (followExposeSettings -> retryNow), after the one here closed.
    const secondHostPid = await waitFor(async () => { const p = await hostTunnelPid(); return p && p !== firstHostPid ? p : null })
    await waitFor(() => routedTo('acme-demo') === 'host')
    const closedMac = service.log.indexOf('close acme-demo mac')
    const reopenedHost = service.log.lastIndexOf('open acme-demo host')
    expect(closedMac).toBeGreaterThanOrEqual(0)
    expect(reopenedHost).toBeGreaterThan(closedMac)
    expect(alive(firstHostPid)).toBe(false)
    expect(alive(secondHostPid)).toBe(true)
    expect(await record()).toMatchObject({ hostKey: 'devbox', key: tunnelKey(definition(), {}), url: urlOf('acme-demo') })
    // Through the address, the host's own listener answers (its token, not this computer's).
    await hostConnected()
    expect(await httpProbe(urlOf('acme-demo'), 5_000, there.proc!.expose.probeToken)).toBe('mine')
    expect(await httpProbe(urlOf('acme-demo'), 5_000, 'this-computers-token')).toBe('other')
    expect(await (await fetch(`${urlOf('acme-demo')}/`)).text()).toBe('the host server')
    // The sign-in code lists the host's address, once, as the host's.
    const code = await (await api('/api/devices/browser-code', { method: 'POST' })).json()
    expect(code.addresses.map((a: { where: string }) => a.where)).toEqual(['devbox'])
  })

  it('a restart here with the record, after a retry bumped the count: nothing starts here, and the host keeps its tunnel', async () => {
    // A retry first (the count the host has seen is 2 now), so a count that started over would show.
    const before = (await hostTunnelPid())!
    await getHostServerManager()!.retryExpose('devbox')
    const bumped = await waitFor(async () => { const p = await hostTunnelPid(); return p && p !== before ? p : null })
    await hostConnected()
    expect(there.spec?.settings.exposeRetry).toBeGreaterThanOrEqual(2)
    const count = there.spec!.settings.exposeRetry
    const configures = there.configures
    await restart(async () => { await fs.rm(pidFile, { force: true }) })
    // The provider went with the stopping server's plugins: the host was told nothing.
    expect(there.configures).toBe(configures)
    expect(there.proc).not.toBeNull()
    // The plugin registered after the boot (as a real one loads): the record holds the place.
    await waitFor(async () => { const v = await status(); return v.runsOn ? v : null })
    await sleep(1_500)
    expect(await tunnelPid()).toBeNull()
    await hostServerConnected(host)
    const s = await waitFor(async () => { const v = await status(); return v.state === 'connected' && v.runsOn ? v : null })
    expect(s.url).toBe(urlOf('acme-demo'))
    // The same count went back (kept under local/): its tunnel did not start again.
    expect(there.spec!.settings.exposeRetry).toBe(count)
    await sleep(800)
    expect(await hostTunnelPid()).toBe(bumped)
    expect(alive(bumped)).toBe(true)
    expect(routedTo('acme-demo')).toBe('host')
    expect(await tunnelPid()).toBeNull()
    expect(await record()).toMatchObject({ hostKey: 'devbox', key: tunnelKey(definition(), {}) })
  })

  it('another tunnel name clears the record: it runs here under that name until the host holds that one too', async () => {
    expect((await put({ options: { name: 'acme-other' } })).status).toBe(200)
    await connectedHere(urlOf('acme-other')).catch(() => null)
    // The host gets the new name at once (its server applies it); whichever happens first, the end is the same.
    await refresh()
    const s = await waitFor(async () => { await refresh(); const v = await status(); return v.state === 'connected' && v.runsOn && v.url === urlOf('acme-other') ? v : null })
    expect(s.runsOn).toMatchObject({ hostKey: 'devbox' })
    await waitFor(() => routedTo('acme-other') === 'host')
    expect(routedTo('acme-demo')).toBeNull()
    expect(there.spec?.settings.expose.options).toEqual({ name: 'acme-other' })
    expect(await record()).toMatchObject({ hostKey: 'devbox', key: tunnelKey(definition(), { name: 'acme-other' }) })
    const pid = await tunnelPid()
    if (pid) await waitFor(async () => !alive(pid))
  })

  it('a restart without the record, the host holding it from before: the one here runs (the newest), then the same handover', async () => {
    const hostPid = (await hostTunnelPid())!
    await restart(async () => {
      await fs.rm(handoverFile(), { force: true })
      await fs.rm(pidFile, { force: true })
    })
    // Not reached yet: the tunnel runs here, and the service gives it the name (the host's gets nothing now).
    const here = await connectedHere(urlOf('acme-other'))
    expect(here.movingTo).toMatchObject({ hostKey: 'devbox' })
    await waitFor(() => routedTo('acme-other') === 'mac')
    const pid = (await tunnelPid())!
    await hostServerConnected(host)
    await waitFor(async () => { const v = await status(); return v.state === 'connected' && v.runsOn ? v : null })
    await waitFor(async () => !alive(pid))
    await waitFor(async () => { const p = await hostTunnelPid(); return p && p !== hostPid ? p : null })
    await waitFor(() => routedTo('acme-other') === 'host')
    await hostConnected()
    expect(await httpProbe(urlOf('acme-other'), 5_000, there.proc!.expose.probeToken)).toBe('mine')
    expect(await record()).toMatchObject({ hostKey: 'devbox', key: tunnelKey(definition(), { name: 'acme-other' }) })
  })

  it('moving it back here clears the record, runs it here, and lets the host go', async () => {
    await fs.rm(pidFile, { force: true })
    expect((await put({ run_on: 'here' })).status).toBe(200)
    const here = await connectedHere(urlOf('acme-other'))
    expect(here.movingTo).toBeUndefined()
    expect(await record()).toBeNull()
    expect(alive((await waitFor(tunnelPid))!)).toBe(true)
    // Its own server was never turned on: it stops, its tunnel with it.
    await waitFor(() => there.spec === null)
    await waitFor(() => routedTo('acme-other') === 'mac')
  })

  it('back on the host and handed over again, turning it off clears the record', async () => {
    const pid = (await tunnelPid())!
    expect((await put({ run_on: null })).status).toBe(200)
    await waitFor(() => there.spec !== null)
    await hostConnected()
    await refresh()
    await waitFor(async () => !alive(pid))
    await waitFor(() => routedTo('acme-other') === 'host')
    expect(await record()).toMatchObject({ hostKey: 'devbox' })
    expect((await put({ enabled: false })).status).toBe(200)
    expect(await record()).toBeNull()
    expect(await status()).toMatchObject({ enabled: false, state: 'off' })
    await sleep(500)
    expect(await tunnelPid()).toBe(pid)
    expect(alive(pid)).toBe(false)
  })
})
