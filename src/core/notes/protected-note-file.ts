/**
 * The file steps both protected-note stores share (locked-note-store.ts for Lock, Show and Remove
 * lock; hidden-note-store.ts for Hide and Unhide): the note's file from a path, its bytes, the hash
 * check, and the announcement every note write makes. Each store runs them under the person's file
 * lock (withUserFileLock) and replaces the file whole (drawings/vault-files.ts replaceAtomically).
 */
import fsp from 'node:fs/promises'
import { computeContentHash } from '../../utils/file-ops.js'
import { LockedNoteError } from './locked-note.js'
import { noteRelOf, resolveNotePath } from './note-paths.js'

export interface NoteFileWritten { contentHash: string; updatedAt: string; path: string }

/** The note's file, or a 400. */
export function noteFileOf(notePath: unknown): string {
  if (typeof notePath !== 'string' || !notePath.trim()) throw new LockedNoteError('path is required', 400, 'bad_path')
  const full = resolveNotePath(notePath)
  if (!full) throw new LockedNoteError('invalid path', 400, 'bad_path')
  return full.endsWith('.md') ? full : `${full}.md`
}

/** The file's text and when it last changed, or a 404. */
export async function readNoteFile(file: string): Promise<{ text: string; updatedAt: string }> {
  try {
    const text = await fsp.readFile(file, 'utf-8')
    const st = await fsp.stat(file)
    return { text, updatedAt: st.mtime.toISOString() }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LockedNoteError('Note not found', 404, 'not_found')
    throw err
  }
}

/** A 409 with the current hash when the caller names a hash the file no longer has. */
export function checkNoteHash(text: string, expectedHash: unknown): void {
  if (typeof expectedHash !== 'string' || !expectedHash) return
  const currentHash = computeContentHash(text)
  if (currentHash !== expectedHash) throw new LockedNoteError('The note changed since it was read', 409, 'conflict', { currentHash })
}

/** Announce the write as every note write does, and answer what was written. */
export async function noteWritten(file: string, text: string): Promise<NoteFileWritten> {
  const contentHash = computeContentHash(text)
  const { bus, EventNames } = await import('../event-bus.js')
  // source format `notes/{path}` is a shared contract with notes-v2.ts and useNoteContent.ts
  bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${noteRelOf(file).replace(/\.md$/, '')}`, contentHash }, ['web-ui'])
  return { contentHash, updatedAt: (await fsp.stat(file)).mtime.toISOString(), path: noteRelOf(file) }
}
