/**
 * Witnesses in local directories (this phase: every machine of the switch is on one
 * computer). Each witness is a directory holding the permit core's record file; any process
 * may serve a request to it, one at a time under a cross-process lock on that file.
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
import { withFileLockSync } from '../../../utils/file-lock.js'
import { createWitnessClock } from '../permit/clock.js'
import { bootstrapWitnessStore, createFilePermitStore } from '../permit/store.js'
import { PermitWitness } from '../permit/witness.js'
import type { PermitParams, PermitReply, PermitRequest, PermitTransport } from '../permit/types.js'
import type { WitnessPlace } from './settings.js'

import { registerMemoryHolder } from '../../observability/memory-ledger.js'

const RECORD = 'permit-record.json'

export function witnessRecordFile(place: WitnessPlace): string {
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

/** Serve one request at a local witness; null when its directory is missing (no answer). */
export function serveLocalWitness(place: WitnessPlace, req: PermitRequest, params: PermitParams): PermitReply | null {
  if (!fs.existsSync(place.dir)) return null
  const file = witnessRecordFile(place)
  return withFileLockSync(file, () => {
    const text = readText(file)
    let c = cache.get(place.dir)
    if (!c || c.text !== text) {
      c = { witness: new PermitWitness({ id: place.id, store: createFilePermitStore(file), clock: createWitnessClock(), params }), text }
      cache.set(place.dir, c)
    }
    const reply = c.witness.handle(req)
    c.text = readText(file)
    return reply
  })
}

/** Forget every witness this process loaded (tests: a "restart" of the witnesses). */
export function forgetLocalWitnesses(): void {
  cache.clear()
}

/**
 * The permit core's transport over local witness directories. A reply is handed back on a
 * later tick, as a network would, so the client never sees an answer inside its own send.
 */
export function localWitnessTransport(places: WitnessPlace[], params: PermitParams, deliver: (reply: PermitReply) => void): PermitTransport {
  const byId = new Map(places.map((p) => [p.id, p]))
  return {
    send(witness, req) {
      const place = byId.get(witness)
      if (!place) return
      setImmediate(() => {
        let reply: PermitReply | null = null
        try {
          reply = serveLocalWitness(place, req, params)
        } catch {
          reply = null // a lock that could not be taken, a disk error: no answer
        }
        if (reply) deliver(reply)
      })
    },
  }
}

/**
 * Set up witness directories that have never held a record, with the first list. A directory
 * that already holds one is left as it is (a witness that lost its record rejoins through a
 * list change, never by starting over: store.ts).
 */
export function setUpLocalWitnesses(places: WitnessPlace[]): { made: string[]; kept: string[] } {
  const list = places.map((p) => p.id)
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
