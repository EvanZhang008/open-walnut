/**
 * DaemonConnection for the cloud box (`__cloudbox__`): the transport is the
 * companion's /daemon-tunnel WebSocket with a bearer header, never ssh.
 *
 * Real pieces: the DaemonConnection class, the replica-side tunnel handler
 * (web/ws/daemon-tunnel.ts) mounted on a loopback HTTP server, and a MockDaemon
 * behind it. Stubbed: the pairing lookup (which companion, which token) and
 * `ssh`, which records any spawn so "no ssh for the cloud box" is an assertion.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-cloud-tunnel-conn'))

const sshCalls = vi.hoisted(() => [] as string[][])
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return {
    ...original,
    spawn: vi.fn((cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'ssh') sshCalls.push(args)
      return original.spawn(cmd, args, opts as never)
    }),
    execFile: vi.fn((cmd: string, ...rest: unknown[]) => {
      if (cmd === 'ssh') sshCalls.push(rest[0] as string[])
      return (original.execFile as (...a: unknown[]) => unknown)(cmd, ...rest)
    }),
  }
})

// The dial target and the credential the Mac would present.
const endpoint = vi.hoisted(() => ({ url: '', token: 'primary-machine-token' }))
vi.mock('../../src/core/hosts/cloud-box-probe.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/hosts/cloud-box-probe.js')>()
  return {
    ...original,
    resolveCloudTunnelEndpoint: vi.fn(async () => ({
      url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, domain: '127.0.0.1', token: endpoint.token,
    })),
    // The credential recovery around the dial is pinned in cloud-box-probe.test.ts.
    openCloudTunnel: vi.fn(async (connect: (e: { url: string; headers: Record<string, string>; domain: string; token: string }) => Promise<void>) => connect({
      url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` }, domain: '127.0.0.1', token: endpoint.token,
    })),
    refreshCloudBoxHost: vi.fn(async () => null),
  }
})

import { DaemonConnection, pingPayloadSentAt, probeDaemonLiveness } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../helpers/silent-link-proxy.js'
import { handleDaemonTunnelUpgrade, closeAllDaemonTunnels, liveDaemonTunnelCount } from '../../src/web/ws/daemon-tunnel.js'
import {
  CLOUD_BOX_HOST_ALIAS, CLOUD_BOX_OTHER_MAC_SENTENCE, getCloudBoxState, resetCloudBoxStateForTest, setCloudBoxState, type CloudBoxCapability,
} from '../../src/core/hosts/cloud-box-host.js'
import { openCloudTunnel } from '../../src/core/hosts/cloud-box-probe.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

let daemon: MockDaemon
let server: http.Server
let port = 0
let execOn = true
const seenAuth: Array<string | undefined> = []
/** The companion's heartbeat for tunnels opened from now on (its 30s default when unset). */
let tunnelHeartbeatMs: number | undefined

// The replica's credential check, reduced to a lookup table (the real one is
// exercised against a real auth.json in tests/e2e/cloud-box-tunnel-e2e.test.ts).
const CREDS: Record<string, { name: string; kind: 'device' | 'machine' }> = {
  'primary-machine-token': { name: 'bridge-local', kind: 'machine' },
  'phone-device-token': { name: 'my-phone', kind: 'device' },
}

