/**
 * Setting up the remote witnesses of a Walnut (`walnut leader witnesses init`, the leader server's
 * POST /api/leader/witnesses/init). A setup makes a witness record from nothing, so it is only for a
 * list that has never held a record: a witness that lost its disk while others still hold records must
 * not be made again as a fresh one (two fresh witnesses and an old expired record would let a second
 * machine see a majority while the first still leads: permit/store.ts, "rejoins through a list change").
 *
 * So the caller first reads the witnesses it can reach, and sends each setup with what it saw at the
 * OTHER witnesses; the witness refuses unless none held a record (witness-wire.ts setupAllowed).
 */
import { resolveWitnessHost, setUpRemoteWitness, type RemoteCall } from './witness-transport.js'
import type { RemoteWitnessPlace } from './settings.js'
import type { WitnessEvidence } from './witness-wire.js'

/** What one witness answered to a read: what the setup needs to know about it. */
export interface WitnessSighting { witness: string; held: boolean; epoch: number | null }

export interface WitnessSetupReport { witness: string; host: string; ok: boolean; made?: boolean; error?: string }

export interface SetUpWitnessesInput {
  places: RemoteWitnessPlace[]
  list: string[]
  walnutId: string | null
  /** The witnesses that answered a read just now. */
  sightings: WitnessSighting[]
  call?: RemoteCall
  /** The machine a `host` names (a hosts alias, or a machine id): two witnesses on one machine are one witness counted twice. */
  resolveHost?: (host: string) => Promise<string>
}

/** What the caller saw at every witness of `list` except `target`. */
export function evidenceFor(list: string[], target: string, sightings: readonly WitnessSighting[]): WitnessEvidence[] {
  return list.filter((w) => w !== target).map((witness) => {
    const s = sightings.find((x) => x.witness === witness)
    return { witness, seen: !s ? 'none' : (s.held || (s.epoch ?? 0) > 0 ? 'record' : 'blank') }
  })
}

export async function setUpRemoteWitnesses(input: SetUpWitnessesInput): Promise<WitnessSetupReport[]> {
  const resolve = input.resolveHost ?? resolveWitnessHost
  const machines = new Map<string, string>()
  const same = new Set<string>()
  for (const p of input.places) {
    const m = await resolve(p.host).catch(() => p.host)
    const other = machines.get(m)
    if (other) { same.add(p.id); same.add(other) } else machines.set(m, p.id)
  }
  const reports: WitnessSetupReport[] = []
  for (const p of input.places) {
    if (same.has(p.id)) { reports.push({ witness: p.id, host: p.host, ok: false, error: 'two witnesses name one machine' }); continue }
    // Answered a read: it holds a record (or waits to join) and is not made again.
    if (input.sightings.some((s) => s.witness === p.id)) { reports.push({ witness: p.id, host: p.host, ok: true, made: false }); continue }
    const evidence = evidenceFor(input.list, p.id, input.sightings)
    if (evidence.some((e) => e.seen === 'record')) {
      reports.push({ witness: p.id, host: p.host, ok: false, error: `not made: other witnesses hold records (${evidence.filter((e) => e.seen === 'record').map((e) => e.witness).join(', ')}); a witness that lost its record rejoins through a list change` })
      continue
    }
    const r = await setUpRemoteWitness(p, input.list, input.walnutId, evidence, input.call)
    reports.push({ witness: p.id, host: p.host, ...r })
  }
  return reports
}
