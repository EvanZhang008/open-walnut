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
 *  - a first read that times out (a deploy, a busy Mac) does not wait the render
 *    out: the page renders on its local values, keeps asking in the background,
 *    and holds its writes until the server answers; then the server's values win
 *    over those writes and the app mounts again to show them (initUiPrefsSync).
 *
 * Only layout/preference keys sync (open-walnut-* / walnut-todo-*). Device
 * tokens (walnut.deviceToken), chat drafts (draft:*), per-session diff review
 * state (open-walnut-diff-review:*), and machine-specific keys that embed an
 * absolute path (open-walnut-file-explorer-selected:*) never leave the browser.
 */

import { apiGet, apiPut } from '@/api/client';
import { log } from '@/utils/log';
import { getDeviceToken } from '@/api/device-token';
import { SKIP_PREFS_MERGE_FLAG } from './crash-recovery';
import { LAYOUT_PREFIX, adoptsServerLayout } from './layout-record';
import { BOOT_TIMEOUT_MS, EVENT_RETRY_TIMEOUT_MS, RETRY_PLAN, SLOW_RETRY_MS, settledRefusal } from './ui-prefs-retry';
import { forgetStale, showLatePrefs, staleValueOf, touchedSinceLateMerge, watchInteraction, __resetLateRemountForTests } from './ui-prefs-remount';
import { UNION_PREF_KEYS } from '../../../src/core/recent-opened-list';

const INCLUDE_PREFIXES = ['open-walnut-', 'walnut-todo-'];
/**
 * Never mirrored. Two different reasons:
 *  - `open-walnut-diff-review:` — a per-session blob, too big and too transient.
 *  - `open-walnut-file-explorer-selected:` — the KEY embeds an absolute
 *    filesystem path (`…:local:/Users/me/repo`), so the entry means nothing on
 *    another device. Since ui-prefs.json now lives in the SYNCED
 *    config/share/ (git-tracked), such a key would export this box's paths to
 *    every other one.
 *  - `open-walnut-view:panel.` / `open-walnut-view:tab.` — what a session panel
 *    shows (a file path, a localhost service) and which panel is full screen:
 *    this window's own, kept across its reloads and restarts on this device.
 *  - `open-walnut-diff-state:` — the Changed tab's comparison and open file per
 *    session (an absolute path): this browser's, like its Viewed marks.
 *    The server's twin is MACHINE_LOCAL_PREFIXES in src/core/ui-prefs-keys.ts.
 */
const EXCLUDE_PREFIXES = ['open-walnut-diff-review:', 'open-walnut-file-explorer-selected:', 'open-walnut-view:panel.', 'open-walnut-view:tab.', 'open-walnut-diff-state:'];
/** Keys the boot merge combines instead of taking the newer side (each side's raw value in, the stored value out). */
const MERGED_KEYS = UNION_PREF_KEYS;
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
interface RawStorage { get: Storage['getItem']; set: Storage['setItem']; remove: Storage['removeItem']; clear: Storage['clear'] }
const RAW_STORAGE = Symbol.for('open-walnut.ui-prefs-sync.raw-storage');
const storageProto: Storage | null = typeof Storage === 'undefined' ? null : Storage.prototype;
function rawStorage(proto: Storage): RawStorage {
  const holder = proto as unknown as Record<symbol, RawStorage | undefined>;
  const known = holder[RAW_STORAGE];
  if (known) return known;
  const raw: RawStorage = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem, clear: proto.clear };
  Object.defineProperty(proto, RAW_STORAGE, { value: raw, enumerable: false, configurable: true });
  return raw;
}
const raw: RawStorage | null = storageProto ? rawStorage(storageProto) : null;
const noop = () => null;
const rawGet: Storage['getItem'] = raw?.get ?? noop;
const rawSet: Storage['setItem'] = raw?.set ?? noop;
const rawRemove: Storage['removeItem'] = raw?.remove ?? noop;
const rawClear: Storage['clear'] = raw?.clear ?? (() => undefined);
const FLUSH_DEBOUNCE_MS = 800;

