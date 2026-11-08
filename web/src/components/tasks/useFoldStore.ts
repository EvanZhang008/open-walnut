/**
 * The React half of section-fold-rule.ts: one localStorage-backed fold store, its auto folds
 * folded again on their clock. Every status fold the task panel draws reads its open state here
 * (tests/web/section-fold-rule-guard.test.ts holds every drawer to it).
 *
 * The clock runs from the stored opening time and the user's last action in the fold's panel (a
 * click, a scroll, a key or a touch there, kept here in memory and written into the opening time
 * when the page goes away): a reload, a restart or another device reading the synced value folds
 * a fold whose time ran out while it was away, and gives one still in time its full time from the
 * load, so a fold that shows open at a load never folds a few seconds later. A timer
 * only wakes the page at the next due time; a due fold the user is typing in, or has a menu open
 * from (foldBusy), is looked at again every FOLD_BUSY_RETRY_MS until they are done.
 *
 * Each tab shows its own state (another tab's choice shows at its next mount, as every kept view
 * does), and every write lays only this tab's changed folds over what storage holds now
 * (mergeFoldChanges), so a fold this tab folds by its clock never undoes another tab's choice.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FOLD_PIN_EVENT, FOLD_SETTLE_EVENT, type FoldPinDetail } from '@/hooks/useFoldAnchor';
import { decodeField, LAYOUT_FIELDS } from '@/utils/layout-record';
import {
  clockFoldChanges,
  FOLD_BUSY_RETRY_MS,
  FOLD_KEY_ATTR,
  FOLD_PANEL_ATTR,
  type FoldKindOf,
  type FoldStore,
  foldBusy,
  foldIsDue,
  foldIsOpen,
  inPanelView,
  initialFoldStore,
  keepLastActions,
  mergeFoldChanges,
  nextAutoClose,
  parseFoldStore,
  pruneFolds,
  restartShownFolds,
  serializeFoldStore,
  setFold,
} from './section-fold-rule';
import { foldPanelOf, type LastActionOf } from './section-fold-rule';

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

/** The user's last action (a click, a scroll, a key, a touch) in each fold panel. */
const lastAction = new WeakMap<Element, number>();
let actionListening = false;
function listenForActions(): void {
  if (actionListening || typeof document === 'undefined') return;
  actionListening = true;
  // A key pressed with the focus on the page itself (PageDown, Space or an arrow after a click
  // that left no focus) scrolls the panel the user last pressed in.
  let pressedIn: Element | null = null;
  const note = (e: Event) => {
    const t = e.target;
    let panel = t instanceof Element ? t.closest(`[${FOLD_PANEL_ATTR}]`) : null;
    if (e.type === 'pointerdown') pressedIn = panel;
    else if (!panel && e.type === 'keydown' && (t === document.body || t === document.documentElement)) panel = pressedIn;
    if (panel) lastAction.set(panel, Date.now());
  };
  // The user's own input only. A pointer that only moves or rests is no action, and a scroll
  // event also comes from a focus or a fold anchor moving the panel, while the user's scrolling
  // arrives as wheel, touch, keys or a scrollbar press anyway.
  for (const type of ['pointerdown', 'wheel', 'keydown', 'touchmove'] as const) {
    document.addEventListener(type, note, { capture: true, passive: true });
  }
}
function foldElements(key: string): Element[] {
  return [...document.querySelectorAll(`[${FOLD_KEY_ATTR}]`)].filter((e) => e.getAttribute(FOLD_KEY_ATTR) === key);
}
/** The user's last action in the panel a fold is drawn in; 0 for a fold not on the page. */
const lastActionOf: LastActionOf = (key) => {
  let at = 0;
  for (const el of foldElements(key)) at = Math.max(at, lastAction.get(foldPanelOf(el)) ?? 0);
  return at;
};
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

/** A fold held by the user's typing or open menu has its 60 s again from the moment it is let
 *  go: the panel's last action moves up while it waits (the menu's own click is portalled out of
 *  the panel, so it never counts there). */
function held(key: string, t: number): void {
  for (const el of foldElements(key)) lastAction.set(foldPanelOf(el), t);
}

/** `drawn` false: the store's folds are not on screen now (a project jump draws its own), so
 *  its clock folds them without touching the page, whose folds of the same keys are another
 *  store's. */
