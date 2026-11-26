/**
 * What a machine reaches of the witnesses with no leader link: ways a (a witness it keeps itself)
 * and b (a direct door), never c. The switch's preflight asks it of the NEW leader's machine, with
 * that machine's identity and that machine's own copy of the config (its standby copy, which
 * carries every key): the candidate itself proves it reaches a majority before anything changes,
 * so its commit never depends on a link that only the old leader has, or on hosts that do not
 * know it as the leader yet (docs/reference/leader-switch.md, "The preflight from the candidate's side").
 *
 * Read only: it sends `read` requests, which no witness writes for.
 */
import { majorityOf, type PermitParams, type PermitRecord } from '../permit/types.js'
import { openPermitClient, readStanding } from './permit-ops.js'
import { NO_RELAY_CODE, NO_WITNESS_HERE_CODE } from './witness-wire.js'
import { isRemoteWitness, type RemoteWitnessPlace, type WitnessPlace } from './settings.js'
import { waysOf, type HereMachine, type HostLink, type RemoteCall, type WitnessDrop, type WitnessWay } from './witness-transport.js'

export interface WitnessReachOne {
  id: string
  answered: boolean
  way?: WitnessWay
  /** What it holds (answered only; null: no record yet). */
  held?: PermitRecord | null
  /** Its list generation (answered only). */
  epoch?: number | null
  /** It has a direct door (its `url` and `key`): a way that stands once the old leader stopped (answered only). */
  door?: boolean
  /** Answered through a relay: the witness whose door relayed it (the companion). */
  via?: string
  why?: string
}

export interface WitnessReachReport {
  /** The machine that asked (its id). */
  machine: string | null
  witnesses: WitnessReachOne[]
  answered: number
  /** A majority of the FIXED list answered by ways a and b. */
  majority: boolean
  /** The record a majority of the answers holds (null: none ever), undefined when none has a majority. */
  standing: PermitRecord | null | undefined
}

/**
 * The ways a candidate takes: never a leader link. `host-link` (the leader's machine's witness door over this
 * machine's own host link to it, leader-relay.ts) only when its call is given, and it counts only while the
 * leader's server runs: see commitReach. `relay` (a witness's door through another witness's door, witness-relay.ts)
 * stands whatever the leader's server does.
 */
export const CANDIDATE_WAYS: readonly WitnessWay[] = ['here', 'host-link', 'direct', 'relay']

export async function probeWitnessReach(o: {
  places: WitnessPlace[]
  params: PermitParams
  here: HereMachine
  walnutId: string
  /** Way b's call (default: the direct door over fetch). */
  direct?: RemoteCall
  /** The `host-link` way's call (leader-relay.ts hostLinkCallHere): absent, the way is not there. */
  hostLink?: HostLink
  waitMs?: number
}): Promise<WitnessReachReport> {
  // Per witness, the last drop of each way it was tried by: a person reads why each way failed.
  const drops = new Map<string, Map<WitnessWay | undefined, Drop>>()
  const came = new Map<string, WitnessWay>()
  const h = openPermitClient(`${o.here.machineId ?? 'unknown'}-candidate-probe`, o.places, o.params, undefined, {
    here: o.here, ways: CANDIDATE_WAYS, walnutId: o.walnutId, ...(o.direct ? { direct: o.direct } : {}), ...(o.hostLink ? { hostLink: o.hostLink } : {}),
    onAnswer: (id, way) => { came.set(id, way) },
    onDrop: (why, d) => {
      const m = drops.get(d.witness) ?? new Map<WitnessWay | undefined, Drop>()
      m.set(d.way, { why, ...(d.way ? { way: d.way } : {}), ...(d.status !== undefined ? { status: d.status } : {}), ...(d.error ? { error: d.error } : {}) })
      drops.set(d.witness, m)
    },
  })
  const need = majorityOf(o.places.map((p) => p.id))
  // Wait for the witnesses it has a way to, not for one it has none to.
  const waysHere = (p: WitnessPlace) => (isRemoteWitness(p) ? waysOf(p, { here: o.here, direct: () => {}, ...(o.hostLink ? { hostLink: o.hostLink } : {}), ways: CANDIDATE_WAYS }).length : 1)
  const reachable = o.places.filter((p) => waysHere(p) > 0).length
  const waitMs = o.waitMs ?? 5_000
  // A witness with more than one way may answer only on its next one (the leader's machine holds no record of it over
  // the host link, its direct door out of reach before its relay): the long read asks again those that have not
  // answered, each time on its next way (permit-ops.ts readStanding).
  let r = await readStanding(h, waitMs, reachable)
  // A renew in flight leaves one witness a record behind for a moment: read again before calling it a disagreement.
  for (let i = 0; i < 2 && r.answered >= need && r.standing === undefined; i++) {
    await new Promise((res) => setTimeout(res, 500))
    r = await readStanding(h, waitMs, reachable)
  }
  const held = new Map(r.replies.map((x) => [x.witness, x.held ?? null]))
  const epochs = new Map(r.replies.map((x) => [x.witness, x.epoch ?? null]))
  const answered = new Set(held.keys())
  const witnesses = o.places.map((p): WitnessReachOne => {
    if (answered.has(p.id)) {
      const way = came.get(p.id) ?? 'here'
      return { id: p.id, answered: true, way, held: held.get(p.id) ?? null, epoch: epochs.get(p.id) ?? null, door: isRemoteWitness(p) && !!(p.url && p.key), ...(way === 'relay' && isRemoteWitness(p) && p.relay ? { via: p.relay } : {}) }
    }
    return { id: p.id, answered: false, why: whyNot(p, o.here, drops.get(p.id), o.hostLink) }
  })
  return { machine: o.here.machineId, witnesses, answered: answered.size, majority: answered.size >= need, standing: r.standing }
}

