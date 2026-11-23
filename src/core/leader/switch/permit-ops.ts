/**
 * Asynchronous steps over the event-driven permit client (permit/client.ts): read the
 * witnesses, propose a record and wait for its outcome. The server's runtime proposes; the
 * switch command only reads (the witnesses take a record only from the process that holds).
 */
import { createHolderClock } from '../permit/clock.js'
import { PermitClient } from '../permit/client.js'
import type { PermitParams, PermitRecord, PermitReply } from '../permit/types.js'
import { createWitnessTransport, hostLinkCall, placesOf, type WitnessTransportOptions } from './witness-transport.js'
import { isRemoteWitness, type WitnessPlace } from './settings.js'

export interface PermitHandle {
  client: PermitClient
  places: WitnessPlace[]
}

/**
 * `guard`: false stops acting at once (the instance lock's held()). `net`: how remote witnesses
 * are reached (witness-transport.ts). By default only through a registered reach (the host-dialed
 * door): `daemonLink: true` adds the pooled daemon link to the host, which describes this Walnut to
 * that host (host.slice, leader.configure, the offline drain) and so is for the leader server alone,
 * never a standby, a reader command or a trial start.
 */
export function openPermitClient(id: string, places: WitnessPlace[], params: PermitParams, guard?: () => boolean, net: Partial<WitnessTransportOptions> & { daemonLink?: boolean } = {}): PermitHandle {
  const { daemonLink, ...transportOpts } = net
  let client: PermitClient | null = null
  const transport = createWitnessTransport({
    placeOf: placesOf(places), params, deliver: (reply: PermitReply) => client?.receive(reply),
    ...(places.some(isRemoteWitness) ? { remote: hostLinkCall({ daemonLink: daemonLink === true }) } : {}), ...transportOpts,
  })
  client = new PermitClient({ id, list: places.map((p) => p.id), transport, clock: createHolderClock(), params, ...(guard ? { guard } : {}) })
  return { client, places }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Read every witness. `standing` is the record a majority holds (null: none ever), or
 * undefined when no record has a majority among the answers (the outcome is unknown).
 */
export async function readStanding(h: PermitHandle, waitMs = 1_500): Promise<{ standing: PermitRecord | null | undefined; answered: number; replies: PermitReply[] }> {
  h.client.read()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await tick(20)
    if (h.client.readBack().length >= h.places.length) break
  }
  const replies = h.client.readBack()
  return { standing: h.client.standing(), answered: replies.length, replies }
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
