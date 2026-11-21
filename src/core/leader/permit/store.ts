/**
 * Where a witness keeps the highest record it accepted. A save is durable when it
 * returns (written, fsynced, renamed, directory fsynced); the witness answers only
 * after that. A file that is torn or fails its checksum is refused loudly
 * (PermitStoreCorrupt), never read as "no record": a witness that forgot what it said
 * yes to could say yes to someone else.
 */
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { PermitRecord } from './types.js'

export interface StoredWitness {
  held: PermitRecord | null
  list: string[] | null
}

export interface PermitStore {
  /** null: no file at all (a witness that was never set up, or lost its disk). Throws PermitStoreCorrupt. */
  load(): StoredWitness | null
  /** Durable when it returns; throws when it could not be made durable. */
  save(s: StoredWitness): void
}

export class PermitStoreCorrupt extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermitStoreCorrupt'
  }
}

type Fs = Pick<typeof nodeFs, 'openSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'readFileSync' | 'mkdirSync' | 'unlinkSync'>

function checksum(body: StoredWitness): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export function encodeStored(s: StoredWitness): string {
  const body: StoredWitness = { held: s.held, list: s.list }
  return JSON.stringify({ v: 1, ...body, sum: checksum(body) })
}

export function decodeStored(text: string, where: string): StoredWitness {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new PermitStoreCorrupt(`permit store ${where}: not whole JSON (torn write?)`)
  }
  const o = raw as { v?: unknown; held?: unknown; list?: unknown; sum?: unknown }
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.sum !== 'string') {
    throw new PermitStoreCorrupt(`permit store ${where}: unknown format`)
  }
  const body: StoredWitness = { held: (o.held ?? null) as PermitRecord | null, list: (o.list ?? null) as string[] | null }
  if (checksum(body) !== o.sum) throw new PermitStoreCorrupt(`permit store ${where}: checksum mismatch`)
  if (body.held !== null && (typeof body.held !== 'object' || !Number.isSafeInteger(body.held.number))) {
    throw new PermitStoreCorrupt(`permit store ${where}: bad record`)
  }
  if (body.list !== null && (!Array.isArray(body.list) || body.list.some((x) => typeof x !== 'string'))) {
    throw new PermitStoreCorrupt(`permit store ${where}: bad list`)
  }
  return body
}

/** A store in one file: tmp, write, fsync, rename, fsync the directory. */
export function createFilePermitStore(file: string, fs: Fs = nodeFs): PermitStore {
  const dir = nodePath.dirname(file)
  return {
    load() {
      let text: string
      try {
        text = fs.readFileSync(file, 'utf8') as string
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw new PermitStoreCorrupt(`permit store ${file}: unreadable (${(err as Error).message})`)
      }
      return decodeStored(text, file)
    },
    save(s) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      const fd = fs.openSync(tmp, 'w', 0o600)
      try {
        fs.writeSync(fd, encodeStored(s))
        fs.fsyncSync(fd)
      } catch (err) {
        fs.closeSync(fd)
        try { fs.unlinkSync(tmp) } catch { /* already gone */ }
        throw err
      }
      fs.closeSync(fd)
      fs.renameSync(tmp, file)
      // The rename is durable only once the directory is; unlike a best-effort log, a
      // witness that cannot make it so must not answer yes.
      const dfd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
    },
  }
}

/**
 * Sets up a witness once, with the first list. Refuses when the store already has a
 * file (or a corrupt one): a witness that lost its disk must come back by joining
 * through a members record, never by starting over as if it had said yes to nothing.
 */
export function bootstrapWitnessStore(store: PermitStore, list: string[]): void {
  if (store.load() !== null) throw new Error('permit store: already set up; a witness that lost its record rejoins through a members record')
  store.save({ held: null, list: [...list].sort() })
}