beforeAll(async () => {
  daemon = await createMockDaemon()
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
  server.on('upgrade', (req, socket, head) => {
    seenAuth.push(req.headers.authorization)
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    void handleDaemonTunnelUpgrade(req, socket, head, {
      verify: async () => (token ? CREDS[token] ?? null : null),
      execEnabled: async () => execOn,
      ensureDaemon: async () => `ws://127.0.0.1:${daemon.port}`,
      stillValid: async () => true,
      ...(tunnelHeartbeatMs ? { heartbeatMs: tunnelHeartbeatMs } : {}),
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  endpoint.url = `ws://127.0.0.1:${port}/daemon-tunnel`
})

afterAll(async () => {
  closeAllDaemonTunnels()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await daemon.stop()
})

let conn: DaemonConnection | null = null

function pair(capability: CloudBoxCapability = 'unknown'): void {
  setCloudBoxState({ domain: `127.0.0.1:${port}`, secure: false, capability, checkedAt: null })
}

beforeEach(() => {
  sshCalls.length = 0
  seenAuth.length = 0
  execOn = true
  endpoint.token = 'primary-machine-token'
  resetCloudBoxStateForTest()
})

afterEach(() => {
  conn?.disconnect()
  conn = null
  closeAllDaemonTunnels()
})

async function waitFor(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('DaemonConnection over the cloud tunnel', () => {
  it('dials the tunnel with the machine bearer, speaks the daemon protocol, and never runs ssh', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    expect(conn.connected).toBe(true)
    expect(seenAuth[0]).toBe('Bearer primary-machine-token')

    const ls = await conn.send('fs.ls', { path: '/' })
    expect(ls.ok).toBe(true)
    // The bulk channel rides the tunnel too, with the same credential.
    await waitFor(() => conn!.bulkChannelActive, 10_000, 'bulk channel through the tunnel')
    expect(seenAuth.every((h) => h === 'Bearer primary-machine-token')).toBe(true)
    expect(liveDaemonTunnelCount()).toBe(2)
    expect(sshCalls).toEqual([])
    // A success records the companion as able to host.
    expect(getCloudBoxState()?.capability).toBe('ready')
  })

  it('reconnects after the tunnel drops, to the same daemon instance', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    const before = conn.daemonInstanceId
    expect(before).toBe(daemon.instanceId)
    const upgradesBefore = seenAuth.length

    closeAllDaemonTunnels() // the network between Mac and companion dies
    await waitFor(() => !conn!.connected, 5_000, 'the drop to be noticed')
    await waitFor(() => conn!.connected, 20_000, 'the reconnect')
    expect(seenAuth.length).toBeGreaterThan(upgradesBefore)
    expect((await conn.send('fs.ls', { path: '/' })).ok).toBe(true)
    // Same daemon process behind the new tunnel: its sessions never moved.
    expect(conn.daemonInstanceId).toBe(before)
    expect(sshCalls).toEqual([])
  }, 30_000)

  it('cloud.exec off: the refusal reads as hosting turned off, and the next connect does not dial', async () => {
    pair()
    execOn = false
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    const err = await conn.connect().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/^Cloud companion has session hosting turned off/)
    expect(classifyHostConnectError(err!.message, '127.0.0.1').kind).toBe('cloud_exec_off')
    expect(getCloudBoxState()?.capability).toBe('exec_off')

    const dials = seenAuth.length
    const again = await conn.connect().then(() => null, (e: Error) => e)
    expect(again?.message).toMatch(/^Cloud companion has session hosting turned off/)
    expect(seenAuth.length).toBe(dials)
    expect(sshCalls).toEqual([])
  })

  it('another Mac connected: the dial still asks the companion, so Retry works once that Mac let go', async () => {
    pair('other_mac')
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    expect(conn.connected).toBe(true)
    expect(seenAuth[0]).toBe('Bearer primary-machine-token')
    expect(getCloudBoxState()?.capability).toBe('ready')
  })

  it('the companion refusing because another Mac holds it: the error is that sentence alone, not a tunnel failure', async () => {
    pair()
    // What openCloudTunnel throws when the companion answers other_mac_connected (cloud-box-probe.ts otherMacConnected).
    vi.mocked(openCloudTunnel).mockRejectedValueOnce(new Error(CLOUD_BOX_OTHER_MAC_SENTENCE))
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    const err = await conn.connect().then(() => null, (e: Error) => e)
    expect(err?.message).toBe(CLOUD_BOX_OTHER_MAC_SENTENCE)
    // Any other dial failure still says the tunnel failed, in cloud words.
    vi.mocked(openCloudTunnel).mockRejectedValueOnce(new Error('WebSocket connection timeout'))
    conn.disconnect()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    const other = await conn.connect().then(() => null, (e: Error) => e)
    expect(other?.message).toBe('Cloud companion tunnel failed: WebSocket connection timeout')
    expect(sshCalls).toEqual([])
  })

  it('an older companion (needs_update) is refused without a dial', async () => {
    pair('needs_update')
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    const err = await conn.connect().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/^Cloud companion needs an update/)
    expect(classifyHostConnectError(err!.message, '127.0.0.1').kind).toBe('cloud_update')
    expect(seenAuth).toEqual([])
    expect(sshCalls).toEqual([])
  })

  it('a phone token is refused as not the primary, in cloud words', async () => {
    pair()
    endpoint.token = 'phone-device-token'
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    const err = await conn.connect().then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/^Cloud companion tunnel failed: the companion did not accept/)
    expect(classifyHostConnectError(err!.message, '127.0.0.1').kind).toBe('cloud_tunnel')
    expect(liveDaemonTunnelCount()).toBe(0)
  })

  it('an unreachable companion reads as a tunnel failure, not an ssh one', async () => {
    pair()
    const saved = endpoint.url
    endpoint.url = 'ws://127.0.0.1:1/daemon-tunnel'
    try {
      conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: '127.0.0.1:1' })
      const err = await conn.connect().then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(/^Cloud companion tunnel failed:/)
      expect(classifyHostConnectError(err!.message, '127.0.0.1').kind).toBe('cloud_tunnel')
      expect(sshCalls).toEqual([])
    } finally {
      endpoint.url = saved
    }
  })

  it('port forwarding is refused plainly on the cloud box', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await expect(conn.ensurePortForward(8080)).rejects.toThrow(/not available on Cloud/)
    expect(sshCalls).toEqual([])
  })
})

