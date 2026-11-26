/**
 * The witness relay (docs/reference/leader-switch.md, "How a witness is reached", way `relay`): a witness's door
 * reached through ANOTHER witness's door, the companion's, by a caller that can dial neither the witness's machine
 * nor its door (a Mac behind NAT as the new leader, at its commit, with the old leader's server stopped).
 *
 *   caller ──https POST <companion door>/relay/challenge|request──▶ companion
 *   companion ──one parked stream──▶ the witness's machine's host service ──▶ its own witness door
 *
 * Nobody dials the witness's machine: its host service PARKS streams at the companion over that machine's own
 * cloud bridge (the daemon's existing follower-to-companion stream, `openStream('companion', WITNESS_RELAY_PURPOSE)`,
 * daemon-standalone.ts streamTarget; no daemon change). Each parked stream starts with one hello line naming the
 * Walnut and the witness it serves, then carries ONE HTTP request the companion writes and the witness's door
 * answers, and closes; the host parks a new one. So the path stands whatever any leader's server does: it is
 * the host's service, the host's daemon and bridge, and the companion.
 *
 * The relay is trusted with nothing. The call is way b's (witness-direct.ts): the caller proves the far witness's
 * own key over a nonce of the far door, bound to this call's digest and the caller's own nonce, and counts a reply
 * only when the far witness proved the same key over it. The companion holds no such key, so whatever it does to
 * the bytes (changes them, replays an old answer, answers itself, drops them) the reply is no reply, never a vote:
 * the caller sees `bad_witness_proof` or nothing. A relay that has no parked stream for the witness answers
 * 503 `no_relay` (not reached), never NO_WITNESS_HERE_CODE: a setup's evidence never counts a witness absent from
 * what the relay says.
 *
 * Callback-free on purpose where it can be: the hub is driven by streams and timers; the model check reaches the
 * relay as way b with another url (the proofs are the same code).
 */
import fs from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { requestOver } from '../../host-server/request-over.js'
import { log } from '../../../logging/index.js'
import { callerBrake, machineWitnessDoor, readDoorBody, serveDoorHttp, type DoorResponse, type WitnessDoor } from './witness-door.js'
import { witnessRoot } from './machine-id.js'
import { readWitnessKey, witnessDir } from './witness-route.js'
import { NO_RELAY_CODE, WITNESS_DOOR_CHALLENGE, WITNESS_DOOR_PATH, WITNESS_DOOR_REQUEST, parseDoorChallenge, parseDoorRequest } from './witness-wire.js'

export { NO_RELAY_CODE, WITNESS_RELAY_SUB } from './witness-wire.js'

export { WITNESS_RELAY_PURPOSE } from '../../../lib/leader-relay-names.js'

/** The longest a hello line may be, and how long it may take. */
const HELLO_MAX = 1024
const HELLO_WAIT_MS = 5_000
/** A parked stream is closed after this (the host parks a fresh one): a stream a cut left half open never waits for good. */
export const PARK_MAX_MS = 50_000
/**
 * Parked streams kept per witness from one host (the bridge's host alias, the link's identity), and in all; past them
 * the newest is refused. Per host: a host of this Walnut that parks under another machine's witness id (its streams
 * answer without that witness's proof, so they count for nothing) cannot crowd that machine's own streams out.
 */
export const PARKED_PER_WITNESS = 8
export const PARKED_TOTAL = 256
/** How long a call waits for a parked stream when none is there (the host parks the next within a moment). */
export const TAKE_WAIT_MS = 3_000
/** One relayed post's bound: under the transport's 15 s per call, which holds two posts. */
export const RELAY_POST_TIMEOUT_MS = 6_000
/** Relayed posts one caller may send in one window (the door's own brake counts the relay as one caller). */
export const RELAY_PER_CALLER = 256
export const RELAY_WINDOW_MS = 10_000

const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export interface RelayHello { v: 1; walnutId: string; witness: string }

