/**
 * Asynchronous steps over the event-driven permit client (permit/client.ts): read the
 * witnesses, propose a record and wait for its outcome. The server's runtime proposes; the
 * switch command only reads (the witnesses take a record only from the process that holds).
 */
import { createHolderClock } from '../permit/clock.js'
import { PermitClient } from '../permit/client.js'
import type { PermitParams, PermitRecord, PermitReply } from '../permit/types.js'
import { createWitnessTransport, hostLinkCall, placesOf, thisWalnutId, type HereMachine, type WitnessTransportOptions } from './witness-transport.js'
import { directWitnessCall } from './witness-direct.js'
import { NO_WITNESS_HERE_CODE } from './witness-wire.js'
import { permitHolderId, witnessRoot } from './machine-id.js'
import type { WitnessPlace } from './settings.js'

export interface PermitHandle {
  client: PermitClient
  places: WitnessPlace[]
  /**
   * Take new ways to the same witnesses (a key `walnut leader witnesses init` minted, a url added):
   * the ids must be the same list in the same order (the list is FIXED; a change is a members record).
   */
  setPlaces(places: WitnessPlace[]): boolean
  /** The witnesses that, since `t` (Date.now()), were reached and said they hold nothing of a witness (NO_WITNESS_HERE_CODE). */
  absentSince(t: number): string[]
}

/** This process's own machine for way a: its id, its witness root, the Walnut's id (machine-id.ts, device-auth.ts). */
export function thisMachine(env: NodeJS.ProcessEnv = process.env, walnutId?: string): HereMachine {
  return { machineId: permitHolderId(env), root: witnessRoot(env), walnutId: walnutId ? () => walnutId : thisWalnutId }
}

/** thisMachine(), read at its first use. */
function lazyMachine(): HereMachine {
  let m: HereMachine | null = null
  const get = (): HereMachine => (m ??= thisMachine())
  return { get machineId() { return get().machineId }, get root() { return get().root }, walnutId: () => get().walnutId() }
}

/**
 * `guard`: false stops acting at once (the instance lock's held()). `net`: how remote witnesses
 * are reached (witness-transport.ts). Ways a (a witness this machine keeps) and b (a direct door)
 * by default; way c only through a registered reach (the host-dialed door), and `daemonLink` (true,
 * or a function asked per call) adds the pooled daemon link to the host, which describes this Walnut to that host (host.slice,
 * leader.configure, the offline drain) and so is for the leader server alone, never a standby, a
 * reader command or a trial start.
 */
export function openPermitClient(id: string, places: WitnessPlace[], params: PermitParams, guard?: () => boolean, net: Partial<WitnessTransportOptions> & { daemonLink?: boolean | (() => boolean) } = {}): PermitHandle {
  const { daemonLink, ...transportOpts } = net
  let client: PermitClient | null = null
  let lookup = placesOf(places)
  const absentAt = new Map<string, number>()
  const transport = createWitnessTransport({
    placeOf: (wid) => lookup(wid), params, deliver: (reply: PermitReply) => client?.receive(reply),
    // Every way is there; which one a request takes is chosen per request from the place as it is then (waysOf), so
    // new places (setPlaces: a key, a url, a machine) open their ways at once. Each call is inert for a place
    // without its field, and this machine's identity is read only when a witness names a machine.
    remote: hostLinkCall({ daemonLink }), direct: directWitnessCall({ walnutId: thisWalnutId }), here: lazyMachine(),
    ...transportOpts,
    onDrop: (why, d) => {
      // Only the witness's own "nothing here" (it looked at its directory) is absent; any other 404 is not reached.
      if (why === 'bad-status' && d.status === 404 && d.error === NO_WITNESS_HERE_CODE) absentAt.set(d.witness, Date.now())
      transportOpts.onDrop?.(why, d)
    },
  })
  client = new PermitClient({ id, list: places.map((p) => p.id), transport, clock: createHolderClock(), params, ...(guard ? { guard } : {}) })
  const h: PermitHandle = {
    client,
    places,
    setPlaces(next) {
      if (next.length !== h.places.length || next.some((p, i) => p.id !== h.places[i]!.id)) return false
      h.places = next
      lookup = placesOf(next)
      return true
    },
    absentSince: (t) => [...absentAt].filter(([, at]) => at >= t).map(([w]) => w),
  }
  return h
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Read every witness. `standing` is the record a majority holds (null: none ever), or
 * undefined when no record has a majority among the answers (the outcome is unknown).
 */
export async function readStanding(h: PermitHandle, waitMs = 1_500, expected = h.places.length): Promise<{ standing: PermitRecord | null | undefined; answered: number; replies: PermitReply[]; absent: string[] }> {
  const t0 = Date.now()
  h.client.read()
  // `absent`: reached, and no witness there (it never answers this read); every other one that did not answer was not reached.
  const absent = (): string[] => { const got = new Set(h.client.readBack().map((r) => r.witness)); return h.absentSince(t0).filter((w) => !got.has(w)) }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await tick(20)
    if (h.client.readBack().length + absent().length >= expected) break
  }
  const replies = h.client.readBack()
  return { standing: h.client.standing(), answered: replies.length, replies, absent: absent() }
}

