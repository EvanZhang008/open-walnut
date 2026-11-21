/**
 * The named schedules of the brief, each on a simulated network and simulated clocks.
 * Where a case guards a bug shape, a negative control runs the same schedule with that
 * safety part removed and must go red.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, maxSafeDrift, sameRecord, type PermitParams, type PermitReply } from '../../../../src/core/leader/permit/index.js'
import { CALM, SimStore, World, firstStart, lastStop, pilot, sample } from './sim.js'

const W = ['w1', 'w2', 'w3']

function world(opts: {
  params?: Partial<PermitParams>
  witnessDrift?: number
  witnessOffset?: number
  lazy?: boolean
  delayMs?: [number, number]
} = {}): World {
  const w = new World({ ...DEFAULT_PERMIT_PARAMS, ...opts.params }, { ...CALM, delayMs: opts.delayMs ?? [5, 5] }, 7)
  for (const id of W) w.addWitness(id, { drift: opts.witnessDrift, offset: opts.witnessOffset, store: new SimStore(opts.lazy ? 'lazy' : 'durable'), bootstrap: W })
  return w
}

/** A takes the permission at t=0 and keeps renewing it. */
function aHolds(w: World, opts: { drift?: number; pureMonotonic?: boolean } = {}) {
  const a = w.addMachine('A', W, opts)
  a.c.requestGrant()
  w.run(1_000)
  expect(a.c.mayAct()).toBe(true)
  return a
}

describe('split: A keeps one witness, B reaches the other two', () => {
  it('A stops before B starts, and never acts again while cut off', () => {
    const w = world()
    aHolds(w)
    w.addMachine('B', W)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    pilot(w, 'B', { wantsLead: true, tickMs: 250 })
    w.run(20_000)
    // A's answers from w2 and w3 are lost; B cannot reach w1.
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    w.partition('B', 'w1')
    sample(w, 10, 300_000)
    w.run(300_000)
    expect(w.violations).toEqual([])
    const bStart = firstStart(w, 'B')
    const aStop = lastStop(w, 'A')
    expect(bStart).not.toBeNull()
    expect(aStop).not.toBeNull()
    expect(aStop!).toBeLessThan(bStart!)
  })
})

describe('a holder paused for 90 s (a sleeping laptop)', () => {
  function run(pureMonotonic: boolean) {
    const w = world()
    const a = aHolds(w, { pureMonotonic })
    w.addMachine('B', W)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    pilot(w, 'B', { wantsLead: true, tickMs: 250 })
    w.run(30_000)
    const wake = 30_000 + 90_000
    a.clock.sleeps.push([30_000, wake])
    let atWake: boolean | null = null
    // Scheduled before anything the sleep defers to the wake, so it runs first.
    w.at(wake, () => { atWake = a.c.mayAct() })
    w.run(200_000)
    return { w, atWake }
  }

  it('wakes with mayAct() false at once, before any message arrives', () => {
    const { w, atWake } = run(false)
    expect(atWake).toBe(false)
    expect(w.violations).toEqual([])
    expect(firstStart(w, 'B')).not.toBeNull()
  })

  it('negative control: a holder on the monotonic clock alone wakes still acting, beside B', () => {
    const { w, atWake } = run(true)
    expect(atWake).toBe(true)
    expect(w.violations.length).toBeGreaterThan(0)
  })
})

describe('a witness that restarts', () => {
  it('keeps the record it accepted when it is killed between accepting and answering', () => {
    const w = world()
    const a = w.addMachine('A', W)
    let killed = false
    w.crashBeforeAnswer = (id, req, reply) => {
      if (!killed && id === 'w1' && req.type === 'propose' && reply.ok) return (killed = true)
      return false
    }
    const rec = a.c.requestGrant()
    w.run(30_000)
    expect(killed).toBe(true)
    // It never answered, and after its restart it holds what it accepted.
    expect(sameRecord(w.witnesses.get('w1')!.store.load()!.held, rec)).toBe(true)
    a.c.read()
    w.run(31_000)
    const r1 = a.c.readBack().find((r) => r.witness === 'w1')!
    expect(sameRecord(r1.held, rec)).toBe(true)
  })

  function crashAfterYes(lazy: boolean) {
    const w = world({ lazy })
    const a = aHolds(w)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    // Two witnesses said yes to A; both lose power before anything else reaches their disk.
    w.run(1_500)
    w.crashWitness('w1', 1_000)
    w.crashWitness('w2', 1_000)
    w.run(3_000)
    // B reaches only the two that restarted.
    const b = w.addMachine('B', W)
    w.partition('B', 'w3')
    b.c.requestGrant()
    w.run(10_000)
    return { w, a, b }
  }

  it('after both restart, a grant to another machine is refused while A holds it', () => {
    const { w, b } = crashAfterYes(false)
    expect(b.c.mayAct()).toBe(false)
    expect(w.violations).toEqual([])
  })

  it('negative control: a witness that answers before its record is on disk grants it twice', () => {
    const { w, b } = crashAfterYes(true)
    expect(b.c.mayAct()).toBe(true)
    expect(w.violations.length).toBeGreaterThan(0)
  })
})

