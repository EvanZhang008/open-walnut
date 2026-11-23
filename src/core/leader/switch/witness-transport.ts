/**
 * How a machine's permit client reaches its witnesses: the PermitTransport behind the one
 * interface the client uses (permit/types.ts). A witness is a directory on this computer
 * (local-witnesses.ts) or the Walnut service of another machine (witness-route.ts), reached
 * over whatever link this process has to that machine.
 *
 * The network half is built for the failures a link has, and relies on the permit core being
 * safe under them (the model check runs the core through THIS code with a link that delays,
 * drops, duplicates and reorders: tests/core/leader/permit/sim.ts):
 *   - a reply comes back on a later tick, never inside send();
 *   - every request has a timeout; a reply after it is dropped, as a lost one;
 *   - a reply counts only when it names the witness asked and the request sent (acceptReply),
 *     so a machine that answers for another witness, or an answer to another record, is no answer;
 *   - a witness with too many requests still open gets no more (a hung link never piles up);
 *   - nothing is retried here: the client retransmits, and a duplicate is a no-op at a witness.
 *
 * Links. The leader server reaches a host's service through its daemon link (`link(host)` then
 * `openStream('follower', 'replica')` and one HTTP request on the stream). A process that
 * is not the leader yet has no such link today: the daemon opens a stream to a host's service
 * only for a server that has spoken for a leader home (providers/daemon-standalone.ts
 * streamTarget), and a host's service follows the OLD leader's data dir path. Until a host-dialed
 * door can carry the call (the C5a door: allowDoorCallPrefix(WITNESS_PREFIX)), such a process
 * reaches only its local witnesses. The seam is addWitnessReach: a door that holds a socket to
 * a host registers a call for that host, and it is tried before the daemon link.
 */
import { DEFAULT_PERMIT_PARAMS, type PermitParams, type PermitReply, type PermitRequest, type PermitTransport } from '../permit/types.js'
import { serveLocalWitness } from './local-witnesses.js'
import { isRemoteWitness, type RemoteWitnessPlace, type WitnessPlace } from './settings.js'
import {
  WITNESS_REQUEST_PATH, WITNESS_SETUP_PATH, acceptReply, type WitnessCall, type WitnessEvidence, type WitnessSetup,
} from './witness-wire.js'

/**
 * The longest a witness is waited for: the renew period. A reply is counted only while its record is
 * the client's open proposal (permit/client.ts receive), and the next renew replaces it 15 s after it
 * was sent, so a reply later than this can no longer help; a request open longer only holds a stream.
 */
export const WITNESS_REQUEST_TIMEOUT_MS = DEFAULT_PERMIT_PARAMS.renewEveryMs
/**
 * Requests open to one witness at once, reads and proposals counted apart (a burst of reads never
 * keeps a renew from going): a proposal is resent every 300 ms for a few seconds, a read comes with each look.
 */
export const WITNESS_MAX_READS_IN_FLIGHT = 4
export const WITNESS_MAX_PROPOSALS_IN_FLIGHT = 16

export interface RemoteCallResult { status: number; body: unknown }
/**
 * One call to a remote witness. `done(null)` is no answer at all (no link, a cut, a timeout in the
 * link). It may call `done` at once or never; the transport has its own timeout. The returned
 * function abandons the call (frees its stream).
 */
export type RemoteCall = (place: RemoteWitnessPlace, path: string, body: WitnessCall | WitnessSetup, done: (r: RemoteCallResult | null) => void) => void | (() => void)

export interface WitnessTransportOptions {
  /** The place of a witness id, or undefined when the list names no such witness (no answer). */
  placeOf(id: string): WitnessPlace | undefined
  params: PermitParams
  /** The reply, handed to PermitClient.receive. */
  deliver(reply: PermitReply): void
  /** This Walnut's id, sent with every call; null: the remote call fills it in (the production call does). */
  walnutId?: string | null
  remote?: RemoteCall
  /** Per request; Infinity: none (model-check runs whose link has its own delays). */
  timeoutMs?: number
  /** Both caps at once (tests); default: WITNESS_MAX_READS_IN_FLIGHT and WITNESS_MAX_PROPOSALS_IN_FLIGHT. */
  maxInFlight?: number
  /** Run `fn` on a later tick (default setImmediate); the simulation passes its own clock. */
  defer?: (fn: () => void) => void
  /** Run `fn` after `ms` and return how to cancel it (default setTimeout). */
  after?: (ms: number, fn: () => void) => () => void
  /** A reply thrown away or a request not sent, for logs and tests. */
  onDrop?: (why: 'invalid-reply' | 'late-reply' | 'too-many-open' | 'no-link' | 'bad-status', data: { witness: string; status?: number }) => void
}

