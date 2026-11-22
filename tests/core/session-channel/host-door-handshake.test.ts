/**
 * The door handshake (src/core/session-channel/door-wire.ts), both sides proving who they are:
 * the leader's door (host-door.ts) closes 4001 on a hello naming another Walnut or another
 * machine; the host's dialer (host-dialer.ts) closes on a welcome whose proof is wrong or whose
 * standing is below the highest it has seen, attaches nothing, and does not dial again before its
 * backoff; a host still holding the token a rotation replaced gets in with the proof of THAT
 * token's key.
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
import { mintHostCredential } from '../../../src/core/session-channel/host-credentials.js'
import { handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
import { doorProof } from '../../../src/core/session-channel/door-wire.js'
import { startHostDialer, type HostDialer } from '../../../src/core/session-channel/host-dialer.js'
import type { HostCredential } from '../../../src/core/session-channel/host-credential-file.js'
import type { HostChannel, PermitPair } from '../../../src/core/session-channel/channel.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'
import { _resetDoorCallPrefixesForTesting } from '../../../src/core/session-channel/door-calls.js'

const MACHINE = 'b2'.repeat(16)
const WALNUT = 'deadbeef'.repeat(4)
const NONCE = 'cd'.repeat(32)

let server: http.Server | null = null
let stopDoor: (() => void) | null = null
let dialer: HostDialer | null = null
let fakeDoor: WebSocketServer | null = null
let adopted: ChannelSocket[] = []
let standing: PermitPair = { permitNumber: 0, epoch: 3 }
let leaderDoors: string[] = []

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  adopted = []
  standing = { permitNumber: 0, epoch: 3 }
  leaderDoors = []
  _resetDoorCallPrefixesForTesting()
})
afterEach(async () => {
  dialer?.stop(); dialer = null
  stopDoor?.(); stopDoor = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  await new Promise<void>((r) => (fakeDoor ? fakeDoor.close(() => r()) : r()))
  fakeDoor = null
})

/** The leader's real door on a loopback port. */
async function leaderDoor(): Promise<string> {
  stopDoor = await startHostDoor({
    walnutId: async () => WALNUT,
    standing: () => ({ pair: standing, holder: 'leader-machine' }),
    doors: async () => leaderDoors,
    adopt: (_k, s) => { adopted.push(s); return true },
    log: () => {},
  })
  server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void handleHostDoorUpgrade(req, socket, head, { verify: () => verifyHostDoorUpgrade(url, req) })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  return `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-door`
}

/** A raw host: dial with `token`, send `hello`; the first frame back, or the close code. */
async function rawHello(url: string, token: string, hello: Record<string, unknown>): Promise<{ frame?: any; code?: number }> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } })
  return new Promise((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ ch: 'door', op: 'hello', v: 1, nonce: NONCE, ...hello })))
    ws.on('message', (m) => { resolve({ frame: JSON.parse(String(m)) }); ws.close() })
    ws.on('close', (code) => resolve({ code }))
  })
}

/** A channel that records its attaches (the dialer attaches only after a good welcome). */
function fakeChannel(): { channel: HostChannel; attaches: number } {
  const o = { attaches: 0, channel: null as unknown as HostChannel }
  o.channel = { attach: () => { o.attaches++; return { onFrame: () => {}, onClose: () => {} } } } as unknown as HostChannel
  return o
}

function credential(url: string, token: string, verifyKey: string, permit: PermitPair = { permitNumber: 0, epoch: 0 }): HostCredential {
  return { v: 1, walnutId: WALNUT, machineId: MACHINE, token, verifyKey, doors: [url], permit, issuedAt: new Date().toISOString() }
}

function hostDialer(cred: HostCredential, ch: HostChannel, seen: PermitPair = { permitNumber: 0, epoch: 0 }, backoffMs = 50): HostDialer {
  return startHostDialer({
    walnutId: WALNUT, machineId: async () => MACHINE, enabled: async () => true,
    channel: () => ch, routes: () => null, seenPermit: () => seen,
    readCredential: async () => cred, backoffMs: () => backoffMs, idleRecheckMs: 1_000,
  })
}

