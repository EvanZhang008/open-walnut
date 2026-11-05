/**
 * The React half of section-fold-rule.ts: one localStorage-backed fold store, its auto folds
 * folded again on their clock. Every status fold the task panel draws reads its open state here
 * (tests/web/section-fold-rule-guard.test.ts holds every drawer to it).
 *
 * The clock is the stored opening time, never an in-memory timer alone: a reload, a restart or
 * another device reading the synced value folds a fold whose 15 minutes ran out while it was
 * away. A timer only wakes the page at the next due time; a due fold the user is inside
 * (foldBusy) is looked at again every FOLD_BUSY_RETRY_MS until they leave it.
 *
 * Each tab shows its own state (another tab's choice shows at its next mount, as every kept view
 * does), and every write lays only this tab's changed folds over what storage holds now
 * (mergeFoldChanges), so a fold this tab folds by its clock never undoes another tab's choice.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FOLD_PIN_EVENT, FOLD_SETTLE_EVENT, type FoldPinDetail } from '@/hooks/useFoldAnchor';
import {
  FOLD_BUSY_RETRY_MS,
  FOLD_KEY_ATTR,
  FOLD_PANEL_ATTR,
  FOLD_READING_MS,
  type FoldKindOf,
  type FoldStore,
  foldBusy,
  foldIsDue,
  foldIsOpen,
  inPanelView,
  mergeFoldChanges,
  nextAutoClose,
  parseFoldStore,
  pruneFolds,
  scrollParentOf,
  serializeFoldStore,
  setFold,
} from './section-fold-rule';

export interface FoldStoreApi {
  /** The store as it stands: read open states through `isOpen`. */
  store: FoldStore;
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
  toggle: (key: string) => void;
}

function readStored(lsKey: string): FoldStore {
  try { return parseFoldStore(localStorage.getItem(lsKey)); } catch { return {}; }
}

function persist(lsKey: string, store: FoldStore): void {
  try {
    const raw = serializeFoldStore(store);
    if (raw) localStorage.setItem(lsKey, raw); else localStorage.removeItem(lsKey);
  } catch { /* quota or storage off: the fold still flips for this page */ }
}

