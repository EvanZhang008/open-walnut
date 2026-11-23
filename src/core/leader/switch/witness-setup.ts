/**
 * Setting up the remote witnesses of a Walnut (`walnut leader witnesses init`, the leader server's
 * POST /api/leader/witnesses/init). Two cases, by what the witnesses hold:
 *
 *   - A first setup (no witness reached holds a record): it makes the witness's record from nothing,
 *     with the first list. The caller first reads the witnesses, and sends each setup with what it
 *     saw at the OTHER witnesses; the witness refuses unless every one was reached and holds nothing
 *     (witness-wire.ts setupAllowed). A witness that lost its disk while others still hold records is
 *     never made again as a fresh one (permit/store.ts: two fresh witnesses and an old expired record
 *     would let a second machine see a majority while the first still leads).
 *   - A witness missing beside records (never set up, or its disk lost): only while this server leads,
 *     through the permit core's own way of adding a member. The leader sets it up as a JOINING witness
 *     from the generation the witnesses report, never below its own (prepareJoiningWitness,
 *     generationToJoin: it takes nothing until a change names it), then drops it from the running list
 *     (a list change it writes as the holder) and adds it back by a second list change. The core's membership rules make this safe; a witness that left
 *     never counts for the list it left.
 *
 * Each witness is set up the way it is reached: one this machine keeps in this machine's witness root
 * (witness-route.ts setUpMachineWitness), one with a `host` over the link to it, one with only a
 * direct door on the companion's lane (witness-direct.ts setUpCompanionWitness). Its key always comes
 * from the leader's config inside that setup call; a witness that holds another key answers key_differs.
 */
import type { PermitRecord } from '../permit/types.js'
import { resolveWitnessHost, setUpRemoteWitness, type RemoteCall } from './witness-transport.js'
import { setUpMachineWitness } from './witness-route.js'
import type { RemoteWitnessPlace } from './settings.js'
import type { WitnessEvidence } from './witness-wire.js'

/**
 * What one witness answered to a read: what the setup needs to know about it. `absent`: it was reached and
 * said it holds nothing of a witness (NO_WITNESS_HERE_CODE); `held` and `epoch` then say nothing. `listed`
 * false: it serves no list (a joining witness, or one that hides what it holds because its record is broken).
 */
export interface WitnessSighting { witness: string; held: boolean; epoch: number | null; listed?: boolean; absent?: true }

/** A setup's outcome; `at`: where it was sent (the host, or the door's url). `joined`: added by a list change. */
export interface WitnessSetupReport { witness: string; at: string; ok: boolean; made?: boolean; joined?: boolean; error?: string }

/** The sightings of a read (permit-ops.ts readStanding): its answers, and the witnesses reached that said they hold nothing. */
export function sightingsOf(answers: ReadonlyArray<{ witness: string; held?: PermitRecord | null; epoch?: number | null; list?: readonly string[] | null }>, absent: readonly string[] = []): WitnessSighting[] {
  return [
    ...answers.map((a) => ({ witness: a.witness, held: !!a.held, epoch: a.epoch ?? null, ...(a.list === null ? { listed: false } : {}) })),
    ...absent.map((witness) => ({ witness, held: false, epoch: null, absent: true as const })),
  ]
}

/** The leader's own steps for adding a witness to the running list (runtime.ts): present only while this server leads. */
export interface JoinSteps {
  /** The witness list the permission runs on now. */
  current(): string[]
  /** Change it as the holder, both steps; resolves once the final step stood. */
  change(next: string[]): Promise<{ ok: true } | { ok: false; why: string }>
  /** The generation a joining witness starts from, read from the witnesses now (generationToJoin); null when none answered. */
  generation(): Promise<number | null>
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
  companion?: (place: RemoteWitnessPlace, evidence: WitnessEvidence[], join?: number) => Promise<{ ok: true; made: boolean } | { ok: false; error: string }>
  /** This machine and its witness root: a witness it keeps is set up here directly (way a). */
  here?: { machineId: string | null; root: string }
  /** While this server leads: how it adds a missing witness (a joining setup and list changes). */
  join?: JoinSteps
  /** The machine a `host` names (a hosts alias, or a machine id): two witnesses on one machine are one witness counted twice. */
  resolveHost?: (host: string) => Promise<string>
}

/** What the caller saw at every witness of `list` except `target`. */
export function evidenceFor(list: string[], target: string, sightings: readonly WitnessSighting[]): WitnessEvidence[] {
  return list.filter((w) => w !== target).map((witness) => {
    const s = sightings.find((x) => x.witness === witness)
    if (!s) return { witness, seen: 'unreached' }
    if (s.absent) return { witness, seen: 'absent' }
    if (s.held || (s.epoch ?? 0) > 0) return { witness, seen: 'record' }
    // No list: a joining witness is part of a running Walnut; one that hides everything may hold anything.
    if (s.listed === false) return { witness, seen: s.epoch === null ? 'unreached' : 'record' }
    return { witness, seen: 'blank' }
  })
}

