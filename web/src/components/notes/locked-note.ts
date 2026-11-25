/**
 * A locked or hidden note on the web side (docs/reference/locked-notes.md). The server answers a
 * locked note's read with its stub: the outer frontmatter carrying `walnut_locked: 1` and the
 * stub's paragraph. A hidden note (`walnut_hidden: 1`) is plain text: the person's own read gets
 * it whole, anyone else's its frontmatter and the hidden stub. The web reads both by the server's
 * own rule (src/core/notes/locked-note-format.ts): the mark in the note's first frontmatter block,
 * the rule every server writer refuses on and the notes list reports, so the web never offers an
 * editor whose every save is refused.
 */
import { hasLockMark, noteProtection, type NoteProtection } from '../../../../src/core/notes/locked-note-format';

export type { NoteProtection };

/**
 * What the server reads the mark from (locked-note-format.ts): the first block, which the split
 * leaves in the body when the file starts with a byte order mark, so an empty split frontmatter
 * reads the body (the server skips the mark; the split does not).
 */
const headOf = (frontmatter: string | null | undefined, body?: string | null) => frontmatter || body || ''

/** Whether a note read (its verbatim frontmatter block, then its body) carries the lock mark. */
export function isLockedNote(frontmatter: string | null | undefined, body?: string | null): boolean {
  return hasLockMark(headOf(frontmatter, body));
}

/** Whether a note (its verbatim frontmatter block, and its body) is marked hidden (and not locked: the lock wins). */
export function isHiddenNote(frontmatter: string | null | undefined, body?: string | null): boolean {
  return noteProtection(headOf(frontmatter, body)) === 'hidden';
}

/** Which protection a note (its verbatim frontmatter block, and its body) is marked with ('locked' when both), or null. */
export function noteProtectionOf(frontmatter: string | null | undefined, body?: string | null): NoteProtection | null {
  return noteProtection(headOf(frontmatter, body));
}

/** The one line a hidden note shows in place of its text (HiddenNoteCover, a project's tracking pane). */
export const HIDDEN_NOTE_LINE = 'Hidden from AI: no agent reads it through Walnut. The file is not encrypted, so a program that opens it directly can; Encrypt keeps it from those too.';

/** A note's name as its covers show it: the file name without `.md` or its folders. */
export function noteName(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() || path;
}
