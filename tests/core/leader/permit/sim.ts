/**
 * A simulated world for the write permission: one real timeline, nodes with their own
 * clocks (rate drift, wall offset and jumps, sleeps that stop the monotonic clock), a
 * network that delays, drops, duplicates and reorders, witnesses that crash and restart
 * from their stored file, and machines whose mayAct() is checked after every event.
 */
import {
  bootstrapWitnessStore, prepareJoiningWitness, mayAskForTakeover, PermitClient, PermitWitness, createHolderClock, createWitnessClock, decodeStored, encodeStored,
  type ElapsedClock, type PermitParams, type PermitReply, type PermitRequest, type PermitStore, type StoredWitness,
} from '../../../../src/core/leader/permit/index.js'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A node's clocks: rate 1+drift on both; the wall has an offset and jumps; sleeps stop the monotonic one. */
export class NodeClock {
  sleeps: Array<[number, number]> = []
  wallJumps: Array<[number, number]> = []
  constructor(private readonly world: World, public drift = 0, public wallOffset = 0, public monoOffset = 0) {
    // A machine that wakes may act at once: give the world an event at each wake, so the
    // invariant is checked at that instant and not only at the next event.
    const sleeps = this.sleeps
    sleeps.push = (...items: Array<[number, number]>): number => {
      for (const [, end] of items) world.at(end, () => {})
      return Array.prototype.push.apply(sleeps, items)
    }
  }
  private active(t: number): number {
    let slept = 0
    for (const [s, e] of this.sleeps) if (t > s) slept += Math.min(t, e) - s
    return t - slept
  }
  asleep(t = this.world.now): boolean {
    return this.sleeps.some(([s, e]) => t >= s && t < e)
  }
  wakeAt(t = this.world.now): number {
    const s = this.sleeps.find(([a, b]) => t >= a && t < b)
    return s ? s[1] : t
  }
  monotonic = (): number => this.monoOffset + (1 + this.drift) * this.active(this.world.now)
  /** The machine's clock that counts sleep (CLOCK_BOOTTIME): never set, never stopped. */
  boot = (): number => this.monoOffset + (1 + this.drift) * this.world.now
  wall = (): number => {
    let j = 0
    for (const [at, by] of this.wallJumps) if (this.world.now >= at) j += by
    return this.wallOffset + (1 + this.drift) * this.world.now + j
  }
}

export class SimCrash extends Error {}

/**
 * A witness's disk. 'durable': a save is on disk when it returns (fsync before the
 * answer). 'lazy' (a negative control): a save returns at once and reaches disk only
 * at the next flush, so a crash forgets a record the witness already said yes to.
 */
export class SimStore implements PermitStore {
  disk: string | null = null
  buffer: string | null = null
  constructor(public mode: 'durable' | 'lazy' = 'durable') {}
  load(): StoredWitness | null {
    return this.disk === null ? null : decodeStored(this.disk, 'sim')
  }
  save(s: StoredWitness): void {
    if (this.mode === 'durable') this.disk = encodeStored(s)
    else this.buffer = encodeStored(s)
  }
  flush(): void {
    if (this.buffer !== null) this.disk = this.buffer
    this.buffer = null
  }
  crash(): void {
    this.buffer = null
  }
}

export interface NetOptions {
  drop: number
  dup: number
  /** Delay of one message in ms: [min, max], with a `slow` share drawn from slowMs. */
  delayMs: [number, number]
  slow: number
  slowMs: [number, number]
}

export const CALM: NetOptions = { drop: 0, dup: 0, delayMs: [5, 5], slow: 0, slowMs: [0, 0] }

interface Ev { at: number; seq: number; run: () => void }
const before = (a: Ev, b: Ev): boolean => a.at < b.at || (a.at === b.at && a.seq < b.seq)

export interface WitnessNode { id: string; store: SimStore; clock: NodeClock; w: PermitWitness | null; downUntil: number }
/** `key` names the process (the network and the checks use it); `id` is its machine's id. Two processes of one machine share an id. */
export interface MachineNode { key: string; id: string; clock: NodeClock; c: PermitClient; pureMonotonic: boolean; bootClock: boolean; downUntil: number }

