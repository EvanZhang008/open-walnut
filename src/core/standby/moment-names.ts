/**
 * Which paths existed at a batch's moment. The first scan is older than the moment, so a file
 * made between the two (and changed or removed after it) is in neither scan's view of the
 * moment; this module asks the dirs instead, inside the hold, right after the moment.
 *
 * A name added to, removed from or renamed in a dir moves the dir's ctime. So, for each dir
 * the first scan walked (it noted the dir's stat before listing it):
 *   - unchanged at the hold, and its ctime below the clock read before the scan: no name came
 *     or went since that listing, so the names at the moment are the scan's (a ctime at or past
 *     that clock may share a tick with a later change, which then does not move it);
 *   - otherwise: list it again now; when its ctime, read after that listing, is still below
 *     the moment, its last change came before the moment and the listing is the moment's;
 *     else it also changed at or after the moment, and the names at the moment cannot be told
 *     (`unsettled`: the batch is void).
 * A new dir under a changed one is listed the same way. A path existed when every dir above it
 * existed and named the next step.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { DB_NAME, dirMayHoldLeaderData, limiter, makeFileClass, type ScanResult } from './scan.js'

interface DirAtMoment {
  /** Names in the dir at the moment (leader-data files and the subdirs the walk enters). */
  names: Set<string>
}

export interface MomentNames {
  /** true: `rel` existed at the moment; false: it did not; null: cannot tell. */
  existed(rel: string): boolean | null
  /** Every file named by a dir listed again (a changed dir), relative: the moment's new names among them. */
  listed: string[]
  /** Dirs listed again (changed since the scan, or changed in its tick). */
  changedDirs: number
  /** Dirs that changed at or after the moment too: the batch is void. */
  unsettled: string[]
  ms: number
}

const SIDE = /-(wal|shm|journal)$/

/** The first scan's names per dir. */
function scanNames(s1: ScanResult): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (rel: string) => {
    const dir = path.posix.dirname(rel)
    const key = dir === '.' ? '' : dir
    let set = out.get(key)
    if (!set) out.set(key, (set = new Set()))
    set.add(path.posix.basename(rel))
  }
  for (const rel of s1.files.keys()) add(rel)
  for (const rel of s1.dirs.keys()) if (rel) add(rel)
  return out
}

/** Read inside the hold, after the moment (`momentMs`); `scanClock` was read just before the scan, both on the filesystem's clock. */
export async function namesAtMoment(home: string, s1: ScanResult, momentMs: number, scanClock: number): Promise<MomentNames> {
  const start = performance.now()
  const slot = limiter(64)
  const fileClass = makeFileClass()
  const fromScan = scanNames(s1)
  const changed = new Map<string, DirAtMoment | 'gone'>()
  const listed: string[] = []
  const unsettled: string[] = []

  const list = async (rel: string): Promise<void> => {
    const abs = rel ? path.join(home, rel) : home
    let entries: import('node:fs').Dirent[]
    try {
      entries = await slot(() => fs.readdir(abs, { withFileTypes: true }))
    } catch {
      changed.set(rel, 'gone')
      return
    }
    const names = new Set<string>()
    const fresh: string[] = []
    const files: string[] = []
    const all = new Set(entries.map((e) => e.name))
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!dirMayHoldLeaderData(child)) continue
        names.add(e.name)
        if (!s1.dirs.has(child)) fresh.push(child)
      } else if (e.isFile() && fileClass(rel, e.name) === 'leader-data') {
        // A database's side files are never a batch's plain files.
        const side = SIDE.exec(e.name)
        if (side && all.has(e.name.slice(0, -side[0].length)) && DB_NAME.test(e.name.slice(0, -side[0].length))) continue
        names.add(e.name)
        files.push(child)
      }
    }
    const after = await fs.lstat(abs).catch(() => null)
    if (!after || after.ctimeMs >= momentMs) unsettled.push(rel)
    changed.set(rel, { names })
    listed.push(...files)
    await Promise.all(fresh.map((d) => list(d)))
  }

  const moved: string[] = []
  await Promise.all([...s1.dirs].map(([rel, was]) => slot(async () => {
    const st = await fs.lstat(rel ? path.join(home, rel) : home).catch(() => null)
    if (!st || st.ino !== was.i || st.ctimeMs !== was.c || was.c >= scanClock) moved.push(rel)
  })))
  await Promise.all(moved.map((rel) => list(rel)))

  /** Did dir `dir` name `name` at the moment? */
  const named = (dir: string, name: string): boolean | null => {
    const c = changed.get(dir)
    if (c === undefined) {
      // Unchanged since the first scan (or never walked: then nothing of the batch is in it).
      return fromScan.get(dir)?.has(name) ?? false
    }
    if (c === 'gone') return null
    return c.names.has(name)
  }
  const existed = (rel: string): boolean | null => {
    const parts = rel.split('/')
    let dir = ''
    let known: boolean | null = true
    for (const part of parts) {
      const step = named(dir, part)
      if (step === false) return false
      if (step === null) known = null
      dir = dir ? `${dir}/${part}` : part
    }
    return known
  }
  return { existed, listed, changedDirs: moved.length, unsettled, ms: performance.now() - start }
}
