/**
 * The one open/close rule for every status fold the task panel draws: the status sections
 * (StatusSections.tsx), the same sections inside a project jump, and the By project design's
 * per-project Waiting / Completed folds (PanelDesignParts.tsx). 2026-11-04, the user: "only thing
 * need open constantly is watch and need me ... by default we open in the first time"; 2026-11-06:
 * "auto collapse in 60s if no action ... no action means people not actively scrolling, click".
 *
 * Two kinds of fold:
 *   sticky  Watching, Needs you: open on a first visit, then exactly what the user last chose.
 *   auto    Working, Waiting / snoozed, Completed, and every per-project fold: folded by default;
 *           opened, it folds again FOLD_AUTO_CLOSE_MS after the later of its opening and the user's
 *           last action in its panel; only a fold the user is typing in or has a menu open from waits.
 *
 * The store is one JSON object per localStorage key: a sticky fold holds the user's boolean (only
 * when it differs from the default), an open auto fold holds the time it was opened (epoch ms),
 * so the 15 minutes survive a reload, a restart and the ui-prefs sync to another device. Any
 * other value (a boolean an older build wrote for an auto fold, a corrupt entry) reads as folded
 * for an auto fold and as the default for a sticky one. useFoldStore.ts is the React half.
 * The time is FOLD_AUTO_CLOSE_MS (60 s since 2026-11-06). An action is a click, a scroll, a key or
 * a touch in the panel; the pointer resting on a fold, or its row being the task open, is none.
 */
import { STATUS_SECTION_ORDER, type StatusSectionKey } from './status-sections';

/** An opened auto fold folds again this long after it was opened or last acted in. */
export const FOLD_AUTO_CLOSE_MS = 60_000;
/** While the user is typing in a fold that is due, or has a menu open from it, look again this often. */
export const FOLD_BUSY_RETRY_MS = 1_000;

export type FoldKind = 'sticky' | 'auto';

/** Every status section's kind: the record type makes a new section name its rule. */
export const STATUS_SECTION_FOLD: Record<StatusSectionKey, FoldKind> = {
  watching: 'sticky',
  needs: 'sticky',
  working: 'auto',
  waiting: 'auto',
  notstarted: 'auto',
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

/** The user's last action in the panel a fold lives in (epoch ms, 0 when none is known). */
export type LastActionOf = (key: string) => number;
const noAction: LastActionOf = () => 0;

/** When an open auto fold folds again: FOLD_AUTO_CLOSE_MS after the later of its opening and the
 *  user's last action in its panel; null for a fold that is not open on a clock. */
export function autoCloseAt(store: FoldStore, key: string, kind: FoldKindOf, lastAction: LastActionOf = noAction): number | null {
  const v = store[key];
  return kind(key) === 'auto' && typeof v === 'number' ? Math.max(v, lastAction(key)) + FOLD_AUTO_CLOSE_MS : null;
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
export function foldIsDue(store: FoldStore, key: string, kind: FoldKindOf, now: number, lastAction: LastActionOf = noAction): boolean {
  const at = autoCloseAt(store, key, kind, lastAction);
  return at !== null && now >= at;
}

/**
 * The store with one fold set: an auto fold opened now starts its clock (again, when it was open
 * already: a locate that shows a row in it gives the row its full time); folded, it is dropped.
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
export function nextAutoClose(store: FoldStore, kind: FoldKindOf, lastAction: LastActionOf = noAction): number | null {
  let soonest: number | null = null;
  for (const k of Object.keys(store)) {
    const at = autoCloseAt(store, k, kind, lastAction);
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

/** The attribute a fold's element carries, so the clock finds it on the page. */
export const FOLD_KEY_ATTR = 'data-fold-key';
/** Marks the panel a fold lives in: a click, scroll, key or touch anywhere in it (its toolbar and
 *  search included) is an action that gives its folds their time again. Without one, the fold's
 *  scroller is it. */
export const FOLD_PANEL_ATTR = 'data-fold-panel';

/** Focus that means typing (an inline title edit), not the toggle a click left focused. */
const EDITING = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
/** A menu opened from a row of the fold: the menu itself is portalled out of it. */
const MENU_OPEN = '[data-menu-open], [aria-haspopup][aria-expanded="true"]';

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

/** The panel whose actions count for a fold element. */
export function foldPanelOf(el: Element): Element {
  return el.closest(`[${FOLD_PANEL_ATTR}]`) ?? scrollParentOf(el, false);
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
 * Would folding it now break something the user is doing in it: typing in a field inside it, or a
 * menu open from one of its rows. Nothing else holds a due fold: the pointer resting on it, the
 * task open among its rows or the user looking at it is no action (2026-11-06, the user: no action
 * means not scrolling or clicking in the side bar).
 */
export function foldBusy(doc: Document, key: string): boolean {
  const focused = doc.activeElement;
  const typing = !!focused && focused !== doc.body && focused.matches(EDITING);
  for (const el of doc.querySelectorAll(`[${FOLD_KEY_ATTR}]`)) {
    if (el.getAttribute(FOLD_KEY_ATTR) !== key) continue;
    if (typing && el.contains(focused)) return true;
    if (el.querySelector(MENU_OPEN)) return true;
  }
  return false;
}
