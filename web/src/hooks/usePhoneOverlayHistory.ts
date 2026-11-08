/**
 * Phone back gesture = close the layer that was opened last (spec 4.3).
 *
 * Phone layout only. Every full-screen layer (drawer, session overlay, chat, a
 * task detail, one note, one Settings pane, a sheet...) registers itself with
 * `usePhoneOverlay`. Opening one pushes ONE history entry with the same URL and
 * a `walnutOverlay: { id, kind, depth }` marker on top of react-router's own
 * state (`usr` / `key` / `idx` are kept, so route navigation keeps working).
 * A popstate to an entry of depth d closes every layer above d, top first, with
 * `onClose({ fromHistory: true })`, so the owner never calls `history.back()`
 * again. A UI close (Back arrow, x, backdrop, Escape) goes through `close()`:
 * when the current entry is this layer it calls `history.back()` and lets the
 * popstate do the closing, so the history stack and the screen always match
 * and there is no "empty back".
 *
 * Desktop never touches history: `close()` calls `onClose` directly.
 *
 * Id convention (one layer per id at a time):
 *   drawer, chat, asks, notifications, search, calendar-tasks,
 *   session:<sid>, draft:<id>, task-detail:<taskId>, note:<path>,
 *   settings-pane:<paneId>, board:<taskId>, file:<path>, plan:<id>, sheet:<name>
 *
 * Three traps this file encodes:
 * - `history.back()` is asynchronous. A push issued before its popstate lands
 *   would be made on the entry that is about to be left, and the popstate
 *   would then close the new layer. Pushes wait for pending backs.
 * - React StrictMode (dev, so every Playwright fixture) unmounts and remounts
 *   each effect synchronously. A release is settled in a microtask, so a
 *   remount with the same id reclaims its history entry instead of popping it.
 *   Every release of a tick is settled together in ONE unwind, and a push made
 *   while one is unsettled waits for it (a replaced column, `settleReleases`).
 * - Leaving phone layout (rotate, resize) removes every layer's entry with
 *   `history.go(-depth)`, so no empty back survives a breakpoint. Menus and
 *   sheets close; a `keepOnBreakpoint` layer (session, viewer, board, file,
 *   draft, chat) keeps its owner's state, which desktop then shows.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { PHONE_LAYOUT_QUERY, isPhoneLayout, usePhoneLayout } from './usePhoneLayout';
import { log } from '@/utils/log';

export type PhoneOverlayKind =
  | 'drawer' | 'session' | 'chat' | 'draft' | 'asks' | 'task-detail' | 'note'
  | 'settings-pane' | 'calendar-tasks' | 'notifications' | 'search' | 'board'
  | 'file' | 'plan' | 'viewer' | 'sheet';

/** What the phone top bar shows while this layer is the top one with a bar. */
/** Why a layer closed: `fromHistory` (a back, or the breakpoint), `breakpoint` (the window stopped being a phone). */
export interface PhoneOverlayCloseInfo {
  fromHistory: boolean;
  /** The window left the phone layout: the layer's content may live on as desktop UI. */
  breakpoint?: boolean;
}

export interface PhoneOverlayBar {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  onTitleTap?: () => void;
}

export interface PhoneOverlayOptions {
  id: string;
  kind: PhoneOverlayKind;
  open: boolean;
  onClose: (info: PhoneOverlayCloseInfo) => void;
  /** null / undefined: the layer draws its own chrome (drawer, sheets). */
  bar?: PhoneOverlayBar | null;
  /** First push of a page load opened from a deep link: back lands here. */
  deepLinkBaseUrl?: string;
  /** The layer's root element, dragged by the standalone edge swipe. */
  getElement?: () => HTMLElement | null;
  /**
   * true: leaving phone layout drops this layer's history entry but never calls
   * onClose, so the owner's own open state (a session, a file, a draft) survives
   * the resize and shows on desktop. Menus and sheets leave it unset and close.
   */
  keepOnBreakpoint?: boolean;
  /**
   * The layer this one sits on: it registers only once that one is open, so a
   * child whose effect runs first (React runs child effects before the parent's)
   * still lands above it, on a reload or a rotation back to phone.
   */
  parentId?: string;
}

export interface OverlayMarker { id: string; kind: PhoneOverlayKind; depth: number }