describe('clocks: a witness 30 s off, a holder 1% fast or slow', () => {
  /**
   * The worst case for a lease: A renews, then is cut from every witness at once, with
   * no network delay, while B asks every 50 ms from the instant the witnesses let it.
   */
  function worst(holderDrift: number, witnessDrift: number, witnessOffset: number, params: Partial<PermitParams> = {}) {
    const w = world({ witnessDrift, witnessOffset, params, delayMs: [0, 0] })
    aHolds(w, { drift: holderDrift })
    w.addMachine('B', W)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    pilot(w, 'B', { wantsLead: true, tickMs: 50 })
    w.run(31_000)
    for (const id of W) w.partition('A', id)
    w.run(200_000)
    expect(firstStart(w, 'B')).not.toBeNull()
    return w
  }

  for (const offset of [30_000, -30_000]) {
    for (const hd of [0.01, -0.01]) {
      for (const wd of [0.01, -0.01]) {
        it(`holds with witness offset ${offset / 1000} s, witness drift ${wd * 100}%, holder drift ${hd * 100}%`, () => {
          expect(worst(hd, wd, offset).violations).toEqual([])
        })
      }
    }
  }

  it('negative control: with the margins removed, a slow holder and a fast witness overlap', () => {
    const w = worst(-0.01, 0.01, 30_000, { holderMarginMs: 0, witnessMarginMs: 0, maxDriftRate: 0 })
    expect(w.violations.length).toBeGreaterThan(0)
  })

  it('holds at the assumed drift bound (2%), the worst way round', () => {
    const r = DEFAULT_PERMIT_PARAMS.maxDriftRate
    expect(worst(-r, r, 0).violations).toEqual([])
  })

  it('the margins cover up to maxSafeDrift and no further: just under holds, just over breaks', () => {
    const edge = maxSafeDrift(DEFAULT_PERMIT_PARAMS)
    expect(edge).toBeGreaterThan(DEFAULT_PERMIT_PARAMS.maxDriftRate)
    expect(worst(-edge * 0.99, edge * 0.99, 0).violations).toEqual([])
    expect(worst(-edge * 1.1, edge * 1.1, 0).violations.length).toBeGreaterThan(0)
  })
})

describe('a renew delivered late', () => {
  it('a renew held back 70 s is refused when it arrives and never extends the holder', () => {
    const w = world()
    const a = aHolds(w)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    w.run(14_000)
    // A's next renew is held back 70 s; nothing else A sends arrives. Answers to A do.
    let late: number | null = null
    w.intercept = (from, _to, msg, d) => {
      if (from !== 'A') return d
      if ('type' in msg && msg.type === 'propose' && (late === null || msg.record.number === late)) {
        if (msg.record.kind !== 'renew') return null
        late = msg.record.number
        return 70_000
      }
      return null
    }
    const replies: PermitReply[] = []
    const orig = a.c.receive.bind(a.c)
    a.c.receive = (r) => { if (r.re === late) replies.push(r); orig(r) }
    sample(w, 50, 120_000)
    w.run(120_000)
    expect(late).not.toBeNull()
    expect(replies.length).toBeGreaterThanOrEqual(3)
    expect(replies.every((r) => !r.ok)).toBe(true)
    expect(a.c.mayAct()).toBe(false)
    expect(lastStop(w, 'A')!).toBeLessThan(14_000 + 60_000)
  })

  it('a yes that comes back after the permission ran out on the holder is not counted', () => {
    const w = world()
    const a = aHolds(w)
    w.run(10_000)
    // The renew reaches every witness at once; their answers take 65 s to come back.
    w.intercept = (_from, to, _msg, d) => (to === 'A' ? 65_000 : d)
    a.c.renew()
    let at: number | null = null
    let ackedWhileExpired = false
    const orig = a.c.receive.bind(a.c)
    a.c.receive = (r) => {
      orig(r)
      if (r.ok) { at = w.now; ackedWhileExpired ||= !a.c.mayAct() }
    }
    w.run(100_000)
    expect(at).not.toBeNull()
    expect(ackedWhileExpired).toBe(true)
    expect(w.witnesses.get('w1')!.w!.handle({ type: 'read' }).held?.number).toBeGreaterThan(1)
  })
})

