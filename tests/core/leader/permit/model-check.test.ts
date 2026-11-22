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
  /** A fourth witness waits to join; holders now and then swap one witness of the list for it. */
  members?: boolean
  /** Most faults restart the machine that acts, mid-renew, and stamps repeat across restarts. */
  restarts?: boolean
  /** With members: five witnesses (lists of three drawn from them) and a change about every minute. */
  pool5?: boolean
  /** One message in ten takes one to five minutes (old change steps arriving late). */
  lateSteps?: boolean
  /** Candidates ask the instant the rule lets them, with no random back-off. */
  noBackoff?: boolean
  /** Holders send outward ops (an op id about every 10 s) and the copy misses half the done marks. */
  ops?: boolean
  /** Negative control (ops): send as soon as the registration is proposed. */
  sendUnregistered?: boolean
  /** Negative control (ops): a holder that reads an op as sent does not write that into its data. */
  noRecordSeen?: boolean
  /** Negative control (ops + members): list changes carry no op entries. */
  dropLedger?: boolean
  /** Every machine runs a second process beside the first (same id, its own incarnation). */
  twins?: boolean
  /** Negative control (twins): both processes of a machine share one incarnation. */
  twinsShareNonce?: boolean
}

function schedule(seed: number, v: Variant = {}): { world: World; totalMs: number } {
  const params = { ...DEFAULT_PERMIT_PARAMS, ...v.params }
  const world = new World(params, {
    drop: 0.1, dup: 0.05, delayMs: v.delayMs ?? [2, 300],
    slow: v.lateSteps ? 0.1 : 0.04, slowMs: v.lateSteps ? [60_000, 300_000] : [1_000, 90_000],
  }, seed)
  const r = world.rand
  const bound = (v.params?.maxDriftRate === 0 ? DEFAULT_PERMIT_PARAMS.maxDriftRate : params.maxDriftRate) * (v.driftShare ?? 0.99)
  const drift = (side: 1 | -1) => (v.worstDrift ? side : r() * 2 - 1) * bound
  const extra = v.members ? (v.pool5 ? ['w4', 'w5'] : ['w4']) : []
  const pool = [...W, ...extra]
  for (const id of extra) world.addWitness(id, { drift: drift(1), joinFrom: 0 })
  for (const id of W) {
    const n = world.addWitness(id, { drift: drift(1), store: new SimStore(v.lazyStore ? 'lazy' : 'durable'), bootstrap: W })
    if (v.lazyStore) {
      const flush = () => { n.store.flush(); world.after(20_000, flush) }
      world.after(20_000 * r(), flush)
    }
  }
  for (const id of M) {
    const m = world.addMachine(id, W, { drift: drift(-1), wallOffset: (r() * 2 - 1) * 30_000, pureMonotonic: v.pureMonotonic, ...(v.twinsShareNonce ? { nonce: `${id}-one` } : {}) })
    if (v.reachableMajority) patchReachableMajority(m.c)
    if (v.dropLedger) dropLedger(m.c)
    if (v.twins) world.addMachine(id, W, { key: `${id}#2`, clockOf: id, pureMonotonic: v.pureMonotonic, ...(v.twinsShareNonce ? { nonce: `${id}-one` } : {}) })
  }
  const processes = v.twins ? M.flatMap((id) => [id, `${id}#2`]) : M
  if (v.ops) {
    for (let i = 0, t = 0; t < (v.minutes ?? 15) * 60_000; i++, t += 5_000 + r() * 10_000) world.at(t, () => { world.outbox.push(`op-${i}`) })
  }
  for (const id of processes) {
    pilot(world, id, {
      ...(v.ops ? { ops: { markDoneShare: 0.5, sendUnregistered: v.sendUnregistered, noRecordSeen: v.noRecordSeen } } : {}),
      wantsLead: true,
      tickMs: v.tickMs,
      backoff: !v.noBackoff,
      sparseStamps: v.restarts,
      cancelChance: 0.3,
      onTick: (m) => {
        // About one manual switch per machine-held 3 minutes, whatever the tick. (A change
        // left between its two steps is finished first: the pilot's repairChange.)
        if (m.c.jointList()) return
        if (v.members && r() < (v.tickMs ?? 5_000) / (v.pool5 ? 60_000 : 240_000)) {
          const list = m.c.witnessList()
          const out = list[Math.floor(r() * list.length)]
          const out_ = pool.filter((x) => !list.includes(x))
          const inn = out_[Math.floor(r() * out_.length)]
          m.c.changeWitnesses([...list.filter((x) => x !== out), inn])
          return
        }
        if (r() < (v.tickMs ?? 5_000) / 180_000) m.c.handover(M.filter((x) => x !== m.id)[Math.floor(r() * 2)])
      },
    })
  }
  const totalMs = (v.minutes ?? 15) * 60_000
  // Faults, spread over the run.
  const faults = 6 + Math.floor(r() * 8)
  for (let i = 0; i < faults; i++) {
    const at = r() * totalMs
    // 7 (members only): a machine out of touch with every witness for 3 to 7 minutes,
    // across list changes, then back.
    const kind = v.splitsOnly ? 5 : v.restarts && r() < 0.7 ? 6 : Math.floor(r() * (v.members ? 8 : 7))
    world.at(at, () => {
      if (kind === 0) world.crashWitness(pool[Math.floor(r() * pool.length)], 1_000 + r() * 60_000)
      else if (kind === 1) {
        const m = world.machines.get(M[Math.floor(r() * 3)])!
        m.clock.sleeps.push([world.now, world.now + 10_000 + r() * 110_000])
      } else if (kind === 2) {
        const a = M[Math.floor(r() * 3)], b = pool[Math.floor(r() * pool.length)]
        world.partition(a, b, true)
        world.after(20_000 + r() * 120_000, () => world.partition(a, b, false))
      } else if (kind === 3) {
        const m = world.machines.get(M[Math.floor(r() * 3)])!
        m.clock.wallJumps.push([world.now, (r() * 2 - 1) * 120_000])
      } else if (kind === 4) {
        const w = world.witnesses.get(pool[Math.floor(r() * pool.length)])!
        w.clock.sleeps.push([world.now, world.now + 5_000 + r() * 60_000])
      } else if (kind === 5) {
        // A machine cut from two of the three witnesses: the split of the design.
        const a = M[Math.floor(r() * 3)]
        const list = world.machines.get(a)!.c.witnessList()
        const keep = list[Math.floor(r() * list.length)]
        const cut = list.filter((w) => w !== keep)
        for (const w of cut) world.partition(a, w, true)
        world.after(30_000 + r() * 120_000, () => { for (const w of cut) world.partition(a, w, false) })
      } else if (kind === 7) {
        const a = M[Math.floor(r() * 3)]
        for (const w of pool) world.partition(a, w, true)
        world.after(180_000 + r() * 240_000, () => { for (const w of pool) world.partition(a, w, false) })
      } else {
        const id = (v.restarts && world.acting()[0]) || processes[Math.floor(r() * processes.length)]
        world.restartMachine(id, W, 1_000 + r() * 20_000, undefined, v.ops)
        if (v.reachableMajority) patchReachableMajority(world.machines.get(id)!.c)
        if (v.dropLedger) dropLedger(world.machines.get(id)!.c)
      }
    })
  }
  // Now and then a witness dies after it accepted a record and before it answered. (Per
  // accepted record: per message would restart the witnesses every few seconds, and each
  // restart counts their record afresh, which hides a timing bug instead of finding one.)
  world.crashBeforeAnswer = (_w, req, reply) => req.type === 'propose' && reply.ok && r() < (v.crashRate ?? 0.01)
  if (process.env.PERMIT_TRACE_SEED === String(seed)) world.trace = []
  world.run(totalMs)
  if (world.trace) {
    const v0 = world.violations[0]
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(v0), '\n' + world.trace.filter((l) => !v0 || parseFloat(l) * 1000 < v0.at + 1000).join('\n'), '\n', JSON.stringify(world.timeline.filter(([t]) => !v0 || Math.abs(t - v0.at) < 200_000)))
  }
  return { world, totalMs }
}

