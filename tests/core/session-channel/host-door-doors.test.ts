/**
 * The door list and the call frames of a host-dialed link, against the leader's real door
 * (host-door.ts) and the host's real dialer (host-dialer.ts) and credential file:
 *
 *   - once a socket passed its auth, the door tells the leader's door list (a `doors` frame); the
 *     host keeps it when the welcome's standing is not below what it holds
 *     (updateHostCredentialDoors), and a later `doors` frame (pushDoorsToDialed) is kept the same
 *     way; a lower standing changes nothing
 *   - a door that answers anything but 101 (a 429, a 409, a 503) is passed over for the next one,
 *     and the list is tried round and round with the backoff; `holder` is never checked
 *   - a linked door that answers no ping (a leader gone silent with its socket still open) is closed
 *     and the next door of the list gets the host
 *   - call frames reach only an allowed prefix (door-calls.ts); the credential and doors routes
 *     never, whatever is registered
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../../helpers/silent-link-proxy.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-door-doors'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { mintHostCredential } from '../../../src/core/session-channel/host-credentials.js'
import { handleHostDoorUpgrade, pushDoorsToDialed, startHostDoor, verifyHostDoorUpgrade } from '../../../src/core/session-channel/host-door.js'
import { startHostDialer, type HostDialer } from '../../../src/core/session-channel/host-dialer.js'
import { readHostCredential, updateHostCredentialDoors, writeHostCredentialFile } from '../../../src/core/session-channel/host-credential-file.js'
import { _resetDoorCallPrefixesForTesting, allowDoorCallPrefix, answerDoorCall } from '../../../src/core/session-channel/door-calls.js'
import { setMachineIdHomeForTest } from '../../../src/core/machine-id.js'
import type { HostChannel, PermitPair } from '../../../src/core/session-channel/channel.js'
import type { ChannelSocket } from '../../../src/core/session-channel/leader-links.js'

const MACHINE = 'd4'.repeat(16)
const WALNUT = 'cafebabe'.repeat(4)
const PEER = { walnutId: WALNUT, machineId: MACHINE }
const OTHER_DOOR = 'wss://leader.example.test/host-door'

let home = ''
const servers: http.Server[] = []
let stopDoor: (() => void) | null = null
let dialer: HostDialer | null = null
let adopted: ChannelSocket[] = []
let standing: PermitPair = { permitNumber: 0, epoch: 3 }
let leaderDoors: string[] = []
let proxy: SilentLinkProxy | null = null

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  _resetDoorCallPrefixesForTesting()
  await fs.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  await fs.rm(path.join(WALNUT_HOME, 'auth.json.bak'), { force: true })
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'host-door-doors-'))
  setMachineIdHomeForTest(home)
  adopted = []
  standing = { permitNumber: 0, epoch: 3 }
  leaderDoors = []
})
afterEach(async () => {
  dialer?.stop(); dialer = null
  await proxy?.close(); proxy = null
  stopDoor?.(); stopDoor = null
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise<void>((r) => s.close(() => r())) }
  _resetDoorCallPrefixesForTesting()
  setMachineIdHomeForTest(null)
  await fs.rm(home, { recursive: true, force: true })
})

async function listen(s: http.Server): Promise<number> {
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  return (s.address() as net.AddressInfo).port
}

/** The leader's real door; `holder` is whatever the test says (the host never checks it). */
async function leaderDoor(holder = 'leader-machine'): Promise<string> {
  stopDoor = await startHostDoor({
    walnutId: async () => WALNUT,
    standing: () => ({ pair: standing, holder }),
    doors: async () => leaderDoors,
    configured: () => true,
    adopt: (_k, s) => { adopted.push(s); return true },
    log: () => {},
  })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void handleHostDoorUpgrade(req, socket, head, { verify: () => verifyHostDoorUpgrade(url, req) })
  })
  return `ws://127.0.0.1:${await listen(server)}/host-door`
}

/** A door that answers every upgrade with `status`; the times it was dialed. */
async function refusingDoor(status: number): Promise<{ url: string; dials: () => number }> {
  let n = 0
  const server = http.createServer()
  server.on('upgrade', (_req, socket) => { n++; socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) })
  return { url: `ws://127.0.0.1:${await listen(server)}/host-door`, dials: () => n }
}

