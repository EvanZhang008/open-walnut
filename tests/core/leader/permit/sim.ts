/**
 * A simulated world for the write permission: one real timeline, nodes with their own
 * clocks (rate drift, wall offset and jumps, sleeps that stop the monotonic clock), a
 * network that delays, drops, duplicates and reorders, witnesses that crash and restart
 * from their stored file, and machines whose mayAct() is checked after every event.
 *
 * Every machine reaches its witnesses through the REAL network transport
 * (src/core/leader/switch/witness-transport.ts): timeouts, reply checks, the later tick, the
 * JSON wire. Only the link under it is the simulation's: a RemoteCall that sends the request and
 * the reply through World.transmit (delay, drop, duplicate, reorder, cuts). A test replaces it
 * with `world.makeLink` to break the link in a way of its own.
 *
 * `world.way = 'direct'` reaches every witness by its direct door instead (way b: the real caller,
 * witness-direct.ts, and the real door, witness-door.ts, each witness with its own key): a request
 * is then a challenge and the keyed call, each crossing the network both ways, the nonce timed on
 * the witness's own clock.
 */
import {
  createWitnessTransport, type RemoteCall, type RemoteCallResult,
} from '../../../../src/core/leader/switch/witness-transport.js'
import type { WitnessCall } from '../../../../src/core/leader/switch/witness-wire.js'
import { createWitnessDoor, type WitnessDoor } from '../../../../src/core/leader/switch/witness-door.js'
import { directWitnessCall, type DoorPost } from '../../../../src/core/leader/switch/witness-direct.js'
import { sha256Hex } from '../../../../src/utils/hmac-proof.js'
import {
  bootstrapWitnessStore, prepareJoiningWitness, mayAskForTakeover, PermitClient, PermitWitness, createHolderClock, createWitnessClock, decodeStored, encodeStored,
  type ElapsedClock, type PermitParams, type PermitRecord, type PermitReply, type PermitRequest, type PermitStore, type StoredWitness,
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
  violations: Array<{ at: number; who: string[]; leases?: string[] }> = []
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
  /** Planned stops (plannedStop): when each released, when it saw its release stand, when it exited. */
  releases: Array<{ key: string; at: number; record: PermitRecord | null; reach: string[] | null; stoodAt: number | null; exitAt: number | null }> = []
  /** A release (by its writer's incarnation) reaches only these witnesses: the rest are unreachable for it. */
  private releaseReach = new Map<string, Set<string>>()
  /** Called with every new process (addMachine, restartMachine): a negative control patches its client here. */
  onNewClient: ((m: MachineNode) => void) | null = null
  /** Called with every witness start (addWitness, a restart): a negative control patches it here. */
  onNewWitness: ((n: WitnessNode) => void) | null = null
  /** Per request timeout of the transport (Infinity: none, as a link whose only fault is its own delays). Set before addMachine. */
  transportTimeoutMs = Infinity
  /** Open requests per witness the transport allows (Infinity: the model check's lost messages never time out, so they would use the slots up). */
  transportMaxInFlight: number | undefined = Infinity
  /** Replace the link under the transport (set before addMachine); `base` is the simulated one. */
  makeLink: ((from: string, base: RemoteCall) => RemoteCall) | null = null
  /** Replace what the transport hands the client (set before addMachine): a broken transport for a negative control. `base` delivers to the client. */
  wrapDeliver: ((from: string, base: (reply: PermitReply) => void) => (reply: PermitReply) => void) | null = null
  /** Faults a negative control injected below or above the transport (wrapDeliver). */
  injected = 0
  /** What the transport threw away, by reason. */
  drops: Record<string, number> = {}
  /** How machines reach the witnesses: over a link (way c) or by each witness's direct door (way b). Set before addMachine. */
  way: 'link' | 'direct' | 'mixed' = 'link'
  /** Each witness's direct door (way b), made at its first call; its nonces outlive a witness restart only as a real door's would not (a restart forgets them: see startWitness). */
  private doors = new Map<string, WitnessDoor>()

  /**
   * Mixed clocks (set before addMachine): the params of process `key`, else `params`. With it set,
   * every witness is a record on one computer opened by whichever process asks (a witness dir,
   * local-witnesses.ts): each process judges with its own params, and reads the record again, as
   * accepted at that read, whenever another process changed it since its last call.
   */
  paramsOf: ((key: string) => PermitParams) | null = null
  /** Mixed clocks: each process's view of each witness record, with the record text it last saw. */
  private views = new Map<string, { w: PermitWitness; text: string | null }>()

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
    // A restarted service starts with no nonce issued.
    this.doors.delete(n.id)
    this.onNewWitness?.(n)
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
    this.onNewClient?.(node)
    return node
  }

  private newClient(node: MachineNode, list: string[], nonce?: string, cfg?: string, epoch?: number): PermitClient {
    const clock: ElapsedClock = node.pureMonotonic
      ? createWitnessClock({ monotonic: node.clock.monotonic })
      : createHolderClock({ monotonic: node.clock.monotonic, wall: node.clock.wall, ...(node.bootClock ? { boot: { kind: 'boottime' as const, now: node.clock.boot } } : {}) })
    const params = this.paramsOf?.(node.key) ?? this.params
    return new PermitClient({
      id: node.id, list, clock, params, ...(nonce ? { testNonce: nonce } : {}), ...(cfg ? { cfg } : {}), ...(epoch !== undefined ? { epoch } : {}),
      transport: createWitnessTransport({
        placeOf: (id) => (this.way === 'direct' ? { id, url: `https://sim/${id}`, key: simWitnessKey(id) } : this.way === 'mixed' ? { id, host: id, url: `https://sim/${id}`, key: simWitnessKey(id) } : { id, host: id }), params, walnutId: 'sim',
        deliver: this.wrapDeliver ? this.wrapDeliver(node.key, (reply) => this.deliverToMachine(node.key, reply)) : (reply) => this.deliverToMachine(node.key, reply),
        remote: this.makeLink ? this.makeLink(node.key, this.simLink(node.key)) : this.way === 'mixed' ? this.simMixed(node.key) : this.simLink(node.key),
        direct: this.makeLink ? this.makeLink(node.key, this.simDirect(node.key)) : this.simDirect(node.key),
        timeoutMs: this.transportTimeoutMs, ...(this.transportMaxInFlight !== undefined ? { maxInFlight: this.transportMaxInFlight } : {}),
        defer: (fn) => this.after(0, fn),
        after: (ms, fn) => { let live = true; this.after(ms, () => { if (live) fn() }); return () => { live = false } },
        onDrop: (why) => { this.drops[why] = (this.drops[why] ?? 0) + 1 },
      }),
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
    this.onNewClient?.(n)
  }

  /**
   * A planned stop (a deploy) of process `key`, as the wiring does it: release() (it stops acting
   * at once), resend it every 300 ms to the witnesses that have not taken it, and exit once it
   * stood or after `capMs` (3 s), whichever comes first; the next process of the machine starts
   * `downMs` after the exit. `reach`: the only witnesses the release gets to (the others are
   * unreachable for it), to model a release that reaches a minority.
   */
  plannedStop(key: string, list: string[], o: { capMs?: number; downMs?: number; reach?: string[] | null; keepConfig?: boolean } = {}): void {
    const m = this.machines.get(key)!
    const c = m.c
    if (o.reach) this.releaseReach.set(c.incarnation(), new Set(o.reach))
    const record = c.release()
    const entry = { key, at: this.now, record, reach: o.reach ?? null, stoodAt: null as number | null, exitAt: null as number | null }
    this.releases.push(entry)
    const exit = (): void => {
      entry.exitAt = this.now
      this.restartMachine(key, list, o.downMs ?? 500, undefined, o.keepConfig)
    }
    if (!record) return exit()
    const cap = this.now + (o.capMs ?? 3_000)
    let lastSend = this.now
    const look = (): void => {
      if (m.c !== c) return
      if (c.released() === 'stood') {
        entry.stoodAt = this.now
        return exit()
      }
      if (this.now >= cap || c.outcome() === 'short') return exit()
      if (this.now - lastSend >= 300) {
        c.release()
        lastSend = this.now
      }
      this.after(20, look)
    }
    this.after(20, look)
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

  /** The simulated link of process `from`: the request and the reply each cross the network (World.transmit), as JSON. */
  simLink(from: string): RemoteCall {
    return (place, _path, body, done) => {
      const to = place.id
      const req = JSON.parse(JSON.stringify((body as WitnessCall).request)) as PermitRequest
      if (req.type === 'propose' && req.record.kind === 'release' && this.releaseReach.get(req.record.nonce)?.has(to) === false) return
      const round = (body as WitnessCall).round
      this.transmit(from, to, req, () => this.deliverToWitness(from, to, req, done, round))
    }
  }

  /**
   * Both ways at once (`way = 'mixed'`): each request to a witness goes by its link or by its door, at random,
   * besides the transport's own turn to the next way after one that did not answer. One record, two doors.
   */
  simMixed(from: string): RemoteCall {
    const link = this.simLink(from)
    const direct = this.simDirect(from)
    return (place, path, body, done) => (this.rand() < 0.5 ? link : direct)(place, path, body, done)
  }

  /**
   * The direct way of process `from` (way b): the real caller over posts that cross the simulated
   * network, each to the witness's real door. What a message carries, for `intercept`, is the
   * permit request inside it (both of its posts) and the reply (the call's answer).
   */
  simDirect(from: string): RemoteCall {
    return (place, path, body, done) => {
      const req = JSON.parse(JSON.stringify((body as WitnessCall).request)) as PermitRequest
      const to = place.id
      if (req.type === 'propose' && req.record.kind === 'release' && this.releaseReach.get(req.record.nonce)?.has(to) === false) return
      const post: DoorPost = (url, b, answered) => {
        const step = url.slice(url.lastIndexOf('/') + 1)
        this.transmit(from, to, req, () => {
          const n = this.witnesses.get(to)
          if (!n || !n.w || n.clock.asleep()) return
          const door = this.doorOf(n)
          const back = (r: { status: number; body: unknown }, msg: PermitRequest | PermitReply): void => {
            const wire = JSON.parse(JSON.stringify(r.body)) as unknown
            this.transmit(to, from, msg, () => answered({ status: r.status, json: wire }))
          }
          if (step === 'challenge') back(door.challenge(b), req)
          else door.request(b, (r) => back(r, r.status === 200 ? JSON.parse((r.body as { reply: string }).reply) as PermitReply : req))
        })
      }
      return directWitnessCall({ post })(place, path, body, done)
    }
  }

  private doorOf(n: WitnessNode): WitnessDoor {
    let door = this.doors.get(n.id)
    if (!door) {
      door = createWitnessDoor({
        keyOf: (walnutId, witness) => (walnutId === 'sim' && witness === n.id ? simWitnessKey(n.id) : null),
        serve: (_walnutId, witness, req, done) => {
          const reply = this.answerAtWitness(witness, req)
          if (reply) done(reply)
        },
        now: () => n.clock.monotonic(),
      })
      this.doors.set(n.id, door)
    }
    return door
  }

  /** The witness takes the request; its reply, or null when it gives none (down, asleep, or it crashed before answering). */
  private answerAtWitness(to: string, req: PermitRequest, from?: string): PermitReply | null {
    const n = this.witnesses.get(to)
    if (!n || !n.w || n.clock.asleep()) return null
    const reply = this.paramsOf && from ? this.viewOf(n, from).handle(req) : n.w.handle(req)
    if (this.paramsOf && from) this.views.get(`${n.id}|${from}`)!.text = n.store.disk
    if (this.trace && req.type === 'propose' && reply.ok) {
      const r = req.record
      this.trace.push(`${(this.now / 1000).toFixed(3)} ${to} took #${r.number} ${r.kind} by ${r.by} -> ${r.holder} list=${r.list.join(',')}${r.joint ? ' pair=' + r.joint.join(',') : ''}${r.stage ? ' ' + r.stage : ''}`)
    }
    if (this.crashBeforeAnswer?.(to, req, reply)) {
      this.crashWitness(to, 1_000 + this.rand() * 10_000)
      return null
    }
    return reply
  }

  /** Mixed clocks: process `from`'s view of witness `n`, read again when another process changed the record. */
  private viewOf(n: WitnessNode, from: string): PermitWitness {
    const key = `${n.id}|${from}`
    let v = this.views.get(key)
    if (!v || v.text !== n.store.disk) {
      v = { w: new PermitWitness({ id: n.id, store: n.store, clock: createWitnessClock({ monotonic: n.clock.monotonic }), params: this.paramsOf!(from) }), text: n.store.disk }
      this.views.set(key, v)
    }
    return v.w
  }

  /** Called with the reply about to go out; return true to crash the witness instead of answering. */
  crashBeforeAnswer: ((witness: string, req: PermitRequest, reply: PermitReply) => boolean) | null = null

  private deliverToWitness(from: string, to: string, req: PermitRequest, done: (r: RemoteCallResult | null) => void, round?: number): void {
    const reply = this.answerAtWitness(to, req, from)
    if (!reply) return
    const wire = JSON.parse(JSON.stringify({ ok: true, reply, ...(round !== undefined ? { round } : {}) })) as unknown
    this.transmit(to, from, reply, () => done({ status: 200, body: wire }))
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
    if (who.length > 1) {
      // What each acting machine stands on (for reading a violating schedule's trace).
      const leases = who.map((k) => {
        const nodeClock = this.machines.get(k)!.clock
        const c = this.machines.get(k)!.c as unknown as { lease: { record: PermitRecord; until: number } | null; opts: { clock: ElapsedClock } }
        const l = c.lease
        return `${k}: #${l?.record.number} ${l?.record.kind} by ${l?.record.by}/${l?.record.nonce} until ${Math.round(l?.until ?? 0)}, clock ${Math.round(c.opts.clock.now())}, left ${Math.round((l?.until ?? 0) - c.opts.clock.now())}, sleeps ${JSON.stringify(nodeClock.sleeps.map(([a, b]) => [Math.round(a), Math.round(b)]))}, wall jumps ${JSON.stringify(nodeClock.wallJumps.map(([a, b]) => [Math.round(a), Math.round(b)]))}, drift ${nodeClock.drift}`
      })
      this.violations.push({ at: this.now, who, leases })
    }
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
    // A process in its planned stop does nothing more (World.plannedStop drives its release).
    if (c.released()) return
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

/**
 * Negative control (a): the releaser keeps acting until it sees its release stand, instead of
 * stopping before it sends it.
 */
export function actUntilReleaseStood(c: PermitClient): void {
  const x = c as unknown as { releasing: boolean; remainingMs: () => number }
  const orig = x.remainingMs.bind(c)
  x.remainingMs = () => {
    const was = x.releasing
    x.releasing = false
    try { return orig() } finally { x.releasing = was }
  }
}

/**
 * Negative control: a witness that takes a release on any live record, whoever holds it (the
 * rule takes it only on the writer's own record, same incarnation). A process whose lease ran
 * out on its clock but was never cleared then frees the witnesses that hold the next holder's
 * grant, and a third machine is granted beside it.
 */
export function releaseOnAnyLive(w: PermitWitness): void {
  const x = w as unknown as { state: { held: PermitRecord | null }; handle: (req: PermitRequest) => PermitReply }
  const handle = x.handle.bind(w)
  x.handle = (req) => {
    const real = x.state.held
    if (req.type !== 'propose' || req.record.kind !== 'release' || !real || real.kind === 'release') return handle(req)
    // Judge it as if the live record were the writer's own; on a refusal, judge it again as it is.
    x.state = { ...x.state, held: { ...real, kind: 'renew', holder: req.record.by, by: req.record.by, nonce: req.record.nonce } }
    const reply = handle(req)
    if (reply.ok) return reply
    x.state = { ...x.state, held: real }
    return handle(req)
  }
}

/**
 * Negative control (b): a new process takes the permission on a release of its machine seen at
 * a minority. It counts a grant of its own as chosen once every witness that showed it that
 * release took it ("the others have not heard the release yet"), not only with a majority. Its
 * renews still need a majority, so the bug is in taking it, not in keeping it.
 */
export function takeOnMinorityRelease(c: PermitClient): void {
  const x = c as unknown as { chosen: (p: { acks: Set<string>; record: PermitRecord }) => boolean; receive: (r: PermitReply) => void }
  const showed = new Set<string>()
  const chosen = x.chosen.bind(c)
  const receive = x.receive.bind(c)
  x.receive = (r) => {
    if (r.held?.kind === 'release' && r.held.from === c.id && r.held.nonce !== c.incarnation()) showed.add(r.witness)
    receive(r)
  }
  x.chosen = (p) => chosen(p) || (p.record.kind === 'grant' && showed.size > 0 && [...showed].every((w) => p.acks.has(w)))
}

/** Each simulated witness's own key (the direct way): fixed per id, as a minted one is for the witness's life. */
export function simWitnessKey(id: string): string {
  return sha256Hex(`walnut-sim-witness-key:${id}`)
}
