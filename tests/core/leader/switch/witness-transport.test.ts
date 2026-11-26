/**
 * The network transport of the write permission (witness-transport.ts): its own rules with a fake
 * call, and a real permit client over real witness machines (leader doors on loopback sockets, records
 * on disk): grant, renew, a witness down, a split, a candidate with no link of its own, and the
 * renew round trip, measured.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blankEvidence, startWitnessMachine, loopbackCall, type WitnessMachine } from '../../../helpers/witness-machines.js'
import { DEFAULT_PERMIT_PARAMS, type PermitReply } from '../../../../src/core/leader/permit/index.js'
import { openPermitClient, proposeAndWait, readStanding } from '../../../../src/core/leader/switch/permit-ops.js'
import {
  addWitnessReach, createWitnessTransport, hostLinkCall, setUpRemoteWitness, type RemoteCall, type RemoteCallResult,
} from '../../../../src/core/leader/switch/witness-transport.js'
import { acceptReply, requestRe, WITNESS_REQUEST_PATH } from '../../../../src/core/leader/switch/witness-wire.js'
import type { RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'

const WALNUT = 'walnut-test-1'
const LIST = ['w1', 'w2', 'w3']
const PLACES: RemoteWitnessPlace[] = LIST.map((id, i) => ({ id, host: `m${i + 1}` }))
const READ = { type: 'read' } as const

function reply(witness: string, over: Partial<PermitReply> = {}): PermitReply {
  return { witness, re: 'read', ok: true, held: null, list: LIST, joint: null, cfg: 'c', epoch: 0, progress: null, ops: [], grantable: true, ...over }
}
const answer = (r: PermitReply, round?: number): RemoteCallResult => ({ status: 200, body: { ok: true, reply: r, ...(round !== undefined ? { round } : {}) } })
const roundOf = (body: unknown): number | undefined => (body as { round?: number }).round

describe('what a reply must be to count', () => {
  it('names the witness asked and the request sent, and is whole', () => {
    expect(acceptReply({ ok: true, reply: reply('w1') }, 'w1', READ)?.witness).toBe('w1')
    // A machine that answers for another witness (a wrong alias), or to another request.
    expect(acceptReply({ ok: true, reply: reply('w1') }, 'w2', READ)).toBeNull()
    expect(acceptReply({ ok: true, reply: reply('w1', { re: 4 }) }, 'w1', READ)).toBeNull()
    expect(requestRe({ type: 'propose', record: { number: 7 } as never })).toBe(7)
    // Refusals, malformed bodies, torn answers.
    expect(acceptReply({ ok: false, error: 'not_found' }, 'w1', READ)).toBeNull()
    expect(acceptReply(null, 'w1', READ)).toBeNull()
    expect(acceptReply({ ok: true, reply: { ...reply('w1'), grantable: 'yes' } }, 'w1', READ)).toBeNull()
    expect(acceptReply({ ok: true, reply: { ...reply('w1'), held: { number: 'x' } } }, 'w1', READ)).toBeNull()
  })
})

describe('the transport with a fake call', () => {
  function build(remote: RemoteCall, o: { timeoutMs?: number; maxInFlight?: number } = {}) {
    const delivered: PermitReply[] = []
    const dropped: string[] = []
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
    const ticks: Array<() => void> = []
    const t = createWitnessTransport({
      placeOf: (id) => PLACES.find((p) => p.id === id), params: DEFAULT_PERMIT_PARAMS, walnutId: WALNUT, remote,
      deliver: (r) => delivered.push(r), defer: (fn) => ticks.push(fn),
      after: (ms, fn) => { const x = { at: ms, fn, live: true }; timers.push(x); return () => { x.live = false } },
      onDrop: (why) => dropped.push(why), ...o,
    })
    return { t, delivered, dropped, ticks, fire: () => { for (const x of timers) if (x.live) { x.live = false; x.fn() } }, runTicks: () => { while (ticks.length) ticks.shift()!() } }
  }

  it('hands a reply back on a later tick, never inside send', () => {
    const b = build((_p, _path, body, done) => { done(answer(reply('w1'), roundOf(body))) })
    b.t.send('w1', READ)
    expect(b.delivered).toEqual([])
    b.runTicks()
    expect(b.delivered.map((r) => r.witness)).toEqual(['w1'])
  })

  it('a duplicate answer to one request is one reply', () => {
    const b = build((_p, _path, body, done) => { done(answer(reply('w1'), roundOf(body))); done(answer(reply('w1'), roundOf(body))) })
    b.t.send('w1', READ)
    b.runTicks()
    expect(b.delivered).toHaveLength(1)
  })

  it('a reply after the timeout is dropped as a lost one, and the call is abandoned', () => {
    let finish: ((r: RemoteCallResult | null) => void) | null = null
    let abandoned = 0
    const b = build((_p, _path, _body, done) => { finish = done; return () => { abandoned++ } }, { timeoutMs: 20_000 })
    b.t.send('w1', READ)
    b.fire()
    finish!(answer(reply('w1'), 1))
    b.runTicks()
    expect(b.delivered).toEqual([])
    expect(b.dropped).toContain('late-reply')
    expect(abandoned).toBe(1)
  })

  it('throws away a reply from the wrong witness, to the wrong request, a refusal, and no answer', () => {
    // The rounds of the five reads are 1..5, each answered for its own round (so only what is wrong is wrong).
    const results: Array<(round: number) => RemoteCallResult | null> = [
      (n) => answer(reply('w3'), n), (n) => answer(reply('w1', { re: 9 }), n), () => ({ status: 404, body: { ok: false, error: 'not_found' } }), () => null, () => ({ status: 200, body: 'torn' }),
    ]
    const b = build((_p, _path, body, done) => { done(results.shift()!(roundOf(body)!)) })
    for (let i = 0; i < 5; i++) b.t.send('w1', READ)
    b.runTicks()
    expect(b.delivered).toEqual([])
    expect(b.dropped.sort()).toEqual(['bad-status', 'invalid-reply', 'invalid-reply', 'invalid-reply', 'no-answer'])
  })

  it('opens no more requests to a witness that holds too many open (a hung link never piles up), and frees one when it ends', () => {
    const open: Array<(r: RemoteCallResult | null) => void> = []
    const b = build((_p, _path, _body, done) => { open.push(done) }, { maxInFlight: 3 })
    for (let i = 0; i < 6; i++) b.t.send('w1', READ)
    b.t.send('w2', READ)
    expect(open).toHaveLength(4)
    expect(b.dropped.filter((d) => d === 'too-many-open')).toHaveLength(3)
    open[0]!(null)
    b.t.send('w1', READ)
    expect(open).toHaveLength(5)
  })

  it('sends the Walnut id, the witness and the request on the witness path; a witness not in the list gets nothing', () => {
    const seen: unknown[] = []
    const b = build((p, path, body, done) => { seen.push({ host: p.host, path, body }); done(null) })
    b.t.send('w2', READ)
    b.t.send('w9', READ)
    expect(seen).toEqual([{ host: 'm2', path: WITNESS_REQUEST_PATH, body: { v: 1, walnutId: WALNUT, witness: 'w2', request: READ, round: 1 } }])
  })
})

describe('a read is answered for its own round', () => {
  function rig() {
    const open: Array<{ body: { round?: number }; done: (r: RemoteCallResult | null) => void }> = []
    const delivered: PermitReply[] = []
    const dropped: string[] = []
    const ticks: Array<() => void> = []
    const t = createWitnessTransport({
      placeOf: (id) => PLACES.find((p) => p.id === id), params: DEFAULT_PERMIT_PARAMS, walnutId: WALNUT,
      remote: (_p, _path, body, done) => { open.push({ body: body as { round?: number }, done }) },
      deliver: (r) => delivered.push(r), defer: (fn) => ticks.push(fn), after: () => () => {}, onDrop: (why) => dropped.push(why),
    })
    return { t, open, delivered, dropped, run: () => { while (ticks.length) ticks.shift()!() } }
  }

  it('an answer that overtook a newer one never takes a witness back: the older answer arriving after it is dropped', () => {
    const r = rig()
    r.t.send('w1', READ)
    r.t.send('w1', READ)
    expect(r.open.map((o) => o.body.round)).toEqual([1, 2])
    r.open[1]!.done(answer(reply('w1', { epoch: 5 }), 2))
    r.open[0]!.done(answer(reply('w1', { epoch: 4 }), 1))
    r.run()
    expect(r.delivered.map((x) => x.epoch)).toEqual([5])
    expect(r.dropped).toContain('late-reply')
  })

  it('a witness slower than the interval between looks is still heard: its older answer counts when no newer one came first', () => {
    const r = rig()
    r.t.send('w1', READ)
    r.t.send('w1', READ)
    r.open[0]!.done(answer(reply('w1', { epoch: 4 }), 1))
    r.open[1]!.done(answer(reply('w1', { epoch: 5 }), 2))
    r.run()
    expect(r.delivered.map((x) => x.epoch)).toEqual([4, 5])
  })

  it('an answer that echoes no round, or another one, is no answer to a read', () => {
    const r = rig()
    r.t.send('w1', READ)
    r.t.send('w2', READ)
    r.open[0]!.done(answer(reply('w1')))
    r.open[1]!.done(answer(reply('w2'), 7))
    r.run()
    expect(r.delivered).toEqual([])
    expect(r.dropped).toEqual(['invalid-reply', 'invalid-reply'])
  })

  it('rounds are counted per witness, and a propose carries none', () => {
    const r = rig()
    r.t.send('w1', READ); r.t.send('w2', READ); r.t.send('w1', READ)
    r.t.send('w1', { type: 'propose', record: { number: 1 } as never })
    expect(r.open.map((o) => o.body.round)).toEqual([1, 1, 2, undefined])
  })
})

describe('a permit client over real witness machines', () => {
  let root = ''
  let machines: WitnessMachine[] = []
  const hosts = () => Object.fromEntries(machines.map((m) => [m.host, m]))

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'witness-net-'))
    machines = await Promise.all(PLACES.map((p) => startWitnessMachine({ host: p.host, root: path.join(root, p.host), walnutId: WALNUT })))
    const call = loopbackCall(hosts())
    for (const p of PLACES) expect(await setUpRemoteWitness(p, LIST, WALNUT, blankEvidence(LIST, p.id), call)).toEqual({ ok: true, made: true })
  })
  afterEach(async () => {
    await Promise.all(machines.map((m) => m.close()))
    fs.rmSync(root, { recursive: true, force: true })
  })

  const open = (id: string, call: RemoteCall = loopbackCall(hosts())) => openPermitClient(id, PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: call, walnutId: WALNUT })

  it('takes the permission with a majority, renews it, and keeps it with one witness down', async () => {
    const a = open('A')
    const g = await proposeAndWait(a, (c) => c.requestGrant())
    expect(g?.outcome).toBe('chosen')
    expect(a.client.mayAct()).toBe(true)
    machines[2]!.setUp(false)
    const r = await proposeAndWait(a, (c) => c.renew())
    expect(r?.outcome).toBe('chosen')
    // Two of three out of reach: nothing is chosen, and the lease is not extended by it.
    machines[1]!.setUp(false)
    const r2 = await proposeAndWait(a, (c) => c.renew(), 1_500)
    expect(r2?.outcome).toBe('open')
    const read = await readStanding(a, 800)
    expect(read.answered).toBe(1)
    machines[1]!.setUp(true)
    machines[2]!.setUp(true)
    expect((await proposeAndWait(a, (c) => c.renew()))?.outcome).toBe('chosen')
  }, 30_000)

  it('a second machine cannot take what the first holds, even from the witnesses only it reaches', async () => {
    const a = open('A')
    expect((await proposeAndWait(a, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    // B reaches w2 and w3; A took all three, so both hold A's live record and refuse B.
    const reach = loopbackCall({ m2: machines[1]!, m3: machines[2]! })
    const b = open('B', reach)
    const bg = await proposeAndWait(b, (c) => c.requestGrant(), 1_500)
    expect(bg?.outcome).not.toBe('chosen')
    expect(b.client.mayAct()).toBe(false)
    expect(a.client.mayAct()).toBe(true)
  }, 30_000)

  it('a process with no link of its own (a candidate) reaches the witnesses through a reach registered for the host', async () => {
    const direct = loopbackCall(hosts())
    // The seam a host-dialed door fills: a call to a host over a socket the host opened.
    const off = addWitnessReach((host, path, body) => {
      const call = body as { witness: string }
      return new Promise<RemoteCallResult>((resolve, reject) => {
        direct({ id: call.witness, host }, path, body as never, (r) => (r ? resolve(r) : reject(new Error('no answer'))))
      })
    })
    try {
      // The production call (what openPermitClient sets for remote witnesses): no daemon link exists in this test, only the registered reach.
      const h = openPermitClient('B', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { remote: hostLinkCall(), walnutId: WALNUT })
      expect((await proposeAndWait(h, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    } finally {
      off()
    }
  }, 30_000)

  it('a long read asks again on the next way a witness whose first way did not answer; a short read does not', async () => {
    // Two ways to each witness: the door first (it never answers here: a relay with nothing parked, a door out of
    // reach), then the link. init's setup read (10 s) must hear them all; a renew's short read stays one ask.
    const twoWays = PLACES.map((p) => ({ ...p, url: 'https://door.invalid/leader-witness', key: 'k'.repeat(43) }))
    const silentDoor: RemoteCall = (_p, _path, _body, done) => { done(null) }
    const client = (id: string) => openPermitClient(id, twoWays, DEFAULT_PERMIT_PARAMS, undefined, { remote: loopbackCall(hosts()), direct: silentDoor, walnutId: WALNUT })
    expect((await readStanding(client('short'), 600)).answered).toBe(0)
    const long = await readStanding(client('long'), 5_000)
    expect(long.answered).toBe(3)
    expect(long.standing).toBeNull()
  }, 30_000)

  it('a standby or a reader command (no daemon link allowed, no reach registered) describes this Walnut to no host and reaches no remote witness', async () => {
    const h = openPermitClient('S', PLACES, DEFAULT_PERMIT_PARAMS, undefined, { walnutId: WALNUT })
    const read = await readStanding(h, 600)
    expect(read.answered).toBe(0)
    expect((await proposeAndWait(h, (c) => c.requestGrant(), 600))?.outcome).not.toBe('chosen')
    // The pooled daemon link (a full DaemonConnection) is only ever loaded when the leader server asked for it.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/core/leader/switch/witness-transport.ts'), 'utf8')
    expect(src.indexOf("if (!o.daemonLink) { done(null); return }")).toBeGreaterThan(0)
    expect(src.indexOf("if (!o.daemonLink) { done(null); return }")).toBeLessThan(src.indexOf('overDaemonLink(host, '))
  }, 30_000)

  it('measures the renew round trip: a real client, three real witnesses, the grant on disk before each answer', async () => {
    const a = open('A')
    expect((await proposeAndWait(a, (c) => c.requestGrant()))?.outcome).toBe('chosen')
    const times: number[] = []
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now()
      const r = await proposeAndWait(a, (c) => c.renew())
      expect(r?.outcome).toBe('chosen')
      times.push(performance.now() - t0)
    }
    times.sort((x, y) => x - y)
    // proposeAndWait polls every 20 ms, so a time here is the round trip rounded up to the next poll.
    const stat = { median: times[20]!, p95: times[38]!, max: times[39]! }
    // eslint-disable-next-line no-console
    console.log(`\nrenew round trip over loopback doors, 3 witnesses (ms): median ${stat.median.toFixed(1)}, p95 ${stat.p95.toFixed(1)}, max ${stat.max.toFixed(1)}\n`)
    expect(stat.median).toBeLessThan(500)
  }, 60_000)
})