/** Negative control: list changes carry no op entries to the witnesses that join. */
function dropLedger(c: object): void {
  ;(c as { ops: { ledger: () => unknown[] } }).ops.ledger = () => []
}

/** Op ids sent by more than one process. */
function doubleSends(world: World): string[] {
  return [...world.sends.entries()].filter(([, s]) => s.length > 1).map(([id]) => id)
}

/** The bug the design names in the old takeover: a majority of whoever answered. */
function patchReachableMajority(c: object): void {
  const x = c as { chosen: (p: { acks: Set<string>; refusals: Map<string, string> }) => boolean }
  x.chosen = (p) => p.acks.size > 0 && p.acks.size * 2 > p.acks.size + p.refusals.size
}

/** Async, yielding after every schedule: one long synchronous block starves vitest's worker channel. */
async function sweep(seeds: number, v: Variant = {}, from = 1, stopAtFirst = false) {
  let violations = 0
  let firstBad: number | null = null
  let active = 0
  let total = 0
  let sent = 0
  let unknown = 0
  for (let seed = from; seed < from + seeds; seed++) {
    await new Promise((res) => setImmediate(res))
    const { world, totalMs } = schedule(seed, v)
    sent += world.sends.size
    unknown += world.unknownSeen.size
    if (world.violations.length > 0 || doubleSends(world).length > 0) {
      violations++
      firstBad ??= seed
      if (stopAtFirst) break
    }
    for (const ms of world.activeMs.values()) active += ms
    total += totalMs
  }
  return { violations, firstBad, activeShare: active / total, sent, unknown }
}

