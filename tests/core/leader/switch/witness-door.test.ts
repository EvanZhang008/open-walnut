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
import { MAX_CHALLENGES_PER_CALLER, callerKey, machineWitnessDoor, doorRequest } from '../../../../src/core/leader/switch/witness-door.js'
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
      if (url.endsWith('/challenge')) done({ status: 200, json: { ok: true, nonce: `${'0'.repeat(12)}${proofSecret()}`, ttlMs: 10_000 } })
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
  /** The caller's own nonce of the challenge in flight (each challenge below has its own). */
  const cnonces = new Map<string, string>()
  async function challenge(url: string, call: WitnessCall): Promise<string> {
    const cnonce = proofSecret()
    const r = await postOnce(post, `${url}/challenge`, { v: 1, walnutId: call.walnutId, witness: call.witness, digest: sha256Hex(JSON.stringify(call)), cnonce })
    expect(r?.status).toBe(200)
    const nonce = (r!.json as { nonce: string }).nonce
    cnonces.set(nonce, cnonce)
    return nonce
  }
  function signed(call: WitnessCall, nonce: string, key: string, digestOf: WitnessCall = call) {
    const text = JSON.stringify(call)
    const cnonce = cnonces.get(nonce) ?? proofSecret()
    return { v: 1, nonce, cnonce, call: text, proof: hmacProof(key, doorCallerProofText({ walnutId: digestOf.walnutId, witness: digestOf.witness, nonce, cnonce, digest: sha256Hex(JSON.stringify(digestOf)) })) }
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
    const noChallenge = await postOnce(post, `${url}/challenge`, { v: 1, walnutId: other.walnutId, witness: 'w1', digest: sha256Hex(JSON.stringify(other)), cnonce: proofSecret() })
    expect(noChallenge).toEqual({ status: 404, json: { ok: false, error: 'no_witness_here' } })
    // ...and a nonce for this Walnut does not carry a call for another.
    const n2 = await challenge(url, call)
    const crossWalnut = await postOnce(post, `${url}/request`, { ...signed(other, n2, keys.w1!), call: JSON.stringify(other) })
    expect(crossWalnut?.status).toBe(403)
    answers.push(noChallenge?.json, crossWalnut?.json)

    // 4. A nonce issued to another request (a read), used for the proposal, with a proof over the proposal: the
    // door's HMAC in the nonce is over the read, so it is no nonce of this door for the proposal.
    const n3 = await challenge(url, read)
    const swapped = await postOnce(post, `${url}/request`, signed(call, n3, keys.w1!))
    expect(swapped).toEqual({ status: 403, json: { ok: false, error: 'unknown_nonce' } })
    answers.push(swapped?.json)

    // 5. No nonce ever issued (a made-up one of the right shape, and one with a far expiry).
    const forged = await postOnce(post, `${url}/request`, signed(call, `${'f'.repeat(12)}${proofSecret()}`, keys.w1!))
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
    const cnonce = proofSecret()
    const ch = door.challenge({ v: 1, walnutId: WALNUT, witness: 'w2', digest: sha256Hex(JSON.stringify(call)), cnonce })
    expect(ch.status).toBe(200)
    const nonce = (ch.body as { nonce: string }).nonce
    const before = fs.readFileSync(recordOf('w2'), 'utf8')
    t = 10_001
    const r = await doorRequest(door, { v: 1, nonce, cnonce, call: JSON.stringify(call), proof: hmacProof(keys.w2!, doorCallerProofText({ walnutId: WALNUT, witness: 'w2', nonce, cnonce, digest: sha256Hex(JSON.stringify(call)) })) })
    expect(r).toEqual({ status: 403, body: { ok: false, error: 'expired_nonce' } })
    expect(fs.readFileSync(recordOf('w2'), 'utf8')).toBe(before)
    // Control: the same, in time, is answered.
    t = 0
    const ch2 = door.challenge({ v: 1, walnutId: WALNUT, witness: 'w2', digest: sha256Hex(JSON.stringify(call)), cnonce })
    const n2 = (ch2.body as { nonce: string }).nonce
    const r2 = await doorRequest(door, { v: 1, nonce: n2, cnonce, call: JSON.stringify(call), proof: hmacProof(keys.w2!, doorCallerProofText({ walnutId: WALNUT, witness: 'w2', nonce: n2, cnonce, digest: sha256Hex(JSON.stringify(call)) })) })
    expect(r2.status).toBe(200)
  })

  it('a flood holds no state: challenges keep nothing, a request is remembered only once its proof held (N2)', async () => {
    const door = machineWitnessDoor({ root: rootOf('w3') })
    const call = (i: number): WitnessCall => ({ v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' }, round: i })
    const ask = (i: number, from: string, cnonce = proofSecret()) => ({ cnonce, r: door.challenge({ v: 1, walnutId: WALNUT, witness: 'w3', digest: sha256Hex(JSON.stringify(call(i))), cnonce }, from) })
    // 20,000 challenges from 2,000 addresses: no nonce is kept, so nothing fills.
    for (let i = 0; i < 20_000; i++) ask(i, `10.${(i >> 16) & 255}.${(i >> 8) & 7}.${i & 255}`)
    expect(door.usedNonces()).toBe(0)
    // Requests without the key (a wrong proof on a real nonce, forged nonces): refused, and nothing is remembered.
    for (let i = 0; i < 200; i++) {
      const { cnonce, r } = ask(i, '203.0.113.9')
      const nonce = (r.body as { nonce: string }).nonce
      expect((await doorRequest(door, { v: 1, nonce, cnonce, call: JSON.stringify(call(i)), proof: proofSecret() })).body).toEqual({ ok: false, error: 'bad_proof' })
    }
    expect(door.usedNonces()).toBe(0)
    // The honest caller, in the middle of all that, is answered.
    const { cnonce, r } = ask(7, '198.51.100.2')
    const nonce = (r.body as { nonce: string }).nonce
    const good = { v: 1, nonce, cnonce, call: JSON.stringify(call(7)), proof: hmacProof(keys.w3!, doorCallerProofText({ walnutId: WALNUT, witness: 'w3', nonce, cnonce, digest: sha256Hex(JSON.stringify(call(7))) })) }
    expect((await doorRequest(door, good)).status).toBe(200)
    expect(door.usedNonces()).toBe(1)
    // Used once: the replay is refused.
    expect(await doorRequest(door, good)).toEqual({ status: 403, body: { ok: false, error: 'unknown_nonce' } })
  })

  it('one caller is braked past its share of challenges, counted by its address and an IPv6 one by its /64; another caller is not', () => {
    const door = machineWitnessDoor({ root: rootOf('w3') })
    const ask = (from: string) => door.challenge({ v: 1, walnutId: WALNUT, witness: 'w3', digest: sha256Hex('x'), cnonce: proofSecret() }, from).status
    const flood = Array.from({ length: 1_000 }, (_, i) => ask(`2001:db8:1:2::${(i + 1).toString(16)}`))
    expect(flood.filter((s) => s === 200)).toHaveLength(MAX_CHALLENGES_PER_CALLER)
    expect(ask('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(429)
    expect(ask('2001:db8:1:3::1')).toBe(200)
    expect(ask('198.51.100.2')).toBe(200)
    expect(callerKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(callerKey('2001:db8:1:2::abcd'))
    expect(callerKey('::ffff:192.0.2.1')).toBe('192.0.2.1')
    expect(callerKey('192.0.2.1')).toBe('192.0.2.1')
  })

  it('the used nonces are capped: past the cap a key holder\'s request is refused, never an entry dropped', async () => {
    const door = machineWitnessDoor({ root: rootOf('w3'), limits: { maxUsed: 3 } })
    const read: WitnessCall = { v: 1, walnutId: WALNUT, witness: 'w3', request: { type: 'read' } }
    const once = async () => {
      const cnonce = proofSecret()
      const nonce = (door.challenge({ v: 1, walnutId: WALNUT, witness: 'w3', digest: sha256Hex(JSON.stringify(read)), cnonce }).body as { nonce: string }).nonce
      return doorRequest(door, { v: 1, nonce, cnonce, call: JSON.stringify(read), proof: hmacProof(keys.w3!, doorCallerProofText({ walnutId: WALNUT, witness: 'w3', nonce, cnonce, digest: sha256Hex(JSON.stringify(read)) })) })
    }
    for (let i = 0; i < 3; i++) expect((await once()).status).toBe(200)
    expect(await once()).toEqual({ status: 429, body: { ok: false, error: 'too_many_requests' } })
    expect(door.usedNonces()).toBe(3)
  })

  it('a witness set up without a key refuses every caller (no nonce at all)', async () => {
    const root = path.join(base, 'keyless', 'leader-witness')
    const list9 = ['w9', 'x', 'y']
    const setup9 = { v: 1 as const, walnutId: WALNUT, witness: 'w9', list: list9, evidence: blankEvidence(list9, 'w9') }
    expect((await setUpMachineWitness(root, setup9)).status).toBe(200)
    const door = machineWitnessDoor({ root })
    expect(door.challenge({ v: 1, walnutId: WALNUT, witness: 'w9', digest: sha256Hex('x'), cnonce: proofSecret() })).toEqual({ status: 404, body: { ok: false, error: 'not_a_witness' } })
    // A setup never replaces a key; it may add one to a witness set up before keys.
    expect((await setUpMachineWitness(root, { ...setup9, key: keys.w1! })).status).toBe(200)
    expect(await setUpMachineWitness(root, { ...setup9, key: keys.w2! })).toEqual({ status: 409, body: { ok: false, error: 'key_differs' } })
    expect(door.challenge({ v: 1, walnutId: WALNUT, witness: 'w9', digest: sha256Hex('x'), cnonce: proofSecret() }).status).toBe(200)
    expect(fs.statSync(path.join(witnessDir(root, WALNUT, 'w9'), 'witness-key')).mode & 0o777).toBe(0o600)
  })
})

describe('only a witness that looked and holds nothing counts as absent (M1 of review r1)', () => {
  /** A door at a fresh https front over `app`; its url as a place. */
  async function doorAt(app: express.Express, id: string): Promise<RemoteWitnessPlace> {
    const server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    servers.push(server)
    const port = (server.address() as net.AddressInfo).port
    const front = await startTlsFront(cert, () => port)
    fronts.push(front)
    return { id, url: `https://127.0.0.1:${front.port}${WITNESS_DOOR_PATH}`, key: proofSecret() }
  }
  const doorApp = (root: string) => { const app = express(); app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root })); return app }
  const seen = async (ps: RemoteWitnessPlace[]) => {
    const h = openPermitClient('E', ps, DEFAULT_PERMIT_PARAMS, undefined, { direct: directWitnessCall({ post }), walnutId: WALNUT, ways: ['direct'] })
    return readStanding(h, 3_000)
  }

  it('an empty door is absent; a record without its key and a service with the capability off are unreached', async () => {
    const list = ['e1', 'e2', 'e3']
    // e1: a door over a root that holds nothing of e1.
    const empty = await doorAt(doorApp(path.join(base, 'm1-empty', 'leader-witness')), 'e1')
    // e2: a door over a record set up without a key (its key file lost, say): it holds a record, so never absent.
    const keyless = path.join(base, 'm1-keyless', 'leader-witness')
    expect((await setUpMachineWitness(keyless, { v: 1, walnutId: WALNUT, witness: 'e2', list, evidence: blankEvidence(list, 'e2') })).status).toBe(200)
    const kept = await doorAt(doorApp(keyless), 'e2')
    // e3: the same service with the capability off: no door mounted, express's own 404.
    const off = await doorAt(express(), 'e3')
    const r = await seen([empty, kept, off])
    expect(r.answered).toBe(0)
    expect(r.absent).toEqual(['e1'])
    // Red control: the old rule (any 404 is absent) would have called all three absent, and a genesis would be made beside e2's record.
    const anyNotFound = new Set<string>()
    const h = openPermitClient('E2', [empty, kept, off], DEFAULT_PERMIT_PARAMS, undefined, {
      direct: directWitnessCall({ post }), walnutId: WALNUT, ways: ['direct'], onDrop: (_why, d) => { if (d.status === 404) anyNotFound.add(d.witness) },
    })
    await readStanding(h, 3_000)
    expect([...anyNotFound].sort()).toEqual(['e1', 'e2', 'e3'])
  }, 30_000)

  it('a door that replays a recorded exchange (old nonce, old reply, old proof) is no answer: the caller\'s new nonce is in the proof (m2)', async () => {
    const recorded: Record<string, { status: number; json: unknown } | null> = {}
    const recorder: DoorPost = (url, body, done) => post(url, body, (r) => { recorded[url.endsWith('/challenge') ? 'challenge' : 'request'] = r; done(r) })
    const read = { v: 1 as const, walnutId: WALNUT, witness: 'w1', request: { type: 'read' as const } }
    const first = await new Promise((resolve) => { directWitnessCall({ post: recorder })(places[0]!, WITNESS_REQUEST_PATH, read, resolve) })
    expect(first).toMatchObject({ status: 200 })
    // The same call again, through a door that answers both posts with the recorded ones.
    const replayer: DoorPost = (url, _body, done) => done(recorded[url.endsWith('/challenge') ? 'challenge' : 'request']!)
    const again = await new Promise((resolve) => { directWitnessCall({ post: replayer })(places[0]!, WITNESS_REQUEST_PATH, read, resolve) })
    expect(again).toEqual({ status: 502, body: { ok: false, error: BAD_WITNESS_PROOF } })
  })
})