// ── What this page wrote ──
//
// The browser's storage can take a write and later drop it. 2026-11-15, the Mac app: its WebKit
// storage database was locked for two days ("SQLiteStorageArea::setItem failed ... database is
// locked"), every write failed in the background, and WebKit put the page's storage back to what
// was on disk, so a side bar closed a second before was open again when the user came back to
// the page. So this page keeps every value it wrote (or adopted from the server) and reads its own
// value first; another tab's write (a real `storage` event) hands the key back to storage. Values
// are the same strings the writer passed: kept by reference, they cost no copy.
//
// A storage that put a key back holds a value this page already knew there: what the key held when
// the page first wrote it (what was on disk), or one of its own later writes. Any other value is
// someone else's write that raised no event here: an extension's content script writing this page's
// storage from its own world (2026-11-16: the password extension hands the page its browser key that
// way, and the page kept reading the "no key" it had written itself), or another tab whose event has
// not arrived yet. That value is storage's again, as before this layer.
interface PageWrite {
  mine: string | null;
  /** False once another writer's value is in storage: storage's again until this page writes. */
  held: boolean;
  /** Values a put-back can bring, kept across another writer's turn (the disk may still hold one). */
  known: Array<string | null>;
}
const pageWrites = new Map<string, PageWrite>();
/** Values per key a put-back can bring: what the page first found there, then its latest writes. */
const KNOWN_MAX = 8;
/** Keys whose stored value went back on this page (logged once each). */
const lostWrites = new Set<string>();

function noteLost(key: string, mine: string | null, now: string | null): void {
  if (lostWrites.has(key)) return;
  lostWrites.add(key);
  log.warn('ui-prefs', 'browser storage lost a write; this page keeps its own value', {
    key, mineBytes: mine?.length ?? -1, storedBytes: now?.length ?? -1, lostKeys: lostWrites.size,
  });
}

/** This page's value of a key: its own last write, unless someone else wrote it since; else what storage holds. */
function localGet(key: string): string | null {
  const w = pageWrites.get(key);
  let now: string | null;
  try { now = rawGet.call(localStorage, key); } catch (err) { if (w?.held) return w.mine; throw err; }
  if (!w?.held || now === w.mine) return now;
  if (!w.known.includes(now)) { w.held = false; return now; }
  noteLost(key, w.mine, now);
  return w.mine;
}
function remember(w: PageWrite, value: string | null): void {
  if (w.known.includes(value)) return;
  w.known.push(value);
  // The first stays: it is what the disk held when this page started writing the key.
  if (w.known.length > KNOWN_MAX) w.known.splice(1, 1);
}
function keep(key: string, value: string | null, before: string | null): void {
  const w = pageWrites.get(key);
  if (!w) { pageWrites.set(key, { mine: value, held: true, known: before === value ? [value] : [before, value] }); return; }
  // What storage held just before: another writer's value this page never read is one a put-back can bring too.
  remember(w, before);
  remember(w, value);
  w.mine = value;
  w.held = true;
}
function storedNow(key: string): string | null {
  try { return rawGet.call(localStorage, key); } catch { return null; }
}
/** Writes that throw (quota, storage off) are not kept: the caller is told, as before. */
function localSet(key: string, value: string): void {
  const before = storedNow(key);
  rawSet.call(localStorage, key, value);
  keep(key, String(value), before);
}
function localRemove(key: string): void {
  const before = storedNow(key);
  rawRemove.call(localStorage, key);
  keep(key, null, before);
}