/** The top bar's view of the topmost layer that has a bar. */
export interface PhoneOverlayTopEntry {
  id: string;
  kind: PhoneOverlayKind;
  depth: number;
  bar: PhoneOverlayBar;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Pure stack rules (tests/web/phone-overlay-history.test.ts)
// ---------------------------------------------------------------------------

export interface StackItem { id: string; kind: PhoneOverlayKind; depth: number; pushed: boolean }

/** Depth recorded on a history state, 0 for an entry with no overlay marker. */
export function markerDepth(state: unknown): number {
  const m = (state as { walnutOverlay?: Partial<OverlayMarker> } | null | undefined)?.walnutOverlay;
  return typeof m?.depth === 'number' && m.depth > 0 ? m.depth : 0;
}

export function markerId(state: unknown): string | null {
  const m = (state as { walnutOverlay?: Partial<OverlayMarker> } | null | undefined)?.walnutOverlay;
  return typeof m?.id === 'string' ? m.id : null;
}

/** History state for a new layer: the old state (router keys kept) plus the marker. */
export function stateWithMarker(state: unknown, marker: OverlayMarker): Record<string, unknown> {
  const base = state && typeof state === 'object' ? { ...(state as Record<string, unknown>) } : {};
  return { ...base, walnutOverlay: marker };
}

/** The same state with no marker (deep-link base entry, reload clean-up). */
export function stateWithoutMarker(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const { walnutOverlay: _drop, ...rest } = state as Record<string, unknown>;
  return rest;
}

/**
 * A popstate landed on an entry of `targetDepth`: which layers close (top
 * first) and which stay. Layers whose push is still deferred never close here.
 */
export function popToDepth<T extends StackItem>(stack: readonly T[], targetDepth: number): { kept: T[]; closed: T[] } {
  const kept: T[] = [];
  const closed: T[] = [];
  for (const item of stack) {
    if (item.pushed && item.depth > targetDepth) closed.push(item);
    else kept.push(item);
  }
  closed.reverse();
  return { kept, closed };
}

/** Depth for the next push: one above the entry the browser is on now. */
export function nextDepth(currentState: unknown): number {
  return markerDepth(currentState) + 1;
}

/**
 * How a UI close of `item` maps to history: `back` when the browser is on this
 * layer's entry, `go` with the steps when layers above it still hold entries,
 * `direct` when its entry is gone (a navigate(replace) wiped it).
 */
export function closePlan(item: StackItem, currentState: unknown): { kind: 'back' } | { kind: 'go'; steps: number } | { kind: 'direct' } {
  if (!item.pushed) return { kind: 'direct' };
  const cur = markerDepth(currentState);
  if (markerId(currentState) === item.id && cur === item.depth) return { kind: 'back' };
  if (cur > item.depth) return { kind: 'go', steps: cur - item.depth + 1 };
  return { kind: 'direct' };
}

// ---------------------------------------------------------------------------
// Module store: one stack for the whole page
// ---------------------------------------------------------------------------

interface LiveEntry extends StackItem {
  token: number;
  bar: PhoneOverlayBar | null;
  onClose: (info: PhoneOverlayCloseInfo) => void;
  getElement?: () => HTMLElement | null;
  deepLinkBaseUrl?: string;
  keepOnBreakpoint: boolean;
  /** A UI close whose back has not landed yet: a breakpoint still closes it. */
  closing?: boolean;
}

let stack: LiveEntry[] = [];
let tokenSeq = 0;
let pendingBacks = 0;
let pendingBackTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The depth history still has to be taken back to (0: the base entry), done once
 * every pending back has landed and measured from where they landed: two gos
 * counted from one depth overshoot the base into the previous route. Set by a
 * breakpoint during a back, and by released layers.
 */
let pendingUnwindTo: number | null = null;
let pushedThisLoad = false;
let installed = false;
const listeners = new Set<() => void>();
/** Releases waiting one microtask for a StrictMode remount to reclaim them. */
const releasing = new Map<string, LiveEntry>();
/** Every release of this tick, settled together (a replaced column releases several at once). */
let releaseBatch: LiveEntry[] = [];
let releaseSettleScheduled = false;
let releaseGeneration = 0;

interface Snapshot { top: PhoneOverlayTopEntry | null; depth: number }
let snapshot: Snapshot = { top: null, depth: 0 };

function notify(): void {
  const withBar = [...stack].reverse().find((e) => e.bar);
  const prev = snapshot.top;
  const top: PhoneOverlayTopEntry | null = withBar && withBar.bar
    ? (prev && prev.id === withBar.id && prev.bar === withBar.bar && prev.depth === withBar.depth
      ? prev
      : { id: withBar.id, kind: withBar.kind, depth: withBar.depth, bar: withBar.bar, close: () => closeEntry(withBar) })
    : null;
  if (top === snapshot.top && stack.length === snapshot.depth) return;
  snapshot = { top, depth: stack.length };
  for (const l of [...listeners]) l();
}

export function subscribePhoneOverlays(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Is a layer open (any layer when no id is given)? Phone layout only. */
export function isPhoneOverlayOpen(id?: string): boolean {
  return id ? stack.some((e) => e.id === id) : stack.length > 0;
}

/** The ids of the open layers, bottom first (tests and diagnostics). */
export function phoneOverlayIds(): string[] {
  return stack.map((e) => e.id);
}

function canUseHistory(): boolean {
  return typeof window !== 'undefined' && typeof window.history?.pushState === 'function';
}

function beginBack(): void {
  pendingBacks += 1;
  if (pendingBackTimer) clearTimeout(pendingBackTimer);
  // A back that never answers (a browser that ignored it) must not hold every
  // later push forever.
  pendingBackTimer = setTimeout(() => {
    pendingBackTimer = null;
    if (pendingBacks > 0) {
      log.warn('phone-overlay', 'history back never answered, releasing pushes', { pendingBacks });
      pendingBacks = 0;
      flushDeferredPushes();
    }
  }, 1500);
}

function pushEntry(e: LiveEntry): void {
  if (!canUseHistory()) return;
  const href = window.location.href;
  if (e.deepLinkBaseUrl && !pushedThisLoad && markerDepth(window.history.state) === 0) {
    const base = new URL(e.deepLinkBaseUrl, href).href;
    if (base !== href) {
      // Back from a deep-linked layer lands on its base page, not outside Walnut.
      window.history.replaceState(stateWithoutMarker(window.history.state), '', base);
    }
  }
  e.depth = nextDepth(window.history.state);
  e.pushed = true;
  pushedThisLoad = true;
  window.history.pushState(stateWithMarker(window.history.state, { id: e.id, kind: e.kind, depth: e.depth }), '', href);
}

/** Nothing in flight: no back landing, no release unsettled, no unwind owed. */
function historySettled(): boolean {
  return pendingBacks === 0 && !releaseSettleScheduled && pendingUnwindTo === null;
}

function flushDeferredPushes(): void {
  if (pendingBacks > 0 || releaseSettleScheduled) return;
  if (pendingUnwindTo !== null) {
    // Before any push: a layer opened meanwhile must land above what stays.
    const target = pendingUnwindTo;
    pendingUnwindTo = null;
    const cur = canUseHistory() ? markerDepth(window.history.state) : 0;
    if (cur > target) {
      // Layers still open above the target lose their entries to this go: they
      // are pushed again once it lands, in stack order.
      for (const x of stack) if (x.pushed && x.depth > target) x.pushed = false;
      beginBack();
      window.history.go(target - cur);
      log.info('phone-overlay', 'unwind after pending backs and releases', { from: cur, to: target });
      return;
    }
  }
  let changed = false;
  for (const e of stack) {
    if (!e.pushed) { pushEntry(e); changed = true; }
  }
  if (changed) notify();
  for (const fn of afterBacks.splice(0)) {
    try { fn(); } catch (err) { log.error('phone-overlay', 'after-backs callback threw', { error: String(err) }); }
  }
}

const afterBacks: Array<() => void> = [];

/**
 * Run `fn` once every `history.back()` a closing layer started has landed (now, when
 * none is pending). A route push made before then is undone by the back (the first
 * trap above), so a caller that closes layers and then navigates waits here.
 */
export function afterPhoneOverlayBacks(fn: () => void): void {
  if (historySettled()) { fn(); return; }
  afterBacks.push(fn);
}

function removeFromStack(e: LiveEntry): boolean {
  const before = stack.length;
  stack = stack.filter((x) => x !== e);
  return stack.length !== before;
}

function onPopState(event: PopStateEvent): void {
  if (pendingBacks > 0) pendingBacks -= 1;
  if (pendingBacks === 0 && pendingBackTimer) { clearTimeout(pendingBackTimer); pendingBackTimer = null; }
  const { kept, closed } = popToDepth(stack, markerDepth(event.state));
  if (closed.length > 0) {
    stack = kept;
    notify();
    for (const e of closed) {
      try { e.onClose({ fromHistory: true }); } catch (err) {
        log.error('phone-overlay', 'onClose threw', { id: e.id, error: String(err) });
      }
    }
  }
  flushDeferredPushes();
}

/**
 * Left phone layout: take every layer and its entry off history. Temporary
 * layers (menus, sheets) close; a `keepOnBreakpoint` layer is only dropped, its
 * owner keeps its open state for desktop (2026-11-07: a resize to desktop
 * closed the open file and its session).
 */
function closeAllForBreakpoint(): void {
  if (stack.length === 0) return;
  const dropped = [...stack].reverse();
  const depth = canUseHistory() ? markerDepth(window.history.state) : 0;
  stack = [];
  notify();
  let closed = 0;
  for (const e of dropped) {
    // A layer the user was already closing still closes: its back lands after the stack is gone.
    if (e.keepOnBreakpoint && !e.closing) continue;
    closed += 1;
    try { e.onClose({ fromHistory: true, breakpoint: true }); } catch { /* owner's problem, keep closing */ }
  }
  const deferred = pendingBacks > 0;
  if (deferred) {
    // A back is still landing: unwind to the base from where it lands (flushDeferredPushes).
    pendingUnwindTo = 0;
  } else if (depth > 0) {
    beginBack();
    window.history.go(-depth);
  }
  log.info('phone-overlay', 'left phone layout, dropped layers', {
    count: dropped.length, closed, kept: dropped.length - closed, depth, deferred,
  });
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('popstate', onPopState);
  // Registered before any React subscriber, so the layers are closed before
  // their owners re-render as desktop.
  window.matchMedia?.(PHONE_LAYOUT_QUERY).addEventListener('change', (ev) => {
    if (!ev.matches) closeAllForBreakpoint();
  });
  // A reload keeps the browser's state, marker included, while no layer is
  // open any more: strip it so the next push does not count a ghost depth.
  if (canUseHistory() && markerDepth(window.history.state) > 0) {
    window.history.replaceState(stateWithoutMarker(window.history.state), '');
  }
}

function openEntry(opts: PhoneOverlayOptions): LiveEntry {
  install();
  const reclaimed = releasing.get(opts.id);
  if (reclaimed) {
    // StrictMode remount (or a same-id reopen in one tick): keep its entry, at
    // its depth's place (child effects remount before their parent's).
    releasing.delete(opts.id);
    releaseBatch = releaseBatch.filter((x) => x !== reclaimed);
    // A new owner may take the id (a replaced column showing the same file): its callbacks now.
    reclaimed.kind = opts.kind;
    reclaimed.onClose = opts.onClose;
    reclaimed.bar = opts.bar ?? null;
    reclaimed.getElement = opts.getElement;
    reclaimed.keepOnBreakpoint = opts.keepOnBreakpoint === true;
    const at = reclaimed.pushed ? stack.findIndex((x) => x.pushed && x.depth > reclaimed.depth) : -1;
    if (at < 0) stack.push(reclaimed); else stack.splice(at, 0, reclaimed);
    notify();
    return reclaimed;
  }
  const e: LiveEntry = {
    id: opts.id, kind: opts.kind, depth: 0, pushed: false, token: ++tokenSeq,
    bar: opts.bar ?? null, onClose: opts.onClose, getElement: opts.getElement,
    deepLinkBaseUrl: opts.deepLinkBaseUrl, keepOnBreakpoint: opts.keepOnBreakpoint === true,
  };
  stack.push(e);
  // A release still unsettled may take entries off history first: push after it.
  if (historySettled()) pushEntry(e);
  notify();
  return e;
}

/** Open flipped false or the owner unmounted without close(): never onClose. */
function releaseEntry(e: LiveEntry): void {
  if (!removeFromStack(e)) return;
  notify();
  releasing.set(e.id, e);
  releaseBatch.push(e);
  if (releaseSettleScheduled) return;
  releaseSettleScheduled = true;
  const gen = releaseGeneration;
  queueMicrotask(() => { if (gen === releaseGeneration) settleReleases(); });
}

/**
 * The tick's releases that no remount reclaimed: take their entries off history
 * in ONE unwind, to just below the lowest of them (a replaced column's session,
 * view and file used to plan three gos from the new session's entry, ignore them,
 * and leave three ghost backs). Waits for pending backs; an entry a
 * navigate(replace) already wiped is not unwound again (the depth check).
 */
function settleReleases(): void {
  releaseSettleScheduled = false;
  const batch = releaseBatch;
  releaseBatch = [];
  for (const e of batch) if (releasing.get(e.id) === e) releasing.delete(e.id);
  let lowest = Infinity;
  for (const e of batch) if (e.pushed) lowest = Math.min(lowest, e.depth);
  // Off phone the breakpoint already unwound everything.
  if (lowest !== Infinity && canUseHistory() && isPhoneLayout()) {
    pendingUnwindTo = Math.min(pendingUnwindTo ?? Infinity, lowest - 1);
  }
  flushDeferredPushes();
}

/** The UI close path (Back, x, backdrop, Escape, edge swipe). */
function closeEntry(e: LiveEntry): void {
  if (!stack.includes(e)) return;
  const plan = canUseHistory() ? closePlan(e, window.history.state) : { kind: 'direct' as const };
  if (plan.kind === 'back') { e.closing = true; beginBack(); window.history.back(); return; }
  if (plan.kind === 'go') {
    // The go closes every pushed layer from this one up.
    for (const x of stack) if (x.pushed && x.depth >= e.depth) x.closing = true;
    beginBack(); window.history.go(-plan.steps); return;
  }
  removeFromStack(e);
  notify();
  e.onClose({ fromHistory: false });
}

/** Close the topmost layer through history (Escape, edge swipe). */
export function closeTopPhoneOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  closeEntry(top);
  return true;
}

/** Root element of the top layer (edge swipe drags it). */
export function topPhoneOverlayElement(): HTMLElement | null {
  const top = stack[stack.length - 1];
  if (!top) return null;
  const own = top.getElement?.();
  if (own) return own;
  // Layers that do not hand over their element: the home overlays' known boxes.
  const selector = FALLBACK_LAYER_SELECTOR[top.kind];
  return selector && typeof document !== 'undefined' ? document.querySelector<HTMLElement>(selector) : null;
}

const FALLBACK_LAYER_SELECTOR: Partial<Record<string, string>> = {
  session: '.main-page-session-column.is-mobile-active',
  draft: '.main-page-session-column.is-mobile-active',
  chat: '.main-page-chat',
  drawer: '#primary-sidebar',
};

/** Install the popstate / breakpoint listeners early (AppShell mount). */
export function installPhoneOverlayHistory(): void {
  install();
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function barEqual(a: PhoneOverlayBar | null | undefined, b: PhoneOverlayBar | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.title === b.title && a.subtitle === b.subtitle && a.action === b.action && a.onTitleTap === b.onTitleTap;
}

/**
 * Register one layer. `close()` is the UI close: on phone it goes through
 * history; on desktop (or when the layer is not registered) it calls
 * `onClose({ fromHistory: false })` directly.
 */
export function usePhoneOverlay(o: PhoneOverlayOptions): { close: () => void } {
  const phone = usePhoneLayout();
  const optsRef = useRef(o);
  optsRef.current = o;
  const entryRef = useRef<LiveEntry | null>(null);
  const parentId = o.parentId;
  const parentOpen = useSyncExternalStore(
    subscribePhoneOverlays,
    () => !parentId || isPhoneOverlayOpen(parentId),
    () => !parentId,
  );
  const active = o.open && phone && parentOpen;

  useEffect(() => {
    if (!active) return undefined;
    const opts = optsRef.current;
    const e = openEntry({ ...opts, onClose: (info) => optsRef.current.onClose(info) });
    entryRef.current = e;
    return () => {
      entryRef.current = null;
      releaseEntry(e);
    };
  }, [active]);

  // Same layer, new subject (another session in the same overlay): retarget
  // the entry in place instead of popping and pushing.
  useEffect(() => {
    const e = entryRef.current;
    if (!e || (e.id === o.id && e.kind === o.kind)) return;
    const oldId = e.id;
    e.id = o.id;
    e.kind = o.kind;
    if (e.pushed && canUseHistory() && markerId(window.history.state) === oldId) {
      window.history.replaceState(stateWithMarker(window.history.state, { id: e.id, kind: e.kind, depth: e.depth }), '');
    }
    notify();
  }, [o.id, o.kind]);

  useEffect(() => {
    const e = entryRef.current;
    if (!e) return;
    e.getElement = o.getElement;
    e.keepOnBreakpoint = o.keepOnBreakpoint === true;
    const next = o.bar ?? null;
    if (barEqual(e.bar, next)) return;
    e.bar = next;
    notify();
  });

  const close = useCallback(() => {
    const e = entryRef.current;
    if (e && stack.includes(e)) closeEntry(e);
    else optsRef.current.onClose({ fromHistory: false });
  }, []);
  return { close };
}

function getSnapshot(): Snapshot { return snapshot; }
const SERVER_SNAPSHOT: Snapshot = { top: null, depth: 0 };
function getServerSnapshot(): Snapshot { return SERVER_SNAPSHOT; }

/** The topmost open layer that has a bar (the top bar draws it), or null. */
export function usePhoneOverlayTop(): PhoneOverlayTopEntry | null {
  return useSyncExternalStore(subscribePhoneOverlays, getSnapshot, getServerSnapshot).top;
}

/** How many layers are open (0 on desktop). */
export function usePhoneOverlayDepth(): number {
  return useSyncExternalStore(subscribePhoneOverlays, getSnapshot, getServerSnapshot).depth;
}

/** Test seam (vitest): the store's own entry points, without React. */
export const __phoneOverlayInternals = {
  open: (o: PhoneOverlayOptions) => openEntry(o),
  release: (e: unknown) => releaseEntry(e as LiveEntry),
  close: (e: unknown) => closeEntry(e as LiveEntry),
  leavePhone: () => closeAllForBreakpoint(),
};

/** Test hook: forget everything (vitest only). */
export function __resetPhoneOverlaysForTest(): void {
  stack = [];
  releasing.clear();
  pendingBacks = 0;
  pendingUnwindTo = null;
  releaseBatch = [];
  releaseSettleScheduled = false;
  releaseGeneration += 1;
  afterBacks.length = 0;
  pushedThisLoad = false;
  installed = false;
  snapshot = { top: null, depth: 0 };
}

// ---------------------------------------------------------------------------
// Standalone edge swipe (spec 4.3, P2): a Home Screen app has no browser back
// gesture, so a pan that starts within 20px of the left edge drags the top
// layer and, released past 30% of the width, closes it through history.
// Safari has its own gesture, so this is off outside standalone.
// ---------------------------------------------------------------------------

export const EDGE_SWIPE_START_PX = 20;
export const EDGE_SWIPE_CLOSE_RATIO = 0.3;

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

/** Pure release rule: close when dragged at least 30% of the width. */
export function edgeSwipeCloses(dx: number, width: number): boolean {
  return width > 0 && dx >= width * EDGE_SWIPE_CLOSE_RATIO;
}

export function usePhoneOverlayEdgeSwipe(): void {
  const phone = usePhoneLayout();
  useEffect(() => {
    if (!phone || !isStandaloneDisplay()) return undefined;
    let drag: { pointerId: number; startX: number; el: HTMLElement | null; dx: number } | null = null;
    const reset = (el: HTMLElement | null, animate: boolean) => {
      if (!el) return;
      el.style.transition = animate ? 'transform 180ms ease-out' : '';
      el.style.transform = '';
      if (animate) setTimeout(() => { el.style.transition = ''; }, 200);
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.clientX >= EDGE_SWIPE_START_PX || stack.length === 0) return;
      // A layer with no box to move still closes on the swipe, it just does not follow the finger.
      drag = { pointerId: ev.pointerId, startX: ev.clientX, el: topPhoneOverlayElement(), dx: 0 };
    };
    const onMove = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      drag.dx = Math.max(0, ev.clientX - drag.startX);
      if (!drag.el) return;
      drag.el.style.transition = 'none';
      drag.el.style.transform = `translateX(${drag.dx}px)`;
    };
    const onUp = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const { el, dx } = drag;
      drag = null;
      if (edgeSwipeCloses(dx, window.innerWidth)) {
        reset(el, false);
        closeTopPhoneOverlay();
      } else {
        reset(el, true);
      }
    };
    const onCancel = () => { if (drag) { reset(drag.el, true); drag = null; } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
    };
  }, [phone]);
}
