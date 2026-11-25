/**
 * A locked or hidden note on the web side (docs/reference/locked-notes.md). The server answers a
 * locked note's read with its stub: the outer frontmatter carrying `walnut_locked: 1` and the
 * stub's paragraph. A hidden note (`walnut_hidden: 1`) is plain text: the person's own read gets
 * it whole, anyone else's its frontmatter and the hidden stub. The web reads both by the server's
 * own rule (src/core/notes/locked-note-format.ts): the mark in the note's first frontmatter block,
 * the rule every server writer refuses on and the notes list reports, so the web never offers an
 * editor whose every save is refused.
 */
import { hasHiddenMark, hasLockMark, noteProtection, type NoteProtection } from '../../../../src/core/notes/locked-note-format';

export type { NoteProtection };

/**
 * Whether a note read (its verbatim frontmatter block, then its body) is a locked note. The mark
 * decides; the body is not needed (kept so callers pass what they split).
 */
export function isLockedNote(frontmatter: string | null | undefined, _body?: string | null): boolean {
  return hasLockMark(frontmatter);
}

/** Whether a note's verbatim frontmatter block marks it hidden (and not locked: the lock wins). */
export function isHiddenNote(frontmatter: string | null | undefined): boolean {
  return hasHiddenMark(frontmatter) && !hasLockMark(frontmatter);
}

/** Which protection a note's verbatim frontmatter block marks ('locked' when both: the lock wins), or null. */
export function noteProtectionOf(frontmatter: string | null | undefined): NoteProtection | null {
  return noteProtection(frontmatter);
}

/** The one line a hidden note shows in place of its text (HiddenNoteCover, a project's tracking pane). */
export const HIDDEN_NOTE_LINE = 'Hidden from AI. Agents cannot read it, and its text is stored unencrypted.';

/** A note's name as its covers show it: the file name without `.md` or its folders. */
export function noteName(path: string): string {
  return path.replace(/\.md$/i, '').split('/').pop() || path;
}