/** Another tab of this browser wrote: storage holds its value now, not this page's. */
function onOtherTabWrite(e: StorageEvent): void {
  try { if (e.storageArea !== localStorage) return; } catch { return; }
  if (e.key === null) for (const w of pageWrites.values()) w.held = false;
  else { const w = pageWrites.get(e.key); if (w) w.held = false; }
}
// From the first write on (the drafts adopt theirs before the wrap), and once per page: a hot
// reload replaces the listener, never adds a second one. Capture: it runs before any page's own
// storage listener reads the key.
const OTHER_TAB_LISTENER = Symbol.for('open-walnut.ui-prefs-sync.other-tab-listener');
try {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const slot = window as unknown as Record<symbol, ((e: StorageEvent) => void) | undefined>;
    const prev = slot[OTHER_TAB_LISTENER];
    if (prev) window.removeEventListener('storage', prev as EventListener, true);
    slot[OTHER_TAB_LISTENER] = onOtherTabWrite;
    window.addEventListener('storage', onOtherTabWrite as EventListener, true);
  }
} catch { /* no DOM */ }

/** localStorage without the mirror: a write through these is seen by no listener. */
export const rawLocalStorage = {
  get: (key: string): string | null => { try { return localGet(key); } catch { return null; } },
  set: (key: string, value: string): void => { localSet(key, value); },
  remove: (key: string): void => { localRemove(key); },
};

type StorageWriteListener = (key: string, value: string | null) => void;
const writeListeners = new Set<StorageWriteListener>();
/** Every localStorage write after boot, from any code path (the draft mirror reads its keys here). */
export function onLocalStorageWrite(cb: StorageWriteListener): () => void {
  writeListeners.add(cb);
  return () => { writeListeners.delete(cb); };
}
function notifyWrite(key: string, value: string | null): void {
  for (const cb of writeListeners) { try { cb(key, value); } catch { /* a listener never fails the write */ } }
}

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

function parseMeta(text: string | null): Record<string, number> {
  try {
    if (text) {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
    }
  } catch { /* corrupt — start fresh */ }
  return {};
}

/**
 * The write stamps, this page's and storage's together (the newer stamp of each key): another tab
 * may have stamped a key a moment before its storage event reaches this page, and storage may have
 * dropped this page's own stamps (pageWrites above).
 */
function readMeta(): Record<string, number> {
  const mine = parseMeta(localGet(META_KEY));
  let stored: Record<string, number> = mine;
  try { stored = parseMeta(rawGet.call(localStorage, META_KEY)); } catch { /* storage off */ }
  if (stored === mine) return mine;
  const out = { ...stored };
  for (const [k, ts] of Object.entries(mine)) if (typeof ts === 'number' && !(typeof out[k] === 'number' && out[k] >= ts)) out[k] = ts;
  return out;
}

let meta: Record<string, number> = {};

function persistMeta() {
  try { localSet(META_KEY, JSON.stringify(meta)); } catch { /* quota */ }
}

let pending = new Map<string, PrefEntry>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function takePending(): Record<string, PrefEntry> | null {
  if (pending.size === 0) return null;
  const prefs = Object.fromEntries(pending);
  pending = new Map();
  return prefs;
}

/**
 * A list both sides add to (MERGED_KEYS): read the server's copy just before the PUT and send
 * the union, stamped newer than it, so an open another device saved since this window last
 * looked is kept rather than replaced. This window takes the union too, unless the key
 * changed again meanwhile (that write queues its own merge).
 */
async function mergeWithServer(prefs: Record<string, PrefEntry>): Promise<void> {
  for (const [key, entry] of Object.entries(prefs)) {
    const merge = MERGED_KEYS[key];
    if (!merge || typeof entry.v !== 'string') continue;
    try {
      const res = await apiGet<{ prefs?: Record<string, PrefEntry> }>(
        '/api/ui-prefs', { key }, { timeoutMs: 2500, priority: 'low' },
      );
      const theirs = res?.prefs?.[key];
      if (!theirs || typeof theirs.v !== 'string') continue;
      const mine = entry.v;
      const merged = merge(mine, theirs.v);
      entry.ts = Math.max(entry.ts, theirs.ts + 1);
      if (merged === mine) continue;
      entry.v = merged;
      if (localGet(key) !== mine) continue;
      localSet(key, merged);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: merged }));
    } catch { /* offline: PUT this window's copy; the next boot merge unions them */ }
  }
}

