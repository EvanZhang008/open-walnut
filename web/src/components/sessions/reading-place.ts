/**
 * Where the reader is in each chat page, and the one way a pane goes back there
 * (2026-11-09, the user: "when click from main chat and then it jump to bottom
 * while open a another pannel", then "it shoudl alwys remmebret the location").
 *
 * A page (the main conversation, or one question) is drawn by whichever scroll
 * box shows it now: the panel's own timeline, a Tree Mode page beside it, the
 * sibling page, Conversation Mode's timeline for the main conversation. Moving a
 * page from one box to another (Main into the left page when a question opens,
 * back when it closes, a slide of the pages, a switch of view, a remount, a
 * reload) used to start the new box at the bottom, or at a raw scrollTop measured
 * in a box of another width. So the place is kept per PAGE, not per box, and by
 * content: the rows on screen with their height in the box, and whether the
 * reader was at the bottom. Any box showing the page puts the first of those
 * rows it draws back at the same height (the same share of the row when the box
 * is another width and the text rewraps).
 *
 * Kept in memory and in localStorage per session (the newest MAX_SESSIONS
 * sessions), so a reload and a restart of the Mac app, whose web view drops
 * sessionStorage, land there too. The pure part is here; the hook that records and restores
 * is useReadingPlace (same folder).
 */

/** The main conversation's page key (thread-tree's ROOT_THREAD_KEY). */
const ROOT = '';

export interface PlaceRow {
  id: string;
  /** The row's top relative to the box's top edge, px (negative: it starts above). */
  top: number;
  height: number;
}

export interface ReadingPlace {
  /** The rows on screen, top first (at most MAX_ROWS). */
  rows: PlaceRow[];
  /** The box's content width when it was read: another width rewraps the text. */
  width: number;
  /** Which box read it, and that box's top on screen then. Back in the SAME box,
   *  the rows keep their height on screen when the bar above the box changed
   *  (a path bar or sliver came or went, C4); another box keeps their height in it. */
  box?: string;
  boxTop?: number;
  /** The reader was at the end: the page goes back to its end, whatever came since. */
  atBottom: boolean;
  at: number;
}

const MAX_ROWS = 8;
/** As close to the end as "at the bottom" (the follow paths' own band is 80px). */
export const PLACE_BOTTOM_PX = 24;
const STORE_PREFIX = 'walnut:reading-place.v1:';
const MAX_PAGES_PER_SESSION = 40;
/** Sessions kept on this device, the oldest written dropped first. */
const MAX_SESSIONS = 30;
const INDEX_KEY = `${STORE_PREFIX}index`;

const places = new Map<string, Map<string, ReadingPlace>>();

function sessionPlaces(sessionId: string): Map<string, ReadingPlace> {
  let m = places.get(sessionId);
  if (m) return m;
  m = new Map();
  try {
    const raw = localStorage.getItem(STORE_PREFIX + sessionId);
    const obj = raw ? JSON.parse(raw) as Record<string, ReadingPlace> : null;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) if (v && Array.isArray(v.rows)) m.set(k, v);
    }
  } catch { /* nothing kept */ }
  places.set(sessionId, m);
  return m;
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
function persist(sessionId: string): void {
  clearTimeout(persistTimers.get(sessionId));
  persistTimers.set(sessionId, setTimeout(() => {
    persistTimers.delete(sessionId);
    const m = places.get(sessionId);
    if (!m) return;
    try {
      localStorage.setItem(STORE_PREFIX + sessionId, JSON.stringify(Object.fromEntries(m)));
      // Newest last; past MAX_SESSIONS the oldest session's places go.
      let ids: string[] = [];
      try { const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]'); if (Array.isArray(raw)) ids = raw.filter((x): x is string => typeof x === 'string'); } catch { /* start over */ }
      ids = [...ids.filter((x) => x !== sessionId), sessionId];
      while (ids.length > MAX_SESSIONS) {
        const old = ids.shift()!;
        localStorage.removeItem(STORE_PREFIX + old);
        places.delete(old);
      }
      localStorage.setItem(INDEX_KEY, JSON.stringify(ids));
    } catch { /* full or off */ }
  }, 400));
}

export function getPlace(sessionId: string, pageKey: string): ReadingPlace | undefined {
  return sessionPlaces(sessionId).get(pageKey);
}

