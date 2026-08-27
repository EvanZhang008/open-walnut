/**
 * Path helpers shared by the "@" mention surfaces (the unified MentionPalette's
 * Files group and the legacy "@?" recents popup). Extracted verbatim from
 * FileMentionPopup so both interpret an "@query" path identically.
 */

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** Path of `full` relative to `base`; falls back to `full` if not under base. */
export function relativeTo(base: string, full: string): string {
  const b = base.replace(/\/+$/, '');
  if (full === b) return '.';
  if (full.startsWith(b + '/')) return full.slice(b.length + 1);
  return full;
}

/**
 * Collapse "." and ".." segments in an absolute (or "~"-rooted) path so the
 * value sent to the backend is canonical. The backend rejects any literal ".."
 * for safety, so we must resolve it here to support typing "../" to go up.
 * A leading "~" is preserved as its own segment (the backend expands it).
 */
export function normalizePath(p: string): string {
  const lead = p.startsWith('~') ? '~' : '';
  const rest = lead ? p.slice(1) : p;
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length) out.pop(); continue; }
    out.push(seg);
  }
  if (lead) return out.length ? `~/${out.join('/')}` : '~';
  return '/' + out.join('/');
}

/**
 * Split the "@query" text into the directory to browse and the trailing filter.
 * - No "/" → browse cwd, filter by the whole query.
 * - Has "/" → the part before the last "/" is a path (absolute `/…`/`~…` used as-is,
 *   else joined onto cwd); the part after the last "/" filters that dir. Any
 *   "."/".." segments are collapsed so the resolved dir is a clean absolute path.
 */
export function parseQuery(query: string, cwd: string): { dir: string; filter: string } {
  const slash = query.lastIndexOf('/');
  if (slash === -1) return { dir: cwd, filter: query };
  const dirPart = query.slice(0, slash) || '/'; // leading "/abc" → dirPart "" → root
  const filter = query.slice(slash + 1);
  const isAbsolute = dirPart.startsWith('/') || dirPart.startsWith('~');
  const joined = isAbsolute ? dirPart : joinPath(cwd.replace(/\/+$/, ''), dirPart);
  return { dir: normalizePath(joined), filter };
}