export type ProposeResult =
  | { outcome: 'chosen'; record: PermitRecord }
  | { outcome: 'short' | 'open'; record: PermitRecord }

/**
 * Send one record (`make` builds it on the client) and wait until a majority took it, enough
 * refused that it cannot, or `waitMs` passed. Sends again to the witnesses that have not
 * answered every 300 ms. A result that is not 'chosen' is never a yes.
 */
export async function proposeAndWait(h: PermitHandle, make: (c: PermitClient) => PermitRecord | null, waitMs = 3_000): Promise<ProposeResult | null> {
  // Learn the highest number and the witness list in use first, so the record is above it.
  await readStanding(h, Math.min(waitMs, 1_500))
  const record = make(h.client)
  if (!record) return null
  const deadline = Date.now() + waitMs
  let last = Date.now()
  while (Date.now() < deadline) {
    await tick(20)
    const pending = h.client.pendingRecord()
    // Chosen: onChosen cleared it (or a later proposal replaced it).
    if (!pending || pending.number !== record.number || pending.nonce !== record.nonce) return { outcome: 'chosen', record }
    if (h.client.outcome() === 'short') break
    if (Date.now() - last > 300) { h.client.retransmit(); last = Date.now() }
  }
  const pending = h.client.pendingRecord()
  if (!pending || pending.number !== record.number) return { outcome: 'chosen', record }
  return { outcome: h.client.outcome() === 'short' ? 'short' : 'open', record }
}

/**
 * Change the witness list as the holder, both steps (permit/client.ts changeWitnesses: the pair step,
 * then the final one the client sends once the pair stood); ok once the final step stood and the
 * client runs on `next`. A step that did not stand in time is reported, never taken as done.
 */
export async function changeListAndWait(h: PermitHandle, next: string[], waitMs = 15_000): Promise<{ ok: true } | { ok: false; why: string }> {
  const target = [...next].sort()
  const done = () => !h.client.jointList() && h.client.witnessList().length === target.length && h.client.witnessList().every((w) => target.includes(w))
  const deadline = Date.now() + waitMs
  // The final step the client sent by itself once the pair stood: wait for it, never send a step over it (a new pair
  // step from the old list, sent while the witnesses already take the final one, is refused there and stands nowhere).
  const settle = async (): Promise<void> => {
    let last = Date.now()
    while (Date.now() < deadline) {
      const p = h.client.pendingRecord()
      if (!p || p.kind !== 'members' || h.client.outcome() !== 'open') return
      if (Date.now() - last > 300) { h.client.retransmit(); last = Date.now() }
      await tick(20)
    }
  }
  for (let step = 0; step < 4; step++) {
    await settle()
    if (done()) return { ok: true }
    const left = deadline - Date.now()
    if (left <= 0) break
    let r: ProposeResult | null
    try { r = await proposeAndWait(h, (c) => c.changeWitnesses(target), left) } catch (err) { return { ok: false, why: (err as Error).message } }
    if (!r) return { ok: false, why: 'nothing was sent' }
    if (r.outcome !== 'chosen') return { ok: false, why: `its ${r.record.stage ?? r.record.kind} step is ${r.outcome}` }
    await tick(20)
  }
  await settle()
  return done() ? { ok: true } : { ok: false, why: 'it did not finish in time' }
}
