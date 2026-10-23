/**
 * The Mac's host-server manager (src/core/host-server/manager.ts) against a fake
 * host: what it asks the host's daemon, what it runs over SSH, what it sends on
 * a stream to the host server, and what it tells the person. The scripts
 * themselves run for real in host-server-install.test.ts and
 * host-server-target.test.ts, the real install and start of the compiled file in
 * host-server-file-e2e.test.ts; a whole host server in tests/e2e/host-server-e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHostServerManager, type HostServerHost, type HostServerSettings, type ManagerDeps } from '../../src/core/host-server/manager.js'
import type { HostFile, HostFileSource } from '../../src/core/host-server/host-file.js'
import { registerExposeProvider, _resetExposeProvidersForTesting } from '../../src/core/expose/registry.js'

const HOME = '/Users/me/.open-walnut'

interface FakeHost extends HostServerHost {
  calls: string[]
  specs: Array<Record<string, any> | null>
  uploads: Array<{ path: string; bytes: number }>
  streams: string[]
  /** keepStreamLane calls. */
  lane: boolean[]
  installState: 'absent' | 'running' | 'ready' | 'failed'
  pollsUntilReady: number
  /** What the target probe answers. */
  system: string
  caps: Set<string>
  daemonState: string
  /** The server reports through its daemon once started. */
  reports: boolean
  /** More of the daemon's server.status (its program, a fallback). */
  statusExtra?: Record<string, unknown>
  /** The install script last uploaded. */
  script?: string
}

/** The host server's end of a stream: what the Mac posts to it. */
let follower: http.Server
let followerPort = 0
let posted: Array<{ url: string; body: string }> = []

function fakeHost(): FakeHost {
  const h: FakeHost = {
    hostKey: 'devbox',
    connected: true,
    calls: [], specs: [], uploads: [], streams: [], lane: [],
    installState: 'absent', pollsUntilReady: 2, system: 'os=Linux\narch=x86_64\nlibc=glibc\ntranslated=0\nglibc=2.26\n',
    caps: new Set(['host-server-v1', 'follower-v1', 'stream-relay-v1']),
    daemonState: 'off',
    reports: true,
    hasCapability: (cap) => h.caps.has(cap),
    async send(cmd, params) {
      h.calls.push(`send ${cmd}`)
      if (cmd === 'server.status') {
        // The host's clock is an hour behind: only the age it gives counts.
        const report = h.daemonState === 'running' && h.reports ? { report: { route: { kind: 'leader' }, version: '0.6.7' }, reportedAt: Date.now() - 3_600_000, reportAgeMs: 1_000 } : {}
        return { ok: true, status: { state: h.daemonState, since: 0, restarts: 0, ...report, ...h.statusExtra } }
      }
      if (cmd === 'server.configure') {
        h.specs.push((params?.spec as Record<string, any>) ?? null)
        h.daemonState = params?.spec ? 'running' : 'off'
        return { ok: true, status: { state: h.daemonState, since: 0, restarts: 0, pid: 4242 } }
      }
      return { ok: false, error: 'unknown' }
    },
    async runRemoteScript(script) {
      if (script === 'printf %s "$HOME"') return '/home/me'
      if (script.includes('s=$(uname -s')) { h.calls.push('probe'); return h.system }
      if (script.includes('nohup sh')) { h.calls.push('launch'); h.installState = 'running'; return 'launched' }
      if (script.includes('if [ -f "$ROOT/app/$ID/.ready" ]')) {
        h.calls.push('state')
        if (h.installState === 'running' && --h.pollsUntilReady <= 0) h.installState = 'ready'
        if (h.installState === 'failed') return 'FAILED\nthe walnut file does not start on this host (Linux x86_64, glibc 2.26): boom\n__LOG__\nboom'
        return { absent: 'ABSENT', running: 'RUNNING', ready: 'READY' }[h.installState] ?? 'ABSENT'
      }
      if (script.includes('require("net")')) {
        h.calls.push(script.startsWith('BUN_BE_BUN=1 ') ? `ports ${script.split(' ')[1]}` : `ports ${script.split(' ')[0]}`)
        return script.split(' ').filter((w) => /^\d{5}$/.test(w)).map((p) => `${p}:free`).join('\n')
      }
      throw new Error('unexpected script: ' + script.slice(0, 80))
    },
    async uploadFile(p, data) { h.uploads.push({ path: p, bytes: data.length }); if (p.endsWith('.install.sh')) h.script = data.toString() },
    keepStreamLane(on) { h.lane.push(on) },
    async openStream(to, purpose) {
      h.streams.push(`${to}:${purpose}`)
      const sock = net.connect(followerPort, '127.0.0.1')
      await new Promise((r) => sock.once('connect', r))
      return sock
    },
  }
  return h
}

