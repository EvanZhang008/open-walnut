/**
 * The door handshake (src/core/session-channel/door-wire.ts v2), both sides proving they hold S with
 * no bearer on the wire:
 *
 *   the leader's door (host-door.ts): an upgrade with no secret; 429 while the address is rate
 *   limited (failed proofs count), 503 when its check throws; a welcome with one proof per key the
 *   host may hold; 4001 on another Walnut, a wrong host proof or any frame before the auth (nothing
 *   adopted, nothing forwarded); 4004 for a machine it keeps no credential for; a pre-auth byte cap
 *   counted on the raw socket (a large frame is cut before ws assembles it) and a timeout; at most
 *   PRE_AUTH_PER_ADDRESS unauthenticated sockets per address and PRE_AUTH_TOTAL in all (429 above);
 *   at most PENDING_PER_MACHINE sockets of one machine from one address waiting (a newer one is
 *   refused, the waiting ones stay)
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
import net from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-door-handshake'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { mintHostCredential } from '../../../src/core/session-channel/host-credentials.js'
import { PENDING_PER_MACHINE, PRE_AUTH_MAX_BYTES, PRE_AUTH_PER_ADDRESS, handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
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
let logs: string[] = []

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  _resetDoorCallPrefixesForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  adopted = []
  standing = { permitNumber: 0, epoch: 3 }
  verifyThrows = false
  logs = []
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
async function leaderDoor(o: { authTimeoutMs?: number; preAuthPerAddress?: number; preAuthTotal?: number } = {}): Promise<string> {
  stopDoor = await startHostDoor({
    walnutId: async () => WALNUT,
    standing: () => ({ pair: standing, holder: 'leader-machine' }),
    configured: () => true,
    adopt: (hostKey, sock) => { adopted.push({ hostKey, sock }); return true },
    authTimeoutMs: o.authTimeoutMs, preAuthPerAddress: o.preAuthPerAddress, preAuthTotal: o.preAuthTotal,
    log: (_l, msg) => { logs.push(msg) },
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
    const good = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted.map((a) => a.hostKey)).toEqual(['devbox']))
    // The door says the auth passed before anything else.
    await vi.waitFor(() => expect(good.frames[0]).toEqual({ ch: 'door', op: 'linked' }))
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
    // Cut on the raw socket (no close frame).
    expect(await big.closed).toBe(1006)
    const slow = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' })
    expect(await slow.closed).toBe(4001)
    // No hello at all.
    const silent = new WebSocket(url)
    expect(await new Promise<number>((r) => silent.on('close', (code) => r(code)))).toBe(4001)
    expect(adopted).toHaveLength(0)
  })

  it(`keeps at most ${PENDING_PER_MACHINE} sockets of one machine from one address waiting: a newer one is refused, the waiting ones stay`, async () => {
    const url = await leaderDoor()
    const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const waiting = []
    for (let i = 0; i < PENDING_PER_MACHINE; i++) waiting.push(await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, auth: 'none' }))
    const newcomer = await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    expect(newcomer.code).toBe(1013)
    await new Promise((r) => setTimeout(r, 100))
    for (const w of waiting) expect(w.ws.readyState).toBe(WebSocket.OPEN)
    // Once they went, the host's own dial gets in.
    for (const w of waiting) { w.ws.close(); await w.closed }
    await doorHandshake(url, { walnutId: WALNUT, machineId: MACHINE, verifyKey })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
  })

  it('cuts a large frame before its auth on the raw socket, before the frame is complete', async () => {
    const url = await leaderDoor()
    const port = Number(new URL(url.replace('ws:', 'http:')).port)
    for (const declared of [16 * 1024, 60 * 1024 * 1024]) {
      logs = []
      // A raw client: the upgrade by hand, then one masked text frame declaring `declared` bytes, of
      // which only 9 KB are sent. It can never be a whole message, so only a cut on the raw bytes
      // closes it (the auth timer is 10 s).
      const sock = net.connect(port, '127.0.0.1')
      const closed = new Promise<boolean>((r) => sock.on('close', () => r(true)))
      sock.on('error', () => {})
      await new Promise<void>((r) => sock.on('connect', () => r()))
      sock.write(`GET /host-door HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
      const answer = await new Promise<string>((r) => sock.once('data', (b: Buffer) => r(b.toString('latin1'))))
      expect(answer.startsWith('HTTP/1.1 101')).toBe(true)
      const header = declared < 65_536
        ? Buffer.from([0x81, 0x80 | 126, declared >> 8, declared & 0xff])
        : Buffer.concat([Buffer.from([0x81, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(declared)); return b })()])
      sock.write(Buffer.concat([header, Buffer.from([1, 2, 3, 4]), Buffer.alloc(9 * 1024, 0x61)]))
      const started = Date.now()
      expect(await closed).toBe(true)
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(logs).toContain('host door: an unauthenticated socket sent more than its handshake; cut')
      // The handshake never saw a message of it.
      expect(logs).not.toContain('host door: closed a socket before its auth')
    }
    expect(adopted).toHaveLength(0)
  })

  it(`lets one address hold at most ${PRE_AUTH_PER_ADDRESS} unauthenticated sockets, and all of them a total, answering 429 above`, async () => {
    const url = await leaderDoor()
    const open: WebSocket[] = []
    for (let i = 0; i < PRE_AUTH_PER_ADDRESS; i++) {
      const ws = new WebSocket(url)
      await new Promise<void>((r) => ws.on('open', () => r()))
      open.push(ws)
    }
    expect(await upgradeStatus(url)).toBe(429)
    // A slot comes back when one closes (or authenticates).
    await new Promise<void>((r) => { open[0]!.on('close', () => r()); open[0]!.close() })
    await vi.waitFor(async () => expect(await upgradeStatus(url)).toBe(101))
    for (const ws of open) ws.close()
    stopDoor?.(); stopDoor = null
    server?.closeAllConnections?.()
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    const small = await leaderDoor({ preAuthPerAddress: 10, preAuthTotal: 2 })
    const two = [new WebSocket(small), new WebSocket(small)]
    await Promise.all(two.map((ws) => new Promise<void>((r) => ws.on('open', () => r()))))
    expect(await upgradeStatus(small)).toBe(429)
    for (const ws of two) ws.close()
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
        if (f.op === 'auth') { out.auths.push(f); ws.send(JSON.stringify({ ch: 'door', op: 'linked' })) }
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