/** Issue the credential, and keep it on the host with `doors` and `permit`. */
async function hostHolds(doors: string[], permit: PermitPair = { permitNumber: 0, epoch: 1 }): Promise<void> {
  const minted = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'devbox' })
  expect(minted.record).toMatchObject({ kind: 'machine', issuer: 'leader', machineId: MACHINE, hostKey: 'devbox' })
  const w = await writeHostCredentialFile({ walnutId: WALNUT, machineId: MACHINE, verifyKey: minted.verifyKey, doors, ...permit }, { thisMachine: async () => MACHINE })
  expect(w.ok).toBe(true)
}

const channel = { attach: () => ({ onFrame: () => {}, onClose: () => {} }) } as unknown as HostChannel

function dial(o: { seen?: PermitPair; backoffMs?: number; pingMs?: number; welcomeTimeoutMs?: number } = {}): HostDialer {
  return startHostDialer({
    walnutId: WALNUT, machineId: async () => MACHINE, enabled: async () => true,
    channel: () => channel, routes: () => null, seenPermit: () => o.seen ?? { permitNumber: 0, epoch: 0 },
    backoffMs: () => o.backoffMs ?? 30, idleRecheckMs: 60_000,
    ...(o.pingMs ? { pingMs: o.pingMs } : {}), ...(o.welcomeTimeoutMs ? { welcomeTimeoutMs: o.welcomeTimeoutMs } : {}),
  })
}

describe('the leader\'s door list on the host', () => {
  it('the door tells it once the socket is linked, and the host keeps it with the welcome\'s standing; holder is never checked', async () => {
    const url = await leaderDoor('some-other-machine')
    leaderDoors = [url, OTHER_DOOR]
    await hostHolds([url])
    dialer = dial()
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    await vi.waitFor(async () => expect((await readHostCredential(WALNUT))!.doors).toEqual([url, OTHER_DOOR]))
    expect((await readHostCredential(WALNUT))!.permit).toEqual({ permitNumber: 0, epoch: 3 })
  })

  it('a doors frame on the dialed socket is kept the same way', async () => {
    const url = await leaderDoor()
    await hostHolds([url])
    dialer = dial()
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    expect(pushDoorsToDialed([url, OTHER_DOOR])).toEqual(['devbox'])
    await vi.waitFor(async () => expect((await readHostCredential(WALNUT))!.doors).toEqual([url, OTHER_DOOR]))
  })

  it('is kept only from a standing not below the highest the host holds, never empty or refused', async () => {
    const url = 'ws://127.0.0.1:9/host-door'
    await hostHolds([url], { permitNumber: 1, epoch: 0 })
    expect(await updateHostCredentialDoors(WALNUT, [OTHER_DOOR], { permitNumber: 0, epoch: 9 })).toBe('stale')
    // The fact log saw (2, 0): (1, 5) is below it, whatever the credential holds.
    expect(await updateHostCredentialDoors(WALNUT, [OTHER_DOOR], { permitNumber: 1, epoch: 5 }, { permitNumber: 2, epoch: 0 })).toBe('stale')
    expect(await updateHostCredentialDoors(WALNUT, [], { permitNumber: 1, epoch: 0 })).toBe('bad_doors')
    expect(await updateHostCredentialDoors(WALNUT, ['ws://203.0.113.4/host-door'], { permitNumber: 1, epoch: 0 })).toBe('bad_doors')
    expect((await readHostCredential(WALNUT))!.doors).toEqual([url])
    expect(await updateHostCredentialDoors(WALNUT, [url], { permitNumber: 1, epoch: 0 })).toBe('same')
    expect(await updateHostCredentialDoors(WALNUT, [OTHER_DOOR, url], { permitNumber: 1, epoch: 0 })).toBe('updated')
    expect((await readHostCredential(WALNUT))!.doors).toEqual([OTHER_DOOR, url])
    expect(await updateHostCredentialDoors('0'.repeat(32), [url], { permitNumber: 5, epoch: 0 })).toBe('none')
  })
})

