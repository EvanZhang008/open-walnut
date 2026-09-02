/**
 * File-history snapshot store — the "works without git" half of the Files
 * panel's per-file history.
 *
 * Only the file the user has OPEN is ever recorded, and only through the two
 * edges that already own the bytes: the viewer's read (`?track=`) and the
 * editor's save (PUT). There is no walker, no watcher, and no attempt to mirror
 * a whole tree — a snapshot exists because a human looked at or wrote that one
 * file.
 *
 * Layout under `<WALNUT_HOME>/tmp/file-history/`:
 *
 *   <key>/index.json      { host, path, entries: Entry[] }   newest LAST
 *   <key>/<hash>.txt      the content, content-addressed
 *
 * `key` = sha256(host + NUL + absolutePath), first 16 hex chars. Blobs are
 * content-addressed so a save that reverts a file costs nothing, and the
 * index is the only thing that has to be written per snapshot.
 *
 * Two constraints this file exists to hold:
 *
 * 1. `tmp/` is the ONLY place this may live. Everything under WALNUT_HOME's
 *    root is git-synced (see TMP_DIR's note in constants.ts), and a per-
 *    keystroke copy of whatever file is open is exactly the kind of scratch
 *    that grew that repo to gigabytes.
 * 2. A store failure NEVER fails the read or write it decorates. Every public
 *    function swallows its own errors (recordSnapshot logs, the readers answer
 *    empty), because history is a decoration on an operation the user actually
 *    asked for.
 *
 * Callers must run the path sandbox (`assertPathAllowed`) BEFORE handing a path
 * here — this module does no authorization of its own.
 *
 * All fs access is async (`fs.promises`). The server has one event loop and
 * every route shares it, so a sync read here would freeze the whole box.
 */

import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { computeContentHash } from '../utils/file-ops.js'
import { log } from '../logging/index.js'

/** Who produced a snapshot. Drives the source pill in the UI, nothing else. */
export type SnapshotWriter = 'baseline' | 'user' | 'live' | 'merge' | 'agent'

export interface FileHistoryEntry {
  /** `<at>-<hash first 8>` — stable enough to address one version by URL. */
  id: string
  hash: string
  size: number
  /** Epoch ms. */
  at: number
  writer: SnapshotWriter
}

interface FileHistoryIndex {
  host: string | null
  path: string
  entries: FileHistoryEntry[]
}

export interface SnapshotRef {
  host?: string | null
  path: string
}

/** Newest-N per file. Old versions of one file are worth little; the cap is what
 *  keeps a busy editing session from turning into thousands of tiny files. */
const MAX_ENTRIES_PER_FILE = 100
/** Anything bigger is skipped outright — the editor can't load it either. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
/** Global directory budget; the least-recently-updated files fall off first. */
const MAX_FILE_DIRS = 500
/** Two `live` snapshots this close together collapse into one. */
const LIVE_COALESCE_MS = 60_000
/** The global prune walks every directory, so it runs at most this often. */
const GLOBAL_PRUNE_INTERVAL_MS = 10 * 60_000

/**
 * Resolved per call rather than captured at import: constants.ts WRITES
 * `OPEN_WALNUT_HOME` whenever it overrides the default (test isolation,
 * ephemeral children), so reading it here is what lets a test repoint the
 * store at a mkdtemp dir. Falls back to the imported constant.
 */
function historyRoot(): string {
  return path.join(process.env.OPEN_WALNUT_HOME || WALNUT_HOME, 'tmp', 'file-history')
}

function keyFor(host: string | null | undefined, filePath: string): string {
  return crypto.createHash('sha256')
    .update((host ?? 'local') + '\0' + filePath)
    .digest('hex')
    .slice(0, 16)
}

function dirFor(ref: SnapshotRef): string {
  return path.join(historyRoot(), keyFor(ref.host, ref.path))
}

/**
 * Serialize per file key. Two saves of one file (or a save racing the viewer's
 * baseline read) would otherwise read the same index, each append their own
 * entry, and the second write would drop the first — a lost version, which is
 * the one bug this store must not have.
 */
const chains = new Map<string, Promise<unknown>>()

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // The map holds a NEVER-rejecting tail (an unhandled rejection here would be a
  // process-level warning for something the caller already handles) and is
  // cleared once this link is the last one, so it can't grow per file forever.
  const tail = next.then(() => undefined, () => undefined)
  chains.set(key, tail)
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return next
}

/** Read an index, treating absent AND corrupt as "no history yet" (never throws). */
async function readIndex(dir: string, ref: SnapshotRef): Promise<FileHistoryIndex> {
  const empty: FileHistoryIndex = { host: ref.host ?? null, path: ref.path, entries: [] }
  let raw: string
  try {
    raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf-8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FileHistoryIndex>
    if (!parsed || !Array.isArray(parsed.entries)) return empty
    // Drop anything that isn't a well-formed entry rather than trusting the file:
    // a half-written index must degrade to fewer versions, never to a throw on a
    // request path.
    const entries = parsed.entries.filter((e): e is FileHistoryEntry =>
      !!e && typeof e.id === 'string' && typeof e.hash === 'string'
      && typeof e.size === 'number' && typeof e.at === 'number' && typeof e.writer === 'string')
    return { host: ref.host ?? null, path: ref.path, entries }
  } catch {
    return empty
  }
}

/** Atomic tmp → rename, so a crash mid-write can't leave a torn index. */
async function writeIndex(dir: string, index: FileHistoryIndex): Promise<void> {
  const target = path.join(dir, 'index.json')
  const tmp = target + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(index), 'utf-8')
  await fsp.rename(tmp, target)
}

