/**
 * The write permission's pieces on their own: the witness rules, the durable store on a
 * real file system, the two clocks, the automatic takeover rule and assertMayAct.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMIT_PARAMS, PermitClient, PermitNotHeld, PermitWitness, bootstrapWitnessStore, checkTiming,
  DISTRUST_STEP_MS, createFilePermitStore, createHolderClock, encodeStored, judge, mayAskForTakeover, maxSafeDrift,
  genesisConfigId, type PermitRecord, type PermitReply, type PermitRequest, type WitnessState,
} from '../../../../src/core/leader/permit/index.js'
import { SimStore } from './sim.js'

const P = DEFAULT_PERMIT_PARAMS
const W = ['w1', 'w2', 'w3']
const G = genesisConfigId(W)
const rec = (number: number, kind: PermitRecord['kind'], by: string, extra: Partial<PermitRecord> = {}): PermitRecord => ({
  number, kind, by, holder: by, nonce: 'n1', validMs: P.validMs, list: W, cfg: G, ...extra,
})
const empty: WitnessState = { held: null, acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }

describe('judge: what a witness accepts', () => {
  it('a grant on nothing, then only the holder renews while it lasts', () => {
    const g = judge(empty, 'w1', rec(1, 'grant', 'A'), 0, P)
    expect(g.ok).toBe(true)
    const s = (g as { next: WitnessState }).next
    expect(judge(s, 'w1', rec(2, 'renew', 'A'), 10_000, P).ok).toBe(true)
    expect(judge(s, 'w1', rec(2, 'renew', 'B'), 10_000, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), 10_000, P)).toEqual({ ok: false, reason: 'held' })
  })

  it('grants to another machine only once validMs plus the witness margin ran out on its clock', () => {
    const s: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }
    const edge = P.validMs + P.witnessMarginMs
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), edge - 1, P).ok).toBe(false)
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), edge, P).ok).toBe(true)
    // And a renew that comes after that is refused: the holder must ask again.
    expect(judge(s, 'w1', rec(2, 'renew', 'A'), edge, P).ok).toBe(false)
  })

  it('never takes a number that is not above what it holds (a replay or a duplicate)', () => {
    const s: WitnessState = { held: rec(5, 'renew', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }
    for (const n of [1, 4, 5]) expect(judge(s, 'w1', rec(n, 'renew', 'A'), 1, P)).toEqual({ ok: false, reason: 'stale-number' })
  })

  it('a replayed or duplicated old record never lowers the number a witness holds, across a restart too', () => {
    const store = new SimStore()
    bootstrapWitnessStore(store, W)
    let t = 0
    const clock = { now: () => t }
    let w = new PermitWitness({ id: 'w1', store, clock, params: P })
    const sent = [rec(1, 'grant', 'A'), rec(2, 'renew', 'A'), rec(3, 'renew', 'A')]
    for (const r of sent) expect(w.handle({ type: 'propose', record: r }).ok).toBe(true)
    for (const r of [...sent, sent[0], sent[1]]) {
      t += 100
      const a = w.handle({ type: 'propose', record: r })
      expect(a.ok).toBe(false)
      expect(a.held?.number).toBe(3)
    }
    w = new PermitWitness({ id: 'w1', store, clock, params: P })
    for (const r of sent) expect(w.handle({ type: 'propose', record: r }).held?.number).toBe(3)
  })

  it('a handover comes only from the live holder; then the new holder renews and the old one cannot', () => {
    const s: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }
    expect(judge(s, 'w1', rec(2, 'handover', 'C', { from: 'C', to: 'B', holder: 'B' }), 1, P).ok).toBe(false)
    const h = judge(s, 'w1', rec(2, 'handover', 'A', { from: 'A', to: 'B', holder: 'B' }), 1, P)
    expect(h.ok).toBe(true)
    const s2 = (h as { next: WitnessState }).next
    expect(judge(s2, 'w1', rec(3, 'renew', 'A'), 2, P).ok).toBe(false)
    expect(judge(s2, 'w1', rec(3, 'renew', 'B'), 2, P).ok).toBe(true)
  })

  it('a cancel stands on its own handover or its own live record, never on the new holder\'s renew', () => {
    const ho = rec(2, 'handover', 'A', { from: 'A', to: 'B', holder: 'B' })
    const cancel = rec(3, 'cancel', 'A', { from: 'A' })
    expect(judge({ held: ho, acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }, 'w1', cancel, 1, P).ok).toBe(true)
    expect(judge({ held: rec(1, 'renew', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }, 'w1', cancel, 1, P).ok).toBe(true)
    expect(judge({ held: rec(2, 'renew', 'B'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }, 'w1', cancel, 1, P).ok).toBe(false)
  })

  it('refuses a record judged by another list, and a witness waiting to join takes only its members record', () => {
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { list: ['w1', 'w2', 'w4'] }), 0, P)).toEqual({ ok: false, reason: 'wrong-list' })
    const joining: WitnessState = { held: null, acceptedAt: 0, list: null, joint: null }
    expect(judge(joining, 'w4', rec(1, 'grant', 'A'), 0, P)).toEqual({ ok: false, reason: 'not-a-member' })
    const m = judge(joining, 'w4', rec(9, 'members', 'A', { newList: ['w1', 'w2', 'w4'], joint: ['w1', 'w2', 'w4'], stage: 'joint' }), 0, P)
    expect(m.ok && [m.next.list, m.next.joint]).toEqual([W, ['w1', 'w2', 'w4']])
  })

  it('a list change goes old list -> pair -> new list, and a pair witness takes only pair records', () => {
    const N = ['w1', 'w2', 'w4']
    const base: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }
    // The final step straight from the old list is refused: the pair comes first.
    expect(judge(base, 'w1', rec(2, 'members', 'A', { newList: N, joint: N, stage: 'final' }), 1, P)).toEqual({ ok: false, reason: 'wrong-list' })
    const j = judge(base, 'w1', rec(2, 'members', 'A', { newList: N, joint: N, stage: 'joint' }), 1, P)
    expect(j.ok).toBe(true)
    const pair = (j as { next: WitnessState }).next
    expect([pair.list, pair.joint]).toEqual([W, N])
    // In the pair: neither list alone, only the pair.
    expect(judge(pair, 'w1', rec(3, 'renew', 'A'), 2, P)).toEqual({ ok: false, reason: 'wrong-list' })
    expect(judge(pair, 'w1', rec(3, 'renew', 'A', { list: N }), 2, P)).toEqual({ ok: false, reason: 'wrong-list' })
    expect(judge(pair, 'w1', rec(3, 'renew', 'A', { joint: N }), 2, P).ok).toBe(true)
    // Another change from the old list cannot take the pair over.
    const other = ['w1', 'w3', 'w4']
    expect(judge(pair, 'w1', rec(3, 'members', 'A', { newList: other, joint: other, stage: 'joint' }), 2, P).ok).toBe(false)
    const f = judge(pair, 'w1', rec(3, 'members', 'A', { newList: N, joint: N, stage: 'final' }), 2, P)
    expect(f.ok && [f.next.list, f.next.joint]).toEqual([N, null])
    // A witness the change drops is out after the final step.
    const out = judge(pair, 'w3', rec(3, 'members', 'A', { newList: N, joint: N, stage: 'final' }), 2, P)
    expect(out.ok).toBe(true)
    const gone = (out as { next: WitnessState }).next
    expect(judge(gone, 'w3', rec(4, 'renew', 'A', { list: N }), 3, P)).toEqual({ ok: false, reason: 'not-a-member' })
  })

  it('refuses malformed records', () => {
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { holder: 'B' }), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { validMs: 10 * P.validMs }), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(0, 'grant', 'A'), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(1.5, 'grant', 'A'), 0, P).ok).toBe(false)
  })
})

describe('timing parameters', () => {
  it('the defaults are safe for their assumed drift, and the safe bound is (W-L)/(W+L)', () => {
    expect(() => checkTiming(P)).not.toThrow()
    expect(maxSafeDrift(P)).toBeCloseTo((62_000 - 58_000) / 120_000, 10)
  })
  it('refuses margins that do not cover the assumed drift, and renews slower than the lease', () => {
    expect(() => checkTiming({ ...P, holderMarginMs: 0, witnessMarginMs: 0 })).toThrow(/drift/)
    expect(() => checkTiming({ ...P, maxDriftRate: 0.05 })).toThrow(/drift/)
    expect(() => checkTiming({ ...P, renewEveryMs: 58_000 })).toThrow(/renewEveryMs/)
    expect(() => checkTiming({ ...P, holderMarginMs: 60_000 })).toThrow()
  })
})

describe('the holder clock', () => {
  it('counts a sleep (the monotonic clock stops, the wall clock does not)', () => {
    let mono = 0, wall = 1_000_000
    const c = createHolderClock({ monotonic: () => mono, wall: () => wall })
    mono = 10; wall += 10
    expect(c.now()).toBe(10)
    wall += 90_000 // asleep: only the wall clock moves
    expect(c.now()).toBe(90_010)
  })
  it('a wall clock set forward only ends the permission early', () => {
    let mono = 0, wall = 1_000_000
    const c = createHolderClock({ monotonic: () => mono, wall: () => wall })
    wall += 3_600_000
    expect(c.now()).toBe(3_600_000)
    mono += 1_000; wall += 1_000
    expect(c.now()).toBe(3_601_000)
  })
  it('a wall clock set back by more than the tolerance ends what is held (it may hide a sleep), and never steps back', () => {
    let mono = 0, wall = 1_000_000
    const c = createHolderClock({ monotonic: () => mono, wall: () => wall })
    mono += 1_000; wall += 1_000 - 500 // a small correction: counted as the monotonic step
    expect(c.now()).toBe(1_000)
    // Asleep 88 s (monotonic stopped) while the wall clock was set back 100 s.
    wall += 88_000 - 100_000
    expect(c.now()).toBe(1_000 + DISTRUST_STEP_MS)
    mono += 1_000; wall += 1_000
    expect(c.now()).toBe(2_000 + DISTRUST_STEP_MS)
  })
})

describe('mayAskForTakeover', () => {
  const read = (witness: string, grantable: boolean, held: PermitRecord | null): PermitReply => ({ witness, re: 'read', ok: true, held, list: W, joint: null, cfg: G, progress: held?.progress ?? null, grantable })
  const last = rec(7, 'renew', 'A', { progress: { seq: 100, writtenAt: 1_000_000 } })
  const base = { list: W, params: P, maxBehindMs: 5 * 60_000 }

  it('allows it when the old permission ran out on a majority and the copy is close enough', () => {
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 99, writtenAt: 1_000_000 - 60_000 } })
    expect(a.ok).toBe(true)
    expect(a.ok && a.behindAtMostMs).toBe(60_000 + 58_000)
  })
  it('refuses while the old permission still holds on a majority, counted on the fixed list', () => {
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', false, last), read('w3', false, last)], standby: { seq: 100 } }).ok).toBe(false)
    // One witness answering "ran out" is not a majority of three, however few answered.
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last)], standby: { seq: 100 } }).ok).toBe(false)
    // An answer from a witness not on the list counts for nothing.
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w9', true, last)], standby: { seq: 100 } }).ok).toBe(false)
  })
  it('refuses when the standby copy is behind the limit', () => {
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 50, writtenAt: 1_000_000 - 5 * 60_000 } })
    expect(a.ok).toBe(false)
    expect(!a.ok && a.reason).toMatch(/behind/)
  })
  it('refuses when nothing proves how far behind it is', () => {
    const bare = rec(7, 'renew', 'A')
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, bare), read('w2', true, bare)], standby: { seq: 100 } }).ok).toBe(false)
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 99 } }).ok).toBe(false)
  })
  it('does not count a witness that serves another list', () => {
    const moved: PermitReply = { ...read('w2', true, last), list: ['w1', 'w2', 'w4'] }
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), moved], standby: { seq: 100 } }).ok).toBe(false)
  })
  it('a contending grant with an old stamp on top does not hide how far the real holder wrote (review S-2)', () => {
    // The holder's renew carried seq 100; then C's grant (seq 5) reached w1 and w2 once it ran out.
    const s0: WitnessState = { held: null, acceptedAt: 0, list: W, joint: null, cfg: G, progress: null }
    const a = judge(s0, 'w1', rec(1, 'grant', 'A', { progress: { seq: 100, writtenAt: 1_000_000 } }), 0, P)
    const s1 = (a as { next: WitnessState }).next
    const c = judge(s1, 'w1', rec(2, 'grant', 'C', { progress: { seq: 5, writtenAt: 10 } }), 70_000, P)
    const s2 = (c as { next: WitnessState }).next
    expect(s2.held!.holder).toBe('C')
    expect(s2.progress).toEqual({ seq: 100, writtenAt: 1_000_000 })
    const grantC = rec(2, 'grant', 'C', { progress: { seq: 5, writtenAt: 10 } })
    const reads = ['w1', 'w2'].map((id) => ({ ...read(id, true, grantC), progress: { seq: 100, writtenAt: 1_000_000 } }))
    const ans = mayAskForTakeover({ ...base, reads, standby: { seq: 5, writtenAt: 10 } })
    expect(ans.ok).toBe(false)
    // A grant with no stamp at all does not block every other candidate (review S-3).
    const bare = ['w1', 'w2'].map((id) => ({ ...read(id, true, rec(2, 'grant', 'C')), progress: { seq: 100, writtenAt: 1_000_000 } }))
    expect(mayAskForTakeover({ ...base, reads: bare, standby: { seq: 100, writtenAt: 1_000_000 } }).ok).toBe(true)
  })
  it('reads the newest record among the answers, not the first', () => {
    const old = rec(3, 'renew', 'A', { progress: { seq: 10, writtenAt: 0 } })
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, old), read('w2', true, last)], standby: { seq: 10, writtenAt: 0 } })
    expect(a.ok).toBe(false)
  })
})

describe('assertMayAct', () => {
  function holder() {
    let t = 0
    const replies: Array<() => void> = []
    const witnesses = W.map((id) => {
      const store = new SimStore()
      bootstrapWitnessStore(store, W)
      return new PermitWitness({ id, store, clock: { now: () => t }, params: P })
    })
    const c: PermitClient = new PermitClient({
      id: 'A', list: W, params: P, clock: { now: () => t },
      transport: { send: (w: string, req: PermitRequest) => { const r = witnesses.find((x) => x.id === w)!.handle(req); replies.push(() => c.receive(r)) } },
    })
    const flush = () => { while (replies.length) replies.shift()!() }
    return { c, flush, at: (ms: number) => { t = ms } }
  }

  it('passes with enough left, refuses with under minSendRemainingMs, and refuses during a handover', () => {
    const h = holder()
    expect(() => h.c.assertMayAct('op-1')).toThrow(PermitNotHeld)
    h.c.requestGrant()
    h.flush()
    expect(h.c.mayAct()).toBe(true)
    expect(() => h.c.assertMayAct('op-1')).not.toThrow()
    h.at(P.validMs - P.holderMarginMs - P.minSendRemainingMs + 1)
    expect(h.c.mayAct()).toBe(true)
    expect(() => h.c.assertMayAct('op-2')).toThrow(/ms left/)
    h.at(1_000)
    h.c.handover('B')
    expect(h.c.mayAct()).toBe(false)
    expect(() => h.c.assertMayAct('op-3')).toThrow(/handover/)
  })
})

describe('the file store', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })
  const mk = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-store-')))

  it('round-trips, and a witness reads back after a restart what it accepted', () => {
    const file = path.join(mk(), 'witness.json')
    const store = createFilePermitStore(file)
    bootstrapWitnessStore(store, W)
    const w1 = new PermitWitness({ id: 'w1', store, clock: { now: () => 0 }, params: P })
    expect(w1.handle({ type: 'propose', record: rec(1, 'grant', 'A') }).ok).toBe(true)
    const again = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock: { now: () => 0 }, params: P })
    expect(again.handle({ type: 'read' }).held?.number).toBe(1)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  for (const [name, text] of [
    ['half written', (good: string) => good.slice(0, Math.floor(good.length / 2))],
    ['checksum mismatch', (good: string) => good.replace('"number":1', '"number":0')],
    ['empty', () => ''],
    ['garbage', () => '\u0000\u0001not json'],
  ] as const) {
    it(`refuses loudly a file that is ${name}, never as "no record"`, () => {
      const file = path.join(mk(), 'witness.json')
      fs.writeFileSync(file, text(encodeStored({ held: rec(1, 'grant', 'A'), list: W, joint: null, cfg: G, progress: null })))
      const logs: string[] = []
      const w = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock: { now: () => 1e9 }, params: P, log: (l, m) => logs.push(`${l} ${m}`) })
      expect(w.brokenReason()).toBeTruthy()
      expect(logs.some((l) => l.startsWith('error'))).toBe(true)
      // Not even a grant on what would look like an empty record.
      const a = w.handle({ type: 'propose', record: rec(2, 'grant', 'B') })
      expect(a.ok).toBe(false)
      expect(a.reason).toMatch(/store-broken/)
      expect(a.grantable).toBe(false)
      expect(w.handle({ type: 'read' }).ok).toBe(false)
      // And the setup step will not paper over it.
      expect(() => bootstrapWitnessStore(createFilePermitStore(file), W)).toThrow()
    })
  }

  it('a witness with no file at all is not set up: it waits to join, it grants nothing', () => {
    const file = path.join(mk(), 'witness.json')
    const w = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock: { now: () => 0 }, params: P })
    const a = w.handle({ type: 'propose', record: rec(1, 'grant', 'A') })
    expect(a).toMatchObject({ ok: false, reason: 'not-a-member' })
  })

  it('answers no, and nothing after, when the record cannot be made durable', () => {
    const file = path.join(mk(), 'witness.json')
    const good = createFilePermitStore(file)
    bootstrapWitnessStore(good, W)
    let failSync = false
    const flaky = createFilePermitStore(file, {
      ...fs,
      fsyncSync: (fd: number) => { if (failSync) throw new Error('EIO'); fs.fsyncSync(fd) },
    } as typeof fs)
    const w = new PermitWitness({ id: 'w1', store: flaky, clock: { now: () => 0 }, params: P })
    failSync = true
    const a = w.handle({ type: 'propose', record: rec(1, 'grant', 'A') })
    expect(a.ok).toBe(false)
    failSync = false
    expect(w.handle({ type: 'propose', record: rec(2, 'grant', 'A') }).ok).toBe(false)
    // What is on disk is still the last durable record, and no temp files are left.
    expect(good.load()!.held).toBeNull()
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('fsyncs the file before the rename and the directory after it', () => {
    const file = path.join(mk(), 'witness.json')
    const calls: string[] = []
    const spy = {
      ...fs,
      fsyncSync: (fd: number) => { calls.push('fsync'); fs.fsyncSync(fd) },
      renameSync: (a: fs.PathLike, b: fs.PathLike) => { calls.push('rename'); fs.renameSync(a, b) },
    } as typeof fs
    createFilePermitStore(file, spy).save({ held: null, list: W, joint: null, cfg: G, progress: null })
    expect(calls).toEqual(['fsync', 'rename', 'fsync'])
  })
})
