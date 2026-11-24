/**
 * The leader relay (src/core/leader/switch/leader-relay.ts): a candidate that is a host of the leader (the Mac
 * switching back) reaches the witness the leader's machine keeps over its OWN host link, plus the companion's
 * direct door. Real pieces end to end on loopback: the host replica's relay socket (replica/leader-relay-entry.ts),
 * a fake host link under it (a TCP hop the test delays, drops and cuts), the leader's relay door
 * (leader-relay-door.ts) with this machine's real witness door, the real caller and proofs (witness-direct.ts).
 *
 * Also: the way ends with the leader's link, so a majority that needs it is no majority at the commit (the
 * check refuses: target-job.ts); and nothing on the candidate's side builds a link (the link module is a spy).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const spy = vi.hoisted(() => ({ links: [] as string[] }))
// Nothing on the candidate's side may open a leader link: the module every daemon link goes through is a spy.
vi.mock('../../../../src/core/hosts/link.js', () => ({ link: async (host: string) => { spy.links.push(host); throw new Error('no link in this test') } }))

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-relay-'))
// The leader's process: its machine id file (its witness root beside it) and its witness door capability.
process.env.WALNUT_MACHINE_ID_FILE = path.join(base, 'a', 'machine-id')
process.env.WALNUT_CAPABILITIES = 'witness-door'

import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/index.js'
import { openPermitClient, proposeAndWait } from '../../../../src/core/leader/switch/permit-ops.js'
import { acceptLeaderRelay } from '../../../../src/core/leader/switch/leader-relay-door.js'
import { commitReach, probeWitnessReach } from '../../../../src/core/leader/switch/witness-reach.js'
import { directWitnessCall } from '../../../../src/core/leader/switch/witness-direct.js'
import { hostLinkCallHere, hostLinkWitnessCall, leaderRelaySocketPath, relayRequest, relaySocketOpener, streamDoorPost, type StreamOpener } from '../../../../src/core/leader/switch/leader-relay.js'
import { listenLeaderRelay, type LeaderRelayListener } from '../../../../src/replica/leader-relay-entry.js'
import { setUpMachineWitness } from '../../../../src/core/leader/switch/witness-route.js'
import { createWitnessDoorRouter } from '../../../../src/web/routes/witness-door.js'
import { WITNESS_DOOR_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import { waysOf } from '../../../../src/core/leader/switch/witness-transport.js'
import { runTargetJob } from '../../../../src/core/leader/switch/target-job.js'
import type { RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'
import type { SwitchSide } from '../../../../src/core/leader/switch/side.js'
import type { CheckReport } from '../../../../src/core/leader/switch/ticket.js'
import { proofSecret } from '../../../../src/utils/hmac-proof.js'
import { emptyState } from '../../../../src/core/standby/target-files.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'

const WALNUT = 'walnut-relay-1'
const LIST = ['w-a', 'w-b', 'w-k']
const keys: Record<string, string> = Object.fromEntries(LIST.map((id) => [id, proofSecret()]))
const roots = { 'w-a': path.join(base, 'a', 'leader-witness'), 'w-b': path.join(base, 'b', 'leader-witness'), 'w-k': path.join(base, 'k', 'leader-witness') }
const here = { machineId: 'machine-m', root: path.join(base, 'm', 'leader-witness'), walnutId: () => WALNUT }

/** The fake host link: a TCP hop into the leader's relay door, which the test delays, drops (no stream) and cuts. */
const fault = { delayMs: 0, refuse: false, cutAfterBytes: -1 }
let linkServer: net.Server
let linkPort = 0
let companion: http.Server
let companionPort = 0
let deadPort = 0
let places: RemoteWitnessPlace[] = []
let relay: LeaderRelayListener | null = null
const socketPath = leaderRelaySocketPath(path.join(base, 'mdaemon'), WALNUT)

/** One stream of the host link: what the Mac's daemon relays to the leader's DaemonConnection. */
const hostLinkStream = (): Promise<net.Socket> => new Promise((resolve, reject) => {
  if (fault.refuse) { reject(new Error('the daemon has no primary')); return }
  setTimeout(() => {
    const s = net.connect(linkPort, '127.0.0.1')
    s.once('connect', () => {
      if (fault.cutAfterBytes >= 0) {
        let n = 0
        const write = s.write.bind(s)
        s.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
          n += Buffer.byteLength(chunk)
          if (n > fault.cutAfterBytes) { s.destroy(); return false }
          return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
        }) as typeof s.write
      }
      resolve(s)
    })
    s.once('error', reject)
  }, fault.delayMs)
})

