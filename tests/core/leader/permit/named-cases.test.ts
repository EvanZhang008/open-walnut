/**
 * The named schedules of the brief, each on a simulated network and simulated clocks.
 * Where a case guards a bug shape, a negative control runs the same schedule with that
 * safety part removed and must go red.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, genesisConfigId, maxSafeDrift, sameRecord, witnessHoldMs, type PermitClient, type PermitParams, type PermitReply } from '../../../../src/core/leader/permit/index.js'
import { CALM, SimStore, World, firstStart, lastStop, pilot, releaseOnAnyLive, sample, simDefaults, takeOnMinorityRelease } from './sim.js'

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

describe('a holder process that restarts mid-renew (review round 1, B-1)', () => {
  /**
   * M's renew #2 reaches only w1; M restarts, reads w2 and w3, and renews #2 again (the
   * same record when the stamp did not move). w1's earlier yes must not count for it.
   */
  function restartDupAck(sameIncarnation: boolean, stamped: boolean) {
    const w = world()
    const m = w.addMachine('M', W, { nonce: 'inc-1' })
    const x = w.addMachine('X', W)
    m.c.requestGrant()
    w.run(1_000)
    w.intercept = (from, to, msg, d) => {
      if (from === 'M' && (to === 'w2' || to === 'w3') && 'type' in msg && msg.type === 'propose') return null
      // (the stamped variant) w1's yes to the old #2 is slow: 7 s on the wire.
      if (stamped && from === 'w1' && to === 'M' && !('type' in msg) && msg.re === 2) return 7_000
      return d
    }
    m.c.renew(stamped ? { seq: 1, writtenAt: 1 } : undefined)
    w.run(2_000)
    w.restartMachine('M', W, 0, sameIncarnation ? 'inc-1' : undefined)
    w.intercept = (from, to, msg, d) => (from === 'w1' && to === 'M' && !('type' in msg) && msg.re === 'read' ? null : d)
    w.run(6_000)
    m.c.read()
    w.run(6_100)
    w.intercept = (from, to, msg, d) => {
      if (from === 'M' && to === 'w3') return null
      if (stamped && from === 'M' && to === 'w1' && 'type' in msg && msg.type === 'propose') return null
      return d
    }
    const again = m.c.renew(stamped ? { seq: 2, writtenAt: 6_000 } : undefined)!
    expect(again.number).toBe(2)
    w.run(9_000)
    w.intercept = null
    w.run(63_100)
    x.c.read()
    w.run(63_150)
    x.c.requestGrant()
    sample(w, 10, 70_000)
    w.run(70_000)
    return { w, m }
  }

  it('the same record re-sent by a new incarnation: the old yes is not counted', () => {
    const { w } = restartDupAck(false, false)
    expect(w.violations).toEqual([])
  })

  it('a late yes to the old record of the same number is not counted for the new one', () => {
    const { w } = restartDupAck(false, true)
    expect(w.violations).toEqual([])
  })

  it('negative control: an incarnation reused across the restart counts the old yes and overlaps', () => {
    const { w } = restartDupAck(true, false)
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
    pilot(w, 'B', { wantsLead: true, tickMs: 50, backoff: false })
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
    // Over a door (named-cases-host-link.test.ts) a post 70 s late finds its nonce expired (10 s): refused before the
    // witness reads it, so no reply comes at all. Over a link the witness answers each one, no.
    if (simDefaults.way === 'link') expect(replies.length).toBeGreaterThanOrEqual(3)
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
    // Over a door the challenge's answer is what comes back 65 s late: the call then goes with an expired nonce and is
    // refused, so no yes comes back at all (nothing to count). Over a link the yes comes, after the lease ran out.
    if (simDefaults.way !== 'link') { expect(at).toBeNull(); expect(a.c.mayAct()).toBe(false); return }
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
    w.addWitness('w4', { joinFrom: 0 })
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
    const r3 = w.witnesses.get('w3')!.w!.handle({ type: 'propose', record: { number: 999, kind: 'grant', holder: 'C', by: 'C', nonce: 'c1', validMs: w.params.validMs, list: W, cfg: genesisConfigId(W), epoch: 0 } })
    expect(r3.ok).toBe(false)
  })

  it('a members record that only the old majority took does not move the list, and a retry finishes it', () => {
    const w = world()
    w.addWitness('w4', { joinFrom: 0 })
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

  it('a change that reached one majority, then lost its holder, is finished by another machine once the permission ran out', () => {
    const w = world()
    w.addWitness('w4', { joinFrom: 0 })
    const a = aHolds(w)
    w.partition('A', 'w4')
    w.partition('A', 'w2')
    a.c.changeWitnesses(['w1', 'w2', 'w4'])
    w.run(10_000)
    // A is gone for good. Before the permission runs out, nobody may finish it.
    for (const id of ['w1', 'w2', 'w3', 'w4']) w.partition('A', id)
    const b = w.addMachine('B', W)
    b.c.changeWitnesses(['w1', 'w2', 'w4'], { list: W, cfg: genesisConfigId(W), epoch: 0 })
    w.run(20_000)
    expect(b.c.mayAct()).toBe(false)
    expect(b.c.witnessList()).toEqual(W)
    w.run(100_000)
    b.c.changeWitnesses(['w1', 'w2', 'w4'], { list: W, cfg: genesisConfigId(W), epoch: 0 })
    w.run(101_000)
    expect(b.c.witnessList()).toEqual(['w1', 'w2', 'w4'])
    expect(b.c.mayAct()).toBe(true)
    expect(w.violations).toEqual([])
  })
})