async function flush() {
  const prefs = takePending();
  if (!prefs) return;
  await mergeWithServer(prefs);
  try {
    // keepalive: a navigation that starts while the batch is in flight (a click on a link, a
    // reload) must not cancel it, or the change is lost and WebKit logs the cancel as an error.
    await apiPut('/api/ui-prefs', { prefs }, { keepalive: true });
  } catch {
    // Offline / transient failure: drop silently — localStorage still has the
    // truth for this browser; the next write re-syncs the touched keys.
  }
}

function queue(key: string, value: string | null) {
  if (!syncable(key)) return;
  // An automated browser that did not read the server's layout record must not write it
  // either: a Playwright look at the live server would replace the user's pins.
  if (key.startsWith(LAYOUT_PREFIX) && !adoptsServerLayout()) return;
  // Re-read meta before mutating: several tabs share this store, and writing
  // a stale in-memory copy would erase another tab's timestamps (its keys
  // would then lose to older server values on the next boot merge).
  meta = readMeta();
  if (!serverRead) {
    // Not read yet (the first read timed out): stamped weakest and never sent, so it can
    // never win over the server's value, now or at the next boot merge (mergeServerPrefs).
    meta[key] = 0;
    persistMeta();
    heldKeys.add(key);
    return;
  }
  const shownAs = staleValueOf(key);
  if (shownAs !== undefined) {
    // Read late, not shown yet (ui-prefs-remount.ts): untouched, this is a default re-saved.
    if (!touchedSinceLateMerge()) {
      try { if (shownAs === null) localRemove(key); else localSet(key, shownAs); } catch { /* quota */ }
      return;
    }
    forgetStale(key);
  }
  const ts = Date.now();
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
 * Merge the server's prefs into localStorage with the boot rules (last writer wins per key, the
 * lists both sides add to combined), and say which keys changed and what to send back.
 *
 * `held` are the keys this page wrote before it had read the server's prefs: those writes are
 * a component's defaults far more often than the person's choice (they ran before the user's
 * own layout could reach the page), so the server's value wins whenever it holds the key, and
 * only a key it does not hold is sent up.
 */
function mergeServerPrefs(server: Record<string, PrefEntry>, held: ReadonlySet<string>): { changed: string[]; push: Record<string, PrefEntry> } {
  const push: Record<string, PrefEntry> = {};
  const changed: string[] = [];
  // Under browser automation the shared fixture server's layout record belongs to
  // whichever spec wrote it last (layout-record.ts adoptsServerLayout).
  const adoptLayout = adoptsServerLayout();
  const setRaw = (key: string, value: string | null): void => {
    try {
      if (localGet(key) === value) return;
      if (value === null) localRemove(key);
      else localSet(key, value);
      changed.push(key);
    } catch { /* quota */ }
  };
  for (const [key, entry] of Object.entries(server)) {
    if (!syncable(key) || !entry || typeof entry.ts !== 'number') continue;
    if (!adoptLayout && key.startsWith(LAYOUT_PREFIX)) continue;
    const localVal = localGet(key);
    const localTs = meta[key];
    // A list both sides add to (the tasks opened lately): one list from the two, never the
    // newer side replacing the other, so an open whose write never reached the server stays.
    const merge = MERGED_KEYS[key];
    if (merge && localVal !== null && typeof entry.v === 'string') {
      const merged = merge(localVal, entry.v);
      setRaw(key, merged);
      meta[key] = Math.max(localTs ?? 0, entry.ts);
      if (merged !== entry.v) push[key] = { v: merged, ts: Math.max(Date.now(), entry.ts + 1) };
      continue;
    }
    // Server wins when this page wrote the key before reading it (held), when this browser
    // has nothing for the key, or when the server entry is STRICTLY newer than a tracked
    // local write. A local value with no timestamp (written by an older bundle / another
    // code path) is what the user currently sees: never clobber it; push it up.
    const adoptServer = held.has(key) || localVal === null || (localTs !== undefined && entry.ts > localTs);
    if (adoptServer) {
      if (entry.v === null || typeof entry.v === 'string') {
        setRaw(key, entry.v);
        meta[key] = entry.ts;
      }
    } else if (localVal !== entry.v) {
      const ts = localTs ?? Date.now();
      meta[key] = ts;
      push[key] = { v: localVal, ts };
    }
  }
  for (const key of held) {
    if (key in server || !syncable(key)) continue;
    const value = localGet(key);
    if (value === null) continue;
    const ts = Date.now();
    meta[key] = ts;
    push[key] = { v: value, ts };
  }
  return { changed, push };
}