export function parseRelayHello(line: string): RelayHello | null {
  let o: unknown
  try { o = JSON.parse(line) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (r.v !== 1 || typeof r.walnutId !== 'string' || typeof r.witness !== 'string' || !ID_RE.test(r.walnutId) || !ID_RE.test(r.witness)) return null
  return { v: 1, walnutId: r.walnutId, witness: r.witness }
}

const keyOf = (walnutId: string, witness: string) => `${walnutId}\n${witness}`

interface Parked { stream: Duplex; from: string; timer: ReturnType<typeof setTimeout> }

export interface RelayHub {
  /** A stream a host parked (`from`: who it came from, the bridge's host alias, for logs). Reads its hello, then keeps it. */
  park(from: string, stream: Duplex): void
  /** One door post to that witness over a parked stream: its status and JSON, or null when no stream was there in time or it broke. */
  post(walnutId: string, witness: string, sub: string, body: unknown, timeoutMs?: number): Promise<{ status: number; json: unknown } | null>
  /** Streams parked for that witness now. */
  parked(walnutId: string, witness: string): number
  close(): void
}

export function createRelayHub(o: { parkMaxMs?: number; takeWaitMs?: number; log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void } = {}): RelayHub {
  const parkMaxMs = o.parkMaxMs ?? PARK_MAX_MS
  const takeWaitMs = o.takeWaitMs ?? TAKE_WAIT_MS
  const byWitness = new Map<string, Parked[]>()
  const waiters = new Map<string, Array<() => void>>()
  let total = 0
  let closed = false
  /** Per witness, the hosts it was parked by, once more than one (said once each time the set grows). */
  const parkers = new Map<string, Set<string>>()

  const drop = (key: string, p: Parked): boolean => {
    const list = byWitness.get(key)
    const i = list?.indexOf(p) ?? -1
    if (!list || i < 0) return false
    list.splice(i, 1)
    if (!list.length) byWitness.delete(key)
    total--
    clearTimeout(p.timer)
    return true
  }

  const keep = (key: string, stream: Duplex, from: string): void => {
    const list = byWitness.get(key) ?? []
    if (closed || list.filter((x) => x.from === from).length >= PARKED_PER_WITNESS || total >= PARKED_TOTAL) { stream.destroy(); return }
    const by = parkers.get(key) ?? new Set<string>()
    if (!by.has(from)) {
      by.add(from)
      parkers.set(key, by)
      // A witness is kept by one machine: two hosts parking for it is a misconfiguration or a host answering for another.
      if (by.size > 1) o.log?.('warn', 'witness relay: more than one host parks for one witness', { witness: key.split('\n')[1], hosts: [...by] })
    }
    const p: Parked = { stream, from, timer: setTimeout(() => { if (drop(key, p)) stream.destroy() }, parkMaxMs) }
    p.timer.unref?.()
    list.push(p)
    byWitness.set(key, list)
    total++
    stream.once('close', () => { drop(key, p) })
    const w = waiters.get(key)
    if (w?.length) w.shift()!()
  }

  const take = (key: string): Promise<Parked | null> => {
    const now = (): Parked | null => {
      const list = byWitness.get(key)
      // The newest first: the one least likely to have gone quiet.
      const p = list?.at(-1)
      if (!p) return null
      drop(key, p)
      return p
    }
    const p = now()
    if (p || takeWaitMs <= 0) return Promise.resolve(p)
    return new Promise((resolve) => {
      const list = waiters.get(key) ?? []
      let done = false
      const wake = (): void => { if (done) return; done = true; clearTimeout(timer); resolve(now()) }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        const l = waiters.get(key)
        const i = l?.indexOf(wake) ?? -1
        if (l && i >= 0) l.splice(i, 1)
        resolve(null)
      }, takeWaitMs)
      timer.unref?.()
      list.push(wake)
      waiters.set(key, list)
    })
  }

  return {
    park(from, stream) {
      stream.on('error', () => { /* the host went */ })
      if (closed) { stream.destroy(); return }
      let got = ''
      const timer = setTimeout(() => { cleanup(); stream.destroy() }, HELLO_WAIT_MS)
      timer.unref?.()
      const cleanup = (): void => { clearTimeout(timer); stream.off('data', onData) }
      const onData = (chunk: Buffer): void => {
        got += chunk.toString('utf8')
        const nl = got.indexOf('\n')
        if (nl < 0) { if (got.length > HELLO_MAX) { cleanup(); stream.destroy() } return }
        cleanup()
        // Nothing is read until a call writes its request: the host sends nothing after its hello.
        stream.pause()
        const hello = nl <= HELLO_MAX ? parseRelayHello(got.slice(0, nl)) : null
        if (!hello || got.length > nl + 1) { stream.destroy(); return }
        keep(keyOf(hello.walnutId, hello.witness), stream, from)
      }
      stream.on('data', onData)
    },
    async post(walnutId, witness, sub, body, timeoutMs = RELAY_POST_TIMEOUT_MS) {
      if (sub !== WITNESS_DOOR_CHALLENGE && sub !== WITNESS_DOOR_REQUEST) return null
      const p = await take(keyOf(walnutId, witness))
      if (!p) return null
      p.stream.resume()
      try {
        const res = await requestOver(p.stream, 'POST', `${WITNESS_DOOR_PATH}${sub}`, Buffer.from(JSON.stringify(body)), timeoutMs)
        return { status: res.status, json: await res.json().catch(() => null) }
      } catch {
        return null
      } finally {
        p.stream.destroy()
      }
    },
    parked: (walnutId, witness) => byWitness.get(keyOf(walnutId, witness))?.length ?? 0,
    close() {
      closed = true
      for (const [key, list] of [...byWitness]) for (const p of [...list]) { drop(key, p); p.stream.destroy() }
      for (const list of waiters.values()) for (const w of [...list]) w()
      waiters.clear()
    },
  }
}

