/**
 * The file steps drawings take in the Notes vault (store.ts): paths resolved against the REAL
 * vault (no symlinked file, no folder that leads out), whole-file replacement by a flushed temp
 * file and rename, and exclusive creation. Every temp file is hidden (a leading dot, so the Notes
 * tree never lists it) and removed when its write fails.
 */

import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { NOTES_DIR } from '../../constants.js'
import { DrawingInputError, MAX_SCENE_BYTES } from './scene.js'

export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

export async function vaultReal(): Promise<string> {
  await fsp.mkdir(NOTES_DIR, { recursive: true })
  return fsp.realpath(NOTES_DIR)
}

/** The real path of the nearest existing folder at or above `dir`. */
async function nearestRealDir(dir: string): Promise<string> {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      return await fsp.realpath(d)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(d) === d) throw err
    }
  }
}

/**
 * The absolute path of a vault file, refused when its folder resolves outside the real vault or
 * the file itself is a symlink. `rel` is already clean (paths.ts).
 */
export async function resolveVaultFile(rel: string): Promise<string> {
  const root = await vaultReal()
  const abs = path.join(NOTES_DIR, ...rel.split('/'))
  if (!isInside(abs, NOTES_DIR)) throw new DrawingInputError('invalid path')
  const realDir = await nearestRealDir(path.dirname(abs))
  if (realDir !== root && !isInside(realDir, root)) throw new DrawingInputError('path leads outside Notes')
  try {
    if ((await fsp.lstat(abs)).isSymbolicLink()) throw new DrawingInputError('a linked file is not a drawing Walnut writes')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return abs
}

/** Make a vault folder, checking that no part of it leads out of the vault. */
export async function ensureVaultDir(relDir: string): Promise<void> {
  const root = await vaultReal()
  const abs = path.join(NOTES_DIR, ...relDir.split('/'))
  const before = await nearestRealDir(abs)
  if (before !== root && !isInside(before, root)) throw new DrawingInputError('path leads outside Notes')
  await fsp.mkdir(abs, { recursive: true })
  const after = await fsp.realpath(abs)
  if (!isInside(after, root)) throw new DrawingInputError('path leads outside Notes')
}

export function tempPathFor(abs: string): string {
  return path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
}

/** Write `bytes` to a NEW file at `target` (O_EXCL) and flush it; a failed write removes what it made. */
async function writeNewFile(target: string, bytes: string): Promise<void> {
  const handle = await fsp.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o644)
  try {
    await handle.writeFile(bytes, 'utf-8')
    await handle.sync()
  } catch (err) {
    await handle.close().catch(() => {})
    await fsp.rm(target, { force: true }).catch(() => {})
    throw err
  }
  await handle.close()
}

async function writeTemp(abs: string, bytes: string): Promise<string> {
  const tmp = tempPathFor(abs)
  await writeNewFile(tmp, bytes)
  return tmp
}

/** Replace a file's bytes whole: temp in the same folder, flushed, then rename. */
export async function replaceAtomically(abs: string, bytes: string): Promise<void> {
  const tmp = await writeTemp(abs, bytes)
  try {
    await fsp.rename(tmp, abs)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/** Create a file only if nothing is at its path. False when something already is. */
export async function createExclusively(abs: string, bytes: string): Promise<boolean> {
  const tmp = await writeTemp(abs, bytes)
  try {
    await fsp.link(tmp, abs)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err
    // A file system without hard links: an exclusive create of the file itself. It is ours from
    // the open on (O_EXCL), so a failed write removes only what this call made.
    try {
      await writeNewFile(abs, bytes)
      return true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw e
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * Which file is at a path, cheaply: a rename-replace gives a new inode, and any write a new mtime
 * or size. The companion compares it to skip work for a scene that changed again since.
 */
export interface FileIdentity { ino: number; mtimeMs: number; size: number }

export function sameIdentity(a: FileIdentity | null, b: FileIdentity | null): boolean {
  return !!a && !!b && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size
}

export async function fileIdentity(abs: string): Promise<FileIdentity | null> {
  try {
    const st = await fsp.lstat(abs)
    return st.isFile() ? { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size } : null
  } catch {
    return null
  }
}

/** A scene file's bytes and identity; 404 when missing, 413 when over MAX_SCENE_BYTES. */
export async function readSceneFile(abs: string): Promise<{ bytes: string; identity: FileIdentity }> {
  let stat
  try {
    stat = await fsp.stat(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new DrawingInputError('Drawing not found', 404)
    throw err
  }
  if (!stat.isFile()) throw new DrawingInputError('Drawing not found', 404)
  if (stat.size > MAX_SCENE_BYTES) throw new DrawingInputError(`This drawing is larger than ${MAX_SCENE_BYTES} bytes`, 413)
  const bytes = await fsp.readFile(abs, 'utf-8')
  return { bytes, identity: { ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size } }
}

/** A file's text, or null when nothing is there. */
export async function readOrNull(abs: string): Promise<string | null> {
  try {
    return await fsp.readFile(abs, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Move a file that goes with a scene (its companion note, its walkthroughs) to its new path with
 * `bytes` as its content. False when something else already is at the new path. Only the letter
 * case changing is one file on a case-insensitive disk: it is rewritten and renamed in place.
 */
export async function moveBesideScene(from: { rel: string; abs: string }, to: { rel: string; abs: string }, bytes: string): Promise<boolean> {
  if (from.rel.toLowerCase() === to.rel.toLowerCase()) {
    const there = await fileIdentity(to.abs)
    const mine = await fileIdentity(from.abs)
    if (there && (!mine || there.ino !== mine.ino)) return false
    await replaceAtomically(from.abs, bytes)
    await fsp.rename(from.abs, to.abs)
    return true
  }
  if (!(await createExclusively(to.abs, bytes))) return false
  await fsp.unlink(from.abs)
  return true
}