describe('the liveness probe (a read that went quiet asks the link)', () => {
  let proxy: SilentLinkProxy
  let saved = ''
  beforeEach(async () => {
    proxy = await startSilentLinkProxy(port)
    saved = endpoint.url
    endpoint.url = `ws://127.0.0.1:${proxy.port}/daemon-tunnel`
  })
  afterEach(async () => {
    endpoint.url = saved
    await proxy.close()
  })

  it('a link that answers is alive at once, and concurrent askers share one probe', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    const t0 = Date.now()
    const a = conn.probeLiveness(2_000)
    const b = conn.probeLiveness(2_000)
    expect(a).toBe(b)
    expect(await a).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(conn.connected).toBe(true)
  })

  it('the cloud box: a silent link is closed within the deadline, and what waits on it fails now, not at its 30s timeout', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    proxy.setMode('blackhole')
    const waiting = conn.send('fs.ls', { path: '/' }).then(() => null, (e: Error) => e)
    const t0 = Date.now()
    expect(await conn.probeLiveness(400)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(conn.connected).toBe(false)
    const err = await waiting
    expect(err?.message).toBe('DaemonConnection not connected to __cloudbox__: the link stopped answering')
    expect(Date.now() - t0).toBeLessThan(1_500)
    // The reconnect loop owns it now; a recovered link brings it back.
    proxy.setMode('pass')
    await waitFor(() => conn!.connected, 20_000, 'the reconnect')
  }, 30_000)

  it('the cloud keepalive: three missed pings fail what waits on the link at once, not at its 30s timeout', async () => {
    // The interval, shortened for the test (8s on the cloud box, 3 misses = 24 to 32s).
    const D = DaemonConnection as unknown as { CLOUD_TUNNEL_PING_INTERVAL_MS: number }
    const interval = D.CLOUD_TUNNEL_PING_INTERVAL_MS
    D.CLOUD_TUNNEL_PING_INTERVAL_MS = 200
    try {
      pair()
      conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
      await conn.connect()
      proxy.setMode('blackhole')
      const t0 = Date.now()
      const err = await conn.send('fs.ls', { path: '/' }).then(() => null, (e: Error) => e)
      expect(err?.message).toBe('DaemonConnection not connected to __cloudbox__: the link stopped answering')
      expect(Date.now() - t0).toBeLessThan(3_000)
      expect(conn.connected).toBe(false)
    } finally {
      D.CLOUD_TUNNEL_PING_INTERVAL_MS = interval
    }
  }, 30_000)

  it('a slow link that still answers is alive (no flap)', async () => {
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    await waitFor(() => conn!.bulkChannelActive, 10_000, 'bulk channel through the tunnel')
    const upgrades = seenAuth.length
    proxy.setMode('slow', { delayMs: 250, bytesPerSec: 32 * 1024 })
    for (let i = 0; i < 3; i++) expect(await conn.probeLiveness(1_500)).toBe(true)
    expect((await conn.send('fs.ls', { path: '/' })).ok).toBe(true)
    expect(conn.connected).toBe(true)
    expect(seenAuth.length).toBe(upgrades)
  }, 30_000)

  it('any other host only hears a silent probe as a missed pong: the link stays (a busy daemon can hold a pong there)', async () => {
    const direct = new DaemonConnection('devbox', null)
    const dproxy = await startSilentLinkProxy(daemon.port)
    try {
      await direct.connectDirect(`ws://127.0.0.1:${dproxy.port}`)
      dproxy.setMode('blackhole')
      expect(await direct.probeLiveness(300)).toBe(false)
      expect(direct.connected).toBe(true)
    } finally {
      direct.disconnect()
      await dproxy.close()
    }
  })

  it('a silent verdict on any other host answers the next reads until a byte arrives, and lapses on its own', async () => {
    const direct = new DaemonConnection('devbox', null)
    const dproxy = await startSilentLinkProxy(daemon.port)
    try {
      await direct.connectDirect(`ws://127.0.0.1:${dproxy.port}`)
      expect(direct.linkSilentRecently(15_000)).toBe(false)
      // Every chunk now takes 1.5s: the pong to the probe arrives after its deadline.
      dproxy.setMode('slow', { delayMs: 1_500, bytesPerSec: 1e9 })
      expect(await direct.probeLiveness(300)).toBe(false)
      expect(direct.linkSilentRecently(15_000)).toBe(true)
      // A verdict lapses (past a 1ms window: asked in the same millisecond it still stands).
      await new Promise((r) => setTimeout(r, 5))
      expect(direct.linkSilentRecently(1)).toBe(false)
      // The late pong is a byte from the daemon: the verdict no longer stands.
      await waitFor(() => !direct.linkSilentRecently(15_000), 5_000, 'the late pong')
      expect(direct.connected).toBe(true)
    } finally {
      direct.disconnect()
      await dproxy.close()
    }
  }, 20_000)

  it('nothing connected: not alive', async () => {
    const idle = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    expect(await idle.probeLiveness(100)).toBe(false)
    expect(await probeDaemonLiveness('never-connected-host', 100)).toBe(false)
  })

  it('a long round trip, measured at the handshake: the probe waits as long as the link needs, so the cloud box is not dropped and re-dialled', async () => {
    // Every chunk waits 700ms each way: a round trip near 1.4s, from the first byte.
    proxy.setMode('slow', { delayMs: 700, bytesPerSec: 1e9 })
    pair()
    conn = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    await conn.connect()
    await waitFor(() => conn!.bulkChannelActive, 20_000, 'bulk channel through the slow tunnel')
    expect(conn.roundTripMs).toBeGreaterThanOrEqual(1_300)
    const upgrades = seenAuth.length
    // The link goes quiet, then a read asks it with a deadline shorter than its round trip.
    await new Promise((r) => setTimeout(r, 1_500))
    expect(await conn.probeLiveness(300)).toBe(true)
    expect(conn.connected).toBe(true)
    expect(seenAuth.length).toBe(upgrades)
  }, 40_000)

  it('any other host: a pong that came late is measured, and the next probe waits for it', async () => {
    const direct = new DaemonConnection('devbox', null)
    const dproxy = await startSilentLinkProxy(daemon.port)
    try {
      await direct.connectDirect(`ws://127.0.0.1:${dproxy.port}`)
      dproxy.setMode('slow', { delayMs: 800, bytesPerSec: 1e9 })
      expect(await direct.probeLiveness(300)).toBe(false)
      await waitFor(() => direct.roundTripMs >= 1_400, 5_000, 'the late pong, measured')
      expect(await direct.probeLiveness(300)).toBe(true)
      expect(direct.linkSilentRecently(15_000)).toBe(false)
      expect(direct.connected).toBe(true)
    } finally {
      direct.disconnect()
      await dproxy.close()
    }
  }, 20_000)

  it('a pong that waited behind a reply timed the queue, not the link: the probe deadline stays as asked', async () => {
    const direct = new DaemonConnection('devbox', null)
    const dproxy = await startSilentLinkProxy(daemon.port)
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-rtt-queue-')), 'big.txt')
    fs.writeFileSync(file, 'x'.repeat(256 * 1024))
    try {
      await direct.connectDirect(`ws://127.0.0.1:${dproxy.port}`)
      // A thin link: the 256KB reply takes about 2.7s, and a ping sent while it
      // streams gets its pong after the reply.
      dproxy.setMode('slow', { delayMs: 20, bytesPerSec: 96 * 1024 })
      const read = direct.send('fs.read', { path: file })
      await new Promise((r) => setTimeout(r, 300))
      // The reply's bytes answer the probe; its pong comes after the reply.
      const probedAt = Date.now()
      expect(await direct.probeLiveness(300)).toBe(true)
      expect((await read).ok).toBe(true)
      await new Promise((r) => setTimeout(r, 500))
      expect(Date.now() - probedAt).toBeGreaterThan(1_500) // the pong did wait (else this pins nothing)
      expect(direct.roundTripMs).toBeLessThan(1_000)
      expect(direct.probeDeadlineMs(3_000)).toBe(3_000)
      // With the link idle, a late pong is the link's own and is still measured.
      dproxy.setMode('slow', { delayMs: 800, bytesPerSec: 1e9 })
      expect(await direct.probeLiveness(300)).toBe(false)
      await waitFor(() => direct.roundTripMs >= 1_400, 5_000, 'the late pong on an idle link, measured')
    } finally {
      direct.disconnect()
      await dproxy.close()
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  }, 30_000)

  it('the link\'s round trip is the longest of the last eight: one quick pong does not forget a slow link, eight do', () => {
    const c = new DaemonConnection('devbox', null)
    c.recordRoundTrip(7_000)
    c.recordRoundTrip(90)
    expect(c.roundTripMs).toBe(7_000)
    expect(c.probeDeadlineMs(3_000)).toBe(14_500)
    for (let i = 0; i < 6; i++) c.recordRoundTrip(90)
    expect(c.roundTripMs).toBe(7_000)
    c.recordRoundTrip(90)
    expect(c.roundTripMs).toBe(90)
    expect(c.probeDeadlineMs(3_000)).toBe(3_000)
  })

  it('a link that is never quiet is timed by its queued pongs after 30s, by the quickest of them', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'))
      const c = new DaemonConnection('devbox', null)
      c.recordRoundTrip(510) // the handshake
      // Every pong waits behind some reply: none is clean, so none counts yet.
      vi.advanceTimersByTime(5_000)
      c.notePongForTest(2_600, true)
      vi.advanceTimersByTime(15_000)
      c.notePongForTest(2_100, true)
      expect(c.roundTripMs).toBe(510)
      // 30s with no clean pong: the quickest queued one is the link's round trip.
      vi.advanceTimersByTime(11_000)
      c.notePongForTest(9_000, true)
      expect(c.roundTripMs).toBe(2_100)
      expect(c.probeDeadlineMs(3_000)).toBe(4_700)
      // The clock starts again: the next queued pongs wait another 30s.
      vi.advanceTimersByTime(1_000)
      c.notePongForTest(7_000, true)
      expect(c.roundTripMs).toBe(2_100)
      vi.advanceTimersByTime(30_000)
      c.notePongForTest(7_200, true)
      expect(c.roundTripMs).toBe(7_000)
      // A clean pong is a sample at once, and so is a stall never.
      c.notePongForTest(300, false)
      expect(c.roundTripMs).toBe(7_000)
      c.notePongForTest(90_000, true)
      vi.advanceTimersByTime(31_000)
      c.notePongForTest(95_000, true)
      expect(c.roundTripMs).toBe(7_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the probe deadline: as asked on a quick link, twice the round trip and half a second more on a slow one, never past 20s', () => {
    const c = new DaemonConnection('devbox', null)
    expect(c.probeDeadlineMs(3_000)).toBe(3_000)
    c.recordRoundTrip(40)
    expect(c.probeDeadlineMs(3_000)).toBe(3_000)
    c.recordRoundTrip(7_000)
    expect(c.probeDeadlineMs(3_000)).toBe(14_500)
    c.recordRoundTrip(25_000)
    expect(c.probeDeadlineMs(3_000)).toBe(20_000)
    // A stall or a sleep is not a round trip.
    const d = new DaemonConnection('devbox', null)
    d.recordRoundTrip(90_000)
    d.recordRoundTrip(-5)
    expect(d.roundTripMs).toBe(0)
    // The ping carries its send time; a pong to anyone else's ping says nothing.
    expect(pingPayloadSentAt(Buffer.from('t1759400000123'))).toBe(1759400000123)
    expect(pingPayloadSentAt(Buffer.from(''))).toBeNull()
    expect(pingPayloadSentAt(Buffer.from('hello'))).toBeNull()
    expect(pingPayloadSentAt(undefined)).toBeNull()
  })
})

