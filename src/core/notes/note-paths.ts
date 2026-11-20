/**
 * The one way a note path becomes a file in the notes vault, and back.
 *
 * Every caller-given vault-relative path (a route's `*path`, a plugin's `notes.read`, a
 * journal record from a host that was away, a drawing's scene path, a companion's note key)
 * goes through here, and every resolver asks `movedNotePath` before it joins the root, so
 * one edit there makes every way in follow a note that moved. A raw join of the root
 * outside this file is refused by tests/core/notes/note-paths.test.ts.
 *
 *   normalizeNotePath  a caller's raw path -> a clean relative path, or null (no move)
 *   noteKey            the same, then where that note lives now (a key, not a file)
 *   resolveNotePath    a caller's raw path -> an absolute path inside the vault, or null
 *   noteAbs            a relative path the code already trusts -> its absolute path
 *   noteRelOf          an absolute path -> its vault-relative path (forward slashes)
 *   realNoteFile       a clean relative path checked against the REAL vault (no symlinked
 *                      file, no folder that leads out); ensureRealNoteDir makes a folder so
 *
 * Callers differ in what they refuse, and each keeps its own rules through the options; no
 * option loosens a check another caller makes. Callers raise their own error types: these
 * functions answer null or a refusal reason, never throw on a bad path.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../../constants.js'
import { movedNotePath } from './note-path-moves.js'

export { movedNotePath }

/** The vault root. Today the fixed notes folder; a later change lets notes live elsewhere. */
export function notesRoot(): string {
  return NOTES_DIR
}

/** What a caller refuses or tidies beyond the common steps (slashes, leading "/"). */
export interface NotePathRules {
  /** Trim surrounding whitespace first. */
  trim?: boolean
  /** Drop a leading "./" before the leading slashes. */
  dropDotSlash?: boolean
  /** Drop trailing slashes (a folder named either way). */
  dropTrailingSlash?: boolean
  /** Append ".md" unless the path already ends in it (any case). */
  addMd?: boolean
  /** Refuse a ".." segment (otherwise only the containment check guards an escape). */
  refuseDotDot?: boolean
  /** Refuse a "." segment. */
  refuseDot?: boolean
  /** Refuse an empty segment ("a//b", a trailing "/"). */
  refuseEmptySegment?: boolean
  /** Refuse any segment that starts with "." (hidden files, "." and ".." too). */
  refuseHidden?: boolean
  /** Refuse ASCII control characters. */
  refuseControl?: boolean
  /** Refuse a path longer than this (after ".md" is added). */
  maxLength?: number
}

const CONTROL = /[\u0000-\u001f\u007f]/

function passes(s: string, rules: NotePathRules): boolean {
  if (rules.refuseControl && CONTROL.test(s)) return false
  if (rules.refuseDotDot || rules.refuseDot || rules.refuseEmptySegment || rules.refuseHidden) {
    for (const seg of s.split('/')) {
      if (rules.refuseDotDot && seg === '..') return false
      if (rules.refuseDot && seg === '.') return false
      if (rules.refuseEmptySegment && seg === '') return false
      if (rules.refuseHidden && seg.startsWith('.')) return false
    }
  }
  return rules.maxLength === undefined || s.length <= rules.maxLength
}

/**
 * A caller's raw relative path, cleaned: backslashes become "/" and leading slashes go (so
 * an absolute-looking `/x` means the vault's `x`). Null when nothing is left or a rule
 * refuses it. No percent-decoding: only the attachment resolver decodes, and it does so
 * itself before it asks here. Does NOT follow a move (noteKey and resolveNotePath do).
 */
export function normalizeNotePath(raw: string, rules: NotePathRules = {}): string | null {
  let s = (rules.trim ? raw.trim() : raw).replace(/\\/g, '/')
  if (rules.dropDotSlash) s = s.replace(/^\.\/+/, '')
  s = s.replace(/^\/+/, '')
  if (rules.dropTrailingSlash) s = s.replace(/\/+$/, '')
  if (!s) return null
  if (rules.addMd && !/\.md$/i.test(s)) s += '.md'
  return passes(s, rules) ? s : null
}

