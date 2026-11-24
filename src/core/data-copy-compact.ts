/**
 * Ad-hoc copies in the data home, kept but compressed. Migrations, repair scripts and
 * agents leave whole-file copies beside the files they touched (`usage.sqlite.backup-<x>`,
 * `sessions.sqlite.orphan-repair-<x>.backup`, `cron-jobs.json.corrupt-<x>`); the data
 * repo's .gitignore keeps them out of git sync, and nothing ever shrank them
 * (2026-11-24: a 2.1 GB usage.sqlite backup on a disk that was nearly full).
 *
 * This keeps every one of them, losslessly: a copy over a size limit that nobody wrote
 * for a day becomes `<copy>.gz`, verified byte for byte before the original goes. Nothing
 * is ever deleted without its compressed twin in place, and only a copy whose name is its
 * own (stamped: `.backup-<x>`, `.corrupt-<ts>`, `<stem>-<stamp>.backup`) is touched: a
 * fixed name (`cron-jobs.backup.json`, `config.yaml.bak`, `tasks.sqlite.pre-v5.backup`) is a
 * copy code writes again or reads back by name, and stays. Deleting a copy stays the user's call.
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
import { COPY_SUFFIX } from './home-manifest/index.js'

const MiB = 1024 ** 2
/** A copy under this size is left as it is: compressing it saves too little to matter. */
export const COMPACT_MIN_BYTES = 50 * MiB
/** A copy written within this time may still be in use (a repair that just ran). */
export const COMPACT_MIN_AGE_MS = 24 * 60 * 60_000
/** Room the volume always keeps for live data: the compressed write stops before it takes this. */
const FREE_MARGIN_BYTES = 256 * MiB
const GIT_TIMEOUT_MS = 10_000

/** Folders never looked into: the user's notes, Walnut's scratch and rebuildable stores, plugins' own data. */
const SKIP_DIRS = new Set(['.git', 'notes', 'tmp', 'cache', 'artifacts', 'images', 'plugins', 'plugin-data', 'plugin-stores', 'sessions/streams'])

/** Copy kinds (COPY_SUFFIX's word) that are kept copies; `.tmp` is a write in flight, `.migrated` a journal's own, `.conflicted-*` is read back by name (git-sync-private-data.ts sets secrets aside as `*.conflicted-secret-*`). */
const KEPT_KINDS = new Set(['backup', 'bak', 'corrupt', 'unreadable'])

const GZ_TEMP = /\.gz\.tmp-\d+$/
/** SQLite's sidecars: a copy taken with its -wal/-shm stays whole, as a set, uncompressed. */
const SIDECAR = /-(wal|shm|journal)$/

/**
 * Whether a file name is an ad-hoc copy this module compresses: a kept copy kind whose name
 * is its own, either tagged after the kind word (`.backup-<x>`, `.corrupt-<ts>`) or stamped
 * just before a bare `.backup` (`.orphan-repair-<stamp>.backup`). Never a fixed name code
 * writes again or reads back (`.backup.json`, `.corrupt`, `.bak`, `.bak.<n>`, `.pre-v5.backup`),
 * a hidden file (a copy being written), a SQLite sidecar, a `.gz` or its temp.
 */
export function isCompactableCopyName(name: string): boolean {
  if (name.startsWith('.') || name.endsWith('.gz') || GZ_TEMP.test(name) || SIDECAR.test(name)) return false
  const m = COPY_SUFFIX.exec(name)
  if (!m || !KEPT_KINDS.has(m[1])) return false
  const rest = m[2] ?? ''
  if (rest.startsWith('-')) return true
  if (rest !== '') return false
  const stem = name.slice(0, m.index)
  return /\d{4}/.test(stem.slice(stem.lastIndexOf('.') + 1))
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
 * folders (never a skipped folder or a symlink), old and big enough, and outside what the
 * data repo syncs: when the home is a git repo, only a copy git ignores both as it is and as
 * its `.gz` (the template's `/*.backup` does not cover `x.backup.gz`, and git-sync would
 * commit a new untracked .gz of hundreds of MB).
 */
export async function findCompactableCopies(home: string, opts: CompactOptions = {}): Promise<Array<{ file: string; rel: string; size: number }>> {
  const minBytes = opts.minBytes ?? COMPACT_MIN_BYTES
  const minAgeMs = opts.minAgeMs ?? COMPACT_MIN_AGE_MS
  const now = opts.now ?? Date.now()
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
      if (!e.isFile() || !isCompactableCopyName(e.name)) continue
      if (await exists(path.join(home, `${rel}-wal`))) continue
      const st = await fsp.lstat(path.join(home, rel)).catch(() => null)
      if (!st?.isFile() || st.size < minBytes || now - st.mtimeMs < minAgeMs) continue
      found.push({ file: path.join(home, rel), rel, size: st.size })
    }
  }
  await visit('', 1)
  if (found.length > 0 && await exists(path.join(home, '.git'))) {
    const ignored = await Promise.all(found.map(async (f) => await gitIgnores(home, f.rel) && await gitIgnores(home, `${f.rel}.gz`)))
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
  // Skip a copy unlikely to fit; past that guess, the write itself stops at the budget, so a
  // copy that compresses worse than expected never takes the room live data needs.
  const budget = Math.min(free - FREE_MARGIN_BYTES, st.size)
  if (budget < st.size / 4) {
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
    let written = 0
    const cap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        written += chunk.length
        if (written > budget) cb(new Error(`the compressed copy outgrew its room (${budget} bytes); stopped`))
        else cb(null, chunk)
      },
    })
    const out = opts.createWriteStream ? opts.createWriteStream(tmp) : createWriteStream(tmp, { flags: 'wx' })
    await pipeline(createReadStream(file), tap, zlib.createGzip({ level: 6 }), cap, out)
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

const inFlight = new Map<string, Promise<CompactRow[]>>()

/**
 * One pass over the data home (default this server's WALNUT_HOME), largest copy first.
 * One pass at a time per home: a caller while one runs gets that pass's rows.
 */
export function compactDataCopies(opts: CompactOptions = {}): Promise<CompactRow[]> {
  const home = opts.home ?? WALNUT_HOME
  const running = inFlight.get(home)
  if (running) return running
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
  const pass = run.finally(() => { if (inFlight.get(home) === pass) inFlight.delete(home) })
  inFlight.set(home, pass)
  return pass
}
