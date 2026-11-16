/**
 * Where a drawing's unsaved edits wait: this browser tab only.
 *
 * Not the shared draft store (utils/drafts.ts): its `draft:` keys reach the server and every other
 * tab and device, and a drawing's crash copy there was read by another tab as its own unsaved
 * edits (saved again, or cleared when that tab's copy was clean), and a composer's half-made file
 * made a second one elsewhere. The drawing itself lives in its file; this is only the part a
 * save has not taken yet, so it belongs to the tab that drew it.
 *
 * Keys: `walnut-drawing:<tab id>:<key>` in localStorage (survives a reload and a crash of the
 * tab), the tab id in sessionStorage (the same tab after a reload, a new one in a new tab). Not
 * under `open-walnut-`, so ui-prefs never mirrors it.
 *
 * A tab that is gone leaves its drafts to the next tab that opens the same file or sketch: the
 * Mac app's web view drops sessionStorage on every relaunch, so after a crash the relaunched page
 * is a new tab, and the edits it most needs would otherwise be out of reach. Each tab writes a
 * heartbeat (`walnut-drawing-alive:<tab id>`, every HEARTBEAT_MS, removed when the page goes);
 * drafts are taken over only from a tab whose heartbeat is missing or older than GONE_AFTER_MS,
 * never from a live one. That is longer than the 30 s a visible tab would need, because a browser
 * runs the timers of a tab in the background about once a minute: such a tab is alive.
 */
import { randomId } from '@/utils/random-id';
import type { DraftStore } from './drawing-sync';

export const DRAWING_STORE_PREFIX = 'walnut-drawing:';
export const DRAWING_ALIVE_PREFIX = 'walnut-drawing-alive:';
export const HEARTBEAT_MS = 10_000;
export const GONE_AFTER_MS = 75_000;
const TAB_KEY = 'walnut-drawing-tab';

let cachedTab: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function beat(id: string): void {
  try { localStorage.setItem(`${DRAWING_ALIVE_PREFIX}${id}`, String(Date.now())); } catch { /* storage off */ }
}

function startHeartbeat(id: string): void {
  beat(id);
  heartbeat = setInterval(() => beat(id), HEARTBEAT_MS);
  (heartbeat as { unref?: () => void }).unref?.();
  if (typeof window === 'undefined') return;
  // A closed tab's drafts are free at once; one restored from the back-forward cache is alive again.
  window.addEventListener('pagehide', () => { try { localStorage.removeItem(`${DRAWING_ALIVE_PREFIX}${id}`); } catch { /* storage off */ } });
  window.addEventListener('pageshow', () => beat(id));
}

export function drawingTabId(): string {
  if (cachedTab) return cachedTab;
  let id = '';
  try { id = sessionStorage.getItem(TAB_KEY) ?? ''; } catch { /* storage off */ }
  if (!id) {
    id = randomId();
    try { sessionStorage.setItem(TAB_KEY, id); } catch { /* storage off: this page's life only */ }
  }
  cachedTab = id;
  startHeartbeat(id);
  return id;
}

/** Tests start a new tab. */
export function resetDrawingTabForTest(): void {
  cachedTab = null;
  clearInterval(heartbeat);
  heartbeat = undefined;
}

function tabGone(tab: string, now: number): boolean {
  let raw: string | null = null;
  try { raw = localStorage.getItem(`${DRAWING_ALIVE_PREFIX}${tab}`); } catch { return false; }
  const at = raw === null ? NaN : Number(raw);
  return !Number.isFinite(at) || now - at > GONE_AFTER_MS;
}

/** Keys of the store that belong to `tab`. */
function keysOfTab(tab: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(`${DRAWING_STORE_PREFIX}${tab}:`)) out.push(k);
  }
  return out;
}

/**
 * Move the draft of `key` that a gone tab left behind into this tab's keys (the newest such tab's,
 * when several left one). Nothing happens while this tab has its own draft of `key`.
 */
function adoptFromGoneTab(key: string): void {
  try {
    const mine = drawingTabId();
    const own = `${DRAWING_STORE_PREFIX}${mine}:${key}`;
    if (localStorage.getItem(own)) return;
    const now = Date.now();
    let best: { full: string; tab: string; at: number } | null = null;
    for (let i = 0; i < localStorage.length; i++) {
      const full = localStorage.key(i);
      if (!full?.startsWith(DRAWING_STORE_PREFIX)) continue;
      const rest = full.slice(DRAWING_STORE_PREFIX.length);
      const colon = rest.indexOf(':');
      if (colon <= 0 || rest.slice(colon + 1) !== key) continue;
      const tab = rest.slice(0, colon);
      if (tab === mine || !tabGone(tab, now)) continue;
      const at = Number(localStorage.getItem(`${DRAWING_ALIVE_PREFIX}${tab}`)) || 0;
      if (!best || at > best.at) best = { full, tab, at };
    }
    if (!best) return;
    const text = localStorage.getItem(best.full);
    if (!text) return;
    localStorage.setItem(own, text);
    localStorage.removeItem(best.full);
    // A gone tab with nothing left needs no heartbeat record either.
    if (!keysOfTab(best.tab).length) localStorage.removeItem(`${DRAWING_ALIVE_PREFIX}${best.tab}`);
  } catch { /* quota or storage off: the drafts stay where they are */ }
}

export const tabDrawingStore: DraftStore = {
  read(key) {
    try { return localStorage.getItem(`${DRAWING_STORE_PREFIX}${drawingTabId()}:${key}`) ?? ''; } catch { return ''; }
  },
  write(key, text) {
    const full = `${DRAWING_STORE_PREFIX}${drawingTabId()}:${key}`;
    try {
      if (text) localStorage.setItem(full, text);
      else localStorage.removeItem(full);
    } catch { /* quota or storage off: DrawingSync reads it back and reports it as not kept */ }
  },
  adopt: adoptFromGoneTab,
};
