/**
 * Switch notes, the caller's half (docs/reference/leader-switch.md, "Switch notes"): each job of a
 * switch leaves its newest step at every witness it reaches with no leader link (ways a and b), and
 * reads the other machine's there. The two machines of a switch share no link of their own, and the
 * witnesses are what both reach.
 *
 * Never trusted for safety: a note only changes how soon a side gives up or what it prints. Who leads
 * is the witnesses' record alone (the permit core), which a note never touches.
 */
import { serveSwitchNote } from './local-witnesses.js'
import { isRemoteWitness, type WitnessPlace } from './settings.js'
import { witnessDir } from './witness-route.js'
import { directWitnessCall } from './witness-direct.js'
import { acceptNotes, NOTE_WHY_MAX, WITNESS_NOTE_PATH, type NoteCall, type SwitchNote } from './witness-wire.js'
import type { HereMachine, RemoteCall } from './witness-transport.js'

export type { SwitchNote } from './witness-wire.js'

export interface NotesAccess {
  places: WitnessPlace[]
  here: HereMachine
  walnutId: string
  /** Way b's call (default: the direct door over fetch). */
  direct?: RemoteCall
  timeoutMs?: number
}

/** One note call at one witness by the first way it has (a, then b): the notes of its switch, or null (no answer). */
function noteAt(a: NotesAccess, place: WitnessPlace, op: NoteCall['note']): Promise<SwitchNote[] | null> {
  const switchId = op.op === 'read' ? op.switchId : op.note.switchId
  if (!isRemoteWitness(place)) return serveSwitchNote(place.dir, op).catch(() => null)
  if (place.machine && a.here.machineId === place.machine) return serveSwitchNote(witnessDir(a.here.root, a.walnutId, place.id), op).catch(() => null)
  if (!place.url || !place.key) return Promise.resolve(null)
  const call = a.direct ?? directWitnessCall({ timeoutMs: a.timeoutMs ?? 5_000 })
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: SwitchNote[] | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { abandon?.(); finish(null) }, a.timeoutMs ?? 5_000)
    timer.unref?.()
    const body: NoteCall = { v: 1, walnutId: a.walnutId, witness: place.id, note: op }
    const abandon = call(place, WITNESS_NOTE_PATH, body, (r) => finish(r && r.status === 200 ? acceptNotes(r.body, switchId) : null))
  })
}

/** Leave `note` at every witness this machine reaches with no link; how many took it. */
export async function writeSwitchNote(a: NotesAccess, note: Omit<SwitchNote, 'at'> & { at?: string }): Promise<number> {
  const n: SwitchNote = { ...note, ...(note.why ? { why: note.why.slice(0, NOTE_WHY_MAX) } : {}), at: note.at ?? new Date().toISOString() }
  const got = await Promise.all(a.places.map((p) => noteAt(a, p, { op: 'write', note: n })))
  return got.filter((x) => x !== null).length
}

/** The newest note of each machine in `switchId`, over every witness reached (the newest of their copies wins). */
export async function readSwitchNotes(a: NotesAccess, switchId: string): Promise<Map<string, SwitchNote>> {
  const got = await Promise.all(a.places.map((p) => noteAt(a, p, { op: 'read', switchId })))
  const newest = new Map<string, SwitchNote>()
  for (const list of got) for (const n of list ?? []) {
    const had = newest.get(n.machine)
    if (!had || Date.parse(n.at) > Date.parse(had.at)) newest.set(n.machine, n)
  }
  return newest
}

/**
 * The notes access of a machine from a home's config and Walnut id (its own home, or its standby copy, which
 * carries every witness key), with that machine's identity (its env). Null when the home names no witnesses.
 */
export async function notesAccessOf(home: string, env: NodeJS.ProcessEnv): Promise<NotesAccess | null> {
  const [{ readHomeSwitchConfig }, { instanceIdAt }, { thisMachine }] = await Promise.all([
    import('./settings.js'), import('../../device-store.js'), import('./permit-ops.js'),
  ])
  const cfg = readHomeSwitchConfig(home)
  if (!cfg.settings) return null
  const walnutId = await instanceIdAt(home).catch(() => null)
  if (!walnutId) return null
  return { places: cfg.settings.witnesses, here: thisMachine(env, walnutId), walnutId }
}