describe('planned stop: release', () => {
  /**
   * A holds from t=0 and renews at 15 s and 30 s (with progress stamps, so the takeover rule lets
   * a rival ask once it ran out); at 40 s its process stops: planned (a release,
   * World.plannedStop) or a crash. The next process of A starts once the old one exited and asks
   * as the wiring should: read; once a majority answers grantable, the core's back-off (drawn at
   * its longest, 2 s), read, grant; looks again every second until it holds. (Asking before a
   * majority is grantable only grows the back-off: each grant that did not stand doubles it.)
   * `patchNext` (a negative control) also asks once any witness shows A's release. B, with `rival`, asks whenever the rule lets it.
   */
  function restartAt40s(o: { stop: 'release' | 'crash'; reach?: string[]; rival?: boolean; patchNext?: (c: PermitClient) => void }) {
    const w = world()
    const a = aHolds(w)
    w.at(15_000, () => { a.c.renew({ seq: 1, writtenAt: 15_000 }) })
    w.at(30_000, () => { a.c.renew({ seq: 2, writtenAt: 30_000 }) })
    if (o.rival) {
      w.addMachine('B', W)
      pilot(w, 'B', { wantsLead: true, tickMs: 250 })
    }
    const old = a.c
    let heldAtStop = false
    w.at(40_000, () => {
      heldAtStop = old.mayAct()
      if (o.stop === 'release') w.plannedStop('A', W, { reach: o.reach, downMs: 0 })
      else w.restartMachine('A', W, 0)
    })
    let patched = false
    const step = (): void => {
      const c = a.c
      if (c === old) return void w.after(20, step)
      if (o.patchNext && !patched) { o.patchNext(c); patched = true }
      if (c.mayAct()) return
      c.read()
      w.after(50, () => {
        const reads = c.readBack()
        const free = reads.filter((r) => r.grantable).length >= 2
        const sawRelease = !!o.patchNext && reads.some((r) => r.held?.kind === 'release' && r.held.from === 'A')
        if (!free && !sawRelease) return void w.after(1_000, step)
        w.after(c.grantDelayMs(() => 0.999), () => {
          c.read()
          w.after(50, () => {
            if (!c.mayAct()) c.requestGrant()
            w.after(1_000, step)
          })
        })
      })
    }
    w.at(40_000, step)
    sample(w, 10, 180_000)
    w.run(180_000)
    expect(heldAtStop).toBe(true)
    return { w, release: w.releases[0] ?? null }
  }
  // The old process's last renew reached the witnesses at 30 s: they hold it for A until then.
  const heldUntil = 30_000 + witnessHoldMs(DEFAULT_PERMIT_PARAMS)
  /** Who may act at real time t, from the timeline. */
  const actingAt = (w: World, t: number): string[] => [...w.timeline].reverse().find(([at]) => at <= t)![1]

  it('a planned restart: the next process holds within about 2 s of the release, not after the witness hold', () => {
    const { w, release } = restartAt40s({ stop: 'release' })
    expect(release!.record!.kind).toBe('release')
    // The old process stopped acting the instant it released, and saw its release stand at once.
    expect(actingAt(w, 39_999)).toEqual(['A'])
    expect(actingAt(w, 40_000)).toEqual([])
    expect(release!.stoodAt! - 40_000).toBeLessThan(50)
    const next = firstStart(w, 'A', 40_001)!
    expect(next - 40_000).toBeLessThan(2_200)
    // Without the release it would have waited until the witnesses' hold ran out, 52 s later.
    expect(heldUntil).toBe(92_000)
    expect(w.violations).toEqual([])
  })

  it('a crash (no release): the next process waits for the old record to run out at the witnesses, as before', () => {
    const { w, release } = restartAt40s({ stop: 'crash' })
    expect(release).toBeNull()
    expect(firstStart(w, 'A', 40_001)!).toBeGreaterThanOrEqual(heldUntil)
    expect(w.violations).toEqual([])
  })

  it('a release that reached one witness of three: the next process holds only once the old record ran out at the other two', () => {
    const { w, release } = restartAt40s({ stop: 'release', reach: ['w1'] })
    // It never stood: the old process exited after its 3 s cap.
    expect(release!.stoodAt).toBeNull()
    expect(release!.exitAt).toBe(43_000)
    const next = firstStart(w, 'A', 40_001)!
    expect(next).toBeGreaterThanOrEqual(heldUntil)
    expect(next).toBeLessThan(heldUntil + 5_000)
    expect(w.violations).toEqual([])
  })

  it('the same with a rival asking whenever the rule lets it: nobody holds before the old record ran out, never two at once', () => {
    const { w } = restartAt40s({ stop: 'release', reach: ['w1'], rival: true })
    const next = Math.min(...['A', 'B'].map((id) => firstStart(w, id, 40_001) ?? Infinity))
    expect(next).toBeGreaterThanOrEqual(heldUntil)
    expect(next).toBeLessThan(180_000)
    expect(w.violations).toEqual([])
  })

  it('negative control: a next process that takes it on the release seen at that one witness acts beside the next holder', () => {
    const { w } = restartAt40s({ stop: 'release', reach: ['w1'], rival: true, patchNext: takeOnMinorityRelease })
    expect(firstStart(w, 'A', 40_001)!).toBeLessThan(heldUntil)
    expect(w.violations.length).toBeGreaterThan(0)
  })
})

