/**
 * Is a link DESTINATION (`[label](/repo/x.go#L58)`, `<a href="/tmp/r.html">`) a
 * local path, and which one?
 *
 * Moved from web/src/utils/markdown.ts (fileLinkAttrsForDestination keeps the
 * rest of its rules there) so the server's letter body linker reads an
 * agent-written `<a href>` exactly as the markdown renderer reads a link.
 * Pure: path-ref-parse has no imports either.
 */

import { hasTraversalSegment, parsePathDestination, type ParsedRef } from '../providers/path-ref-parse.js';

/** Characters no destination may carry into an attribute or a path lookup
 *  (quotes, angle brackets, backslashes, control characters). */
// eslint-disable-next-line no-control-regex
export const DEST_FORBIDDEN_RE = /["<>\\\x00-\x1f]/;

export interface LocalDestination extends ParsedRef {
  /** Starts at `/` or `~/`. */
  absolute: boolean;
  /** Path segments, without the leading `/` or `~/` and any trailing `/`. */
  segs: string[];
  leaf: string;
  hasExt: boolean;
}

/**
 * The destination as a local path, or null when it is not one: a URL, an
 * in-page anchor, a query, a traversal, a protocol-relative `//host`. A heading
 * fragment (`guide.md#tiers`) is dropped (the viewer has no headings); a numeric
 * one was already read as a line.
 */
export function localDestination(rawDest: string): LocalDestination | null {
  const dest = rawDest.trim();
  if (!dest || dest.startsWith('#') || dest.startsWith('//')) return null;
  const ref = parsePathDestination(dest);
  const p = ref.path.replace(/#[A-Za-z][\w-]*$/, '');
  // Scheme test runs AFTER the position is split off: `README.md:12` is a file at
  // line 12, not a `README.md:` scheme. `mailto:`/`https:`/`vscode:` still fail.
  if (!p || p.includes('?') || p.includes('#') || DEST_FORBIDDEN_RE.test(p)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p.split('/')[0] ?? '')) return null;
  if (hasTraversalSegment(p)) return null;
  const segs = p.replace(/^~?\//, '').replace(/\/+$/, '').split('/');
  const leaf = segs[segs.length - 1] ?? '';
  return {
    ...ref,
    path: p,
    absolute: /^~?\//.test(p),
    segs,
    leaf,
    hasExt: /^[^.].*\.\w+$|^\.\w+$/.test(leaf),
  };
}

/**
 * The file or directory an ABSOLUTE destination names, or null. Floors follow
 * the bare-path passes: a file needs a directory above it, a directory three
 * segments of plain characters, so `/tasks/<id>` and `/apps/<app>~main/inbox`
 * stay in-app routes.
 */
export function absoluteDestinationPath(d: LocalDestination): string | null {
  if (!d.absolute) return null;
  if (d.hasExt && d.segs.length >= 2) return d.path;
  if (!d.hasExt && d.segs.length >= 3 && d.segs.every((s) => /^[\w@.+-]+$/.test(s))) return d.path.replace(/\/+$/, '');
  return null;
}
