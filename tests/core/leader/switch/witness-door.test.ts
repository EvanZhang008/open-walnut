/**
 * A witness's direct door (way b: witness-door.ts, witness-direct.ts, the companion's route
 * web/routes/witness-door.ts): three real doors behind real TLS on loopback (express routers over
 * records on disk, each witness with its own key), a real permit client over them, and every
 * refusal the door owes. The renew round trip over the direct https doors is measured here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/index.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { createWitnessDoorRouter } from '../../../../src/web/routes/witness-door.js'
import { machineWitnessDoor, doorRequest } from '../../../../src/core/leader/switch/witness-door.js'
import { directWitnessCall, BAD_WITNESS_PROOF, type DoorPost } from '../../../../src/core/leader/switch/witness-direct.js'
import { setUpMachineWitness, witnessDir } from '../../../../src/core/leader/switch/witness-route.js'
import { doorCallerProofText, WITNESS_DOOR_PATH, WITNESS_REQUEST_PATH, type WitnessCall } from '../../../../src/core/leader/switch/witness-wire.js'
import type { RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'
import { hmacProof, proofSecret, sha256Hex } from '../../../../src/utils/hmac-proof.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'
import { httpsDoorPost, makeLoopbackCert, postOnce, startTlsFront, type LoopbackCert, type TlsFront } from '../../../helpers/loopback-tls.js'

const WALNUT = 'walnut-door-1'
const LIST = ['w1', 'w2', 'w3']

let base = ''
let cert: LoopbackCert
const servers: http.Server[] = []
const fronts: TlsFront[] = []
let places: RemoteWitnessPlace[] = []
let post: ReturnType<typeof httpsDoorPost>
const keys: Record<string, string> = {}
const rootOf = (id: string) => path.join(base, id, 'leader-witness')
const recordOf = (id: string) => path.join(witnessDir(rootOf(id), WALNUT, id), 'permit-record.json')

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-door-'))
  cert = makeLoopbackCert(path.join(base, 'tls'))
  post = httpsDoorPost(cert)
  for (const id of LIST) {
    keys[id] = proofSecret()
    expect((await setUpMachineWitness(rootOf(id), { v: 1, walnutId: WALNUT, witness: id, list: LIST, evidence: blankEvidence(LIST, id), key: keys[id] })).status).toBe(200)
    const app = express()
    app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root: rootOf(id) }))
    const server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    servers.push(server)
    const port = (server.address() as net.AddressInfo).port
    const front = await startTlsFront(cert, () => port)
    fronts.push(front)
    places.push({ id, url: `https://127.0.0.1:${front.port}${WITNESS_DOOR_PATH}`, key: keys[id] })
  }
})

afterAll(async () => {
  post?.agent.destroy()
  await Promise.all(fronts.map((f) => f.close()))
  await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()) })))
  fs.rmSync(base, { recursive: true, force: true })
})

const client = (id: string, ps: RemoteWitnessPlace[] = places) => openPermitClient(id, ps, DEFAULT_PERMIT_PARAMS, undefined, { direct: directWitnessCall({ post }), walnutId: WALNUT, ways: ['direct'] })

describe('a permit client over three direct doors on loopback https', () => {
  it('takes the permission, renews it, keeps it with one door down, and measures the renew round trip', async () => {
    const a = client('A')
    expect((await proposeAndWait(a, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    expect(a.client.mayAct()).toBe(true)
    fronts[2]!.setUp(false)
    expect((await proposeAndWait(a, (c) => c.renew()))?.outcome).toBe('chosen')
    fronts[2]!.setUp(true)
    const times: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      expect((await proposeAndWait(a, (c) => c.renew()))?.outcome).toBe('chosen')
      times.push(performance.now() - t0)
    }
    times.sort((x, y) => x - y)
    const stat = { median: times[20]!, p95: times[38]!, max: times[39]! }
    // eslint-disable-next-line no-console
    console.log(`\nrenew round trip over direct https doors on loopback, 3 witnesses, challenge + keyed call each (ms): median ${stat.median.toFixed(1)}, p95 ${stat.p95.toFixed(1)}, max ${stat.max.toFixed(1)}\n`)
    expect(stat.median).toBeLessThan(1_000)
  }, 60_000)

  it('a door that does not prove the witness\'s key over its reply is no answer, whatever it says', async () => {
    // A fake door: hands out nonces and says yes to everything, with a proof it cannot make.
    const fake: DoorPost = (url, _body, done) => {
      if (url.endsWith('/challenge')) done({ status: 200, json: { ok: true, nonce: proofSecret(), ttlMs: 10_000 } })
      else done({ status: 200, json: { ok: true, reply: JSON.stringify({ witness: 'w1', re: 'read', ok: true, held: null, list: LIST, joint: null, cfg: 'c', epoch: 0, progress: null, ops: [], grantable: true }), proof: proofSecret() } })
    }
    const got = await new Promise((resolve) => {
      directWitnessCall({ post: fake })(places[0]!, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } }, resolve)
    })
    expect(got).toEqual({ status: 502, body: { ok: false, error: BAD_WITNESS_PROOF } })
    const dropped: string[] = []
    const h = openPermitClient('F', places.map((p) => p.id === 'w1' ? p : { ...p, url: 'https://127.0.0.1:1' }), DEFAULT_PERMIT_PARAMS, undefined, {
      direct: directWitnessCall({ post: fake }), walnutId: WALNUT, ways: ['direct'], onDrop: (why, d) => dropped.push(`${why}:${d.status}`),
    })
    expect((await readStanding(h, 500)).answered).toBe(0)
    expect(dropped).toContain('bad-status:502')
  })
})

describe('the door refuses, and a refusal never reaches the record', () => {
  /** A request as an attacker would build it: a valid call body for `witness`, its proof under `key`. */
  async function challenge(url: string, call: WitnessCall): Promise<string> {
    const r = await postOnce(post, `${url}/challenge`, { v: 1, walnutId: call.walnutId, witness: call.witness, digest: sha256Hex(JSON.stringify(call)) })
    expect(r?.status).toBe(200)
    return (r!.json as { nonce: string }).nonce
  }
  function signed(call: WitnessCall, nonce: string, key: string, digestOf: WitnessCall = call) {
    const text = JSON.stringify(call)
    return { v: 1, nonce, call: text, proof: hmacProof(key, doorCallerProofText({ walnutId: digestOf.walnutId, witness: digestOf.witness, nonce, digest: sha256Hex(JSON.stringify(digestOf)) })) }
  }
  const grab = () => LIST.map((id) => fs.readFileSync(recordOf(id), 'utf8'))

  it('a replayed old request, the wrong key, the wrong Walnut, a nonce for another request; each 403 or 404, the record byte for byte as it was', async () => {
    const a = client('A2')
    // A record with a number to protect (taken here when no earlier test left one).
    if (!(await readStanding(a, 1_500)).standing) expect((await proposeAndWait(a, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    const held = (await readStanding(a, 1_500)).standing
    expect(held?.number).toBeGreaterThan(0)
    const url = places[0]!.url!
    // A proposal that would be taken if it got in: the next number, a grant (the door decides before the rules).
    const record = { ...held!, number: held!.number + 100, kind: 'grant' as const, by: 'mallory', holder: 'mallory', nonce: 'x' }
    const call: WitnessCall = { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'propose', record } as never }
    const before = grab()
    const answers: unknown[] = []

    // 1. A good request once, then replayed byte for byte.
    const read: WitnessCall = { v: 1, walnutId: WALNUT, witness: 'w1', request: { type: 'read' } }
    const n0 = await challenge(url, read)
    const good = signed(read, n0, keys.w1!)
    const ok = await postOnce(post, `${url}/request`, good)
    expect(ok?.status).toBe(200)
    const replay = await postOnce(post, `${url}/request`, good)
    expect(replay).toEqual({ status: 403, json: { ok: false, error: 'unknown_nonce' } })
    answers.push(ok?.json, replay?.json)

    // 2. The wrong key (another witness's).
    const n1 = await challenge(url, call)
    const wrongKey = await postOnce(post, `${url}/request`, signed(call, n1, keys.w2!))
    expect(wrongKey).toEqual({ status: 403, json: { ok: false, error: 'bad_proof' } })
    answers.push(wrongKey?.json)

    // 3. The wrong Walnut: no challenge is given for a Walnut this door keeps no witness of...
    const other: WitnessCall = { ...call, walnutId: 'another-walnut' }
    const noChallenge = await postOnce(post, `${url}/challenge`, { v: 1, walnutId: other.walnutId, witness: 'w1', digest: sha256Hex(JSON.stringify(other)) })
    expect(noChallenge).toEqual({ status: 404, json: { ok: false, error: 'not_a_witness' } })
    // ...and a nonce for this Walnut does not carry a call for another.
    const n2 = await challenge(url, call)
    const crossWalnut = await postOnce(post, `${url}/request`, { ...signed(other, n2, keys.w1!), call: JSON.stringify(other) })
    expect(crossWalnut?.status).toBe(403)
    answers.push(noChallenge?.json, crossWalnut?.json)

    // 4. A nonce issued to another request (a read), used for the proposal, with a proof over the proposal.
    const n3 = await challenge(url, read)
    const swapped = await postOnce(post, `${url}/request`, signed(call, n3, keys.w1!))
    expect(swapped).toEqual({ status: 403, json: { ok: false, error: 'nonce_for_another_request' } })
    answers.push(swapped?.json)

    // 5. No nonce ever issued.
    const forged = await postOnce(post, `${url}/request`, signed(call, proofSecret(), keys.w1!))
    expect(forged).toEqual({ status: 403, json: { ok: false, error: 'unknown_nonce' } })
    answers.push(forged?.json)

    expect(grab()).toEqual(before)
    // No answer names a key, or carries anything of the record but in the one good reply.
    const text = JSON.stringify(answers)
    for (const k of Object.values(keys)) expect(text).not.toContain(k)
  })

  it('an expired nonce is refused, and the record stays as it was', async () => {
    let t = 0
    const door = machineWitnessDoor({ root: rootOf('w2'), now: () => t, nonceTtlMs: 10_000 })
    const call: WitnessCall = { v: 1, walnutId: WALNUT, witness: 'w2', request: { type: 'read' } }
    const ch = door.challenge({ v: 1, walnutId: WALNUT, witness: 'w2', digest: sha256Hex(JSON.stringify(call)) })
    expect(ch.status).toBe(200)
    const nonce = (ch.body as { nonce: string }).nonce
    const before = fs.readFileSync(recordOf('w2'), 'utf8')
    t = 10_001
    const r = await doorRequest(door, { v: 1, nonce, call: JSON.stringify(call), proof: hmacProof(keys.w2!, doorCallerProofText({ walnutId: WALNUT, witness: 'w2', nonce, digest: sha256Hex(JSON.stringify(call)) })) })
    expect(r).toEqual({ status: 403, body: { ok: false, error: 'expired_nonce' } })
    expect(fs.readFileSync(recordOf('w2'), 'utf8')).toBe(before)
    // Control: the same, in time, is answered.
    t = 0
    const ch2 = door.challenge({ v: 1, walnutId: WALNUT, witness: 'w2', digest: sha256Hex(JSON.stringify(call)) })
    const n2 = (ch2.body as { nonce: string }).nonce
    const r2 = await doorRequest(door, { v: 1, nonce: n2, call: JSON.stringify(call), proof: hmacProof(keys.w2!, doorCallerProofText({ walnutId: WALNUT, witness: 'w2', nonce: n2, digest: sha256Hex(JSON.stringify(call)) })) })
    expect(r2.status).toBe(200)
  })

  it('a flood of challenges never grows the door past its cap', () => {
    const door = machineWitnessDoor({ root: rootOf('w3') })
    for (let i = 0; i < 3_000; i++) door.challenge({ v: 1, walnutId: WALNUT, witness: 'w3', digest: sha256Hex(String(i)) })
    expect(door.openNonces()).toBeLessThanOrEqual(1024)
  })

  it('a witness set up without a key refuses every caller (no nonce at all)', async () => {
    const root = path.join(base, 'keyless', 'leader-witness')
    const list9 = ['w9', 'x', 'y']
    const setup9 = { v: 1 as const, walnutId: WALNUT, witness: 'w9', list: list9, evidence: blankEvidence(list9, 'w9') }
    expect((await setUpMachineWitness(root, setup9)).status).toBe(200)
    const door = machineWitnessDoor({ root })
    expect(door.challenge({ v: 1, walnutId: WALNUT, witness: 'w9', digest: sha256Hex('x') })).toEqual({ status: 404, body: { ok: false, error: 'not_a_witness' } })
    // A setup never replaces a key; it may add one to a witness set up before keys.
    expect((await setUpMachineWitness(root, { ...setup9, key: keys.w1! })).status).toBe(200)
    expect(await setUpMachineWitness(root, { ...setup9, key: keys.w2! })).toEqual({ status: 409, body: { ok: false, error: 'key_differs' } })
    expect(door.challenge({ v: 1, walnutId: WALNUT, witness: 'w9', digest: sha256Hex('x') }).status).toBe(200)
    expect(fs.statSync(path.join(witnessDir(root, WALNUT, 'w9'), 'witness-key')).mode & 0o777).toBe(0o600)
  })
})
