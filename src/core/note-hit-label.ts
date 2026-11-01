/**
 * What a notes search result row says about WHICH note it is: the file name
 * (the label the tree, the tabs and the breadcrumb use), the folder it lives in,
 * and the note's own title only when that title says something the file name
 * does not. Every surface that lists notes search results reads its label from
 * here (tests/core/note-hit-label-guard.test.ts fails on one that does not):
 * a row titled by a note's first heading alone hid a file named like
 * `LaunchHook.md` behind an unrelated sentence, so the user could not tell
 * which note it was. Browser-safe: the web imports it as is.
 */

export interface NoteHitLabel {
  /** The row's lead: the file name (no `.md` for a note, the whole name for an
   *  attachment), or the title when it only respells the file name
   *  ("Vault note" for `vault-note.md`). */
  name: string;
  /** Vault-relative folder, '' at the vault root. */
  folder: string;
  /** The note's display title, only when it differs from the file name. */
  title?: string;
}

/** Lowercase letters and digits only, in one Unicode form: "Launch-Hook" and
 *  "LaunchHook" compare equal, and so do a decomposed file name (macOS) and its
 *  composed title. */
function squash(s: string): string {
  return s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function noteHitLabel(hit: { path: string; title?: string; name?: string }): NoteHitLabel {
  const path = hit.path || '';
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const fileName = /\.md$/i.test(base) ? base.replace(/\.md$/i, '') : base;
  const raw = (hit.title || hit.name || '').trim();
  if (!raw) return { name: fileName, folder };
  const key = squash(fileName);
  if (key && squash(raw) === key) return { name: raw, folder };
  return { name: fileName, folder, title: raw };
}
