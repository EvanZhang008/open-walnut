/**
 * /daemon-tunnel admission and refusals (web/ws/daemon-tunnel.ts), an open
 * tunnel's piping and its close when hosting is turned off, plus the tunnel
 * daemon's dir guard and start env (providers/cloud-tunnel-daemon.ts).
 *
 * The pure rule first, then the same rule answering a real WebSocket client on
 * a loopback server, so the status line AND the refusal header the Mac reads
 * are pinned, not just the decision.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-daemon-tunnel'))

import {
  TUNNEL_CLOSE_EXEC_OFF, TUNNEL_CLOSE_REVOKED, handleDaemonTunnelUpgrade, tunnelAdmission, type TunnelCredential, type TunnelDeps,
} from '../../src/web/ws/daemon-tunnel.js'
import {
  getTunnelDaemon, resetTunnelDaemonForTest, tunnelDaemonDir, tunnelDaemonDirRefusal, tunnelDaemonEnv, tunnelStreamsDir,
} from '../../src/providers/cloud-tunnel-daemon.js'
import { LocalDaemon } from '../../src/providers/local-daemon.js'
import { TUNNEL_PROBE_HEADER, TUNNEL_REFUSAL_HEADER } from '../../src/core/hosts/cloud-box-host.js'
import { notifyRevoked } from '../../src/core/device-auth.js'

const PRIMARY: TunnelCredential = { name: 'bridge-local', kind: 'machine' }
const OTHER_MACHINE: TunnelCredential = { name: 'bridge-devbox', kind: 'machine' }
const PHONE: TunnelCredential = { name: 'my-phone', kind: 'device' }
const API_KEY: TunnelCredential = { name: 'legacy', kind: 'api_key' }

describe('tunnelAdmission', () => {
  it('lets only the primary machine credential through', () => {
    expect(tunnelAdmission(PRIMARY, true)).toEqual({ ok: true })
  })

  it.each([
    ['no credential', null, 401, 'unauthorized'],
    ['a phone device token', PHONE, 403, 'not_primary'],
    ['an API key', API_KEY, 403, 'not_primary'],
    ["another host's machine token", OTHER_MACHINE, 403, 'not_primary'],
  ] as const)('refuses %s', (_label, cred, status, refusal) => {
    const a = tunnelAdmission(cred, true)
    expect(a.ok).toBe(false)
    if (!a.ok) {
      expect(a.status).toBe(status)
      expect(a.refusal).toBe(refusal)
    }
  })

  it('cloud.exec off answers 403 cloud_exec_off to the primary', () => {
    const a = tunnelAdmission(PRIMARY, false)
    expect(a).toMatchObject({ ok: false, status: 403, refusal: 'cloud_exec_off' })
  })

  it('checks identity before the switch: a phone never learns hosting is off', () => {
    expect(tunnelAdmission(PHONE, false)).toMatchObject({ refusal: 'not_primary' })
    expect(tunnelAdmission(null, false)).toMatchObject({ refusal: 'unauthorized' })
  })
})

describe('tunnel daemon dir guard', () => {
  it('lives under the service user home by default, and a test dir overrides it', () => {
    expect(tunnelDaemonDir({}, '/var/lib/svc')).toBe(path.join('/var/lib/svc', '.local', 'state', 'open-walnut', 'primary-daemon'))
    expect(tunnelDaemonDir({ WALNUT_TUNNEL_DAEMON_DIR: '/tmp/t-daemon' }, '/var/lib/svc')).toBe('/tmp/t-daemon')
  })

  it('refuses the default daemon dir and the replica daemon dir: two servers never share one daemon', () => {
    expect(tunnelDaemonDirRefusal('/tmp/open-walnut', '/tmp/replica')).toMatch(/default daemon dir/)
    expect(tunnelDaemonDirRefusal('/tmp/replica/', '/tmp/replica')).toMatch(/own daemon dir/)
    expect(tunnelDaemonDirRefusal('/var/lib/svc/.local/state/open-walnut/primary-daemon', '/tmp/open-walnut')).toBeNull()
  })

  it('is keyed by the id of the Mac that owns the credential: its own dir, streams and daemon', () => {
    const env = { WALNUT_TUNNEL_DAEMON_DIR: '/tmp/t-daemon' }
    const a = tunnelDaemonDir(env, '/h', 'd0123456789abcdef')
    const b = tunnelDaemonDir(env, '/h', 'dfedcba9876543210')
    expect(a).toBe('/tmp/t-daemon.by-device/d0123456789abcdef/daemon')
    expect(b).toBe('/tmp/t-daemon.by-device/dfedcba9876543210/daemon')
    expect(tunnelStreamsDir(a)).toBe('/tmp/t-daemon.by-device/d0123456789abcdef/streams')
    expect(tunnelDaemonEnv(a).WALNUT_STREAMS_DIR).toBe('/tmp/t-daemon.by-device/d0123456789abcdef/streams')
    // A key an earlier build wrote (the owner's name) still names its dir, so its sessions stay.
    expect(tunnelDaemonDir(env, '/h', 'mac-a')).toBe('/tmp/t-daemon.by-device/mac-a/daemon')
    // A credential from before ownership keeps the dir its sessions live in.
    expect(tunnelDaemonDir(env, '/h', undefined)).toBe('/tmp/t-daemon')
    expect(tunnelStreamsDir('/tmp/t-daemon')).toBe('/tmp/t-daemon-streams')
    // Nothing else ever names a dir.
    for (const bad of ['../x', 'a/b', '', '.hidden']) expect(() => tunnelDaemonDir(env, '/h', bad)).toThrow(/is not a device id/)
  })

  it('two owners never share a daemon instance', () => {
    const before = process.env.WALNUT_TUNNEL_DAEMON_DIR
    process.env.WALNUT_TUNNEL_DAEMON_DIR = '/tmp/walnut-tunnel-unit-never-started'
    resetTunnelDaemonForTest()
    try {
      const a = getTunnelDaemon('mac-a')
      expect(getTunnelDaemon('mac-a')).toBe(a)
      const b = getTunnelDaemon('mac-b')
      const legacy = getTunnelDaemon()
      expect(new Set([a, b, legacy]).size).toBe(3)
    } finally {
      resetTunnelDaemonForTest()
      if (before === undefined) delete process.env.WALNUT_TUNNEL_DAEMON_DIR
      else process.env.WALNUT_TUNNEL_DAEMON_DIR = before
    }
  })
})

describe('the tunnel daemon spawn env', () => {
  // Built without spawning anything: buildSpawnEnv() is the env the spawn uses.
  it('a persistent daemon (the tunnel one) gets no parent watchdog; an isolated one does', async () => {
    const persistent = await new LocalDaemon({ daemonDir: '/tmp/walnut-tunnel-unit-a', persistent: true }).buildSpawnEnv()
    expect(persistent.WALNUT_DAEMON_PARENT_PID).toBeUndefined()
    const isolated = await new LocalDaemon({ daemonDir: '/tmp/walnut-tunnel-unit-b' }).buildSpawnEnv()
    expect(isolated.WALNUT_DAEMON_PARENT_PID).toBe(String(process.pid))
  })

  it('the tunnel daemon keeps its sessions on exit; no other daemon inherits that switch', async () => {
    const before = process.env.WALNUT_DAEMON_KEEP_SESSIONS
    process.env.WALNUT_DAEMON_KEEP_SESSIONS = '1'
    try {
      const plain = await new LocalDaemon({ daemonDir: '/tmp/walnut-tunnel-unit-c' }).buildSpawnEnv()
      expect(plain.WALNUT_DAEMON_KEEP_SESSIONS).toBeUndefined()
      const tunnel = await new LocalDaemon({ daemonDir: '/tmp/walnut-tunnel-unit-d', persistent: true, envOverrides: tunnelDaemonEnv('/tmp/walnut-tunnel-unit-d') }).buildSpawnEnv()
      expect(tunnel.WALNUT_DAEMON_KEEP_SESSIONS).toBe('1')
    } finally {
      if (before === undefined) delete process.env.WALNUT_DAEMON_KEEP_SESSIONS
      else process.env.WALNUT_DAEMON_KEEP_SESSIONS = before
    }
  })

  // The daemon's own switch must stop at the daemon: a CLI that inherited it
  // would hand it to any daemon it starts (a `walnut` run inside a session).
  it.each(['daemon-standalone.ts', 'daemon-source.ts'])('%s strips WALNUT_DAEMON_KEEP_SESSIONS from every CLI it spawns', (file) => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'providers', file), 'utf-8')
    expect(src).toMatch(/WALNUT_DAEMON_PARENT_PID: undefined,\s*(\/\/[^\n]*\n\s*)*WALNUT_DAEMON_KEEP_SESSIONS: undefined,/)
  })
})

describe('the tunnel daemon keeps the Mac sessions when it is replaced', () => {
  it('starts with its own streams, not as the replica, and keeping its sessions on exit', () => {
    expect(tunnelDaemonEnv('/srv/primary-daemon')).toEqual({
      WALNUT_CLOUD_MODE: undefined,
      WALNUT_STREAMS_DIR: '/srv/primary-daemon-streams',
      WALNUT_DAEMON_KEEP_SESSIONS: '1',
    })
  })

  // Both twins: the bun binary a box runs, and the source daemon a box without
  // a binary falls back to. Either one reaping its CLIs on exit would end the
  // Mac's sessions on every companion deploy.
  it.each(['daemon-standalone.ts', 'daemon-source.ts'])('%s never reaps its CLIs on exit when told to keep them', (file) => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'providers', file), 'utf-8')
    expect(src).toMatch(/const KEEP_SESSIONS_ON_EXIT = process\.env\.WALNUT_DAEMON_KEEP_SESSIONS === '1'/)
    expect(src).toMatch(/function shouldReapOnExit\(\)[^{]*\{[\s\S]{0,400}&& !KEEP_SESSIONS_ON_EXIT/)
  })
})

describe('refusals on a real socket', () => {
  let server: http.Server
  let port = 0
  let execOn = true
  let daemonFails = false
  let daemonHangs = false
  let ensured: TunnelCredential[] = []
  const CREDS: Record<string, TunnelCredential> = {
    primary: PRIMARY, phone: PHONE, other: OTHER_MACHINE,
  }

  beforeAll(async () => {
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '')
      void handleDaemonTunnelUpgrade(req, socket, head, {
        verify: async () => (token ? CREDS[token] ?? null : null),
        execEnabled: async () => execOn,
        ensureDaemon: async (cred) => {
          ensured.push(cred)
          if (daemonHangs) return new Promise<string>(() => { /* never */ })
          if (daemonFails) throw new Error('no daemon binary for this platform')
          return 'ws://127.0.0.1:1'
        },
        daemonStartDeadlineMs: 300,
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function dial(token?: string, extra: Record<string, string> = {}): Promise<{ status: number; refusal?: string; body: string }> {
    return new Promise((resolve, reject) => {
      const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }
      const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon-tunnel`, { headers })
      // A hang is a failure here, not a test timeout: the deadline is the point.
      const t = setTimeout(() => { ws.terminate(); reject(new Error('the upgrade hung')) }, 5_000)
      ws.on('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (c: Buffer) => { body += c.toString() })
        res.on('end', () => {
          clearTimeout(t)
          const h = res.headers[TUNNEL_REFUSAL_HEADER]
          resolve({ status: res.statusCode ?? 0, refusal: typeof h === 'string' ? h : undefined, body })
        })
      })
      ws.on('open', () => { clearTimeout(t); ws.close(); reject(new Error('the tunnel opened')) })
      ws.on('error', () => { /* unexpected-response carries the answer */ })
    })
  }

  it('the daemon of the credential that dialled is the one started', async () => {
    ensured = []
    await dial('primary')
    expect(ensured).toEqual([PRIMARY])
  })

  it('a daemon start that never finishes: 503 within the start deadline, never a hang', async () => {
    daemonHangs = true
    try {
      const t0 = Date.now()
      const r = await dial('primary')
      expect(r).toMatchObject({ status: 503, refusal: 'daemon_start_failed' })
      expect(r.body).toMatch(/starting the session daemon took longer than/)
      expect(Date.now() - t0).toBeLessThan(3_000)
    } finally { daemonHangs = false }
  })

  it('a credential probe answers 204 for a machine token and starts nothing', async () => {
    ensured = []
    expect(await dial('primary', { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 204, refusal: 'credential_ok' })
    // Another host's machine token is valid too: the probe asks "is it alive", not "may it tunnel".
    expect(await dial('other', { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 204 })
    expect(await dial('phone', { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 403 })
    expect(await dial('forged', { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 401 })
    expect(await dial(undefined, { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 401 })
    // Hosting off does not change the credential's answer, and nothing started.
    execOn = false
    try {
      expect(await dial('primary', { [TUNNEL_PROBE_HEADER]: 'credential' })).toMatchObject({ status: 204 })
    } finally { execOn = true }
    expect(ensured).toEqual([])
  })

  it('absent token: 401', async () => {
    expect(await dial()).toMatchObject({ status: 401, refusal: 'unauthorized' })
  })

  it('phone device token: 403 not_primary', async () => {
    expect(await dial('phone')).toMatchObject({ status: 403, refusal: 'not_primary' })
  })

  it("another machine's token: 403 not_primary", async () => {
    expect(await dial('other')).toMatchObject({ status: 403, refusal: 'not_primary' })
  })

  it('an unknown token: 401', async () => {
    expect(await dial('forged')).toMatchObject({ status: 401 })
  })

  it('cloud.exec off: 403 cloud_exec_off', async () => {
    execOn = false
    try {
      expect(await dial('primary')).toMatchObject({ status: 403, refusal: 'cloud_exec_off' })
    } finally { execOn = true }
  })

  it('a daemon that cannot start: 503 daemon_start_failed with the reason', async () => {
    daemonFails = true
    try {
      const r = await dial('primary')
      expect(r).toMatchObject({ status: 503, refusal: 'daemon_start_failed' })
      expect(r.body).toContain('no daemon binary')
    } finally { daemonFails = false }
  })

  it('a daemon that started but refuses the loopback socket: 503, never a hang', async () => {
    // ensureDaemon answers ws://127.0.0.1:1, where nothing listens.
    expect(await dial('primary')).toMatchObject({ status: 503, refusal: 'daemon_start_failed' })
  })
})

describe('an open tunnel', () => {
  let server: http.Server
  let daemon: WebSocketServer
  let port = 0
  let execOn = true
  let valid = true
  /** Per-dial overrides, keyed by the bearer the test dials with. */
  const DEPS: Record<string, Partial<TunnelDeps>> = {
    primary: { heartbeatMs: 50 },
    'slow-heartbeat': { heartbeatMs: 60_000 },
  }

  beforeAll(async () => {
    // The "daemon": echoes every frame, the way a reply comes back on the real one.
    daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    daemon.on('connection', (s) => s.on('message', (d, isBinary) => s.send(d, { binary: isBinary })))
    await new Promise<void>((resolve) => daemon.once('listening', () => resolve()))
    const daemonUrl = `ws://127.0.0.1:${(daemon.address() as { port: number }).port}`
    server = http.createServer()
    server.on('upgrade', (req, socket, head) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
      void handleDaemonTunnelUpgrade(req, socket, head, {
        verify: async () => PRIMARY,
        execEnabled: async () => execOn,
        ensureDaemon: async () => daemonUrl,
        stillValid: async () => valid,
        ...DEPS[token],
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => daemon.close(() => resolve()))
  })

  async function open(token: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon-tunnel`, { headers: { Authorization: `Bearer ${token}` } })
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    return ws
  }

  it('a credential revoked in this process closes its open tunnel at once', async () => {
    // A 60s heartbeat: only the revoke listener can close it inside the wait.
    const ws = await open('slow-heartbeat')
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    notifyRevoked(['bridge-devbox']) // another credential: nothing happens
    await new Promise((r) => setTimeout(r, 150))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    const t0 = Date.now()
    notifyRevoked(['bridge-local'])
    expect(await closed).toBe(TUNNEL_CLOSE_REVOKED)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it('a credential revoked by another process closes its tunnel within one heartbeat', async () => {
    const ws = await open('primary')
    await new Promise((r) => setTimeout(r, 200))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    valid = false
    try {
      expect(await closed).toBe(TUNNEL_CLOSE_REVOKED)
    } finally { valid = true }
  })

  it('pipes frames both ways, and closes when hosting is turned off while it is open', async () => {
    const ws = await open('primary')
    const echoed = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())))
    ws.send(JSON.stringify({ type: 'hello' }))
    expect(await echoed).toBe('{"type":"hello"}')

    // Several heartbeats pass with hosting on: the tunnel stays up.
    await new Promise((r) => setTimeout(r, 300))
    expect(ws.readyState).toBe(WebSocket.OPEN)

    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    execOn = false
    try {
      expect(await closed).toBe(TUNNEL_CLOSE_EXEC_OFF)
    } finally { execOn = true }
  })
})