type Drop = { why: WitnessDrop; way?: WitnessWay; status?: number; error?: string }

function whyNot(p: WitnessPlace, here: HereMachine, dropped: Map<WitnessWay | undefined, Drop> | undefined, hostLink: HostLink | undefined): string {
  if (!isRemoteWitness(p)) return `its directory ${p.dir} does not answer`
  const ways = waysOf(p, { here, direct: () => {}, ...(hostLink ? { hostLink } : {}), ways: CANDIDATE_WAYS })
  if (!ways.length) {
    const parts = [p.machine ? `it is kept by ${p.machine}` : null, p.host ? `reached only over the leader's link to ${p.host}` : null, (p.url || p.relayUrl) && !p.key ? `its door ${p.url ?? p.relayUrl} has no key yet (walnut leader witnesses init)` : null].filter(Boolean)
    return `no way to it without a leader link${parts.length ? ` (${parts.join('; ')})` : ''}`
  }
  if (!dropped?.size) return `${describe(p, ways[0]!)} did not answer`
  // Each way it was tried by, in the order tried, with why it did not count.
  const tried = ways.map((w) => dropped.get(w)).filter((d): d is Drop => !!d)
  const rest = [...dropped.values()].filter((d) => !d.way || !ways.includes(d.way))
  return [...tried, ...rest].map((d) => dropWords(p, d, ways[0]!)).join('; ')
}

function dropWords(p: RemoteWitnessPlace, drop: Drop, first: WitnessWay): string {
  const where = describe(p, drop.way ?? first)
  switch (drop.why) {
    case 'bad-status':
      if (drop.error === NO_RELAY_CODE) return `${where}: nothing of ${p.machine ?? p.id} is parked there (its machine's service or its bridge to the relay is down)`
      return drop.error === NO_WITNESS_HERE_CODE ? `${where} holds no witness (not set up)` : `${where} refused (${drop.status}${drop.error ? ` ${drop.error}` : ''})`
    case 'invalid-reply': return `${where} answered something that is not its reply`
    default: return `${where} did not answer`
  }
}

function describe(p: { url?: string; machine?: string; relay?: string }, way: WitnessWay): string {
  if (way === 'relay') return `its door through ${p.relay}'s relay`
  return way === 'here' ? `this machine (${p.machine})` : way === 'host-link' ? `its door on ${p.machine} over this machine's host link to the leader` : `its door ${p.url}`
}

/** How a person reads the way a witness answered by. */
function wayWords(w: WitnessReachOne): string {
  return w.way === 'here' ? 'on this machine' : w.way === 'host-link' ? 'over this machine\'s host link to the leader' : w.way === 'relay' ? `through ${w.via ?? 'a'} relay` : 'its direct door'
}

/**
 * The witnesses reached by a way that still stands once the current leader's server stopped: every way but
 * `host-link`, which is that server's own link to this machine and closes at its switch stop, BEFORE the new
 * leader's commit. The commit needs a majority of these (the check refuses otherwise, target-job.ts). A relayed
 * witness counts only by its own reply: the transport hands one on only when that witness proved its key over it
 * (witness-direct.ts), never because the relay answered.
 */
export function commitReach(r: WitnessReachReport): number {
  return r.witnesses.filter((w) => w.answered && w.way !== 'host-link').length
}

/**
 * The commit's majority without the relayed witnesses: below a majority, the commit needs a relay (relay_commit,
 * target-job.ts). With it, `onePath` names a relay whose door the commit's whole majority goes through (that witness
 * itself and the ones it relays): a single path for two votes, so with it down this machine has only what it dials.
 */
export function relayNeed(r: WitnessReachReport, need: number): { without: number; needsRelay: boolean; onePath: { via: string; left: number } | null } {
  const standing = r.witnesses.filter((w) => w.answered && w.way !== 'host-link')
  const without = standing.filter((w) => w.way !== 'relay').length
  const vias = [...new Set(standing.filter((w) => w.way === 'relay' && w.via).map((w) => w.via!))]
  // A relay is one path for the majority when, without it and what it relays, too few are left.
  const paths = vias.map((via) => ({ via, left: standing.filter((w) => w.id !== via && w.via !== via).length }))
  return { without, needsRelay: without < need, onePath: paths.find((p) => p.left < need) ?? null }
}

/**
 * How many of the witnesses reached hold a record that passes `test`. Not the standing: a witness
 * that was out of reach for a while holds an older renew of the same holder, which is no
 * disagreement about who holds the permission. A `host-link` answer counts when that witness also has a
 * direct door, which the commit takes once the old leader stopped (counting every host-link answer out
 * refused a switch that commits: the remote rehearsal's split after the stop); one reached only over the
 * host link does not. Whether the commit has a majority without the host link is also the check's
 * question (commitReach). A relayed answer counts: the relay stands after the stop.
 */
export function reachedHolding(r: WitnessReachReport, test: (held: PermitRecord) => boolean): number {
  return r.witnesses.filter((w) => w.answered && (w.way !== 'host-link' || w.door === true) && w.held && test(w.held)).length
}

/** One line for a person: which witnesses the machine reaches, and why each other one is missing. */
export function reachSentence(r: WitnessReachReport, of: number): string {
  const got = r.witnesses.filter((w) => w.answered).map((w) => `${w.id} (${wayWords(w)})`)
  const missing = r.witnesses.filter((w) => !w.answered).map((w) => `${w.id}: ${w.why}`)
  return `${r.machine ?? 'the new leader\'s machine'} reaches ${r.answered} of ${of} witnesses without a leader link${got.length ? ` (${got.join(', ')})` : ''}${missing.length ? `; missing ${missing.join('; ')}` : ''}`
}
