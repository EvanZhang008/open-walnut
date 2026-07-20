/**
 * Detect file paths that are really NOTES in the local vault (~/.open-walnut/notes/)
 * so click handlers can route them to the Notes page instead of the raw FileViewer.
 */
import { fetchNotesDir } from '@/api/config';

/**
 * If `absPath` is a markdown note inside the LOCAL notes vault, return its
 * vault-relative path (the `/notes?path=` param). Otherwise null → caller
 * falls back to the FileViewer.
 *
 * Remote-session paths (host set) are never vault notes — same string on
 * another machine is a different file. `~/`-prefixed paths are expanded using
 * the home prefix derived from notesDir (only when the vault sits at the
 * standard <home>/.open-walnut/notes location).
 */
export async function vaultRelativeNotePath(absPath: string, host?: string): Promise<string | null> {
  if (host && host !== '__local__') return null;
  if (!absPath.toLowerCase().endsWith('.md')) return null;
  const notesDir = await fetchNotesDir();
  if (!notesDir) return null; // cloud mode / config unavailable

  let p = absPath;
  if (p.startsWith('~/')) {
    const home = notesDir.match(/^(.*)\/\.open-walnut\/notes\/?$/)?.[1];
    if (!home) return null;
    p = home + p.slice(1);
  }
  const root = notesDir.replace(/\/$/, '') + '/';
  return p.startsWith(root) ? p.slice(root.length) : null;
}