export class World {
  now = 0
  private seq = 0
  private q: Ev[] = []
  witnesses = new Map<string, WitnessNode>()
  machines = new Map<string, MachineNode>()
  /** Pairs that cannot talk: "a|b". */
  cut = new Set<string>()
  violations: Array<{ at: number; who: string[] }> = []
  /** Every change of who may act: [time, ids]. */
  timeline: Array<[number, string[]]> = [[0, []]]
  activeMs = new Map<string, number>()
  private lastCheck = 0
  rand: () => number
  /** Set to an array to record every record a witness takes. */
  trace: string[] | null = null
  /** The Walnut's own write sequence, shared by whichever machine holds the permission. */
  writeSeq = 0
  /** Stops every pilot (a test then reads back a still world). */
  pilotsStopped = false
  /** Outward sends (pilot ops): the ids to send, those the data marks done, every send made, ids seen as unknown. */
  outbox: string[] = []
  done = new Set<string>()
  sends = new Map<string, Array<{ by: string; nonce: string; at: number }>>()
  unknownSeen = new Set<string>()

  constructor(public params: PermitParams, public net: NetOptions = CALM, seed = 1) {
    this.rand = rng(seed)
  }

  at(t: number, run: () => void): void {
    // A binary heap ordered by (time, insertion).
    const q = this.q
    q.push({ at: Math.max(t, this.now), seq: this.seq++, run })
    let i = q.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!before(q[i], q[p])) break
      ;[q[i], q[p]] = [q[p], q[i]]
      i = p
    }
  }
  private pop(): Ev {
    const q = this.q
    const top = q[0]
    const last = q.pop()!
    if (q.length > 0) {
      q[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < q.length && before(q[l], q[m])) m = l
        if (r < q.length && before(q[r], q[m])) m = r
        if (m === i) break
        ;[q[i], q[m]] = [q[m], q[i]]
        i = m
      }
    }
    return top
  }
  after(ms: number, run: () => void): void {
    this.at(this.now + ms, run)
  }

  /** `bootstrap`: the first list; `joinFrom`: a witness set up to join from that generation; neither: no file. */
  addWitness(id: string, opts: { drift?: number; offset?: number; store?: SimStore; bootstrap?: string[]; joinFrom?: number } = {}): WitnessNode {
    const store = opts.store ?? new SimStore()
    if (opts.bootstrap) {
      bootstrapWitnessStore(store, opts.bootstrap)
      store.flush()
    } else if (opts.joinFrom !== undefined) {
      prepareJoiningWitness(store, opts.joinFrom)
      store.flush()
    }
    const node: WitnessNode = { id, store, clock: new NodeClock(this, opts.drift ?? 0, 0, opts.offset ?? 0), w: null, downUntil: 0 }
    this.witnesses.set(id, node)
    this.startWitness(node)
    return node
  }

  startWitness(n: WitnessNode): void {
    n.w = new PermitWitness({ id: n.id, store: n.store, clock: createWitnessClock({ monotonic: n.clock.monotonic }), params: this.params })
  }

  /** Crash now (losing what is not on disk) and come back after `downMs`. */
  crashWitness(id: string, downMs: number): void {
    const n = this.witnesses.get(id)!
    n.store.crash()
    n.w = null
    n.downUntil = this.now + downMs
    this.at(n.downUntil, () => this.startWitness(n))
  }

  /** `key`: a second process of machine `id` (default: the id itself). */
  addMachine(id: string, list: string[], opts: { drift?: number; wallOffset?: number; pureMonotonic?: boolean; bootClock?: boolean; nonce?: string; key?: string; clockOf?: string; cfg?: string; epoch?: number } = {}): MachineNode {
    const key = opts.key ?? id
    // A second process of a machine reads that machine's clocks.
    const clock = opts.clockOf ? this.machines.get(opts.clockOf)!.clock : new NodeClock(this, opts.drift ?? 0, opts.wallOffset ?? 0)
    const node = { key, id, clock, pureMonotonic: !!opts.pureMonotonic, bootClock: !!opts.bootClock, downUntil: 0 } as MachineNode
    node.c = this.newClient(node, list, opts.nonce, opts.cfg, opts.epoch)
    this.machines.set(key, node)
    this.activeMs.set(key, 0)
    return node
  }

  private newClient(node: MachineNode, list: string[], nonce?: string, cfg?: string, epoch?: number): PermitClient {
    const clock: ElapsedClock = node.pureMonotonic
      ? createWitnessClock({ monotonic: node.clock.monotonic })
      : createHolderClock({ monotonic: node.clock.monotonic, wall: node.clock.wall, ...(node.bootClock ? { boot: { kind: 'boottime' as const, now: node.clock.boot } } : {}) })
    return new PermitClient({
      id: node.id, list, clock, params: this.params, ...(nonce ? { testNonce: nonce } : {}), ...(cfg ? { cfg } : {}), ...(epoch !== undefined ? { epoch } : {}),
      transport: { send: (w, req) => this.send(node.key, w, req) },
    })
  }

  /**
   * The machine restarts: a new client that remembers nothing (as after a process restart).
   * `nonce` (a negative control only) makes it reuse an incarnation.
   */
  restartMachine(key: string, list: string[], downMs: number, nonce?: string, keepConfig = false): void {
    const n = this.machines.get(key)!
    n.downUntil = this.now + downMs
    // keepConfig: the process starts from the witness list it last knew (kept on its disk).
    const known = keepConfig ? n.c.config() : null
    n.c = known && !known.joint ? this.newClient(n, known.list, nonce, known.cfg, known.epoch) : this.newClient(n, list, nonce)
  }

  partition(a: string, b: string, on = true): void {
    const k = [a, b].sort().join('|')
    if (on) this.cut.add(k)
    else this.cut.delete(k)
  }
  private blocked(a: string, b: string): boolean {
    return this.cut.has([a, b].sort().join('|'))
  }

  private delay(): number {
    const [a, b] = this.rand() < this.net.slow ? this.net.slowMs : this.net.delayMs
    return a + this.rand() * (b - a)
  }

  /** A hook a test sets to drop or delay one message: return a delay, or null to drop. */
  intercept: ((from: string, to: string, msg: PermitRequest | PermitReply, delay: number) => number | null) | null = null

  private transmit(from: string, to: string, msg: PermitRequest | PermitReply, deliver: () => void): void {
    if (this.blocked(from, to) || this.rand() < this.net.drop) return
    const copies = this.rand() < this.net.dup ? 2 : 1
    for (let i = 0; i < copies; i++) {
      let d: number | null = this.delay()
      if (this.intercept) d = this.intercept(from, to, msg, d)
      if (d === null) continue
      this.after(d, deliver)
    }
  }

  private send(from: string, to: string, req: PermitRequest): void {
    this.transmit(from, to, req, () => this.deliverToWitness(from, to, req))
  }

  /** Called with the reply about to go out; return true to crash the witness instead of answering. */
  crashBeforeAnswer: ((witness: string, req: PermitRequest, reply: PermitReply) => boolean) | null = null

  private deliverToWitness(from: string, to: string, req: PermitRequest): void {
    const n = this.witnesses.get(to)
    if (!n || !n.w || n.clock.asleep()) return
    const reply = n.w.handle(req)
    if (this.trace && req.type === 'propose' && reply.ok) {
      const r = req.record
      this.trace.push(`${(this.now / 1000).toFixed(3)} ${to} took #${r.number} ${r.kind} by ${r.by} -> ${r.holder} list=${r.list.join(',')}${r.joint ? ' pair=' + r.joint.join(',') : ''}${r.stage ? ' ' + r.stage : ''}`)
    }
    if (this.crashBeforeAnswer?.(to, req, reply)) {
      this.crashWitness(to, 1_000 + this.rand() * 10_000)
      return
    }
    this.transmit(to, from, reply, () => this.deliverToMachine(from, reply))
  }

  private deliverToMachine(id: string, reply: PermitReply): void {
    const m = this.machines.get(id)
    if (!m || this.now < m.downUntil) return
    if (m.clock.asleep()) {
      const c = m.c
      this.at(m.clock.wakeAt(), () => { if (m.c === c) c.receive(reply) })
      return
    }
    m.c.receive(reply)
  }

  /**
   * Who may act right now. A machine that sleeps runs nothing, so it is not asked (asking would
   * read its clocks in the middle of its sleep, which no real machine does: it would see a
   * wall clock set back during the sleep apart from the sleep itself).
   */
  acting(): string[] {
    return [...this.machines.values()].filter((m) => !m.clock.asleep() && m.c.mayAct()).map((m) => m.key)
  }

  check(): void {
    const who = this.acting()
    const dt = this.now - this.lastCheck
    for (const id of who) this.activeMs.set(id, (this.activeMs.get(id) ?? 0) + dt)
    this.lastCheck = this.now
    const last = this.timeline[this.timeline.length - 1][1]
    if (last.join() !== who.join()) this.timeline.push([this.now, who])
    if (who.length > 1) this.violations.push({ at: this.now, who })
  }

  /** Run every event up to `until`, checking the invariant after each one. */
  run(until: number): void {
    for (;;) {
      if (this.q.length === 0 || this.q[0].at > until) break
      const ev = this.pop()
      // Checking after every event is enough: a machine starts to act only on an event
      // (an answer arriving), and stops by itself between events.
      this.now = ev.at
      ev.run()
      this.check()
    }
    this.now = until
    this.check()
  }
}