// ── The first read, and its retries ──
//
// The first render never waits on more than BOOT_TIMEOUT_MS (a page that opens at once beats
// one that opens right). When that read fails, the page keeps asking in the background until
// the server answers (a deploy, a busy Mac: 2026-11 the Mac app opened on the default layout,
// the CEO chat open, and never took the user's), and until then holds its writes: a write is
// stamped weakest (0) and never sent, so a default a component saved cannot replace the
// user's prefs on the server, on this load or the next one. A refusal asking again will not
// change (a 4xx) ends the wait: the page syncs on its local values, as before.


/** True once this page has read the server's prefs (or was told to skip them after a crash heal). */
let serverRead = false;
/** Syncable keys written in this page before `serverRead`. */
const heldKeys = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryStep = 0;
let reading = false;
export { setLatePrefsHost, type LatePrefsHost } from './ui-prefs-remount';
export { RETRY_PLAN, SLOW_RETRY_MS } from './ui-prefs-retry';

const onOnline = (): void => { retryNow(); };
const onVisible = (): void => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') retryNow(); };

function listenUntilRead(on: boolean): void {
  const fn = on ? 'addEventListener' : 'removeEventListener';
  try {
    window[fn]('online', onOnline);
    if (typeof document !== 'undefined') document[fn]('visibilitychange', onVisible);
  } catch { /* no DOM (tests) */ }
}

async function readServerPrefs(timeoutMs: number): Promise<Record<string, PrefEntry>> {
  const res = await apiGet<{ prefs: Record<string, PrefEntry> }>('/api/ui-prefs', undefined, { timeoutMs });
  // No body is no answer (a 204): never read it as "the server holds nothing".
  if (!res || typeof res !== 'object') throw new Error('ui-prefs: empty answer');
  return res.prefs ?? {};
}

function giveUpReading(): void {
  serverRead = true;
  heldKeys.clear();
  clearTimeout(retryTimer);
  listenUntilRead(false);
  watchInteraction(false);
}

function scheduleRetry(): void {
  clearTimeout(retryTimer);
  if (serverRead) return;
  const step = RETRY_PLAN[retryStep];
  const wait = step ? step.waitMs : SLOW_RETRY_MS;
  const timeoutMs = step ? step.timeoutMs : RETRY_PLAN[RETRY_PLAN.length - 1].timeoutMs;
  retryStep++;
  retryTimer = setTimeout(() => void attemptLateRead(timeoutMs), wait);
}

function retryNow(): void {
  if (serverRead || reading) return;
  clearTimeout(retryTimer);
  void attemptLateRead(EVENT_RETRY_TIMEOUT_MS);
}

async function attemptLateRead(timeoutMs: number): Promise<void> {
  if (serverRead || reading) return;
  reading = true;
  let prefs: Record<string, PrefEntry> | null = null;
  let refused = false;
  try { prefs = await readServerPrefs(timeoutMs); } catch (err) { prefs = null; refused = settledRefusal(err); } finally { reading = false; }
  if (serverRead) return;
  if (refused) { giveUpReading(); return; }
  if (!prefs) { scheduleRetry(); return; }
  applyLatePrefs(prefs);
}