const setImmediateDefer = (fn: () => void): void => { setImmediate(fn) }
const timerAfter = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export function createWitnessTransport(opts: WitnessTransportOptions): PermitTransport {
  const defer = opts.defer ?? setImmediateDefer
  const after = opts.after ?? timerAfter
  const timeoutMs = opts.timeoutMs ?? WITNESS_REQUEST_TIMEOUT_MS
  const open = new Map<string, number>()
  // Each read of a witness gets the next round number, and its answer echoes it. An answer is handed on only if it is newer
  // than the last one handed on for that witness: a reply that overtook a newer one (late over a slow link, or reordered)
  // never takes the state back. An answer to an older read still counts when no newer one came first, so a witness whose
  // round trip is longer than the interval between looks is still heard (its answers are as old as its round trip).
  const readRound = new Map<string, number>()
  const answeredRound = new Map<string, number>()
  const deliver = (reply: PermitReply): void => { defer(() => opts.deliver(reply)) }

  function sendRemote(place: RemoteWitnessPlace, req: PermitRequest): void {
    if (!opts.remote) { opts.onDrop?.('no-link', { witness: place.id }); return }
    const slot = `${place.id}:${req.type}`
    const maxOpen = opts.maxInFlight ?? (req.type === 'read' ? WITNESS_MAX_READS_IN_FLIGHT : WITNESS_MAX_PROPOSALS_IN_FLIGHT)
    const n = open.get(slot) ?? 0
    if (n >= maxOpen) { opts.onDrop?.('too-many-open', { witness: place.id }); return }
    open.set(slot, n + 1)
    let round: number | undefined
    if (req.type === 'read') { round = (readRound.get(place.id) ?? 0) + 1; readRound.set(place.id, round) }
    let settled = false
    let cancelTimer: (() => void) | null = null
    let abandon: (() => void) | void = undefined
    const finish = (r: RemoteCallResult | null, late: boolean): void => {
      if (settled) return
      settled = true
      cancelTimer?.()
      open.set(slot, Math.max(0, (open.get(slot) ?? 1) - 1))
      if (late) { abandon?.(); opts.onDrop?.('late-reply', { witness: place.id }); return }
      if (!r) return
      if (r.status !== 200) { opts.onDrop?.('bad-status', { witness: place.id, status: r.status }); return }
      const reply = acceptReply(r.body, place.id, req, round)
      if (reply && round !== undefined) {
        if (round <= (answeredRound.get(place.id) ?? 0)) { opts.onDrop?.('late-reply', { witness: place.id }); return }
        answeredRound.set(place.id, round)
      }
      if (!reply) { opts.onDrop?.('invalid-reply', { witness: place.id }); return }
      deliver(reply)
    }
    if (Number.isFinite(timeoutMs)) cancelTimer = after(timeoutMs, () => finish(null, true))
    const call: WitnessCall = { v: 1, walnutId: opts.walnutId ?? '', witness: place.id, request: req, ...(round !== undefined ? { round } : {}) }
    abandon = opts.remote(place, WITNESS_REQUEST_PATH, call, (r) => finish(r, false))
    // A call that ended before it returned its handle has nothing left to abandon.
    if (settled) abandon = undefined
  }

  return {
    send(witness, req) {
      const place = opts.placeOf(witness)
      if (!place) return
      if (isRemoteWitness(place)) { sendRemote(place, req); return }
      // A local witness: served here, its answer on a later tick, as a network's would be.
      defer(() => {
        void serveLocalWitness(place, req, opts.params).catch(() => null).then((reply) => { if (reply) opts.deliver(reply) })
      })
    },
  }
}

/** A place lookup over a fixed list. */
export function placesOf(places: readonly WitnessPlace[]): (id: string) => WitnessPlace | undefined {
  const byId = new Map(places.map((p) => [p.id, p]))
  return (id) => byId.get(id)
}

// ---- links to a host's service ----------------------------------------------------------

/** A call to a host's service over a link this process holds, or null when it holds none to that host. */
export type HostCall = (host: string, path: string, body: unknown, timeoutMs: number) => Promise<RemoteCallResult> | null

const reaches: HostCall[] = []

/**
 * Register a way to reach a host that is tried before the daemon link: the host-dialed door of the
 * leader (or of a candidate) holds a socket the host opened, and answers `host-api` calls on it.
 * Returns how to remove it. Nothing registers one until that door exists.
 */
export function addWitnessReach(reach: HostCall): () => void {
  reaches.push(reach)
  return () => { const i = reaches.indexOf(reach); if (i >= 0) reaches.splice(i, 1) }
}

let configModule: Promise<typeof import('../../config-manager.js')> | null = null

/** `host` as the config names it: a `hosts` alias, or else a machine id some connected host reported in its hello. */
export async function resolveWitnessHost(host: string): Promise<string> {
  // One import shared by the calls that arrive together (a read goes to every witness at once).
  const { getConfig } = await (configModule ??= import('../../config-manager.js'))
  const hosts = (await getConfig()).hosts ?? {}
  if (Object.hasOwn(hosts, host)) return host
  const { pooledMachineIdOf } = await import('../../../providers/daemon-connection.js')
  const alias = Object.keys(hosts).find((k) => pooledMachineIdOf(k) === host)
  if (!alias) throw new Error(`witness host ${host} is neither a hosts alias nor the machine id of a connected host`)
  return alias
}