export interface PilotOptions {
  /** Ask for the permission whenever it is free. */
  wantsLead: boolean
  /** How often the pilot looks, in ms (renews happen every params.renewEveryMs). */
  tickMs?: number
  /** Look at exactly tickMs, starting at tickMs (no random phase or jitter). */
  exactTicks?: boolean
  /** Called on every tick that it may act; a test can hand over or change witnesses here. */
  onTick?: (m: MachineNode) => void
  /** Chance per tick that a machine with an open handover takes it back. */
  cancelChance?: number
  /** Advance the progress stamp only every fourth renew, so records repeat across restarts. */
  sparseStamps?: boolean
  /** Wait PermitClient.grantDelayMs() and read again before a grant (default true); false asks at once. */
  backoff?: boolean
  /** Send outward ops from world.outbox while it holds the permission (ops.ts). */
  ops?: OpsDriver
}

/**
 * The outward sends of the Walnut: world.outbox lists op ids to send; the holder registers
 * each, sends it once beginSend passes, and reports it. world.sends records every send.
 * `markDoneShare`: the share of sends whose "done" mark reaches the copy a later holder starts
 * from (the rest it does not know about, as with a copy a few minutes behind). A holder that
 * reads from the witnesses that another process sent an op writes that into the data
 * (world.done), as the wiring must (PermitClient.learnedOutcomes), before they drop the entry.
 */
