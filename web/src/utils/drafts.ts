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
import { sendUuidsOfRow, type RowWithSendUuids } from '@/utils/send-uuids';
import { foldPending, hasCredential, isDraftKey, MAX_SYNCED_DRAFT_LEN, planDraftMerge, type DraftEntry } from './draft-merge';
import { onLocalStorageWrite, rawLocalStorage } from './ui-prefs-sync';
import { KEPT_ATTACHMENTS_PREFIX } from './kept-attachments-key';

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

/** The note a deny carries on one permission prompt (PromptCards.tsx). */
export function permissionNoteDraftKey(requestId: string): string {
  return draftKey('permission-note', requestId);
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

/**
 * The draft's owner threw it away (a draft column closed, its words became a
 * task, a fork draft closed): its words go now, and a save a mounted box still
 * owes from before is dropped. Without this the box's unmount flush (ChatInput
 * writes its debounced save when it goes) put the words back right after the
 * owner removed them, so a closed draft column came back on the next load and
 * on every other device (2026-10-30). A box typed in again after the discard
 * saves as usual.
 */
export function discardDraft(key: string): void {
  discardedAt.set(key, ++saveSeq);
  writeDraft(key, '');
  // The attachments kept beside the words go with them (ChatInput keeps them on this device).
  try { localStorage.removeItem(KEPT_ATTACHMENTS_PREFIX + key); } catch { /* storage off */ }
}

/** A mark for a save a box owes, taken when the words were typed; with `key`, also the key's newest revision. */
export function draftSaveMark(key?: string | null): number {
  const mark = ++saveSeq;
  if (key) {
    revisions.set(key, { mark });
    unbindKey(key);
    if (failedRecords().some((r) => r.key === key)) dropFailed((r) => r.key === key);
  }
  return mark;
}

/** Was the key discarded after a save marked `mark` was owed? */
export function discardedSince(key: string, mark: number): boolean {
  return (discardedAt.get(key) ?? 0) > mark;
}

let saveSeq = 0;
const discardedAt = new Map<string, number>();

/**
 * The box sent `text` from `key`. From now on a copy of those words is never
 * written back as the key's draft: a save a box owed from before the send, a
 * reload flush of a box still showing them, the server's copy from before
 * (2026-10-30: a debounced save fired while the send was on its way, and the
 * sent message came back as the draft and was sent twice). Words typed after
 * the send take a newer mark and save as usual, the same words included.
 * Returns the send's mark, for unmarkDraftSent when the send fails.
 */
export function markDraftSent(key: string, text: string): number {
  const mark = ++saveSeq;
  if (text.trim()) sentAt.set(key, { text: text.trim(), mark, at: Date.now() });
  return mark;
}

/**
 * How long after a send a server copy of the sent words is still a copy. Long
 * enough for every window's owed save and the mirror's debounce to have gone up;
 * the same words typed on another device later than that are that device's draft.
 */
const SENT_COPY_WINDOW_MS = 60_000;

/** The send marked `mark` failed: its words are the draft again. */
export function unmarkDraftSent(key: string, mark: number): void {
  if (sentAt.get(key)?.mark === mark) sentAt.delete(key);
}

/**
 * Is `text` a copy of the words last sent from `key`? With `mark` (when the
 * writer's words were typed), only words typed before that send count.
 */
export function isSentDraftCopy(key: string, text: string | null, mark?: number, stampedAt?: number): boolean {
  const sent = sentAt.get(key);
  if (!sent || !text?.trim()) return false;
  if (mark !== undefined && mark > sent.mark) return false;
  // A server copy (stamped when its writer saved it) from well after the send was typed again.
  if (stampedAt !== undefined && stampedAt > sent.at + SENT_COPY_WINDOW_MS) return false;
  return text.trim() === sent.text;
}

const sentAt = new Map<string, { text: string; mark: number; at: number }>();

/** Local composer ownership, never sent to the server. */
export interface DraftOrigin { readonly key: string; readonly text: string; readonly sent: number }

export function draftOriginOf(key: string, text: string): DraftOrigin {
  return { key, text, sent: ++saveSeq };
}

const revisions = new Map<string, { mark: number; origin?: number }>();

/** The draft's words; undefined when storage cannot be read (never taken for empty). */
const storedDraft = (key: string): string | undefined => { try { return localStorage.getItem(key) ?? ''; } catch { return undefined; } };

// A refused send's ownership across a reload: its session and user-line uuid, the
// draft key, and a hash and META stamp of the words (never the words). This browser only.
const FAILED_KEY = 'walnut-failed-drafts';
interface FailedDraft { sid: string; uuid: string; key: string; hash: string; stamp: number }
const bound = new WeakMap<DraftOrigin, { sid: string; uuid: string }>();
/** Claimed (refused) origins only, by session and uuid: an accepted send is never held here. */
const boundBy = new Map<string, DraftOrigin>();
const unbindKey = (key: string): void => { for (const [k, o] of boundBy) if (o.key === key) boundBy.delete(k); };
/** Origins whose claim was written to FAILED_KEY: their settle checks that record again. */
const persisted = new WeakSet<DraftOrigin>();
const isFailedDraft = (r: unknown): r is FailedDraft => {
  const x = r as Partial<FailedDraft> | null;
  return !!x && typeof x.sid === 'string' && typeof x.uuid === 'string' && typeof x.key === 'string'
    && typeof x.hash === 'string' && typeof x.stamp === 'number' && Number.isFinite(x.stamp);
};
function failedRecords(): FailedDraft[] {
  try {
    const v: unknown = JSON.parse(rawLocalStorage.get(FAILED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter(isFailedDraft) : [];
  } catch { return []; }
}
function dropFailed(drop: (r: FailedDraft) => boolean): void {
  const list = failedRecords();
  const next = list.filter((r) => !drop(r));
  if (next.length === list.length) return;
  try { if (next.length) rawLocalStorage.set(FAILED_KEY, JSON.stringify(next)); else rawLocalStorage.remove(FAILED_KEY); } catch { /* storage off */ }
}
const failedOf = (origin: DraftOrigin): FailedDraft | undefined => {
  const b = bound.get(origin);
  return b ? failedRecords().find((r) => r.sid === b.sid && r.uuid === b.uuid) : undefined;
};
/** The record still describes the stored words: same key, hash and META stamp. */
const recordHolds = (r: FailedDraft | undefined, key: string, stored: string | undefined): boolean =>
  !!r && r.key === key && !!stored?.trim() && draftHash(stored) === r.hash && readMeta()[key] === r.stamp;

/** The send of `origin` goes to `sid` as the user line `uuid` (useSessionSend). */
export function bindDraftOrigin(origin: DraftOrigin, sid: string, uuid: string): void {
  bound.set(origin, { sid, uuid });
}

/** A failed send's words become the key's revision, unless it was edited (or emptied) since the send: 0. */
export function claimFailedDraft(origin: DraftOrigin): number {
  if ((revisions.get(origin.key)?.mark ?? 0) > origin.sent) return 0;
  const stored = storedDraft(origin.key);
  if (stored !== undefined && stored.trim() && stored.trim() !== origin.text.trim()) return 0;
  if (stored !== undefined && !stored.trim()) writeDraft(origin.key, origin.text);
  const mark = ++saveSeq;
  revisions.set(origin.key, { mark, origin: origin.sent });
  // Unreadable storage: the box gets its words back, but nothing is kept across a reload.
  const b = bound.get(origin);
  if (b) boundBy.set(`${b.sid}\n${b.uuid}`, origin);
  const now = stored === undefined ? undefined : storedDraft(origin.key);
  const stamp = readMeta()[origin.key];
  if (b && now?.trim() && stamp !== undefined) {
    try {
      const list = failedRecords().filter((r) => !(r.sid === b.sid && r.uuid === b.uuid));
      rawLocalStorage.set(FAILED_KEY, JSON.stringify([...list, { sid: b.sid, uuid: b.uuid, key: origin.key, hash: draftHash(now), stamp }]));
      persisted.add(origin);
    } catch { /* storage off: memory ownership only */ }
  }
  return mark;
}

/** The refused send `uuid` of `sid` still owns its draft: the origin it has, or (after a reload) a new one. */
export function adoptFailedDraft(sid: string, uuid: string): DraftOrigin | undefined {
  const known = boundBy.get(`${sid}\n${uuid}`);
  if (known) return !persisted.has(known) || recordHolds(failedOf(known), known.key, storedDraft(known.key)) ? known : undefined;
  const r = failedRecords().find((x) => x.sid === sid && x.uuid === uuid);
  // Any revision here (typed, an external write) is newer than the record.
  if (!r || revisions.has(r.key)) return undefined;
  const stored = storedDraft(r.key);
  if (stored === undefined) return undefined;
  if (!recordHolds(r, r.key, stored)) {
    dropFailed((x) => x.sid === sid && x.uuid === uuid);
    return undefined;
  }
  const origin: DraftOrigin = { key: r.key, text: stored, sent: ++saveSeq };
  bindDraftOrigin(origin, sid, uuid);
  boundBy.set(`${sid}\n${uuid}`, origin);
  persisted.add(origin);
  revisions.set(r.key, { mark: ++saveSeq, origin: origin.sent });
  return origin;
}

/** Dismissed: the refused send gives up its ownership; the draft stays. */
export function forgetFailedDraft(origin: DraftOrigin): void {
  const b = bound.get(origin);
  if (!b) return;
  if (boundBy.get(`${b.sid}\n${b.uuid}`) === origin) boundBy.delete(`${b.sid}\n${b.uuid}`);
  dropFailed((r) => r.sid === b.sid && r.uuid === b.uuid);
}

/** History holds the user line of a refused send (the server took it after all): settled as a Retry. */
export function settleConfirmedDrafts(sid: string, rows: ReadonlyArray<RowWithSendUuids>): void {
  const mine = failedRecords().filter((r) => r.sid === sid);
  if (mine.length === 0) return;
  const ids = new Set<string>();
  for (const m of rows) for (const u of sendUuidsOfRow(m)) ids.add(u);
  for (const r of mine) {
    if (!ids.has(r.uuid)) continue;
    const origin = adoptFailedDraft(sid, r.uuid);
    if (origin) settleRetriedDraft(origin);
  }
}

const settledListeners = new Set<(origin: DraftOrigin) => void>();
export function onDraftSettled(cb: (origin: DraftOrigin) => void): () => void {
  settledListeners.add(cb);
  return () => { settledListeners.delete(cb); };
}

/** A Retry was accepted: the restored words go and count as sent, unless typed again since (the same words too). */
export function settleRetriedDraft(origin: DraftOrigin): boolean {
  const stored = storedDraft(origin.key);
  if (revisions.get(origin.key)?.origin !== origin.sent || stored === undefined || (stored.trim() && stored.trim() !== origin.text.trim())) return false;
  // Another tab's write of the same words may not have reached this one as an event yet.
  if (persisted.has(origin) && !recordHolds(failedOf(origin), origin.key, stored)) return false;
  revisions.delete(origin.key);
  unbindKey(origin.key);
  const b = bound.get(origin);
  dropFailed((r) => r.key === origin.key || (r.sid === b?.sid && r.uuid === b?.uuid));
  markDraftSent(origin.key, origin.text);
  for (const cb of [...settledListeners]) { try { cb(origin); } catch { /* one box never stops another */ } }
  writeDraft(origin.key, '');
  return true;
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
  // A clear (sent, or the box emptied) is one event, not a run of keystrokes: it goes
  // up at once, so a window closed right after it (no pagehide under automation, a
  // crash) leaves no stale words on the server for the next browser to bring back.
  schedule(value === null ? 0 : FLUSH_DEBOUNCE_MS);
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
    // Words this window sent are not a draft, however the copy is stamped:
    // this browser's value (or none, for one kept here only) goes back up over it.
    if (isSentDraftCopy(key, entry.v, undefined, entry.ts)) {
      const ts = Math.max(Date.now(), entry.ts + 1);
      const v = rawLocalStorage.get(key);
      meta[key] = ts;
      foldPending(pending, key, { v: v === null || v.length > MAX_SYNCED_DRAFT_LEN || hasCredential(v) ? null : v, ts });
      continue;
    }
    try {
      if (entry.v === null) rawLocalStorage.remove(key);
      else rawLocalStorage.set(key, entry.v);
      meta[key] = entry.ts;
      revisions.set(key, { mark: ++saveSeq });
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
  window.addEventListener('storage', (e) => {
    if (!e.key || !isDraftKey(e.key)) return;
    revisions.set(e.key, { mark: ++saveSeq });
    emit(e.key);
  });
}