let shared: RelayHub | null = null
/** This server's hub (the companion's bridge registry parks into it, its door posts through it). */
export function relayHub(): RelayHub {
  return (shared ??= createRelayHub({ log: (level, msg, data) => log.web[level](msg, data) }))
}

/** Tests only. */
export function _resetRelayHub(): void { shared?.close(); shared = null }

/**
 * The relay's two paths on a door (`sub` under WITNESS_RELAY_SUB: '/challenge' or '/request'): the body read as the
 * door reads it (capped, JSON), checked to be a door call (it names its Walnut and witness), sent on over one parked
 * stream, and that door's answer passed back as it came (status and JSON). The relay checks no proof: it holds no
 * key. Returns false (nothing written) for any other method or path.
 */
export function serveRelayHttp(hub: RelayHub, sub: string, req: IncomingMessage, res: ServerResponse, from: string, brake = defaultBrake()): boolean {
  return readDoorBody(sub, req, res, (body, send) => {
    const call = sub === WITNESS_DOOR_CHALLENGE ? parseDoorChallenge(body) : parseDoorRequest(body)
    if (!call) { send({ status: 400, body: { ok: false, error: 'bad_request' } }); return }
    if (!brake(from, performance.now())) { send({ status: 429, body: { ok: false, error: 'too_many_requests' } }); return }
    void hub.post(call.walnutId, call.witness, sub, body).then((r) => {
      if (!r) { send({ status: 503, body: { ok: false, error: NO_RELAY_CODE } }); return }
      // Passed on as it came: the caller judges it by the far witness's proof alone.
      send({ status: r.status, body: (r.json && typeof r.json === 'object' ? r.json : { ok: false, error: 'bad_relay_answer' }) as DoorResponse['body'] })
    })
  })
}

let sharedBrake: ((from: string, t: number) => boolean) | null = null
function defaultBrake(): (from: string, t: number) => boolean {
  return (sharedBrake ??= callerBrake(RELAY_PER_CALLER, RELAY_WINDOW_MS))
}

// ---- the host's half: parked streams ---------------------------------------------------------------------------

