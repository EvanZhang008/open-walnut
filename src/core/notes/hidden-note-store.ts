/**
 * Hide and Unhide (docs/reference/locked-notes.md, "Hidden notes"): the person keeps one note away
 * from agents without a password. Hide adds the line `walnut_hidden: 1` to the note's first
 * frontmatter block (a new block when it has none, its id stamped first so links keep it); Unhide
 * takes it out. The text stays plain on disk. Only the person reaches these (routes/hidden-notes-v1.ts).
 *
 * Both run under the person's file lock with the hash check, and replace the file whole. A locked
 * note is neither hidden nor unhidden here (409 `note_locked`: Remove lock first), and a note Walnut
 * writes itself is never hidden (400 `not_lockable`), as Lock refuses it.
 */
import { computeContentHash } from '../../utils/file-ops.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { withNoteId } from '../parse-frontmatter.js'
import { replaceAtomically } from '../drawings/vault-files.js'
import { LockedNoteError, noteProtection, withHiddenMark, withoutHiddenMark } from './locked-note.js'
import { noteRelOf } from './note-paths.js'
import { walnutWritesNote } from './vault-files.js'
import { checkNoteHash, noteFileOf, noteWritten, readNoteFile, type NoteFileWritten } from './protected-note-file.js'

export interface HiddenNoteChange extends NoteFileWritten {
  /** Whether the file changed (false: it already was as asked). */
  changed: boolean
}

const LOCKED_HERE = 'This note is locked: its text is encrypted, so it is already hidden from agents. Remove its lock first to hide or unhide it.'

async function rewrite(file: string, expectedHash: unknown, change: (text: string) => string): Promise<HiddenNoteChange> {
  const out = await withUserFileLock(file, async () => {
    const { text, updatedAt } = await readNoteFile(file)
    if (noteProtection(text) === 'locked') throw new LockedNoteError(LOCKED_HERE, 409, 'note_locked')
    checkNoteHash(text, expectedHash)
    const next = change(text)
    if (next === text) return { text, updatedAt, changed: false }
    await replaceAtomically(file, next)
    return { text: next, updatedAt, changed: true }
  })
  if (!out.changed) return { contentHash: computeContentHash(out.text), updatedAt: out.updatedAt, path: noteRelOf(file), changed: false }
  return { ...(await noteWritten(file, out.text)), changed: true }
}

/** Hide a note: its text stays as it is, under a frontmatter that carries the mark. */
export async function hideNote(notePath: unknown, expectedHash: unknown): Promise<HiddenNoteChange> {
  const file = noteFileOf(notePath)
  const rel = noteRelOf(file)
  if (walnutWritesNote(rel)) throw new LockedNoteError('Walnut writes this note itself, so it cannot be hidden', 400, 'not_lockable')
  const done = await rewrite(file, expectedHash, (text) => (noteProtection(text) === 'hidden' ? text : withHiddenMark(withNoteId(text, text).content)))
  // The indexes go to the stub at once. No wipe of what they freed: the file itself is plain text.
  if (done.changed) void import('./locked-note-residue.js').then((m) => m.wipeLockedNoteResidue(rel, file, { wipe: false }))
  return done
}

/** Unhide a note: the mark goes, and agents, search and sync read it again. */
export async function unhideNote(notePath: unknown, expectedHash: unknown): Promise<HiddenNoteChange> {
  return rewrite(noteFileOf(notePath), expectedHash, withoutHiddenMark)
}
