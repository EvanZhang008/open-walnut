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
import { NO_WITNESS_HERE_CODE } from './witness-wire.js'
import { isRemoteWitness, type WitnessPlace } from './settings.js'
import { waysOf, type HereMachine, type RemoteCall, type WitnessDrop, type WitnessWay } from './witness-transport.js'

export interface WitnessReachOne {
  id: string
  answered: boolean
  way?: WitnessWay
  /** What it holds (answered only; null: no record yet). */
  held?: PermitRecord | null
  /** Its list generation (answered only). */
  epoch?: number | null
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

/** The ways a candidate takes: never a leader link. */
export const CANDIDATE_WAYS: readonly WitnessWay[] = ['here', 'direct']

export async function probeWitnessReach(o: {
  places: WitnessPlace[]
  params: PermitParams
  here: HereMachine
  walnutId: string
  /** Way b's call (default: the direct door over fetch). */
  direct?: RemoteCall
  waitMs?: number
}): Promise<WitnessReachReport> {
  const drops = new Map<string, { why: WitnessDrop; way?: WitnessWay; status?: number; error?: string }>()
  const came = new Map<string, WitnessWay>()
  const h = openPermitClient(`${o.here.machineId ?? 'unknown'}-candidate-probe`, o.places, o.params, undefined, {
    here: o.here, ways: CANDIDATE_WAYS, walnutId: o.walnutId, ...(o.direct ? { direct: o.direct } : {}),
    onAnswer: (id, way) => { came.set(id, way) },
    onDrop: (why, d) => { drops.set(d.witness, { why, ...(d.way ? { way: d.way } : {}), ...(d.status !== undefined ? { status: d.status } : {}), ...(d.error ? { error: d.error } : {}) }) },
  })
  const need = majorityOf(o.places.map((p) => p.id))
  // Wait for the witnesses it has a way to, not for one it has none to.
  const reachable = o.places.filter((p) => !isRemoteWitness(p) || waysOf(p, { here: o.here, direct: () => {}, ways: CANDIDATE_WAYS }).length > 0).length
  let r = await readStanding(h, o.waitMs ?? 5_000, reachable)
  // A renew in flight leaves one witness a record behind for a moment: read again before calling it a disagreement.
  for (let i = 0; i < 2 && r.answered >= need && r.standing === undefined; i++) {
    await new Promise((res) => setTimeout(res, 500))
    r = await readStanding(h, o.waitMs ?? 5_000, reachable)
  }
  const held = new Map(r.replies.map((x) => [x.witness, x.held ?? null]))
  const epochs = new Map(r.replies.map((x) => [x.witness, x.epoch ?? null]))
  const answered = new Set(held.keys())
  const witnesses = o.places.map((p): WitnessReachOne => {
    if (answered.has(p.id)) return { id: p.id, answered: true, way: came.get(p.id) ?? 'here', held: held.get(p.id) ?? null, epoch: epochs.get(p.id) ?? null }
    return { id: p.id, answered: false, why: whyNot(p, o.here, drops.get(p.id)) }
  })
  return { machine: o.here.machineId, witnesses, answered: answered.size, majority: answered.size >= need, standing: r.standing }
}

function whyNot(p: WitnessPlace, here: HereMachine, drop: { why: WitnessDrop; way?: WitnessWay; status?: number; error?: string } | undefined): string {
  if (!isRemoteWitness(p)) return `its directory ${p.dir} does not answer`
  const ways = waysOf(p, { here, direct: () => {}, ways: CANDIDATE_WAYS })
  if (!ways.length) {
    const parts = [p.machine ? `it is kept by ${p.machine}` : null, p.host ? `reached only over the leader's link to ${p.host}` : null, p.url && !p.key ? `its door ${p.url} has no key yet (walnut leader witnesses init)` : null].filter(Boolean)
    return `no way to it without a leader link${parts.length ? ` (${parts.join('; ')})` : ''}`
  }
  if (!drop) return `${describe(p, ways[0]!)} did not answer`
  const where = describe(p, drop.way ?? ways[0]!)
  switch (drop.why) {
    case 'bad-status': return drop.error === NO_WITNESS_HERE_CODE ? `${where} holds no witness (not set up)` : `${where} refused (${drop.status}${drop.error ? ` ${drop.error}` : ''})`
    case 'invalid-reply': return `${where} answered something that is not its reply`
    default: return `${where} did not answer`
  }
}

function describe(p: { url?: string; machine?: string }, way: WitnessWay): string {
  return way === 'here' ? `this machine (${p.machine})` : `its door ${p.url}`
}

/**
 * How many of the witnesses reached hold a record that passes `test`. Not the standing: a witness
 * that was out of reach for a while holds an older renew of the same holder, which is no
 * disagreement about who holds the permission.
 */
export function reachedHolding(r: WitnessReachReport, test: (held: PermitRecord) => boolean): number {
  return r.witnesses.filter((w) => w.answered && w.held && test(w.held)).length
}

/** One line for a person: which witnesses the machine reaches, and why each other one is missing. */
export function reachSentence(r: WitnessReachReport, of: number): string {
  const got = r.witnesses.filter((w) => w.answered).map((w) => `${w.id} (${w.way === 'here' ? 'on this machine' : 'its direct door'})`)
  const missing = r.witnesses.filter((w) => !w.answered).map((w) => `${w.id}: ${w.why}`)
  return `${r.machine ?? 'the new leader\'s machine'} reaches ${r.answered} of ${of} witnesses without a leader link${got.length ? ` (${got.join(', ')})` : ''}${missing.length ? `; missing ${missing.join('; ')}` : ''}`
}
