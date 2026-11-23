/**
 * Switch notes (switch-notes.ts, the note call of witness-wire.ts and witness-door.ts): written and read
 * through ways a and b with each witness's own key, beside the record and never in it. A replayed note
 * request and a wrong key are refused before anything is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { machineWitnessDoor, type WitnessDoor } from '../../../../src/core/leader/switch/witness-door.js'
import { directWitnessCall, type DoorPost } from '../../../../src/core/leader/switch/witness-direct.js'
import { setUpMachineWitness, witnessDir } from '../../../../src/core/leader/switch/witness-route.js'
import { readSwitchNotes, writeSwitchNote, type NotesAccess } from '../../../../src/core/leader/switch/switch-notes.js'
import { NOTES_FILE, setUpLocalWitnesses } from '../../../../src/core/leader/switch/local-witnesses.js'
import { parseNoteCall, NOTE_WHY_MAX } from '../../../../src/core/leader/switch/witness-wire.js'
import type { RemoteWitnessPlace } from '../../../../src/core/leader/switch/settings.js'
import { proofSecret } from '../../../../src/utils/hmac-proof.js'
import { blankEvidence } from '../../../helpers/witness-machines.js'

const WALNUT = 'walnut-notes-1'
const LIST = ['w-a', 'w-b', 'w-k']
let base = ''
const keys: Record<string, string> = {}
const doors = new Map<string, WitnessDoor>()
const rootOf = (id: string) => path.join(base, id, 'leader-witness')
const recordOf = (id: string) => path.join(witnessDir(rootOf(id), WALNUT, id), 'permit-record.json')
const notesOf = (id: string) => path.join(witnessDir(rootOf(id), WALNUT, id), NOTES_FILE)
/** Every body sent to a door, in order (the replay test resends one). */
const sent: { url: string; body: unknown }[] = []

/** A door call in this process: the door's own challenge and request, answered on a later tick as a network would. */
const post: DoorPost = (url, body, done) => {
  sent.push({ url, body })
  const id = /\/door\/([^/]+)\//.exec(url)![1]!
  const door = doors.get(id)!
  setImmediate(() => {
    if (url.endsWith('/challenge')) { const r = door.challenge(body, '127.0.0.1'); done({ status: r.status, json: r.body }) } else door.request(body, (r) => done({ status: r.status, json: r.body }), '127.0.0.1')
  })
}

const place = (id: string, key = keys[id]!): RemoteWitnessPlace => ({ id, url: `https://door.test/door/${id}/leader-witness`, key })

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-notes-'))
  for (const id of LIST) {
    keys[id] = proofSecret()
    expect((await setUpMachineWitness(rootOf(id), { v: 1, walnutId: WALNUT, witness: id, list: LIST, evidence: blankEvidence(LIST, id), key: keys[id] })).status).toBe(200)
    doors.set(id, machineWitnessDoor({ root: rootOf(id) }))
  }
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

/** Machine A keeps w-a (way a); the others only by their doors (way b). */
function accessOf(machineId: string, places: RemoteWitnessPlace[]): NotesAccess {
  return { places, here: { machineId, root: rootOf('w-a'), walnutId: () => WALNUT }, walnutId: WALNUT, direct: directWitnessCall({ post }) }
}

describe('switch notes through ways a and b', () => {
  it('a note written by one machine is read by the other, newest per machine, and no permit record changes', async () => {
    const records = LIST.map((id) => fs.readFileSync(recordOf(id)))
    const a = accessOf('machine-a', [{ ...place('w-a'), machine: 'machine-a' }, place('w-b'), place('w-k')])
    const b = accessOf('machine-b', [place('w-a'), place('w-b'), place('w-k')])
    expect(await writeSwitchNote(a, { switchId: 'S1', machine: 'machine-a', step: 'handed-over' })).toBe(3)
    expect(await writeSwitchNote(b, { switchId: 'S1', machine: 'machine-b', step: 'waiting-mark' })).toBe(3)
    expect(await writeSwitchNote(b, { switchId: 'S1', machine: 'machine-b', step: 'gave-up', why: 'x'.repeat(NOTE_WHY_MAX + 50) })).toBe(3)
    const seen = await readSwitchNotes(a, 'S1')
    expect(seen.get('machine-a')?.step).toBe('handed-over')
    expect(seen.get('machine-b')?.step).toBe('gave-up')
    expect(seen.get('machine-b')?.why?.length).toBe(NOTE_WHY_MAX)
    // Another switch's notes are not this one's.
    expect((await readSwitchNotes(b, 'S2')).size).toBe(0)
    // The permit records are byte for byte as before: notes live in their own file.
    expect(LIST.map((id) => fs.readFileSync(recordOf(id)))).toEqual(records)
    expect(fs.existsSync(notesOf('w-b'))).toBe(true)
  })

  it('a replayed note request is refused, and a wrong key writes nothing', async () => {
    const b = accessOf('machine-b', [place('w-k')])
    sent.length = 0
    expect(await writeSwitchNote(b, { switchId: 'S3', machine: 'machine-b', step: 'promote' })).toBe(1)
    const request = sent.find((x) => x.url.endsWith('/request'))!
    const replay = await new Promise<{ status: number; body: unknown }>((r) => doors.get('w-k')!.request(request.body, r, '127.0.0.1'))
    expect(replay.status).toBe(403)
    expect((replay.body as { error: string }).error).toBe('unknown_nonce')
    const before = fs.readFileSync(notesOf('w-k'), 'utf8')
    const wrong = accessOf('machine-b', [place('w-k', proofSecret())])
    expect(await writeSwitchNote(wrong, { switchId: 'S3', machine: 'machine-b', step: 'forged' })).toBe(0)
    expect(fs.readFileSync(notesOf('w-k'), 'utf8')).toBe(before)
    expect(await readSwitchNotes(wrong, 'S3')).toEqual(new Map())
  })

  it('a door answers no note for a witness it does not keep, and a note call is never a permit request', async () => {
    const stranger = accessOf('machine-b', [{ id: 'w-x', url: 'https://door.test/door/w-k/leader-witness', key: keys['w-k']! }])
    expect(await writeSwitchNote(stranger, { switchId: 'S4', machine: 'machine-b', step: 'x' })).toBe(0)
    expect(parseNoteCall({ v: 1, walnutId: WALNUT, witness: 'w-a', request: { type: 'read' }, note: { op: 'read', switchId: 'S' } })).toBeNull()
    expect(parseNoteCall({ v: 1, walnutId: WALNUT, witness: 'w-a', note: { op: 'write', note: { switchId: 'S', machine: 'm', step: 's', at: 'now', extra: 1 } } })).toBeNull()
  })

  it('a dir witness (one computer) keeps notes beside its record, and a missing one answers none', async () => {
    const dirs = ['d1', 'd2', 'd3'].map((id) => ({ id, dir: path.join(base, 'dirs', id) }))
    setUpLocalWitnesses(dirs)
    fs.rmSync(dirs[2]!.dir, { recursive: true })
    const a: NotesAccess = { places: dirs, here: { machineId: 'machine-a', root: base, walnutId: () => WALNUT }, walnutId: WALNUT }
    expect(await writeSwitchNote(a, { switchId: 'S5', machine: 'machine-a', step: 'stopped' })).toBe(2)
    expect((await readSwitchNotes(a, 'S5')).get('machine-a')?.step).toBe('stopped')
  })
})
