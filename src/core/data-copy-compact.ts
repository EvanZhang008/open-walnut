/**
 * Ad-hoc copies in the data home, kept but compressed. Migrations, repair scripts and
 * agents leave whole-file copies beside the files they touched (`usage.sqlite.backup-<x>`,
 * `sessions.sqlite.orphan-repair-<x>.backup`, `cron-jobs.json.corrupt-<x>`); the data
 * repo's .gitignore keeps them out of git sync, and nothing ever shrank them
 * (2026-11-24: a 2.1 GB usage.sqlite backup on a disk that was nearly full).
 *
 * This keeps every one of them, losslessly: a copy over a size limit that nobody wrote
 * for a day becomes `<copy>.gz`, verified byte for byte before the original goes. Nothing
 * is ever deleted without its compressed twin in place, and nothing Walnut's own code
 * reads by name is touched (KEPT_COPY_PATHS). Deleting a copy stays the user's call.
 *
 * Runs with every task-dir sweep round and the disk alarm's auto-fix, on this server's
 * own WALNUT_HOME only (a test or ephemeral server's home is its own). All I/O is
 * streamed (zlib streams run on the thread pool): the event loop never holds a file.
 */
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { CONFIG_BACKUP_FILE } from './config-store.js'
import { COPY_SUFFIX } from './home-manifest/index.js'
import { TASK_DB_PRE_V5_BACKUP_PATH } from './task-db.js'

const MiB = 1024 ** 2
/** A copy under this size is left as it is: compressing it saves too little to matter. */
export const COMPACT_MIN_BYTES = 50 * MiB
/** A copy written within this time may still be in use (a repair that just ran). */
export const COMPACT_MIN_AGE_MS = 24 * 60 * 60_000
/** Room the volume keeps beyond the compressed copy (a quarter of the original). */
const FREE_MARGIN_BYTES = 256 * MiB
const GIT_TIMEOUT_MS = 10_000

/** Folders never looked into: the user's notes, Walnut's scratch and rebuildable stores, plugins' own data. */
const SKIP_DIRS = new Set(['.git', 'notes', 'tmp', 'cache', 'artifacts', 'images', 'plugins', 'plugin-data', 'plugin-stores', 'sessions/streams'])

/** Copy kinds (COPY_SUFFIX's word) that are kept copies; `.tmp` is a write in flight, `.migrated` a journal's own, `.conflicted-*` is read back by name (git-sync-private-data.ts sets secrets aside as `*.conflicted-secret-*`). */
const KEPT_KINDS = new Set(['backup', 'bak', 'corrupt', 'unreadable'])

/**
 * Copies Walnut's own code reads by name (paths relative to the data home). Each stays as
 * it is. tests/core/data-copy-compact.test.ts holds every exported `*_BACKUP_PATH` and
 * `*_BACKUP_FILE` constant in src/ to this list.
 */
export const KEPT_COPY_PATHS: readonly string[] = [
  path.relative(WALNUT_HOME, TASK_DB_PRE_V5_BACKUP_PATH), // pre-ledger-owners.ts reads it
  path.relative(WALNUT_HOME, CONFIG_BACKUP_FILE), // config-store.ts restores from it
].map((p) => p.split(path.sep).join('/')).concat('auth.json.bak') // device-store.ts authBackupPath

const GZ_TEMP = /\.gz\.tmp-\d+$/

/**
 * Whether a file name is an ad-hoc copy this module compresses: a kept copy kind, never a
 * plain `<file>.bak` or a rolling `.bak.<n>` (live fallbacks code restores from:
 * config-store.ts, device-store.ts, bounded-memory-backup.ts), never a `.gz` or its temp.
 */
export function isCompactableCopyName(name: string): boolean {
  if (name.endsWith('.gz') || GZ_TEMP.test(name)) return false
  const m = COPY_SUFFIX.exec(name)
  if (!m || !KEPT_KINDS.has(m[1])) return false
  const rest = m[2] ?? ''
  if (m[1] === 'bak') return rest !== '' && !/^\.\d+$/.test(rest)
  return true
}

export interface CompactOptions {
  home?: string
  minBytes?: number
  minAgeMs?: number
  now?: number
  /** Free space of a volume (tests). */
  statfs?: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
  /** The compressed temp's writer (tests inject a failing one). */
  createWriteStream?: (file: string) => NodeJS.WritableStream
}

export interface CompactRow { file: string; before: number; after: number }

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(() => true, () => false)
}

/** Whether git ignores `rel` in the data repo at `home` (exit 0); a tracked or unignored file, or any error, says no. */
function gitIgnores(home: string, rel: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['-C', home, 'check-ignore', '-q', '--', rel], { timeout: GIT_TIMEOUT_MS }, (err) => resolve(!err))
  })
}

/**
 * The copies to compress under `home`, largest first: the top level and one level of
 * folders (never a skipped folder or a symlink), old and big enough, not kept by name, and
 * outside what the data repo tracks (when the home is a git repo, only what it ignores).
 */
