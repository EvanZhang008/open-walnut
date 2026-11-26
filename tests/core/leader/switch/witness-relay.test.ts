/**
 * The witness relay (src/core/leader/switch/witness-relay.ts): a Mac-shaped candidate (no witness of its own, every
 * dev box's door out of its reach, nobody can dial it) reaches the other dev box's witness through the companion's
 * door, over streams that dev box's service parked at the companion. Real pieces on loopback: the companion's door
 * router with the relay paths (web/routes/witness-door.ts), the hub, the host's parker with that machine's real
 * witness door, a TCP hop standing in for the dev box's bridge, the real caller and proofs (witness-direct.ts).
 *
 * Also: the relay can make no vote count, whatever it does to the bytes (the proofs are the far witness's key,
 * bound to this call), a relay with nothing parked is "not reached" (never "absent"), the settings, the ways, and
 * the candidate's check (a commit that needs the relay stays refused unless relay_commit lifts it).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const spy = vi.hoisted(() => ({ links: [] as string[] }))
// A candidate builds no leader link: the module every daemon link goes through is a spy.
vi.mock('../../../../src/core/hosts/link.js', () => ({ link: async (host: string) => { spy.links.push(host); throw new Error('no link in this test') } }))

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-relay-'))
process.env.WALNUT_MACHINE_ID_FILE = path.join(base, 'k', 'machine-id')
process.env.WALNUT_CAPABILITIES = 'witness-door'

import { DEFAULT_PERMIT_PARAMS } from '../../../../src/core/leader/permit/index.js'
import { commitReach, probeWitnessReach, relayNeed, CANDIDATE_WAYS } from '../../../../src/core/leader/switch/witness-reach.js'
import { directWitnessCall, BAD_WITNESS_PROOF } from '../../../../src/core/leader/switch/witness-direct.js'
import { setUpMachineWitness } from '../../../../src/core/leader/switch/witness-route.js'
import { machineWitnessDoor } from '../../../../src/core/leader/switch/witness-door.js'
import { createWitnessDoorRouter } from '../../../../src/web/routes/witness-door.js'
import { NO_RELAY_CODE, NO_WITNESS_HERE_CODE, WITNESS_DOOR_PATH, WITNESS_REQUEST_PATH, WITNESS_RELAY_SUB, relayUrlOf } from '../../../../src/core/leader/switch/witness-wire.js'
import { permitWays, waysOf, type RemoteCall, type RemoteCallResult } from '../../../../src/core/leader/switch/witness-transport.js'
import { openPermitClient, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import { startPermitRuntime } from '../../../../src/core/leader/switch/runtime.js'
import { createRelayHub, PARKED_PER_HOST, PARKED_PER_WITNESS, keyedWitnesses, startWitnessRelayParker, parseRelayHello, relayHub, startHostWitnessRelay, _resetRelayHub, type RelayParker } from '../../../../src/core/leader/switch/witness-relay.js'
import { parseSwitchSettings, type LeaderSwitchSettings, type RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'
import { runTargetJob } from '../../../../src/core/leader/switch/target-job.js'
import type { SwitchSide } from '../../../../src/core/leader/switch/side.js'
import type { CheckReport } from '../../../../src/core/leader/switch/ticket.js'
import { hmacProof, proofSecret } from '../../../../src/utils/hmac-proof.js'
import { emptyState } from '../../../../src/core/standby/target-files.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'

const WALNUT = 'cd34ef56'.repeat(4)
const LIST = ['w-a', 'w-b', 'w-k']
const keys: Record<string, string> = Object.fromEntries(LIST.map((id) => [id, proofSecret()]))
const roots = { 'w-a': path.join(base, 'a', 'leader-witness'), 'w-b': path.join(base, 'b', 'leader-witness'), 'w-k': path.join(base, 'k', 'leader-witness') }
// The Mac-shaped candidate: no witness of its own.
const here = { machineId: 'machine-m', root: path.join(base, 'm', 'leader-witness'), walnutId: () => WALNUT }

let companion: http.Server
let companionPort = 0
/** The dev box B's bridge to the companion: a TCP hop, every connection a stream the companion's hub takes as from `machine-b`. */
let bridge: net.Server
let bridgePort = 0
const bridgeFault = { refuse: false }
/** Posts to the companion's relay (any caller). */
const relayPosts = { n: 0 }
let deadPort = 0
let places: RemoteWitnessPlace[] = []
let parker: RelayParker | null = null