let linkModules: Promise<[typeof import('../../hosts/link.js'), typeof import('../../host-server/request-over.js')]> | null = null

/** Whether this process ever opened a daemon link for a witness call (closeWitnessLinks). */
let daemonLinkOpened = false

/**
 * Close the daemon links this process opened for witness calls, when it did. A server refused the permission goes on as a
 * standby, which must hold no link that describes this Walnut to a host as its leader (boot.ts calls this before that).
 * The permit runtime opens none before it leads, so this is the second line, not the first.
 */
export async function closeWitnessLinks(): Promise<void> {
  if (!daemonLinkOpened) return
  daemonLinkOpened = false
  const { disconnectAllDaemons } = await import('../../../providers/daemon-connection.js')
  disconnectAllDaemons()
}

/** Through the daemon link this server holds to the host: one stream, one request. */
async function overDaemonLink(host: string, path: string, body: unknown, timeoutMs: number, abandoned: { stream: { destroy(): void } | null; cancelled: boolean }): Promise<RemoteCallResult> {
  // One import shared by the calls that arrive together (a read goes to every witness at once).
  const [{ link }, { requestOver }] = await (linkModules ??= Promise.all([import('../../hosts/link.js'), import('../../host-server/request-over.js')]))
  const resolved = await resolveWitnessHost(host)
  daemonLinkOpened = true
  const conn = await link(resolved)
  const stream = await conn.openStream('follower', 'replica')
  abandoned.stream = stream
  if (abandoned.cancelled) { stream.destroy(); throw new Error('abandoned') }
  const res = await requestOver(stream, 'POST', path, Buffer.from(JSON.stringify(body)), timeoutMs)
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * The production RemoteCall: a registered reach first, then (only with `daemonLink`) the pooled daemon
 * link. That link is a full DaemonConnection: connecting it describes this Walnut to the host (slice,
 * leader.configure, the offline drain, triggers), which only the leader server may do, so a process
 * that must never do that (a standby, a reader command) leaves it off and reaches no remote witness
 * until a reach is registered.
 */
export function hostLinkCall(o: { timeoutMs?: number; daemonLink?: boolean | (() => boolean) } = {}): RemoteCall {
  const timeoutMs = o.timeoutMs ?? WITNESS_REQUEST_TIMEOUT_MS
  return (place, path, body, done) => {
    const abandoned: { stream: { destroy(): void } | null; cancelled: boolean } = { stream: null, cancelled: false }
    void (async () => {
      try {
        // The Walnut's id: this server's own (a host's service answers only the Walnut it follows).
        if (!body.walnutId) body = { ...body, walnutId: await (await import('../../device-auth.js')).getInstanceId() }
        for (const reach of reaches) {
          const p = reach(place.host, path, body, timeoutMs)
          if (p) { done(await p); return }
        }
        if (!o.daemonLink) { done(null); return }
        // A function is asked per call: the leader runtime answers true only while it is `leading`.
        if (typeof o.daemonLink === 'function' && !o.daemonLink()) { done(null); return }
        done(await overDaemonLink(place.host, path, body, timeoutMs, abandoned))
      } catch {
        // No link, a cut, a refusal: no answer.
        done(null)
      }
    })()
    return () => { abandoned.cancelled = true; abandoned.stream?.destroy() }
  }
}

/**
 * Set a remote witness up (its record is made once, with the first list). Not part of a permit
 * round: `walnut leader witnesses init` calls it, and a witness that already holds a record answers `made: false`.
 * `evidence`: what the caller saw at each OTHER witness of the list; the witness refuses a setup unless
 * none of them held a record (a witness that lost its disk never starts over beside records that still exist).
 */
export function setUpRemoteWitness(place: RemoteWitnessPlace, list: string[], walnutId: string | null, evidence: WitnessEvidence[], call: RemoteCall = hostLinkCall({ daemonLink: true }), timeoutMs = 30_000): Promise<{ ok: true; made: boolean } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'no answer' }), timeoutMs)
    timer.unref?.()
    const setup: WitnessSetup = { v: 1, walnutId: walnutId ?? '', witness: place.id, list, evidence }
    call(place, WITNESS_SETUP_PATH, setup, (r) => {
      clearTimeout(timer)
      const b = r?.body as { ok?: boolean; made?: boolean; error?: string } | null | undefined
      if (r && r.status === 200 && b?.ok === true && typeof b.made === 'boolean') resolve({ ok: true, made: b.made })
      else resolve({ ok: false, error: r ? `${r.status} ${b?.error ?? 'refused'}` : 'no answer' })
    })
  })
}