/**
 * PROGRESS, not wall time on one socket: a host's two sockets share one
 * physical link (one ssh stream, one bottleneck). The gate measured a 24MB read
 * at 1MB/s cut at 20s every time, and a companion on a 32KB/s shared link
 * dropped 4 times in 180s, because the pong waited behind the bulk socket's
 * bytes and the main socket heard nothing for 3s.
 */
describe('progress on a slow link that is alive', () => {
  let proxy: SilentLinkProxy
  let saved = ''
  let dir = ''
  beforeEach(async () => {
    proxy = await startSilentLinkProxy(port)
    saved = endpoint.url
    endpoint.url = `ws://127.0.0.1:${proxy.port}/daemon-tunnel`
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-link-'))
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024 * 1024, 7))
  })
  afterEach(async () => {
    endpoint.url = saved
    await proxy.close()
    const fs = await import('node:fs')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function connectWithBulk(): Promise<DaemonConnection> {
    pair()
    const c = new DaemonConnection(CLOUD_BOX_HOST_ALIAS, { hostname: `127.0.0.1:${port}` })
    conn = c
    await c.connect()
    await waitFor(() => c.bulkChannelActive, 10_000, 'bulk channel through the tunnel')
    return c
  }

  it('the probe counts the bulk socket: on one shared link the main socket hears nothing while a reply streams, and the link is alive', async () => {
    const c = await connectWithBulk()
    proxy.setMode('slow', { delayMs: 5, bytesPerSec: 128 * 1024, shared: true })
    const read = c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 384 * 1024 })
    await new Promise((r) => setTimeout(r, 800))
    const heard = c.heardBytes
    // The pong waits behind ~500KB of base64 on the shared queue: only the bulk socket's bytes arrive.
    expect(await c.probeLiveness(1_500)).toBe(true)
    expect(c.heardBytes).toBeGreaterThan(heard)
    expect(c.connected).toBe(true)
    const res = await read
    expect(res.ok).toBe(true)
    expect(res.bytesRead).toBe(384 * 1024)
  }, 30_000)

  it('the companion keeps the bulk tunnel through a download longer than two of its heartbeats: the Mac pings that socket too', async () => {
    // Shortened for the test: the companion beats every 300ms, the Mac pings every 100ms.
    const D = DaemonConnection as unknown as { CLOUD_TUNNEL_PING_INTERVAL_MS: number }
    const interval = D.CLOUD_TUNNEL_PING_INTERVAL_MS
    D.CLOUD_TUNNEL_PING_INTERVAL_MS = 100
    tunnelHeartbeatMs = 300
    try {
      const c = await connectWithBulk()
      const upgrades = seenAuth.length
      // One ~1.4MB frame at 256KB/s, the link pushing back: the companion's write
      // of it stays in flight for seconds, and its pings wait behind it.
      proxy.setMode('slow', { delayMs: 5, bytesPerSec: 256 * 1024, queueBytes: 64 * 1024 })
      const res = await c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 1024 * 1024 })
      expect(res.ok).toBe(true)
      expect(res.bytesRead).toBe(1024 * 1024)
      expect(c.bulkChannelActive).toBe(true)
      expect(c.connected).toBe(true)
      expect(seenAuth.length).toBe(upgrades)
    } finally {
      D.CLOUD_TUNNEL_PING_INTERVAL_MS = interval
      tunnelHeartbeatMs = undefined
    }
  }, 30_000)

  it('a stuck bulk command is cut at its timeout: the pongs on its socket are not its reply arriving', async () => {
    // The Mac pings both sockets every 50ms: the pongs keep coming on the bulk socket.
    const D = DaemonConnection as unknown as { CLOUD_TUNNEL_PING_INTERVAL_MS: number }
    const interval = D.CLOUD_TUNNEL_PING_INTERVAL_MS
    D.CLOUD_TUNNEL_PING_INTERVAL_MS = 50
    try {
      const c = await connectWithBulk()
      const bulkHeard = () => (c as unknown as { _bulkHeardBytes: number })._bulkHeardBytes
      daemon.swallowNextCommand('fs.readRange')
      const before = bulkHeard()
      const t0 = Date.now()
      const err = await c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 4096 }, 1_000).then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(/daemon command timeout: fs.readRange \(1000ms\)/)
      expect(Date.now() - t0).toBeLessThan(2_500)
      // Its socket was not quiet meanwhile: pongs arrived on it, and were not taken for the reply.
      expect(bulkHeard()).toBeGreaterThan(before)
    } finally {
      D.CLOUD_TUNNEL_PING_INTERVAL_MS = interval
    }
  }, 30_000)

  it('a main-socket reply in line behind a bulk reply on one link outlives its timeout; with nothing ahead of it, its timeout stands', async () => {
    const c = await connectWithBulk()
    proxy.setMode('slow', { delayMs: 5, bytesPerSec: 128 * 1024, shared: true })
    // About 4s of base64 on the shared link, ahead of anything sent after it.
    const big = c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 384 * 1024 })
    await new Promise((r) => setTimeout(r, 300))
    const t0 = Date.now()
    const list = await c.send('fs.ls', { path: dir }, 800)
    expect(list.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThan(800)
    expect((await big).ok).toBe(true)

    // The daemon never answers it: it waits while the bulk reply ahead of it
    // arrives, then its own timeout stands.
    const big2 = c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 256 * 1024 })
    let bigAt = 0
    void big2.then(() => { bigAt = Date.now() })
    await new Promise((r) => setTimeout(r, 300))
    daemon.swallowNextCommand('fs.ls')
    const err = await c.send('fs.ls', { path: dir }, 800).then(() => null, (e: Error) => e)
    const errAt = Date.now()
    expect(err?.message).toMatch(/daemon command timeout: fs.ls \(800ms\)/)
    await big2
    expect(errAt - bigAt).toBeLessThan(2_000)

    // No bulk reply ahead of it: the timeout is the timeout.
    proxy.setMode('blackhole')
    const t2 = Date.now()
    const lost = await c.send('fs.ls', { path: dir }, 800).then(() => null, (e: Error) => e)
    expect(lost?.message).toMatch(/daemon command timeout: fs.ls \(800ms\)/)
    expect(Date.now() - t2).toBeLessThan(1_600)
  }, 40_000)

  it('a main-socket command with no bulk reply ahead: other traffic on the link does not hold it past its timeout', async () => {
    const c = await connectWithBulk()
    daemon.swallowNextCommand('fs.ls')
    // Events stream the whole time (8KB every 100ms, for 3s), but no bulk reply is in flight.
    const pad = 'x'.repeat(8 * 1024)
    const ticker = setInterval(() => daemon.emitEvent('gate-noise', { pad }), 100)
    const stop = setTimeout(() => clearInterval(ticker), 3_000)
    try {
      const heard = c.heardBytes
      const t0 = Date.now()
      const err = await c.send('fs.ls', { path: dir }, 800).then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(/daemon command timeout: fs.ls \(800ms\)/)
      expect(Date.now() - t0).toBeLessThan(1_600)
      // The link was busy meanwhile: that was not this command's reply.
      expect(c.heardBytes - heard).toBeGreaterThan(16 * 1024)
    } finally {
      clearInterval(ticker)
      clearTimeout(stop)
    }
  }, 30_000)

  it('the keepalive hears the bulk socket too: pongs waiting behind a download on one shared link do not drop it', async () => {
    // The Mac pings every 100ms here: three silent ticks on the main socket alone would end the link in 300ms.
    const D = DaemonConnection as unknown as { CLOUD_TUNNEL_PING_INTERVAL_MS: number }
    const interval = D.CLOUD_TUNNEL_PING_INTERVAL_MS
    D.CLOUD_TUNNEL_PING_INTERVAL_MS = 100
    try {
      const c = await connectWithBulk()
      const upgrades = seenAuth.length
      proxy.setMode('slow', { delayMs: 5, bytesPerSec: 128 * 1024, shared: true })
      // About 4s of base64 on the one queue, the main socket's pongs behind it.
      const res = await c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 384 * 1024 })
      expect(res.ok).toBe(true)
      expect(res.bytesRead).toBe(384 * 1024)
      expect(c.connected).toBe(true)
      expect(seenAuth.length).toBe(upgrades)
    } finally {
      D.CLOUD_TUNNEL_PING_INTERVAL_MS = interval
    }
  }, 30_000)

  it('a bulk read whose bytes are still arriving outlives its timeout; one that receives nothing does not', async () => {
    const c = await connectWithBulk()
    proxy.setMode('slow', { delayMs: 5, bytesPerSec: 64 * 1024 })
    const t0 = Date.now()
    // ~340KB of base64 at 64KB/s: about 5s, five times its 1s timeout.
    const res = await c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 256 * 1024 }, 1_000)
    expect(res.ok).toBe(true)
    expect(res.bytesRead).toBe(256 * 1024)
    expect(Date.now() - t0).toBeGreaterThan(2_000)
    // Nothing arrives at all: the timeout is the timeout.
    proxy.setMode('blackhole')
    const t1 = Date.now()
    const err = await c.send('fs.readRange', { path: `${dir}/big.bin`, start: 0, length: 4096 }, 800).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/daemon command timeout: fs.readRange \(800ms\)/)
    expect(Date.now() - t1).toBeLessThan(1_600)
  }, 30_000)
})