const openBridge = (): Promise<net.Socket> => new Promise((resolve, reject) => {
  if (bridgeFault.refuse) { reject(new Error('the cloud companion is not linked to this host')); return }
  const s = net.connect(bridgePort, '127.0.0.1')
  s.once('connect', () => resolve(s))
  s.once('error', reject)
})

const listen = (s: net.Server | http.Server): Promise<number> => new Promise((r) => s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port)))

beforeAll(async () => {
  for (const id of LIST) {
    const r = await setUpMachineWitness(roots[id as keyof typeof roots], { v: 1, walnutId: WALNUT, witness: id, list: LIST, evidence: blankEvidence(LIST, id), key: keys[id] })
    expect(r.status).toBe(200)
  }
  const app = express()
  app.use((req, _res, next) => { if (req.path.startsWith(`${WITNESS_DOOR_PATH}${WITNESS_RELAY_SUB}/`)) relayPosts.n++; next() })
  app.use(WITNESS_DOOR_PATH, createWitnessDoorRouter({ root: roots['w-k'] }))
  companion = http.createServer(app)
  companionPort = await listen(companion)
  bridge = net.createServer((sock) => relayHub().park('machine-b', sock))
  bridgePort = await listen(bridge)
  const s = net.createServer()
  deadPort = await listen(s)
  await new Promise<void>((r) => s.close(() => r()))
  const kDoor = `http://127.0.0.1:${companionPort}${WITNESS_DOOR_PATH}`
  places = [
    { id: 'w-a', machine: 'machine-a', host: 'machine-a', url: `http://127.0.0.1:${deadPort}/a${WITNESS_DOOR_PATH}`, key: keys['w-a'] },
    // The other dev box: its own door out of reach, its relay the companion's door.
    { id: 'w-b', machine: 'machine-b', host: 'machine-b', url: `http://127.0.0.1:${deadPort}/b${WITNESS_DOOR_PATH}`, key: keys['w-b'], relay: 'w-k', relayUrl: relayUrlOf(kDoor, 'machine-b') },
    { id: 'w-k', url: kDoor, key: keys['w-k'] },
  ]
})

afterAll(async () => {
  parker?.stop()
  _resetRelayHub()
  await new Promise<void>((r) => bridge.close(() => r()))
  await new Promise<void>((r) => { companion.closeAllConnections?.(); companion.close(() => r()) })
  fs.rmSync(base, { recursive: true, force: true })
})

beforeEach(() => { bridgeFault.refuse = false; spy.links.length = 0 })
afterEach(() => { parker?.stop(); parker = null; _resetRelayHub() })