let dir = ''
let settings: HostServerSettings
let tunnelPort = 5555
let released: string[] = []
let held: string[] = []
let targets: Array<{ id: string; post?: (body: Record<string, unknown>) => Promise<Response>; copies?: () => Promise<Record<string, boolean> | undefined> }> = []
/** Each `ready` the copy target heard: `<host>` or `<host> restarted`. */
let readies: string[] = []

/** This Mac's build as the walnut file: what it was asked for, and what it said while getting it. */
let fileAsks: string[] = []
function fakeFiles(over: Partial<HostFileSource> = {}): HostFileSource {
  return {
    buildId: async () => ({ id: '0.6.7-abc1234', version: '0.6.7' }),
    file: async (target, say) => {
      fileAsks.push(target)
      say?.(`Building Walnut 0.6.7-abc1234 for ${target} on this computer (about a minute, once per build).`)
      return { id: '0.6.7-abc1234', version: '0.6.7', target, gz: Buffer.alloc(3 * 2 ** 20), sha256: 'c'.repeat(64) } satisfies HostFile
    },
    ...over,
  }
}

function deps(over: Partial<ManagerDeps> = {}): ManagerDeps {
  return {
    settingsOf: async () => settings,
    label: async () => 'Dev box',
    walnutId: async () => 'wmac01',
    home: HOME,
    holdTunnelPort: async (holder) => { held.push(holder); return tunnelPort },
    releaseTunnelPort: async (holder) => { released.push(holder) },
    hostFile: fakeFiles(),
    stateFile: path.join(dir, 'host-servers.json'),
    now: Date.now,
    registerTarget: (hostKey, post, copies) => {
      targets.push({ id: `+${hostKey}`, post, copies })
      return { unregister: () => targets.push({ id: `-${hostKey}` }), ready: (restarted) => readies.push(restarted ? `${hostKey} restarted` : hostKey) }
    },
    installPollMs: 1,
    pollMs: 60_000,
    ...over,
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-'))
  settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
  fileAsks = []
  tunnelPort = 5555
  released = []
  held = []
  targets = []
  readies = []
  posted = []
  _resetExposeProvidersForTesting()
  follower = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      posted.push({ url: req.url!, body })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, need: [] }))
    })
  })
  await new Promise<void>((r) => follower.listen(0, '127.0.0.1', () => r()))
  followerPort = (follower.address() as net.AddressInfo).port
})