function applyLatePrefs(prefs: Record<string, PrefEntry>): void {
  meta = readMeta();
  const { changed, push } = mergeServerPrefs(prefs, heldKeys);
  persistMeta();
  serverRead = true;
  heldKeys.clear();
  clearTimeout(retryTimer);
  listenUntilRead(false);
  if (Object.keys(push).length > 0) void apiPut('/api/ui-prefs', { prefs: push }).catch(() => {});
  for (const key of changed) {
    try { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localGet(key) })); } catch { /* no DOM */ }
  }
  // The UI reads these keys in useState initializers: ui-prefs-remount.ts mounts the app again
  // (at once on a young untouched page, else once it is hidden). The lists both sides add to
  // (MERGED_KEYS) are read through their storage listeners and need no remount.
  const shown = showLatePrefs(changed.filter((k) => !MERGED_KEYS[k]).map((k) => [k, localGet(k)] as const));
  log.info('ui-prefs', 'late prefs applied', { changed: changed.length, pushed: Object.keys(push).length, shown, tries: retryStep + 1 });
}

/**
 * Merge server prefs into localStorage (LWW per key), then start mirroring writes back. Await
 * this BEFORE the first render: components read the keys synchronously in useState
 * initializers. Resolves within BOOT_TIMEOUT_MS and never throws; when that read fails the
 * page renders on its local values and the read goes on in the background (see above).
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

  if (skipMerge) {
    // The heal's own writes are meant to reach the server: plain last-writer-wins.
    serverRead = true;
  } else {
    listenUntilRead(true);
    watchInteraction(true);
    // `reading` keeps an online/visibility retry from asking a second time meanwhile.
    reading = true;
    try {
      const prefs = await readServerPrefs(BOOT_TIMEOUT_MS).finally(() => { reading = false; });
      const { push } = mergeServerPrefs(prefs, heldKeys);
      persistMeta();
      serverRead = true;
      listenUntilRead(false);
      watchInteraction(false);
      if (Object.keys(push).length > 0) void apiPut('/api/ui-prefs', { prefs: push }).catch(() => {});
    } catch (err) {
      if (settledRefusal(err)) {
        giveUpReading();
      } else {
        // Slow or offline: render on the local values, keep asking in the background.
        log.warn('ui-prefs', 'first read failed, retrying in the background', { error: String((err as Error)?.message ?? err) });
        scheduleRetry();
      }
    }
  }

  wrapLocalStorageWrites();
  window.addEventListener('pagehide', flushKeepalive);
}

/** Test hook: forget this page's read state (the module is shared across a test file's cases). */
export function __resetUiPrefsSyncForTests(): void {
  clearTimeout(retryTimer);
  serverRead = false;
  heldKeys.clear();
  retryStep = 0;
  reading = false;
  __resetLateRemountForTests();
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
    if (this !== localStorage) { rawSet.call(this, key, value); return; }
    // A write of the value the key already holds changes nothing to sync: a boot that
    // re-saved its state used to PUT it back every load (N19).
    const unchanged = localGet(key) === String(value) && rawGet.call(this, key) === String(value);
    localSet(key, value);
    if (!unchanged) { queue(key, value); notifyWrite(key, String(value)); }
  };
  storageProto.removeItem = function removeItem(this: Storage, key: string) {
    if (this !== localStorage) { rawRemove.call(this, key); return; }
    localRemove(key);
    queue(key, null); notifyWrite(key, null);
  };
  // Every reader (view memory, the layout record, a plugin's own key) gets this page's value.
  storageProto.getItem = function getItem(this: Storage, key: string) {
    return this === localStorage ? localGet(key) : rawGet.call(this, key);
  };
  storageProto.clear = function clear(this: Storage) {
    if (this === localStorage) pageWrites.clear();
    rawClear.call(this);
  };
}