export interface OpsDriver {
  markDoneShare: number
  /** A negative control: send as soon as the registration is proposed, without waiting for a majority. */
  sendUnregistered?: boolean
  /** A negative control: a holder that reads an op as sent does not write it into the data. */
  noRecordSeen?: boolean
}

/**
 * Drives one machine the way the wiring will: renew while it holds the permission, read
 * back when unsure, ask for it when a majority says the old one ran out (after a random
 * back-off), take a handover addressed to it by renewing, and finish a list change left
 * between its steps.
 */
export function pilot(world: World, key: string, opts: PilotOptions): void {
  const tick = opts.tickMs ?? 5_000
  const backoff = opts.backoff ?? true
  let lastRenew = -Infinity
  let asking = false
  let lastLook = -Infinity
  const stamp = (m: MachineNode) => ({ seq: world.writeSeq, writtenAt: opts.sparseStamps ? world.writeSeq : m.clock.wall() })
  const step = (): void => {
    const m = world.machines.get(key)!
    if (world.pilotsStopped) return
    world.after(opts.exactTicks ? tick : tick * (0.8 + 0.4 * world.rand()), step)
    if (m.clock.asleep() || world.now < m.downUntil) return
    const c = m.c
    if (c.isFrozen()) {
      if (opts.cancelChance && world.rand() < opts.cancelChance) c.cancelHandover()
      else if (c.outcome() === 'open') c.retransmit()
      else c.read()
      return
    }
    if (c.mayAct()) {
      // One write sequence for the Walnut: whoever acts continues it.
      if (!opts.sparseStamps || world.rand() < 0.25) world.writeSeq++
      if (world.now - lastRenew >= world.params.renewEveryMs) {
        c.renew(stamp(m))
        lastRenew = world.now
      }
      if (opts.ops) driveOps(world, m, opts.ops)
      // A change between its steps is finished first; now and then look for one left half done.
      const plan = c.changePlan()
      if ((plan.kind === 'final' || plan.kind === 'pair') && world.rand() < 0.5) c.repairChange()
      else opts.onTick?.(m)
      if (c.jointList() || world.now - lastLook >= world.params.renewEveryMs) {
        c.read()
        lastLook = world.now
      }
      return
    }
    const reads = c.readBack()
    const s = c.standing()
    // Renew without a live permission only on a record a majority still holds for this very
    // process (after answers were lost): renewing a minority's record would keep it alive
    // forever and block every grant.
    const mine = reads.filter((r) => r.held?.holder === m.id && r.held.kind !== 'handover' && r.held.nonce === c.incarnation() && !r.grantable).length
    const mineHeld = mine >= Math.floor(c.witnessList().length / 2) + 1
    if ((s && s.kind === 'handover' && s.holder === m.id) || mineHeld) {
      c.renew(stamp(m))
      lastRenew = world.now
    } else if (opts.wantsLead && reads.length > 0 && !asking) {
      const plan = c.changePlan()
      const joint = plan.kind === 'final' || plan.kind === 'pair' ? plan.pair.next : null
      const may = (j: string[] | null) => mayAskForTakeover({
        list: c.witnessList(), cfg: c.config().cfg, joint: j, reads: c.readBack(), standby: { seq: Number.MAX_SAFE_INTEGER },
        params: world.params, maxBehindMs: 5 * 60_000,
      }).ok
      const use = joint && may(joint) ? joint : may(null) ? null : undefined
      if (use !== undefined) {
        const ask = () => {
          lastRenew = world.now
          if (use) c.repairChange()
          else c.requestGrant()
        }
        if (!backoff) ask()
        else {
          // Wait a random while, read again, and ask only if it is still free.
          asking = true
          world.after(c.grantDelayMs(world.rand), () => {
            if (m.c !== c || world.pilotsStopped) { asking = false; return }
            c.read()
            world.after(400, () => {
              asking = false
              if (m.c !== c || c.mayAct() || world.now < m.downUntil || m.clock.asleep()) return
              if (use ? may(use) : may(null)) ask()
            })
          })
        }
      }
    }
    c.read()
  }
  world.after(opts.exactTicks ? tick : world.rand() * tick, step)
}