describe('the leader\'s door', () => {
  it('welcomes the credential\'s machine of this Walnut, with the proof of the token\'s key', async () => {
    const url = await leaderDoor()
    const { token, verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const r = await rawHello(url, token, { walnutId: WALNUT, machineId: MACHINE })
    expect(r.frame).toMatchObject({ ch: 'door', op: 'welcome', walnutId: WALNUT, holder: 'leader-machine', permitNumber: 0, epoch: 3 })
    expect(r.frame.proof).toBe(doorProof(verifyKey, { nonce: NONCE, walnutId: WALNUT, machineId: MACHINE, permitNumber: 0, epoch: 3 }))
  })

  it('closes 4001 on a hello that names another Walnut, or another machine', async () => {
    const url = await leaderDoor()
    const { token } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    expect(await rawHello(url, token, { walnutId: 'f'.repeat(32), machineId: MACHINE })).toEqual({ code: 4001 })
    expect(await rawHello(url, token, { walnutId: WALNUT, machineId: 'e'.repeat(32) })).toEqual({ code: 4001 })
    expect(adopted).toHaveLength(0)
  })

  it('refuses a token in the URL and a wrong token before the upgrade', async () => {
    const url = await leaderDoor()
    const { token } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const status = (u: string, headers: Record<string, string>) => new Promise<number>((r) => {
      const ws = new WebSocket(u, { headers })
      ws.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0))
      ws.on('open', () => { r(101); ws.close() })
      ws.on('error', () => {})
    })
    expect(await status(`${url}?token=${token}`, {})).toBe(401)
    expect(await status(url, { authorization: `Bearer ${'0'.repeat(64)}` })).toBe(401)
    expect(await status(url, {})).toBe(401)
  })

  it('a host still holding the token a rotation replaced gets in with the proof of that token\'s key', async () => {
    const url = await leaderDoor()
    const first = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const second = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    const r = await rawHello(url, first.token, { walnutId: WALNUT, machineId: MACHINE })
    const f = { nonce: NONCE, walnutId: WALNUT, machineId: MACHINE, permitNumber: 0, epoch: 3 }
    expect(r.frame.proof).toBe(doorProof(first.verifyKey, f))
    expect(r.frame.proof).not.toBe(doorProof(second.verifyKey, f))
    // And the real dialer, holding the old token and key, links.
    const ch = fakeChannel()
    dialer = hostDialer(credential(url, first.token, first.verifyKey), ch.channel)
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    expect(ch.attaches).toBe(1)
    // The raw host's socket and the dialer's, each handed to the leader side.
    await vi.waitFor(() => expect(adopted).toHaveLength(2))
  })
})

