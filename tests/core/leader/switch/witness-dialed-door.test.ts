/**
 * Way c over call frames (docs/reference/leader-switch.md, "Witnesses on other machines"): a host that
 * reaches its leader only by dialing the leader's door (a Mac behind NAT, the old leader's machine
 * after a switch) serves its witness on that socket. Every piece is real but the daemon: the
 * leader's door (session-channel/host-door.ts) on a loopback port, the host's dialer
 * (host-dialer.ts) proving its machine credential, the host service's leader door
 * (replica/leader-door.ts), which allows `/host-api/witness/` on the dialed socket, and the leader's
 * witness transport (witness-transport.ts hostLinkCall) with the dialed reach registered
 * (reachDialedHosts) and NO daemon link.
 *
 *   - the leader sets the host's witness up, proposes, and reads it back, by host key and by machine id;
 *   - a permit read over the fixed list counts the door witness by way `link`;
 *   - the caller is the credential's Walnut, not the body's: a host service that follows another
 *     Walnut refuses (403), whatever the body claims, and a host with the experiment off answers as
 *     a prefix nobody allowed (403 not_callable, as before), so the leader tries its next way;
 *   - an answer on the dialed socket never takes the daemon link; once the socket is gone, or the host
 *     did not allow the route on it (an older service), the daemon link is the next way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../../helpers/mock-constants.js'

vi.mock('../../../../src/constants.js', () => createMockConstants('walnut-witness-dialed-door'))
// The daemon link, spied: a call the dialed socket answers never takes it; one it cannot answer falls back to it.
const linkCalls = vi.hoisted(() => [] as string[])
vi.mock('../../../../src/core/hosts/link.js', () => ({
  link: async (host: string) => { linkCalls.push(host); throw new Error('no daemon link in this test') },
}))
vi.mock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { olddev: {} } }) }))

import { WALNUT_HOME } from '../../../../src/constants.js'
import { _resetDeviceAuthForTesting } from '../../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../../src/web/middleware/auth-rate-limit.js'
import { mintHostCredential } from '../../../../src/core/session-channel/host-credentials.js'
import { dialedHostCall, handleHostDoorUpgrade, startHostDoor, verifyHostDoorUpgrade } from '../../../../src/core/session-channel/host-door.js'
import { startHostDialer, type HostDialer } from '../../../../src/core/session-channel/host-dialer.js'
import { _resetDoorCallPrefixesForTesting } from '../../../../src/core/session-channel/door-calls.js'
import type { HostChannel } from '../../../../src/core/session-channel/channel.js'
import type { ChannelSocket } from '../../../../src/core/session-channel/leader-links.js'
import { createLeaderDoor, type LeaderDoor } from '../../../../src/replica/leader-door.js'
import type { DeviceCopy } from '../../../../src/host-server/device-copy.js'
import { hostLinkCall, reachDialedHosts, setUpRemoteWitness, type RemoteCallResult } from '../../../../src/core/leader/switch/witness-transport.js'
import { WITNESS_REQUEST_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import { openPermitClient, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { setUpLocalWitnesses } from '../../../../src/core/leader/switch/local-witnesses.js'
import { DEFAULT_PERMIT_PARAMS, genesisConfigId } from '../../../../src/core/leader/permit/index.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'

const MACHINE = 'c7'.repeat(16)
const WALNUT = 'feedface'.repeat(4)
const LIST = ['w1', 'w2', 'w3']

let server: http.Server | null = null
let stopDoor: (() => void) | null = null
let dialer: HostDialer | null = null
let hostService: LeaderDoor | null = null
let unreach: (() => void) | null = null
let adopted: Array<{ hostKey: string; sock: ChannelSocket }> = []
let root = ''
const host = { enabled: true, walnutId: WALNUT as string | null }

beforeEach(async () => {
  _resetDeviceAuthForTesting()
  _resetAuthRateLimitForTesting()
  _resetDoorCallPrefixesForTesting()
  await fsp.rm(path.join(WALNUT_HOME, 'auth.json'), { force: true })
  adopted = []
  host.enabled = true
  host.walnutId = WALNUT
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-dialed-'))
  linkCalls.length = 0
})
afterEach(async () => {
  unreach?.(); unreach = null
  dialer?.stop(); dialer = null
  stopDoor?.(); stopDoor = null
  await hostService?.close(); hostService = null
  server?.closeAllConnections?.()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
  fs.rmSync(root, { recursive: true, force: true })
})

/** The leader's door, the host's service (its witness on disk under `root`) and its dialer, linked. */
async function linked(): Promise<void> {
  stopDoor = await startHostDoor({
    walnutId: async () => WALNUT,
    standing: () => ({ pair: { permitNumber: 3, epoch: 0 }, holder: 'leader-machine' }),
    configured: () => true,
    adopt: (hostKey, sock) => { adopted.push({ hostKey, sock }); return true },
    log: () => {},
  })
  server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    void handleHostDoorUpgrade(req, socket, head, { verify: () => verifyHostDoorUpgrade(url, req) })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/host-door`
  const { verifyKey } = await mintHostCredential({ machineId: MACHINE, walnutId: WALNUT, hostKey: 'olddev' })
  // The host's service: its leader door registers the witness prefix for call frames.
  hostService = createLeaderDoor({
    devices: { put: async () => ({}) } as unknown as DeviceCopy,
    witness: { enabled: async () => host.enabled, walnutId: () => host.walnutId, root: () => root },
  })
  const channel = { attach: () => ({ onFrame: () => {}, onClose: () => {} }) } as unknown as HostChannel
  dialer = startHostDialer({
    walnutId: WALNUT, machineId: async () => MACHINE, enabled: async () => true,
    channel: () => channel, routes: () => null, seenPermit: () => ({ permitNumber: 0, epoch: 0 }),
    readCredential: async () => ({ v: 2, walnutId: WALNUT, machineId: MACHINE, verifyKey, doors: [url], permit: { permitNumber: 0, epoch: 0 }, issuedAt: new Date().toISOString() }),
    backoffMs: () => 50, idleRecheckMs: 1_000, keepDoors: async () => 'same',
  })
  await vi.waitFor(() => expect(adopted.map((a) => a.hostKey)).toEqual(['olddev']), { timeout: 10_000 })
  unreach = await reachDialedHosts()
}

/** The leader's way c with its daemon link allowed (spied above): the dialed socket is tried first. */
const call = hostLinkCall({ daemonLink: true, timeoutMs: 5_000 })
const post = (hostName: string, body: unknown): Promise<RemoteCallResult | null> => new Promise((resolve) => {
  call({ id: 'w3', host: hostName }, WITNESS_REQUEST_PATH, body as never, resolve)
})
const grant = { number: 1, kind: 'grant' as const, holder: 'A', by: 'A', nonce: 'n1', validMs: DEFAULT_PERMIT_PARAMS.validMs, list: LIST, cfg: genesisConfigId(LIST), epoch: 0 }

describe('a witness on a host that dialed the leader\'s door, reached over call frames', () => {
  it('is set up, takes a proposal and reads back, by host key and by machine id, with no daemon link', async () => {
    await linked()
    expect(dialedHostCall('olddev')).not.toBeNull()
    expect(dialedHostCall(MACHINE)).not.toBeNull()
    const set = await setUpRemoteWitness({ id: 'w3', host: 'olddev' }, LIST, WALNUT, blankEvidence(LIST, 'w3'), call, 5_000)
    expect(set).toEqual({ ok: true, made: true })
    expect(fs.existsSync(path.join(root, WALNUT, 'w3', 'permit-record.json'))).toBe(true)
    const p = await post('olddev', { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'propose', record: grant } })
    expect(p?.status).toBe(200)
    expect((p!.body as { reply: unknown }).reply).toMatchObject({ witness: 'w3', ok: true, held: { number: 1 } })
    const r = await post(MACHINE, { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' }, round: 1 })
    expect(r).toMatchObject({ status: 200, body: { ok: true, round: 1, reply: { witness: 'w3', held: { number: 1, holder: 'A' } } } })
    expect(linkCalls).toEqual([])
  })

  it('counts in a permit read of the fixed list by way link', async () => {
    await linked()
    await setUpRemoteWitness({ id: 'w3', host: 'olddev' }, LIST, WALNUT, blankEvidence(LIST, 'w3'), call, 5_000)
    const dirs = { w1: path.join(root, 'local-w1'), w2: path.join(root, 'local-w2') }
    setUpLocalWitnesses([{ id: 'w1', dir: dirs.w1 }, { id: 'w2', dir: dirs.w2 }], LIST)
    const ways = new Map<string, string>()
    const h = openPermitClient('leader-test', [{ id: 'w1', dir: dirs.w1 }, { id: 'w2', dir: dirs.w2 }, { id: 'w3', host: 'olddev' }], DEFAULT_PERMIT_PARAMS, undefined, {
      daemonLink: false, walnutId: WALNUT, onAnswer: (id, way) => { ways.set(id, way) },
    })
    const read = await readStanding(h, 5_000)
    expect(read.answered).toBe(3)
    expect(ways.get('w3')).toBe('link')
    expect(read.standing).toBeNull()
  })

  it('answers the credential\'s Walnut only (the body\'s claim is not looked at), and nothing with the experiment off', async () => {
    await linked()
    await setUpRemoteWitness({ id: 'w3', host: 'olddev' }, LIST, WALNUT, blankEvidence(LIST, 'w3'), call, 5_000)
    // The host's service follows another Walnut than the credential's: refused, though the body names it.
    host.walnutId = 'another-walnut'
    expect((await post('olddev', { v: 1, walnutId: 'another-walnut', witness: 'w3', request: { type: 'read' } }))?.status).toBe(403)
    host.walnutId = WALNUT
    // A body that claims another Walnut is answered as the credential's: the record under WALNUT, and
    // no record is ever looked for (or made) under the claimed one.
    const r = await post('olddev', { v: 1, walnutId: 'claimed-other', witness: 'w3', request: { type: 'read' } })
    expect(r).toMatchObject({ status: 200, body: { ok: true, reply: { witness: 'w3' } } })
    expect(fs.existsSync(path.join(root, 'claimed-other'))).toBe(false)
    // The experiment off on the host: answered as a prefix nobody allowed (as before the witness rode
    // call frames), so the leader goes on to its next way (the daemon link, spied).
    host.enabled = false
    linkCalls.length = 0
    expect(await post('olddev', { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' } })).toBeNull()
    expect(linkCalls).toEqual(['olddev'])
    expect(await dialedHostCall('olddev')!('POST', WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' } }, 5_000)).toEqual({ status: 403, body: { ok: false, error: 'not_callable' } })
  })

  it('once the host\'s socket is gone the reach is gone: the daemon link is the next way', async () => {
    await linked()
    dialer!.stop(); dialer = null
    await vi.waitFor(() => expect(dialedHostCall('olddev')).toBeNull(), { timeout: 5_000 })
    expect(await post('olddev', { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' } })).toBeNull()
    expect(linkCalls).toEqual(['olddev'])
  })

  it('a host service that does not allow the witness on its dialed socket (an older one) is no answer there: the daemon link is tried', async () => {
    await linked()
    _resetDoorCallPrefixesForTesting()
    expect(await post('olddev', { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' } })).toBeNull()
    expect(linkCalls).toEqual(['olddev'])
  })
})