describe('planned stop of a process whose lease ran out but was never cleared', () => {
  /**
   * A holds from t=0. At 5 s A loses w2 and w3 (it keeps w1) and B loses w1. A renews at w1 alone
   * every 15 s: its numbers climb there, and its lease runs out on its clock at 58 s, never
   * cleared (w1 shows it nothing newer). B, which never sees w1, takes the permission at w2 and w3
   * once A's grant ran out there (62 s), with a lower number. At 75 s the cuts heal and A stops
   * at once (a deploy), before it heard anything: its release is numbered above B's record at w2
   * and w3. C asks whenever the rule lets it.
   */
  function staleRelease(relaxed: boolean) {
    const w = world()
    if (relaxed) for (const n of w.witnesses.values()) releaseOnAnyLive(n.w!)
    const a = w.addMachine('A', W)
    a.c.requestGrant({ seq: 1, writtenAt: 0 })
    w.run(1_000)
    w.at(5_000, () => {
      w.partition('A', 'w2')
      w.partition('A', 'w3')
      w.partition('B', 'w1')
    })
    for (const t of [15_000, 30_000, 45_000]) w.at(t, () => { a.c.renew({ seq: t / 1_000, writtenAt: t }) })
    w.addMachine('B', W)
    w.addMachine('C', W)
    pilot(w, 'B', { wantsLead: true, tickMs: 250 })
    let releasedOver: number | null = null
    w.at(75_000, () => {
      for (const id of ['w2', 'w3']) w.partition('A', id, false)
      w.partition('B', 'w1', false)
      releasedOver = w.witnesses.get('w2')!.w!.handle({ type: 'read' }).held!.number
      w.plannedStop('A', W, { downMs: 60_000 })
    })
    w.at(75_000, () => pilot(w, 'C', { wantsLead: true, tickMs: 250 }))
    sample(w, 10, 150_000)
    w.run(150_000)
    return { w, release: w.releases[0]!, releasedOver: releasedOver! }
  }

  it('the witnesses that hold the next holder\'s record refuse the release: never two at once', () => {
    const { w, release, releasedOver } = staleRelease(false)
    // The timing: B held at w2 with a lower number than A's release, and A had its stale lease.
    expect(firstStart(w, 'B')!).toBeLessThan(75_000)
    expect(release.record!.number).toBeGreaterThan(releasedOver)
    expect(release.stoodAt).toBeNull()
    expect(w.violations).toEqual([])
  })

  it('negative control: witnesses that take a release on any live record let C act beside B', () => {
    const { w } = staleRelease(true)
    expect(w.violations.length).toBeGreaterThan(0)
    expect(w.violations[0]!.who.sort()).toEqual(['B', 'C'])
  })
})