export function useFoldStore(lsKey: string, kind: FoldKindOf, now: () => number = Date.now, drawn = true): FoldStoreApi {
  const drawnRef = useRef(drawn);
  drawnRef.current = drawn;
  const [store, setStore] = useState<FoldStore>(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(lsKey); } catch { /* storage off */ }
    let existing = false;
    try { existing = Object.values(LAYOUT_FIELDS).some(key => decodeField(localStorage.getItem(key)) !== undefined); } catch { /* storage off */ }
    const parsed = initialFoldStore(raw, kind, existing);
    const t = now();
    const pruned = restartShownFolds(pruneFolds(parsed, kind, t), kind, t);
    if (serializeFoldStore(pruned) !== raw) persist(lsKey, pruned);
    return pruned;
  });
  const storeRef = useRef(store);
  storeRef.current = store;

  /** This tab's new store; storage gets only the folds that changed, over what it holds now. A
   *  clock fold (`clock`) leaves out a fold another tab opened again since (clockFoldChanges). */
  const write = useCallback((next: FoldStore, clock = false) => {
    const prev = storeRef.current;
    if (next === prev) return;
    const changes: Record<string, boolean | number | undefined> = {};
    for (const k of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (prev[k] !== next[k]) changes[k] = next[k];
    }
    storeRef.current = next;
    const stored = readStored(lsKey);
    persist(lsKey, mergeFoldChanges(stored, clock ? clockFoldChanges(stored, prev, changes) : changes));
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

  // Fold what is due, except one the user is typing in or has a menu open from; then wake at the
  // next due time. A folded group's heading keeps its place on screen (useFoldAnchor), and a
  // focus in it moves to its toggle.
  useEffect(listenForActions, []);
  const focusedRef = useRef<Array<{ key: string; visible: boolean }>>([]);
  const clockFoldedRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    for (const key of clockFoldedRef.current.splice(0)) toggleOf(key)?.dispatchEvent(new CustomEvent(FOLD_SETTLE_EVENT, { bubbles: true }));
    for (const f of focusedRef.current.splice(0)) keepFocus(f.key, f.visible);
  }, [store]);
  const [wake, setWake] = useState(0);
  /** Folds what is due and free; true while a due fold waits on the user's typing or open menu. */
  const foldDue = useCallback((): boolean => {
    const t = now();
    const cur = storeRef.current;
    let next = cur;
    let busy = false;
    for (const key of Object.keys(cur)) {
      // Folds due within a moment of each other go together, never one after the other.
      if (!foldIsDue(cur, key, kind, t + FOLD_BATCH_MS, lastActionOf)) continue;
      if (drawnRef.current && foldBusy(document, key)) { busy = true; held(key, t); continue; }
      if (!drawnRef.current) { next = setFold(next, key, false, kind, t); continue; }
      const focus = beforeClockFold(key);
      if (focus) focusedRef.current.push({ key, visible: focus === 'visible' });
      clockFoldedRef.current.push(key);
      next = setFold(next, key, false, kind, t);
    }
    write(next, true);
    return busy;
  }, [kind, now, write]);
  useEffect(() => {
    let timer: number | null = null;
    const arm = (ms: number) => { timer = window.setTimeout(look, Math.min(Math.max(0, ms), 2 ** 31 - 1)); };
    // Each look folds what is due; with nothing folded (the user acted in the panel meanwhile,
    // the timer ran early, the clock was set back) it waits for the next due time from now.
    function look() {
      timer = null;
      const cur = storeRef.current;
      if (foldDue()) { arm(FOLD_BUSY_RETRY_MS); return; }
      if (storeRef.current !== cur) return; // a fold folded: the new store arms its own wait
      const at = nextAutoClose(cur, kind, lastActionOf);
      if (at !== null) arm(Math.max(EARLY_RETRY_MS, at - now()));
    }
    const at = nextAutoClose(store, kind, lastActionOf);
    if (at !== null) arm(at - now());
    return () => { if (timer !== null) window.clearTimeout(timer); };
  }, [store, kind, now, foldDue, wake]);

  // A tab coming back after its timers were held (sleep, a hidden tab) checks at once.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setWake((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // The last action lives in memory: before the page goes away it is written into each open
  // fold's opening time, so the next load counts from it (keepLastActions). It refreshes what
  // storage holds now and goes around `write`, which would lay this tab's copy over another
  // tab's close; this tab's own state is left as it is (its clock reads the last action anyway).
  useEffect(() => {
    const keep = () => {
      if (!drawnRef.current) return;
      const stored = readStored(lsKey);
      const next = keepLastActions(stored, storeRef.current, kind, lastActionOf);
      if (next !== stored) persist(lsKey, next);
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') keep(); };
    window.addEventListener('pagehide', keep);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', keep);
      document.removeEventListener('visibilitychange', onHidden);
    };
  }, [kind, lsKey]);

  const isOpen = useCallback((key: string) => foldIsOpen(store, key, kind), [store, kind]);
  return { store, isOpen, setOpen, toggle };
}
