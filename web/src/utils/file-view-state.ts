/**
 * Persisted per-file view state for the Files panel (SessionFileExplorer +
 * FileContentView).
 *
 * Three things survive a panel close / reload / session switch:
 *  - which FILE was open in the preview pane, keyed per host+SCOPE, so reopening
 *    Files lands you back on the file you were reading instead of the empty
 *    "Select a file to preview" pane;
 *  - the browser-style BACK/FORWARD history of files read under that scope;
 *  - the SCROLL OFFSET (and preview/source mode) of each file, keyed per
 *    host+path, so reopening a long doc resumes where you stopped reading
 *    instead of jumping to the top.
 *
 * SCOPE = one session, not a directory. The scope has to satisfy two opposing
 * requirements, and getting either wrong is a shipped bug:
 *
 *  1. STABLE WITHIN a session. The panel is entered two ways that resolve to
 *     DIFFERENT tree roots — the Files chip roots at the session cwd, a file-path
 *     click in the chat roots at the clicked file's PARENT dir. Keying by root
 *     meant those two never met (the click wrote `…:/repo/src/web`, the chip read
 *     `…:/repo`), so the chip always reopened on the empty preview pane.
 *
 *  2. UNIQUE ACROSS sessions. Fixing (1) by keying on the session CWD traded one
 *     bug for a worse one: two sessions in the same repo share a cwd, so they
 *     shared a key and leaked each other's open file and history — "I open a file
 *     in session 1, go to session 2, and it's remembered there too". Sessions are
 *     completely isolated, so the key must be the SESSION ID, which is unique by
 *     construction and independent of where the tree happens to be rooted.
 *
 * Callers pass `session:<id>`. Scope falls back to the tree root only for callers
 * that genuinely have no session (the standalone FileViewer overlay).
 *
 * All of it is pure navigation comfort — a miss just means "start at the top", so
 * every read is best-effort and a corrupt/denied localStorage is non-fatal.
 * The scroll map is capped (LRU by write order) so a long-lived browser profile
 * can't grow it without bound.
 */

const LS_SELECTED_FILE = 'open-walnut-file-explorer-selected';
const LS_SCROLL = 'open-walnut-file-view-scroll';
const LS_HISTORY = 'open-walnut-file-explorer-history';

/** Max files remembered in one scope's back/forward history. Oldest drop first. */
export const HISTORY_MAX_ENTRIES = 50;

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

/**
 * The scope for a session's Files panel. Prefixed so a session id can never
 * collide with the path-shaped fallback scope of a session-less caller.
 */
export function sessionScope(sessionId: string): string {
  return `session:${sessionId}`;
}

/** Normalize a scope so `/repo` and `/repo/` share one key. Session scopes have
 *  no trailing slash to strip, so this is a no-op for them. */
function normScope(scope: string): string {
  return scope.replace(/\/+$/, '') || '/';
}

function selectedKey(host: string | undefined, scope: string): string {
  return `${LS_SELECTED_FILE}:${host ?? 'local'}:${normScope(scope)}`;
}

function historyKey(host: string | undefined, scope: string): string {
  return `${LS_HISTORY}:${host ?? 'local'}:${normScope(scope)}`;
}

function scrollKey(host: string | undefined, path: string): string {
  return `${host ?? 'local'}${KEY_SEP}${path}`;
}

// ── Selected file (per host + scope) ──

export function loadSelectedFile(host: string | undefined, scope: string): string | null {
  try {
    return localStorage.getItem(selectedKey(host, scope));
  } catch {
    return null; // denied
  }
}

export function saveSelectedFile(host: string | undefined, scope: string, path: string | null): void {
  try {
    if (path) localStorage.setItem(selectedKey(host, scope), path);
    else localStorage.removeItem(selectedKey(host, scope));
  } catch { /* quota/denied */ }
}

// ── Back/forward history (per host + scope) ──

/**
 * A browser-style history stack for the preview pane. `entries` is oldest-first,
 * `index` points at the currently-shown file. Back = index-1, Forward = index+1.
 */
export interface FileHistory {
  entries: string[];
  index: number;
}

const EMPTY_HISTORY: FileHistory = { entries: [], index: -1 };

function sanitizeHistory(raw: unknown): FileHistory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_HISTORY;
  const obj = raw as Partial<FileHistory>;
  if (!Array.isArray(obj.entries)) return EMPTY_HISTORY;
  const entries = obj.entries.filter((e): e is string => typeof e === 'string' && e.length > 0);
  if (entries.length === 0) return EMPTY_HISTORY;
  const idx = typeof obj.index === 'number' && Number.isInteger(obj.index) ? obj.index : entries.length - 1;
  // A stored index outside the surviving entries would strand Back/Forward on a
  // hole — clamp it into range instead of trusting the payload.
  return { entries, index: Math.min(Math.max(idx, 0), entries.length - 1) };
}

export function loadFileHistory(host: string | undefined, scope: string): FileHistory {
  try {
    const raw = localStorage.getItem(historyKey(host, scope));
    if (!raw) return EMPTY_HISTORY;
    return sanitizeHistory(JSON.parse(raw) as unknown);
  } catch {
    return EMPTY_HISTORY; // corrupt/denied — no history, buttons stay disabled
  }
}

export function saveFileHistory(host: string | undefined, scope: string, history: FileHistory): void {
  try {
    if (history.entries.length === 0) localStorage.removeItem(historyKey(host, scope));
    else localStorage.setItem(historyKey(host, scope), JSON.stringify(history));
  } catch { /* quota/denied */ }
}

/**
 * Push a newly-opened file, exactly like a browser address-bar navigation:
 *  - re-opening the file already shown is a no-op (no duplicate stack entries);
 *  - navigating after going Back TRUNCATES the forward tail (that future is gone);
 *  - the stack is capped, dropping oldest entries (index shifts with them).
 */
export function pushFileHistory(history: FileHistory, path: string): FileHistory {
  if (history.entries[history.index] === path) return history;
  const entries = [...history.entries.slice(0, history.index + 1), path];
  const overflow = entries.length - HISTORY_MAX_ENTRIES;
  const trimmed = overflow > 0 ? entries.slice(overflow) : entries;
  return { entries: trimmed, index: trimmed.length - 1 };
}

/** Drop every occurrence of a path (file deleted since) and re-clamp the index. */
export function removeFromFileHistory(history: FileHistory, path: string): FileHistory {
  if (!history.entries.includes(path)) return history;
  const removedBeforeIndex = history.entries.slice(0, history.index).filter((e) => e === path).length;
  const wasCurrent = history.entries[history.index] === path;
  const entries = history.entries.filter((e) => e !== path);
  if (entries.length === 0) return EMPTY_HISTORY;
  // Removing the current entry lands on its predecessor (browser-like); removing
  // earlier entries just shifts the index left by however many vanished.
  const index = Math.min(Math.max(history.index - removedBeforeIndex - (wasCurrent ? 1 : 0), 0), entries.length - 1);
  return { entries, index };
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
