/**
 * A witness list change between its two steps: the witnesses refuse a final step whose
 * record does not show that its pair stood, a change left half done is finished (or waits,
 * naming whom for), and candidates that see the permission free at once back off at random.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMIT_PARAMS, PairEvidence, backoffDelayMs, genesisConfigId, judge, nextConfigId, planRepair,
  type PermitRecord, type PermitReply, type WitnessState,
} from '../../../../src/core/leader/permit/index.js'
import { CALM, World, firstStart, pilot, type MachineNode } from './sim.js'

const P = DEFAULT_PERMIT_PARAMS
const W = ['w1', 'w2', 'w3']
const G = genesisConfigId(W)
const N = ['w1', 'w2', 'w4']
const rec = (number: number, kind: PermitRecord['kind'], by: string, extra: Partial<PermitRecord> = {}): PermitRecord => ({
  number, kind, by, holder: by, nonce: 'n1', validMs: P.validMs, list: W, cfg: G, epoch: 0, ...extra,
})
const state = (s: Partial<WitnessState>): WitnessState => ({ held: rec(1, 'grant', 'A'), acceptedAt: 0, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [], ...s })
const final = (pairBy: string[], newList = N) => rec(3, 'members', 'A', { newList, joint: newList, stage: 'final', pairBy })

describe('a witness checks the evidence a final step carries', () => {
  const pair = state({ joint: N, held: rec(2, 'members', 'A', { newList: N, joint: N, stage: 'joint' }) })

  it('takes it when the evidence names a majority of each list', () => {
    const j = judge(pair, 'w1', final(['w1', 'w2']), 1, P)
    expect(j.ok && [j.next.list, j.next.joint, j.next.cfg]).toEqual([N, null, nextConfigId(G, N)])
  })

  it('refuses it when the evidence names no majority of the old list, or of the new one', () => {
    expect(judge(pair, 'w1', final(['w1', 'w4']), 1, P)).toEqual({ ok: false, reason: 'pair-not-shown' })
    const far = ['w4', 'w5', 'w6']
    const farPair = state({ joint: far, held: rec(2, 'members', 'A', { newList: far, joint: far, stage: 'joint' }) })
    expect(judge(farPair, 'w1', final(['w1', 'w2', 'w4'], far), 1, P)).toEqual({ ok: false, reason: 'pair-not-shown' })
  })

  it('refuses evidence naming a witness of neither list, and a final with none at all', () => {
    expect(judge(pair, 'w1', final(['w1', 'w2', 'w9']), 1, P)).toEqual({ ok: false, reason: 'bad-evidence' })
    const bare = rec(3, 'members', 'A', { newList: N, joint: N, stage: 'final' })
    expect(judge(pair, 'w1', bare, 1, P)).toEqual({ ok: false, reason: 'bad-evidence' })
    expect(judge(state({}), 'w1', rec(2, 'members', 'A', { newList: N, joint: N, stage: 'joint', pairBy: W }), 1, P)).toEqual({ ok: false, reason: 'bad-evidence' })
  })

  it('a joining witness refuses evidence that says it took a pair it never took', () => {
    const joining: WitnessState = { held: null, acceptedAt: 0, list: null, joint: null, cfg: null, epoch: 0, progress: null, ops: [] }
    expect(judge(joining, 'w4', final(['w1', 'w2', 'w4']), 1, P)).toEqual({ ok: false, reason: 'bad-evidence' })
    expect(judge(joining, 'w4', final(['w1', 'w2']), 1, P).ok).toBe(true)
  })
})

describe('a client that sends the final step before its pair stood', () => {
  /**
   * Old list w1-w3, new list w4-w6. The pair step reaches w1 and the new witnesses only, then A
   * sends the final step anyway (a bug). X can then hold under the old list through w2 and w3;
   * if w4-w6 took that final, Z could hold under the new list at the same time.
   */
  function run(fakeEvidence: boolean) {
    const far = ['w4', 'w5', 'w6']
    const w = new World(P, { ...CALM }, 3)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    for (const id of far) w.addWitness(id, { joinFrom: 0 })
    const a = w.addMachine('A', W)
    a.c.requestGrant()
    w.run(1_000)
    a.c.renew({ seq: 1, writtenAt: 1 })
    w.run(1_500)
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    a.c.changeWitnesses(far)
    w.run(2_000)
    const c = a.c as unknown as { joint: string[] | null; proposeFinal: () => PermitRecord; evidence: { shown: () => string[] } }
    if (fakeEvidence) c.evidence.shown = () => [...W, ...far]
    c.joint = far
    const f = c.proposeFinal()
    w.run(3_000)
    // Where the new witnesses stand right after that final step.
    const afterFinal = far.map((id) => w.witnesses.get(id)!.w!.handle({ type: 'read' }).joint)
    const x = w.addMachine('X', W)
    const z = w.addMachine('Z', far, { cfg: nextConfigId(G, far), epoch: 1 })
    w.partition('X', 'w1')
    for (const m of ['X', 'Z']) pilot(w, m, { wantsLead: true, tickMs: 1_000, backoff: false })
    w.run(200_000)
    return { w, f, x, z, afterFinal }
  }

  it('the new witnesses refuse it (the evidence shows one of three old witnesses) and stay in the pair; no two ever hold', () => {
    const { w, f, afterFinal } = run(false)
    expect(f.pairBy).toEqual(['w1', 'w4', 'w5', 'w6'])
    expect(afterFinal).toEqual([['w4', 'w5', 'w6'], ['w4', 'w5', 'w6'], ['w4', 'w5', 'w6']])
    // Later a candidate finishes the change properly (repairChange) and holds under the new list.
    expect(firstStart(w, 'X') ?? firstStart(w, 'Z')).not.toBeNull()
    expect(w.violations).toEqual([])
  })

  it('negative control: evidence that names witnesses that never took the pair: X and Z hold at once', () => {
    const { w } = run(true)
    expect(w.violations.length).toBeGreaterThan(0)
  })
})

