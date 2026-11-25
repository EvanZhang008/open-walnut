/**
 * Model-checking style: many random schedules from seeds, two invariants. At no real
 * instant do two processes both have mayAct() === true, and no op id is sent by two
 * processes. Each negative control turns one safety part off and must find a violation,
 * so the invariant check is known to bite.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMIT_PARAMS, generationToJoin, prepareJoiningWitness, type PermitParams, type PermitReply } from '../../../../src/core/leader/permit/index.js'
import { SimStore, World, actUntilReleaseStood, countOwnLiveGrants, grantOnAnyProcess, pilot, releaseOnAnyLive, takeOnMinorityRelease } from './sim.js'

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
  /**
   * Planned stops: about every 1 to 2.5 minutes a process releases and exits (World.plannedStop),
   * the one that acts or any other, and half the machines that sleep or are cut off do so the
   * instant they wake or the cut heals; the next process of its machine starts; the release reaches every witness, or only a
   * majority, or only one.
   */
  releases?: boolean
  /** Negative control (releases): the releaser keeps acting until its release stood. */
  actUntilStood?: boolean
  /** Negative control (releases): a new process takes it on a release of its machine seen at a minority. */
  minorityTakes?: boolean
  /** Negative control (releases): a witness takes a release on any live record, whoever holds it. */
  releaseAnyOwner?: boolean
  /** Count in `injected` the grants a witness took on a live record of the grant's own process (rules.ts judge). */
  countOwnGrants?: boolean
  /** Candidates count a witness holding their own process's live record as free, as the runtime does (sim.ts pilot). */
  ownCountsFree?: boolean
  /** Negative control: a witness takes a grant on a live record of the grant's machine, whatever the process. */
  grantAnyProcess?: boolean
  /**
   * A process whose handover is open asks a grant 30% of its ticks (runtime.ts: lost with its cancel owed, and cancel()
   * once only a grant can stand); `injected` counts the freezes such a grant ended where the process then acted.
   */
  frozenGrants?: boolean
  /** Negative control (frozenGrants): the process ends its freeze the moment it asks, before a majority took the grant. */
  unfreezeOnAsk?: boolean
  /** The network transport's timeout per request (default: none; the real default is 20 s). */
  transportTimeoutMs?: number
  /** Old replies come back after newer ones (a link or a transport that redelivers): the core must not care. */
  replayOldReplies?: boolean
  /** Negative control: a transport that also hands each reply over as another witness's (one machine counted as two). */
  wrongWitnessId?: boolean
  /** Every witness is reached by its direct door (way b): a challenge, the keyed call, the keyed reply. */
  direct?: boolean
  /** Each request to a witness goes by its link or its door at random (one record behind both). */
  mixedWays?: boolean
  /** Every witness is reached by its machine's door over the caller's host link (`host-link`, leader-relay.ts). */
  hostLink?: boolean
  /**
   * w3 is not set up at the start (no file: the list leads on w1 and w2); after the first lead the
   * holder drops it from the list, it is set up as a joining witness from the generation the
   * witnesses report, and the holder adds it back (witness-setup.ts, the init of a witness missing beside records).
   */
  joinThird?: boolean
  /**
   * Mixed clocks on witness dirs: machine A runs a permit scaled to a tenth (validMs 6 s, as
   * WALNUT_LEADER_PERMIT_VALID_MS=6000 gives), B and C the default; each process opens every
   * witness record itself with its own params (World.paramsOf).
   */
  mixedClocks?: boolean
}

/** The default clocks at a tenth, as settings.ts permitParamsFor scales them. */
function scaledTenth(p: PermitParams): PermitParams {
  const f = 0.1
  return { ...p, validMs: p.validMs * f, renewEveryMs: p.renewEveryMs * f, holderMarginMs: p.holderMarginMs * f, witnessMarginMs: p.witnessMarginMs * f, minSendRemainingMs: p.minSendRemainingMs * f, backoffBaseMs: p.backoffBaseMs * f, backoffMaxMs: p.backoffMaxMs * f }
}

