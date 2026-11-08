/**
 * The home folder: ONE rule for every place the web app names or shows a folder
 * (2026-11-10 review: a pick of "~/" in Quick access read "Folder/Host: 3381787b-..." and
 * "New project: 3381787b-..." in the Demo, whose home is named by its generation id; on any
 * other Mac it read the user name; the Files tree said "in homes").
 *
 * The folder picker stores the ABSOLUTE home (its `~` rewrite resolves it), so `~` alone is not
 * enough: a folder is the home when it is `~` or the host's home path.
 *
 * NAMING (a new project's name, `namingHomeOf`): the home folder is "Home", the same rule the
 * launch applies (src/core/sessions/folder-project.ts folderBaseName, with the home
 * task-manager.ts ensureFolderProject passes: os.homedir() for a local launch only). A remote
 * host's absolute home is named by its last segment there, because the launch knows no remote
 * home; `~` is "Home" on every host. tests/web/folder-project-parity.test.ts holds the two.
 *
 * SHOWING (a pill, a tree row, a breadcrumb, `shownFolderName` / `tildePath`): the home reads `~`
 * on every host: this Walnut's own HOME for local folders, a home a `~/` listing resolved for a
 * remote one, else the account-shaped guess (/Users/<x>, /home/<x>).
 *
 * Every draft and Files surface that names a folder goes through here; the guard in
 * tests/web/folder-project-parity.test.ts fails on one that names a folder by hand.
 */
import { peekWorkingDirs } from '@/api/sessions';

export const HOME_PROJECT_NAME = 'Home';

const LOCAL = '__local__';
const learned = new Map<string, string>();

const isLocal = (host: string | null | undefined): boolean => !host || host === LOCAL || host === 'local';
const trim = (p: string): string => p.replace(/\/+$/, '');

/** Record a host's home, as a `~/` listing resolved it (the path picker, the Files tree). */
export function rememberHostHome(host: string | null | undefined, home: string | null | undefined): void {
  const h = trim(home ?? '');
  if (!h.startsWith('/')) return;
  learned.set(isLocal(host) ? LOCAL : host!, h);
}

/** The home of `host` as far as this window knows it; undefined when it does not. */
export function knownHomeOf(host: string | null | undefined): string | undefined {
  if (isLocal(host)) {
    const own = trim(peekWorkingDirs()?.localHome ?? '');
    return own.startsWith('/') ? own : learned.get(LOCAL);
  }
  return learned.get(host!);
}

/** The home a folder's NEW project name is judged against: local only, exactly as the launch
 *  tells local from remote (task-manager.ts ensureFolderProject: no host or `__local__`). */
export function namingHomeOf(host: string | null | undefined): string | undefined {
  return !host || host === LOCAL ? knownHomeOf(host) : undefined;
}

/** True when `cwd` is the home folder: `~`, or `home` when given. */
export function isHomeFolder(cwd: string, home?: string): boolean {
  const dir = trim(cwd);
  return dir === '~' || (!!home && dir === trim(home));
}

/**
 * `path` with the home as `~` (`/Users/sam/code/` → `~/code/`). A known `home` wins over the
 * account-shaped guess: a server whose HOME is not the account's (the Demo) lists `~/Documents`
 * under its own HOME, and the guess labelled it `~/Library/.../home/Documents` (2026-11-08).
 */
export function tildePath(path: string, home?: string): string {
  if (home && home !== '/') {
    const h = trim(home);
    return path === h || path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
  }
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

/** `tildePath` backwards: `~` and `~/x` against a known `home` (`~/code` → `/Users/sam/code`). With
 *  no home known the path stays as typed (the server expands a local `~`, a remote daemon its own). */
export function untildePath(path: string, home?: string): string {
  const h = trim(home ?? '');
  if (!h.startsWith('/') || h === '/') return path;
  if (path === '~') return h;
  return path.startsWith('~/') ? h + path.slice(1) : path;
}

/** A folder's name as shown, against a known `home` (else the guess): `~` for the home, else its
 *  last segment ('/' for the root). */
export function folderNameIn(cwd: string, home?: string): string {
  const dir = trim(cwd);
  if (!dir) return '/';
  if (dir === '~' || tildePath(dir, home) === '~') return '~';
  return dir.slice(dir.lastIndexOf('/') + 1) || dir;
}

/** A folder's name as shown on `host`: `~` for that host's home, else its last segment. */
export function shownFolderName(cwd: string, host: string | null | undefined): string {
  return folderNameIn(cwd, knownHomeOf(host));
}

/** A path (already shown with its home as `~`) as breadcrumb segments: the last three, after an
 *  ellipsis when longer. A path under the home keeps its `~` first (2026-11-11 review: the Files
 *  crumbs read "… › projects › app › notes.md" for `~/projects/app/notes.md`); the ellipsis then
 *  stands only for the folders between. */
export function pathCrumbs(p: string): string[] {
  const segs = p.split('/').filter(Boolean);
  if (segs.length === 0) return [p || '/'];
  if (segs[0] === '~') return segs.length > 4 ? ['~', '…', ...segs.slice(-3)] : segs;
  return segs.length > 3 ? ['…', ...segs.slice(-3)] : segs;
}
