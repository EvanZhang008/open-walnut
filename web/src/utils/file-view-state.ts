/**
 * Persisted per-file view state for the Files panel (SessionFileExplorer +
 * FileContentView).
 *
 * Two things survive a panel close / reload / session switch:
 *  - which FILE was open in the preview pane, keyed per host+root, so reopening
 *    Files lands you back on the file you were reading instead of the empty
 *    "Select a file to preview" pane;
 *  - the SCROLL OFFSET (and preview/source mode) of each file, keyed per
 *    host+path, so reopening a long doc resumes where you stopped reading
 *    instead of jumping to the top.
 *
 * Both are pure navigation comfort — a miss just means "start at the top", so
 * every read is best-effort and a corrupt/denied localStorage is non-fatal.
 * The scroll map is capped (LRU by write order) so a long-lived browser profile
 * can't grow it without bound.
 */

const LS_SELECTED_FILE = 'open-walnut-file-explorer-selected';
const LS_SCROLL = 'open-walnut-file-view-scroll';

/** Max remembered files' scroll offsets. Oldest-written entries are dropped. */
const SCROLL_MAX_ENTRIES = 300;

/** Below this offset there's nothing worth restoring — treat as "top". */
const SCROLL_MIN_PERSIST = 24;

/** Separator between host and path in a scroll-map key. A space can't appear in
 *  a host, and any path spaces are unambiguous after the first separator.
 *  Deliberately NOT a raw NUL byte: a literal \0 in this source made git
 *  classify the file as binary, so the change had no reviewable diff. */
const KEY_SEP = ' ';

export interface FileScrollState {
  /** Scroll offset of the preview/source scroll container, in px. */
  top: number;
  /** true = the user had switched a md/html file to Source view. */
  source?: boolean;
}

function selectedKey(host: string | undefined, root: string): string {
  return `${LS_SELECTED_FILE}:${host ?? 'local'}:${root}`;
}

function scrollKey(host: string | undefined, path: string): string {
  return `${host ?? 'local'}${KEY_SEP}${path}`;
}

// ── Selected file (per host + tree root) ──

export function loadSelectedFile(host: string | undefined, root: string): string | null {
  try {
    return localStorage.getItem(selectedKey(host, root));
  } catch {
    return null; // denied
  }
}

export function saveSelectedFile(host: string | undefined, root: string, path: string | null): void {
  try {
    if (path) localStorage.setItem(selectedKey(host, root), path);
    else localStorage.removeItem(selectedKey(host, root));
  } catch { /* quota/denied */ }
}

// ── Per-file scroll offset + view mode ──

type ScrollMap = Record<string, FileScrollState>;

function readScrollMap(): ScrollMap {
  try {
    const raw = localStorage.getItem(LS_SCROLL);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ScrollMap;
  } catch {
    return {}; // corrupt/denied — start fresh
  }
}

export function loadFileScroll(host: string | undefined, path: string): FileScrollState | null {
  const entry = readScrollMap()[scrollKey(host, path)];
  if (!entry || typeof entry.top !== 'number' || !Number.isFinite(entry.top)) return null;
  return entry;
}

export function saveFileScroll(
  host: string | undefined,
  path: string,
  state: FileScrollState,
): void {
  const key = scrollKey(host, path);
  const map = readScrollMap();
  // Back at the top with default view mode → drop the entry instead of storing a
  // no-op, so "scrolled back up" doesn't leave a stale offset behind.
  if (state.top < SCROLL_MIN_PERSIST && !state.source) delete map[key];
  else {
    // Re-insert last so JSON key order doubles as LRU-by-write for the cap below.
    delete map[key];
    map[key] = { top: Math.round(state.top), ...(state.source ? { source: true } : {}) };
  }
  const keys = Object.keys(map);
  if (keys.length > SCROLL_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - SCROLL_MAX_ENTRIES)) delete map[k];
  }
  try {
    localStorage.setItem(LS_SCROLL, JSON.stringify(map));
  } catch { /* quota/denied */ }
}
