/**
 * Home rows hold still under the thumb (spec 4.5, C61).
 *
 * A phase change pushed over WS re-sorts the home list. On a phone the row the
 * thumb was about to tap then slides away, and the tap lands on its neighbour.
 * While the list was touched in the last 2 s, is coasting (scroll momentum), or
 * any phone layer is open, the RELATIVE order of the rows already shown is
 * frozen; the reorders that arrive meanwhile are queued and counted
 * (`1 update` / `N updates`). Tapping the pill applies them; so does coming to
 * rest at the top of the list (scrollTop 0, 2 s without a touch, no layer).
 * New rows appear at once (at their live place) and removed rows leave at once:
 * only the order of rows that stay is held.
 *
 * Desktop: pass-through, no listeners.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { usePhoneOverlayDepth } from '@/hooks/usePhoneOverlayHistory';

export const HOLD_AFTER_TOUCH_MS = 2000;
export const MOMENTUM_MS = 160;
const AUTO_APPLY_POLL_MS = 400;

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Do the ids both lists share appear in the same relative order? */
export function sameRelativeOrder(a: readonly string[], b: readonly string[]): boolean {
  const inB = new Set(b);
  const inA = new Set(a);
  const ca = a.filter((id) => inB.has(id));
  const cb = b.filter((id) => inA.has(id));
  return sameOrder(ca, cb);
}

/**
 * `frozen`'s relative order for the ids still live, with every new live id
 * inserted right after the live row that precedes it (or first).
 */
export function mergeStableOrder(frozen: readonly string[], live: readonly string[]): string[] {
  const liveSet = new Set(live);
  const out = frozen.filter((id) => liveSet.has(id));
  const placed = new Set(out);
  if (placed.size === live.length) return out;
  for (let i = 0; i < live.length; i++) {
    const id = live[i];
    if (placed.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(live[j]);
      if (k >= 0) { at = k + 1; break; }
    }
    out.splice(at, 0, id);
    placed.add(id);
  }
  return out;
}

export function updatesLabel(n: number): string {
  return n === 1 ? '1 update' : `${n} updates`;
}

/**
 * The gate itself, without React (tests/web/stable-order.test.ts). `update`
 * takes each live order and whether the list must hold still; it returns the
 * order to show. Idempotent for a repeated live order (StrictMode renders twice).
 */
export class StableOrderGate {
  private shown: string[] = [];
  private lastLive: string[] = [];
  pending = 0;

  update(live: readonly string[], hold: boolean): string[] {
    const reordered = this.lastLive.length > 0 && !sameRelativeOrder(this.lastLive, live);
    this.lastLive = [...live];
    if (!hold && this.pending === 0) {
      this.shown = [...live];
      return this.shown;
    }
    const merged = mergeStableOrder(this.shown, live);
    if (sameOrder(merged, live)) {
      // The live order came back to what is shown: nothing is queued any more.
      this.pending = 0;
      this.shown = [...live];
      return this.shown;
    }
    if (reordered) this.pending += 1;
    else if (this.pending === 0) this.pending = 1;
    this.shown = merged;
    return this.shown;
  }

  apply(): string[] {
    this.pending = 0;
    this.shown = [...this.lastLive];
    return this.shown;
  }

  current(): string[] { return this.shown; }
}

// ---------------------------------------------------------------------------
// Touch clock: one set of document listeners for the whole page.
// ---------------------------------------------------------------------------

let lastTouchAt = 0;
let touching = 0;
let lastScrollAt = 0;
let clockUsers = 0;
const onTouchStart = () => { touching += 1; lastTouchAt = Date.now(); };
const onTouchMove = () => { lastTouchAt = Date.now(); };
const onTouchEnd = (e: TouchEvent) => { touching = e.touches?.length ?? 0; lastTouchAt = Date.now(); };
const onScroll = () => { lastScrollAt = Date.now(); };

function useTouchClock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    clockUsers += 1;
    if (clockUsers === 1) {
      document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
      document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
      document.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
      document.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
      document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    }
    return () => {
      clockUsers -= 1;
      if (clockUsers > 0) return;
      document.removeEventListener('touchstart', onTouchStart, true);
      document.removeEventListener('touchmove', onTouchMove, true);
      document.removeEventListener('touchend', onTouchEnd, true);
      document.removeEventListener('touchcancel', onTouchEnd, true);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [enabled]);
}

/** Touched in the last 2 s, a finger down, or still coasting. */
export function touchHold(now = Date.now()): boolean {
  return touching > 0 || now - lastTouchAt < HOLD_AFTER_TOUCH_MS || now - lastScrollAt < MOMENTUM_MS;
}

/** Test seam: pretend a touch just ended (vitest has no TouchEvent). */
export function __noteTouchForTest(at = Date.now()): void { lastTouchAt = at; touching = 0; }

// ---------------------------------------------------------------------------
// The queued-updates pill reads this (one home list per page).
// ---------------------------------------------------------------------------

export interface QueuedUpdates { pending: number; apply: () => void }
const NONE: QueuedUpdates = { pending: 0, apply: () => {} };
let queued: QueuedUpdates = NONE;
const queuedListeners = new Set<() => void>();
function setQueued(next: QueuedUpdates): void {
  if (queued.pending === next.pending && queued.apply === next.apply) return;
  queued = next;
  for (const l of [...queuedListeners]) l();
}
function subscribeQueued(cb: () => void): () => void {
  queuedListeners.add(cb);
  return () => { queuedListeners.delete(cb); };
}
export function useQueuedUpdates(): QueuedUpdates {
  return useSyncExternalStore(subscribeQueued, () => queued, () => NONE);
}

export interface StableOrderOptions {
  enabled: boolean;
  /** The list's scroll box (auto-apply waits for scrollTop 0). */
  getScroller?: () => HTMLElement | null;
}

export function useStableOrder<T>(items: T[], keyOf: (item: T) => string, opts: StableOrderOptions): T[] {
  const { enabled } = opts;
  const depth = usePhoneOverlayDepth();
  const gateRef = useRef<StableOrderGate | null>(null);
  if (!gateRef.current) gateRef.current = new StableOrderGate();
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const getScrollerRef = useRef(opts.getScroller);
  getScrollerRef.current = opts.getScroller;
  useTouchClock(enabled);

  const shown = useMemo(() => {
    if (!enabled) return items;
    const gate = gateRef.current!;
    const ids = gate.update(items.map(keyOf), depth > 0 || touchHold());
    if (sameOrder(ids, items.map(keyOf))) return items;
    const byKey = new Map(items.map((it) => [keyOf(it), it]));
    return ids.map((id) => byKey.get(id)).filter((it): it is T => it !== undefined);
    // `version` re-runs the gate after apply(); keyOf is a stable accessor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, enabled, version]);

  const apply = useCallback(() => {
    gateRef.current?.apply();
    bump();
  }, []);

  const pending = enabled ? gateRef.current.pending : 0;
  useEffect(() => {
    setQueued(pending > 0 ? { pending, apply } : NONE);
  }, [pending, apply]);
  useEffect(() => () => setQueued(NONE), []);

  // Auto-apply at rest at the top of the list.
  useEffect(() => {
    if (!enabled || pending === 0 || depth > 0) return undefined;
    const timer = setInterval(() => {
      const scroller = getScrollerRef.current?.() ?? null;
      const atTop = !scroller || scroller.scrollTop <= 0;
      if (atTop && !touchHold()) apply();
    }, AUTO_APPLY_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, pending, depth, apply]);

  return shown;
}
