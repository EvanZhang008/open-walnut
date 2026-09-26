/**
 * Server-side persistence for browser layout state.
 *
 * All layout preferences (section collapse flags, splitter ratios, dragged
 * heights, panel widths) already live in localStorage under stable keys.
 * This module mirrors those keys to the server
 * (WALNUT_HOME/config/share/ui-prefs.json, which syncs across devices) so the
 * layout survives new browsers, other devices, and cleared browser data —
 * without touching any of the ~30 existing call sites:
 *
 *  - boot: GET /api/ui-prefs merges into localStorage BEFORE the app renders
 *    (components read these keys in useState initializers). The merge is
 *    last-writer-wins per key: each side carries a write timestamp, so a
 *    reload racing the previous page's unload flush can NOT clobber a fresh
 *    local change with a stale server value.
 *  - after boot: localStorage.setItem/removeItem are wrapped; writes to
 *    syncable keys are stamped + batched and PUT back (debounced), plus a
 *    keepalive flush on pagehide so a quick reload can't lose the last change.
 *
 * Only layout/preference keys sync (open-walnut-* / walnut-todo-*). Device
 * tokens (walnut.deviceToken), chat drafts (draft:*), per-session diff review
 * state (open-walnut-diff-review:*), and machine-specific keys that embed an
 * absolute path (open-walnut-file-explorer-selected:*) never leave the browser.
 */

import { apiGet, apiPut } from '@/api/client';
import { getDeviceToken } from '@/api/device-token';
import { SKIP_PREFS_MERGE_FLAG } from './crash-recovery';

const INCLUDE_PREFIXES = ['open-walnut-', 'walnut-todo-'];
/**
 * Never mirrored. Two different reasons:
 *  - `open-walnut-diff-review:` — a per-session blob, too big and too transient.
 *  - `open-walnut-file-explorer-selected:` — the KEY embeds an absolute
 *    filesystem path (`…:local:/Users/me/repo`), so the entry means nothing on
 *    another device. Since ui-prefs.json now lives in the SYNCED
 *    config/share/ (git-tracked), such a key would export this box's paths to
 *    every other one.
 */
const EXCLUDE_PREFIXES = ['open-walnut-diff-review:', 'open-walnut-file-explorer-selected:'];
/** Local write timestamps per key — lets boot-merge decide who's newer. */
const META_KEY = 'open-walnut-ui-prefs-sync-meta';

// The unwrapped Storage methods: this module's own writes (meta, adopted
// server values) must never be queued back to the server. (Node tests import
// `syncable` from here and have no Storage.)
//
// Captured ONCE per page, on the prototype itself, not once per evaluation of
// this module: under HMR the module runs again after the prototype is already
// wrapped, and capturing then took the previous wrapper as "raw", so every
// write was queued twice and the chain grew by one wrapper per hot reload.
interface RawStorage { get: Storage['getItem']; set: Storage['setItem']; remove: Storage['removeItem'] }
const RAW_STORAGE = Symbol.for('open-walnut.ui-prefs-sync.raw-storage');
const storageProto: Storage | null = typeof Storage === 'undefined' ? null : Storage.prototype;
function rawStorage(proto: Storage): RawStorage {
  const holder = proto as unknown as Record<symbol, RawStorage | undefined>;
  const known = holder[RAW_STORAGE];
  if (known) return known;
  const raw: RawStorage = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem };
  Object.defineProperty(proto, RAW_STORAGE, { value: raw, enumerable: false, configurable: true });
  return raw;
}
const raw: RawStorage | null = storageProto ? rawStorage(storageProto) : null;
const noop = () => null;
const rawGet: Storage['getItem'] = raw?.get ?? noop;
const rawSet: Storage['setItem'] = raw?.set ?? noop;
const rawRemove: Storage['removeItem'] = raw?.remove ?? noop;
const FLUSH_DEBOUNCE_MS = 800;

interface PrefEntry { v: string | null; ts: number }

/** Whether a localStorage key is mirrored to the server. Exported so a feature
 *  that DEPENDS on cross-device sync (e.g. the launcher's sticky pin tier) can
 *  assert its key against this predicate instead of a hardcoded prefix string —
 *  narrowing the allowlist would otherwise silently make that state
 *  device-local with a green test suite. Keep in sync with the server-side twin
 *  in src/web/routes/ui-prefs.ts. */
export function syncable(key: string): boolean {
  if (key === META_KEY) return false;
  if (EXCLUDE_PREFIXES.some((p) => key.startsWith(p))) return false;
  return INCLUDE_PREFIXES.some((p) => key.startsWith(p));
}

function readMeta(): Record<string, number> {
  try {
    const raw = rawGet.call(localStorage, META_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
    }
  } catch { /* corrupt — start fresh */ }
  return {};
}

let meta: Record<string, number> = {};

function persistMeta() {
  try { rawSet.call(localStorage, META_KEY, JSON.stringify(meta)); } catch { /* quota */ }
}