export async function findCompactableCopies(home: string, opts: CompactOptions = {}): Promise<Array<{ file: string; rel: string; size: number }>> {
  const minBytes = opts.minBytes ?? COMPACT_MIN_BYTES
  const minAgeMs = opts.minAgeMs ?? COMPACT_MIN_AGE_MS
  const now = opts.now ?? Date.now()
  const kept = new Set(KEPT_COPY_PATHS)
  const found: Array<{ file: string; rel: string; size: number }> = []
  const visit = async (relDir: string, depth: number): Promise<void> => {
    const entries = await fsp.readdir(path.join(home, relDir), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (depth < 2 && !SKIP_DIRS.has(rel)) await visit(rel, depth + 1)
        continue
      }
      if (!e.isFile() || !isCompactableCopyName(e.name) || kept.has(rel)) continue
      const st = await fsp.lstat(path.join(home, rel)).catch(() => null)
      if (!st?.isFile() || st.size < minBytes || now - st.mtimeMs < minAgeMs) continue
      found.push({ file: path.join(home, rel), rel, size: st.size })
    }
  }
  await visit('', 1)
  if (found.length > 0 && await exists(path.join(home, '.git'))) {
    const ignored = await Promise.all(found.map((f) => gitIgnores(home, f.rel)))
    for (let i = found.length - 1; i >= 0; i--) if (!ignored[i]) found.splice(i, 1)
  }
  return found.sort((a, b) => b.size - a.size)
}

async function sha256Of(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(stream, new Writable({ write(chunk, _e, cb) { hash.update(chunk); cb() } }))
  return hash.digest('hex')
}

/** fsync a file or folder; a platform that cannot sync a folder is fine. */
async function syncPath(p: string): Promise<void> {
  const fh = await fsp.open(p, 'r')
  try { await fh.sync() } catch { /* not supported for folders here */ } finally { await fh.close() }
}

/**
 * Compresses one copy to `<file>.gz`: stream-gzip into a temp while hashing the original,
 * gunzip the temp and compare hashes, give it the original's times, rename it into place,
 * and only then remove the original. Any failure (a full disk included) removes the temp
 * and leaves the original as it was. Returns null when skipped (a `.gz` already there,
 * too little room on the volume).
 */
export async function compressCopy(file: string, opts: CompactOptions = {}): Promise<CompactRow | null> {
  const st = await fsp.stat(file)
  const gz = `${file}.gz`
  if (await exists(gz)) {
    log.session.warn('data copy compaction: a compressed copy already exists, left both', { file, gz })
    return null
  }
  const vol = await (opts.statfs ?? fsp.statfs)(path.dirname(file))
  const free = Number(vol.bavail) * Number(vol.bsize)
  if (free < st.size / 4 + FREE_MARGIN_BYTES) {
    log.session.warn('data copy compaction: too little free space to compress safely', { file, size: st.size, free })
    return null
  }
  // A temp a stopped run left beside this copy is ours and holds nothing the copy lacks.
  const dir = path.dirname(file)
  const base = `${path.basename(gz)}.tmp-`
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith(base) && GZ_TEMP.test(name)) await fsp.rm(path.join(dir, name), { force: true })
  }
  const tmp = `${gz}.tmp-${process.pid}`
  try {
    const hash = crypto.createHash('sha256')
    const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk) } })
    const out = opts.createWriteStream ? opts.createWriteStream(tmp) : createWriteStream(tmp, { flags: 'wx' })
    await pipeline(createReadStream(file), tap, zlib.createGzip({ level: 6 }), out)
    const want = hash.digest('hex')
    const got = await sha256Of(createReadStream(tmp).pipe(zlib.createGunzip()))
    if (got !== want) throw new Error('the compressed copy does not read back as the original')
    const again = await fsp.stat(file)
    if (again.size !== st.size || again.mtimeMs !== st.mtimeMs) throw new Error('the copy changed while it was compressed')
    await syncPath(tmp)
    await fsp.utimes(tmp, st.atime, st.mtime)
    await fsp.rename(tmp, gz)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  await syncPath(dir).catch(() => {})
  const after = (await fsp.stat(gz)).size
  await fsp.unlink(file)
  return { file, before: st.size, after }
}

let inFlight: Promise<CompactRow[]> | null = null

/**
 * One pass over the data home (default this server's WALNUT_HOME), largest copy first.
 * One pass at a time per process: a caller while one runs gets that pass's rows.
 */
export function compactDataCopies(opts: CompactOptions = {}): Promise<CompactRow[]> {
  if (inFlight) return inFlight
  const home = opts.home ?? WALNUT_HOME
  const run = (async () => {
    const rows: CompactRow[] = []
    for (const c of await findCompactableCopies(home, opts)) {
      try {
        const row = await compressCopy(c.file, opts)
        if (!row) continue
        rows.push(row)
        log.session.info('data copy compressed', { file: c.rel, before: row.before, after: row.after })
      } catch (err) {
        log.session.warn('data copy compaction failed, the copy is left as it was', { file: c.rel, error: (err as Error).message })
      }
    }
    return rows
  })()
  const pass = run.finally(() => { if (inFlight === pass) inFlight = null })
  inFlight = pass
  return pass
}
