/**
 * Unsent drafts, the one store every input box keeps its words in.
 *
 * 2026-10-27, the user: "all the input boxes must save permanently". A reply
 * typed into the Ask here card was gone after they went to chat somewhere else
 * and came back; that box kept its words in React state only.
 *
 * The rule: a box keeps what was typed and not sent under a `draft:` key named
 * after the thing it belongs to (`draftKey('question', sessionId, threadKey)`),
 * and only a successful send, or the person clearing the box, removes it.
 * Leaving the page, switching sessions, closing a popover, a reload and an app
 * restart all keep it. A message composer does this through ChatInput's
 * `draftKey`; any other box through `useDraft` (hooks/useDraft.ts). A ratchet
 * (tests/web/draft-inputs-ratchet.test.ts) fails on a box that does neither.
 *
 * Storage: this browser's localStorage, written at once, and a mirror on the
 * server (src/web/routes/drafts.ts) so a draft survives cleared browser data and
 * reaches every other browser of this Walnut (typed in Chrome, there in the Mac
 * app). Every localStorage write of a draft key is mirrored, from any code path
 * (ui-prefs-sync.ts's write listener), so an older writer needs no change.
 * Last writer wins per key; the server's copy is read before the first render,
 * and again whenever the window comes back to the front.
 */
import { apiGet, apiPut } from '@/api/client';
import { getDeviceToken } from '@/api/device-token';
import { log } from '@/utils/log';
import { foldPending, hasCredential, isDraftKey, MAX_SYNCED_DRAFT_LEN, planDraftMerge, type DraftEntry } from './draft-merge';
import { onLocalStorageWrite, rawLocalStorage } from './ui-prefs-sync';

export { isDraftKey } from './draft-merge';

/** A draft's key: `draft:<kind>:<id>…`, each part the id of what the box belongs to. */
export function draftKey(kind: string, ...ids: Array<string | number>): string {
  return ['draft', kind, ...ids.map(String)].join(':');
}

/** A short stable id for an object known only by its text (an ask's questions). */
export function draftHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** An AskUserQuestion's own-words answers: one draft per ask, whichever surface shows it. */
export function askAnswerDraftKey(questions: ReadonlyArray<{ question: string }>): string {
  return draftKey('ask-answer', draftHash(questions.map((q) => q.question).join('\n')));
}

/** The words kept under a key ('' when none). */
export function readDraft(key: string | null | undefined): string {
  if (!key) return '';
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

/** Keep `text` under `key`; empty text removes the draft. */
export function writeDraft(key: string, text: string): void {
  try {
    if (text) { if (localStorage.getItem(key) !== text) localStorage.setItem(key, text); }
    else localStorage.removeItem(key);
  } catch { /* quota or storage off: the box still shows the text */ }
}

/** The draft was sent or the person cleared it. */
export function clearDraft(key: string | null | undefined): void {
  if (key) writeDraft(key, '');
}

/** A draft as a JSON value (a form's several fields under one key). */
export function readDraftJson<T>(key: string): T | undefined {
  const raw = readDraft(key);
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}
export function writeDraftJson(key: string, value: unknown): void {
  writeDraft(key, value === undefined ? '' : JSON.stringify(value));
}

// ── Changes seen by every open box of a key ──

type DraftListener = (text: string) => void;
const listeners = new Map<string, Set<DraftListener>>();

/** Called when the key's draft changes: another box of this window, another tab, window or device. */
export function subscribeDraft(key: string, cb: DraftListener): () => void {
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(cb);
  return () => { set!.delete(cb); if (set!.size === 0) listeners.delete(key); };
}
function emit(key: string): void {
  const text = readDraft(key);
  for (const cb of listeners.get(key) ?? []) { try { cb(text); } catch { /* one box never stops another */ } }
}

// ── The mirror ──

/** When this browser last wrote each draft key (deletes included). */
const META_KEY = 'walnut-drafts-meta';
const FLUSH_DEBOUNCE_MS = 800;
const RETRY_MS = 5_000;
const PULL_MIN_GAP_MS = 3_000;
/** The server keeps a removal 30 days; a stamp for a key with no words here goes after that. */
const META_KEEP_MS = 30 * 86_400_000;
/** fetch keepalive refuses a body over 64 KB. */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

function readMeta(): Record<string, number> {
  try {
    const parsed = JSON.parse(rawLocalStorage.get(META_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, number> : {};
  } catch { return {}; }
}
function writeMeta(meta: Record<string, number>): void {
  try { rawLocalStorage.set(META_KEY, JSON.stringify(meta)); } catch { /* quota */ }
}

let pending = new Map<string, DraftEntry>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function schedule(ms: number): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flush(); }, ms);
}

async function flush(): Promise<void> {
  if (pending.size === 0) return;
  const batch = pending;
  pending = new Map();
  try {
    await apiPut('/api/drafts', { drafts: Object.fromEntries(batch) });
  } catch (err) {
    // Kept for the next try: this browser still has every word, the server catches up.
    for (const [key, entry] of batch) foldPending(pending, key, entry);
    log.warn('drafts', 'draft mirror write failed, retrying', { keys: batch.size, error: err instanceof Error ? err.message : String(err) });
    schedule(RETRY_MS);
  }
}