afterEach(() => {
  follower.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const ids = () => targets.map((t) => t.id)

describe('host server manager', () => {
  it('a host without the setting gets nothing but a look at what its daemon runs', async () => {
    settings = { ...settings, enabled: false }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    await m.connected(host)
    expect(host.calls).toEqual(['send server.status'])
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
  })

  it('sets it up: the file for its system, its port, the door, the daemon spec with its tunnel, and a copy target over a stream', async () => {
    const messages: string[] = []
    const m = createHostServerManager(deps({ changed: (v) => { if (v.message && messages.at(-1) !== v.message) messages.push(v.message) } }))
    const host = fakeHost()
    await m.connected(host)
    // No Node anywhere: the probe says which file, the installed file itself finds the port.
    const file = '/home/me/.open-walnut-host/app/0.6.7-abc1234/walnut'
    expect(host.calls.filter((c) => c !== 'state')).toEqual(['probe', 'launch', `ports '${file}'`, 'send server.configure', 'send server.status'])
    expect(fileAsks).toEqual(['linux-x64'])
    expect(host.uploads).toEqual([
      { path: '/home/me/.open-walnut-host/incoming/0.6.7-abc1234.gz', bytes: 3 * 2 ** 20 },
      { path: '/home/me/.open-walnut-host/incoming/0.6.7-abc1234.install.sh', bytes: expect.any(Number) },
    ])
    // The script installs that file: its version, its sha256, the host in words.
    expect(host.script).toContain("VERSION='0.6.7'")
    expect(host.script).toContain(`SHA='${'c'.repeat(64)}'`)
    expect(host.script).toContain("HOSTDESC='Linux x86_64, glibc 2.26'")
    expect(host.script).toContain('ROOT="$HOME/.open-walnut-host"')
    expect(host.script).not.toMatch(/npm|node_modules\/|NODE=/)
    expect(messages).toEqual([
      'Checking the host.',
      'Getting Walnut 0.6.7-abc1234 for linux-x64.',
      'Building Walnut 0.6.7-abc1234 for linux-x64 on this computer (about a minute, once per build).',
      'Sending Walnut 0.6.7-abc1234 for linux-x64 to the host (3 MB).',
      'Installing Walnut 0.6.7-abc1234 on the host.',
      'Starting the server on the host.',
    ])
    const ports = JSON.parse(fs.readFileSync(path.join(dir, 'host-servers.json'), 'utf8')).devbox
    expect(fs.statSync(path.join(dir, 'host-servers.json')).mode & 0o777).toBe(0o600)
    expect(Object.keys(ports)).toEqual(['publicPort'])
    // The door host server streams come in by, and a lane of their own to the host.
    expect(held).toEqual(['host-server:devbox'])
    expect(host.lane).toEqual([true])
    const spec = host.specs[0]!
    expect(spec).toMatchObject({
      home: HOME, walnutId: 'wmac01', command: file,
      args: ['host-server'],
      cwd: '/home/me/.open-walnut-host/data', log: '/home/me/.open-walnut-host/logs/server.log',
      port: ports.publicPort,
      settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
    })
    expect(spec.env).toEqual({
      // Its own run dir: the host server never writes the host daemon's /tmp/open-walnut (WP3).
      OPEN_WALNUT_HOME: '/home/me/.open-walnut-host/data', WALNUT_DAEMON_DIR: '/home/me/.open-walnut-host/run', WALNUT_HOST_SERVER: '1',
      WALNUT_HOST_SERVER_PORT: String(ports.publicPort),
      WALNUT_LEADER_HOME: HOME, WALNUT_WALNUT_ID: 'wmac01',
      WALNUT_HOST_LABEL: 'Dev box', WALNUT_NO_AUTO_UPDATE: '1',
    })
    expect(ids()).toEqual(['+devbox'])
    expect(m.view('devbox')).toMatchObject({ enabled: true, phase: 'running', build: '0.6.7-abc1234', install: { state: 'ready' }, server: { route: { kind: 'leader' } }, port: ports.publicPort })
    // A copy step goes to the host server on a stream through its daemon.
    const res = await targets[0]!.post!({ op: 'sync', kind: 'tasks', entries: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, need: [] })
    expect(host.streams).toEqual(['follower:replica'])
    expect(posted).toEqual([{ url: '/bridge/replica', body: JSON.stringify({ op: 'sync', kind: 'tasks', entries: [] }) }])
    // The host's choice of copied kinds (its Settings row) reaches the copy kinds, read at each round (WP4).
    expect(await targets[0]!.copies!()).toBeUndefined()
    settings = { ...settings, copies: { inbox_bodies: true, boards: false } }
    expect(await targets[0]!.copies!()).toEqual({ inbox_bodies: true, boards: false })
  })

  it('the next connect keeps its port, and installs nothing already installed', async () => {
    const m = createHostServerManager(deps())
    const first = fakeHost()
    await m.connected(first)
    const ports = JSON.parse(fs.readFileSync(path.join(dir, 'host-servers.json'), 'utf8')).devbox
    const again = fakeHost()
    again.installState = 'ready'
    m.disconnected('devbox')
    expect(m.view('devbox').phase).toBe('waiting-for-host')
    expect(ids()).toEqual(['+devbox', '-devbox'])
    expect(released).toEqual(['host-server:devbox'])
    fileAsks = []
    await m.connected(again)
    expect(again.calls).not.toContain('launch')
    expect(again.calls).not.toContain('probe')
    expect(again.calls.filter((c) => c.startsWith('ports'))).toEqual([])
    expect(again.uploads).toEqual([])
    // Installed already: the file is neither built nor downloaded again.
    expect(fileAsks).toEqual([])
    expect(again.specs[0]).toEqual(first.specs[0])
    expect(again.specs[0]!.port).toBe(ports.publicPort)
    expect(ids()).toEqual(['+devbox', '-devbox', '+devbox'])
  })

  it('sends the tunnel as a provider definition the host can run', async () => {
    registerExposeProvider('plugin-x', {
      id: 'mytunnel', title: 'My tunnel', command: '~/bin/tunnel', args: ['{port}', '{name}'],
      options: [{ key: 'name', label: 'Name', default: 'walnut' }], urlPattern: 'https://[a-z.]+',
    })
    settings = { ...settings, expose: { enabled: true, provider: 'mytunnel', options: { name: 'devbox' } } }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    await m.connected(host)
    expect(host.specs[0]!.settings.expose).toEqual({
      enabled: true,
      definition: expect.objectContaining({ id: 'mytunnel', command: '~/bin/tunnel', args: ['{port}', '{name}'] }),
      options: { name: 'devbox' },
    })
    // "Retry the tunnel": the same spec with a new count, so the daemon restarts nothing.
    await m.retryExpose('devbox')
    expect(host.specs[1]).toEqual({ ...host.specs[0], settings: { ...host.specs[0]!.settings, exposeRetry: 1 } })
  })

  it('a tunnel provider nobody provides is sent as off', async () => {
    settings = { ...settings, expose: { enabled: true, provider: 'gone', options: {} } }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    await m.connected(host)
    expect(host.specs[0]!.settings.expose).toEqual({ enabled: false, definition: null, options: {} })
  })

  it('a host there is no file for says so, and gets nothing', async () => {
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.system = 'os=FreeBSD\narch=amd64\nlibc=\ntranslated=0\nglibc=\n'
    await m.connected(host)
    expect(m.view('devbox')).toMatchObject({ phase: 'error' })
    expect(m.view('devbox').message).toMatch(/the host runs FreeBSD on amd64; the walnut file is built for Linux and macOS on x64 and arm64/)
    expect(fileAsks).toEqual([])
    expect(host.uploads).toEqual([])
    expect(host.specs).toEqual([])
  })

  it('the musl and arm64 systems get their own file', async () => {
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.system = 'os=Linux\narch=aarch64\nlibc=musl\ntranslated=0\nglibc=\n'
    await m.connected(host)
    expect(fileAsks).toEqual(['linux-arm64-musl'])
    expect(host.script).toContain("HOSTDESC='Linux aarch64, musl'")
    expect(m.view('devbox').phase).toBe('running')
  })

  it('a build this Mac cannot get a file for says why in the host\'s status; nothing is installed on the host', async () => {
    const why = 'Walnut 0.6.7 is not a published release (https://example.invalid/v0.6.7/SHA256SUMS is not there), and this compiled walnut file has no checkout to build the walnut file for linux-x64 from.'
    const m = createHostServerManager(deps({ hostFile: fakeFiles({ file: async () => { throw new Error(why) } }) }))
    const host = fakeHost()
    await m.connected(host)
    expect(m.view('devbox')).toMatchObject({ phase: 'error', message: why })
    expect(host.uploads).toEqual([])
    expect(host.calls).not.toContain('launch')
    expect(host.specs).toEqual([])
    // Running from source: not even an id, so the host is not asked anything about an install.
    const src = createHostServerManager(deps({ hostFile: fakeFiles({ buildId: async () => { throw new Error('This server runs from source, not from a build') } }) }))
    const h2 = fakeHost()
    await src.connected(h2)
    expect(src.view('devbox')).toMatchObject({ phase: 'error', message: 'This server runs from source, not from a build' })
    expect(h2.calls).toEqual([])
  })

  it('a failed install says why and starts nothing', async () => {
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.pollsUntilReady = 1_000
    const run = m.connected(host)
    await new Promise((r) => setTimeout(r, 20))
    host.installState = 'failed'
    await run
    expect(m.view('devbox')).toMatchObject({ phase: 'error', install: { state: 'failed', logTail: 'boom' } })
    expect(m.view('devbox').message).toMatch(/the install on the host failed: the walnut file does not start on this host \(Linux x86_64, glibc 2\.26\): boom/)
    expect(host.specs).toEqual([])
  })

  it('an older daemon is told to update first', async () => {
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.caps.delete('stream-relay-v1')
    await m.connected(host)
    expect(m.view('devbox')).toMatchObject({ phase: 'unsupported' })
    expect(host.calls).toEqual([])
  })

  it('turning it off stops it there, drops the copy target and lets the door go', async () => {
    const m = createHostServerManager(deps())
    const host = fakeHost()
    await m.connected(host)
    settings = { ...settings, enabled: false }
    await m.reconcile('devbox')
    expect(host.specs.at(-1)).toBeNull()
    expect(released).toEqual(['host-server:devbox'])
    expect(host.lane).toEqual([true, false])
    expect(ids()).toEqual(['+devbox', '-devbox'])
    expect(m.view('devbox')).toMatchObject({ enabled: false, phase: 'off' })
  })

  it('the program configured on a host outlives a disconnect (the walnut mount of its sessions, WP12) and goes when it is turned off', async () => {
    const m = createHostServerManager(deps())
    expect(m.programOf('devbox')).toBeNull()
    await m.connected(fakeHost())
    const program = { command: '/home/me/.open-walnut-host/app/0.6.7-abc1234/walnut', args: ['host-server'] }
    expect(m.programOf('devbox')).toEqual(program)
    // The Mac woke and the host is back: its drain asks before this host is configured again.
    m.disconnected('devbox')
    expect(m.programOf('devbox')).toEqual(program)
    settings = { ...settings, enabled: false }
    await m.reconcile('devbox')
    expect(m.programOf('devbox')).toBeNull()
  })

  it('the copy target hears when the server answers: once it runs, and again after it comes back', async () => {
    const phases: string[] = []
    const m = createHostServerManager(deps({ changed: (v) => phases.push(v.phase), pollMs: 5 }))
    const host = fakeHost()
    host.statusExtra = { pid: 4242 }
    try {
      await m.connected(host)
      // Registered at 'starting' (before the server answers), told at 'running'.
      expect(ids()).toEqual(['+devbox'])
      expect(phases.indexOf('starting')).toBeLessThan(phases.indexOf('running'))
      expect(readies).toEqual(['devbox restarted'])
      // A poll that sees the same running server tells nothing again.
      await new Promise((r) => setTimeout(r, 30))
      expect(readies).toEqual(['devbox restarted'])
      // The server stops answering for a while, then the same process answers again.
      host.reports = false
      await expect.poll(() => m.view('devbox').phase, { timeout: 5_000, interval: 5 }).toBe('starting')
      expect(readies).toEqual(['devbox restarted'])
      host.reports = true
      await expect.poll(() => m.view('devbox').phase, { timeout: 5_000, interval: 5 }).toBe('running')
      expect(readies).toEqual(['devbox restarted', 'devbox'])
      // A settings change reconciles: the phase cycles, the process is the same.
      await m.reconcile('devbox')
      const flow = phases.filter((p, i) => p !== phases[i - 1])
      expect(flow.slice(-3)).toEqual(['checking', 'starting', 'running'])
      expect(readies).toEqual(['devbox restarted', 'devbox', 'devbox'])
      // A restart on the host: another process answers (the daemon names its pid).
      host.reports = false
      await expect.poll(() => m.view('devbox').phase, { timeout: 5_000, interval: 5 }).toBe('starting')
      host.statusExtra = { pid: 5151, restarts: 1 }
      host.reports = true
      await expect.poll(() => readies.length, { timeout: 5_000, interval: 5 }).toBe(4)
      expect(readies.at(-1)).toBe('devbox restarted')
    } finally {
      m.stop()
    }
  })

  it('a host that is not connected waits for it', async () => {
    const m = createHostServerManager(deps())
    await m.reconcile('devbox')
    expect(m.view('devbox')).toMatchObject({ enabled: true, phase: 'waiting-for-host' })
  })

  it('a server that never reports through its daemon is an error that names its log', async () => {
    const m = createHostServerManager(deps({ firstReportMs: 30 }))
    const host = fakeHost()
    host.reports = false
    await m.connected(host)
    expect(m.view('devbox')).toMatchObject({ phase: 'error' })
    expect(m.view('devbox').message).toMatch(/did not answer within a minute; its log is \/home\/me\/\.open-walnut-host\/logs\/server\.log on the host/)
  })
})

describe('host server manager: which program (WP2)', () => {
  const file = '/home/me/.open-walnut-host/app/0.6.7-abc1234/walnut'
  const hostServerEnv = (port: number) => ({
    OPEN_WALNUT_HOME: '/home/me/.open-walnut-host/data', WALNUT_DAEMON_DIR: '/home/me/.open-walnut-host/run', WALNUT_HOST_SERVER: '1',
    WALNUT_HOST_SERVER_PORT: String(port), WALNUT_LEADER_HOME: HOME, WALNUT_WALNUT_ID: 'wmac01',
    WALNUT_HOST_LABEL: 'Dev box', WALNUT_NO_AUTO_UPDATE: '1',
  })

  it('a host that opted in, on a daemon with replica-host-v1, runs web --replica with the host server as its fallback', async () => {
    settings = { ...settings, program: 'replica' }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.caps.add('replica-host-v1')
    await m.connected(host)
    const spec = host.specs[0]!
    expect(spec).toMatchObject({ command: file, args: ['web', '--replica'] })
    expect(spec.env).toEqual({
      ...hostServerEnv(spec.port), WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host',
      // WP6 reads this host's sessions and files on the replica itself; WP7's console tells them from the Mac's.
      WALNUT_HOST_KEY: 'devbox',
    })
    // The plain host server's env is unchanged: no host key.
    expect(spec.fallback).toEqual({ args: ['host-server'], env: hostServerEnv(spec.port) })
    expect(m.view('devbox')).toMatchObject({ phase: 'running', program: 'replica' })
  })

  it('the view says the daemon\'s fallback while it runs one, and the replica again once it is back', async () => {
    settings = { ...settings, program: 'replica' }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.caps.add('replica-host-v1')
    await m.connected(host)
    expect(m.view('devbox').program).toBe('replica')
    const fallback = { since: 1_000, until: 3_601_000, lastError: 'exit code 1' }
    host.statusExtra = { program: 'fallback', fallback }
    await m.reconcile('devbox')
    expect(m.view('devbox')).toMatchObject({ program: 'fallback', daemon: { program: 'fallback', fallback } })
    host.statusExtra = { program: 'primary' }
    await m.reconcile('devbox')
    expect(m.view('devbox').program).toBe('replica')
  })

  it('the opt-in on a daemon without replica-host-v1 runs host-server, with no fallback', async () => {
    settings = { ...settings, program: 'replica' }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    await m.connected(host)
    const spec = host.specs[0]!
    expect(spec).toMatchObject({ command: file, args: ['host-server'] })
    expect(spec.env).toEqual(hostServerEnv(spec.port))
    expect('fallback' in spec).toBe(false)
    expect(m.view('devbox').program).toBe('host-server')
  })

  it('D13: a daemon with replica-host-v1 runs the replica when the host names no program', async () => {
    settings = { enabled: true, expose: { enabled: false, provider: null, options: {} } }
    const m = createHostServerManager(deps())
    const host = fakeHost()
    host.caps.add('replica-host-v1')
    await m.connected(host)
    const spec = host.specs[0]!
    expect(spec).toMatchObject({ command: file, args: ['web', '--replica'] })
    expect(spec.fallback?.args).toEqual(['host-server'])
    expect(m.view('devbox').program).toBe('replica')
  })

  it('the rollback: server_program host-server on a daemon with replica-host-v1 runs host-server exactly as before', async () => {
    for (const program of ['host-server'] as const) {
      settings = { enabled: true, expose: { enabled: false, provider: null, options: {} }, ...(program ? { program } : {}) }
      const m = createHostServerManager(deps())
      const host = fakeHost()
      host.caps.add('replica-host-v1')
      await m.connected(host)
      const spec = host.specs[0]!
      expect(spec).toMatchObject({ command: file, args: ['host-server'] })
      expect(spec.env).toEqual(hostServerEnv(spec.port))
      expect(Object.keys(spec)).toEqual(['v', 'home', 'walnutId', 'command', 'args', 'cwd', 'env', 'log', 'port', 'settings'])
    }
  })

  it('another root and a local app dir: no install, every path under that root', async () => {
    settings = { ...settings, program: 'replica' }
    const m = createHostServerManager(deps({ hostRoot: '/srv/marina-host', appDir: '/work/walnut-tree', appCommand: '/opt/js/bin/runtime' }))
    const host = fakeHost()
    host.caps.add('replica-host-v1')
    await m.connected(host)
    expect(host.uploads).toEqual([])
    expect(host.calls).not.toContain('launch')
    expect(host.calls).not.toContain('probe')
    expect(fileAsks).toEqual([])
    // Its port is asked of the runtime the app dir runs on (no BUN_BE_BUN: it is not the walnut file).
    expect(host.calls).toContain("ports '/opt/js/bin/runtime'")
    const spec = host.specs[0]!
    expect(spec).toMatchObject({ command: '/opt/js/bin/runtime', args: ['/work/walnut-tree/dist/cli.js', 'web', '--replica'], cwd: '/srv/marina-host/data', log: '/srv/marina-host/logs/server.log' })
    expect(spec.env).toMatchObject({ OPEN_WALNUT_HOME: '/srv/marina-host/data', WALNUT_DAEMON_DIR: '/srv/marina-host/run' })
  })

  it('another root takes the file and the install too', async () => {
    const m = createHostServerManager(deps({ hostRoot: '/srv/marina-host' }))
    const host = fakeHost()
    await m.connected(host)
    expect(host.uploads.map((u) => u.path)).toEqual(['/srv/marina-host/incoming/0.6.7-abc1234.gz', '/srv/marina-host/incoming/0.6.7-abc1234.install.sh'])
    expect(host.script).toContain('ROOT="/srv/marina-host"')
    expect(host.specs[0]).toMatchObject({ command: '/srv/marina-host/app/0.6.7-abc1234/walnut', args: ['host-server'], cwd: '/srv/marina-host/data' })
  })

  it('a root a shell would expand is refused', async () => {
    const m = createHostServerManager(deps({ hostRoot: '/srv/$(touch x)' }))
    await m.connected(fakeHost())
    expect(m.view('devbox')).toMatchObject({ phase: 'error' })
    expect(m.view('devbox').message).toMatch(/plain characters/)
  })
})
