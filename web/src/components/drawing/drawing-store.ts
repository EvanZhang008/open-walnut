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
 */
import { randomId } from '@/utils/random-id';
import type { DraftStore } from './drawing-sync';

export const DRAWING_STORE_PREFIX = 'walnut-drawing:';
const TAB_KEY = 'walnut-drawing-tab';

let cachedTab: string | null = null;

export function drawingTabId(): string {
  if (cachedTab) return cachedTab;
  let id = '';
  try { id = sessionStorage.getItem(TAB_KEY) ?? ''; } catch { /* storage off */ }
  if (!id) {
    id = randomId();
    try { sessionStorage.setItem(TAB_KEY, id); } catch { /* storage off: this page's life only */ }
  }
  cachedTab = id;
  return id;
}

/** Tests start a new tab. */
export function resetDrawingTabForTest(): void { cachedTab = null; }

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
};