describe('the host\'s dialer and its doors', () => {
  it('passes a door that answers 429, 409 or 503 over for the next, and keeps cycling the list', async () => {
    const limited = await refusingDoor(429)
    const busy = await refusingDoor(409)
    const broken = await refusingDoor(503)
    const url = await leaderDoor()
    await hostHolds([limited.url, busy.url, broken.url, url])
    dialer = dial()
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
    expect([limited.dials(), busy.dials(), broken.dials()]).toEqual([1, 1, 1])
    dialer.stop()
    // A list of refusals only: tried again and again (a rate limit is no dead door).
    await hostHolds([limited.url, busy.url, broken.url])
    dialer = dial({ backoffMs: 20 })
    await vi.waitFor(() => expect(limited.dials()).toBeGreaterThanOrEqual(4), { timeout: 5_000 })
    expect(busy.dials()).toBeGreaterThanOrEqual(3)
    expect(broken.dials()).toBeGreaterThanOrEqual(3)
    expect(dialer.linked()).toBe(false)
  })
})

describe('a linked door that goes silent', () => {
  it('answers no ping, so the host closes it and the next door of the list gets the host', async () => {
    const url = await leaderDoor()
    const port = Number(new URL(url).port)
    proxy = await startSilentLinkProxy(port)
    const viaProxy = `ws://127.0.0.1:${proxy.port}/host-door`
    await hostHolds([viaProxy, url])
    dialer = dial({ pingMs: 100, welcomeTimeoutMs: 500 })
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    // The first door went silent with its socket open (a leader whose lid closed): no pong comes.
    proxy.setMode('blackhole')
    await vi.waitFor(() => expect(adopted).toHaveLength(2), { timeout: 10_000 })
    await vi.waitFor(() => expect(dialer!.linked()).toBe(true))
  })
})

describe('call frames on a host-dialed link', () => {
  it('reach only an allowed prefix; the credential and doors routes never, whatever is registered', async () => {
    const url = await leaderDoor()
    await hostHolds([url])
    dialer = dial()
    await vi.waitFor(() => expect(adopted).toHaveLength(1))
    const sock = adopted[0]!
    const call = (p: string) => sock.call!('POST', p, { walnutId: WALNUT, machineId: MACHINE }, 5_000)
    expect(await call('/host-api/credential')).toEqual({ status: 403, body: { ok: false, error: 'not_callable' } })
    expect(await call('/host-api/doors')).toEqual({ status: 403, body: { ok: false, error: 'not_callable' } })
    expect(await call('/host-api/sessions/../credential')).toEqual({ status: 403, body: { ok: false, error: 'not_callable' } })
    expect(await call('/host-api/witness/read')).toEqual({ status: 403, body: { ok: false, error: 'not_callable' } })
    // The session routes are allowed from the start (this host runs none here: its answer says so).
    expect(await call('/host-api/sessions/send')).toMatchObject({ status: 503 })
    // A peer's prefix, once registered.
    // It is told who called: the Walnut and machine of the credential the leader proved (never the body's word).
    const undo = allowDoorCallPrefix('/host-api/witness/', async (_m, p, b, from) => ({ status: 200, body: { ok: true, path: p, got: b, from } }))
    expect(await sock.call!('POST', '/host-api/witness/read', { walnutId: 'claimed' }, 5_000)).toEqual({ status: 200, body: { ok: true, path: '/host-api/witness/read', got: { walnutId: 'claimed' }, from: PEER } })
    undo()
    expect(await call('/host-api/witness/read')).toMatchObject({ status: 403 })
    // A prefix that would cover a route never callable is refused at registration.
    expect(() => allowDoorCallPrefix('/host-api/credential/')).toThrow(/never callable/)
    expect(() => allowDoorCallPrefix('/host-api/doors/')).toThrow(/never callable/)
    expect(() => allowDoorCallPrefix('/host-api/')).toThrow(/not a door call prefix/)
    // Even a handler registered beside them does not open them.
    allowDoorCallPrefix('/host-api/creds/', async () => ({ status: 200, body: { ok: true } }))
    expect(await answerDoorCall('POST', '/host-api/credential', {}, null, PEER)).toMatchObject({ status: 403 })
    expect(await answerDoorCall('POST', '/host-api/doors/x', {}, null, PEER)).toMatchObject({ status: 403 })
    expect(await answerDoorCall('POST', '/host-api/sessions/send?x=1', {}, null, PEER)).toMatchObject({ status: 403 })
  })
})
