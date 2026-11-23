/**
 * Setting up remote witnesses (witness-setup.ts, the setup route). A setup makes a witness record from
 * nothing, so it must never run beside records that still exist: the named case is the lost witness. A and a
 * witness w2 said yes to A's lease; w2's machine loses its disk; the operator runs `witnesses init` again, which
 * the CLI itself suggests for a witness "not set up". If w2 came back as a fresh witness it would say yes to
 * a second machine too, and that machine plus a witness holding only an old record would be a majority while
 * A's lease is still live: two leaders. With the evidence rule w2 stays unset.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blankEvidence, startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
import { DEFAULT_PERMIT_PARAMS, genesisConfigId, type PermitRecord } from '../../../../src/core/leader/permit/index.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { evidenceFor, setUpRemoteWitnesses, type WitnessSighting } from '../../../../src/core/leader/switch/witness-setup.js'
import { setUpRemoteWitness, type RemoteCall, type RemoteCallResult } from '../../../../src/core/leader/switch/witness-transport.js'
import { WITNESS_REQUEST_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import type { RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

const WALNUT = 'walnut-test-1'
const LIST = ['w1', 'w2', 'w3']
const PLACES: RemoteWitnessPlace[] = LIST.map((id, i) => ({ id, host: `m${i + 1}` }))

let root = ''
let machines: WitnessMachine[] = []
let call: RemoteCall

const post = (host: string, p: string, body: unknown): Promise<RemoteCallResult | null> => new Promise((resolve) => { call({ id: 'x', host }, p, body as never, resolve) })
const readFrom = async (witness: string, host: string) => post(host, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness, request: { type: 'read' }, round: 1 })

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-setup-'))
  machines = await Promise.all(PLACES.map((p) => startWitnessMachine({ host: p.host, root: path.join(root, p.host), walnutId: WALNUT })))
  call = loopbackCall(Object.fromEntries(machines.map((m) => [m.host, m])))
})
afterEach(async () => {
  await Promise.all(machines.map((m) => m.close()))
  fs.rmSync(root, { recursive: true, force: true })
})

async function sightings(): Promise<WitnessSighting[]> {
  const h = openPermitClient('operator', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: call, walnutId: WALNUT })
  const r = await readStanding(h, 1_000)
  return r.replies.map((x) => ({ witness: x.witness, held: x.held !== null, epoch: x.epoch }))
}

describe('the first setup of a Walnut\'s witnesses', () => {
  it('makes all three when none exists yet, and a second run changes nothing', async () => {
    const first = await setUpRemoteWitnesses({ places: PLACES, list: LIST, walnutId: WALNUT, sightings: await sightings(), call, resolveHost: async (h) => h })
    expect(first.map((r) => [r.witness, r.ok, r.made])).toEqual([['w1', true, true], ['w2', true, true], ['w3', true, true]])
    const again = await setUpRemoteWitnesses({ places: PLACES, list: LIST, walnutId: WALNUT, sightings: await sightings(), call, resolveHost: async (h) => h })
    expect(again.map((r) => [r.witness, r.ok, r.made])).toEqual([['w1', true, false], ['w2', true, false], ['w3', true, false]])
  })

  it('evidence is what the caller saw at the others: nothing answered is none, a genesis record is blank, a held record or a generation is a record', () => {
    expect(evidenceFor(LIST, 'w1', [{ witness: 'w2', held: false, epoch: 0 }, { witness: 'w3', held: true, epoch: 0 }])).toEqual([{ witness: 'w2', seen: 'blank' }, { witness: 'w3', seen: 'record' }])
    expect(evidenceFor(LIST, 'w1', [{ witness: 'w2', held: false, epoch: 2 }])).toEqual([{ witness: 'w2', seen: 'record' }, { witness: 'w3', seen: 'none' }])
  })
})

describe('a witness that lost its disk is not made again beside records that still exist (named case)', () => {
  async function aHoldsThroughAllThree(): Promise<void> {
    await setUpRemoteWitnesses({ places: PLACES, list: LIST, walnutId: WALNUT, sightings: [], call, resolveHost: async (h) => h })
    const a = openPermitClient('A', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: call, walnutId: WALNUT })
    expect((await proposeAndWait(a, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    expect(a.client.mayAct()).toBe(true)
    // w2's machine loses its state dir.
    fs.rmSync(path.join(root, 'm2'), { recursive: true, force: true })
  }
  const bGrant = (witness: string): unknown => ({
    v: 1, walnutId: WALNUT, witness,
    request: { type: 'propose', record: { number: 1, kind: 'grant', holder: 'B', by: 'B', nonce: 'nb', validMs: DEFAULT_PERMIT_PARAMS.validMs, list: LIST, cfg: genesisConfigId(LIST), epoch: 0 } satisfies PermitRecord },
  })

  it('the operator\'s rerun leaves w2 unset, so it never says yes to a second machine', async () => {
    await aHoldsThroughAllThree()
    const reports = await setUpRemoteWitnesses({ places: PLACES, list: LIST, walnutId: WALNUT, sightings: await sightings(), call, resolveHost: async (h) => h })
    const w2 = reports.find((r) => r.witness === 'w2')!
    expect(w2.ok).toBe(false)
    expect(w2.error).toMatch(/other witnesses hold records \(w1, w3\)/)
    // The witness itself refuses the same setup when a caller leaves the evidence out or claims no record was seen.
    expect(await post('m2', '/host-api/witness/setup', { v: 1, walnutId: WALNUT, witness: 'w2', list: LIST })).toMatchObject({ status: 400 })
    expect(await post('m2', '/host-api/witness/setup', { v: 1, walnutId: WALNUT, witness: 'w2', list: LIST, evidence: [{ witness: 'w1', seen: 'record' }, { witness: 'w3', seen: 'none' }] })).toEqual({ status: 409, body: { ok: false, error: 'witnesses_hold_records' } })
    // Still no witness: it answers like a path that is not there, and a grant to it is no yes.
    expect(await readFrom('w2', 'm2')).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
    expect(await post('m2', WITNESS_REQUEST_PATH, bGrant('w2'))).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
  })

  it('red control: a setup that takes the caller\'s word that nothing exists (the old route) makes w2 a fresh witness, and it says yes to B', async () => {
    await aHoldsThroughAllThree()
    // What the route did before the evidence rule: any caller of this Walnut could make it.
    expect(await setUpRemoteWitness(PLACES[1]!, LIST, WALNUT, blankEvidence(LIST, 'w2'), call)).toEqual({ ok: true, made: true })
    const reply = ((await readFrom('w2', 'm2'))!.body as { reply: { held: unknown; epoch: number; grantable: boolean } }).reply
    expect(reply).toMatchObject({ held: null, epoch: 0, grantable: true })
    // It has forgotten A's lease: B's record, number 1, is a yes at w2, while w1 and w3 hold A's.
    const b = (await post('m2', WITNESS_REQUEST_PATH, bGrant('w2')))!.body as { reply: { ok: boolean } }
    expect(b.reply.ok).toBe(true)
    const w1 = ((await readFrom('w1', 'm1'))!.body as { reply: { held: { holder: string } } }).reply
    expect(w1.held.holder).toBe('A')
  })
})

describe('two witnesses on one machine', () => {
  it('names that resolve to one machine (an alias and a machine id) are reported and neither is made', async () => {
    const places: RemoteWitnessPlace[] = [{ id: 'w1', host: 'dev-alias' }, { id: 'w2', host: 'm2-machine-id' }, { id: 'w3', host: 'm3' }]
    const calls: string[] = []
    const reports = await setUpRemoteWitnesses({
      places, list: LIST, walnutId: WALNUT, sightings: [], call: (p, _path, _body, done) => { calls.push(p.id); done({ status: 200, body: { ok: true, made: true } }) },
      resolveHost: async (h) => (h === 'm2-machine-id' ? 'dev-alias' : h),
    })
    expect(reports.map((r) => [r.witness, r.ok])).toEqual([['w1', false], ['w2', false], ['w3', true]])
    expect(calls).toEqual(['w3'])
  })
})
