/**
 * The standby target's directory, its files and the small I/O helpers its writers share.
 *
 *   standby.json       which batch is current (written last: the one step that makes a batch current)
 *   batches/<n>.json   the manifest of batch n (the current one, and the one before while a batch applies)
 *   chunks/<aa>/<id>   content chunks, named by their sha256
 *   copy/              the copy of the leader's home, read-only on disk (owner only, like the whole target)
 *   copy-stat.json     each copied file's stat as written, so a verify pass sees a direct edit cheaply
 *   .apply/            a batch being made current: journal.json, new/ (its files), old/ (what they replace)
 *   drift/<time>/      what a verify pass found changed in copy/, saved before it was repaired
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { CHUNK_ID } from './chunks.js'
import { STANDBY_FORMAT, STANDBY_VERSION, type BatchFile, type BatchManifest, type StandbyState } from './types.js'

/** The copy holds credentials too: its owner may read it, nobody else, and nobody may write it. */
export const FILE_MODE = 0o400
export const EXEC_MODE = 0o500
export const DIR_MODE = 0o500
export const OPEN_DIR_MODE = 0o700

export interface TargetPaths {
  root: string
  state: string
  batches: string
  chunks: string
  copy: string
  copyStat: string
  apply: string
  journal: string
  applyNew: string
  applyOld: string
  drift: string
}

export function targetPaths(root: string): TargetPaths {
  const apply = path.join(root, '.apply')
  return {
    root,
    state: path.join(root, 'standby.json'),
    batches: path.join(root, 'batches'),
    chunks: path.join(root, 'chunks'),
    copy: path.join(root, 'copy'),
    copyStat: path.join(root, 'copy-stat.json'),
    apply,
    journal: path.join(apply, 'journal.json'),
    applyNew: path.join(apply, 'new'),
    applyOld: path.join(apply, 'old'),
    drift: path.join(root, 'drift'),
  }
}

export function chunkPath(t: TargetPaths, id: string): string {
  if (!CHUNK_ID.test(id)) throw new Error(`not a chunk id: ${id}`)
  return path.join(t.chunks, id.slice(0, 2), id)
}

export function manifestPath(t: TargetPaths, batch: number): string {
  return path.join(t.batches, `${batch}.json`)
}

/** Whether resolved path `a` is `b` or lies under it (`/` contains everything). */
export function pathInside(a: string, b: string): boolean {
  const rel = path.relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Refuse a target inside the home (it would copy itself) or a home inside the target. */
export async function checkTargetPlace(home: string, dir: string): Promise<void> {
  const inside = pathInside
  // As written and with symlinks resolved: a link to the home (or into it) is the home.
  for (const [h, d] of [[path.resolve(home), path.resolve(dir)], [await realPart(home), await realPart(dir)]]) {
    if (inside(d, h) || inside(h, d)) throw new Error(`the standby target ${path.resolve(dir)} and the home ${path.resolve(home)} must not contain each other`)
  }
}

/** `p` with symlinks resolved in the part of it that exists; the rest appended as written. */
async function realPart(p: string): Promise<string> {
  const rest: string[] = []
  for (let cur = path.resolve(p); ;) {
    try {
      return path.join(await fs.realpath(cur), ...rest)
    } catch {
      const up = path.dirname(cur)
      if (up === cur) return path.resolve(p)
      rest.unshift(path.basename(cur))
      cur = up
    }
  }
}

/** A relative path of a batch, refused if it could leave the copy. */
export function safeRel(rel: string): string {
  // A backslash is a separator only on Windows; elsewhere `a\b.md` is a fine note name.
  if (!rel || rel.startsWith('/') || (process.platform === 'win32' && rel.includes('\\')) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`unsafe path in a batch: ${JSON.stringify(rel)}`)
  }
  return rel
}

/** fsync a file or dir by path (best effort for dirs on platforms that refuse it). */
export async function fsyncPath(p: string): Promise<void> {
  const fh = await fs.open(p, 'r')
  try {
    await fh.sync()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EINVAL' && (err as NodeJS.ErrnoException).code !== 'EISDIR') throw err
  } finally {
    await fh.close()
  }
}

