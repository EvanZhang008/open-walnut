/**
 * The write permission's pieces on their own: the witness rules, the durable store on a
 * real file system, the two clocks, the automatic takeover rule and assertMayAct.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMIT_PARAMS, NO_HOLDER, PermitClient, PermitNotHeld, PermitWitness, bootstrapWitnessStore, checkTiming, grantable,
  DISTRUST_STEP_MS, createFilePermitStore, createHolderClock, encodeStored, judge, mayAskForTakeover, maxSafeDrift,
  genesisConfigId, generationToJoin, prepareJoiningWitness, type PermitRecord, type PermitReply, type PermitRequest, type WitnessState,
} from '../../../../src/core/leader/permit/index.js'
import { SimStore } from './sim.js'

const P = DEFAULT_PERMIT_PARAMS
const W = ['w1', 'w2', 'w3']
const G = genesisConfigId(W)
const rec = (number: number, kind: PermitRecord['kind'], by: string, extra: Partial<PermitRecord> = {}): PermitRecord => ({
  number, kind, by, holder: by, nonce: 'n1', validMs: P.validMs, list: W, cfg: G, epoch: 0,
  // A final step names who held its pair: here every witness of both lists, unless a case says otherwise.
  ...(extra.stage === 'final' ? { pairBy: [...new Set([...(extra.list ?? W), ...(extra.newList ?? [])])] } : {}),
  ...extra,
})
const empty: WitnessState = { held: null, acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }

describe('judge: what a witness accepts', () => {
  it('a grant on nothing, then only the holder renews while it lasts', () => {
    const g = judge(empty, 'w1', rec(1, 'grant', 'A'), 0, P)
    expect(g.ok).toBe(true)
    const s = (g as { next: WitnessState }).next
    expect(judge(s, 'w1', rec(2, 'renew', 'A'), 10_000, P).ok).toBe(true)
    expect(judge(s, 'w1', rec(2, 'renew', 'B'), 10_000, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), 10_000, P)).toEqual({ ok: false, reason: 'held' })
  })

  it('a grant of the holder\'s own process on its live record is taken as its renew would be; another process\'s, or one on a handover, waits', () => {
    // The retake after a failed trial: one witness took this process's grant alone; its next grant must stand there too.
    const own = (h: PermitRecord): WitnessState => ({ ...empty, held: h, acceptedAt: 0 })
    expect(judge(own(rec(1, 'grant', 'A')), 'w1', rec(2, 'grant', 'A'), 10_000, P).ok).toBe(true)
    expect(judge(own(rec(1, 'renew', 'A')), 'w1', rec(2, 'grant', 'A'), 10_000, P).ok).toBe(true)
    expect(judge(own(rec(1, 'cancel', 'A', { from: 'A' })), 'w1', rec(2, 'grant', 'A'), 10_000, P).ok).toBe(true)
    // Another process of the same machine is another holder (the incarnation).
    expect(judge(own(rec(1, 'grant', 'A')), 'w1', rec(2, 'grant', 'A', { nonce: 'n2' }), 10_000, P)).toEqual({ ok: false, reason: 'held' })
    // Its own handover: the permission is on its way to the new holder; only a cancel takes it back.
    expect(judge(own(rec(1, 'handover', 'A', { holder: 'B', from: 'A', to: 'B' })), 'w1', rec(2, 'grant', 'A'), 10_000, P)).toEqual({ ok: false, reason: 'held' })
    // The new holder of that handover may not grant itself on it either (its commit is a renew).
    expect(judge(own(rec(1, 'handover', 'A', { holder: 'B', from: 'A', to: 'B' })), 'w1', rec(2, 'grant', 'B'), 10_000, P)).toEqual({ ok: false, reason: 'held' })
    // A lower number is still refused.
    expect(judge(own(rec(3, 'grant', 'A')), 'w1', rec(2, 'grant', 'A'), 10_000, P)).toEqual({ ok: false, reason: 'stale-number' })
  })

  it('grants to another machine only once validMs plus the witness margin ran out on its clock', () => {
    const s: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }
    const edge = P.validMs + P.witnessMarginMs
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), edge - 1, P).ok).toBe(false)
    expect(judge(s, 'w1', rec(2, 'grant', 'B'), edge, P).ok).toBe(true)
    // And a renew that comes after that is refused: the holder must ask again.
    expect(judge(s, 'w1', rec(2, 'renew', 'A'), edge, P).ok).toBe(false)
  })

  it('never takes a number that is not above what it holds (a replay or a duplicate)', () => {
    const s: WitnessState = { held: rec(5, 'renew', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }
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
    const s: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }
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
    expect(judge({ held: ho, acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }, 'w1', cancel, 1, P).ok).toBe(true)
    expect(judge({ held: rec(1, 'renew', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }, 'w1', cancel, 1, P).ok).toBe(true)
    expect(judge({ held: rec(2, 'renew', 'B'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }, 'w1', cancel, 1, P).ok).toBe(false)
  })

  it('refuses a record judged by another list, and a witness waiting to join takes only its members record', () => {
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { list: ['w1', 'w2', 'w4'] }), 0, P)).toEqual({ ok: false, reason: 'wrong-list' })
    const joining: WitnessState = { held: null, acceptedAt: 0, list: null, joint: null, cfg: null, epoch: 0, progress: null, ops: [] }
    expect(judge(joining, 'w4', rec(1, 'grant', 'A'), 0, P)).toEqual({ ok: false, reason: 'not-a-member' })
    const m = judge(joining, 'w4', rec(9, 'members', 'A', { newList: ['w1', 'w2', 'w4'], joint: ['w1', 'w2', 'w4'], stage: 'joint' }), 0, P)
    expect(m.ok && [m.next.list, m.next.joint]).toEqual([W, ['w1', 'w2', 'w4']])
  })

  it('a list change goes old list -> pair -> new list, and a pair witness takes only pair records', () => {
    const N = ['w1', 'w2', 'w4']
    const base: WitnessState = { held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }
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

  it('a witness that left at generation 2 refuses a late step of an older change, and joins from 2 on (stress seed 8618)', () => {
    const N = ['w1', 'w2', 'w5']
    const retired: WitnessState = { held: rec(25, 'members', 'B'), acceptedAt: 0, list: W, joint: null, cfg: 'c2', epoch: 2, progress: null, ops: [] }
    const stale = rec(29, 'members', 'B', { newList: N, joint: N, stage: 'final', epoch: 0 })
    expect(judge(retired, 'w5', stale, 1, P)).toEqual({ ok: false, reason: 'not-a-member' })
    const staleJoint = rec(30, 'members', 'B', { newList: N, joint: N, stage: 'joint', epoch: 1 })
    expect(judge(retired, 'w5', staleJoint, 1, P).ok).toBe(false)
    const fresh = rec(31, 'members', 'B', { cfg: 'c2', newList: N, joint: N, stage: 'joint', epoch: 2 })
    const j = judge(retired, 'w5', fresh, 1, P)
    expect(j.ok && [j.next.list, j.next.joint, j.next.epoch]).toEqual([W, N, 2])
  })

  it('refuses malformed records', () => {
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { holder: 'B' }), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(1, 'grant', 'A', { validMs: 10 * P.validMs }), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(0, 'grant', 'A'), 0, P).ok).toBe(false)
    expect(judge(empty, 'w1', rec(1.5, 'grant', 'A'), 0, P).ok).toBe(false)
  })
})

describe('a witness record opened with two clocks (a witness dir: each process judges with its own params)', () => {
  // A process whose permit is scaled to a tenth (WALNUT_LEADER_PERMIT_VALID_MS=6000, settings.ts permitParamsFor).
  const S = { ...P, validMs: 6_000, renewEveryMs: 1_500, holderMarginMs: 200, witnessMarginMs: 200, minSendRemainingMs: 1_500, backoffBaseMs: 200, backoffMaxMs: 3_000 }
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = '' })

  it('the scaled process\'s grant is refused while the default process\'s record is held there, the whole default time', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permit-two-clocks-'))
    const file = path.join(dir, 'permit-record.json')
    bootstrapWitnessStore(createFilePermitStore(file), W)
    let t = 0
    const clock = { now: () => t }
    // Machine B's process, default clocks, takes the record.
    const byDefault = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock, params: P })
    expect(byDefault.handle({ type: 'propose', record: rec(1, 'grant', 'B') }).ok).toBe(true)
    // Machine A's process opens the same dir with scaled clocks (it reads the record at t = 0).
    const scaled = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock, params: S })
    const grantA = (n: number) => scaled.handle({ type: 'propose', record: { ...rec(n, 'grant', 'A', { nonce: 'a1' }), validMs: S.validMs } })
    // Past the scaled hold (6.2 s), inside the default one (62 s): refused.
    t = S.validMs + S.witnessMarginMs
    expect(grantA(2)).toMatchObject({ ok: false, reason: 'held' })
    t = P.validMs + P.witnessMarginMs - 1
    expect(grantA(2)).toMatchObject({ ok: false, reason: 'held' })
    // B's record ran out by its own validity: A's grant stands.
    t = P.validMs + P.witnessMarginMs
    expect(grantA(2).ok).toBe(true)
    // The other way round only waits longer: a default judge keeps A's short record its own whole time.
    const s: WitnessState = { ...empty, held: { ...rec(2, 'grant', 'A'), validMs: S.validMs }, acceptedAt: 0 }
    expect(judge(s, 'w1', rec(3, 'grant', 'B'), S.validMs + S.witnessMarginMs, P)).toEqual({ ok: false, reason: 'held' })
    expect(judge(s, 'w1', rec(3, 'grant', 'B'), P.validMs + P.witnessMarginMs, P).ok).toBe(true)
  })
})

describe('judge: a release', () => {
  const release = (number: number, by: string, extra: Partial<PermitRecord> = {}) => rec(number, 'release', by, { holder: NO_HOLDER, from: by, ...extra })
  const holding = (h: PermitRecord, acceptedAt = 0): WitnessState => ({ ...empty, held: h, acceptedAt })
  const after = (j: ReturnType<typeof judge>) => (j as { next: WitnessState }).next

  it('comes only from the holder of the live record, same incarnation, and is a hold already over', () => {
    const s = holding(rec(1, 'grant', 'A'))
    expect(judge(s, 'w1', release(2, 'B'), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', release(2, 'A', { nonce: 'n2' }), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    // After the hold ran out it is refused like a renew (nothing to hand back).
    expect(judge(s, 'w1', release(2, 'A'), P.validMs + P.witnessMarginMs, P)).toEqual({ ok: false, reason: 'not-holder' })
    const r = judge(s, 'w1', release(2, 'A'), 1, P)
    expect(r.ok).toBe(true)
    // One millisecond later another machine's grant is taken, not 62 s later.
    expect(grantable(after(r), 'w1', 2, P)).toBe(true)
    expect(judge(after(r), 'w1', rec(3, 'grant', 'B'), 2, P).ok).toBe(true)
    // And the next process of the same machine (a new incarnation) too.
    expect(judge(after(r), 'w1', rec(3, 'grant', 'A', { nonce: 'n2' }), 2, P).ok).toBe(true)
  })

  it('a renew, handover, cancel or second release on it is refused, from its writer too', () => {
    const s = after(judge(holding(rec(1, 'grant', 'A')), 'w1', release(2, 'A'), 1, P))
    expect(judge(s, 'w1', rec(3, 'renew', 'A'), 2, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', rec(3, 'handover', 'A', { from: 'A', to: 'B', holder: 'B' }), 2, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(s, 'w1', rec(3, 'cancel', 'A', { from: 'A' }), 2, P)).toEqual({ ok: false, reason: 'nothing-to-cancel' })
    expect(judge(s, 'w1', release(3, 'A'), 2, P)).toEqual({ ok: false, reason: 'not-holder' })
    // A witness that restarts with the release on disk holds nothing for anyone either.
    expect(grantable({ ...s, acceptedAt: 1_000_000 }, 'w1', 1_000_000, P)).toBe(true)
  })

  it('is refused on a handover (the permission is on its way to its new holder) and on another holder\'s record', () => {
    const ho = rec(2, 'handover', 'A', { from: 'A', to: 'B', holder: 'B' })
    expect(judge(holding(ho), 'w1', release(3, 'A'), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    expect(judge(holding(rec(3, 'renew', 'B')), 'w1', release(4, 'A'), 1, P)).toEqual({ ok: false, reason: 'not-holder' })
    // On the holder's own cancel it is taken (that is its live record again).
    expect(judge(holding(rec(3, 'cancel', 'A', { from: 'A' })), 'w1', release(4, 'A'), 1, P).ok).toBe(true)
  })

  it('carries outcomes, never a registration; gives the permission to nobody', () => {
    const s = holding(rec(1, 'grant', 'A'))
    expect(judge(s, 'w1', release(2, 'A', { ops: { register: ['op1'] } }), 1, P)).toEqual({ ok: false, reason: 'bad-ops' })
    const r = judge(s, 'w1', release(2, 'A', { ops: { sent: ['op1'], notSent: ['op2'] } }), 1, P)
    expect(r.ok && r.next.ops.map((e) => [e.id, e.state])).toEqual([['op1', 'sent'], ['op2', 'not-sent']])
    expect(judge(s, 'w1', release(2, 'A', { holder: 'A' }), 1, P)).toEqual({ ok: false, reason: 'bad-release' })
    expect(judge(s, 'w1', release(2, 'A', { from: 'B' }), 1, P)).toEqual({ ok: false, reason: 'bad-release' })
    expect(judge(s, 'w1', release(2, 'A', { to: 'B' }), 1, P)).toEqual({ ok: false, reason: 'bad-release' })
    // No machine is named by the empty id: a grant or renew by it is malformed.
    expect(judge(empty, 'w1', rec(1, 'grant', NO_HOLDER), 0, P)).toEqual({ ok: false, reason: 'bad-holder' })
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
  const read = (witness: string, grantable: boolean, held: PermitRecord | null): PermitReply => ({ witness, re: 'read', ok: true, held, list: W, joint: null, cfg: G, epoch: 0, progress: held?.progress ?? null, grantable })
  const last = rec(7, 'renew', 'A', { progress: { seq: 100, writtenAt: 1_000_000, by: 'A' } })
  const base = { list: W, params: P, maxBehindMs: 5 * 60_000 }

  it('allows it when the old permission ran out on a majority and the copy is close enough', () => {
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 99, writtenAt: 1_000_000 - 60_000, writtenBy: 'A' } })
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
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 50, writtenAt: 1_000_000 - 5 * 60_000, writtenBy: 'A' } })
    expect(a.ok).toBe(false)
    expect(!a.ok && a.reason).toMatch(/behind/)
  })
  it('refuses when nothing proves how far behind it is', () => {
    const bare = rec(7, 'renew', 'A')
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, bare), read('w2', true, bare)], standby: { seq: 100 } }).ok).toBe(false)
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), read('w2', true, last)], standby: { seq: 99 } }).ok).toBe(false)
  })
  it('never subtracts two machines\' wall clocks; the sequence is one for the Walnut and a new holder continues it (review round 2)', () => {
    // A wrote up to seq 100; B took over from that copy and wrote on to seq 150.
    const bLast = rec(9, 'renew', 'B', { progress: { seq: 150, writtenAt: 5_000_000, by: 'B' } })
    const reads = [read('w1', true, bLast), read('w2', true, last)]
    // A copy whose newest write is A's seq 120: its stamp is on A's clock, the last on B's.
    expect(mayAskForTakeover({ ...base, reads, standby: { seq: 120, writtenAt: 4_990_000, writtenBy: 'A' } }).ok).toBe(false)
    // A copy of B's seq 140, stamped by B 60 s before B's last stamp: comparable.
    const ok = mayAskForTakeover({ ...base, reads, standby: { seq: 140, writtenAt: 4_940_000, writtenBy: 'B' } })
    expect(ok.ok && ok.behindAtMostMs).toBe(60_000 + 58_000)
    // A copy that has the last seq needs no clock at all.
    expect(mayAskForTakeover({ ...base, reads, standby: { seq: 150 } }).ok).toBe(true)
  })
  it('does not count a witness that serves another list', () => {
    const moved: PermitReply = { ...read('w2', true, last), list: ['w1', 'w2', 'w4'] }
    expect(mayAskForTakeover({ ...base, reads: [read('w1', true, last), moved], standby: { seq: 100 } }).ok).toBe(false)
  })
  it('a contending grant with an old stamp on top does not hide how far the real holder wrote (review S-2)', () => {
    // The holder's renew carried seq 100; then C's grant (seq 5) reached w1 and w2 once it ran out.
    const s0: WitnessState = { held: null, acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] }
    const a = judge(s0, 'w1', rec(1, 'grant', 'A', { progress: { seq: 100, writtenAt: 1_000_000 } }), 0, P)
    const s1 = (a as { next: WitnessState }).next
    const c = judge(s1, 'w1', rec(2, 'grant', 'C', { progress: { seq: 5, writtenAt: 10 } }), 70_000, P)
    const s2 = (c as { next: WitnessState }).next
    expect(s2.held!.holder).toBe('C')
    expect(s2.progress).toEqual({ seq: 100, writtenAt: 1_000_000 })
    const grantC = rec(2, 'grant', 'C', { progress: { seq: 5, writtenAt: 10 } })
    const reads = ['w1', 'w2'].map((id) => ({ ...read(id, true, grantC), progress: { seq: 100, writtenAt: 1_000_000 } }))
    const ans = mayAskForTakeover({ ...base, reads, standby: { seq: 5, writtenAt: 10, writtenBy: 'C' } })
    expect(ans.ok).toBe(false)
    // A grant with no stamp at all does not block every other candidate (review S-3).
    const bare = ['w1', 'w2'].map((id) => ({ ...read(id, true, rec(2, 'grant', 'C')), progress: { seq: 100, writtenAt: 1_000_000 } }))
    expect(mayAskForTakeover({ ...base, reads: bare, standby: { seq: 100 } }).ok).toBe(true)
  })
  it('reads the newest record among the answers, not the first', () => {
    const old = rec(3, 'renew', 'A', { progress: { seq: 10, writtenAt: 0 } })
    const a = mayAskForTakeover({ ...base, reads: [read('w1', true, old), read('w2', true, last)], standby: { seq: 10, writtenAt: 0 } })
    expect(a.ok).toBe(false)
  })
})

/** A client of machine `id` on three witnesses with one shared clock; replies wait for flush(). */
function holderSetup(id = 'A') {
  let t = 0
  const replies: Array<() => void> = []
  const witnesses = W.map((wid) => {
    const store = new SimStore()
    bootstrapWitnessStore(store, W)
    return new PermitWitness({ id: wid, store, clock: { now: () => t }, params: P })
  })
  /** `reach`: the witnesses a proposal gets to (all by default). */
  let reach: string[] = W
  /** A transport whose send throws (a socket that broke under it). */
  let throwing = false
  const client = (cid: string): PermitClient => {
    const c: PermitClient = new PermitClient({
      id: cid, list: W, params: P, clock: { now: () => t },
      transport: { send: (w: string, req: PermitRequest) => {
        if (req.type === 'propose' && !reach.includes(w)) return
        if (throwing && req.type === 'propose') throw new Error('EPIPE')
        const r = witnesses.find((x) => x.id === w)!.handle(req)
        replies.push(() => c.receive(r))
      } },
    })
    return c
  }
  const c = client(id)
  const flush = () => { while (replies.length) replies.shift()!() }
  return { c, client, witnesses, flush, at: (ms: number) => { t = ms }, reachOnly: (ws: string[]) => { reach = ws }, failSends: (on: boolean) => { throwing = on } }
}

