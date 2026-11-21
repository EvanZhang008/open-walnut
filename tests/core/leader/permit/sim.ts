/**
 * A simulated world for the write permission: one real timeline, nodes with their own
 * clocks (rate drift, wall offset and jumps, sleeps that stop the monotonic clock), a
 * network that delays, drops, duplicates and reorders, witnesses that crash and restart
 * from their stored file, and machines whose mayAct() is checked after every event.
 */
import {
  bootstrapWitnessStore, mayAskForTakeover, PermitClient, PermitWitness, createHolderClock, createWitnessClock, decodeStored, encodeStored,
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
  constructor(private readonly world: World, public drift = 0, public wallOffset = 0, public monoOffset = 0) {}
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
export interface MachineNode { id: string; clock: NodeClock; c: PermitClient; pureMonotonic: boolean; downUntil: number }

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
  /** Stops every pilot (a test then reads back a still world). */
  pilotsStopped = false

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

  addWitness(id: string, opts: { drift?: number; offset?: number; store?: SimStore; bootstrap?: string[] } = {}): WitnessNode {
    const store = opts.store ?? new SimStore()
    if (opts.bootstrap) {
      bootstrapWitnessStore(store, opts.bootstrap)
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

  addMachine(id: string, list: string[], opts: { drift?: number; wallOffset?: number; pureMonotonic?: boolean; nonce?: string } = {}): MachineNode {
    const clock = new NodeClock(this, opts.drift ?? 0, opts.wallOffset ?? 0)
    const node = { id, clock, pureMonotonic: !!opts.pureMonotonic, downUntil: 0 } as MachineNode
    node.c = this.newClient(node, list, opts.nonce)
    this.machines.set(id, node)
    this.activeMs.set(id, 0)
    return node
  }

  private newClient(node: MachineNode, list: string[], nonce?: string): PermitClient {
    const clock: ElapsedClock = node.pureMonotonic
      ? createWitnessClock({ monotonic: node.clock.monotonic })
      : createHolderClock({ monotonic: node.clock.monotonic, wall: node.clock.wall })
    return new PermitClient({
      id: node.id, list, clock, params: this.params, ...(nonce ? { nonce } : {}),
      transport: { send: (w, req) => this.send(node.id, w, req) },
    })
  }

  /**
   * The machine restarts: a new client that remembers nothing (as after a process restart).
   * `nonce` (a negative control only) makes it reuse an incarnation.
   */
  restartMachine(id: string, list: string[], downMs: number, nonce?: string): void {
    const n = this.machines.get(id)!
    n.downUntil = this.now + downMs
    n.c = this.newClient(n, list, nonce)
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

  /** Who may act right now. */
  acting(): string[] {
    return [...this.machines.values()].filter((m) => m.c.mayAct()).map((m) => m.id)
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
  /** Called on every tick that it may act; a test can hand over or change witnesses here. */
  onTick?: (m: MachineNode) => void
  /** Chance per tick that a machine with an open handover takes it back. */
  cancelChance?: number
  /** Advance the progress stamp only every fourth renew, so records repeat across restarts. */
  sparseStamps?: boolean
}

/**
 * Drives one machine the way the wiring will: renew while it holds the permission, read
 * back when unsure, ask for it when a majority says the old one ran out, take a
 * handover addressed to it by renewing.
 */
export function pilot(world: World, id: string, opts: PilotOptions): void {
  const tick = opts.tickMs ?? 5_000
  let lastRenew = -Infinity
  let progress = 0
  const step = (): void => {
    const m = world.machines.get(id)!
    if (world.pilotsStopped) return
    world.after(tick * (0.8 + 0.4 * world.rand()), step)
    if (m.clock.asleep() || world.now < m.downUntil) return
    const c = m.c
    if (c.isFrozen()) {
      if (opts.cancelChance && world.rand() < opts.cancelChance) c.cancelHandover()
      else if (c.outcome() === 'open') c.retransmit()
      else c.read()
      return
    }
    if (c.mayAct()) {
      if (!opts.sparseStamps || world.rand() < 0.25) progress++
      if (world.now - lastRenew >= world.params.renewEveryMs) {
        c.renew({ seq: progress, writtenAt: opts.sparseStamps ? progress : m.clock.wall() })
        lastRenew = world.now
      }
      opts.onTick?.(m)
      return
    }
    const reads = c.readBack()
    const s = c.standing()
    // Renew without a live permission only on a record a majority still holds for us (after
    // a restart, or answers lost): renewing a minority's record would keep it alive forever
    // and block every grant.
    const mine = reads.filter((r) => r.held?.holder === id && !r.grantable).length
    const mineHeld = mine >= Math.floor(c.witnessList().length / 2) + 1
    if ((s && s.kind === 'handover' && s.holder === id) || mineHeld) {
      c.renew({ seq: progress, writtenAt: opts.sparseStamps ? progress : m.clock.wall() })
      lastRenew = world.now
    } else if (opts.wantsLead && reads.length > 0) {
      const ans = mayAskForTakeover({
        list: c.witnessList(), cfg: c.config().cfg, reads, standby: { seq: Number.MAX_SAFE_INTEGER },
        params: world.params, maxBehindMs: 5 * 60_000,
      })
      if (ans.ok) {
        c.requestGrant()
        lastRenew = world.now
      }
    }
    c.read()
  }
  world.after(world.rand() * tick, step)
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
