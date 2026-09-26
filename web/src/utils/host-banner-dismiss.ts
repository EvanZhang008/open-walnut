/**
 * What the user dismissed on the home banner, and when a dismissal expires.
 *
 * Host rows: localStorage `open-walnut-host-banner-dismissed`, a JSON array of
 * keys (oldest first, at most 50). The `open-walnut-` prefix is what makes
 * ui-prefs-sync mirror it, so a row hidden in the Mac app stays hidden in a
 * browser tab too (last writer wins for the whole array).
 *   readiness  `${alias}|${kind}|${minVersion || version || ''}`: dropped on the
 *              first frame that no longer has that problem, so a relapse shows.
 *   connect    `${alias}|connect` (every connect kind shares it, so a VPN that
 *              flips between unreachable and timeout stays hidden): dropped only
 *              after the host stayed connected for 10 minutes.
 *
 * Local Claude Code notice: the set `open-walnut-setup-dismissed-claude` of
 * `install:{minVersion}`, `outdated:{minVersion}`, `sign-in:{claude.version}`.
 * The legacy global `walnut-setup-dismissed` is read as "dismissed", never written.
 */
import { readinessAnsweredThisConnection, type HostStatusInput } from '@open-walnut/host-problem';

export const HOST_BANNER_DISMISS_KEY = 'open-walnut-host-banner-dismissed';
export const HOST_BANNER_DISMISS_MAX = 50;
/** A connect dismissal re-arms only after this much unbroken connection. */
export const CONNECT_KEY_CLEAR_MS = 10 * 60_000;

export const LOCAL_DISMISS_KEY = 'open-walnut-setup-dismissed-claude';
/** Legacy: one global flag the old install banner wrote. Read, never written. */
export const LEGACY_SETUP_DISMISS_KEY = 'walnut-setup-dismissed';
/** Legacy: the old single-string local key (one state at a time). */
export const LEGACY_LOCAL_DISMISS_KEY = 'walnut-setup-dismissed-claude';

export const connectDismissKey = (alias: string): string => `${alias}|connect`;

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage full or disabled */ }
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch { return []; }
}

/** Append keys (a key dismissed again moves to the newest end); cap at `max`, oldest evicted. */
export function addKeys(list: readonly string[], add: readonly string[], max = HOST_BANNER_DISMISS_MAX): string[] {
  const drop = new Set(add);
  const out = [...list.filter((k) => !drop.has(k)), ...add.filter((k, i) => add.indexOf(k) === i)];
  return out.length > max ? out.slice(out.length - max) : out;
}

/** The alias a host key belongs to (everything before the first `|`). */
export function aliasOfKey(key: string): string {
  const i = key.indexOf('|');
  return i < 0 ? key : key.slice(0, i);
}

/**
 * Which dismissals the latest frames expire. Only a host the store knows is
 * judged: an absent host (hydration not done, a blip) keeps its keys.
 */
export function pruneKeys(list: readonly string[], statuses: readonly HostStatusInput[], now: number): string[] {
  const byHost = new Map(statuses.map((s) => [s.host, s]));
  return list.filter((key) => {
    const s = byHost.get(aliasOfKey(key));
    if (!s) return true;
    if (key === connectDismissKey(s.host)) {
      return !(s.connected && typeof s.connectedAt === 'number' && now - s.connectedAt >= CONNECT_KEY_CLEAR_MS);
    }
    // A readiness key: judged only on an answer asked on this connection.
    if (!s.connected || !readinessAnsweredThisConnection(s)) return true;
    const c = s.readiness?.claude;
    const version = c?.minVersion || c?.version || '';
    return (s.readiness?.problems ?? []).some((p) => key === `${s.host}|${p.kind}|${version}`);
  });
}

// ── Host keys: a tiny store (every banner instance reads the same list) ──
//
// localStorage is the truth, the cache only saves parsing. Another tab (or the
// Mac app next to a browser tab) writes the same key, so every write starts
// from a fresh read (a stale cache written back would resurrect the row the
// other tab just hid, or drop the one it just added), and a `storage` event
// refreshes the cache at once.

let hostKeys: string[] | null = null;
let hostKeySet: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
let storageHooked = false;

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k, i) => k === b[i]);

function notify(): void {
  for (const l of listeners) l();
}

