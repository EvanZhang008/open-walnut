/**
 * A locked note on the web side (docs/reference/locked-notes.md). The server answers a locked
 * note's read with its stub: the outer frontmatter carrying `walnut_locked: 1` and the stub's
 * paragraph, which opens with LOCKED_STUB_LEAD (the server's core/notes/locked-note.ts
 * LOCKED_NOTE_STUB; tests/core/notes/locked-note.test.ts keeps the two in step). Both must be
 * there: a plain note whose frontmatter only names the mark is still a plain note.
 */
const LOCKED_LINE_RE = /^walnut_locked:[ \t]*1[ \t]*\r?$/m;

/** How the server's stub paragraph opens. */
export const LOCKED_STUB_LEAD = '**Locked note.**';

/** Whether a note read (its verbatim frontmatter block and its body) is a locked note's stub. */
export function isLockedNote(frontmatter: string | null | undefined, body: string | null | undefined): boolean {
  return !!frontmatter && LOCKED_LINE_RE.test(frontmatter) && typeof body === 'string' && body.trimStart().startsWith(LOCKED_STUB_LEAD);
}