function onWrite(key: string, value: string | null): void {
  if (!isDraftKey(key)) return;
  // Two boxes of one object in this window (a question's card and the panel
  // composer aimed at it) show the same words.
  emit(key);
  const meta = readMeta();
  // A remove of a draft this browser never wrote nor took from the server is not news.
  if (value === null && meta[key] === undefined) return;
  const ts = Math.max(Date.now(), (meta[key] ?? 0) + 1);
  meta[key] = ts;
  writeMeta(meta);
  // Too long, or holding a credential: kept in this browser only. Its stamp still
  // counts, so an older copy elsewhere never wins over it here. A credential that
  // replaced words the server holds goes up as a removal of those words.
  if (value !== null && value.length > MAX_SYNCED_DRAFT_LEN) return;
  if (value !== null && hasCredential(value)) { foldPending(pending, key, { v: null, ts }); schedule(FLUSH_DEBOUNCE_MS); return; }
  foldPending(pending, key, { v: value, ts });
  schedule(FLUSH_DEBOUNCE_MS);
}

function flushKeepalive(): void {
  if (pending.size === 0) return;
  clearTimeout(flushTimer);
  const entries = [...pending].sort((a, b) => b[1].ts - a[1].ts);
  const body: Record<string, DraftEntry> = {};
  let bytes = 16;
  for (const [key, entry] of entries) {
    const size = key.length + (entry.v?.length ?? 4) * 3 + 32;
    if (bytes + size > KEEPALIVE_MAX_BYTES) continue;
    body[key] = entry;
    bytes += size;
  }
  // What did not fit is still in localStorage, stamped newer: the next boot pushes it.
  pending = new Map();
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = getDeviceToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Offline: nothing is lost, the local stamps are newer and the next boot pushes them.
    void fetch('/api/drafts', { method: 'PUT', headers, body: JSON.stringify({ drafts: body }), keepalive: true }).catch(() => {});
  } catch { /* best effort */ }
}

function localView() {
  const meta = readMeta();
  return {
    meta,
    view: {
      get: (key: string) => rawLocalStorage.get(key),
      ts: (key: string) => meta[key],
      keys: () => {
        const out: string[] = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && isDraftKey(k)) out.push(k);
          }
        } catch { /* storage off */ }
        return out;
      },
    },
  };
}

/** Read the server's drafts and merge them here; `notify` tells open boxes about adopted ones. */
async function pull(notify: boolean, timeoutMs: number): Promise<void> {
  const res = await apiGet<{ drafts: Record<string, DraftEntry> }>('/api/drafts', undefined, { timeoutMs });
  const { meta, view } = localView();
  const plan = planDraftMerge(res.drafts ?? {}, view);
  const adopted: string[] = [];
  for (const [key, entry] of Object.entries(plan.adopt)) {
    // A write waiting to go up is newer than anything the server could hold.
    if (pending.has(key)) continue;
    try {
      if (entry.v === null) rawLocalStorage.remove(key);
      else rawLocalStorage.set(key, entry.v);
      meta[key] = entry.ts;
      adopted.push(key);
    } catch { /* quota */ }
  }
  for (const [key, entry] of Object.entries(plan.push)) {
    meta[key] = entry.ts;
    foldPending(pending, key, entry);
  }
  // A removal's stamp outlives the server's tombstone for no use.
  const horizon = Date.now() - META_KEEP_MS;
  for (const [key, ts] of Object.entries(meta)) {
    if (ts < horizon && !pending.has(key) && rawLocalStorage.get(key) === null) delete meta[key];
  }
  writeMeta(meta);
  if (pending.size) schedule(FLUSH_DEBOUNCE_MS);
  if (notify) for (const key of adopted) emit(key);
  if (adopted.length || Object.keys(plan.push).length) {
    log.info('drafts', 'drafts merged with the server', { adopted: adopted.length, pushed: Object.keys(plan.push).length });
  }
}

let lastPullAt = 0;
function pullSoon(): void {
  if (Date.now() - lastPullAt < PULL_MIN_GAP_MS) return;
  lastPullAt = Date.now();
  void pull(true, 5_000).catch(() => { /* offline: local drafts stand */ });
}

/**
 * Merge the server's drafts into this browser, then mirror every draft write.
 * Await before the first render: boxes read their draft in a useState
 * initializer. Never throws; offline keeps this browser's drafts.
 */
export async function initDraftSync(): Promise<void> {
  if (started || typeof window === 'undefined') return;
  onLocalStorageWrite(onWrite);
  try {
    lastPullAt = Date.now();
    await pull(false, 2_500);
  } catch { /* offline or an older server: this browser's drafts stand */ }
  started = true;
  window.addEventListener('pagehide', flushKeepalive);
  window.addEventListener('focus', pullSoon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullSoon();
    else flushKeepalive();
  });
  window.addEventListener('online', () => { void flush(); });
  // Another tab of this browser wrote a draft: open boxes here follow it.
  window.addEventListener('storage', (e) => { if (e.key && isDraftKey(e.key)) emit(e.key); });
}
