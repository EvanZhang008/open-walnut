/**
 * The three ways to a witness behind one transport (witness-transport.ts waysOf): a, the record
 * opened on its own machine; b, its direct door; c, a link to its machine's service. Which ways a
 * place has, the order they are tried, the next way after one that did not answer, and way a and
 * way c reaching the ONE record of a machine under its lock. And the config that names them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PERMIT_PARAMS, type PermitReply } from '../../../../src/core/leader/permit/index.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { createWitnessTransport, setUpRemoteWitness, waysOf, type RemoteCall } from '../../../../src/core/leader/switch/witness-transport.js'
import { parseSwitchSettings, type RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'
import { proofSecret } from '../../../../src/utils/hmac-proof.js'
import { blankEvidence, loopbackCall, startWitnessMachine, type WitnessMachine } from '../../../helpers/witness-machines.js'

const WALNUT = 'walnut-ways-1'
const LIST = ['w1', 'w2', 'w3']
const here = (machineId: string, root: string) => ({ machineId, root, walnutId: () => WALNUT })
const none: RemoteCall = (_p, _path, _b, done) => { done(null) }

describe('which ways a witness has', () => {
  const place: RemoteWitnessPlace = { id: 'w1', machine: 'm1', host: 'box', url: 'https://box/leader-witness', key: 'a'.repeat(64) }
  it('here first (no network), then the direct door, then a link; only those configured and allowed', () => {
    expect(waysOf(place, { here: here('m1', '/r'), direct: none, remote: none })).toEqual(['here', 'direct', 'link'])
    // Another machine: not here.
    expect(waysOf(place, { here: here('m2', '/r'), direct: none, remote: none })).toEqual(['direct', 'link'])
    // A door with no key is no way (nothing to prove with).
    expect(waysOf({ ...place, key: undefined }, { here: here('m2', '/r'), direct: none, remote: none })).toEqual(['link'])
    // A candidate never takes a link.
    expect(waysOf(place, { here: here('m2', '/r'), direct: none, remote: none, ways: ['here', 'direct'] })).toEqual(['direct'])
    expect(waysOf({ id: 'w3', host: 'box' }, { here: here('m2', '/r'), direct: none, remote: none, ways: ['here', 'direct'] })).toEqual([])
  })

  it('a way that does not answer hands the next request to the next way, and the one that answered is kept', () => {
    const used: string[] = []
    const delivered: PermitReply[] = []
    const ticks: Array<() => void> = []
    const reply = (w: string): PermitReply => ({ witness: w, re: 'read', ok: true, held: null, list: LIST, joint: null, cfg: 'c', epoch: 0, progress: null, ops: [], grantable: true })
    const t = createWitnessTransport({
      placeOf: () => ({ id: 'w1', host: 'box', url: 'https://box/x', key: 'a'.repeat(64) }), params: DEFAULT_PERMIT_PARAMS, walnutId: WALNUT,
      direct: (_p, _path, _b, done) => { used.push('direct'); done(null) },
      remote: (_p, _path, b, done) => { used.push('link'); done({ status: 200, body: { ok: true, reply: reply('w1'), round: (b as { round?: number }).round } }) },
      deliver: (r) => delivered.push(r), defer: (fn) => ticks.push(fn),
    })
    for (let i = 0; i < 3; i++) t.send('w1', { type: 'read' })
    while (ticks.length) ticks.shift()!()
    expect(used).toEqual(['direct', 'link', 'link'])
    expect(delivered).toHaveLength(2)
  })
})

describe('way a and way c reach the one record of a machine', () => {
  let base = ''
  let machines: WitnessMachine[] = []
  const rootOf = (m: string) => path.join(base, m, 'leader-witness')
  const PLACES: RemoteWitnessPlace[] = LIST.map((id, i) => ({ id, machine: `m${i + 1}`, host: `m${i + 1}` }))

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-ways-'))
    machines = await Promise.all(PLACES.map((p) => startWitnessMachine({ host: p.host!, root: rootOf(p.machine!), walnutId: WALNUT })))
    const call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
    for (const p of PLACES) expect(await setUpRemoteWitness({ ...p, key: proofSecret() }, LIST, WALNUT, blankEvidence(LIST, p.id), call)).toEqual({ ok: true, made: true })
  })
  afterEach(async () => {
    await Promise.all(machines.map((m) => m.close()))
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('the leader holds over links; a process on m1 opens m1\'s record itself and sees the same holder, and cannot take it', async () => {
    const call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
    const leader = openPermitClient('A', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: call, walnutId: WALNUT })
    expect((await proposeAndWait(leader, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    // On m1, no link at all: m1's own record (way a), m2's and m3's not reachable.
    const onM1 = openPermitClient('B', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { here: here('m1', rootOf('m1')), walnutId: WALNUT, ways: ['here', 'direct'] })
    const read = await readStanding(onM1, 800)
    expect(read.answered).toBe(1)
    expect(read.replies[0]?.held?.holder).toBe('A')
    expect((await proposeAndWait(onM1, (c) => c.requestGrant(), 800))?.outcome).not.toBe('chosen')
    // The record the leader door serves is the one m1's process opened (one file, one lock): the leader still renews on it.
    expect((await proposeAndWait(leader, (c) => c.renew()))?.outcome).toBe('chosen')
    const again = await readStanding(onM1, 800)
    expect(again.replies[0]?.held?.number).toBeGreaterThan(read.replies[0]!.held!.number)
  }, 30_000)
})

describe('the witnesses of leader_switch', () => {
  const machines = [{ id: 'a', home: '/a', standby_dir: '/as', port: 1 }, { id: 'b', home: '/b', standby_dir: '/bs', port: 2 }]
  const parse = (witnesses: unknown[]) => parseSwitchSettings({ witnesses, machines })
  const key = proofSecret()

  it('takes a witness kept by a machine with any of machine, host and url, and its key', () => {
    const r = parse([
      { id: 'w1', machine: 'm1', host: 'h1', key },
      { id: 'w2', url: 'https://box.example/leader-witness/', key },
      { id: 'w3', host: 'h3' },
    ])
    expect(r.problem).toBeUndefined()
    expect(r.settings!.witnesses[1]).toEqual({ id: 'w2', url: 'https://box.example/leader-witness', key })
  })

  it('refuses what would count one machine twice, an open door, and a key init did not mint; a problem never quotes a key', () => {
    const bad = [
      [{ id: 'w1', machine: 'm1' }, { id: 'w2', machine: 'm1' }, { id: 'w3', host: 'h3' }],
      [{ id: 'w1', url: 'http://box.example/leader-witness' }, { id: 'w2', host: 'h' }, { id: 'w3', host: 'h3' }],
      [{ id: 'w1', url: 'https://u:p@box.example/x' }, { id: 'w2', host: 'h' }, { id: 'w3', host: 'h3' }],
      [{ id: 'w1', host: 'h', key: `${key}00` }, { id: 'w2', host: 'h2' }, { id: 'w3', host: 'h3' }],
      [{ id: 'w1', host: 'h', dir: '/y' }, { id: 'w2', host: 'h2' }, { id: 'w3', host: 'h3' }],
      // A witness of this machine is named by the machine, never by a dir beside the others (M3).
      [{ id: 'w1', machine: 'm1', key }, { id: 'w2', url: 'https://box.example/leader-witness', key }, { id: 'w3', dir: '/x' }],
    ]
    for (const b of bad) {
      const r = parse(b)
      expect(r.settings, JSON.stringify(b)).toBeNull()
      expect(r.problem).not.toContain(key)
    }
    // Plain http to loopback only (a tunnel, a test).
    expect(parse([{ id: 'w1', url: 'http://127.0.0.1:9/x' }, { id: 'w2', host: 'h' }, { id: 'w3', host: 'h3' }]).settings).not.toBeNull()
  })
})