/** One holder tick of outward sends (OpsDriver). */
function driveOps(world: World, m: MachineNode, d: OpsDriver): void {
  const c = m.c
  // Ops another process sent, as the witnesses report them: this holder writes them into the
  // data (its own sends reach the data by markDoneShare, as before).
  const seenSent = d.noRecordSeen ? null : new Set(c.learnedOutcomes().filter((e) => e.state === 'sent' && e.nonce !== c.incarnation()).map((e) => e.id))
  for (const id of world.outbox) {
    if (world.done.has(id)) continue
    if (seenSent?.has(id)) {
      world.done.add(id)
      continue
    }
    const st = c.opStatus(id)
    if (st === 'unknown') world.unknownSeen.add(id)
    if (st === 'registered' || (d.sendUnregistered && st === 'pending')) {
      const sends = world.sends.get(id) ?? []
      try {
        // The client keeps one process from sending an op twice (beginSend). The control that
        // skips the client keeps that by hand, so only sends across processes count there.
        if (!d.sendUnregistered) c.beginSend(id)
        else if (sends.some((x) => x.nonce === c.incarnation())) continue
        else c.assertMayAct(id)
      } catch {
        continue
      }
      sends.push({ by: m.key, nonce: c.incarnation(), at: world.now })
      world.sends.set(id, sends)
      // The send takes a while; the report goes with the next renew, if this process lives.
      world.after(world.rand() * 3_000, () => {
        if (m.c !== c) return
        c.reportOutcome(id, true)
        if (world.rand() < d.markDoneShare) world.done.add(id)
      })
      continue
    }
    if (st === 'free') {
      try { c.registerOps([id]) } catch { /* not holding: next tick */ }
      return
    }
  }
}

/** When `id` last stopped, and first started, acting within the timeline. */
export function firstStart(world: World, id: string, after = 0): number | null {
  for (const [t, who] of world.timeline) if (t >= after && who.includes(id)) return t
  return null
}
export function lastStop(world: World, id: string): number | null {
  let acting = false
  let stop: number | null = null
  for (const [t, who] of world.timeline) {
    if (acting && !who.includes(id)) stop = t
    acting = who.includes(id)
  }
  return acting ? null : stop
}

/** Look at who may act every `ms` until `until`, so stops between events are seen on time. */
export function sample(world: World, ms: number, until: number): void {
  for (let t = world.now + ms; t <= until; t += ms) world.at(t, () => {})
}
