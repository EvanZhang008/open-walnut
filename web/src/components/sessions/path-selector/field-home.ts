/**
 * The folder picker's path FIELD reads the home as `~` (2026-11-11 review: the field, the
 * "Create folder ..." row and the Files path field showed the long absolute Demo home,
 * `/Users/.../homes/<generation>/projects/app/`, and a remote pick read `/home/alice/`).
 *
 * The picker keeps the path ABSOLUTE inside (listing, ghost text, the pick it hands the draft
 * all compare against the server's absolute rows); only the field shows the `~` form, and what
 * the user types in that form comes back absolute here. A home that is not known yet (a remote
 * host before its first listing) is never guessed: the field then shows the path as it is.
 *
 * A lone `~` is kept as typed (it lists the home, input-model.ts classifyInput). Turning it into
 * `~/` under the user's fingers was what made the next "/" read as `~//`, a restart at the root.
 *
 * Pure. Unit-tested in tests/web/path-selector/field-home.test.ts.
 */
import { tildePath, untildePath } from '@/utils/home-folder';

const trim = (p: string): string => p.replace(/\/+$/, '');

/** What the field shows for the picker's path `path` on a host whose home is `home`. */
export function shownFieldPath(path: string, home?: string): string {
  const h = home ? trim(home) : '';
  if (!h || h === '/' || !path) return path;
  return tildePath(path, h);
}

/** The typed field text as the picker keeps it: `~/x` under a known home becomes absolute. */
export function keptFieldPath(typed: string, home?: string): string {
  return typed === '~' ? typed : untildePath(typed, home);
}

/** The folder a confirm hands on: `~` and `~/x` resolved against a known home. */
export function resolvedFieldPath(path: string, home?: string): string {
  return untildePath(path, home);
}

/**
 * The home a `~`-prefixed listing reveals: the server answered `typedDir` (`~/`, `~/a/b/`) with
 * the absolute `parent`, so the home is `parent` minus the typed tail. Undefined when the two do
 * not line up (a link the server followed, an old server).
 */
export function homeFromListing(typedDir: string, parent: string): string | undefined {
  if (typedDir !== '~/' && !typedDir.startsWith('~/')) return undefined;
  const tail = typedDir.slice(2);
  const p = parent.endsWith('/') ? parent : `${parent}/`;
  if (!p.startsWith('/') || !p.endsWith(tail)) return undefined;
  const home = trim(p.slice(0, p.length - tail.length));
  return home || undefined;
}