export function setPlace(sessionId: string, pageKey: string, place: ReadingPlace): void {
  const m = sessionPlaces(sessionId);
  m.delete(pageKey);
  m.set(pageKey, place);
  while (m.size > MAX_PAGES_PER_SESSION) m.delete(m.keys().next().value as string);
  persist(sessionId);
}

/** The timeline's top-level rows (a merged run's members carry ids inside it). */
function topRows(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
    .filter((row) => !row.parentElement?.closest('[data-message-id]'));
}

/** Read where the reader is in `el`, or null when the box is not laid out. */
export function readPlace(el: HTMLElement, boxId?: string): ReadingPlace | null {
  if (!el.isConnected || el.clientHeight === 0) return null;
  const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
  const box = el.getBoundingClientRect();
  const rows: PlaceRow[] = [];
  for (const row of topRows(el)) {
    const r = row.getBoundingClientRect();
    if (!r.height || r.bottom <= box.top) continue;
    if (r.top >= box.bottom) break;
    rows.push({ id: row.dataset.messageId ?? '', top: Math.round(r.top - box.top), height: Math.round(r.height) });
    if (rows.length >= MAX_ROWS) break;
  }
  return {
    rows: rows.filter((x) => x.id), width: Math.round(el.clientWidth), atBottom: gap <= PLACE_BOTTOM_PX, at: Date.now(),
    ...(boxId ? { box: boxId, boxTop: Math.round(box.top) } : {}),
  };
}

/**
 * The row's wanted top in a box of `width` when it is now `height` tall: the
 * same px in the same width; in another width, a row that started above the
 * edge keeps the same share of itself above it (the text rewrapped), one below
 * keeps its px.
 */
export function wantedTop(row: PlaceRow, placeWidth: number, width: number, height: number): number {
  if (Math.abs(placeWidth - width) <= 2 || row.top >= 0 || row.height <= 0) return row.top;
  return Math.round((row.top / row.height) * height);
}

/**
 * Where `kept` belongs in `el` now: its height in the box, moved by how far the
 * box itself moved on screen when it is the box that read the place, as long as
 * that stays inside the box.
 */
function targetIn(el: HTMLElement, box: DOMRect, place: ReadingPlace, kept: PlaceRow, height: number, boxId?: string): number {
  const inBox = wantedTop(kept, place.width, Math.round(el.clientWidth), height);
  if (!boxId || place.box !== boxId || place.boxTop === undefined) return inBox;
  const onScreen = inBox + (place.boxTop - Math.round(box.top));
  return onScreen + height > 0 && onScreen < el.clientHeight ? onScreen : inBox;
}

export type ApplyResult = 'bottom' | 'restored' | 'missing';

/** Put `el` back at `place`: its end, or the first kept row it draws at its height. */
export function applyPlace(el: HTMLElement, place: ReadingPlace, boxId?: string): ApplyResult {
  if (place.atBottom) {
    el.scrollTop = el.scrollHeight;
    return 'bottom';
  }
  const box = el.getBoundingClientRect();
  for (const kept of place.rows) {
    const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(kept.id)}"]`);
    if (!row) continue;
    const r = row.getBoundingClientRect();
    if (!r.height) continue;
    const delta = (r.top - box.top) - targetIn(el, box, place, kept, r.height, boxId);
    if (Math.abs(delta) > 0.5) el.scrollTop += delta;
    return 'restored';
  }
  return 'missing';
}

/** How far `el` is off `place` now (px), for the hold; null when no kept row is drawn. */
export function placeDrift(el: HTMLElement, place: ReadingPlace, boxId?: string): number | null {
  if (place.atBottom) return el.scrollHeight - el.clientHeight - el.scrollTop;
  const box = el.getBoundingClientRect();
  for (const kept of place.rows) {
    const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(kept.id)}"]`);
    if (!row) continue;
    const r = row.getBoundingClientRect();
    if (!r.height) continue;
    return (r.top - box.top) - targetIn(el, box, place, kept, r.height, boxId);
  }
  return null;
}

/** The page key a timeline keeps its place under: Conversation Mode shows the
 *  main conversation, so it shares Main's place with Tree Mode's Main page. */
export function placeKeyOf(stackMode: boolean, currentKey: string): string {
  return stackMode ? currentKey : ROOT;
}

/** For tests: forget every place. */
export function clearPlacesForTest(): void {
  places.clear();
}