// --- Finishing a change left between its steps ------------------------------------------------

function world(extra: string[] = ['w4']): World {
  const w = new World(P, { ...CALM }, 9)
  for (const id of W) w.addWitness(id, { bootstrap: W })
  for (const id of extra) w.addWitness(id, { joinFrom: 0 })
  return w
}
function holds(w: World, id: string): MachineNode {
  const m = w.addMachine(id, W)
  m.c.requestGrant()
  w.run(w.now + 1_000)
  return m
}
const dropFinals = (w: World, from: string) => {
  w.intercept = (f, _to, msg, d) => (f === from && 'type' in msg && msg.type === 'propose' && msg.record.stage === 'final' ? null : d)
}

describe('a change its writer left between the two steps', () => {
  it('the pair stood and the writer stopped: the next machine sees it, and once the permission ran out finishes it', () => {
    const w = world()
    const a = holds(w, 'A')
    dropFinals(w, 'A')
    a.c.renew({ seq: 1, writtenAt: 1 })
    w.run(w.now + 500)
    a.c.changeWitnesses(N)
    w.run(w.now + 1_000)
    expect(a.c.jointList()).toEqual(N)
    w.restartMachine('A', W, 10 * 60_000)
    w.intercept = null
    const b = w.addMachine('B', W)
    pilot(w, 'B', { wantsLead: true, tickMs: 1_000 })
    w.run(w.now + 120_000)
    expect(b.c.config().list).toEqual(N)
    expect(b.c.mayAct()).toBe(true)
    expect(w.violations).toEqual([])
  })

  it('the pair reached one old witness only: the plain majority goes on, and its holder sends the pair again, then the final', () => {
    const w = world()
    const a = holds(w, 'A')
    a.c.renew({ seq: 1, writtenAt: 1 })
    w.run(w.now + 500)
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    a.c.changeWitnesses(N)
    w.run(w.now + 1_000)
    w.restartMachine('A', W, 10 * 60_000)
    const b = w.addMachine('B', W)
    pilot(w, 'B', { wantsLead: true, tickMs: 1_000 })
    w.run(w.now + 150_000)
    expect(b.c.mayAct()).toBe(true)
    expect(b.c.config().list).toEqual(N)
    expect(w.violations).toEqual([])
  })

  it('the new witnesses are gone: the plan names them and nothing is sent; once they answer, it finishes', () => {
    const far = ['w4', 'w5', 'w6']
    const w = world(far)
    const a = holds(w, 'A')
    for (const id of ['w5', 'w6']) w.partition('A', id)
    a.c.changeWitnesses(far)
    w.run(w.now + 1_000)
    a.c.read()
    w.run(w.now + 500)
    a.c.read()
    w.run(w.now + 500)
    const plan = a.c.changePlan()
    expect(plan).toMatchObject({ kind: 'blocked', waitingFor: ['w5', 'w6'] })
    const before = a.c.pendingRecord()
    expect(a.c.repairChange().record).toBeNull()
    expect(a.c.pendingRecord()).toBe(before)
    for (const id of ['w5', 'w6']) w.partition('A', id, false)
    a.c.read()
    w.run(w.now + 500)
    expect(a.c.changePlan().kind).toBe('pair')
    a.c.repairChange()
    w.run(w.now + 1_000)
    expect(a.c.config().list).toEqual(far)
  })

  it('negative control: without the repair a holder that took over a stuck pair can do nothing', () => {
    const w = world()
    const a = holds(w, 'A')
    dropFinals(w, 'A')
    a.c.renew({ seq: 1, writtenAt: 1 })
    w.run(w.now + 500)
    a.c.changeWitnesses(N)
    w.run(w.now + 1_000)
    w.restartMachine('A', W, 10 * 60_000)
    w.intercept = null
    const b = w.addMachine('B', W)
    // B only ever asks for a plain grant (what the pilot did before the repair existed).
    b.c.repairChange = () => ({ plan: { kind: 'none' }, record: null })
    pilot(w, 'B', { wantsLead: true, tickMs: 1_000 })
    w.run(w.now + 120_000)
    expect(firstStart(w, 'B')).toBeNull()
  })
})