const startParker = (): RelayParker => (parker = startHostWitnessRelay({ walnutId: WALNUT, open: openBridge, root: roots['w-b'] }))
const until = async (fn: () => boolean, ms = 5_000): Promise<void> => {
  for (const end = Date.now() + ms; !fn();) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** One read of `place` by way b's call: its result as the transport sees it. */
const readOnce = (place: RemoteWitnessPlace): Promise<RemoteCallResult | null> => new Promise((resolve) => {
  directWitnessCall({ timeoutMs: 5_000 })(place, WITNESS_REQUEST_PATH, { v: 1, walnutId: WALNUT, witness: place.id, request: { type: 'read' } }, resolve)
})
const viaRelayAt = (url: string): RemoteWitnessPlace => ({ ...places[1]!, url })

describe('a Mac-shaped candidate at its commit (the old leader stopped, no link anywhere)', () => {
  it('reaches 2 of 3: the companion by its door and the other dev box through the companion\'s relay, each by its own key', async () => {
    startParker()
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 2)
    const r = await probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, waitMs: 6_000 })
    const by = Object.fromEntries(r.witnesses.map((w) => [w.id, w.answered ? `${w.way}${w.via ? `:${w.via}` : ''}` : `no: ${w.why}`]))
    expect(by['w-k']).toBe('direct')
    expect(by['w-b']).toBe('relay:w-k')
    expect(by['w-a']).toMatch(/^no: /)
    expect(r.majority).toBe(true)
    expect(commitReach(r)).toBe(2)
    // The relay counts, and it is one path for both votes: with the companion down this machine has none.
    expect(relayNeed(r, 2)).toEqual({ without: 1, needsRelay: true, onePath: { via: 'w-k', left: 0 } })
    expect(spy.links).toEqual([])
  }, 30_000)

  it('the red control: nothing parked (its service, or its bridge, is down): the relay answers no_relay, never no_witness_here, and the candidate has 1 of 3', async () => {
    const r0 = await readOnce(places[1]!.relayUrl ? viaRelayAt(places[1]!.relayUrl) : places[1]!)
    expect(r0?.status).toBe(503)
    expect((r0?.body as { error?: string }).error).toBe(NO_RELAY_CODE)
    expect((r0?.body as { error?: string }).error).not.toBe(NO_WITNESS_HERE_CODE)
    const r = await probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, waitMs: 5_000 })
    const b = r.witnesses.find((w) => w.id === 'w-b')
    expect(b?.answered).toBe(false)
    expect(b?.why).toMatch(/its door http:\/\/127\.0\.0\.1:\d+\/b\/leader-witness did not answer; its door through w-k's relay: nothing of machine-b is parked there/)
    expect(commitReach(r)).toBe(1)
    expect(r.majority).toBe(false)
  }, 30_000)

  it('the bridge refuses the streams: the parker backs off and parks once it is back', async () => {
    bridgeFault.refuse = true
    let tries = 0
    const p = startHostWitnessRelay({ walnutId: WALNUT, open: () => { tries++; return openBridge() }, root: roots['w-b'] })
    parker = p
    await new Promise((r) => setTimeout(r, 1_500))
    // Two slots, each tried once and once after a 1 s back-off at most: no storm.
    expect(tries).toBeLessThanOrEqual(6)
    bridgeFault.refuse = false
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 1, 8_000)
  }, 20_000)

  it('each call takes one parked stream, and the host parks the next', async () => {
    startParker()
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 2)
    for (let i = 0; i < 5; i++) {
      const r = await readOnce(viaRelayAt(places[1]!.relayUrl!))
      expect(r?.status, JSON.stringify(r?.body)).toBe(200)
      // A stream the door got a request on counts as served: the next is parked at once, no back-off.
      await until(() => relayHub().parked(WALNUT, 'w-b') >= 2, 800)
    }
    // Both ways in: the relay without a host, and the one naming it.
    expect(places[1]!.relayUrl).toBe(`http://127.0.0.1:${companionPort}${WITNESS_DOOR_PATH}${WITNESS_RELAY_SUB}/to/machine-b`)
    expect((await readOnce(viaRelayAt(`http://127.0.0.1:${companionPort}${WITNESS_DOOR_PATH}${WITNESS_RELAY_SUB}`)))?.status).toBe(200)
  }, 30_000)

  it('against a companion before the relay (its own port answers the hello and closes): the parker backs off, no hot loop', async () => {
    // The pre-relay companion's bridge splices a follower stream into its own HTTP port (review round 1's script).
    const old = http.createServer((_req, res) => { res.end('ok') })
    const port = await listen(old)
    let opens = 0
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-old-'))
    const p = startWitnessRelayParker({
      walnutId: 'w', witnesses: () => ['w-o'], door: machineWitnessDoor({ root }), perWitness: 2,
      open: async () => { opens++; return net.connect(port, '127.0.0.1') },
    })
    try {
      await new Promise((r) => setTimeout(r, 5_000))
      // Two slots backing off 1 s, 2 s, 4 s, ... (one count for the witness): a handful, where it was about 200.
      expect(opens).toBeGreaterThanOrEqual(2)
      expect(opens).toBeLessThanOrEqual(8)
    } finally {
      p.stop()
      await new Promise<void>((r) => { old.closeAllConnections?.(); old.close(() => r()) })
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('a hostile relay can make no vote count', () => {
  /** A relay in front of the real one, which does `mode` to what passes. */
  const mode: { v: 'pass' | 'flip' | 'replay' | 'forge' | 'own-key' | 'swap-witness' | 'drop' } = { v: 'pass' }
  let hostile: http.Server
  let hostileUrl = ''
  const recorded: Record<string, unknown> = {}
  beforeAll(async () => {
    hostile = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        const sub = (req.url ?? '').slice(`${WITNESS_DOOR_PATH}${WITNESS_RELAY_SUB}`.length)
        const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
        let body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        if (mode.v === 'drop') { send(503, { ok: false, error: NO_RELAY_CODE }); return }
        if (mode.v === 'forge') {
          // It makes the whole exchange up, holding no key of w-b.
          if (sub === '/challenge') { send(200, { ok: true, nonce: 'f'.repeat(76), ttlMs: 10_000 }); return }
          const reply = JSON.stringify({ witness: 'w-b', held: { holder: 'machine-evil', kind: 'grant', number: 99 }, epoch: 1 })
          send(200, { ok: true, reply, proof: hmacProof(proofSecret(), reply) })
          return
        }
        if (mode.v === 'swap-witness') body = { ...body, witness: 'w-k' }
        const r = await fetch(`http://127.0.0.1:${companionPort}${WITNESS_DOOR_PATH}${mode.v === 'swap-witness' ? '' : WITNESS_RELAY_SUB}${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        let j = await r.json() as Record<string, unknown>
        if (sub === '/request' && r.status === 200) {
          if (mode.v === 'replay') { if (recorded.request) j = recorded.request as Record<string, unknown>; else recorded.request = j }
          // One byte more in the reply text (the JSON still means the same): its digest is not the one the witness proved.
          if (mode.v === 'flip' && typeof j.reply === 'string') j = { ...j, reply: `${j.reply as string} ` }
          if (mode.v === 'own-key' && typeof j.reply === 'string') {
            // The companion answers for w-b with the key it does hold (w-k's): still not w-b's proof.
            j = { ...j, proof: hmacProof(keys['w-k']!, j.reply as string) }
          }
        }
        send(r.status, j)
      })
    })
    hostileUrl = `http://127.0.0.1:${await listen(hostile)}${WITNESS_DOOR_PATH}${WITNESS_RELAY_SUB}`
  })
  afterAll(async () => { await new Promise<void>((r) => hostile.close(() => r())) })

  it('passing the bytes as they came: w-b answers (the control)', async () => {
    startParker()
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 1)
    mode.v = 'pass'
    const r = await readOnce(viaRelayAt(hostileUrl))
    expect(r?.status).toBe(200)
    expect((r?.body as { reply?: { witness?: string } }).reply?.witness).toBe('w-b')
  }, 20_000)

  for (const m of ['flip', 'replay', 'forge', 'own-key', 'swap-witness', 'drop'] as const) {
    it(`${m}: no reply the transport may count`, async () => {
      startParker()
      await until(() => relayHub().parked(WALNUT, 'w-b') >= 1)
      if (m === 'replay') {
        // One honest exchange recorded first, then handed back for a new call.
        mode.v = 'replay'
        delete recorded.request
        expect((await readOnce(viaRelayAt(hostileUrl)))?.status).toBe(200)
        await until(() => relayHub().parked(WALNUT, 'w-b') >= 1)
      }
      mode.v = m
      const r = await readOnce(viaRelayAt(hostileUrl))
      expect(r?.status, JSON.stringify(r?.body)).not.toBe(200)
      if (m === 'flip' || m === 'replay' || m === 'own-key') expect((r?.body as { error?: string }).error).toBe(BAD_WITNESS_PROOF)
      // And through the candidate's whole probe: w-b is not reached through it, so the commit has 1 of 3.
      const hostilePlaces = places.map((p) => (p.id === 'w-b' ? { ...p, relayUrl: hostileUrl } : p))
      const probe = await probeWitnessReach({ places: hostilePlaces, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, waitMs: 3_000 })
      expect(probe.witnesses.find((w) => w.id === 'w-b')?.answered).toBe(false)
      expect(commitReach(probe)).toBe(1)
    }, 30_000)
  }
})

describe('the hub', () => {
  const pair = (): [net.Socket, Promise<net.Socket>] => {
    let take: (s: net.Socket) => void = () => {}
    const got = new Promise<net.Socket>((r) => { take = r })
    const srv = net.createServer((s) => { take(s); srv.close() })
    const c = new net.Socket()
    srv.listen(0, '127.0.0.1', () => c.connect((srv.address() as net.AddressInfo).port, '127.0.0.1'))
    return [c, got]
  }
  const closed = (s: net.Socket) => new Promise<void>((r) => { if (s.destroyed) r(); else s.once('close', () => r()) })

  it('takes a stream only with a hello line naming a Walnut and a witness, and nothing after it', async () => {
    expect(parseRelayHello('{"v":1,"walnutId":"w","witness":"w-b"}')).toEqual({ v: 1, walnutId: 'w', witness: 'w-b' })
    for (const bad of ['', 'x', '{"v":2,"walnutId":"w","witness":"w-b"}', '{"v":1,"walnutId":"w/../x","witness":"w-b"}', '{"v":1,"walnutId":"w"}']) expect(parseRelayHello(bad)).toBeNull()
    const hub = createRelayHub()
    const [c1, s1] = pair()
    hub.park('h', await s1)
    c1.write('{"v":1,"walnutId":"w","witness":"w-b"}\nGET / HTTP/1.1\r\n\r\n')
    await closed(c1)
    const [c2, s2] = pair()
    hub.park('h', await s2)
    c2.write('not a hello\n')
    await closed(c2)
    const [c3, s3] = pair()
    hub.park('h', await s3)
    c3.write('{"v":1,"walnutId":"w","witness":"w-b"}\n')
    await until(() => hub.parked('w', 'w-b') === 1)
    // A parked stream that closes is gone.
    c3.destroy()
    await until(() => hub.parked('w', 'w-b') === 0)
    hub.close()
  })

  it('keeps a parked stream only for its park time, and a post waits a moment for one', async () => {
    const hub = createRelayHub({ parkMaxMs: 300, takeWaitMs: 1_000 })
    const [c, s] = pair()
    hub.park('h', await s)
    c.write('{"v":1,"walnutId":"w","witness":"w-b"}\n')
    await until(() => hub.parked('w', 'w-b') === 1)
    await closed(c)
    expect(hub.parked('w', 'w-b')).toBe(0)
    // Nothing parked: the post waits its while, then there is no relay.
    const t0 = Date.now()
    expect(await hub.post('w', 'w-b', '/challenge', {})).toBeNull()
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    // Only the two door paths.
    expect(await hub.post('w', 'w-b', '/setup', {})).toBeNull()
    hub.close()
  })

  it('a post naming the witness\'s host takes that host\'s stream, not the newest; a host never seen there takes any', async () => {
    const hub = createRelayHub({ takeWaitMs: 300 })
    const hello = '{"v":1,"walnutId":"w","witness":"w-b"}\n'
    // Each "host" answers the one request on its stream with its own name.
    const park = async (from: string): Promise<net.Socket> => {
      const [c, s] = pair()
      hub.park(from, await s)
      c.write(hello)
      c.once('data', () => { const b = JSON.stringify({ ok: true, from }); c.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${b.length}\r\nconnection: close\r\n\r\n${b}`) })
      return c
    }
    const socks = [await park('machine-b'), await park('machine-x')]
    await until(() => hub.parked('w', 'w-b') === 2)
    expect((await hub.post('w', 'w-b', '/challenge', {}, { host: 'machine-b' }))?.json).toEqual({ ok: true, from: 'machine-b' })
    // machine-b has parked for w-b: a post naming it waits for its streams and never takes machine-x's.
    expect(await hub.post('w', 'w-b', '/challenge', {}, { host: 'machine-b' })).toBeNull()
    expect(hub.parked('w', 'w-b')).toBe(1)
    // A host that never parked for it (an alias the bridge does not use): any stream, the newest.
    expect((await hub.post('w', 'w-b', '/challenge', {}, { host: 'machine-z' }))?.json).toEqual({ ok: true, from: 'machine-x' })
    hub.close()
    for (const c of socks) c.destroy()
  })

  it('one host\'s streams over all its witnesses are capped on their own: made-up witness ids crowd no other host out', async () => {
    const hub = createRelayHub()
    const socks: net.Socket[] = []
    const park = async (from: string, witness: string): Promise<net.Socket> => {
      const [c, s] = pair()
      hub.park(from, await s)
      c.write(`{"v":1,"walnutId":"w","witness":"${witness}"}\n`)
      socks.push(c)
      return c
    }
    for (let i = 0; i < PARKED_PER_HOST; i++) await park('machine-x', `w-made-${Math.floor(i / 4)}-${i % 4}`)
    await until(() => Array.from({ length: PARKED_PER_HOST / 4 }, (_, j) => [0, 1, 2, 3].reduce((n, k) => n + hub.parked('w', `w-made-${j}-${k}`), 0)).reduce((a, b) => a + b, 0) === PARKED_PER_HOST)
    const refused = await park('machine-x', 'w-made-new')
    await closed(refused)
    await park('machine-b', 'w-b')
    await until(() => hub.parked('w', 'w-b') === 1)
    hub.close()
    for (const c of socks) c.destroy()
  })

  it('the far door brakes each relayed caller on its own: one address spends no other caller\'s share', async () => {
    const hub = createRelayHub()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-brake-'))
    expect((await setUpMachineWitness(root, { v: 1, walnutId: WALNUT, witness: 'w-b', list: LIST, evidence: blankEvidence(LIST, 'w-b'), key: keys['w-b'] })).status).toBe(200)
    const open = (): Promise<net.Socket> => new Promise((resolve) => {
      const srv = net.createServer((s) => { srv.close(); hub.park('machine-b', s) })
      srv.listen(0, '127.0.0.1', () => { const c = net.connect((srv.address() as net.AddressInfo).port, '127.0.0.1'); c.once('connect', () => resolve(c)) })
    })
    const p = startWitnessRelayParker({ walnutId: WALNUT, witnesses: () => ['w-b'], door: machineWitnessDoor({ root, limits: { maxPerCaller: 2 } }), open })
    try {
      const challenge = { v: 1, walnutId: WALNUT, witness: 'w-b', digest: 'a'.repeat(64), cnonce: 'b'.repeat(64) }
      const ask = async (caller: string) => {
        await until(() => hub.parked(WALNUT, 'w-b') >= 1)
        return (await hub.post(WALNUT, 'w-b', '/challenge', challenge, { caller }))?.status
      }
      expect([await ask('198.51.100.7'), await ask('198.51.100.7'), await ask('198.51.100.7')]).toEqual([200, 200, 429])
      expect(await ask('203.0.113.9')).toBe(200)
    } finally {
      p.stop()
      hub.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('a host parking under another machine\'s witness id cannot crowd that machine out, and is said', async () => {
    const said: Array<Record<string, unknown> | undefined> = []
    const hub = createRelayHub({ log: (level, _msg, data) => { if (level === 'warn') said.push(data) } })
    const hello = '{"v":1,"walnutId":"w","witness":"w-b"}\n'
    const park = async (from: string): Promise<net.Socket> => { const [c, s] = pair(); hub.park(from, await s); c.write(hello); return c }
    // Another host fills its share, and one more of its own is refused.
    const other: net.Socket[] = []
    for (let i = 0; i < PARKED_PER_WITNESS; i++) other.push(await park('machine-x'))
    await until(() => hub.parked('w', 'w-b') === PARKED_PER_WITNESS)
    const extra = await park('machine-x')
    await closed(extra)
    // The witness's own machine still parks.
    const own = await park('machine-b')
    await until(() => hub.parked('w', 'w-b') === PARKED_PER_WITNESS + 1)
    expect(own.destroyed).toBe(false)
    expect(said).toEqual([{ witness: 'w-b', hosts: ['machine-x', 'machine-b'] }])
    hub.close()
    for (const c of [...other, own]) c.destroy()
  })
})

describe('the settings and the ways', () => {
  const cfg = (witnesses: unknown[], extra: Record<string, unknown> = {}) => parseSwitchSettings({
    witnesses,
    machines: [{ id: 'a', home: '/h/a', standby_dir: '/s/a', port: 1 }, { id: 'm', home: '/h/m', standby_dir: '/s/m', port: 2 }],
    ...extra,
  })
  const k = { id: 'w-k', url: 'https://box.example/leader-witness' }

  it('a relay names another witness of the list with a door; its relay door is that door\'s /relay', () => {
    const r = cfg([{ id: 'w-a', machine: 'a' }, { id: 'w-b', machine: 'b', relay: 'w-k' }, k])
    expect(r.problem).toBeUndefined()
    expect(r.settings!.witnesses[1]).toMatchObject({ id: 'w-b', relay: 'w-k', relayUrl: 'https://box.example/leader-witness/relay' })
    expect(r.settings!.relayCommit).toBe(false)
    expect(cfg([{ id: 'w-a', machine: 'a' }, { id: 'w-b', machine: 'b' }, k], { relay_commit: true }).settings!.relayCommit).toBe(true)
    expect(cfg([{ id: 'w-a', machine: 'a' }, { id: 'w-b', machine: 'b', relay: 'w-x' }, k]).problem).toMatch(/w-b's relay names no other witness/)
    expect(cfg([{ id: 'w-a', machine: 'a' }, { id: 'w-b', machine: 'b', relay: 'w-b' }, k]).problem).toMatch(/w-b's relay names no other witness/)
    expect(cfg([{ id: 'w-a', machine: 'a' }, { id: 'w-b', machine: 'b', relay: 'w-a' }, k]).problem).toMatch(/w-b's relay w-a has no door url/)
    expect(cfg([{ id: 'w-a', machine: 'a', url: 'https://a.example/w', relay: 'w-k' }, { id: 'w-b', machine: 'b', relay: 'w-a' }, k]).problem).toMatch(/is itself relayed/)
  })

  it('the relay is the last way, needs the key and a door call, and is a candidate\'s way', () => {
    const p: RemoteWitnessPlace = { id: 'w-b', machine: 'machine-b', host: 'machine-b', url: 'https://b/x', key: 'k', relay: 'w-k', relayUrl: 'https://k/x/relay' }
    expect(waysOf(p, { here, direct: () => {}, remote: () => {} })).toEqual(['direct', 'link', 'relay'])
    expect(waysOf({ ...p, key: undefined }, { here, direct: () => {} })).toEqual([])
    expect(waysOf(p, { here })).toEqual([])
    expect(waysOf(p, { here, direct: () => {}, ways: CANDIDATE_WAYS })).toEqual(['direct', 'relay'])
  })

  it('keyedWitnesses lists only the witnesses of that Walnut kept here with a key', () => {
    expect(keyedWitnesses(roots['w-b'], WALNUT)).toEqual(['w-b'])
    expect(keyedWitnesses(roots['w-b'], 'another')).toEqual([])
  })
})

describe('the candidate\'s check', () => {
  const check = async (relayCommit: boolean): Promise<CheckReport> => {
    const standbyDir = path.join(base, `m-${relayCommit}`, 'standby')
    const copy = path.join(standbyDir, 'copy')
    fs.mkdirSync(copy, { recursive: true })
    fs.writeFileSync(path.join(standbyDir, 'standby.json'), JSON.stringify(emptyState()))
    fs.writeFileSync(path.join(copy, 'config.yaml'), YAML.stringify({
      experimental: { switchable_leader: true },
      leader_switch: {
        witnesses: places.map(({ relayUrl: _r, ...p }) => p),
        machines: [
          { id: 'machine-a', home: path.join(base, 'a', 'home'), standby_dir: path.join(base, 'a', 'standby'), port: 4901 },
          { id: 'machine-m', home: path.join(base, 'm', 'home'), standby_dir: standbyDir, port: 4902 },
        ],
        ...(relayCommit ? { relay_commit: true } : {}),
      },
    }))
    const side = {
      machine: { id: 'machine-m', home: path.join(base, 'm', 'home'), standbyDir, port: 4902 },
      runningServer: () => null,
      reachWitnesses: () => probeWitnessReach({ places, params: DEFAULT_PERMIT_PARAMS, here, walnutId: WALNUT, waitMs: 6_000 }),
    } as unknown as SwitchSide
    const machineFile = path.join(base, 'm', 'machine-id')
    fs.mkdirSync(path.dirname(machineFile), { recursive: true })
    fs.writeFileSync(machineFile, 'machine-m\n')
    return await runTargetJob({ standbyDir, switchId: `S-relay-${relayCommit}`, check: true, side, env: { ...process.env, WALNUT_MACHINE_ID_FILE: machineFile } }) as CheckReport
  }

  it('refuses a commit that needs the relay in this phase, naming it; relay_commit lifts that, and the one path is said', async () => {
    startParker()
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 2)
    const off = await check(false)
    expect(off.problems.join('\n')).toMatch(/commit majority needs a relay \(w-b through w-k\): without it 1 of 3 answer \(2 needed\)\. A switch to a machine that reaches a majority only through a relay is refused in this phase \(leader_switch\.relay_commit is off\)/)
    expect(off.reach?.find((w) => w.id === 'w-b')).toMatchObject({ answered: true, way: 'relay', via: 'w-k' })
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 2)
    const on = await check(true)
    // No problem about the witnesses (the copy holds no batch yet: that one is the standby's).
    expect(on.problems.filter((p) => !/holds no complete batch yet/.test(p)), on.problems.join('\n')).toEqual([])
    expect(on.notes?.[0]).toMatch(/the commit majority goes through w-k's door alone \(w-k itself, and w-b through w-k\): with w-k down this machine reaches only the witnesses it dials itself, 0 of 3 \(2 needed\)/)
    expect(spy.links).toEqual([])
  }, 40_000)
})

describe('the permit itself (not only the preflight)', () => {
  it('a relayed no_witness_here is not reached, never absent; the same over the direct door is absent', async () => {
    const nothingHere: RemoteCall = (_p, _path, _body, done) => { done({ status: 404, body: { ok: false, error: NO_WITNESS_HERE_CODE } }) }
    const others: RemoteWitnessPlace[] = [{ id: 'w-a', url: `http://127.0.0.1:${deadPort}/a`, key: keys['w-a'] }, { id: 'w-k', url: `http://127.0.0.1:${deadPort}/k`, key: keys['w-k'] }]
    const absentWith = async (wb: RemoteWitnessPlace): Promise<string[]> => {
      const h = openPermitClient('reader', [others[0]!, wb, others[1]!], DEFAULT_PERMIT_PARAMS, undefined, { direct: nothingHere, walnutId: WALNUT })
      return (await readStanding(h, 600)).absent
    }
    expect(await absentWith({ id: 'w-b', url: 'http://door.invalid/leader-witness', key: keys['w-b'] })).toContain('w-b')
    expect(await absentWith({ id: 'w-b', relay: 'w-k', relayUrl: 'http://relay.invalid/leader-witness/relay', key: keys['w-b'] })).not.toContain('w-b')
  })

  it('relay_commit off: a Mac-shaped permit runtime never leads through the relay; on, it does', async () => {
    startParker()
    await until(() => relayHub().parked(WALNUT, 'w-b') >= 2)
    const settings = (relayCommit: boolean): LeaderSwitchSettings => ({
      witnesses: places,
      machines: ['machine-a', 'machine-m'].map((id, i) => ({ id, home: path.join(base, `rt-${id}`), standbyDir: path.join(base, `rt-${id}-standby`), port: 4910 + i })),
      backWindowHours: 24, params: { ...DEFAULT_PERMIT_PARAMS }, relayCommit,
    }) as LeaderSwitchSettings
    const start = async (relayCommit: boolean) => {
      const home = path.join(base, `rt-${relayCommit}`)
      fs.mkdirSync(home, { recursive: true })
      return startPermitRuntime({ home, holderId: 'machine-m', settings: settings(relayCommit), trial: false, net: { walnutId: WALNUT, here, direct: directWitnessCall({ timeoutMs: 5_000 }) } })
    }
    relayPosts.n = 0
    const off = await start(false)
    try {
      // Its boot reads and grant reach w-k by its door only (w-b only through the relay, w-a out of reach): 1 of 3, it
      // waits, and it never posts through the relay at all. One way per read, the next after a miss: the boot's reads
      // reach the relay's turn within about 20 s (the "on" runtime below leads then), so it waits longer than that.
      await new Promise((r) => setTimeout(r, 25_000))
      expect(relayPosts.n).toBe(0)
      expect(off.mayAct()).toBe(false)
    } finally {
      await off.stop()
    }
    const on = await start(true)
    try {
      await until(() => on.mayAct(), 20_000)
    } finally {
      await on.stop()
    }
    expect(permitWays(false)).not.toContain('relay')
    expect(spy.links).toEqual([])
  }, 90_000)
})
