/**
 * A pooled daemon link to a host describes this Walnut to it as its leader (host.slice, leader.configure, the
 * offline drain), so only a server that has led may open one to reach a remote witness (witness-transport.ts
 * `daemonLink`, runtime.ts). The link module is replaced by a spy whose streams go to real witness doors on
 * loopback: a start that never leads, one the witnesses refuse, and a trial start open none; a server that led
 * reaches its witnesses through `link(host)`, `openStream('follower', 'replica')` and one HTTP request on the
 * stream, the production remote path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { blankEvidence, startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/types.js'
import { openPermitClient, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { startPermitRuntime, type PermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { setOutwardDoorChecker } from '../../../../src/core/leader/switch/doors.js'
import { addWitnessReach, closeWitnessLinks, hostLinkCall, setUpRemoteWitness, type RemoteCallResult } from '../../../../src/core/leader/switch/witness-transport.js'
import type { LeaderSwitchSettings, RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

const spy = vi.hoisted(() => ({ links: [] as string[], streams: [] as Array<{ host: string; to: string; purpose: string }>, ports: {} as Record<string, number> }))
// A plain factory (no importActual): with an async one, imports that arrive together get the real module for all but the first.
vi.mock('../../../../src/core/hosts/link.js', () => ({
  link: async (host: string) => {
    spy.links.push(host)
    return {
      openStream: async (to: string, purpose: string) => {
        spy.streams.push({ host, to, purpose })
        return net.connect(spy.ports[host]!, '127.0.0.1')
      },
    }
  },
}))
// Only getConfig is used on this path (resolveWitnessHost: the `hosts` aliases). A plain factory: concurrent first imports of a
// factory that loads the real module beside it do not return in vitest.
vi.mock('../../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ hosts: { m1: {}, m2: {}, m3: {} } }) }))

const WALNUT = 'walnut-test-1'
const LIST = ['w1', 'w2', 'w3']
const PLACES: RemoteWitnessPlace[] = LIST.map((id, i) => ({ id, host: `m${i + 1}` }))

let root = ''
let machines: WitnessMachine[] = []
let settings: LeaderSwitchSettings
const runtimes: PermitRuntime[] = []
const offs: Array<() => void> = []

const start = async (id: string, trial: boolean, net: Record<string, unknown> = { walnutId: WALNUT }) => {
  const home = path.join(root, id, 'home')
  fs.mkdirSync(home, { recursive: true })
  const rt = await startPermitRuntime({ home, holderId: id, settings, trial, net })
  runtimes.push(rt)
  return rt
}
/** A reach to the witness doors: how a not-yet-leader would talk over a door of its own (the seam, not a daemon link). */
const reachToDoors = () => {
  const call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
  const off = addWitnessReach((host, p, body) => new Promise<RemoteCallResult>((resolve, reject) => {
    call({ id: (body as { witness: string }).witness, host }, p, body as never, (r) => (r ? resolve(r) : reject(new Error('no answer'))))
  }))
  offs.push(off)
  return off
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-gate-'))
  spy.links.length = 0
  spy.streams.length = 0
  machines = await Promise.all(PLACES.map((p) => startWitnessMachine({ host: p.host, root: path.join(root, p.host), walnutId: WALNUT })))
  for (const m of machines) spy.ports[m.host] = m.port
  const call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
  for (const p of PLACES) await setUpRemoteWitness(p, LIST, WALNUT, blankEvidence(LIST, p.id), call)
  settings = {
    witnesses: PLACES,
    machines: ['machine-a', 'machine-b'].map((id, i) => ({ id, home: path.join(root, id, 'home'), standbyDir: path.join(root, id, 'standby'), port: 4900 + i })),
    backWindowHours: 24,
    params: { ...DEFAULT_PERMIT_PARAMS },
  }
})
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop()
  for (const off of offs.splice(0)) off()
  setOutwardDoorChecker(null)
  await Promise.all(machines.map((m) => m.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

describe('no leader-describing link before the server has led', () => {
  it('a start that finds no witness it can reach waits, and opens no link while it waits', async () => {
    const rt = await start('machine-a', false)
    expect(rt.decision.kind).toBe('waiting')
    expect(rt.status().state).toBe('waiting')
    expect(await rt.readWitnesses()).toMatchObject({ answered: 0 })
    expect(spy.links).toEqual([])
    expect(spy.streams).toEqual([])
  }, 60_000)

  it('a start the witnesses refuse (another machine leads) sends no leader.configure, host.slice or offline drain: no link was opened, and closing them is a no-op', async () => {
    // Machine B leads, reaching the witnesses through the test's own call.
    const b = await start('machine-b', false, { walnutId: WALNUT, remote: loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m]))) })
    expect(b.decision.kind).toBe('lead')
    reachToDoors()
    const a = await start('machine-a', false)
    expect(a.decision).toMatchObject({ kind: 'refuse', leader: 'machine-b' })
    expect(spy.links).toEqual([])
    expect(spy.streams).toEqual([])
    await closeWitnessLinks()
    expect(spy.links).toEqual([])
  }, 60_000)

  it('a trial start opens none, whatever it reads', async () => {
    const rt = await start('machine-a', true)
    expect(rt.decision.kind).toBe('trial')
    await rt.readWitnesses()
    expect(spy.links).toEqual([])
  }, 60_000)
})