/** Delete a blob no remaining entry references. */
async function dropUnreferencedBlob(dir: string, hash: string, entries: FileHistoryEntry[]): Promise<void> {
  if (entries.some((e) => e.hash === hash)) return
  try {
    await fsp.unlink(path.join(dir, hash + '.txt'))
  } catch { /* already gone */ }
}

let lastGlobalPrune = 0

/**
 * Keep at most `maxDirs` per-file directories, dropping the least recently
 * updated (index.json mtime). Exported so a test can exercise it with a small
 * cap instead of materializing 500 directories.
 */
export async function pruneFileHistoryDirs(maxDirs = MAX_FILE_DIRS): Promise<number> {
  const root = historyRoot()
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch {
    return 0
  }
  if (names.length <= maxDirs) return 0
  const stamped: Array<{ dir: string; mtimeMs: number }> = []
  for (const name of names) {
    const dir = path.join(root, name)
    try {
      const st = await fsp.stat(path.join(dir, 'index.json'))
      stamped.push({ dir, mtimeMs: st.mtimeMs })
    } catch {
      // No index → not a store directory (or a half-created one). Treat it as
      // the oldest possible so it's the first thing reclaimed.
      stamped.push({ dir, mtimeMs: 0 })
    }
  }
  stamped.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const doomed = stamped.slice(0, stamped.length - maxDirs)
  for (const d of doomed) {
    try {
      await fsp.rm(d.dir, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
  return doomed.length
}

/**
 * Record one version of one file.
 *
 * Rules, in the order they apply:
 *  - content over MAX_SNAPSHOT_BYTES → skipped (debug log, never a throw)
 *  - identical to the newest entry's hash → skipped, whatever the writer
 *  - a `live` snapshot within LIVE_COALESCE_MS of a `live` newest entry
 *    REPLACES it (typing produces one version per minute, not per keystroke)
 *  - anything else appends
 *
 * Never throws: a failure is logged and the caller's read/write is unaffected.
 */
export async function recordSnapshot(input: {
  host?: string | null
  path: string
  content: string
  writer: SnapshotWriter
}): Promise<void> {
  const ref: SnapshotRef = { host: input.host ?? null, path: input.path }
  const key = keyFor(ref.host, ref.path)
  try {
    const size = Buffer.byteLength(input.content, 'utf-8')
    if (size > MAX_SNAPSHOT_BYTES) {
      log.web.debug('file-history: snapshot skipped (too large)', {
        path: ref.path, host: ref.host ?? undefined, size, limit: MAX_SNAPSHOT_BYTES,
      })
      return
    }
    const hash = computeContentHash(input.content)
    await serialize(key, async () => {
      const dir = dirFor(ref)
      await fsp.mkdir(dir, { recursive: true })
      const index = await readIndex(dir, ref)
      const newest = index.entries[index.entries.length - 1]
      if (newest && newest.hash === hash) return // nothing changed
      const now = Date.now()

      // Blob first: an index entry pointing at a missing blob is a broken
      // version in the UI, while an orphan blob is just wasted bytes.
      const blob = path.join(dir, hash + '.txt')
      try {
        await fsp.writeFile(blob, input.content, { encoding: 'utf-8', flag: 'wx' })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        // Content-addressed: an existing blob with this name IS this content.
      }

      const coalesce = input.writer === 'live' && newest?.writer === 'live'
        && now - newest.at < LIVE_COALESCE_MS
      if (coalesce) {
        const replaced = newest.hash
        newest.hash = hash
        newest.size = size
        newest.at = now
        // The id is derived from (at, hash) — regenerate it so it can't describe
        // a version that no longer exists.
        newest.id = now + '-' + hash.slice(0, 8)
        await dropUnreferencedBlob(dir, replaced, index.entries)
      } else {
        index.entries.push({ id: now + '-' + hash.slice(0, 8), hash, size, at: now, writer: input.writer })
      }

      if (index.entries.length > MAX_ENTRIES_PER_FILE) {
        const dropped = index.entries.splice(0, index.entries.length - MAX_ENTRIES_PER_FILE)
        for (const d of dropped) await dropUnreferencedBlob(dir, d.hash, index.entries)
      }
      await writeIndex(dir, index)
    })

    const now = Date.now()
    if (now - lastGlobalPrune > GLOBAL_PRUNE_INTERVAL_MS) {
      lastGlobalPrune = now
      await pruneFileHistoryDirs()
    }
  } catch (err) {
    log.web.warn('file-history: snapshot failed (ignored)', {
      path: ref.path, host: ref.host ?? undefined, writer: input.writer,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Every recorded version of one file, oldest first. Empty when there is none. */
export async function listSnapshots(ref: SnapshotRef): Promise<FileHistoryEntry[]> {
  try {
    return (await readIndex(dirFor(ref), ref)).entries
  } catch {
    return []
  }
}

/** One recorded version's content, or null when the id is unknown / blob gone. */
export async function readSnapshot(
  ref: SnapshotRef & { id: string },
): Promise<{ content: string; hash: string; size: number; at: number; writer: SnapshotWriter } | null> {
  try {
    const dir = dirFor(ref)
    const index = await readIndex(dir, ref)
    const entry = index.entries.find((e) => e.id === ref.id)
    if (!entry) return null
    const content = await fsp.readFile(path.join(dir, entry.hash + '.txt'), 'utf-8')
    return { content, hash: entry.hash, size: entry.size, at: entry.at, writer: entry.writer }
  } catch {
    return null
  }
}

/** Drop all history for one file (tests, and a future "forget this file" action). */
export async function forgetFile(ref: SnapshotRef): Promise<void> {
  try {
    await fsp.rm(dirFor(ref), { recursive: true, force: true })
  } catch { /* best effort */ }
}
