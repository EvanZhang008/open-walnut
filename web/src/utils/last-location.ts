/**
 * Remember where the user last was inside each section, so a sidebar click brings
 * them BACK there instead of to the section's front door.
 *
 * Several pages keep their view state in the URL — Calendar's `?view=&d=`, Settings'
 * `#pane`, Memory's `?path=` — which survives reload and Back, but the sidebar always
 * linked to the bare path, so the ordinary way of returning to a page threw that
 * state away (2026-09-23: "all panels need to persist the choice … even after switch
 * away and back"). Consumers: the Sidebar; any other nav (the Settings "Manage"
 * links to /memory etc.) can adopt `linkTargetFor` the same way.
 *
 * Model: a section is the first path segment (`/calendar`, `/settings`, `/memory`).
 * A location is remembered only when it IS the section root (`/tasks` yes,
 * `/tasks/<id>` no — a task detail page is not "where the tasks list was"), with one
 * exception: Plugin Apps under `/apps/<id>/…` own their whole subtree, so their
 * section is `/apps/<id>` and sub-paths are remembered. Home (`/`) stays mounted
 * and keeps its own state, so it is never recorded.
 *
 * Pure logic against a Storage-shaped store; tests in tests/web/last-location.test.ts.
 */

export const LS_LAST_LOCATION = 'walnut-app-last-location';

export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStore(): KeyStore | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** The section key for a pathname, or null when the location is not remembered. */
export function sectionFor(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null;
  const segs = pathname.split('/').filter(Boolean);
  if (segs.length === 0) return null;                       // home
  if (segs[0] === 'apps') {
    return segs.length >= 2 ? `/apps/${segs[1]}` : null;    // plugin app subtree
  }
  return segs.length === 1 ? `/${segs[0]}` : null;          // section root only
}

function readAll(store: KeyStore | null): Record<string, string> {
  try {
    const raw = store?.getItem(LS_LAST_LOCATION);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.startsWith(k)) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Record the current location (pathname + search + hash). A location with no
 * search and no hash is stored too: it means "the user cleared the state", and
 * must overwrite an older remembered one.
 */
export function rememberLocation(
  loc: { pathname: string; search: string; hash: string },
  store: KeyStore | null = safeStore(),
): void {
  const section = sectionFor(loc.pathname);
  if (!section) return;
  const url = `${loc.pathname}${loc.search}${loc.hash}`;
  try {
    const all = readAll(store);
    if (all[section] === url) return;
    all[section] = url;
    store?.setItem(LS_LAST_LOCATION, JSON.stringify(all));
  } catch { /* quota / private mode: links fall back to the bare path */ }
}

/** Where a link to `path` should go: the remembered location, else `path` itself. */
export function linkTargetFor(path: string, store: KeyStore | null = safeStore()): string {
  const section = sectionFor(path);
  if (!section) return path;
  const remembered = readAll(store)[section];
  return remembered ?? path;
}