describe('assertMayAct', () => {
  it('passes with enough left, refuses with under minSendRemainingMs, and refuses during a handover', () => {
    const h = holderSetup()
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

describe('PermitClient: a handover that did not stand', () => {
  it('its own grant taken by a majority above it (the take-back when a cancel cannot stand) ends the freeze: it acts again', () => {
    const h = holderSetup()
    h.c.requestGrant()
    h.flush()
    h.at(1_000)
    // The handover reaches w1 alone: the other two still hold this process's grant.
    h.reachOnly(['w1'])
    h.c.handover('B')
    h.flush()
    expect(h.c.mayAct()).toBe(false)
    h.reachOnly(W)
    h.at(2_000)
    // w2 and w3 take it on this process's live grant (rules.ts judge); w1 refuses (its handover).
    h.c.requestGrant()
    h.flush()
    expect(h.c.pendingRecord()).toBeNull()
    expect(h.c.isFrozen()).toBe(false)
    expect(h.c.mayAct()).toBe(true)
    // ... and the handover can never stand now: the new holder's commit is refused where the grant is.
    const b = h.client('B')
    b.read()
    h.flush()
    b.renew()
    h.flush()
    expect(b.mayAct()).toBe(false)
  })
})

describe('PermitClient.release', () => {
  function holding() {
    const h = holderSetup()
    h.c.requestGrant()
    h.flush()
    expect(h.c.mayAct()).toBe(true)
    return h
  }

  it('stops acting before the release leaves, for good; the next process takes a grant at once', () => {
    const h = holding()
    h.at(10_000)
    const r = h.c.release()!
    expect(r).toMatchObject({ kind: 'release', holder: NO_HOLDER, from: 'A', by: 'A', nonce: h.c.incarnation() })
    // No answer has come back yet: it does not act already.
    expect(h.c.mayAct()).toBe(false)
    expect(() => h.c.assertMayAct('op')).toThrow(/planned stop/)
    expect(h.c.released()).toBe('open')
    h.flush()
    expect(h.c.released()).toBe('stood')
    expect(h.c.mayAct()).toBe(false)
    // It proposes nothing else, ever; asking again only returns the same record.
    expect(h.c.renew()).toBeNull()
    expect(() => h.c.requestGrant()).toThrow(/released/)
    expect(() => h.c.handover('B')).toThrow(/released/)
    expect(h.c.release()).toBe(r)
    // The next process of A, 1 ms later.
    h.at(10_001)
    const next = h.client('A')
    next.read()
    h.flush()
    expect(next.standing()).toMatchObject({ kind: 'release', from: 'A' })
    next.requestGrant()
    h.flush()
    expect(next.mayAct()).toBe(true)
  })

  it('a send that throws: it stays released (not acting, the record kept), and asking again resends it', () => {
    const h = holding()
    h.failSends(true)
    expect(() => h.c.release()).toThrow(/EPIPE/)
    expect(h.c.mayAct()).toBe(false)
    expect(h.c.released()).toBe('open')
    h.failSends(false)
    expect(h.c.release()!.kind).toBe('release')
    h.flush()
    expect(h.c.released()).toBe('stood')
  })

  it('returns null and changes nothing when it holds nothing, or while a handover is open', () => {
    const h = holderSetup()
    expect(h.c.release()).toBeNull()
    expect(h.c.released()).toBeNull()
    h.c.requestGrant()
    h.flush()
    h.c.handover('B')
    expect(h.c.release()).toBeNull()
    expect(h.c.released()).toBeNull()
  })

  it('carries the outcomes reported before it, never a registration', () => {
    const h = holding()
    h.c.registerOps(['op1'])
    h.flush()
    h.c.beginSend('op1')
    h.c.reportOutcome('op1', true)
    // op2's registration never reached a majority: it is not sent, and the release does not carry it.
    h.reachOnly([])
    h.c.registerOps(['op2'])
    h.reachOnly(W)
    const r = h.c.release()!
    expect(r.ops).toEqual({ sent: ['op1'] })
    h.flush()
    for (const w of h.witnesses) expect(w.handle({ type: 'read' }).ops).toEqual([{ id: 'op1', state: 'sent', by: 'A', nonce: h.c.incarnation() }])
  })

  it('reports not-sent for ops a majority registered that it never began, and nothing for one whose registration reached no majority', () => {
    const h = holding()
    h.c.registerOps(['begun', 'idle'])
    h.flush()
    h.c.beginSend('begun')
    // 'pending' reached one witness only: an earlier holder might hold it elsewhere, so it is left alone.
    h.reachOnly(['w1'])
    h.c.registerOps(['pending'])
    h.flush()
    h.reachOnly(W)
    const r = h.c.release()!
    expect(r.ops).toEqual({ notSent: ['idle'] })
    expect(h.c.opStatus('idle')).toBe('not-sent')
    expect(h.c.opStatus('begun')).toBe('sending')
    h.flush()
    const next = h.client('A')
    next.read()
    h.flush()
    expect(next.opStatus('idle')).toBe('not-sent')
    // A send that began and was never reported stays unknown for the next holder: never sent again.
    expect(next.opStatus('begun')).toBe('unknown')
    expect(next.unresolvedOps().map((e) => e.id).sort()).toEqual(['begun', 'pending'])
  })

  it('a released or stopped client changes no witness list, not even the one it follows', () => {
    const h = holding()
    h.c.release()
    expect(() => h.c.changeWitnesses(['w1', 'w2', 'w4'], { list: ['w1', 'w2', 'w9'], cfg: 'x', epoch: 3 })).toThrow(/released/)
    expect(h.c.config()).toMatchObject({ list: W, epoch: 0 })
    const s = holderSetup()
    s.c.stop('lock lost')
    expect(() => s.c.changeWitnesses(['w1', 'w2', 'w4'], { list: ['w1', 'w2', 'w9'], cfg: 'x', epoch: 3 })).toThrow(/stopped/)
    expect(s.c.config()).toMatchObject({ list: W, epoch: 0 })
    // A stopped releaser does not resend.
    let sends = 0
    const t = holderSetup()
    t.c.requestGrant()
    t.flush()
    t.reachOnly([])
    t.c.release()
    t.c.stop('exit')
    const orig = t.witnesses[0].handle.bind(t.witnesses[0])
    t.witnesses[0].handle = (req) => { sends++; return orig(req) }
    t.reachOnly(W)
    t.c.release()
    expect(sends).toBe(0)
  })

  it('a release that reached one witness of three: the next process gets no grant until the old record ran out', () => {
    const h = holding()
    h.at(10_000)
    h.reachOnly(['w1'])
    h.c.release()
    h.flush()
    expect(h.c.released()).toBe('open')
    expect(h.c.mayAct()).toBe(false)
    h.reachOnly(W)
    const next = h.client('A')
    next.read()
    h.flush()
    next.requestGrant()
    h.flush()
    expect(next.mayAct()).toBe(false)
    // The grant (accepted at 0) runs out at w2 and w3 after validMs + witnessMarginMs.
    h.at(P.validMs + P.witnessMarginMs)
    next.read()
    h.flush()
    next.requestGrant()
    h.flush()
    expect(next.mayAct()).toBe(true)
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
      fs.writeFileSync(file, text(encodeStored({ held: rec(1, 'grant', 'A'), list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] })))
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

  it('a witness with no file at all is not set up: it takes nothing, not even a list change', () => {
    const file = path.join(mk(), 'witness.json')
    const w = new PermitWitness({ id: 'w1', store: createFilePermitStore(file), clock: { now: () => 0 }, params: P })
    const a = w.handle({ type: 'propose', record: rec(1, 'grant', 'A') })
    expect(a).toMatchObject({ ok: false, reason: 'not-set-up' })
    // Not even a members record that names it: its operator must say from which generation.
    const m = w.handle({ type: 'propose', record: rec(2, 'members', 'A', { newList: ['w1', 'w2', 'w4'], joint: ['w1', 'w2', 'w4'], stage: 'final' }) })
    expect(m).toMatchObject({ ok: false, reason: 'not-set-up' })
  })

  it('a joining witness takes its generation from the witnesses, and one below it is refused (review round 3 S-2)', () => {
    const reply = (epoch: number | null, list: string[] | null): PermitReply => ({
      witness: 'w', re: 'read', ok: true, held: null, list, joint: null, cfg: list ? 'c' : null, epoch, progress: null, ops: [], grantable: false,
    })
    // Only witnesses that are set up count; one waiting to join says nothing of the current generation.
    expect(generationToJoin([reply(2, W), reply(3, W), reply(5, null), reply(null, null)])).toBe(3)
    expect(generationToJoin([reply(4, null)])).toBeNull()
    const s = new SimStore()
    expect(() => prepareJoiningWitness(s, 2, 3)).toThrow(/below the current one/)
    expect(s.load()).toBeNull()
    prepareJoiningWitness(s, 3, 3)
    expect(s.load()?.epoch).toBe(3)
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
    createFilePermitStore(file, spy).save({ held: null, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [] })
    expect(calls).toEqual(['fsync', 'rename', 'fsync'])
  })
})