describe('a server that has led reaches its witnesses over the link of each host', () => {
  it('leads over a reach with no link, and once it has led its reads and its release go through link(host) and a follower stream', async () => {
    const off = reachToDoors()
    const a = await start('machine-a', false)
    expect(a.decision.kind).toBe('lead')
    expect(spy.links).toEqual([])
    off()
    const read = await a.readWitnesses()
    expect(read).toMatchObject({ agreed: true, answered: 3, of: 3, standing: { holder: 'machine-a' } })
    expect([...new Set(spy.links)].sort()).toEqual(['m1', 'm2', 'm3'])
    expect(spy.streams.length).toBeGreaterThanOrEqual(3)
    expect(new Set(spy.streams.map((s) => `${s.to}/${s.purpose}`))).toEqual(new Set(['follower/replica']))
    // A planned stop writes its release over the same links.
    const before = spy.streams.length
    await a.stop()
    expect(spy.streams.length).toBeGreaterThan(before)
    const reader = openPermitClient('reader', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m]))), walnutId: WALNUT })
    expect((await readStanding(reader)).standing).toMatchObject({ kind: 'release', by: 'machine-a' })
  }, 90_000)

  it('the production call asks its gate on every call: closed, no link; open, the link', async () => {
    let open = false
    const call = hostLinkCall({ daemonLink: () => open })
    const ask = () => new Promise<RemoteCallResult | null>((resolve) => { call(PLACES[0]!, '/host-api/witness/request', { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' }, round: 1 }, resolve) })
    expect(await ask()).toBeNull()
    expect(spy.links).toEqual([])
    open = true
    const r = await ask()
    expect(r?.status).toBe(200)
    expect((r!.body as { round: number; reply: { witness: string } }).round).toBe(1)
    expect(spy.links).toEqual(['m1'])
    expect(spy.streams).toEqual([{ host: 'm1', to: 'follower', purpose: 'replica' }])
  }, 30_000)

  it('init on a server that has not led sets the hosts up over a registered reach only, never a link (the route\'s daemonLink: leading)', async () => {
    const { setUpRemoteWitnesses } = await import('../../../../src/core/leader/switch/witness-setup.js')
    const input = { places: PLACES, list: LIST, walnutId: WALNUT, sightings: LIST.map((witness) => ({ witness, held: false, epoch: null, absent: true as const })), call: hostLinkCall({ daemonLink: false }), resolveHost: async (h: string) => h }
    // No reach: nothing goes out, and no link is opened.
    expect((await setUpRemoteWitnesses(input)).map((r) => [r.witness, r.ok, r.error])).toEqual(LIST.map((w) => [w, false, expect.stringMatching(/^no answer from \S+ \(before this server leads it opens no link to a host/)]))
    expect(spy.links).toEqual([])
    // A reach (the host-dialed door's seam): the setups go over it (already set up here, so made: false), still no link.
    reachToDoors()
    expect((await setUpRemoteWitnesses(input)).map((r) => [r.witness, r.ok, r.made])).toEqual(LIST.map((w) => [w, true, false]))
    expect(spy.links).toEqual([])
  }, 30_000)
})