describe('planRepair', () => {
  const reply = (witness: string, s: Partial<PermitReply>): PermitReply => ({
    witness, re: 'read', ok: true, held: null, list: W, joint: null, cfg: G, epoch: 0, progress: null, ops: [], grantable: true, ...s,
  })

  it('picks the pair most witnesses of the list stand in, and needs no read of the new ones once it stands', () => {
    const ev = new PairEvidence()
    const reads = [reply('w1', { joint: N }), reply('w2', { joint: N }), reply('w3', {})]
    for (const r of reads) ev.note(r)
    ev.note(reply('w4', { list: N, cfg: nextConfigId(G, N), epoch: 1 }))
    expect(planRepair({ list: W, cfg: G, epoch: 0, joint: null, reads, evidence: ev })).toMatchObject({ kind: 'final', pair: { next: N } })
  })

  it('a pair of another configuration is not this one\'s to finish', () => {
    const ev = new PairEvidence()
    const reads = [reply('w1', { joint: N, cfg: 'other' }), reply('w2', { joint: N, cfg: 'other' })]
    expect(planRepair({ list: W, cfg: G, epoch: 0, joint: null, reads, evidence: ev })).toEqual({ kind: 'none' })
  })

  it('a witness set up to join from a later generation cannot take this pair', () => {
    const ev = new PairEvidence()
    const reads = [reply('w1', { joint: N }), reply('w2', {}), reply('w3', {}), reply('w4', { list: null, cfg: null, epoch: 5, grantable: false })]
    // w4 can't join generation 0, so of N only w1 and w2 can take it: still a majority.
    expect(planRepair({ list: W, cfg: G, epoch: 0, joint: null, reads, evidence: ev }).kind).toBe('pair')
    const far = ['w4', 'w5', 'w6']
    const farReads = [reply('w1', { joint: far }), reply('w2', {}), reply('w3', {}), reply('w4', { list: null, cfg: null, epoch: 5 })]
    expect(planRepair({ list: W, cfg: G, epoch: 0, joint: null, reads: farReads, evidence: ev })).toMatchObject({ kind: 'blocked', waitingFor: far })
  })
})

// --- Back-off -----------------------------------------------------------------------------

describe('candidates that see the permission free at the same instant', () => {
  it('back-off: random, under backoffBaseMs at first, doubling per failed try, capped at backoffMaxMs', () => {
    const one = () => 0.999
    expect(backoffDelayMs(0, one, P)).toBeLessThan(P.backoffBaseMs)
    expect(backoffDelayMs(1, one, P)).toBeGreaterThan(P.backoffBaseMs)
    expect(backoffDelayMs(1, one, P)).toBeLessThan(2 * P.backoffBaseMs)
    expect(backoffDelayMs(50, one, P)).toBeLessThan(P.backoffMaxMs)
    expect(backoffDelayMs(50, one, P)).toBeGreaterThan(P.backoffMaxMs * 0.99)
    const seen = new Set(Array.from({ length: 20 }, (_, i) => backoffDelayMs(0, () => (i * 7919) % 101 / 101, P)))
    expect(seen.size).toBeGreaterThan(10)
  })

  /**
   * Three candidates, each next to one witness (5 ms) and far from the others (50 ms), all
   * looking at the same instants. Without back-off each witness takes its neighbour's grant
   * first: no one has a majority, all of them wait the whole hold out, and it repeats.
   */
  function race(seed: number, backoff: boolean) {
    const w = new World(P, { ...CALM }, seed)
    for (const id of W) w.addWitness(id, { bootstrap: W })
    const near: Record<string, string> = { A: 'w1', B: 'w2', C: 'w3' }
    for (const id of Object.keys(near)) w.addMachine(id, W)
    w.intercept = (from, to, _msg, d) => (near[from] ? (near[from] === to ? 5 : 50) : d)
    for (const id of Object.keys(near)) pilot(w, id, { wantsLead: true, tickMs: 1_000, exactTicks: true, backoff })
    w.run(10 * 60_000)
    const starts = Object.keys(near).map((id) => firstStart(w, id)).filter((t): t is number => t !== null)
    return { w, first: starts.length ? Math.min(...starts) : null }
  }

  it('with the random back-off one of them holds within a minute, in every one of 30 runs', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { w, first } = race(seed, true)
      expect(first, `seed ${seed}`).not.toBeNull()
      expect(first!).toBeLessThan(60_000)
      expect(w.violations).toEqual([])
    }
  })

  it('negative control: without it they split the witnesses every time, and no one holds in ten minutes', () => {
    for (let seed = 1; seed <= 5; seed++) expect(race(seed, false).first).toBeNull()
  })
})
