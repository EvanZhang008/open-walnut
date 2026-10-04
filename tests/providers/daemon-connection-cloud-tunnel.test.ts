/**
 * DaemonConnection for the cloud box (`__cloudbox__`): the transport is the
 * companion's /daemon-tunnel WebSocket with a bearer header, never ssh.
 *
 * Real pieces: the DaemonConnection class, the replica-side tunnel handler
 * (web/ws/daemon-tunnel.ts) mounted on a loopback HTTP server, and a MockDaemon
 * behind it. Stubbed: the pairing lookup (which companion, which token) and
 * `ssh`, which records any spawn so "no ssh for the cloud box" is an assertion.
 */
import http from 'node:http'
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

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { handleDaemonTunnelUpgrade, closeAllDaemonTunnels, liveDaemonTunnelCount } from '../../src/web/ws/daemon-tunnel.js'
import {
  CLOUD_BOX_HOST_ALIAS, getCloudBoxState, resetCloudBoxStateForTest, setCloudBoxState, type CloudBoxCapability,
} from '../../src/core/hosts/cloud-box-host.js'
import { classifyHostConnectError } from '../../src/core/sessions/host-connect-hint.js'

let daemon: MockDaemon
let server: http.Server
let port = 0
let execOn = true
const seenAuth: Array<string | undefined> = []

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