describe('a witness that missed the holder\'s first record (the remote rehearsal\'s standby-behind red, 2026-11-26)', () => {
  /**
   * The holder took the permission on two witnesses while w3 was out of its reach (a door-only host that dialed the
   * new leader only after its grant stood, a witness down at that moment), or w3 was out of reach for longer than a
   * record is held. w3 then holds a record that ran out there: it never takes a renew (a renew stands only on a live
   * record of its writer's process or on a live handover to it), so every renew stands on w1 and w2 alone and one more
   * witness down leaves no majority. The holder brings w3 back with a grant, which w3 takes because nothing is live there.
   */
  function missed(start: 'grant' | 'handover' | 'cut') {
    const w = world()
    const a = w.addMachine('A', W)
    if (start === 'handover') {
      const b = w.addMachine('B', W)
      b.c.requestGrant()
      w.run(1_000)
      b.c.handover('A')
      w.run(2_000)
    }
    if (start === 'cut') {
      a.c.requestGrant()
      w.run(1_000)
    }
    w.partition('A', 'w3')
    if (start === 'grant') a.c.requestGrant()
    pilot(w, 'A', { wantsLead: false, tickMs: 1_000 })
    w.run(10_000)
    expect(a.c.mayAct()).toBe(true)
    // Back in reach once what w3 holds (the handover, A's own grant, or nothing) is no longer live there.
    const back = 10_000 + witnessHoldMs(w.params) + 5_000
    w.at(back, () => w.partition('A', 'w3', false))
    sample(w, 10, 200_000)
    // Two renew periods after it is back (the pilot's ticks wander by up to a second each).
    w.run(back + 2 * w.params.renewEveryMs + 3_000)
    const read = (id: string) => w.witnesses.get(id)!.w!.handle({ type: 'read' })
    return { w, a, read }
  }

  for (const start of ['grant', 'handover', 'cut'] as const) {
    it(`${start === 'cut' ? 'cut off for longer than a record is held' : `after a ${start} that stood without it`}, w3 holds the holder's record again within two renews`, () => {
      const { w, a, read } = missed(start)
      // A live record of this very process at every witness (a record of A that ran out there is no better than none).
      const ownAtEvery = () => {
        for (const id of W) {
          const r = read(id)
          expect(r.held?.by, id).toBe('A')
          expect(r.held?.nonce, id).toBe(a.c.incarnation())
          expect(r.held?.kind, id).not.toBe('handover')
          expect(r.grantable, id).toBe(false)
        }
      }
      ownAtEvery()
      // And it stays so: the renews that follow stand on all three.
      w.run(200_000)
      ownAtEvery()
      expect(w.violations).toEqual([])
      expect(a.c.mayAct()).toBe(true)
    })
  }

  it('the failed trial: the old leader\'s own witness restarts with its server and still holds the handover when the grant stands on the other two', () => {
    // The remote rehearsal's shape (2026-11-26, r2c loop 1): A hands over to B; B's trial fails and B never leads; A's
    // server restarts, and its own witness (w3 here) restarts with it, so it counts the handover's hold from then. A's
    // new process asks a grant once the handover ran out at w1 and w2: it stands there, and w3, its handover still live,
    // refuses it ('held'). Once w3's handover ran out there, it refuses every renew of A ('not-holder').
    const w = world()
    const a = w.addMachine('A', W)
    a.c.requestGrant()
    w.run(1_000)
    a.c.handover('B')
    w.run(2_000)
    w.restartMachine('A', W, 0)
    w.crashWitness('w3', 12_000)
    const ask = witnessHoldMs(w.params) + 3_000
    w.at(ask, () => { a.c.read(); w.after(500, () => { a.c.requestGrant() }) })
    w.run(ask + 2_000)
    const a2 = w.machines.get('A')!
    expect(a2.c.mayAct()).toBe(true)
    expect(w.witnesses.get('w3')!.w!.handle({ type: 'read' }).held?.kind).toBe('handover')
    pilot(w, 'A', { wantsLead: false, tickMs: 1_000 })
    // w3's handover runs out 12 s later there than at the others; then two renew periods.
    const by = ask + 12_000 + 2 * w.params.renewEveryMs + 3_000
    sample(w, 10, by)
    w.run(by)
    for (const id of W) {
      const r = w.witnesses.get(id)!.w!.handle({ type: 'read' })
      expect(r.held?.by, id).toBe('A')
      expect(r.held?.nonce, id).toBe(a2.c.incarnation())
      expect(r.grantable, id).toBe(false)
    }
    expect(w.violations).toEqual([])
  })

  /** A holds on w1 and w2 since t=0, w3 out of its reach; w3 is back (holding nothing) and has answered a read. */
  function behindW3() {
    const w = world()
    const a = w.addMachine('A', W)
    w.partition('A', 'w3')
    a.c.requestGrant()
    w.run(1_000)
    expect(a.c.mayAct()).toBe(true)
    const back = witnessHoldMs(w.params) + 5_000
    for (let t = 10_000; t < back; t += 10_000) w.at(t, () => { a.c.renew() })
    w.at(back, () => { w.partition('A', 'w3', false); a.c.read() })
    w.run(back + 1_000)
    expect(a.c.witnessesBehind()).toEqual(['w3'])
    let now = back + 1_000
    const step = () => { now += 1_000; w.run(now) }
    const read = (id: string) => w.witnesses.get(id)!.w!.handle({ type: 'read' })
    return { w, a, step, read }
  }

  it('a registration always rides a renew; outcomes wait one round unless the caller must carry them now', () => {
    const { w, a, step, read } = behindW3()
    // A registration: a renew (no witness checks a registration on a grant).
    const reg = a.c.registerOps(['op-1']).record!
    expect(reg.kind).toBe('renew')
    expect(reg.ops?.register).toEqual(['op-1'])
    step()
    expect(a.c.opStatus('op-1')).toBe('registered')
    a.c.beginSend('op-1')
    a.c.reportOutcome('op-1', true)
    // The last renew before a handover carries the outcome whatever is behind.
    const before = a.c.renew(undefined, { carryOutcomes: true })!
    expect(before.kind).toBe('renew')
    expect(before.ops?.sent).toEqual(['op-1'])
    step()
    expect(a.c.witnessesBehind()).toEqual(['w3'])
    // A periodic renew with nothing that must ride: the grant, with no ops; the renew after it takes w3 too.
    const g = a.c.renew()!
    expect(g.kind).toBe('grant')
    expect(g.ops).toBeUndefined()
    step()
    expect(a.c.witnessesBehind()).toEqual([])
    const r = a.c.renew()!
    expect(r.kind).toBe('renew')
    step()
    for (const id of W) {
      expect(read(id).held?.number, id).toBe(r.number)
      expect(read(id).grantable, id).toBe(false)
    }
    expect(w.violations).toEqual([])
  })

  it('a steady stream of outcomes does not hold the grant back for ever', () => {
    const { w, a, step } = behindW3()
    const kinds: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = `op-${i}`
      a.c.registerOps([id])
      step()
      a.c.beginSend(id)
      a.c.reportOutcome(id, true)
      kinds.push(a.c.renew()!.kind)
      step()
    }
    expect(kinds[0]).toBe('grant')
    expect(a.c.witnessesBehind()).toEqual([])
    expect(w.violations).toEqual([])
  })

  it('never two grants in a row: behind again right after one, the next proposal is a plain renew', () => {
    const { a, step } = behindW3()
    expect(a.c.renew()!.kind).toBe('grant')
    // Its answers lost on the way back: w3 is still behind as far as A knows.
    a.c.read()
    expect(a.c.renew()!.kind).toBe('renew')
    step()
    expect(a.c.renew()!.kind).toBe('renew')
  })

  it('witnessesLagging: a witness that held none of the holder\'s renewals for the window, by the clock, with its last answer', () => {
    const w = world()
    const a = w.addMachine('A', W)
    a.c.requestGrant()
    w.run(1_000)
    w.partition('A', 'w3')
    let now = 1_000
    // Renewals 1.5 s apart (a renew that did not stand is tried again that soon): counted by time, not by rounds.
    const renewRound = () => { a.c.renew(); now += 1_500; w.run(now) }
    for (let i = 0; i < 6; i++) renewRound()
    // Six renewals, at 1 s to 8.5 s, the newest not counted: the first one w3 missed went 9 s ago.
    expect(a.c.witnessesLagging(9_500)).toEqual([])
    expect(a.c.witnessesLagging(9_000)).toEqual([{ witness: 'w3', why: 'no answer' }])
    renewRound()
    expect(a.c.witnessesLagging(9_500)).toEqual([{ witness: 'w3', why: 'no answer' }])
    // Back while A's record there is still live: it takes the next renew, and is not lagging after the one after it.
    w.partition('A', 'w3', false)
    renewRound()
    renewRound()
    expect(a.c.witnessesLagging(9_500)).toEqual([])
    expect(w.violations).toEqual([])
  })

  it('back-off: a witness behind that goes down gets one grant, then none until it says again that it is behind', () => {
    const { w, a, step } = behindW3()
    w.partition('A', 'w3')
    const kinds: string[] = []
    for (let i = 0; i < 8; i++) { kinds.push(a.c.renew()!.kind); step() }
    expect(kinds).toEqual(['grant', 'renew', 'renew', 'renew', 'renew', 'renew', 'renew', 'renew'])
    // Back, and its answer (to a renew it refuses) says it is behind again: one more grant brings it back.
    w.partition('A', 'w3', false)
    a.c.renew()
    step()
    expect(a.c.witnessesBehind()).toEqual(['w3'])
    expect(a.c.renew()!.kind).toBe('grant')
    step()
    expect(a.c.witnessesBehind()).toEqual([])
    expect(w.violations).toEqual([])
  })

  it('frozen: no grant while a handover is open (it would put the grant in place of the handover the client waits on)', () => {
    function run(guard: boolean) {
      const { w, a, step } = behindW3()
      const h = a.c.handover('B')
      expect(a.c.isFrozen()).toBe(true)
      expect(a.c.witnessesBehind()).toEqual(['w3'])
      const c = a.c as unknown as { frozen: boolean }
      // Negative control: the frozen guard taken away for the one call.
      if (!guard) c.frozen = false
      const sent = a.c.renew()
      if (!guard) c.frozen = true
      step()
      return { w, a, h, sent }
    }
    const kept = run(true)
    expect(kept.sent).toBeNull()
    expect(kept.a.c.pendingRecord()).toBeNull()
    // The handover stood and the client knows it: it no longer acts, nothing of A's own is open.
    expect(kept.a.c.isFrozen()).toBe(false)
    expect(kept.a.c.mayAct()).toBe(false)
    expect(kept.w.violations).toEqual([])
    const control = run(false)
    expect(control.sent?.kind).toBe('grant')
    // The grant took the handover's place as the open proposal: its answers are lost to the client, which stays
    // frozen with an outcome that is the grant's (refused 'held' where the handover is live), not the handover's.
    expect(control.a.c.isFrozen()).toBe(true)
    expect(control.a.c.pendingRecord()?.kind).toBe('grant')
    expect(control.a.c.outcome()).toBe('short')
  })

  it('alternation: a witness that takes the renew and not the grant (a live handover to this machine) is never left out twice in a row', () => {
    // Five witnesses. B hands over to A; A commits on it at w1 to w3; w4 missed the commit and still holds the
    // handover to A (live: it takes A's renew, refuses its grant 'held'); w5 holds nothing live (behind).
    const W5 = ['w1', 'w2', 'w3', 'w4', 'w5']
    function run(alternate: boolean) {
      const w = new World({ ...DEFAULT_PERMIT_PARAMS }, { ...CALM, delayMs: [5, 5] }, 7)
      for (const id of W5) w.addWitness(id, { store: new SimStore('durable'), bootstrap: W5 })
      const b = w.addMachine('B', W5)
      w.partition('B', 'w5')
      b.c.requestGrant()
      w.run(1_000)
      b.c.handover('A')
      w.run(2_000)
      const a = w.addMachine('A', W5)
      w.partition('A', 'w4')
      w.partition('A', 'w5')
      a.c.read()
      w.run(2_500)
      a.c.renew()
      w.run(3_000)
      expect(a.c.mayAct()).toBe(true)
      w.partition('A', 'w4', false)
      w.partition('A', 'w5', false)
      a.c.read()
      w.run(3_500)
      expect(a.c.witnessesBehind()).toEqual(['w5'])
      const c = a.c as unknown as { repairedLast: boolean; behind: Set<string> }
      let now = 3_500
      for (let i = 0; i < 3; i++) {
        // Negative control: a grant every round while w5 is behind (kept behind: it is the case the rule is for).
        if (!alternate) { c.repairedLast = false; c.behind.add('w5') }
        a.c.renew()
        now += 1_000
        w.run(now)
      }
      const held = (id: string) => w.witnesses.get(id)!.w!.handle({ type: 'read' }).held
      return { w4: held('w4'), a }
    }
    const kept = run(true)
    expect(kept.w4?.by).toBe('A')
    expect(kept.w4?.nonce).toBe(kept.a.c.incarnation())
    const control = run(false)
    // Grants only: w4 refuses each ('held', the handover to A still live there) and stays out until it runs out.
    expect(control.w4?.kind).toBe('handover')
  })

  it('a witness of another list answering grantable is not behind (it takes no grant of this list)', () => {
    const { a } = behindW3()
    const reply = { witness: 'w3', re: 'read' as const, ok: true, held: null, list: ['w1', 'w2', 'w3'], joint: null, cfg: 'some-older-config', epoch: 0, progress: null, ops: [], grantable: true }
    a.c.receive(reply)
    expect(a.c.witnessesBehind()).toEqual([])
    a.c.receive({ ...reply, cfg: a.c.config().cfg })
    expect(a.c.witnessesBehind()).toEqual(['w3'])
  })
})
