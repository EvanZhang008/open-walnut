/**
 * Witnesses in directories of this computer: a one-computer switch's own witnesses, and the
 * records a machine serves for others (witness-route.ts). Each witness is a directory holding
 * the permit core's record file; any process may serve a request to it, one at a time under a
 * cross-process lock on that file. How a request reaches a witness (this file for a local one,
 * the network for a remote one) is witness-transport.ts.
 *
 * Several processes (the old leader's server, the new one's, the switch command) serve the
 * same witness, so each keeps its own PermitWitness and reloads it whenever the file differs
 * from what that process last saw. A reload counts the record as accepted at the reload, as
 * a restarted witness does (witness.ts): a hold measured from then lasts at least as long as
 * the real one, so a grant to another machine only ever comes late, never early. The record
 * itself is always the file's: the numbers, kinds and holders the rules judge are never
 * taken from memory.
 *
 * A witness whose directory is missing does not answer (it is unreachable); one whose
 * directory exists but holds no record answers that it is not set up. Directories are set up
 * once with `setUpLocalWitnesses`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { withFileLock } from '../../../utils/file-lock.js'
import { createWitnessClock } from '../permit/clock.js'
import { bootstrapWitnessStore, createFilePermitStore, prepareJoiningWitness } from '../permit/store.js'
import { PermitWitness } from '../permit/witness.js'
import type { PermitParams, PermitReply, PermitRequest } from '../permit/types.js'
import type { LocalWitnessPlace } from './settings.js'

import { registerMemoryHolder } from '../../observability/memory-ledger.js'

const RECORD = 'permit-record.json'
/** The witness's own key beside its record (witness-route.ts writes it at the setup). */
export const WITNESS_KEY_FILE = 'witness-key'

export function witnessRecordFile(place: LocalWitnessPlace): string {
  return path.join(place.dir, RECORD)
}

interface Cached { witness: PermitWitness; text: string }
/** One entry per witness directory this process served (three in a setup): its record's text. */
const cache = new Map<string, Cached>()
registerMemoryHolder({
  name: 'leader-switch.local-witnesses',
  budgetBytes: 1024 * 1024,
  read: () => ({ entries: cache.size, bytes: [...cache.values()].reduce((n, c) => n + c.text.length, 0) }),
})

function readText(file: string): string {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

/**
 * Whether a witness directory holds nothing of a witness: no record and no key (witness-route.ts). Only
 * then may an answer say "no witness here" (a setup's evidence `absent`): a key with no record, or a record
 * this process cannot read, is a witness that may hold something, so it is no such answer.
 */
export function witnessDirEmpty(dir: string): boolean {
  return !fs.existsSync(path.join(dir, RECORD)) && !fs.existsSync(path.join(dir, WITNESS_KEY_FILE))
}

/**
 * Serve one request at a local witness; null when its directory or its record is missing (no answer). The lock
 * is the async one (a server's event loop never waits on it), held a short while: a witness whose
 * lock is busy that long gives no answer, as a slow one on a network would.
 */
export function serveLocalWitness(place: LocalWitnessPlace, req: PermitRequest, params: PermitParams): Promise<PermitReply | null> {
  const file = witnessRecordFile(place)
  if (!fs.existsSync(file)) return Promise.resolve(null)
  return withFileLock(file, async () => {
    const text = readText(file)
    let c = cache.get(place.dir)
    if (!c || c.text !== text) {
      c = { witness: new PermitWitness({ id: place.id, store: createFilePermitStore(file), clock: createWitnessClock(), params }), text }
      cache.set(place.dir, c)
    }
    const reply = c.witness.handle(req)
    c.text = readText(file)
    return reply
  }, { timeoutMs: 2_000 })
}

/** Forget every witness this process loaded (tests: a "restart" of the witnesses). */
export function forgetLocalWitnesses(): void {
  cache.clear()
}

/**
 * Set up witness directories that have never held a record, with the first list (`list`: the
 * whole fixed list when `places` are only the ones on this machine). A directory that already
 * holds one is left as it is (a witness that lost its record rejoins through a list change,
 * never by starting over: store.ts).
 */
export function setUpLocalWitnesses(places: LocalWitnessPlace[], list: string[] = places.map((p) => p.id)): { made: string[]; kept: string[] } {
  const made: string[] = []
  const kept: string[] = []
  for (const p of places) {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
    const store = createFilePermitStore(witnessRecordFile(p))
    if (fs.existsSync(witnessRecordFile(p))) { kept.push(p.id); continue }
    bootstrapWitnessStore(store, list)
    made.push(p.id)
  }
  return { made, kept }
}

/**
 * Set up a witness that joins a Walnut already running (permit/store.ts prepareJoiningWitness): it takes
 * nothing until a list change from generation `epoch` or later names it. Kept when a record is there.
 */
export function prepareLocalJoiningWitness(place: LocalWitnessPlace, epoch: number): { made: boolean } {
  fs.mkdirSync(place.dir, { recursive: true, mode: 0o700 })
  if (fs.existsSync(witnessRecordFile(place))) return { made: false }
  prepareJoiningWitness(createFilePermitStore(witnessRecordFile(place)), epoch)
  return { made: true }
}
