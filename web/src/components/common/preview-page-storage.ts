/**
 * Where the console keeps what a page in the Files preview keeps (src/web/preview-state-script.ts
 * sends it, src/lib/preview-state-envelope.ts says the parts):
 *  - what a browser keeps for a site goes to disk through PUT /api/preview-storage (the server
 *    puts it back into the page it serves), one write per file at most every WRITE_MS;
 *  - what a browser keeps for a tab (sessionStorage, session cookies) stays in this Walnut window's
 *    own sessionStorage, so a reload of Walnut keeps it and closing the window ends it, as closing
 *    a browser tab does. A new frame of the file is named with it (previewFrameName).
 * A page is named by its URL path, computed here from the file (pageDoc), never taken from the
 * page: a state that names another page is dropped.
 */
import { rawFileContentUrl } from '@/api/files';
import { log } from '@/utils/log';
import { PREVIEW_SESSION_MAX, PREVIEW_STATE_MAX, PREVIEW_STATE_PREFIX } from '../../../../src/lib/preview-state-envelope';

const WRITE_MS = 400;
/** A body a page-unload write may carry (browsers cap keepalive bodies near 64 KB). */
const KEEPALIVE_MAX = 60_000;
const SESSION_KEY = 'walnut-preview-session:';
/** All pages' tab copies together, in characters: well under a browser's 5M-character quota, so
 *  Walnut's own per-tab keys (the Passwords unlock among them) always have room. */
const SESSION_TOTAL_MAX = 2_000_000;

/** The URL path of the file's page, as the page's own `location.pathname` reads it. */
export function pageDoc(host: string | undefined, filePath: string): string {
  return new URL(rawFileContentUrl(filePath, host), window.location.href).pathname;
}

/** Written by the page for this page: JSON of envelope version 2 that starts by naming `doc`. */
function forDoc(text: string, doc: string, max: number): boolean {
  return text.length <= max && text.startsWith(`{"v":2,"p":${JSON.stringify(doc)},`) && text.endsWith('}');
}

const pending = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function write(doc: string, unloading = false): void {
  const text = pending.get(doc);
  const t = timers.get(doc);
  if (t) clearTimeout(t);
  timers.delete(doc);
  if (text === undefined) return;
  pending.delete(doc);
  void fetch(`/api/preview-storage?doc=${encodeURIComponent(doc)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: text,
    keepalive: unloading && text.length <= KEEPALIVE_MAX,
  }).then((res) => {
    if (!res.ok) log.warn('file-view', 'preview page state not kept', { doc, status: res.status, size: text.length });
  }).catch((err: unknown) => {
    log.warn('file-view', 'preview page state not kept', { doc, size: text.length, error: err instanceof Error ? err.message : String(err) });
  });
}

/** Every write still waiting, now (the frame went away, the window is leaving). */
export function flushPageStates(unloading = false): void {
  for (const doc of [...pending.keys()]) write(doc, unloading);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flushPageStates(true));
}

/** This window's tab copies, oldest written first (by the time each copy carries). */
function sessionEntries(): { key: string; size: number; t: number }[] {
  const out: { key: string; size: number; t: number }[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(SESSION_KEY)) continue;
      const text = sessionStorage.getItem(key) ?? '';
      const t = Number(/"t":(\d+)/.exec(text.slice(0, 300 + key.length * 2))?.[1] ?? 0);
      out.push({ key, size: text.length, t });
    }
  } catch { /* storage off */ }
  return out.sort((a, b) => a.t - b.t);
}

/** Room for `need` more characters: the oldest copies of other pages go first. */
function makeRoom(keep: string, need: number): void {
  const all = sessionEntries().filter((e) => e.key !== keep);
  let total = all.reduce((n, e) => n + e.size, 0) + need;
  for (const e of all) {
    if (total <= SESSION_TOTAL_MAX) break;
    try { sessionStorage.removeItem(e.key); } catch { /* storage off */ }
    total -= e.size;
  }
}

function keepSession(doc: string, text: string): void {
  const key = SESSION_KEY + doc;
  makeRoom(key, text.length);
  for (let tries = 0; tries < 2; tries++) {
    try {
      sessionStorage.setItem(key, text);
      return;
    } catch {
      // Full for another reason (Walnut's own keys): make room from every other page's copy, once.
      if (tries === 0) for (const e of sessionEntries()) if (e.key !== key) { try { sessionStorage.removeItem(e.key); } catch { /* off */ } }
    }
  }
  try { sessionStorage.removeItem(key); } catch { /* storage off */ }
  log.warn('file-view', 'preview page session state not kept: this window\'s storage is full or off', { doc, size: text.length });
}

/** A page's state as it sent it: each part kept where a browser keeps it. */
export function keepPageState(doc: string, persist: string, session: string): void {
  if (persist && forDoc(persist, doc, PREVIEW_STATE_MAX)) {
    pending.set(doc, persist);
    if (!timers.has(doc)) timers.set(doc, setTimeout(() => write(doc), WRITE_MS));
  }
  if (session && forDoc(session, doc, PREVIEW_SESSION_MAX)) keepSession(doc, session);
}

/** The name a new preview frame of this file is given: its page's tab-kept state, or nothing. */
export function previewFrameName(host: string | undefined, filePath: string): string | undefined {
  try {
    const text = sessionStorage.getItem(SESSION_KEY + pageDoc(host, filePath));
    return text ? PREVIEW_STATE_PREFIX + text : undefined;
  } catch {
    return undefined;
  }
}