let pending = new Map<string, PrefEntry>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function takePending(): Record<string, PrefEntry> | null {
  if (pending.size === 0) return null;
  const prefs = Object.fromEntries(pending);
  pending = new Map();
  return prefs;
}

async function flush() {
  const prefs = takePending();
  if (!prefs) return;
  try {
    await apiPut('/api/ui-prefs', { prefs });
  } catch {
    // Offline / transient failure: drop silently — localStorage still has the
    // truth for this browser; the next write re-syncs the touched keys.
  }
}

function queue(key: string, value: string | null) {
  if (!syncable(key)) return;
  const ts = Date.now();
  // Re-read meta before mutating: several tabs share this store, and writing
  // a stale in-memory copy would erase another tab's timestamps (its keys
  // would then lose to older server values on the next boot merge).
  meta = readMeta();
  meta[key] = ts;
  persistMeta();
  pending.set(key, { v: value, ts });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), FLUSH_DEBOUNCE_MS);
}

// pagehide can't await — use fetch keepalive so the batch survives unload.
function flushKeepalive() {
  const prefs = takePending();
  if (!prefs) return;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getDeviceToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    void fetch('/api/ui-prefs', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ prefs }),
      keepalive: true,
    });
  } catch { /* best effort */ }
}

/**
 * Merge server prefs into localStorage (LWW per key), then start mirroring
 * writes back. Await this BEFORE the first render — components read the keys
 * synchronously in useState initializers. Resolves quickly (short timeout)
 * and never throws, so an offline server falls back to plain localStorage.
 */
export async function initUiPrefsSync(): Promise<void> {
  meta = readMeta();

  // After a hard crash-heal, the session flag tells us to skip adopting the
  // server copy for one boot — it may carry the same poisoned value that
  // triggered the crash loop. The flag is consumed (removed) immediately.
  const skipMerge = (() => {
    try {
      if (sessionStorage.getItem(SKIP_PREFS_MERGE_FLAG)) {
        sessionStorage.removeItem(SKIP_PREFS_MERGE_FLAG);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  })();

  try {
    if (skipMerge) throw new Error('skip prefs merge (crash recovery)');
    const res = await apiGet<{ prefs: Record<string, PrefEntry> }>(
      '/api/ui-prefs', undefined, { timeoutMs: 2500 },
    );
    const localOnly: Record<string, PrefEntry> = {};
    for (const [key, entry] of Object.entries(res.prefs ?? {})) {
      if (!syncable(key) || !entry || typeof entry.ts !== 'number') continue;
      const localVal = rawGet.call(localStorage, key);
      const localTs = meta[key];
      // Server wins ONLY when this browser has nothing for the key, or when
      // the server entry is STRICTLY newer than a tracked local write. A local
      // value with no timestamp (written by an older bundle / another code
      // path) is what the user currently sees — never clobber it; push it up.
      const adoptServer = localVal === null
        ? true
        : localTs !== undefined && entry.ts > localTs;
      if (adoptServer) {
        try {
          if (entry.v === null) rawRemove.call(localStorage, key);
          else if (typeof entry.v === 'string') rawSet.call(localStorage, key, entry.v);
          meta[key] = entry.ts;
        } catch { /* quota */ }
      } else if (localVal !== entry.v) {
        const ts = localTs ?? Date.now();
        meta[key] = ts;
        localOnly[key] = { v: localVal, ts };
      }
    }
    persistMeta();
    if (Object.keys(localOnly).length > 0) {
      void apiPut('/api/ui-prefs', { prefs: localOnly }).catch(() => {});
    }
  } catch { /* first boot or offline — keep local values */ }

  wrapLocalStorageWrites();
  window.addEventListener('pagehide', flushKeepalive);
}

let wrapped = false;
/**
 * Mirror every localStorage write from now on. The PROTOTYPE is wrapped, never
 * the instance: on WebKit (the Mac app) `localStorage.setItem = fn` does not
 * replace the method, it stores an item named "setItem" holding the function's
 * source, so no write was ever mirrored there. sessionStorage shares the
 * prototype, hence the `this === localStorage` check. A second evaluation of
 * this module (HMR) REPLACES the wrappers rather than stacking on them: both
 * call the same captured raw methods.
 */
export function wrapLocalStorageWrites(): void {
  if (wrapped || !storageProto) return;
  wrapped = true;
  // Items an older bundle wrote by assigning the methods on WebKit.
  for (const junk of ['setItem', 'removeItem']) {
    const v = rawGet.call(localStorage, junk);
    if (v !== null && /=>|function/.test(v)) rawRemove.call(localStorage, junk);
  }
  storageProto.setItem = function setItem(this: Storage, key: string, value: string) {
    rawSet.call(this, key, value);
    if (this === localStorage) queue(key, value);
  };
  storageProto.removeItem = function removeItem(this: Storage, key: string) {
    rawRemove.call(this, key);
    if (this === localStorage) queue(key, null);
  };
}