function schedule(seed: number, v: Variant = {}): { world: World; totalMs: number } {
  const params = { ...DEFAULT_PERMIT_PARAMS, ...v.params }
  const world = new World(params, {
    drop: 0.1, dup: 0.05, delayMs: v.delayMs ?? [2, 300],
    slow: v.lateSteps ? 0.1 : 0.04, slowMs: v.lateSteps ? [60_000, 300_000] : [1_000, 90_000],
  }, seed)
  const r = world.rand
  if (v.mixedClocks) { const scaled = scaledTenth(params); world.paramsOf = (key) => (key.startsWith('A') ? scaled : params) }
  if (v.direct) world.way = 'direct'
  if (v.mixedWays) world.way = 'mixed'
  if (v.hostLink) world.way = 'host-link'
  if (v.transportTimeoutMs !== undefined) world.transportTimeoutMs = v.transportTimeoutMs
  // With the real 15 s timeout the real in-flight caps apply too (lost messages free their slot then).
  if (v.transportTimeoutMs === 15_000) world.transportMaxInFlight = undefined
  if (v.replayOldReplies) world.wrapDeliver = replayOldReplies(world, r)
  if (v.wrongWitnessId) world.wrapDeliver = answerAsWrongWitness(world, r)
  const bound = (v.params?.maxDriftRate === 0 ? DEFAULT_PERMIT_PARAMS.maxDriftRate : params.maxDriftRate) * (v.driftShare ?? 0.99)
  const drift = (side: 1 | -1) => (v.worstDrift ? side : r() * 2 - 1) * bound
  // Every witness a variant changes: set before the first is added, so restarted ones and the first ones alike.
  if (v.releaseAnyOwner) world.onNewWitness = (n) => releaseOnAnyLive(n.w!)
  if (v.countOwnGrants) world.onNewWitness = (n) => countOwnLiveGrants(world, n.w!)
  if (v.grantAnyProcess) world.onNewWitness = (n) => grantOnAnyProcess(n.w!)
  const extra = v.members ? (v.pool5 ? ['w4', 'w5'] : ['w4']) : []
  const pool = [...W, ...extra]
  for (const id of extra) world.addWitness(id, { drift: drift(1), joinFrom: 0 })
  for (const id of W) {
    if (v.joinThird && id === 'w3') { world.addWitness(id, { drift: drift(1) }); continue }
    const n = world.addWitness(id, { drift: drift(1), store: new SimStore(v.lazyStore ? 'lazy' : 'durable'), bootstrap: W })
    if (v.lazyStore) {
      const flush = () => { n.store.flush(); world.after(20_000, flush) }
      world.after(20_000 * r(), flush)
    }
  }
  // Every process a negative control changes, the first ones and every restarted one.
  world.onNewClient = (m) => {
    if (v.reachableMajority) patchReachableMajority(m.c)
    if (v.dropLedger) dropLedger(m.c)
    if (v.actUntilStood) actUntilReleaseStood(m.c)
    if (v.minorityTakes) takeOnMinorityRelease(m.c)
  }
  for (const id of M) {
    world.addMachine(id, W, { drift: drift(-1), wallOffset: (r() * 2 - 1) * 30_000, pureMonotonic: v.pureMonotonic, ...(v.twinsShareNonce ? { nonce: `${id}-one` } : {}) })
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
      ownCountsFree: v.ownCountsFree,
      frozenGrantChance: v.frozenGrants ? 0.3 : 0,
      unfreezeOnAsk: v.unfreezeOnAsk,
      sparseStamps: v.restarts,
      cancelChance: 0.3,
      onTick: (m) => {
        // About one manual switch per machine-held 3 minutes, whatever the tick. (A change
        // left between its two steps is finished first: the pilot's repairChange.)
        if (m.c.jointList()) return
        if (v.joinThird && m.c.mayAct() && joinThird(world, m.c)) return
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
  /** A planned stop of process `key`, unless it is asleep, down or already stopping. */
  const plannedStop = (key: string): void => {
    const m = world.machines.get(key)!
    if (m.clock.asleep() || world.now < m.downUntil || m.c.released()) return
    const list = m.c.witnessList()
    const x = r()
    const start = Math.floor(r() * list.length)
    const turned = list.map((_, i) => list[(start + i) % list.length])
    const reach = x < 0.7 ? null : x < 0.85 ? turned.slice(0, Math.floor(list.length / 2) + 1) : turned.slice(0, 1)
    world.plannedStop(key, W, { reach, downMs: 200 + r() * 2_000, keepConfig: true })
  }
  /**
   * Half the time a machine that was cut off from witnesses stops the instant the cut heals,
   * before it heard anything: it kept renewing at the witnesses it still reached, so its
   * numbers may be above the next holder's record at the others, and its lease ran out on its
   * clock but is not cleared. The rule refuses its release there (not its writer's record).
   */
  const healStop = (key: string): void => {
    if (v.releases && r() < 0.5) world.after(r() * 200, () => plannedStop(key))
  }
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
        const wake = world.now + 10_000 + r() * 110_000
        m.clock.sleeps.push([world.now, wake])
        // A planned stop the instant it wakes, before any answer: its lease ran out in the sleep
        // but is not cleared yet, and another machine may hold by now.
        if (v.releases && r() < 0.5) world.at(wake + r() * 200, () => plannedStop(m.key))
      } else if (kind === 2) {
        const a = M[Math.floor(r() * 3)], b = pool[Math.floor(r() * pool.length)]
        world.partition(a, b, true)
        world.after(20_000 + r() * 120_000, () => {
          world.partition(a, b, false)
          healStop(a)
        })
      } else if (kind === 3) {
        const m = world.machines.get(M[Math.floor(r() * 3)])!
        const jump = (r() * 2 - 1) * 120_000
        // Not in the middle of a sleep: a wall clock set back while a machine sleeps hides that much of the sleep from the
        // fallback clock (mono-wall, clock.ts); the machines the permit runs on count sleep with the boot clock. It has
        // its own named case: system-clock.test.ts 'a set-back of 77 s, 68 s into the sleep' (seed 65 of the
        // 'instant they may' chunk met it once the transport changed the random stream).
        if (!m.clock.asleep()) m.clock.wallJumps.push([world.now, jump])
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
        // With planned stops, half the time the other machines lose the witness `a` keeps, for as
        // long: the next holder then never sees the numbers `a` goes on renewing there, so `a`'s
        // numbers can be above its record when `a` stops at the heal (healStop). That split heals
        // after 65 to 105 s: after the next holder took over at the other two witnesses, while
        // the record `a` renewed at the one it kept still holds there.
        const others = v.releases && r() < 0.5 ? M.filter((x) => x !== a) : []
        for (const o of others) world.partition(o, keep, true)
        const span = r()
        world.after(others.length ? 65_000 + span * 40_000 : 30_000 + span * 120_000, () => {
          for (const w of cut) world.partition(a, w, false)
          for (const o of others) world.partition(o, keep, false)
          healStop(a)
        })
      } else if (kind === 7) {
        const a = M[Math.floor(r() * 3)]
        for (const w of pool) world.partition(a, w, true)
        world.after(180_000 + r() * 240_000, () => { for (const w of pool) world.partition(a, w, false) })
      } else {
        const id = (v.restarts && world.acting()[0]) || processes[Math.floor(r() * processes.length)]
        world.restartMachine(id, W, 1_000 + r() * 20_000, undefined, v.ops)
      }
    })
  }
  if (v.releases) {
    // Planned stops (a deploy), each released before the process exits: half of them of whoever
    // acts, half of any process (one whose lease ran out but is not cleared, a twin, one just
    // superseded): the witnesses must take a release only on its writer's own live record.
    for (let t = 30_000 + r() * 60_000; t < totalMs; t += 60_000 + r() * 90_000) {
      world.at(t, () => {
        const key = r() < 0.5 ? world.acting()[0] : processes[Math.floor(r() * processes.length)]
        if (key) plannedStop(key)
      })
    }
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

/**
 * A transport that redelivers: after a reply it hands over, an OLDER reply of the same witness comes
 * again up to 30 s later, so a read or an answer is seen after a newer one.
 */
function replayOldReplies(world: World, r: () => number): NonNullable<World['wrapDeliver']> {
  return (_from, base) => {
    const seen = new Map<string, PermitReply[]>()
    return (reply) => {
      base(reply)
      const list = seen.get(reply.witness) ?? []
      list.push(reply)
      seen.set(reply.witness, list)
      if (list.length > 1 && r() < 0.5) {
        const old = list[Math.floor(r() * (list.length - 1))]!
        world.injected++
        world.after(1 + r() * 30_000, () => base(JSON.parse(JSON.stringify(old)) as PermitReply))
      }
    }
  }
}

/** Negative control: half the replies are handed over a second time under another witness's id. */
function answerAsWrongWitness(world: World, r: () => number): NonNullable<World['wrapDeliver']> {
  return (_from, base) => (reply) => {
    base(reply)
    if (r() < 0.5) {
      const others = W.filter((w) => w !== reply.witness)
      world.injected++
      base({ ...reply, witness: others[Math.floor(r() * others.length)]! })
    }
  }
}

/** Negative control: list changes carry no op entries to the witnesses that join. */
function dropLedger(c: object): void {
  ;(c as { ops: { ledger: () => unknown[] } }).ops.ledger = () => []
}

/** Op ids sent by more than one process. */
/**
 * The leader's steps for a witness missing beside records, as init takes them: drop w3 from the list, set
 * it up as joining from the generation the witnesses report (permit/store.ts generationToJoin), add it
 * back. Each step is one list change the holder writes; true while a step was taken this tick.
 */
function joinThird(world: World, c: import('../../../../src/core/leader/permit/index.js').PermitClient): boolean {
  const w3 = world.witnesses.get('w3')!
  const list = c.witnessList()
  // One change at a time: its proposal is open until a majority of both lists took it.
  if (c.pendingRecord()?.kind === 'members') return true
  const stored = w3.store.load()
  // The order witness-setup.ts runs: set up as joining first (from the witnesses' generation, never below the
  // holder's own), then the list without it, then the list with it.
  if (stored === null) {
    const gen = generationToJoin(c.readBack(), c.config().epoch)
    if (gen === null) return false
    prepareJoiningWitness(w3.store, gen, c.config().epoch)
    w3.store.flush()
    world.startWitness(w3)
    return true
  }
  const joined = !!stored.list?.includes('w3')
  if (!joined && list.includes('w3')) { c.changeWitnesses(list.filter((x) => x !== 'w3')); return true }
  if (!list.includes('w3')) { c.changeWitnesses([...list, 'w3']); return true }
  return false
}

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
  let releases = 0
  let stood = 0
  /** Planned stops whose release reached every witness and stood, and those of them taken over within 10 s. */
  let fullStood = 0
  let fast = 0
  let injected = 0
  for (let seed = from; seed < from + seeds; seed++) {
    await new Promise((res) => setImmediate(res))
    const { world, totalMs } = schedule(seed, v)
    sent += world.sends.size
    injected += world.injected
    unknown += world.unknownSeen.size
    if (world.violations.length > 0 || doubleSends(world).length > 0) {
      violations++
      firstBad ??= seed
      if (stopAtFirst) break
    }
    for (const ms of world.activeMs.values()) active += ms
    total += totalMs
    for (const e of world.releases) {
      if (!e.record) continue
      releases++
      if (e.stoodAt === null) continue
      stood++
      if (e.reach) continue
      fullStood++
      const next = world.timeline.find(([t, who]) => t > e.at && who.length > 0)
      if (next && next[0] - e.at < 10_000) fast++
    }
  }
  return { violations, firstBad, injected, activeShare: active / total, sent, unknown, releases, stood, fastShare: fullStood ? fast / fullStood : 0 }
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

  // A grant on a live record of its own process (the retake after a failed trial: rules.ts judge) is taken as its renew
  // would be. Counted where a witness took one, so the case is reached, not only allowed; twins and planned stops beside it.
  it('never lets two processes act at once when grants land on their own process\'s live records (100 seeds, twins, planned stops)', async () => {
    const r = await sweep(100, { twins: true, releases: true, tickMs: 1_000, ownCountsFree: true, countOwnGrants: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    console.log(`grants taken on their own process's live record: ${r.injected}`)
    expect(r.injected).toBeGreaterThan(0)
  }, 120_000)

  // A process whose handover is open takes the permission back by a grant (permit/client.ts: a grant of its own that
  // stood ends the freeze); counted where one did and the process then acted.
  it('never lets two processes act at once when a process with an open handover takes it back by a grant (200 seeds, twins, planned stops)', async () => {
    const r = await sweep(200, { twins: true, releases: true, tickMs: 1_000, ownCountsFree: true, frozenGrants: true })
    console.log(`freezes ended by a grant that stood, the process acting after: ${r.injected}`)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.injected).toBeGreaterThan(0)
  }, 300_000)

  // A change left between its steps by a holder that restarted is finished by whoever holds next.
  it('keeps working when holders restart in the middle of list changes (60 seeds)', async () => {
    const r = await sweep(60, { members: true, pool5: true, restarts: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  // Planned stops (deploys): the holder releases, exits, and the next process takes it at once.
  for (let from = 1; from <= 150; from += 50) {
    it(`never lets two processes act at once across planned stops with a release, and the next one takes it within seconds (seeds ${from} to ${from + 49})`, async () => {
      const r = await sweep(50, { releases: true, tickMs: 1_000 }, from)
      expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
      expect(r.releases).toBeGreaterThan(200)
      // Not vacuous: most releases that reached every witness were taken over within 10 s.
      expect(r.fastShare).toBeGreaterThan(0.8)
      expect(r.activeShare).toBeGreaterThan(0.3)
    }, 120_000)
  }

  it('never lets two processes act at once across planned stops when candidates ask the instant they may (100 seeds)', async () => {
    const r = await sweep(100, { releases: true, tickMs: 250, noBackoff: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.stood).toBeGreaterThan(200)
  }, 120_000)

  // Every fault the split, half of them with the other machines cut from the witness it keeps,
  // and the cut machine stopping the instant the split heals (with its lease run out, not cleared).
  it('never lets two processes act at once across planned stops of processes cut off in splits (100 seeds)', async () => {
    const r = await sweep(100, { releases: true, splitsOnly: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.stood).toBeGreaterThan(200)
  }, 120_000)

  it('never lets two processes act at once across planned stops when each machine runs two (60 seeds)', async () => {
    const r = await sweep(60, { releases: true, twins: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.stood).toBeGreaterThan(100)
  }, 120_000)

  it('never sends one op twice across planned stops, crashes and restarts (80 seeds)', async () => {
    const r = await sweep(80, { releases: true, ops: true, restarts: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent).toBeGreaterThan(1_500)
    expect(r.stood).toBeGreaterThan(100)
  }, 120_000)

  it('never lets two processes act at once across planned stops during list changes over five witnesses (60 seeds)', async () => {
    const r = await sweep(60, { releases: true, members: true, pool5: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.stood).toBeGreaterThan(100)
  }, 120_000)

  // The network transport is the real one (witness-transport.ts) in every run above; these add what
  // only it can do: time a request out, and see replies that come again.
  it('never lets two machines act at once when the transport drops a reply after 3 s (100 seeds)', async () => {
    const r = await sweep(100, { transportTimeoutMs: 3_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  it('never lets two machines act at once with the real 15 s timeout and steps arriving minutes late (60 seeds)', async () => {
    const r = await sweep(60, { transportTimeoutMs: 15_000, members: true, pool5: true, lateSteps: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
  }, 120_000)

  it('never lets two machines act at once when old replies arrive again after newer ones (200 seeds)', async () => {
    const r = await sweep(200, { replayOldReplies: true })
    expect(r.injected, 'old replies were redelivered').toBeGreaterThan(1_000)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
  }, 120_000)

  it('never lets two processes act at once, or sends an op twice, when old replies come again across restarts, planned stops and list changes (60 seeds)', async () => {
    const r = await sweep(60, { replayOldReplies: true, ops: true, releases: true, restarts: true, members: true, tickMs: 1_000 })
    expect(r.injected).toBeGreaterThan(1_000)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
  }, 120_000)

  // Way b, the direct door (witness-direct.ts and witness-door.ts, each witness with its own key): every
  // request is two posts over the faulty network, its nonce timed on the witness's clock.
  it('never lets two machines act at once through the witnesses\' direct doors (200 seeds, faults, drift at the edge)', async () => {
    const r = await sweep(200, { direct: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    // Not vacuous. Lower than over a link (0.5): a request is four messages here, each lost one time in ten.
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  it('never lets two processes act at once, or sends an op twice, through the direct doors with the real 15 s timeout, restarts, planned stops and list changes (60 seeds)', async () => {
    const r = await sweep(60, { direct: true, transportTimeoutMs: 15_000, ops: true, releases: true, restarts: true, members: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent, 'ops were sent').toBeGreaterThan(0)
  }, 120_000)

  // The `host-link` way (leader-relay.ts): the same caller and door as way b, the door at its fixed path at the far end
  // of the caller's host link. The link's own failures (it delays, drops, cuts) are the simulated network's here; the
  // real stream's are in tests/core/leader/switch/leader-relay.test.ts.
  it('never lets two machines act at once through the witnesses\' doors over a host link (200 seeds, faults, drift at the edge)', async () => {
    const r = await sweep(200, { hostLink: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  it('never lets two processes act at once, or sends an op twice, over a host link with the real 15 s timeout, restarts, planned stops and list changes (60 seeds)', async () => {
    const r = await sweep(60, { hostLink: true, transportTimeoutMs: 15_000, ops: true, releases: true, restarts: true, members: true, tickMs: 1_000 })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.sent, 'ops were sent').toBeGreaterThan(0)
  }, 120_000)

  it('never lets two machines act at once over a host link when old replies arrive again (100 seeds)', async () => {
    const r = await sweep(100, { hostLink: true, replayOldReplies: true })
    expect(r.injected).toBeGreaterThan(500)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
  }, 120_000)

  it('never lets two machines act at once when one machine runs scaled clocks on the same witness records (200 seeds, faults, drift)', async () => {
    const r = await sweep(200, { mixedClocks: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    // Not vacuous (measured 0.23: A's short records are refused while B's or C's are held).
    expect(r.activeShare).toBeGreaterThan(0.15)
  }, 120_000)

  it('never lets two machines act at once when each witness is reached by its link or its door at random (200 seeds)', async () => {
    const r = await sweep(200, { mixedWays: true })
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
    expect(r.activeShare).toBeGreaterThan(0.3)
  }, 120_000)

  it('never lets two processes act at once when the third witness joins after the first lead, through two list changes (100 seeds, faults, ops, restarts)', async () => {
    let joined = 0
    let firstBad: number | null = null
    for (let seed = 1; seed <= 100; seed++) {
      await new Promise((res) => setImmediate(res))
      const { world } = schedule(seed, { joinThird: true, ops: true, restarts: true, tickMs: 1_000 })
      if (world.violations.length > 0 || doubleSends(world).length > 0) { firstBad ??= seed; break }
      // It joined: some machine runs on all three, and w3 took a record after it.
      const lists = [...world.machines.values()].map((m) => m.c.witnessList())
      if (lists.some((l) => l.includes('w3')) && world.witnesses.get('w3')!.store.load()?.list?.includes('w3')) joined++
    }
    expect(firstBad, `first violating seed ${firstBad}`).toBeNull()
    // Not vacuous: the seeds are fixed, and 67 of 100 join (the rest end first, or keep a change open under the faults).
    expect(joined, 'w3 joined in most runs').toBeGreaterThan(50)
  }, 180_000)

  it('never lets two machines act at once through the direct doors when old replies arrive again (100 seeds)', async () => {
    const r = await sweep(100, { direct: true, replayOldReplies: true })
    expect(r.injected).toBeGreaterThan(500)
    expect(r.firstBad, `first violating seed ${r.firstBad}`).toBeNull()
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

    it('a releaser that keeps acting until its release stood: another candidate acts beside it', async () => {
      const r = await sweep(200, { releases: true, tickMs: 250, noBackoff: true, actUntilStood: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    // Rare in random schedules: a stale process stops proposing once its lease ran out, so its
    // numbers are below the next holder's record unless that holder never saw the witness it kept
    // (the cross cut of the splits). Named case: 'planned stop of a process whose lease ran out'.
    it('a witness that takes a release on another holder\'s record: a stale releaser frees the holder\'s witnesses', async () => {
      const r = await sweep(200, { releases: true, splitsOnly: true, tickMs: 1_000, releaseAnyOwner: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a new process that takes it on a release seen at a minority: it acts beside the next holder', async () => {
      const r = await sweep(200, { releases: true, tickMs: 1_000, minorityTakes: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a witness that takes a grant on a live record of its machine whatever the process: the second process acts beside the first', async () => {
      const r = await sweep(100, { twins: true, tickMs: 1_000, ownCountsFree: true, grantAnyProcess: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a process with an open handover that ends its freeze when it asks a grant, not once a majority took it: it acts beside the new holder', async () => {
      const r = await sweep(200, { tickMs: 1_000, ownCountsFree: true, frozenGrants: true, unfreezeOnAsk: true }, 1, true)
      expect(r.violations).toBeGreaterThan(0)
    }, 300_000)

    it('a transport that answers as another witness too: one machine counts as two and the majority is not one', async () => {
      const r = await sweep(300, { wrongWitnessId: true })
      expect(r.injected).toBeGreaterThan(1_000)
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)

    it('a majority of the witnesses that answered: splits turn it red', async () => {
      const r = await sweep(300, { reachableMajority: true })
      expect(r.violations).toBeGreaterThan(0)
    }, 120_000)
  })
})
