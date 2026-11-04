/**
 * The one open/close rule for every status fold the task panel draws: the status sections
 * (StatusSections.tsx) and the By project design's per-project Waiting / Completed folds
 * (PanelDesignParts.tsx). 2026-11-04, the user: "this should by default auto collapse, and then
 * if user open it after 15min, auto collapse; only thing need open constantly is watch and need
 * me, which we don't do any auto: by default we open in the first time, but follow user's state".
 *
 * Two kinds of fold:
 *   sticky  Watching, Needs you: open on a first visit, then exactly what the user last chose.
 *   auto    Working, Waiting / snoozed, Completed, and every per-project fold: folded by default;
 *           opened, it folds again FOLD_AUTO_CLOSE_MS after it was opened, but never under the
 *           user's hand (the pointer or the focus inside it): then it folds once they leave.
 *
 * The store is one JSON object per localStorage key: a sticky fold holds the user's boolean (only
 * when it differs from the default), an open auto fold holds the time it was opened (epoch ms),
 * so the 15 minutes survive a reload, a restart and the ui-prefs sync to another device. Any
 * other value (a boolean an older build wrote for an auto fold, a corrupt entry) reads as folded
 * for an auto fold and as the default for a sticky one. useFoldStore.ts is the React half.
 */
import { STATUS_SECTION_ORDER, type StatusSectionKey } from './status-sections';

/** An opened auto fold folds again this long after it was opened. */
export const FOLD_AUTO_CLOSE_MS = 15 * 60_000;
/** While the user is inside a fold that is due, look again this often. */
export const FOLD_BUSY_RETRY_MS = 1_000;

export type FoldKind = 'sticky' | 'auto';

/** Every status section's kind: the record type makes a new section name its rule. */
export const STATUS_SECTION_FOLD: Record<StatusSectionKey, FoldKind> = {
  watching: 'sticky',
  needs: 'sticky',
  working: 'auto',
  waiting: 'auto',
  done: 'auto',
};

/** A sticky fold's first-visit state; an auto fold always starts folded. */
export const STICKY_DEFAULT_OPEN = true;

/** One fold kind for a store: the status sections by their key, per-project folds all auto. */
export type FoldKindOf = (key: string) => FoldKind;
export const statusSectionFoldKind: FoldKindOf = (key) => STATUS_SECTION_FOLD[key as StatusSectionKey] ?? 'auto';
export const projectFoldKind: FoldKindOf = () => 'auto';

export type FoldStore = Readonly<Record<string, boolean | number>>;

/** The stored object; anything that is not one reads as empty (every fold at its default). */
export function parseFoldStore(raw: string | null): FoldStore {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean | number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
    return out;
  } catch { return {}; }
}

export function serializeFoldStore(store: FoldStore): string | null {
  return Object.keys(store).length ? JSON.stringify(store) : null;
}

/** When an open auto fold folds again; null for a fold that is not open on a clock. */
export function autoCloseAt(store: FoldStore, key: string, kind: FoldKindOf): number | null {
  const v = store[key];
  return kind(key) === 'auto' && typeof v === 'number' ? v + FOLD_AUTO_CLOSE_MS : null;
}

/**
 * Open as stored: an auto fold stays open past its time until it is folded (pruneFolds on a
 * load, the page's timer otherwise), so a render never folds it under the user's hand.
 */
export function foldIsOpen(store: FoldStore, key: string, kind: FoldKindOf): boolean {
  const v = store[key];
  if (kind(key) === 'sticky') return typeof v === 'boolean' ? v : STICKY_DEFAULT_OPEN;
  return typeof v === 'number';
}

/** An open auto fold whose time ran out. */
export function foldIsDue(store: FoldStore, key: string, kind: FoldKindOf, now: number): boolean {
  const at = autoCloseAt(store, key, kind);
  return at !== null && now >= at;
}

/**
 * The store with one fold set: an auto fold opened now starts its clock (again, when it was open
 * already: a locate that shows a row in it gives the row its 15 minutes); folded, it is dropped.
 */
export function setFold(store: FoldStore, key: string, open: boolean, kind: FoldKindOf, now: number): FoldStore {
  const next: Record<string, boolean | number> = { ...store };
  if (kind(key) === 'sticky') {
    if (open === STICKY_DEFAULT_OPEN) delete next[key]; else next[key] = open;
  } else if (open) {
    next[key] = now;
  } else {
    delete next[key];
  }
  return next;
}

/** The store without the auto folds already past their time, nor values a fold of that kind cannot hold: for a load, before anything is drawn. */
export function pruneFolds(store: FoldStore, kind: FoldKindOf, now: number): FoldStore {
  let changed = false;
  const next: Record<string, boolean | number> = {};
  for (const [k, v] of Object.entries(store)) {
    const keep = kind(k) === 'sticky' ? typeof v === 'boolean' : typeof v === 'number' && !foldIsDue(store, k, kind, now);
    // An opening time ahead of this clock (another device's clock ran ahead) counts from now.
    const value = keep && kind(k) === 'auto' && typeof v === 'number' && v > now ? now : v;
    if (keep) next[k] = value;
    if (!keep || value !== v) changed = true;
  }
  return changed ? next : store;
}

