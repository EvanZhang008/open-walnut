/**
 * A locked note on disk (docs/reference/locked-notes.md): a note the person locked with the Walnut
 * master password, so its text is ciphertext in the file and every reader that is not the person
 * (agents, the search index, embeddings, replicas, git, backups, an older client) sees only the
 * stub, a short paragraph saying what the note is.
 *
 * The file format and its one parse live in locked-note-format.ts (no I/O, shared with the web);
 * this module adds the guards every write path calls. The ciphertext holds the note's whole text
 * as it was (its own frontmatter included). The envelope is one HTML comment line, so Obsidian and
 * every Markdown renderer hide it, and base64 never holds `-->`. The outer frontmatter keeps the
 * note's id, so links, favorites, moves and the index follow the note as before. No key access
 * here (locked-note-store.ts), and nothing heavier than a file read, so every write path can load
 * the guards at start.
 *
 * The same guards keep a hidden note (plain on disk, the mark `walnut_hidden: 1`) the person's: every
 * writer that is not the person is refused, and every reader gets its stub (readableNoteText).
 */
import fsp from 'node:fs/promises'
import { hasHiddenMark, noteProtection } from './locked-note-format.js'

export {
  HIDDEN_FRONTMATTER_KEY, HIDDEN_NOTE_STUB, HIDDEN_STUB_LEAD, LOCKED_ENVELOPE_VERSION, LOCKED_FRONTMATTER_KEY,
  LOCKED_NOTE_STUB, LOCKED_STUB_LEAD, buildLockedNoteText, hasHiddenMark, hasLockMark, isHiddenNoteText,
  isLockedNoteText, lockedNoteAad, looksLockedNoteText, looksProtectedNoteText, noteForReader, noteProtection,
  parseLockedNote, readableNoteText, withHiddenMark, withoutHiddenMark,
  type LockedEnvelope, type NoteProtection, type ParsedLockedNote,
} from './locked-note-format.js'

/** What an agent is told when it reads, writes or deletes a locked note. */
export const LOCKED_NOTE_AGENT_TEXT =
  'This note is locked by the user: it is private, hand-written and very sensitive. Its text is encrypted ' +
  'with their master password, and Walnut does not show it to agents or let agents change it. ' +
  'Do not try to read or decrypt the file. If the task truly needs it, ask the user.'

/** What an agent is told when it reads, writes or deletes a hidden note. */
export const HIDDEN_NOTE_AGENT_TEXT =
  'This note is hidden by the user: it is private and hand-written. Walnut shows its text only to them, ' +
  'and no tool may read or change it. Do not try to read the file another way. If the task truly needs it, ' +
  'ask the user to paste what is needed, or to unhide the note.'

export class LockedNoteError extends Error {
  constructor(message: string, public status: number, public code: string, public extra: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LockedNoteError'
  }
}

/** Who writes: only the person writes a hidden note (a person's own request, see web/routes/person-caller.ts). */
export interface NoteWriteBy { person?: boolean }

/**
 * Every ordinary write of a note's file calls this with the bytes there now (null: none) and the
 * text it would write. Fail-closed on the mark alone, so a file whose envelope an outside editor
 * bent keeps its ciphertext:
 *  - a locked note is written only through locked-note-store.ts (423 `note_locked`);
 *  - a hidden note only by the person (423 `note_hidden`), and their new text keeps the mark
 *    (409 `hidden_mark_kept`: only Unhide shows it to agents again, so an editor that drops the
 *    frontmatter never unhides it by accident).
 */
export function assertNotLocked(current: string | null | undefined, what = 'change', next?: string | null, by: NoteWriteBy = {}): void {
  const kind = noteProtection(current)
  if (kind === 'locked') {
    throw new LockedNoteError(`This note is locked, so it cannot ${what} here. ${LOCKED_NOTE_AGENT_TEXT}`, 423, 'note_locked')
  }
  if (kind === 'hidden' && !by.person) {
    throw new LockedNoteError(`This note is hidden, so it cannot ${what} here. ${HIDDEN_NOTE_AGENT_TEXT}`, 423, 'note_hidden')
  }
  assertNotLockedText(next, by)
  if (kind === 'hidden' && typeof next === 'string' && !hasHiddenMark(next)) {
    throw new LockedNoteError('This note is hidden: its new text must keep the line walnut_hidden: 1 in its frontmatter. To show it to agents again, use Unhide.', 409, 'hidden_mark_kept')
  }
}

/**
 * New text for an ordinary write must not carry the lock mark: only lockNote writes a locked note's
 * file (a copied one would read as locked and could never be edited again), 400 `locked_note_text`.
 * Nor the hidden mark, unless the person writes it (only they hide a note), 400 `hidden_note_text`.
 * Call it on the bytes that land (after an id is stamped in), as well as on what was sent.
 */
export function assertNotLockedText(next: string | null | undefined, by: NoteWriteBy = {}): void {
  const kind = noteProtection(next)
  if (kind === 'locked') {
    throw new LockedNoteError(
      'This text is a locked note\'s file (its frontmatter carries walnut_locked: 1): only Walnut\'s Lock writes one. Write the note\'s own text, without that line.',
      400, 'locked_note_text')
  }
  if (kind === 'hidden' && !by.person) {
    throw new LockedNoteError(
      'This text hides the note (its frontmatter carries walnut_hidden: 1): only the user hides a note, in Walnut. Write the note\'s own text, without that line.',
      400, 'hidden_note_text')
  }
}

/** The same check for a file by its absolute path (a missing file is neither locked nor hidden). */
export async function assertFileNotLocked(absFile: string, what = 'change', by: NoteWriteBy = {}): Promise<void> {
  let current: string | null = null
  try { current = await fsp.readFile(absFile, 'utf-8') } catch { return }
  assertNotLocked(current, what, undefined, by)
}
