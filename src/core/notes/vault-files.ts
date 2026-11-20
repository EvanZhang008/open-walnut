/**
 * Reserved files at the notes vault's root. The root can move at boot (notesRoot()), so a
 * file's absolute path is asked at call time, never kept in a constant.
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { noteAbs, noteRelOf } from './note-paths.js'

/** The global notes file, vault-relative (also its key in a replica's copy). Listings leave it out. */
export const GLOBAL_NOTES_KEY = 'global-notes.md'

/** The global notes file's absolute path in the vault as it is now. */
export function globalNotesFile(): string {
  return noteAbs(GLOBAL_NOTES_KEY)
}

/**
 * Whether a vault file goes into search as a note: not the global notes file, and not a task's
 * memory folder in the one tree (memory/, projects/<p>/memory/: an agent's working notes, which
 * would crowd the user's own notes out of his results).
 */
export function searchableNote(absPath: string): boolean {
  if (path.basename(absPath) === GLOBAL_NOTES_KEY) return false
  return !/^(projects\/[^/]+\/)?memory\//.test(noteRelOf(absPath))
}

/**
 * A file Walnut itself writes in the one tree: a task's memory folder and the skills (memory/,
 * skills/, and the same under projects/<p>/). Their writers own their bytes, so the notes index
 * never stamps an id into them (each writer would drop it and the index stamp it again): such a
 * note's id comes from its path (pathNoteId).
 */
export function walnutOwnedNote(rel: string): boolean {
  return /^(projects\/[^/]+\/)?(memory|skills)\//.test(rel)
}

/** The id of a Walnut-owned note: its path's, never written into the file. */
export function pathNoteId(rel: string): string {
  return `n_w${crypto.createHash('sha1').update(rel).digest('hex').slice(0, 14)}`
}
