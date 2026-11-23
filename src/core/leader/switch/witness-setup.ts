/**
 * Setting up the remote witnesses of a Walnut (`walnut leader witnesses init`, the leader server's
 * POST /api/leader/witnesses/init). A setup makes a witness record from nothing, so it is only for a
 * list that has never held a record: a witness that lost its disk while others still hold records must
 * not be made again as a fresh one (two fresh witnesses and an old expired record would let a second
 * machine see a majority while the first still leads: permit/store.ts, "rejoins through a list change").
 *
 * So the caller first reads the witnesses it can reach, and sends each setup with what it saw at the
 * OTHER witnesses; the witness refuses unless none held a record (witness-wire.ts setupAllowed).
 *
 * Each witness is set up the way it is reached: one this machine keeps in this machine's witness root
 * (witness-route.ts setUpMachineWitness), one with a `host` over the link to it, one with only a
 * direct door on the companion's lane (witness-direct.ts setUpCompanionWitness).
 */
import type { PermitRecord } from '../permit/types.js'
import { resolveWitnessHost, setUpRemoteWitness, type RemoteCall } from './witness-transport.js'
import { setUpMachineWitness } from './witness-route.js'
import type { RemoteWitnessPlace } from './settings.js'
import type { WitnessEvidence } from './witness-wire.js'

/**
 * What one witness answered to a read: what the setup needs to know about it. `absent`: it was reached and
 * answered that no witness is there (404, or no record on this machine); `held` and `epoch` then say nothing.
 */
export interface WitnessSighting { witness: string; held: boolean; epoch: number | null; absent?: true }

/** A setup's outcome; `at`: where it was sent (the host, or the door's url). */
export interface WitnessSetupReport { witness: string; at: string; ok: boolean; made?: boolean; error?: string }

/** The sightings of a read (permit-ops.ts readStanding): its answers, and the witnesses reached that said none is there. */
export function sightingsOf(answers: ReadonlyArray<{ witness: string; held?: PermitRecord | null; epoch?: number | null }>, absent: readonly string[] = []): WitnessSighting[] {
  return [...answers.map((a) => ({ witness: a.witness, held: !!a.held, epoch: a.epoch ?? null })), ...absent.map((witness) => ({ witness, held: false, epoch: null, absent: true as const }))]
}

export interface SetUpWitnessesInput {
  places: RemoteWitnessPlace[]
  list: string[]
  walnutId: string | null
  /** The witnesses that answered a read just now. */
  sightings: WitnessSighting[]
  /** Over a link to a host (default: the daemon link; a server that has not led passes its registered reach only). */
  call?: RemoteCall
  /** A witness with only a direct door: its setup on the companion's lane (none: it is reported not set up). */
  companion?: (place: RemoteWitnessPlace, evidence: WitnessEvidence[]) => Promise<{ ok: true; made: boolean } | { ok: false; error: string }>
  /** This machine and its witness root: a witness it keeps is set up here directly (way a). */
  here?: { machineId: string | null; root: string }
  /** The machine a `host` names (a hosts alias, or a machine id): two witnesses on one machine are one witness counted twice. */
  resolveHost?: (host: string) => Promise<string>
}

/** What the caller saw at every witness of `list` except `target`. */
export function evidenceFor(list: string[], target: string, sightings: readonly WitnessSighting[]): WitnessEvidence[] {
  return list.filter((w) => w !== target).map((witness) => {
    const s = sightings.find((x) => x.witness === witness)
    return { witness, seen: !s ? 'unreached' : s.absent ? 'absent' : (s.held || (s.epoch ?? 0) > 0 ? 'record' : 'blank') }
  })
}

export async function setUpRemoteWitnesses(input: SetUpWitnessesInput): Promise<WitnessSetupReport[]> {
  const resolve = input.resolveHost ?? resolveWitnessHost
  const places = input.places
  const ownHere = (p: RemoteWitnessPlace) => !!(p.machine && input.here?.machineId && p.machine === input.here.machineId)
  const machines = new Map<string, string>()
  const same = new Set<string>()
  for (const p of places) {
    if (!p.host || ownHere(p)) continue
    const m = await resolve(p.host).catch(() => p.host!)
    const other = machines.get(m)
    if (other) { same.add(p.id); same.add(other) } else machines.set(m, p.id)
  }
  const reports: WitnessSetupReport[] = []
  for (const p of places) {
    const at = ownHere(p) ? 'this machine' : p.host ?? p.url ?? p.machine ?? '?'
    if (same.has(p.id)) { reports.push({ witness: p.id, at, ok: false, error: 'two witnesses name one machine' }); continue }
    // Answered a read: it holds a record (or waits to join) and is not made again.
    if (input.sightings.some((s) => s.witness === p.id && !s.absent)) { reports.push({ witness: p.id, at, ok: true, made: false }); continue }
    const evidence = evidenceFor(input.list, p.id, input.sightings)
    const holding = evidence.filter((e) => e.seen === 'record').map((e) => e.witness)
    if (holding.length) {
      reports.push({ witness: p.id, at, ok: false, error: `not made: other witnesses hold records (${holding.join(', ')}); a witness that lost its record rejoins through a list change` })
      continue
    }
    const unreached = evidence.filter((e) => e.seen === 'unreached').map((e) => e.witness)
    if (unreached.length) {
      reports.push({ witness: p.id, at, ok: false, error: `not made: ${unreached.join(', ')} did not answer, and may hold records; run this again when every witness answers` })
      continue
    }
    if (ownHere(p) && input.walnutId) {
      const r = await setUpMachineWitness(input.here!.root, { v: 1, walnutId: input.walnutId, witness: p.id, list: input.list, evidence, ...(p.key ? { key: p.key } : {}) })
      const b = r.body as { ok?: boolean; made?: boolean; error?: string }
      reports.push(r.status === 200 && b.ok ? { witness: p.id, at, ok: true, made: !!b.made } : { witness: p.id, at, ok: false, error: `${r.status} ${b.error ?? 'refused'}` })
    } else if (p.host) reports.push({ witness: p.id, at, ...(await setUpRemoteWitness(p, input.list, input.walnutId, evidence, input.call)) })
    else if (p.url && input.companion) reports.push({ witness: p.id, at, ...(await input.companion(p, evidence)) })
    else reports.push({ witness: p.id, at, ok: false, error: p.url ? 'no companion lane here' : 'kept by another machine with no link or door from here: run walnut leader witnesses init on that machine' })
  }
  return reports
}