beforeAll(async () => {
  for (const id of LIST) {
    const r = await setUpMachineWitness(roots[id as keyof typeof roots], { v: 1, walnutId: WALNUT, witness: id, list: LIST, evidence: blankEvidence(LIST, id), key: keys[id] })
    expect(r.status).toBe(200)
  }
  // The leader's side: every stream of the host link goes to its relay door, as from host `mac`.
  linkServer = net.createServer((sock) => acceptLeaderRelay('mac', sock))
  await new Promise<void>((r) => linkServer.listen(0, '127.0.0.1', () => r()))
  linkPort = (linkServer.address() as net.AddressInfo).port
  // The companion's direct door (plain http: allowed to loopback).
  const app = express()
  app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root: roots['w-k'] }))
  companion = http.createServer(app)
  await new Promise<void>((r) => companion.listen(0, '127.0.0.1', () => r()))
  companionPort = (companion.address() as net.AddressInfo).port
  // A door nobody answers at (the leader's and the other dev box's public doors, out of the Mac's reach).
  const s = net.createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))
  deadPort = (s.address() as net.AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  places = [
    { id: 'w-a', machine: 'machine-a', host: 'machine-a', url: `http://127.0.0.1:${deadPort}/a${WITNESS_DOOR_PATH}`, key: keys['w-a'] },
    { id: 'w-b', machine: 'machine-b', host: 'machine-b', url: `http://127.0.0.1:${deadPort}/b${WITNESS_DOOR_PATH}`, key: keys['w-b'] },
    { id: 'w-k', url: `http://127.0.0.1:${companionPort}${WITNESS_DOOR_PATH}`, key: keys['w-k'] },
  ]
})

afterAll(async () => {
  await relay?.close()
  await new Promise<void>((r) => linkServer.close(() => r()))
  await new Promise<void>((r) => { companion.closeAllConnections?.(); companion.close(() => r()) })
  fs.rmSync(base, { recursive: true, force: true })
})

beforeEach(() => { Object.assign(fault, { delayMs: 0, refuse: false, cutAfterBytes: -1 }); spy.links.length = 0 })

const viaRelay = (): StreamOpener => relaySocketOpener(socketPath)
const startRelay = async (linked = true) => {
  await relay?.close()
  relay = await listenLeaderRelay({ openToLeader: hostLinkStream, linked: () => linked, log: () => {} }, { socketPath, uid: process.getuid?.() ?? null })
  expect(relay).not.toBeNull()
}

describe('the ways with a host link', () => {
  it('tries the leader\'s machine over the host link before a direct door, only for a witness another machine keeps by its key', () => {
    const hostLink = () => {}
    expect(waysOf(places[0]!, { here, hostLink, direct: () => {} })).toEqual(['host-link', 'direct'])
    expect(waysOf(places[2]!, { here, hostLink, direct: () => {} })).toEqual(['direct'])
    expect(waysOf({ id: 'w-a', machine: 'machine-m', key: 'k' }, { here, hostLink })).toEqual(['here'])
    expect(waysOf({ id: 'w-a', machine: 'machine-a' }, { here, hostLink })).toEqual([])
    // Without the call (every process but a candidate's probe) there is no such way.
    expect(waysOf(places[0]!, { here, direct: () => {} })).toEqual(['direct'])
  })
})

describe('the relay socket of a host replica', () => {
  it('is its account\'s only (0600 in a 0700 dir) and carries one exchange per connection to the leader', async () => {
    await startRelay()
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700)
    // A path the relay door does not have: answered by the door itself (so the bytes went the whole way).
    const r = await relayRequest(viaRelay(), 'POST', '/somewhere-else', {}, 5_000)
    expect(r.status).toBe(404)
  })

  it('closes a connection when its follower link does not follow, or the daemon has no primary to give a stream to', async () => {
    await startRelay(false)
    await expect(relayRequest(viaRelay(), 'POST', '/leader-witness/challenge', {}, 5_000)).rejects.toThrow()
    await startRelay()
    fault.refuse = true
    await expect(relayRequest(viaRelay(), 'POST', '/leader-witness/challenge', {}, 5_000)).rejects.toThrow()
  })
})

