/**
 * The door handshake (src/core/session-channel/door-wire.ts v2), both sides proving they hold S with
 * no bearer on the wire:
 *
 *   the leader's door (host-door.ts): an upgrade with no secret; 429 while the address is rate
 *   limited (failed proofs count), 503 when its check throws; a welcome with one proof per key the
 *   host may hold; 4001 on another Walnut, a wrong host proof or any frame before the auth (nothing
 *   adopted, nothing forwarded); 4004 for a machine it keeps no credential for; a pre-auth byte cap
 *   and timeout; at most PENDING_PER_MACHINE sockets of one machine waiting
 *
 *   the host's dialer (host-dialer.ts): links on a good proof of its own key and a standing not
 *   below what it has seen (holder unchecked); closes on a bad proof, a lower standing or another
 *   Walnut, attaching nothing, dialing again only after its backoff; a door that answers 4004 is
 *   tried again only after DEAD_DOOR_RETRY_MS, and at once with a new key; a host holding the key a
 *   rotation replaced gets in with it
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-door-handshake'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { mintHostCredential } from '../../../src/core/session-channel/host-credentials.js'
import { PENDING_PER_MACHINE, PRE_AUTH_MAX_BYTES, handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
import { doorKeyId, doorUrlRefusal, leaderDoorProof } from '../../../src/core/session-channel/door-wire.js'
import { startHostDialer, type HostDialer } from '../../../src/core/session-channel/host-dialer.js'
import type { HostCredential } from '../../../src/core/session-channel/host-credential-file.js'
import type { HostChannel, PermitPair } from '../../../src/core/session-channel/channel.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import { _resetDoorCallPrefixesForTesting } from '../../../src/core/session-channel/door-calls.js'
import { HOST_NONCE, doorHandshake } from '../../helpers/host-door-client.js'

const MACHINE = 'b2'.repeat(16)
const WALNUT = 'deadbeef'.repeat(4)

let server: http.Server | null = null
let stopDoor: (() => void) | null = null
let dialer: HostDialer | null = null
let fakeDoor: WebSocketServer | null = null
let adopted: Array<{ hostKey: string; sock: ChannelSocket }> = []
let standing: PermitPair = { permitNumber: 0, epoch: 3 }
let verifyThrows = false

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  _resetDoorCallPrefixesForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  adopted = []
  standing = { permitNumber: 0, epoch: 3 }
  verifyThrows = false
})
afterEach(async () => {
  dialer?.stop(); dialer = null
  stopDoor?.(); stopDoor = null
  server?.closeAllConnections?.()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  await new Promise<void>((r) => (fakeDoor ? fakeDoor.close(() => r()) : r()))
  fakeDoor = null
  _resetAuthRateLimitForTesting()
})

/** The leader's real door on a loopback port. */
async function leaderDoor(o: { authTimeoutMs?: number } = {}): Promise<string> {
  stopDoor = await startHostDoor({
    walnutId: async () => WALNUT,
    standing: () => ({ pair: standing, holder: 'leader-machine' }),
    configured: () => true,
    adopt: (hostKey, sock) => { adopted.push({ hostKey, sock }); return true },
    authTimeoutMs: o.authTimeoutMs,
    log: () => {},
  })
  server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void handleHostDoorUpgrade(req, socket, head, { verify: async () => { if (verifyThrows) throw new Error('auth.json is locked'); return verifyHostDoorUpgrade(url, req) } })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-door`
}

/** The HTTP status of an upgrade with no secret (101 when it opened). */
const upgradeStatus = (u: string) => new Promise<number>((r) => {
  const ws = new WebSocket(u)
  ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0))
  ws.on('open', () => { r(101); ws.close() })
  ws.on('error', () => {})
})

/** A channel that records its attaches (the dialer attaches only after a good welcome). */
function fakeChannel(): { channel: HostChannel; attaches: number } {
  const o = { attaches: 0, channel: null as unknown as HostChannel }
  o.channel = { attach: () => { o.attaches++; return { onFrame: () => {}, onClose: () => {} } } } as unknown as HostChannel
  return o
}

function credential(url: string, verifyKey: string, permit: PermitPair = { permitNumber: 0, epoch: 0 }): HostCredential {
  return { v: 2, walnutId: WALNUT, machineId: MACHINE, verifyKey, doors: [url], permit, issuedAt: new Date().toISOString() }
}

function hostDialer(cred: HostCredential | (() => HostCredential), ch: HostChannel, o: { seen?: PermitPair; backoffMs?: number; deadDoorRetryMs?: number } = {}): HostDialer {
  return startHostDialer({
    walnutId: WALNUT, machineId: async () => MACHINE, enabled: async () => true,
    channel: () => ch, routes: () => null, seenPermit: () => o.seen ?? { permitNumber: 0, epoch: 0 },
    readCredential: async () => (typeof cred === 'function' ? cred() : cred), backoffMs: () => o.backoffMs ?? 50, idleRecheckMs: 1_000,
    deadDoorRetryMs: o.deadDoorRetryMs, keepDoors: async () => 'same',
  })
}

describe('the leader\'s door', () => {
  it('welcomes a hello with a proof for each key, and adopts the socket under the record\'s host key only after the host\'s proof', async () => {
    const url = await leaderDoor()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey, auth: 'none' })
    expect(c.welcome).toMatchObject({ ch: 'door', op: 'welcome', walnutId: WALNUT, holder: 'leader-machine', permitNumber: 0, epoch: 3 })
    expect(c.welcome.proofs).toEqual([{ keyId: doorKeyId(verifyKey), proof: leaderDoorProof(verifyKey, { nonceH: HOST_NONCE, nonceD: c.welcome.nonce, walnutId: WALNUT, machineId: MACHINE, permitNumber: 0, epoch: 3 }) }])
    // Nothing is adopted before the host proved it holds S.
    await new Promise((r) => setTimeout(r, 100))
    expect(adopted).toHaveLength(0)
    c.ws.close()
    await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted.map((a) => a.hostKey)).toEqual(['devbox']))
  })

  it('closes 4001 on another Walnut, 4004 for a machine it keeps no credential for', async () => {
    const url = await leaderDoor()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    expect((await doorHandshake(url, { walnutId: 'f'.repeat(32), machineId: MACHINE, verifyKey })).code).toBe(4001)
    expect((await doorHandshake(url, { walnutId: WALNUT, machineId: 'e'.repeat(32), verifyKey })).code).toBe(4004)
    expect(adopted).toHaveLength(0)
  })

  it('closes 4001 on a wrong host proof, and on any frame before the auth, adopting nothing', async () => {
    const url = await leaderDoor()
    await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const wrong = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: '77'.repeat(32) })
    expect(await wrong.closed).toBe(4001)
    // A channel frame (or a call reply) in place of the auth.
    const early = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' })
    early.ws.send(JSON.stringify({ ch: 'sf', op: 'hello', v: 1 }))
    expect(await early.closed).toBe(4001)
    const reply = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' })
    reply.ws.send(JSON.stringify({ ch: 'door', op: 'reply', id: 'x', status: 200, body: {} }))
    expect(await reply.closed).toBe(4001)
    expect(adopted).toHaveLength(0)
  })

  it('caps what an unauthenticated socket may send, and how long it may wait', async () => {
    const url = await leaderDoor({ authTimeoutMs: 300 })
    await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const big = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' })
    big.ws.send('x'.repeat(PRE_AUTH_MAX_BYTES))
    expect(await big.closed).toBe(4001)
    const slow = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' })
    expect(await slow.closed).toBe(4001)
    // No hello at all.
    const silent = new WebSocket(url)
    expect(await new Promise<number>((r) => silent.on('close', (code) => r(code)))).toBe(4001)
    expect(adopted).toHaveLength(0)
  })

  it(`keeps at most ${PENDING_PER_MACHINE} sockets of one machine waiting for their auth: a newer one closes the oldest`, async () => {
    const url = await leaderDoor()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const waiting = []
    for (let i = 0; i <= PENDING_PER_MACHINE; i++) waiting.push(await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' }))
    expect(await waiting[0]!.closed).toBe(4000)
    // The host's own dial still gets in.
    await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
  })

  it('answers 429 once the address is rate limited (failed proofs count), and 503 when its check throws', async () => {
    const url = await leaderDoor()
    await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    expect(await upgradeStatus(url)).toBe(101)
    for (let i = 0; i < 10; i++) {
      const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: (10 + i).toString(16).repeat(32), nonce: (i + 1).toString(16).padStart(2, '0').repeat(32) })
      await c.closed
    }
    expect(await upgradeStatus(url)).toBe(429)
    _resetAuthRateLimitForTesting()
    verifyThrows = true
    expect(await upgradeStatus(url)).toBe(503)
  })

  it('a host still holding the key a rotation replaced gets in with it, and the real dialer links', async () => {
    const url = await leaderDoor()
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const second = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const c = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey: first.verifyKey })
    expect(c.welcome.proofs.map((p: { keyId: string }) => p.keyId)).toEqual([doorKeyId(second.verifyKey), doorKeyId(first.verifyKey)])
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    const ch = fakeChannel()
    dialer = hostDialer(credential(url, first.verifyKey), ch.channel)
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    expect(ch.attaches).toBe(1)
    await vi.waitFor(() => expect(adopted).toHaveLength(2))
  })
})

describe('the host\'s dialer', () => {
  const KEY = '11'.repeat(32)

  /** A door that answers every hello with `welcome(hello, nonceD)`, or closes it with `closeWith`. */
  async function fake(o: { welcome?: (hello: any, nonceD: string) => Record<string, unknown>; closeWith?: number }): Promise<{ url: string; dials: number[]; closedByHost: number; auths: any[] }> {
    const out = { url: '', dials: [] as number[], closedByHost: 0, auths: [] as any[] }
    fakeDoor = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/host-door' })
    fakeDoor.on('connection', (ws) => {
      out.dials.push(Date.now())
      let helloSeen = false
      ws.on('message', (m) => {
        const f = JSON.parse(String(m))
        if (!helloSeen) {
          helloSeen = true
          if (o.closeWith) { ws.close(o.closeWith, 'unknown_credential'); return }
          const nonceD = 'ef'.repeat(32)
          ws.send(JSON.stringify({ ch: 'door', op: 'welcome', nonce: nonceD, ...o.welcome!(f, nonceD) }))
          return
        }
        if (f.op === 'auth') out.auths.push(f)
      })
      ws.on('close', (code) => { if (code === 1000) out.closedByHost++ })
    })
    await new Promise<void>((r) => fakeDoor!.on('listening', () => r()))
    out.url = `ws://127.0.0.1:${(fakeDoor.address() as { port: number }).port}/host-door`
    return out
  }
  const signed = (key: string, pair: PermitPair, walnutId = WALNUT) => (h: any, nonceD: string) => ({
    walnutId, holder: 'whoever', ...pair,
    proofs: [{ keyId: doorKeyId(key), proof: leaderDoorProof(key, { nonceH: h.nonce, nonceD, walnutId, machineId: MACHINE, ...pair }) }],
  })

  it('links on a good proof of its key and a standing not below what it has seen, whoever holds the permit, and answers its auth', async () => {
    const door = await fake({ welcome: signed(KEY, { permitNumber: 2, epoch: 1 }) })
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, KEY), ch.channel, { seen: { permitNumber: 1, epoch: 9 } })
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    expect(ch.attaches).toBe(1)
    await vi.waitFor(() => expect(door.auths).toHaveLength(1))
    expect(door.auths[0]).toMatchObject({ keyId: doorKeyId(KEY) })
    expect(door.auths[0].proof).toMatch(/^[0-9a-f]{64}$/)
  })

  it('closes on a bad proof, attaches nothing, and dials again only after its backoff', async () => {
    const door = await fake({ welcome: signed('33'.repeat(32), { permitNumber: 0, epoch: 1 }) })
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, KEY), ch.channel, { backoffMs: 400 })
    await vi.waitFor(() => expect(door.dials.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 })
    expect(ch.attaches).toBe(0)
    expect(door.auths).toHaveLength(0)
    expect(dialer.linked()).toBe(false)
    for (let i = 1; i < door.dials.length; i++) expect(door.dials[i]! - door.dials[i - 1]!).toBeGreaterThanOrEqual(350)
  })

  it('closes on a welcome below the highest standing it has seen (the log\'s, or the credential\'s)', async () => {
    const door = await fake({ welcome: signed(KEY, { permitNumber: 1, epoch: 5 }) })
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, KEY), ch.channel, { seen: { permitNumber: 2, epoch: 0 }, backoffMs: 300 })
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThanOrEqual(1))
    dialer.stop()
    dialer = hostDialer(credential(door.url, KEY, { permitNumber: 1, epoch: 6 }), ch.channel, { backoffMs: 300 })
    const before = door.closedByHost
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThan(before))
    expect(ch.attaches).toBe(0)
    expect(door.auths).toHaveLength(0)
  })

  it('closes on a welcome from another Walnut', async () => {
    const door = await fake({ welcome: signed(KEY, { permitNumber: 0, epoch: 1 }, '9'.repeat(32)) })
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, KEY), ch.channel, { backoffMs: 300 })
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThanOrEqual(1))
    expect(ch.attaches).toBe(0)
  })

  it('a door that keeps no credential for it (4004) is tried again only slowly, and at once with a new key', async () => {
    const door = await fake({ closeWith: 4004 })
    const ch = fakeChannel()
    let cred = credential(door.url, KEY)
    dialer = hostDialer(() => cred, ch.channel, { backoffMs: 20, deadDoorRetryMs: 600 })
    await vi.waitFor(() => expect(door.dials).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 300))
    expect(door.dials).toHaveLength(1)
    // Not for ever: tried again after its slow retry.
    await vi.waitFor(() => expect(door.dials).toHaveLength(2), { timeout: 3_000 })
    // A new key (the leader issued again): dialed at once.
    cred = credential(door.url, '55'.repeat(32))
    dialer.poke()
    await vi.waitFor(() => expect(door.dials).toHaveLength(3), { timeout: 400 })
  })

  it('refuses a door URL that is plain ws:// to anything but loopback', () => {
    expect(doorUrlRefusal('ws://203.0.113.5/host-door')).toMatch(/loopback/)
    expect(doorUrlRefusal('ws://10.1.2.3/host-door')).toMatch(/loopback/)
    expect(doorUrlRefusal('ws://192.168.1.20/host-door')).toMatch(/loopback/)
    expect(doorUrlRefusal('ws://100.64.0.9/host-door')).toMatch(/loopback/)
    expect(doorUrlRefusal('ws://127.0.0.1:9/host-door')).toBeNull()
    expect(doorUrlRefusal('ws://localhost:9/host-door')).toBeNull()
    expect(doorUrlRefusal('ws://[::1]:9/host-door')).toBeNull()
    expect(doorUrlRefusal('wss://10.1.2.3/host-door')).toBeNull()
    expect(doorUrlRefusal('wss://leader.example.test/host-door')).toBeNull()
    expect(doorUrlRefusal('https://leader.example.test/host-door')).toMatch(/ws/)
    expect(doorUrlRefusal('wss://leader.example.test/host-door?token=x')).toMatch(/query/)
    expect(doorUrlRefusal('wss://u:p@leader.example.test/host-door')).toMatch(/credentials/)
    expect(doorUrlRefusal('wss://leader.example.test/bridge')).toMatch(/path/)
  })
})