describe('the host\'s dialer', () => {
  /** A door that answers every hello with `welcome(hello)`; the times it was dialed, and how each socket closed. */
  async function fake(welcome: (hello: any) => Record<string, unknown>): Promise<{ url: string; dials: number[]; closedByHost: number }> {
    const out = { url: '', dials: [] as number[], closedByHost: 0 }
    fakeDoor = new WebSocketServer({ port: 0, host: '127.0.0.1', path: '/host-door' })
    fakeDoor.on('connection', (ws) => {
      out.dials.push(Date.now())
      ws.on('message', (m) => ws.send(JSON.stringify({ ch: 'door', op: 'welcome', ...welcome(JSON.parse(String(m))) })))
      ws.on('close', () => { out.closedByHost++ })
    })
    await new Promise<void>((r) => fakeDoor!.on('listening', () => r()))
    out.url = `ws://127.0.0.1:${(fakeDoor.address() as { port: number }).port}/host-door`
    return out
  }
  const KEY = '11'.repeat(32)
  const TOKEN = '22'.repeat(32)

  it('links on a good proof and a standing not below what it has seen', async () => {
    const door = await fake((h) => ({ walnutId: WALNUT, holder: 'x', permitNumber: 2, epoch: 1, proof: doorProof(KEY, { nonce: h.nonce, walnutId: WALNUT, machineId: MACHINE, permitNumber: 2, epoch: 1 }) }))
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, TOKEN, KEY), ch.channel, { permitNumber: 1, epoch: 9 })
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    expect(ch.attaches).toBe(1)
  })

  it('closes on a bad proof, attaches nothing, and dials again only after its backoff', async () => {
    const door = await fake((h) => ({ walnutId: WALNUT, holder: 'x', permitNumber: 0, epoch: 1, proof: doorProof('33'.repeat(32), { nonce: h.nonce, walnutId: WALNUT, machineId: MACHINE, permitNumber: 0, epoch: 1 }) }))
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, TOKEN, KEY), ch.channel, { permitNumber: 0, epoch: 0 }, 400)
    await vi.waitFor(() => expect(door.dials.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 })
    expect(ch.attaches).toBe(0)
    expect(dialer.linked()).toBe(false)
    expect(door.closedByHost).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < door.dials.length; i++) expect(door.dials[i]! - door.dials[i - 1]!).toBeGreaterThanOrEqual(350)
  })

  it('closes on a welcome below the highest standing it has seen (the log\'s, or the credential\'s)', async () => {
    const pair = { permitNumber: 1, epoch: 5 }
    const door = await fake((h) => ({ walnutId: WALNUT, holder: 'x', ...pair, proof: doorProof(KEY, { nonce: h.nonce, walnutId: WALNUT, machineId: MACHINE, ...pair }) }))
    const ch = fakeChannel()
    // The log saw (2, 0): (1, 5) is lower, whatever its epoch.
    dialer = hostDialer(credential(door.url, TOKEN, KEY), ch.channel, { permitNumber: 2, epoch: 0 }, 300)
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThanOrEqual(1))
    expect(ch.attaches).toBe(0)
    dialer.stop()
    // The credential was issued at (1, 6): (1, 5) is lower.
    dialer = hostDialer(credential(door.url, TOKEN, KEY, { permitNumber: 1, epoch: 6 }), ch.channel, { permitNumber: 0, epoch: 0 }, 300)
    const before = door.closedByHost
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThan(before))
    expect(ch.attaches).toBe(0)
  })

  it('closes on a welcome from another Walnut', async () => {
    const other = '9'.repeat(32)
    const door = await fake((h) => ({ walnutId: other, holder: 'x', permitNumber: 0, epoch: 1, proof: doorProof(KEY, { nonce: h.nonce, walnutId: other, machineId: MACHINE, permitNumber: 0, epoch: 1 }) }))
    const ch = fakeChannel()
    dialer = hostDialer(credential(door.url, TOKEN, KEY), ch.channel, { permitNumber: 0, epoch: 0 }, 300)
    await vi.waitFor(() => expect(door.closedByHost).toBeGreaterThanOrEqual(1))
    expect(ch.attaches).toBe(0)
  })

  it('stops dialing a door that does not know its token (401) until a new credential is written', async () => {
    const url = await leaderDoor()
    const ch = fakeChannel()
    let cred = credential(url, '44'.repeat(32), KEY)
    let reads = 0
    dialer = startHostDialer({
      walnutId: WALNUT, machineId: async () => MACHINE, enabled: async () => true, channel: () => ch.channel, routes: () => null,
      seenPermit: () => ({ permitNumber: 0, epoch: 0 }), readCredential: async () => { reads++; return cred }, backoffMs: () => 30, idleRecheckMs: 60_000,
    })
    await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(2))
    // After the 401 it waits idle (its recheck is a minute): no dial in a loop.
    const settled = reads
    await new Promise((r) => setTimeout(r, 300))
    expect(reads).toBeLessThanOrEqual(settled + 1)
    const issued = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
    cred = credential(url, issued.token, issued.verifyKey)
    dialer.poke()
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
  })

  it('refuses a door URL that is plain ws:// to a public address', async () => {
    const { doorUrlRefusal } = await import('../../../src/core/session-channel/door-wire.js')
    expect(doorUrlRefusal('ws://203.0.113.5/host-door')).toMatch(/private/)
    expect(doorUrlRefusal('ws://127.0.0.1:9/host-door')).toBeNull()
    expect(doorUrlRefusal('ws://10.1.2.3/host-door')).toBeNull()
    expect(doorUrlRefusal('wss://leader.example.test/host-door')).toBeNull()
    expect(doorUrlRefusal('https://leader.example.test/host-door')).toMatch(/ws/)
    expect(doorUrlRefusal('wss://leader.example.test/host-door?token=x')).toMatch(/query/)
    expect(doorUrlRefusal('wss://u:p@leader.example.test/host-door')).toMatch(/credentials/)
    expect(doorUrlRefusal('wss://leader.example.test/bridge')).toMatch(/path/)
  })
})
