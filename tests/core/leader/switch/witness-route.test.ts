/**
 * A witness served by a machine's Walnut service: the route on the leader door, its record on that
 * machine's disk, the one check that a caller belongs to this Walnut, and the 404 of a machine that
 * is no witness (experiment off, or never set up). Real doors on real loopback sockets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blankEvidence, startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
import { DEFAULT_PERMIT_PARAMS, genesisConfigId, type PermitRecord } from '../../../../src/core/leader/permit/index.js'
import { authorizeWitnessCaller, witnessDir } from '../../../../src/core/leader/switch/witness-route.js'
import { setUpRemoteWitness, type RemoteCallResult } from '../../../../src/core/leader/switch/witness-transport.js'
import { WITNESS_REQUEST_PATH, WITNESS_SETUP_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import { witnessRoot } from '../../../../src/core/leader/switch/machine-id.js'

const LIST = ['w1', 'w2', 'w3']
const WALNUT = 'walnut-test-1'
let root = ''
let m: WitnessMachine
let call: ReturnType<typeof loopbackCall>

const post = (host: string, p: string, body: unknown): Promise<RemoteCallResult | null> => new Promise((resolve) => {
  call({ id: 'x', host }, p, body as never, resolve)
})
const read = (witness: string, walnutId = WALNUT) => post('m1', WITNESS_REQUEST_PATH, { v: 1, walnutId, witness, request: { type: 'read' } })
const grant = (witness: string, number = 1): { v: 1; walnutId: string; witness: string; request: { type: 'propose'; record: PermitRecord } } => ({
  v: 1, walnutId: WALNUT, witness,
  request: {
    type: 'propose',
    record: { number, kind: 'grant', holder: 'A', by: 'A', nonce: 'n1', validMs: DEFAULT_PERMIT_PARAMS.validMs, list: LIST, cfg: genesisConfigId(LIST), epoch: 0 },
  },
})

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-route-'))
  m = await startWitnessMachine({ host: 'm1', root, walnutId: WALNUT })
  call = loopbackCall({ m1: m })
})
afterEach(async () => {
  await m.close()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the witness route of a machine', () => {
  it('serves the witness set up here: a grant is taken, durably, on this machine\'s disk', async () => {
    const set = await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    expect(set).toEqual({ ok: true, made: true })
    const file = path.join(witnessDir(root, WALNUT, 'w1'), 'permit-record.json')
    expect(fs.existsSync(file)).toBe(true)
    const r = await post('m1', WITNESS_REQUEST_PATH, grant('w1'))
    expect(r?.status).toBe(200)
    const reply = (r!.body as { reply: { witness: string; ok: boolean; held: { number: number } } }).reply
    expect(reply).toMatchObject({ witness: 'w1', ok: true, held: { number: 1 } })
    // The record is on disk: a restarted service reads it back.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).held.number).toBe(1)
  })

  it('setting up twice keeps the record', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    await post('m1', WITNESS_REQUEST_PATH, grant('w1'))
    expect(await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)).toEqual({ ok: true, made: false })
    expect(((await read('w1'))!.body as { reply: { held: { number: number } } }).reply.held.number).toBe(1)
  })

  it('answers a caller that names another Walnut with 403, and a service that does not know its Walnut with 503', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    expect((await read('w1', 'another-walnut'))?.status).toBe(403)
    m.walnutId = null
    expect((await read('w1'))?.status).toBe(503)
  })

  it('a machine that was never set up is no witness: it says it holds nothing, and a request never makes a record', async () => {
    const r = await read('w1')
    expect(r).toEqual({ status: 404, body: { ok: false, error: 'no_witness_here' } })
    expect(fs.existsSync(path.join(root, WALNUT))).toBe(false)
  })

  it('a witness directory with a key and no record says nothing of the kind: the plain 404, which is not reached, never absent (M1)', async () => {
    const dir = witnessDir(root, WALNUT, 'w1')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'witness-key'), `${'a'.repeat(64)}\n`, { mode: 0o600 })
    expect(await read('w1')).toEqual({ status: 404, body: { ok: false, error: 'not_found' } })
  })

  it('a read answers with the round it carried, and a propose with none', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    const r = await post('m1', WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' }, round: 7 })
    expect((r!.body as { round?: number }).round).toBe(7)
    const g = await post('m1', WITNESS_REQUEST_PATH, grant('w1'))
    expect((g!.body as { round?: number }).round).toBeUndefined()
    expect((await post('m1', WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' }, round: -1 }))?.status).toBe(400)
  })

  it('a record is stored only when its whole shape is a PermitRecord: a bad list, an unknown field, a wrong type is a 400 and stores nothing', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    const bad = (patch: Record<string, unknown>) => {
      const g = grant('w1')
      return { ...g, request: { ...g.request, record: { ...g.request.record, ...patch } } }
    }
    for (const patch of [{ list: 'w1' }, { list: [1, 2, 3] }, { validMs: -5 }, { validMs: 'long' }, { extra: true }, { ops: { register: 'x' } }, { ops: { other: [] } }, { kind: 'wipe' }, { epoch: 1.5 }, { progress: { seq: 'a', writtenAt: 1 } }, { ledger: [{ id: 'a', state: 'maybe', by: 'x', nonce: 'y' }] }, { stage: 'half' }, { joint: [null] }]) {
      expect((await post('m1', WITNESS_REQUEST_PATH, bad(patch)))?.status, JSON.stringify(patch)).toBe(400)
    }
    expect(((await read('w1'))!.body as { reply: { held: unknown } }).reply.held).toBeNull()
    // Every field a real record carries passes.
    const full = bad({ kind: 'renew', progress: { seq: 3, writtenAt: 1_700_000_000_000, by: 'A' }, ops: { register: ['a'], sent: ['b'], notSent: ['c'] }, clock: 'boottime' })
    expect((await post('m1', WITNESS_REQUEST_PATH, full))?.status).toBe(200)
  })

  it('a setup carries evidence: none is a 400, a record seen or a witness not reached is a 409 and makes nothing, an incomplete list is a 409', async () => {
    const body = { v: 1, walnutId: WALNUT, witness: 'w1', list: LIST }
    expect((await post('m1', WITNESS_SETUP_PATH, body))?.status).toBe(400)
    const seen = (a: string, b: string) => [{ witness: 'w2', seen: a }, { witness: 'w3', seen: b }]
    expect(await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: seen('blank', 'record') })).toEqual({ status: 409, body: { ok: false, error: 'witnesses_hold_records' } })
    expect(await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: [{ witness: 'w2', seen: 'blank' }] })).toEqual({ status: 409, body: { ok: false, error: 'evidence_incomplete' } })
    expect(await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: [{ witness: 'w2', seen: 'blank' }, { witness: 'w2', seen: 'absent' }] })).toEqual({ status: 409, body: { ok: false, error: 'evidence_incomplete' } })
    // One not reached may hold a record: no setup beside it.
    expect(await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: seen('unreached', 'blank') })).toEqual({ status: 409, body: { ok: false, error: 'witnesses_unreached' } })
    expect((await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: seen('none', 'blank') }))?.status).toBe(400)
    expect(fs.existsSync(path.join(root, WALNUT, 'w1'))).toBe(false)
    expect((await post('m1', WITNESS_SETUP_PATH, { ...body, evidence: seen('absent', 'blank') }))?.status).toBe(200)
  })

  it('two setups of different ids at once make exactly one witness: the check and the making are one step', async () => {
    const [a, b] = await Promise.all([
      setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call),
      setUpRemoteWitness({ id: 'w2', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w2'), call),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(fs.readdirSync(path.join(root, WALNUT)).filter((n) => !n.startsWith('.'))).toHaveLength(1)
  })

  it('one witness id per Walnut per machine: another id is refused when one is set up, and is not served', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    const second = await setUpRemoteWitness({ id: 'w2', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w2'), call)
    expect(second).toEqual({ ok: false, error: '409 another_witness_here' })
    expect((await read('w2'))?.status).toBe(404)
  })

  it('a record that is not readable answers ok:false with nothing held, never a yes', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    fs.writeFileSync(path.join(witnessDir(root, WALNUT, 'w1'), 'permit-record.json'), '{"torn')
    const r = await post('m1', WITNESS_REQUEST_PATH, grant('w1'))
    const reply = (r!.body as { reply: { ok: boolean; held: unknown; reason: string } }).reply
    expect(reply.ok).toBe(false)
    expect(reply.held).toBeNull()
    expect(reply.reason).toMatch(/store-broken/)
  })

  it('refuses a body that is not a witness call, a name that is a path, and other methods and paths', async () => {
    await setUpRemoteWitness({ id: 'w1', host: 'm1' }, LIST, WALNUT, blankEvidence(LIST, 'w1'), call)
    expect((await post('m1', WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'wipe' } }))?.status).toBe(400)
    expect((await post('m1', WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: '../w1', request: { type: 'read' } }))?.status).toBe(400)
    expect((await post('m1', WITNESS_SETUP_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', list: ['w1'] }))?.status).toBe(400)
    expect((await post('m1', '/host-api/witness/other', { v: 1 }))?.status).toBe(404)
  })

  it('the one caller check: this Walnut passes, another does not, and an unknown own id answers no one', () => {
    expect(authorizeWitnessCaller({ via: 'leader-door', claimedWalnutId: 'a' }, 'a')).toEqual({ ok: true })
    expect(authorizeWitnessCaller({ via: 'leader-door', claimedWalnutId: 'b' }, 'a')).toMatchObject({ ok: false, status: 403 })
    expect(authorizeWitnessCaller({ via: 'leader-door', claimedWalnutId: 'a' }, null)).toMatchObject({ ok: false, status: 503 })
    // The door of C5a: the credential's own verified Walnut decides, whatever the body claims.
    expect(authorizeWitnessCaller({ via: 'host-door', machineId: 'm', verifiedWalnutId: 'b' }, 'a')).toMatchObject({ ok: false, status: 403 })
    expect(authorizeWitnessCaller({ via: 'host-door', machineId: 'm', verifiedWalnutId: 'a' }, 'a')).toEqual({ ok: true })
  })

  it('keeps its records under the state dir beside the machine id, outside any data home', () => {
    const env = { WALNUT_MACHINE_ID_FILE: '/x/state/open-walnut/machine-id' }
    expect(witnessRoot(env)).toBe('/x/state/open-walnut/leader-witness')
  })
})