describe('handover and cancel racing', () => {
  /** A hands over to B and cancels at once; the handover reaches w1 first, the cancel w2 first. */
  function race(seed: number) {
    const w = world()
    const a = aHolds(w)
    w.addMachine('B', W)
    pilot(w, 'A', { wantsLead: false, tickMs: 1_000 })
    pilot(w, 'B', { wantsLead: false, tickMs: 200 })
    w.run(5_000)
    const r = (() => { let x = seed * 9301 + 49297; return () => ((x = (x * 9301 + 49297) % 233280) / 233280) })()
    const ho = a.c.handover('B').number
    const ca = ho + 1
    w.intercept = (from, to, msg, d) => {
      if (from !== 'A' || !('type' in msg) || msg.type !== 'propose') return d
      const n = msg.record.number
      if (n === ho) return to === 'w1' ? 1 : 100 + r() * 900
      if (n === ca) return to === 'w2' ? 1 : 100 + r() * 900
      return d
    }
    expect(a.c.cancelHandover().number).toBe(ca)
    w.run(10_000)
    w.intercept = null
    w.run(120_000)
    // Everyone stops, then both read back.
    w.pilotsStopped = true
    w.run(122_000)
    a.c.read()
    w.machines.get('B')!.c.read()
    w.run(123_000)
    return w
  }

  for (let seed = 1; seed <= 40; seed++) {
    it(`exactly one stands and both machines agree (schedule ${seed})`, () => {
      const w = race(seed)
      expect(w.violations).toEqual([])
      const a = w.machines.get('A')!.c
      const b = w.machines.get('B')!.c
      const sa = a.standing()
      const sb = b.standing()
      // They read a moment apart, so a renew may land between; they agree on who holds it.
      expect(sa).toBeTruthy()
      expect(sb).toBeTruthy()
      expect(sa!.holder).toBe(sb!.holder)
      // The one that stands is the one acting, and the other is not.
      const acting = w.acting()
      expect(acting).toHaveLength(1)
      expect(acting[0]).toBe(sa!.holder)
    })
  }

  it('across the schedules, each side wins sometimes (the race is real)', () => {
    const winners = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) winners.add(race(seed).acting()[0])
    expect([...winners].sort()).toEqual(['A', 'B'])
  })
})

describe('only a majority of the configured list counts', () => {
  function oneReachable(patch: boolean) {
    const w = world()
    const a = w.addMachine('A', W)
    if (patch) {
      const x = a.c as unknown as { chosen: (p: { acks: Set<string>; refusals: Map<string, string> }) => boolean }
      x.chosen = (p) => p.acks.size > 0 && p.acks.size * 2 > p.acks.size + p.refusals.size
    }
    w.partition('A', 'w2')
    w.partition('A', 'w3')
    let ever = false
    for (let t = 0; t < 300_000; t += 5_000) {
      w.at(t, () => { if (!a.c.mayAct()) a.c.requestGrant() })
      w.at(t + 4_000, () => { ever ||= a.c.mayAct() })
    }
    w.run(300_000)
    return ever
  }

  it('with three witnesses configured and one reachable, nothing is ever granted', () => {
    expect(oneReachable(false)).toBe(false)
  })

  it('negative control: counting a majority of those that answered grants it', () => {
    expect(oneReachable(true)).toBe(true)
  })
})

describe('changing the witness list', () => {
  it('w4 replaces w3 only with a majority of both lists; the old list cannot grant after it', () => {
    const w = world()
    // w4 joins with no record and no list: it waits for a members record that names it.
    w.addWitness('w4')
    const a = aHolds(w)
    pilot(w, 'A', { wantsLead: true, tickMs: 1_000 })
    w.run(5_000)
    a.c.changeWitnesses(['w1', 'w2', 'w4'])
    w.run(6_000)
    expect(a.c.witnessList()).toEqual(['w1', 'w2', 'w4'])
    expect(a.c.mayAct()).toBe(true)
    // A machine that still has the old list, with A cut off from everyone: it waits for
    // the permission to run out, then asks w1, w2, w3. Only w3 serves that list now.
    const b = w.addMachine('B', W)
    pilot(w, 'B', { wantsLead: true, tickMs: 250 })
    for (const id of ['w1', 'w2', 'w3', 'w4']) w.partition('A', id)
    w.run(200_000)
    expect(w.violations).toEqual([])
    // B follows the new list from what the witnesses answer, then gets it the proper way.
    expect(b.c.witnessList()).toEqual(['w1', 'w2', 'w4'])
    expect(b.c.mayAct()).toBe(true)
    // w3 is out: it refuses everything now.
    const r3 = w.witnesses.get('w3')!.w!.handle({ type: 'propose', record: { number: 999, kind: 'grant', holder: 'C', by: 'C', validMs: w.params.validMs, list: W } })
    expect(r3.ok).toBe(false)
  })

  it('a members record that only the old majority took does not move the list, and a retry finishes it', () => {
    const w = world()
    w.addWitness('w4')
    const a = aHolds(w)
    w.partition('A', 'w4')
    w.partition('A', 'w2')
    a.c.changeWitnesses(['w1', 'w2', 'w4'])
    w.run(10_000)
    // w1 and w3 (a majority of the old list) took it; of the new list only w1 did.
    expect(a.c.witnessList()).toEqual(W)
    expect(a.c.outcome()).not.toBe('chosen')
    expect(w.violations).toEqual([])
    w.partition('A', 'w4', false)
    w.partition('A', 'w2', false)
    a.c.changeWitnesses(['w1', 'w2', 'w4'])
    w.run(11_000)
    expect(a.c.witnessList()).toEqual(['w1', 'w2', 'w4'])
    expect(a.c.mayAct()).toBe(true)
  })
})