/** The user's last move, scroll or key anywhere on the page: where, and when. */
const lastActivity: { at: number; target: EventTarget | null } = { at: 0, target: null };
let activityListening = false;
function listenForActivity(): void {
  if (activityListening || typeof document === 'undefined') return;
  activityListening = true;
  const note = (e: Event) => { lastActivity.at = Date.now(); lastActivity.target = e.target; };
  // WebKit sends a pointer that never moved a mousemove of its own whenever the layout under it
  // changes (a row updating, a scroll), so a move counts only when the pointer really moved.
  let px = NaN, py = NaN;
  const noteMove = (e: Event) => {
    const { clientX, clientY } = e as PointerEvent;
    if (clientX === px && clientY === py) return;
    px = clientX; py = clientY;
    note(e);
  };
  document.addEventListener('pointermove', noteMove, { capture: true, passive: true });
  // The user's own input only: a scroll event also comes from a focus or a fold anchor moving the
  // panel, and the user's scrolling arrives as wheel, touch, keys or a scrollbar press anyway.
  for (const type of ['pointerdown', 'wheel', 'keydown', 'touchmove'] as const) {
    document.addEventListener(type, note, { capture: true, passive: true });
  }
  // Which focus the user moved with the keyboard: a focus that lands right after Tab or an arrow
  // key. One a closing menu puts back after Escape, or a click leaves, is not.
  let navKeyAt = -Infinity;
  document.addEventListener('keydown', (e) => { navKeyAt = NAV_KEYS.has(e.key) ? Date.now() : -Infinity; }, { capture: true });
  document.addEventListener('pointerdown', () => { navKeyAt = -Infinity; navFocus = null; }, { capture: true });
  document.addEventListener('focusin', (e) => {
    navFocus = Date.now() - navKeyAt < NAV_FOCUS_MS && e.target instanceof Element ? e.target : null;
  }, { capture: true });
}
const NAV_KEYS = new Set(['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const NAV_FOCUS_MS = 1_000;
let navFocus: Element | null = null;
const navigatedTo = (focused: Element) => focused === navFocus;
/** Was the user's last activity, within FOLD_READING_MS, in the panel this fold lives in? */
function readingAround(el: Element): boolean {
  return Date.now() - lastActivity.at < FOLD_READING_MS && lastInputIn(el);
}
/** Was the user's last input in the panel this fold lives in? */
function lastInputIn(el: Element): boolean {
  const target = lastActivity.target;
  if (!(target instanceof Node)) return false;
  const panel = el.closest(`[${FOLD_PANEL_ATTR}]`) ?? scrollParentOf(el, false);
  return panel.contains(target) || target === el.ownerDocument;
}

function foldElements(key: string): Element[] {
  return [...document.querySelectorAll(`[${FOLD_KEY_ATTR}]`)].filter((e) => e.getAttribute(FOLD_KEY_ATTR) === key);
}
/** The fold's own toggle: the element carrying its key and aria-expanded, or the one inside. */
function toggleOf(key: string): HTMLElement | null {
  const els = foldElements(key);
  const toggle = els.find((e) => e.hasAttribute('aria-expanded')) ?? els.map((e) => e.querySelector('[aria-expanded]')).find(Boolean);
  return toggle instanceof HTMLElement ? toggle : null;
}
/** Before the clock folds a fold: the panel's fold anchor holds its heading where it shows (the
 *  same hold a click gets, useFoldAnchor), and whether the focus sits in it. */
function beforeClockFold(key: string): 'visible' | 'plain' | null {
  const toggle = toggleOf(key);
  const under = rowUnderPointerBelow(key, toggle);
  // A pointer resting on a row below the fold keeps that row under it (the rows would otherwise
  // slide up and put another task under the pointer); else the fold's heading keeps its place.
  (under ?? toggle)?.dispatchEvent(new CustomEvent<FoldPinDetail>(FOLD_PIN_EVENT, { bubbles: true, detail: { inView: !under } }));
  const focused = document.activeElement;
  if (!focused || focused === document.body || !foldElements(key).some((e) => e.contains(focused))) return null;
  try { return focused.matches(':focus-visible') ? 'visible' : 'plain'; } catch { return 'plain'; }
}
/** No input anywhere for this long: the user is away, and a due fold folds. */
const AWAY_MS = 5 * 60_000;
/** The window in front, the fold on screen and the user still for a while since their last input
 *  in its panel (past FOLD_READING_MS, short of AWAY_MS): they may be reading it, so it waits.
 *  Input elsewhere, the window going to the background or AWAY_MS of stillness lets it fold. */
function maybeReading(key: string): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  const still = Date.now() - lastActivity.at;
  if (still < FOLD_READING_MS || still >= AWAY_MS) return false;
  return foldElements(key).some((f) => inPanelView(f) && lastInputIn(f));
}
/** The pointer rests on the list below a fold that is on screen: folding it would slide the rows
 *  under the pointer, so it waits for the pointer to go. One scrolled above the panel folds, and
 *  the row under the pointer keeps its place (beforeClockFold). */
function restingBelow(key: string): boolean {
  return !!rowUnderPointerBelow(key, toggleOf(key)) && foldElements(key).some(inPanelView);
}
/** The row the pointer rests on, when it sits after the fold in the same panel. */
function rowUnderPointerBelow(key: string, toggle: HTMLElement | null): Element | null {
  const hovered = [...document.querySelectorAll(':hover')].pop();
  const row = hovered?.closest('[data-task-id], .navigation-heading, .project-status-fold-row, .tier-project-label, .task-group-chip');
  const folds = foldElements(key);
  if (!row || !toggle || !folds.length || folds.some((f) => f.contains(row))) return null;
  const panel = `[${FOLD_PANEL_ATTR}]`;
  if (row.closest(panel) !== toggle.closest(panel)) return null;
  return folds[0].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING ? row : null;
}
/** A clock fold took the focused row away: the focus goes to the fold's own toggle, never body. */
function keepFocus(key: string, visible: boolean): void {
  if (document.activeElement && document.activeElement !== document.body) return;
  // A keyboard user's focus ring follows the focus onto the heading.
  toggleOf(key)?.focus({ preventScroll: true, focusVisible: visible } as FocusOptions);
}

/** Folds due this close to the one due now fold with it. */
const FOLD_BATCH_MS = 2_000;
/** A clock that ran early, or a machine clock set back, looks again this soon. */
const EARLY_RETRY_MS = 1_000;
/** An open auto fold asked open again restarts its clock only this long after its last start. */
const RESTART_MIN_MS = 60_000;

export function useFoldStore(lsKey: string, kind: FoldKindOf, now: () => number = Date.now): FoldStoreApi {
  const [store, setStore] = useState<FoldStore>(() => {
    const parsed = readStored(lsKey);
    const pruned = pruneFolds(parsed, kind, now());
    if (pruned !== parsed) persist(lsKey, pruned);
    return pruned;
  });
  const storeRef = useRef(store);
  storeRef.current = store;

  /** This tab's new store; storage gets only the folds that changed, over what it holds now. */
  const write = useCallback((next: FoldStore) => {
    const prev = storeRef.current;
    if (next === prev) return;
    const changes: Record<string, boolean | number | undefined> = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (prev[k] !== next[k]) changes[k] = next[k];
    }
    storeRef.current = next;
    persist(lsKey, mergeFoldChanges(readStored(lsKey), changes));
    setStore(next);
  }, [lsKey]);

  const setOpen = useCallback((key: string, open: boolean) => {
    const cur = storeRef.current;
    // Opening an auto fold that is open already restarts its clock (a locate showing a row in
    // it), at most once a minute: a held locate asks again on every render.
    if (foldIsOpen(cur, key, kind) === open) {
      const at = cur[key];
      if (!(open && kind(key) === 'auto' && typeof at === 'number' && now() - at >= RESTART_MIN_MS)) return;
    }
    write(setFold(cur, key, open, kind, now()));
  }, [kind, now, write]);

  const toggle = useCallback((key: string) => {
    setOpen(key, !foldIsOpen(storeRef.current, key, kind));
  }, [kind, setOpen]);

  // Fold what is due, except under the user's hand; then wake at the next due time. A folded
  // group's heading keeps its place on screen (useFoldAnchor), and a focus in it moves to its toggle.
  useEffect(listenForActivity, []);
  const focusedRef = useRef<Array<{ key: string; visible: boolean }>>([]);
  const clockFoldedRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    for (const key of clockFoldedRef.current.splice(0)) toggleOf(key)?.dispatchEvent(new CustomEvent(FOLD_SETTLE_EVENT, { bubbles: true }));
    for (const f of focusedRef.current.splice(0)) keepFocus(f.key, f.visible);
  }, [store]);
  const [wake, setWake] = useState(0);
  const retryRef = useRef<number | null>(null);
  /** Folds what is due and free; true while a due fold is held because the user is in it. */
  const foldDue = useCallback((): boolean => {
    const t = now();
    const cur = storeRef.current;
    let next = cur;
    let busy = false;
    for (const key of Object.keys(cur)) {
      // Folds due within a moment of each other go together, never one after the other.
      if (!foldIsDue(cur, key, kind, t + FOLD_BATCH_MS)) continue;
      if (foldBusy(document, key, readingAround, navigatedTo) || restingBelow(key) || maybeReading(key)) { busy = true; continue; }
      const focus = beforeClockFold(key);
      if (focus) focusedRef.current.push({ key, visible: focus === 'visible' });
      clockFoldedRef.current.push(key);
      next = setFold(next, key, false, kind, t);
    }
    write(next);
    return busy;
  }, [kind, now, write]);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const at = nextAutoClose(store, kind);
    if (at === null) { setHeld(false); return; }
    const retry = (ms: number) => {
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      retryRef.current = window.setTimeout(() => {
        retryRef.current = null;
        if (foldDue()) retry(FOLD_BUSY_RETRY_MS); else setHeld(false);
      }, ms);
    };
    const timer = window.setTimeout(() => {
      const cur = storeRef.current;
      const busy = foldDue();
      setHeld(busy);
      if (busy) retry(FOLD_BUSY_RETRY_MS);
      else if (storeRef.current === cur) {
        // Nothing was due after all (the timer ran early, the clock was set back): look again.
        const again = nextAutoClose(cur, kind);
        if (again !== null) retry(Math.max(EARLY_RETRY_MS, Math.min(again - now(), 2 ** 31 - 1)));
      }
    }, Math.min(Math.max(0, at - now()), 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [store, kind, now, foldDue, wake]);
  // While a due fold waits on the user, the moment they leave it (the pointer goes, a press or a
  // focus lands elsewhere) it folds then, not at the next look a second later.
  useEffect(() => {
    if (!held) return;
    let queued = false;
    const look = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; if (!foldDue()) setHeld(false); });
    };
    const types = ['pointermove', 'pointerdown', 'focusin', 'focusout', 'keyup', 'visibilitychange'] as const;
    for (const type of types) document.addEventListener(type, look, { capture: true, passive: true });
    window.addEventListener('blur', look);
    return () => {
      for (const type of types) document.removeEventListener(type, look, { capture: true });
      window.removeEventListener('blur', look);
    };
  }, [held, foldDue]);
  useEffect(() => () => { if (retryRef.current !== null) window.clearTimeout(retryRef.current); }, []);

  // A tab coming back after its timers were held (sleep, a hidden tab) checks at once.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setWake((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const isOpen = useCallback((key: string) => foldIsOpen(store, key, kind), [store, kind]);
  return { store, isOpen, setOpen, toggle };
}