type SetupResult = { ok: true; made: boolean } | { ok: false; error: string }

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
  /** One setup to `p`, the way it is reached. */
  const send = async (p: RemoteWitnessPlace, evidence: WitnessEvidence[], join?: number): Promise<SetupResult> => {
    if (ownHere(p) && input.walnutId) {
      const r = await setUpMachineWitness(input.here!.root, { v: 1, walnutId: input.walnutId, witness: p.id, list: input.list, evidence, ...(p.key ? { key: p.key } : {}), ...(join !== undefined ? { join } : {}) })
      const b = r.body as { ok?: boolean; made?: boolean; error?: string }
      return r.status === 200 && b.ok ? { ok: true, made: !!b.made } : { ok: false, error: `${r.status} ${b.error ?? 'refused'}` }
    }
    if (p.host) {
      const r = await setUpRemoteWitness(p, input.list, input.walnutId, evidence, input.call, undefined, join)
      // Before this server leads only a registered reach opens to a host; the link opens once it leads.
      return !r.ok && r.error === 'no answer' && !input.join
        ? { ok: false, error: `no answer from ${p.host} (before this server leads it opens no link to a host: run this again once it leads, and the witness joins)` }
        : r
    }
    if (p.url && input.companion) return input.companion(p, evidence, join)
    return { ok: false, error: p.url ? 'no companion lane here' : 'kept by a machine this server has no link or door to' }
  }
  const named = (r: SetupResult): SetupResult => (!r.ok && /key_differs/.test(r.error)
    ? { ok: false, error: `${r.error}: it holds another key than this leader's config names (a key is never replaced: set that witness up anew by hand, or put its key in the config)` }
    : r)

  const reports: WitnessSetupReport[] = []
  for (const p of places) {
    const at = ownHere(p) ? 'this machine' : p.host ?? p.url ?? p.machine ?? '?'
    const report = (r: SetupResult, joined?: boolean) => reports.push({ witness: p.id, at, ...named(r), ...(joined ? { joined } : {}) })
    if (same.has(p.id)) { report({ ok: false, error: 'two witnesses name one machine' }); continue }
    const seen = input.sightings.find((s) => s.witness === p.id)
    const evidence = evidenceFor(input.list, p.id, input.sightings)
    const holding = evidence.filter((e) => e.seen === 'record').map((e) => e.witness)
    if (!holding.length) {
      // A first setup. One that answered holds its record already.
      if (seen && !seen.absent) { report({ ok: true, made: false }); continue }
      const unreached = evidence.filter((e) => e.seen === 'unreached').map((e) => e.witness)
      if (unreached.length) { report({ ok: false, error: `not made: ${unreached.join(', ')} did not answer, and may hold records; run this again when every witness answers` }); continue }
      report(await send(p, evidence))
      continue
    }
    // Beside records: a member already, or it joins through the leader's list changes.
    const join = input.join
    const inList = join ? join.current().includes(p.id) : true
    if (seen && !seen.absent && inList && seen.listed !== false) { report({ ok: true, made: false }); continue }
    if (!join) { report({ ok: false, error: `not made: other witnesses hold records (${holding.join(', ')}); it joins through a list change, which this leader server makes once it leads (run this again then)` }); continue }
    if (!seen) { report({ ok: false, error: 'not made: it did not answer, and may hold a record; run this again when it answers' }); continue }
    // Set up as joining already (an earlier run stopped half way): it still needs the list change that adds it.
    const joining = !seen.absent && seen.listed === false && seen.epoch !== null
    if (!seen.absent && !joining) { report({ ok: false, error: 'not made: it serves another list than this leader (a list change of another holder?)' }); continue }
    // Set up as joining FIRST: it takes nothing until a change names it, and a setup that fails here (no lane,
    // key_differs, no generation) leaves the running list as it was, its spare witness counted.
    let made = false
    if (seen.absent) {
      const gen = await join.generation()
      if (gen === null) { report({ ok: false, error: 'not made: no witness reported its generation' }); continue }
      const r = await send(p, evidence, gen)
      if (!r.ok) { report(r); continue }
      made = r.made
    }
    // Then out of the running list and back in: a joining witness takes only a change that adds it to a list it is not in.
    if (inList) {
      const out = await join.change(join.current().filter((w) => w !== p.id))
      if (!out.ok) { report({ ok: false, error: `set up as joining, but the list change without it did not stand (${out.why}); run this again` }); continue }
    }
    if (!join.current().includes(p.id)) {
      const back = await join.change([...join.current(), p.id])
      if (!back.ok) { report({ ok: false, error: `set up as joining, but the list change that adds it did not stand (${back.why}); run this again` }); continue }
    }
    report({ ok: true, made }, true)
  }
  return reports
}
