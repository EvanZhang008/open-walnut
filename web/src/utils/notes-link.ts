/**
 * Detect file paths that are really NOTES in the local vault (the notes folder, or the one
 * tree once the notes moved into it) so click handlers can route them to the Notes page
 * instead of the raw FileViewer.
 */
import { fetchNotesDir } from '@/api/config';

/**
 * If `absPath` is a markdown note inside the LOCAL notes vault, return its
 * vault-relative path (the `/notes?path=` param). Otherwise null → caller
 * falls back to the FileViewer.
 *
 * Remote-session paths (host set) are never vault notes — same string on
 * another machine is a different file. `~/`-prefixed paths are expanded using
 * the home prefix derived from notesDir (only when the vault sits at a standard
 * place under <home>/.open-walnut). A path under the old notes folder while the
 * vault is the one tree is a note by its old path: the server follows the move.
 */
export async function vaultRelativeNotePath(absPath: string, host?: string): Promise<string | null> {
  if (host && host !== '__local__') return null;
  if (!absPath.toLowerCase().endsWith('.md')) return null;
  const notesDir = await fetchNotesDir();
  if (!notesDir) return null; // cloud mode / config unavailable

  let p = absPath;
  const walnutHome = notesDir.match(/^(.*\/\.open-walnut)\/(?:notes|artifacts)\/?$/)?.[1];
  if (p.startsWith('~/')) {
    if (!walnutHome) return null;
    p = walnutHome.replace(/\/\.open-walnut$/, '') + p.slice(1);
  }
  const root = notesDir.replace(/\/$/, '') + '/';
  if (p.startsWith(root)) return p.slice(root.length);
  const oldRoot = walnutHome ? `${walnutHome}/notes/` : null;
  return oldRoot && oldRoot !== root && p.startsWith(oldRoot) ? p.slice(oldRoot.length) : null;
}