/**
 * A caller's raw path as a vault-relative key of the note's place NOW: normalized, then
 * moved. The moved path meets the same rules.
 */
export function noteKey(raw: string, rules: NotePathRules = {}): string | null {
  const rel = normalizeNotePath(raw, rules)
  if (rel === null) return null
  const moved = movedNotePath(rel)
  return moved === rel || passes(moved, rules) ? moved : null
}

export interface ResolveNotePathOptions extends NotePathRules {
  /** The vault root itself is an answer too (otherwise only paths strictly inside it). */
  allowRoot?: boolean
}

/**
 * A caller's raw path as an absolute path inside the vault, or null: normalized, moved,
 * resolved against the root, and refused unless it stays inside (strictly inside unless
 * `allowRoot`). `path.resolve` collapses `a/../b`, so an escape such as `a/../../x` fails
 * the containment check even when no rule refuses "..".
 */
export function resolveNotePath(raw: string, opts: ResolveNotePathOptions = {}): string | null {
  const rel = normalizeNotePath(raw, opts)
  if (rel === null) return null
  const root = notesRoot()
  const abs = path.resolve(root, movedNotePath(rel))
  if (abs.startsWith(root + path.sep) || (opts.allowRoot && abs === root)) return abs
  return null
}

/**
 * The absolute path of a vault-relative path the code already holds (a path read from the
 * vault, the index, a watcher event, a fixed folder). Moved, then joined: like the
 * `path.join` it replaces, it does not check containment.
 */
export function noteAbs(rel: string): string {
  return path.join(notesRoot(), movedNotePath(rel))
}

/** The vault-relative path (forward slashes) of an absolute path. "../x" when outside. */
export function noteRelOf(abs: string): string {
  return path.relative(notesRoot(), abs).replace(/\\/g, '/')
}

/** `child` is strictly inside `root` (both absolute). */
export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** The vault's real path (symlinks in the path to it resolved), made when missing. */
export async function realNotesRoot(): Promise<string> {
  const root = notesRoot()
  await fsp.mkdir(root, { recursive: true })
  return fsp.realpath(root)
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
 * Why a real-vault check refused a path: `invalid` it leaves the vault as written,
 * `outside` a folder on the way resolves outside the real vault, `linked` the file itself
 * is a symlink.
 */
export type RealNotePathRefusal = 'invalid' | 'outside' | 'linked'
export type RealNotePath = { ok: true; abs: string } | { ok: false; refused: RealNotePathRefusal }

/**
 * A vault file checked against the REAL vault: moved, joined, and refused when it is not
 * strictly inside the vault, when its nearest existing folder resolves outside the real
 * vault, or when the file is a symlink. `rel` is already clean (no "..", no empty segment).
 * Filesystem errors other than a missing path are thrown.
 */
export async function realNoteFile(rel: string): Promise<RealNotePath> {
  const root = await realNotesRoot()
  const abs = noteAbs(rel)
  if (!isInside(abs, notesRoot())) return { ok: false, refused: 'invalid' }
  const realDir = await nearestRealDir(path.dirname(abs))
  if (realDir !== root && !isInside(realDir, root)) return { ok: false, refused: 'outside' }
  try {
    if ((await fsp.lstat(abs)).isSymbolicLink()) return { ok: false, refused: 'linked' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return { ok: true, abs }
}

/**
 * Make a vault folder, refused (`outside`) when a part of it leads out of the real vault,
 * before or after it is made. The made folder must be strictly inside the vault.
 */
export async function ensureRealNoteDir(relDir: string): Promise<RealNotePath> {
  const root = await realNotesRoot()
  const abs = noteAbs(relDir)
  const before = await nearestRealDir(abs)
  if (before !== root && !isInside(before, root)) return { ok: false, refused: 'outside' }
  await fsp.mkdir(abs, { recursive: true })
  const after = await fsp.realpath(abs)
  if (!isInside(after, root)) return { ok: false, refused: 'outside' }
  return { ok: true, abs }
}
