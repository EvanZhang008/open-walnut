/**
 * The standby target's directory, its files and the small I/O helpers its writers share.
 *
 *   standby.json       which batch is current (written last: the one step that makes a batch current)
 *   batches/<n>.json   the manifest of batch n (the current one, and the one before while a batch applies)
 *   chunks/<aa>/<id>   content chunks, named by their sha256
 *   copy/              the copy of the leader's home, read-only on disk
 *   copy-stat.json     each copied file's stat as written, so a verify pass sees a direct edit cheaply
 *   .apply/            a batch being made current: journal.json, new/ (its files), old/ (what they replace)
 *   drift/<time>/      what a verify pass found changed in copy/, saved before it was repaired
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { CHUNK_ID } from './chunks.js'
import { STANDBY_FORMAT, STANDBY_VERSION, type BatchFile, type BatchManifest, type StandbyState } from './types.js'

export const FILE_MODE = 0o444
export const EXEC_MODE = 0o555
export const DIR_MODE = 0o555
export const OPEN_DIR_MODE = 0o755

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

/** A relative path of a batch, refused if it could leave the copy. */
export function safeRel(rel: string): string {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
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
  await fs.mkdir(path.dirname(file), { recursive: true })
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
  return s.current ? (await readManifest(t, s.current.manifest)).files : []
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

/** Make every dir from `rel`'s parent up to the copy's root writable (for a rename inside it). */
export async function openDirs(copyRoot: string, rel: string, opened: Set<string>): Promise<void> {
  const parts = rel.split('/').slice(0, -1)
  let dir = copyRoot
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) dir = path.join(dir, parts[i - 1])
    if (opened.has(dir)) continue
    try {
      await fs.chmod(dir, OPEN_DIR_MODE)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      await fs.mkdir(dir, { mode: OPEN_DIR_MODE })
    }
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

/** Every file under `root` (relative, '/'-separated), and every non-file, non-dir entry as well. */
export async function listTree(root: string, rel = '', out: { files: string[]; others: string[] } = { files: [], others: [] }): Promise<{ files: string[]; others: string[] }> {
  const entries = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  })
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) await listTree(root, child, out)
    else if (e.isFile()) out.files.push(child)
    else out.others.push(child)
  }
  return out
}

/** Remove a dir that holds only (empty) dirs; throws ENOTEMPTY when any file is in it. */
export async function removeEmptyDirs(p: string): Promise<void> {
  await fs.chmod(p, OPEN_DIR_MODE)
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    if (!e.isDirectory()) throw Object.assign(new Error(`${p} is not empty`), { code: 'ENOTEMPTY' })
    await removeEmptyDirs(path.join(p, e.name))
  }
  await fs.rmdir(p)
}

/** Remove the dirs above `rel` (inside the copy) that a delete left empty. */
export async function pruneEmptyParents(copyRoot: string, rel: string): Promise<void> {
  let dir = path.dirname(rel)
  while (dir !== '.') {
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
