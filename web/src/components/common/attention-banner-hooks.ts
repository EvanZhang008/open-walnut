/**
 * The attention card's live inputs, kept out of AttentionBanner.tsx: the
 * height cap by mount, pointer and keyboard focus inside the card (answered
 * at mount too, since WebKit sends no pointerenter to an element mounted
 * under a static pointer), the time-based wake, the Dismiss all hidden
 * success rows (session-backed), and the layout hold (spec 5.5).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { serverNow } from '@/hooks/useHostStatus';
import type { BannerMount } from '@/utils/host-banner-placement';
import { isPointerOver } from '@/utils/pointer-tracker';
import { getHiddenReady, setHiddenReady } from '@/utils/attention-banner-session';

/** The whole card is at most max(40% of its container, 132px) tall. */
export const CARD_CAP_RATIO = 0.4;
export const CARD_MIN_CAP_PX = 132;
/** A held layout change waits at most this long from the first queued change. */
export const HOLD_MAX_MS = 10_000;

/** The container each mount measures its cap against. */
export const MOUNT_CONTAINER: Record<BannerMount, string> = {
  tasks: '.todo-panel',
  notifications: '.notification-panel',
  slot: '.main-page-chat',
  draft: '.main-page-session-column, .draft-session-panel',
};

/**
 * The card's max height. The 40% share includes the card's own vertical
 * margins (marginY), so whatever follows the card keeps at least 60%.
 */
export function cardCapPx(containerHeight: number, marginY = 0): number {
  return Math.round(Math.max(CARD_CAP_RATIO * containerHeight - marginY, CARD_MIN_CAP_PX));
}

/** Top plus bottom margin of `el` in px (0 when it is not rendered). */
export function verticalMarginPx(el: HTMLElement | null): number {
  if (!el || typeof getComputedStyle === 'undefined') return 0;
  const cs = getComputedStyle(el);
  return (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The first focusable element after `el` in document order. */
export function focusAfter(el: HTMLElement | null): void {
  if (!el) return;
  const all = Array.from(document.querySelectorAll<HTMLElement>('button, [href], input, textarea, select, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'));
  const next = all.find((c) => !el.contains(c) && (el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) && c.getClientRects().length > 0);
  next?.focus();
}

/** The mount container's height (null until measured). */
export function useMountHeight(el: HTMLElement | null, mount: BannerMount): number | null {
  const [h, setH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = el?.closest<HTMLElement>(MOUNT_CONTAINER[mount]);
    if (!box) return;
    setH(box.getBoundingClientRect().height);
    if (typeof ResizeObserver === 'undefined') return;
    // The update lands in the next frame, never inside the observer callback: a
    // re-render there resizes observed boxes in the same frame, which WebKit
    // reports as 'ResizeObserver loop completed with undelivered notifications' (N3-21).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = Math.round(box.getBoundingClientRect().height);
        setH((prev) => (prev != null && Math.round(prev) === next ? prev : next));
      });
    });
    ro.observe(box);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [el, mount]);
  return h;
}

/**
 * Pointer or keyboard focus inside the card. At mount the pointer is asked
 * directly (isPointerOver), not left to pointerenter. Keyboard focus holds
 * rows like the pointer does; the focus a mouse click leaves on a button does not.
 */
export function usePointerFocus(el: HTMLElement | null) {
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  useLayoutEffect(() => { if (el) setPointerInside(isPointerOver(el)); }, [el]);
  // WebKit loses the card's pointerleave when the element under the pointer is
  // replaced (a row x turning into its undo line): while inside, a document
  // move outside the card's box, or the pointer leaving the window, says so.
  useEffect(() => {
    if (!el || !pointerInside) return;
    const onMove = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) setPointerInside(false);
    };
    const onOut = (e: MouseEvent): void => { if (!e.relatedTarget) setPointerInside(false); };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    document.addEventListener('pointermove', onMove, opts);
    document.addEventListener('mouseout', onOut, opts);
    return () => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('mouseout', onOut, true);
    };
  }, [el, pointerInside]);
  const handlers = {
    onPointerEnter: () => setPointerInside(true),
    onPointerLeave: () => setPointerInside(false),
    onFocus: (e: FocusEvent<HTMLElement>) => setFocusInside(!!(e.target as HTMLElement).matches?.(':focus-visible')),
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusInside(false);
    },
  };
  return { pointerInside, focusInside, handlers };
}

/** Re-render at a server time with no new frame (3s success hold, reconnect age, deferral cap). */
export function useWakeAt(wakeAt: number | null): void {
  const [, setWake] = useState(0);
  useEffect(() => {
    if (wakeAt === null) return;
    const t = setTimeout(() => setWake((n) => n + 1), Math.max(0, wakeAt - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [wakeAt]);
}

type HiddenMap = ReadonlyMap<string, number>;

/**
 * Success rows Dismiss all hid, kept in the session (a remount keeps them
 * hidden). Each is forgotten when its own 3s would have ended, so the same
 * host healing again later shows its success row.
 */
export function useHiddenReady(): [HiddenMap, (update: (m: HiddenMap) => HiddenMap) => void] {
  const [hidden, setHidden] = useState<HiddenMap>(getHiddenReady);
  const update = useCallback((fn: (m: HiddenMap) => HiddenMap) => {
    setHidden((m) => { const next = fn(m); setHiddenReady(next); return next; });
  }, []);
  useEffect(() => {
    if (hidden.size === 0) return;
    const next = Math.min(...hidden.values());
    const t = setTimeout(() => {
      update((m) => {
        const at = serverNow();
        const kept = new Map([...m].filter(([, until]) => until > at));
        return kept.size === m.size ? m : kept;
      });
    }, Math.max(0, next - serverNow()) + 30);
    return () => clearTimeout(t);
  }, [hidden, update]);
  return [hidden, update];
}

/**
 * The layout hold (spec 5.5). While `hold` is true, a change whose
 * `signature` differs from the one on screen (a height change: the card
 * appearing or leaving, rows added or removed, a success row leaving, an undo
 * row collapsing, row 1 changing) is queued: the last applied value keeps
 * rendering, for at most HOLD_MAX_MS from the first queued change, then
 * everything applies at once. `flush()` applies the next render at once (the
 * user's own click: the change is what they asked for).
 */
export function useHeldLayout<T>(live: T, signature: string, hold: boolean): { value: T; flush: () => void } {
  const shown = useRef<{ value: T; signature: string }>({ value: live, signature });
  const since = useRef<number | null>(null);
  const force = useRef(false);
  const [, setTick] = useState(0);
  const now = Date.now();
  let value = live;
  if (signature === shown.current.signature || force.current || !hold) {
    shown.current = { value: live, signature };
    since.current = null;
    force.current = false;
  } else if (since.current === null || now - since.current < HOLD_MAX_MS) {
    if (since.current === null) since.current = now;
    value = shown.current.value;
  } else {
    shown.current = { value: live, signature };
    since.current = null;
  }
  const waiting = since.current;
  useEffect(() => {
    if (waiting === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, waiting + HOLD_MAX_MS - Date.now()) + 20);
    return () => clearTimeout(t);
  }, [waiting]);
  const flush = useCallback(() => { force.current = true; }, []);
  return { value, flush };
}
