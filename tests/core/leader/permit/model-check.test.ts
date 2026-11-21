/**
 * Model-checking style: many random schedules from seeds, one invariant. At no real
 * instant do two machines both have mayAct() === true. Each negative control turns one
 * safety part off and must find a violation, so the invariant check is known to bite.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, type PermitParams } from '../../../../src/core/leader/permit/index.js'
import { SimStore, World, pilot } from './sim.js'

const W = ['w1', 'w2', 'w3']
const M = ['A', 'B', 'C']

interface Variant {
  params?: Partial<PermitParams>
  lazyStore?: boolean
  pureMonotonic?: boolean
  reachableMajority?: boolean
  /** How far each clock's rate may be off, as a share of params.maxDriftRate. */
  driftShare?: number
  minutes?: number
  /** How often each machine's pilot looks (ms); short means candidates ask the instant they may. */
  tickMs?: number
  /** The worst way round, at the edge: every witness clock fast, every machine clock slow. */
  worstDrift?: boolean
  delayMs?: [number, number]
  /** Make every fault the split of the design (a machine cut from two witnesses). */
  splitsOnly?: boolean
  /** Share of accepted records after which the witness dies before answering. */
  crashRate?: number
}

function schedule(seed: number, v: Variant = {}): { world: World; totalMs: number } {
  const params = { ...DEFAULT_PERMIT_PARAMS, ...v.params }
  const world = new World(params, { drop: 0.1, dup: 0.05, delayMs: v.delayMs ?? [2, 300], slow: 0.04, slowMs: [1_000, 90_000] }, seed)
  const r = world.rand
  const bound = (v.params?.maxDriftRate === 0 ? DEFAULT_PERMIT_PARAMS.maxDriftRate : params.maxDriftRate) * (v.driftShare ?? 0.99)
  const drift = (side: 1 | -1) => (v.worstDrift ? side : r() * 2 - 1) * bound
  for (const id of W) {
    const n = world.addWitness(id, { drift: drift(1), store: new SimStore(v.lazyStore ? 'lazy' : 'durable'), bootstrap: W })
    if (v.lazyStore) {
      const flush = () => { n.store.flush(); world.after(20_000, flush) }
      world.after(20_000 * r(), flush)
    }
  }
  for (const id of M) {
    const m = world.addMachine(id, W, { drift: drift(-1), wallOffset: (r() * 2 - 1) * 30_000, pureMonotonic: v.pureMonotonic })
    if (v.reachableMajority) patchReachableMajority(m.c)
  }
  for (const id of M) {
    pilot(world, id, {
      wantsLead: true,
      tickMs: v.tickMs,
      cancelChance: 0.3,
      onTick: (m) => {
        // About one manual switch per machine-held 3 minutes, whatever the tick.
        if (r() < (v.tickMs ?? 5_000) / 180_000) m.c.handover(M.filter((x) => x !== m.id)[Math.floor(r() * 2)])
      },
    })
  }
  const totalMs = (v.minutes ?? 15) * 60_000
  // Faults, spread over the run.
  const faults = 6 + Math.floor(r() * 8)
  for (let i = 0; i < faults; i++) {
    const at = r() * totalMs
    const kind = v.splitsOnly ? 5 : Math.floor(r() * 7)
    world.at(at, () => {
      if (kind === 0) world.crashWitness(W[Math.floor(r() * 3)], 1_000 + r() * 60_000)
      else if (kind === 1) {
        const m = world.machines.get(M[Math.floor(r() * 3)])!
        m.clock.sleeps.push([world.now, world.now + 10_000 + r() * 110_000])
      } else if (kind === 2) {
        const a = M[Math.floor(r() * 3)], b = W[Math.floor(r() * 3)]
        world.partition(a, b, true)
        world.after(20_000 + r() * 120_000, () => world.partition(a, b, false))
      } else if (kind === 3) {
        const m = world.machines.get(M[Math.floor(r() * 3)])!
        m.clock.wallJumps.push([world.now, (r() * 2 - 1) * 120_000])
      } else if (kind === 4) {
        const w = world.witnesses.get(W[Math.floor(r() * 3)])!
        w.clock.sleeps.push([world.now, world.now + 5_000 + r() * 60_000])
      } else if (kind === 5) {
        // A machine cut from two of the three witnesses: the split of the design.
        const a = M[Math.floor(r() * 3)]
        const keep = W[Math.floor(r() * 3)]
        const cut = W.filter((w) => w !== keep)
        for (const w of cut) world.partition(a, w, true)
        world.after(30_000 + r() * 120_000, () => { for (const w of cut) world.partition(a, w, false) })
      } else {
        const id = M[Math.floor(r() * 3)]
        world.restartMachine(id, W, 1_000 + r() * 20_000)
        if (v.reachableMajority) patchReachableMajority(world.machines.get(id)!.c)
      }
    })
  }
  // Now and then a witness dies after it accepted a record and before it answered. (Per
  // accepted record: per message would restart the witnesses every few seconds, and each
  // restart counts their record afresh, which hides a timing bug instead of finding one.)
  world.crashBeforeAnswer = (_w, req, reply) => req.type === 'propose' && reply.ok && r() < (v.crashRate ?? 0.01)
  world.run(totalMs)
  return { world, totalMs }
}

