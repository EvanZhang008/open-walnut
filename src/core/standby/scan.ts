/**
 * The leader side's walk of the home: every path the data-location manifest
 * (src/core/home-manifest/) classes `leader-data`, with its stat, and nothing else; and the
 * stat of every dir it walked, so the batch can tell which dirs gained or lost a name since.
 *
 * It follows the manifest and nothing else: `machine` and `rebuildable` places are never
 * read, a dir of another class is not entered unless a `leader-data` place sits inside it
 * (cache/applied-ops.sqlite, tmp/file-history), and a SQLite database's -wal, -shm and
 * -journal are left out (the database rides as a snapshot, sqlite-pin.ts).
 *
 * Fast on purpose: the stats run many at a time, with a cap on open dirs and stats so a Mac's
 * low open-file limit is never hit, and a file is classified by its dir (fileClass below)
 * unless a manifest entry could name it on its own: classifying every one of 100k files
 * through the manifest took 2.4 s. Symlinks are skipped, as the backup skips them.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { homeEntries, homePathClass, type DataClass } from '../home-manifest/index.js'
import type { SourceStat } from './types.js'

export interface ScanEntry {
  p: string
  st: SourceStat
  x: boolean
  /** A SQLite database (by name and header). */
  db: boolean
}

/** A dir walked: its inode and ctime (a name added, removed or renamed in it moves the ctime). */
export interface DirStat {
  i: number
  c: number
}

export interface ScanResult {
  files: Map<string, ScanEntry>
  /** Every dir walked ('' is the home), stat taken before its listing. */
  dirs: Map<string, DirStat>
  /** Paths that could not be read (permission, I/O): a batch over them is not complete. */
  unreadable: string[]
  ms: number
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1')
const SQLITE_SIDE = /-(wal|shm|journal)$/
export const DB_NAME = /\.(sqlite|sqlite3|db)$/

const ENTRIES = homeEntries()
/** Paths of every `leader-data` entry: a dir of another class is entered only on the way to one. */
const LEADER_PATHS = ENTRIES.filter((e) => e.class === 'leader-data' && e.path).map((e) => e.path)
const ENTRY_PATHS = ENTRIES.filter((e) => e.path).map((e) => e.path)
const PATTERNS = ENTRIES.filter((e) => e.match).map((e) => e.match as RegExp)
/** The manifest's copy suffix (home-manifest/index.ts COPY_SUFFIX): such a name is classed by its original. */
const COPY_LIKE = /\.(bak|backup|tmp|conflicted|corrupt|unreadable|migrated)([.-][^/]*)?$/
const PROBE = 'standby-probe-name'

export function dirMayHoldLeaderData(rel: string): boolean {
  if (homePathClass(rel) === 'leader-data') return true
  return LEADER_PATHS.some((p) => p.startsWith(`${rel}/`))
}

/**
 * The class of `name` in dir `dir`, as homePathClass gives it, cached per dir. When no entry
 * path lies inside `dir`, no pattern matches the file and its name is no copy, the manifest
 * picks the same dir entry for every file there (the longest dir prefix), so the class of a
 * probe name stands for all of them; any other file goes through homePathClass itself.
 * tests/core/standby/scan.test.ts checks this against homePathClass for every manifest place.
 */
export function makeFileClass(): (dir: string, name: string) => DataClass {
  const byDir = new Map<string, DataClass | null>()
  return (dir, name) => {
    const rel = dir ? `${dir}/${name}` : name
    if (!dir || COPY_LIKE.test(name) || PATTERNS.some((re) => re.test(rel))) return homePathClass(rel)
    let cls = byDir.get(dir)
    if (cls === undefined) {
      const probe = `${dir}/${PROBE}`
      const simple = !ENTRY_PATHS.some((p) => p === dir || p.startsWith(`${dir}/`)) && !PATTERNS.some((re) => re.test(probe))
      cls = simple ? homePathClass(probe) : null
      byDir.set(dir, cls)
    }
    return cls ?? homePathClass(rel)
  }
}

export function toSourceStat(st: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): SourceStat {
  return { s: st.size, m: st.mtimeMs, c: st.ctimeMs, i: st.ino }
}

export function sameStat(a: SourceStat | undefined, b: SourceStat | undefined): boolean {
  return !!a && !!b && a.s === b.s && a.m === b.m && a.c === b.c && a.i === b.i && a.w === b.w
}

/** A tiny limiter: at most `n` of these run at once. */
export function limiter(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A slot that ends is handed straight to the next waiter, so `active` never passes `n`.
    if (active >= n) await new Promise<void>((resolve) => queue.push(resolve))
    else active++
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}

export async function isSqliteFile(abs: string): Promise<boolean> {
  let fh: fs.FileHandle | undefined
  try {
    fh = await fs.open(abs, 'r')
    const buf = Buffer.alloc(16)
    const { bytesRead } = await fh.read(buf, 0, 16, 0)
    return bytesRead === 16 && buf.equals(SQLITE_HEADER)
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** Walk `home` and return every `leader-data` file, and every dir walked. */
export async function scanHome(home: string): Promise<ScanResult> {
  const start = performance.now()
  const files = new Map<string, ScanEntry>()
  const dirs = new Map<string, DirStat>()
  const unreadable: string[] = []
  const dirSlot = limiter(32)
  const statSlot = limiter(256)
  const fileClass = makeFileClass()
  const candidates: Array<{ rel: string; abs: string }> = []

  const walk = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(home, rel) : home
    let entries: import('node:fs').Dirent[]
    try {
      entries = await dirSlot(async () => {
        // The dir's stat before its listing: a name that comes later moves the ctime past it.
        const st = await fs.lstat(abs)
        dirs.set(rel, { i: st.ino, c: st.ctimeMs })
        return fs.readdir(abs, { withFileTypes: true })
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(rel || '.')
      return
    }
    const subdirs: Promise<void>[] = []
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (dirMayHoldLeaderData(child)) subdirs.push(walk(child))
      } else if (e.isFile()) {
        if (fileClass(rel, e.name) === 'leader-data') candidates.push({ rel: child, abs: path.join(abs, e.name) })
      }
    }
    await Promise.all(subdirs)
  }
  await walk('')

  // A database's side files ride inside its snapshot: leave out every -wal/-shm/-journal whose
  // database is one.
  const names = new Set(candidates.map((c) => c.rel))
  await Promise.all(candidates.map(({ rel, abs }) => statSlot(async () => {
    const side = SQLITE_SIDE.exec(rel)
    if (side && names.has(rel.slice(0, -side[0].length)) && DB_NAME.test(rel.slice(0, -side[0].length))) {
      if (await isSqliteFile(abs.slice(0, -side[0].length))) return
    }
    let st: import('node:fs').Stats
    try {
      st = await fs.lstat(abs)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push(rel)
      return
    }
    if (!st.isFile()) return
    const db = DB_NAME.test(rel) && st.size >= 16 ? await isSqliteFile(abs) : false
    files.set(rel, { p: rel, st: toSourceStat(st), x: (st.mode & 0o111) !== 0, db })
  })))
  return { files, dirs, unreadable, ms: performance.now() - start }
}