describe('a candidate that is a host of the leader', () => {
  it('reaches a majority: the leader\'s machine\'s witness over its host link and the companion\'s door, proven with each witness\'s own key', async () => {
    await startRelay()
    const hostLink = await hostLinkCallHere(WALNUT, { ...process.env, WALNUT_DAEMON_DIR: path.join(base, 'mdaemon') })
    expect(hostLink).not.toBeNull()
    const r = await probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, hostLink: hostLink!, waitMs: 6_000 })
    const by = Object.fromEntries(r.witnesses.map((w) => [w.id, w.answered ? w.way : `no: ${w.why}`]))
    expect(by['w-a']).toBe('host-link')
    expect(by['w-k']).toBe('direct')
    // w-b: the leader's machine holds no record of it (no_witness_here over the link), its own door does not answer.
    expect(by['w-b']).toMatch(/^no: /)
    expect(r.majority).toBe(true)
    // Only the companion stands once the leader's link is gone: no majority for the commit.
    expect(commitReach(r)).toBe(1)
    expect(spy.links).toEqual([])
  }, 30_000)

  it('a key the witness does not hold gets no answer over the relay (the relay is trusted with nothing)', async () => {
    await startRelay()
    const wrong = places.map((p) => (p.id === 'w-a' ? { ...p, key: proofSecret() } : p))
    const r = await probeWitnessReach({ places: wrong, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, hostLink: hostLinkWitnessCall(streamDoorPost(viaRelay())), waitMs: 3_000 })
    expect(r.witnesses.find((w) => w.id === 'w-a')?.answered).toBe(false)
  }, 20_000)

  it('the leader stopped (no primary on the daemon): the host link answers nothing, and the probe reaches 1 of 3', async () => {
    await startRelay()
    fault.refuse = true
    const r = await probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, hostLink: hostLinkWitnessCall(streamDoorPost(viaRelay())), waitMs: 3_000 })
    expect(r.answered).toBe(1)
    expect(r.majority).toBe(false)
  }, 20_000)

  it('proposals through the host link and the companion are chosen over a link that delays, drops and cuts (the client resends; a lost post is no answer)', async () => {
    await startRelay()
    // Only through these two ways (a grant here is a test of the transport, not something a candidate sends).
    const opts = { hostLink: hostLinkWitnessCall(streamDoorPost(viaRelay(), 2_000)), direct: directWitnessCall(), walnutId: WALNUT, ways: ['host-link', 'direct'] as const, here }
    const h = openPermitClient('machine-m', places, DEFAULT_PERMIT_PARAMS, undefined, { ...opts, ways: [...opts.ways] })
    fault.delayMs = 400
    expect((await proposeAndWait(h, (c) => c.requestGrant(), 8_000))?.outcome).toBe('chosen')
    // Every stream dropped for a while, then back: the renew is chosen once it is.
    fault.delayMs = 0
    fault.refuse = true
    const renew = proposeAndWait(h, (c) => c.renew(), 8_000)
    setTimeout(() => { fault.refuse = false }, 1_000)
    expect((await renew)?.outcome).toBe('chosen')
    // Each stream cut in the middle of its request body: no answer counts, nothing breaks; then whole again.
    fault.cutAfterBytes = 40
    expect((await proposeAndWait(h, (c) => c.renew(), 2_000))?.outcome).not.toBe('chosen')
    fault.cutAfterBytes = -1
    expect((await proposeAndWait(h, (c) => c.renew(), 8_000))?.outcome).toBe('chosen')
    expect(spy.links).toEqual([])
  }, 60_000)

  it('the check refuses a switch here whose majority needs the host link, naming it (the link ends at the old leader\'s stop, before the commit)', async () => {
    await startRelay()
    const standbyDir = path.join(base, 'm', 'standby')
    const copy = path.join(standbyDir, 'copy')
    fs.mkdirSync(copy, { recursive: true })
    // A standby folder with no batch yet: the check says so and goes on to the witnesses.
    fs.writeFileSync(path.join(standbyDir, 'standby.json'), JSON.stringify(emptyState()))
    fs.writeFileSync(path.join(copy, 'config.yaml'), YAML.stringify({
      experimental: { switchable_leader: true },
      leader_switch: {
        witnesses: places,
        machines: [
          { id: 'machine-a', home: path.join(base, 'a', 'home'), standby_dir: path.join(base, 'a', 'standby'), port: 4901 },
          { id: 'machine-m', home: path.join(base, 'm', 'home'), standby_dir: standbyDir, port: 4902 },
        ],
      },
    }))
    const hostLink = hostLinkWitnessCall(streamDoorPost(viaRelay()))
    const side = {
      machine: { id: 'machine-m', home: path.join(base, 'm', 'home'), standbyDir, port: 4902 },
      runningServer: () => null,
      reachWitnesses: () => probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, hostLink, waitMs: 6_000 }),
    } as unknown as SwitchSide
    const machineFile = path.join(base, 'm', 'machine-id')
    fs.writeFileSync(machineFile, 'machine-m\n')
    const report = await runTargetJob({ standbyDir, switchId: 'S-relay-1', check: true, side, env: { ...process.env, WALNUT_MACHINE_ID_FILE: machineFile } }) as CheckReport
    expect(report.ok).toBe(false)
    expect(report.problems.join('\n')).toMatch(/only through its host link to the leader \(w-a\), which closes at the old leader's stop, before the commit: without it 1 of 3 answer \(2 needed\)/)
    expect(report.reach?.find((w) => w.id === 'w-a')?.way).toBe('host-link')
    expect(spy.links).toEqual([])
  }, 30_000)
})