/** The bug the design names in the old takeover: a majority of whoever answered. */
function patchReachableMajority(c: object): void {
  const x = c as { chosen: (p: { acks: Set<string>; refusals: Map<string, string> }) => boolean }
  x.chosen = (p) => p.acks.size > 0 && p.acks.size * 2 > p.acks.size + p.refusals.size
}

function sweep(seeds: number, v: Variant = {}, from = 1) {
  let violations = 0
  let firstBad: number | null = null
  let active = 0
  let total = 0
  for (let seed = from; seed < from + seeds; seed++) {
    const { world, totalMs } = schedule(seed, v)
    if (world.violations.length > 0) {
      violations++
      firstBad ??= seed
    }
    for (const ms of world.activeMs.values()) active += ms
    total += totalMs
  }
  return { violations, firstBad, activeShare: active / total }
}

describe('write permission: random schedules', () => {
  it('never lets two machines act at once (300 seeds, faults, drift at the edge of the bound)', () => {
    const r = sweep(300)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    // Not vacuous: someone held the permission most of the time.
    expect(r.activeShare).toBeGreaterThan(0.5)
  }, 120_000)

  // Candidates that ask the instant they may, in chunks so no one test holds the worker long.
  for (let from = 1; from <= 100; from += 25) {
    it(`never lets two machines act at once when candidates ask the instant they may (seeds ${from} to ${from + 24})`, () => {
      const r = sweep(25, { tickMs: 250 }, from)
      expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
      expect(r.activeShare).toBeGreaterThan(0.5)
    }, 60_000)
  }

  it('never lets two machines act at once when witnesses die after one in ten records they accept (100 seeds)', () => {
    const r = sweep(100, { crashRate: 0.1 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 60_000)

  it('holds with no faults beyond the network across longer runs', () => {
    const r = sweep(20, { minutes: 60 })
    expect(r.firstBad).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.6)
  }, 120_000)

  describe('negative controls: each removed safety part is caught', () => {
    it('margins removed: drift turns it red', () => {
      const r = sweep(40, { params: { holderMarginMs: 0, witnessMarginMs: 0, maxDriftRate: 0 }, tickMs: 250, worstDrift: true, delayMs: [1, 20], splitsOnly: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a witness that answers before its record is on disk: crashes turn it red', () => {
      const r = sweep(100, { lazyStore: true, crashRate: 0.1 })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a holder that counts on the monotonic clock alone: sleep turns it red', () => {
      const r = sweep(300, { pureMonotonic: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a majority of the witnesses that answered: splits turn it red', () => {
      const r = sweep(300, { reachableMajority: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)
  })
})