function loadHostKeys(): string[] {
  if (hostKeys === null) {
    hostKeys = parseList(safeGet(HOST_BANNER_DISMISS_KEY));
    hostKeySet = new Set(hostKeys);
  }
  return hostKeys;
}

/** Re-read the stored list; a change another tab made reaches every reader. */
function syncFromStorage(): string[] {
  const fresh = parseList(safeGet(HOST_BANNER_DISMISS_KEY));
  const had = hostKeys;
  if (had === null || !sameList(had, fresh)) {
    hostKeys = fresh;
    hostKeySet = new Set(fresh);
    if (had !== null) notify();
  }
  return fresh;
}

function commitHostKeys(next: string[]): void {
  const prev = loadHostKeys();
  if (sameList(next, prev)) return;
  hostKeys = next;
  hostKeySet = new Set(next);
  // A plain localStorage write: ui-prefs-sync stamps and mirrors it.
  safeSet(HOST_BANNER_DISMISS_KEY, JSON.stringify(next));
  notify();
}

function hookStorageEvents(): void {
  if (storageHooked || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  storageHooked = true;
  window.addEventListener('storage', (e: StorageEvent) => {
    // key null = the other tab cleared the whole storage.
    if (e.key === null || e.key === HOST_BANNER_DISMISS_KEY) syncFromStorage();
  });
}

export function subscribeHostDismissed(cb: () => void): () => void {
  listeners.add(cb);
  hookStorageEvents();
  return () => { listeners.delete(cb); };
}

/** The dismissed host keys as a Set (stable identity until it changes). */
export function getHostDismissed(): ReadonlySet<string> {
  loadHostKeys();
  return hostKeySet;
}

export function dismissHostKeys(keys: readonly string[]): void {
  if (keys.length === 0) return;
  commitHostKeys(addKeys(syncFromStorage(), keys));
}

/** Drop the keys the latest frames expire (see pruneKeys). */
export function pruneHostDismissed(statuses: readonly HostStatusInput[], now: number): void {
  const list = syncFromStorage();
  if (list.length === 0) return;
  commitHostKeys(pruneKeys(list, statuses, now));
}

// ── Local Claude Code notice ──

/** The local dismissal key for a banner state: install / outdated by minVersion, sign-in by version. */
export function localDismissKey(kind: 'install' | 'outdated' | 'sign-in', versions: { minVersion?: string; version?: string }): string {
  if (kind === 'sign-in') return `sign-in:${versions.version ?? ''}`;
  return `${kind}:${versions.minVersion ?? ''}`;
}

/** Keys read from the stored set, plus the legacy single-string value. */
export function readLocalDismissed(): string[] {
  const list = parseList(safeGet(LOCAL_DISMISS_KEY));
  const legacy = safeGet(LEGACY_LOCAL_DISMISS_KEY);
  if (legacy && !legacy.startsWith('[')) list.push(legacy);
  return list;
}

/** Whether a local notice with this key is hidden. The old global flag hid the install card. */
export function isLocalDismissed(key: string, kind: 'install' | 'outdated' | 'sign-in', list = readLocalDismissed()): boolean {
  if (list.includes(key)) return true;
  // Old installs wrote bare 'sign-in' (no version): still honoured.
  if (kind === 'sign-in' && list.includes('sign-in')) return true;
  return kind === 'install' && safeGet(LEGACY_SETUP_DISMISS_KEY) === 'true';
}

export function dismissLocal(key: string): string[] {
  const next = addKeys(parseList(safeGet(LOCAL_DISMISS_KEY)), [key], 20);
  safeSet(LOCAL_DISMISS_KEY, JSON.stringify(next));
  return next;
}

/** "Show setup guide" (the notification pane): forget every local dismissal. */
export function clearLocalDismissed(): void {
  try {
    localStorage.removeItem(LOCAL_DISMISS_KEY);
    localStorage.removeItem(LEGACY_LOCAL_DISMISS_KEY);
    localStorage.removeItem(LEGACY_SETUP_DISMISS_KEY);
  } catch { /* storage disabled */ }
}

/** Test hook. */
export function __resetHostBannerDismissForTests(): void {
  hostKeys = null;
  hostKeySet = new Set();
  listeners.clear();
  storageHooked = false;
}