/**
 * One page's change laid over what storage holds now: only the folds this page changed, so a
 * write never puts back another tab's (or, through the ui-prefs sync, another device's) older
 * value of a fold this page did not touch. `undefined` drops the fold.
 */
export function mergeFoldChanges(stored: FoldStore, changes: Readonly<Record<string, boolean | number | undefined>>): FoldStore {
  const next: Record<string, boolean | number> = { ...stored };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete next[k]; else next[k] = v;
  }
  return next;
}

/** The soonest time an open auto fold is due, or null when none is open on a clock. */
export function nextAutoClose(store: FoldStore, kind: FoldKindOf): number | null {
  let soonest: number | null = null;
  for (const k of Object.keys(store)) {
    const at = autoCloseAt(store, k, kind);
    if (at !== null && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/** Every status section's open state from a store. */
export function statusSectionsOpen(store: FoldStore): Record<StatusSectionKey, boolean> {
  return Object.fromEntries(
    STATUS_SECTION_ORDER.map((k) => [k, foldIsOpen(store, k, statusSectionFoldKind)]),
  ) as Record<StatusSectionKey, boolean>;
}

/** The attribute a fold's element carries, so a due fold can tell the user is inside it. */
export const FOLD_KEY_ATTR = 'data-fold-key';
/** Marks the panel a fold lives in: the user moving, scrolling or typing anywhere in it (its
 *  toolbar and search included) is reading its folds. Without one, the fold's scroller is it. */
export const FOLD_PANEL_ATTR = 'data-fold-panel';

/** Focus that means typing (an inline title edit), not the toggle a click left focused. */
const EDITING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** A menu opened from a row of the fold: the menu itself is portalled out of it. */
const MENU_OPEN = '[data-menu-open], [aria-haspopup][aria-expanded="true"]';
/** The task the user has open (its row highlighted): a fold holding it keeps it in sight. */
const OPEN_TASK_ROW = '.todo-pinned-card-active, .task-focused';
/** The user moved, scrolled or typed this recently: a fold on screen is still being read. */
export const FOLD_READING_MS = 30_000;

/** The panel a fold scrolls in: its nearest scrolling ancestor (the page when none). With
 *  `overflowing` false, a scroll container counts even while its list is short and does not
 *  scroll: a short list's panel is still that panel, never the whole page. */
export function scrollParentOf(el: Element, overflowing = true): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && (!overflowing || p.scrollHeight > p.clientHeight)) return p;
  }
  return el.ownerDocument.scrollingElement ?? el.ownerDocument.documentElement;
}

function keyboardFocus(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return false; }
}

/** Less of a group than this in view is its edge (padding, a border), not something to read. */
const IN_VIEW_MIN_PX = 8;
/** Is some of it in the part of its panel the user sees: the window clipped to the scroller it
 *  scrolls in, so a group scrolled up under the panel's toolbar is not on screen. */
export function inPanelView(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  const vh = win?.innerHeight ?? 0, vw = win?.innerWidth ?? 0;
  const r = el.getBoundingClientRect();
  const s = scrollParentOf(el, false).getBoundingClientRect();
  const top = Math.max(0, s.top), bottom = s.bottom > s.top ? Math.min(vh, s.bottom) : vh;
  const shown = Math.min(r.bottom, bottom) - Math.max(r.top, top);
  return r.height > 0 && shown >= Math.min(IN_VIEW_MIN_PX, r.height) && r.right > 0 && r.left < vw;
}

/**
 * Is the user inside this fold: the pointer over it, typing in it, a menu open from one of its
 * rows, one of its rows the task they have open, or the fold on screen while the user is reading around it (`reading(el)`: their last move,
 * scroll or key, within FOLD_READING_MS, was in the panel that holds it). A fold that is not on the
 * page is not busy, nor one on screen while the user works elsewhere or is away.
 */
export function foldBusy(
  doc: Document,
  key: string,
  reading: (el: Element) => boolean = () => false,
  navigated: (focused: Element) => boolean = () => false,
): boolean {
  const focused = doc.activeElement;
  // Typing, or a keyboard user's focus on one of its rows (folding would drop that focus); a
  // focus a click left, or one on the fold's own toggle (it stays), does not hold it.
  const typing = !!focused && focused !== doc.body && focused.matches(EDITING);
  const keyFocus = !!focused && focused !== doc.body && !typing
    && keyboardFocus(focused) && !focused.hasAttribute('aria-expanded');
  for (const el of doc.querySelectorAll(`[${FOLD_KEY_ATTR}]`)) {
    if (el.getAttribute(FOLD_KEY_ATTR) !== key) continue;
    if (el.matches(':hover')) return true;
    if (typing && el.contains(focused)) return true;
    // A focus the user moved there with Tab or an arrow key holds it until they move on; one a
    // closing menu put back (Escape) holds it only while they keep working in the panel.
    if (keyFocus && el.contains(focused) && (navigated(focused!) || reading(el))) return true;
    if (el.querySelector(MENU_OPEN) || el.querySelector(OPEN_TASK_ROW)) return true;
    if (inPanelView(el) && reading(el)) return true;
  }
  return false;
}