/** Write a file durably: a temp file, fsync, rename over, fsync the dir. */
export async function writeDurable(file: string, data: string | Buffer, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  const fh = await fs.open(tmp, 'w', mode)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await fs.rename(tmp, file)
  await fsyncPath(path.dirname(file))
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export function emptyState(): StandbyState {
  return { format: STANDBY_FORMAT, version: STANDBY_VERSION, current: null }
}

export async function readState(t: TargetPaths): Promise<StandbyState> {
  const s = await readJson<StandbyState>(t.state)
  if (!s) return emptyState()
  if (s.format !== STANDBY_FORMAT) throw new Error(`${t.state} is not a standby copy`)
  if (s.version > STANDBY_VERSION) throw new Error(`${t.state} was written by a newer Walnut (version ${s.version})`)
  return s
}

export async function writeState(t: TargetPaths, s: StandbyState): Promise<void> {
  await writeDurable(t.state, `${JSON.stringify(s, null, 2)}\n`)
}

export async function readManifest(t: TargetPaths, batch: number): Promise<BatchManifest> {
  const m = await readJson<BatchManifest>(manifestPath(t, batch))
  if (!m) throw new Error(`the manifest of batch ${batch} is missing`)
  return m
}

export async function currentFiles(t: TargetPaths, s: StandbyState): Promise<BatchFile[]> {
  return (await currentBatch(t, s)).files
}

/** The current batch's files and dirs (none before the first batch). */
export async function currentBatch(t: TargetPaths, s: StandbyState): Promise<{ files: BatchFile[]; dirs: string[] }> {
  if (!s.current) return { files: [], dirs: [] }
  const m = await readManifest(t, s.current.manifest)
  return { files: m.files, dirs: m.dirs ?? [] }
}

/** [ino, size, mtimeMs, ctimeMs, mode] of a copied file as written. */
export type CopyStat = [number, number, number, number, number]
export type CopyStats = Record<string, CopyStat>

export async function readCopyStats(t: TargetPaths): Promise<CopyStats> {
  return (await readJson<CopyStats>(t.copyStat).catch(() => null)) ?? {}
}

export async function writeCopyStats(t: TargetPaths, stats: CopyStats): Promise<void> {
  await writeDurable(t.copyStat, JSON.stringify(stats))
}

export function copyStatOf(st: import('node:fs').Stats): CopyStat {
  return [st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode & 0o777]
}

/**
 * Make every dir from `rel`'s parent up to the copy's root writable (for a rename inside it).
 * Refuses a path through anything but a real dir (a link put there could point outside the
 * copy); verify moves such an entry aside first.
 */
export async function openDirs(copyRoot: string, rel: string, opened: Set<string>): Promise<void> {
  const parts = rel.split('/').slice(0, -1)
  let dir = copyRoot
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) dir = path.join(dir, parts[i - 1])
    if (opened.has(dir)) continue
    const st = await fs.lstat(dir).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    if (st && !st.isDirectory()) throw Object.assign(new Error(`${dir} is not a dir in the copy`), { code: 'ENOTDIR' })
    if (st) await fs.chmod(dir, OPEN_DIR_MODE)
    else await fs.mkdir(dir, { mode: OPEN_DIR_MODE })
    opened.add(dir)
  }
}

/** Put the read-only mode back on dirs a writer opened (deepest first). */
export async function closeDirs(opened: Iterable<string>): Promise<void> {
  const dirs = [...opened].sort((a, b) => b.length - a.length)
  for (const dir of dirs) await fs.chmod(dir, DIR_MODE).catch(() => {})
}

/** Remove a tree that may hold read-only dirs. */
export async function removeTree(p: string): Promise<void> {
  const st = await fs.lstat(p).catch(() => null)
  if (!st) return
  if (st.isDirectory()) {
    await fs.chmod(p, OPEN_DIR_MODE).catch(() => {})
    for (const name of await fs.readdir(p)) await removeTree(path.join(p, name))
    await fs.rmdir(p)
  } else {
    await fs.rm(p, { force: true })
  }
}

export interface TreeListing {
  files: string[]
  /** Neither a file nor a dir: a link, a socket. Never entered. */
  others: string[]
  /** Every dir below the root, with its mode. */
  dirs: Array<{ rel: string; mode: number }>
}

/**
 * Every entry under `root` (relative, '/'-separated). A dir it cannot read is opened (and
 * added to `opened`, for closeDirs), so a chmod in the copy cannot hide what is in it.
 */
export async function listTree(root: string, opened?: Set<string>, rel = '', out: TreeListing = { files: [], others: [], dirs: [] }): Promise<TreeListing> {
  const abs = rel ? path.join(root, rel) : root
  const read = () => fs.readdir(abs, { withFileTypes: true })
  const entries = await read().catch(async (err) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return []
    if (code !== 'EACCES' || !opened) throw err
    await fs.chmod(abs, OPEN_DIR_MODE)
    opened.add(abs)
    return read()
  })
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      const st = await fs.lstat(path.join(root, child))
      out.dirs.push({ rel: child, mode: st.mode & 0o777 })
      await listTree(root, opened, child, out)
    } else if (e.isFile()) out.files.push(child)
    else out.others.push(child)
  }
  return out
}

/** Remove a dir that holds only (empty) dirs; throws ENOTEMPTY when any file is in it. */
export async function removeEmptyDirs(p: string): Promise<void> {
  // Never a chmod through a path that is no dir (a file the batch put where a dir was).
  if (!(await fs.lstat(p)).isDirectory()) throw Object.assign(new Error(`${p} is not a dir`), { code: 'ENOTDIR' })
  await fs.chmod(p, OPEN_DIR_MODE)
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    if (!e.isDirectory()) throw Object.assign(new Error(`${p} is not empty`), { code: 'ENOTEMPTY' })
    await removeEmptyDirs(path.join(p, e.name))
  }
  await fs.rmdir(p)
}

/** Remove the dirs above `rel` (inside the copy) that a delete left empty, up to one in `keep` (a dir the batch lists, or one above it). */
export async function pruneEmptyParents(copyRoot: string, rel: string, keep?: ReadonlySet<string>): Promise<void> {
  let dir = path.dirname(rel)
  while (dir !== '.' && !keep?.has(dir)) {
    const abs = path.join(copyRoot, dir)
    const parent = path.dirname(abs)
    const names = await fs.readdir(abs).catch(() => null)
    if (!names || names.length) return
    await fs.chmod(parent, OPEN_DIR_MODE).catch(() => {})
    try {
      await fs.rmdir(abs)
    } finally {
      await fs.chmod(parent, DIR_MODE).catch(() => {})
    }
    dir = path.dirname(dir)
  }
}
