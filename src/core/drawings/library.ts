/**
 * The drawing library: the shapes a person keeps to reuse (the editor's Library panel), one list
 * shared by every surface and device, kept on the server.
 *
 * Stored in Walnut's own data (`WALNUT_HOME/drawings/library.json`, not the Notes vault) as an
 * `.excalidrawlib` file: `{type:'excalidrawlib', version:2, source:'walnut', libraryItems}`. Its
 * revision is the hash of the file's bytes; no file reads as an empty list with the revision of the
 * empty file, so the first PUT sends that revision like any other.
 *
 * A write checks the caller's revision under the store's file lock (CAS) and refuses a stale one
 * with the current list (409), replaces the file whole (temp file, flush, rename), and announces
 * the new revision (`drawings:library-updated`). The body is parsed, checked and encoded once, in
 * the scene worker when it is large (scene-codec.ts), and a read hands out the list as JSON text, so
 * a library of megabytes never holds the event loop. Over MAX_LIBRARY_BYTES a write is a 413.
 */

import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { withFileLock } from '../../utils/file-lock.js'
import { bus, EventNames } from '../event-bus.js'
import { isLargeScene, MAX_LIBRARY_BYTES, runCodec } from './scene-codec.js'
import { DrawingInputError } from './scene.js'
import { replaceAtomically } from './vault-files.js'

export { MAX_LIBRARY_BYTES }

/** The library as the routes send it: `libraryItems` is JSON text, spliced in as it is. */
export interface DrawingLibrary {
  revision: string
  items: string
}

/** A stale revision: the library changed since the caller read it. */
export class LibraryConflictError extends DrawingInputError {
  constructor(public readonly current: DrawingLibrary) {
    super('The drawing library changed since it was read', 409)
    this.name = 'LibraryConflictError'
  }
}

const EMPTY_BYTES = '{"type":"excalidrawlib","version":2,"source":"walnut","libraryItems":[]}\n'

export function libraryFile(): string {
  return path.join(WALNUT_HOME, 'drawings', 'library.json')
}

function hash(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readBytes(file: string): Promise<string | null> {
  try {
    if (!(await fsp.stat(file)).isFile()) return null
    return await fsp.readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * The library as it is on disk. A file that cannot be read as a library (edited by hand, cut short)
 * reads as an empty list with that file's revision, so the editor still opens; the next write keeps
 * a copy of it beside the new one (`library.unreadable.json`).
 */
async function current(file: string): Promise<DrawingLibrary & { unreadable?: string }> {
  const bytes = await readBytes(file)
  if (bytes === null) return { revision: hash(EMPTY_BYTES), items: '[]' }
  try {
    return await runCodec<DrawingLibrary>('library-read', bytes, isLargeScene(bytes.length))
  } catch (err) {
    if (!(err instanceof DrawingInputError)) throw err
    log.memory.warn('drawing library file is not readable; it reads as empty', { file, error: err.message })
    return { revision: hash(bytes), items: '[]', unreadable: bytes }
  }
}

export async function readLibrary(): Promise<DrawingLibrary> {
  const { revision, items } = await current(libraryFile())
  return { revision, items }
}

/**
 * Replace the library from a PUT body (`{revision, libraryItems}`, as JSON text or an object), only
 * when `revision` is the one on disk.
 */
export async function writeLibrary(body: string | Record<string, unknown>): Promise<DrawingLibrary> {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const next = await runCodec<{ revision: unknown; bytes: string; newRevision: string; items: string }>('library-body', text, isLargeScene(text.length))
  if (typeof next.revision !== 'string' || !next.revision) throw new DrawingInputError('revision is required: read the library first')
  const file = libraryFile()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const written = await withFileLock(file, async () => {
    const now = await current(file)
    if (now.revision !== next.revision) throw new LibraryConflictError({ revision: now.revision, items: now.items })
    if (now.revision === next.newRevision) return false
    if (now.unreadable !== undefined) await replaceAtomically(path.join(path.dirname(file), 'library.unreadable.json'), now.unreadable)
    await replaceAtomically(file, next.bytes)
    return true
  })
  if (written) {
    bus.emit(EventNames.DRAWING_LIBRARY_UPDATED, { revision: next.newRevision }, ['web-ui'])
    log.memory.info('drawing library saved', { revision: next.newRevision, bytes: Buffer.byteLength(next.bytes) })
  }
  return { revision: next.newRevision, items: next.items }
}