describe('write permission: random schedules', () => {
  it('never lets two machines act at once (300 seeds, faults, drift at the edge of the bound)', async () => {
    const r = await sweep(300)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    // Not vacuous: someone held the permission most of the time.
    expect(r.activeShare).toBeGreaterThan(0.5)
  }, 120_000)

  // Candidates that ask the instant they may, in chunks so no one test holds the worker long.
  for (let from = 1; from <= 100; from += 25) {
    it(`never lets two machines act at once when candidates ask the instant they may (seeds ${from} to ${from + 24})`, async () => {
      const r = await sweep(25, { tickMs: 250, noBackoff: true }, from)
      expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
      expect(r.activeShare).toBeGreaterThan(0.5)
    }, 60_000)
  }

  it('never lets two machines act at once when witnesses die after one in ten records they accept (100 seeds)', async () => {
    const r = await sweep(100, { crashRate: 0.1 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 60_000)

  // In chunks: one long synchronous block starves vitest's worker channel.
  for (let from = 1; from <= 200; from += 50) {
    it(`never lets two machines act at once when the holder restarts mid-renew and its records repeat (seeds ${from} to ${from + 49})`, async () => {
      const r = await sweep(50, { restarts: true, tickMs: 1_000 }, from)
      expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
      expect(r.activeShare).toBeGreaterThan(0.3)
    }, 60_000)
  }

  it('never lets two machines act at once across many list changes over five witnesses, with steps arriving minutes late (100 seeds)', async () => {
    const r = await sweep(100, { members: true, pool5: true, lateSteps: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
  }, 60_000)

  // Seed 12 here found the bug of a one-step list change (a witness that took a change no
  // majority of the old list had confirmed served the new list at once): two disjoint
  // majorities. The change is two steps now (rules.ts judge).
  it('never lets two machines act at once while holders swap witnesses in and out (200 seeds)', async () => {
    const r = await sweep(200, { members: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 60_000)

  // Ops: no op id is ever sent by two processes, whatever the faults; the unknown ones are seen.
  it('never sends one op twice: holders register before each send, then crash, restart and take over (100 seeds)', async () => {
    const r = await sweep(100, { ops: true, restarts: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent).toBeGreaterThan(2_500)
    expect(r.unknown).toBeGreaterThan(0)
  }, 120_000)

  it('never sends one op twice across list changes over five witnesses (60 seeds)', async () => {
    const r = await sweep(60, { ops: true, members: true, pool5: true, restarts: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent).toBeGreaterThan(600)
  }, 120_000)

  // The witnesses drop a sent entry after opRetainMs (10 minutes here, shorter than a run):
  // holders that read an op as sent write it into the data first, so it is never sent again.
  it('never sends one op twice once the witnesses dropped its entry (60 seeds, 10-minute retention)', async () => {
    const r = await sweep(60, { ops: true, restarts: true, tickMs: 1_000, params: { opRetainMs: 600_000 }, minutes: 25 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent).toBeGreaterThan(1_000)
  }, 120_000)

  // Two processes of every machine (a second server beside the first): the witnesses tell them apart.
  it('never lets two processes act at once when each machine runs two (60 seeds)', async () => {
    const r = await sweep(60, { twins: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  // A change left between its steps by a holder that restarted is finished by whoever holds next.
  it('keeps working when holders restart in the middle of list changes (60 seeds)', async () => {
    const r = await sweep(60, { members: true, pool5: true, restarts: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  it('holds with no faults beyond the network across longer runs', async () => {
    const r = await sweep(20, { minutes: 60 })
    expect(r.firstBad).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.6)
  }, 120_000)

  describe('negative controls: each removed safety part is caught', () => {
    it('margins removed: drift turns it red', async () => {
      let violations = 0
      for (let from = 1; from <= 40 && violations === 0; from += 10) {
        violations += (await sweep(10, { params: { holderMarginMs: 0, witnessMarginMs: 0, maxDriftRate: 0 }, tickMs: 250, noBackoff: true, worstDrift: true, delayMs: [1, 20], splitsOnly: true }, from)).violations
      }
      expect(violations).toBeGreaterThan(0)
    }, 120_000)

    it('a witness that answers before its record is on disk: crashes turn it red', async () => {
      const r = await sweep(300, { lazyStore: true, crashRate: 0.2 })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a holder that counts on the monotonic clock alone: sleep turns it red', async () => {
      const r = await sweep(300, { pureMonotonic: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    // A registration that reached even one witness usually protects the op, since the next
    // holder hears that witness too; the majority is for when it does not. The cut that shows
    // it: a holder out of touch with every witness sends on a registration nobody took.
    it('a send before its registration stood: a holder cut off from every witness sends, and the next holder sends again', async () => {
      const r = await sweep(100, { ops: true, members: true, pool5: true, tickMs: 1_000, sendUnregistered: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a holder that does not write what it read as sent into its data: once the entry is dropped, it is sent again', async () => {
      const r = await sweep(60, { ops: true, restarts: true, tickMs: 1_000, params: { opRetainMs: 600_000 }, minutes: 25, noRecordSeen: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('list changes that carry no op entries: an op sent before a change is sent again after', async () => {
      const r = await sweep(100, { ops: true, members: true, pool5: true, restarts: true, tickMs: 1_000, dropLedger: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('two processes of a machine with one incarnation: they act at once', async () => {
      const r = await sweep(100, { twins: true, twinsShareNonce: true, tickMs: 1_000 }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a majority of the witnesses that answered: splits turn it red', async () => {
      const r = await sweep(300, { reachableMajority: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)
  })
})