export interface RelayParkerDeps {
  /** One stream to the companion over this machine's bridge (the host service's follower link). */
  open(): Promise<Duplex>
  walnutId: string
  /** The witnesses of this Walnut this machine keeps with a key now (read again every few seconds). */
  witnesses(): string[]
  /** This machine's witness door (witness-door.ts machineWitnessDoor over its witness root). */
  door: WitnessDoor
  /** Streams kept parked per witness (default 2). */
  perWitness?: number
  /** Delay before try `attempt` after a failure (default 1 s doubling to 30 s). */
  backoffMs?(attempt: number): number
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export interface RelayParker { stop(): void; parked(): number }

/** How often the parker looks again at which witnesses this machine keeps. */
const PARKER_LOOK_MS = 5_000

/**
 * Keep `perWitness` streams parked at the companion for each witness this machine keeps: each one opened, its hello
 * written, then served as an HTTP connection by this machine's own witness door (serveDoorHttp, the one every server
 * answers the door with); once it closed (a call answered, the companion's park time, a cut) the next one is parked.
 */
export function startWitnessRelayParker(d: RelayParkerDeps): RelayParker {
  const per = d.perWitness ?? 2
  const backoff = d.backoffMs ?? ((n: number) => Math.min(30_000, 1_000 * 2 ** Math.max(0, n - 1)))
  let stopped = false
  const open = new Set<Duplex>()
  const slots = new Map<string, number>()
  const failures = new Map<string, number>()
  const server = http.createServer((req, res) => {
    const url = req.url ?? ''
    const sub = url.startsWith(`${WITNESS_DOOR_PATH}/`) ? url.slice(WITNESS_DOOR_PATH.length) : ''
    res.setHeader('connection', 'close')
    if (!serveDoorHttp(d.door, sub, req, res, 'relay')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not_found' })) }
  })
  server.on('clientError', (_err, socket) => { try { socket.destroy() } catch { /* gone */ } })
  let warned = ''

  const fill = (witness: string): void => {
    while (!stopped && (slots.get(witness) ?? 0) < per) {
      slots.set(witness, (slots.get(witness) ?? 0) + 1)
      void parkOne(witness)
    }
  }

  const parkOne = async (witness: string): Promise<void> => {
    const release = (failed: boolean): void => {
      slots.set(witness, Math.max(0, (slots.get(witness) ?? 1) - 1))
      if (stopped) return
      const n = failed ? (failures.get(witness) ?? 0) + 1 : 0
      failures.set(witness, n)
      const t = setTimeout(() => { if (d.witnesses().includes(witness)) fill(witness) }, failed ? backoff(n) : 50)
      t.unref?.()
    }
    let stream: Duplex
    try {
      stream = await d.open()
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (why !== warned) { warned = why; d.log?.('info', 'witness relay: no stream to the companion', { witness, error: why }) }
      release(true)
      return
    }
    if (stopped) { stream.destroy(); release(false); return }
    warned = ''
    open.add(stream)
    const at = Date.now()
    let served = false
    stream.on('error', () => { /* the companion went */ })
    stream.once('close', () => {
      open.delete(stream)
      // Closed within a second having served nothing: the companion refused it (no relay there, too many parked). Back off.
      release(!served && Date.now() - at < 1_000)
    })
    stream.write(`${JSON.stringify({ v: 1, walnutId: d.walnutId, witness } satisfies RelayHello)}\n`)
    stream.once('data', () => { served = true })
    server.emit('connection', stream)
  }

  const look = (): void => { if (!stopped) for (const w of d.witnesses()) fill(w) }
  look()
  const timer = setInterval(look, PARKER_LOOK_MS)
  timer.unref?.()
  return {
    stop() {
      stopped = true
      clearInterval(timer)
      for (const s of open) s.destroy()
      open.clear()
      server.close()
    },
    parked: () => open.size,
  }
}

/**
 * The host service's parker (replica/front.ts): this machine's witness door over its witness root (machine-id.ts
 * witnessRoot), and the witnesses of `walnutId` it keeps with a key there (one per Walnut per machine).
 */
export function startHostWitnessRelay(o: { walnutId: string; open: RelayParkerDeps['open']; log?: RelayParkerDeps['log']; root?: string }): RelayParker {
  const root = o.root ?? witnessRoot()
  const door = machineWitnessDoor({ root, ...(o.log ? { log: (level: 'warn', msg: string, data?: Record<string, unknown>) => o.log!(level, msg, data) } : {}) })
  return startWitnessRelayParker({
    open: o.open, walnutId: o.walnutId, door, ...(o.log ? { log: o.log } : {}),
    witnesses: () => keyedWitnesses(root, o.walnutId),
  })
}

/** The witnesses of `walnutId` this machine keeps with a key (their dirs under the witness root). */
export function keyedWitnesses(root: string, walnutId: string): string[] {
  let names: string[] = []
  try { names = fs.readdirSync(path.join(root, walnutId)).filter((n) => !n.startsWith('.')) } catch { return [] }
  return names.filter((n) => ID_RE.test(n) && readWitnessKey(witnessDir(root, walnutId, n)) !== null)
}
