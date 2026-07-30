import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';

/**
 * Selection guard — shared primitives that keep text selection usable in
 * auto-scrolling / live-updating chat surfaces.
 *
 * Two failure modes this solves:
 * 1. AUTO-SCROLL vs DRAG-SELECT: while the user drags a selection, any
 *    `scrollTop = scrollHeight` write shifts the content under the cursor, so
 *    the browser extends the selection to wherever the mouse now points
 *    (usually the bottom). Scroll paths must pause while a selection gesture
 *    or an active selection intersects their container.
 * 2. innerHTML REPLACEMENT vs SELECTION: streaming markdown blocks re-render
 *    via dangerouslySetInnerHTML on every delta, destroying the DOM nodes the
 *    selection is anchored to. The rendered value must freeze while the
 *    selection lives inside the block, and catch up when it clears.
 */

// ── Module-level pointer tracking (lazy, browser-only) ──
// Tracks whether the primary button is held and where the gesture started, so
// guards can pause auto-scroll for the whole mousedown→mouseup window — before
// the selection is even non-collapsed.
//
// Module-level ON PURPOSE, not per-hook: every chat message block mounts one of
// these hooks, so per-hook listeners would pile hundreds of duplicates onto
// document, and all surfaces must share ONE "is the button held" fact anyway.
// The listeners are installed once and never removed — they live for the
// document lifetime by design (a handful of no-op handlers, not a leak).
let pointerDownTarget: Node | null = null;
let listenersInstalled = false;

function ensurePointerTracking(): void {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  document.addEventListener('pointerdown', (e) => {
    // Only primary-button gestures latch — and a right/middle press MID-drag
    // (which fires its own pointerdown with button!==0) must not clear the
    // latch, or the guard drops out in the middle of the left-button gesture.
    if (e.button === 0) pointerDownTarget = e.target instanceof Node ? e.target : null;
  }, true);
  const clear = () => { pointerDownTarget = null; };
  document.addEventListener('pointerup', clear, true);
  document.addEventListener('pointercancel', clear, true);
  // Dragging out of the window / cmd-tabbing away can eat the pointerup; a
  // stuck non-null pointerDownTarget would pause auto-scroll forever.
  window.addEventListener('blur', clear);
}

/** True while the primary button is held on a target inside `el`. */
export function pointerSelectingWithin(el: Element | null): boolean {
  ensurePointerTracking();
  return !!el && !!pointerDownTarget && el.contains(pointerDownTarget);
}

/** True when a non-collapsed selection intersects `node`. */
export function selectionIntersects(node: Node | null): boolean {
  if (!node || typeof window === 'undefined') return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    try {
      if (sel.getRangeAt(i).intersectsNode(node)) return true;
    } catch { /* detached range */ }
  }
  return false;
}

/**
 * Returns a predicate: "should auto-scroll pause right now?" — true while the
 * user is drag-selecting inside the container OR an active selection
 * intersects it. Selection = user intent to read/copy, same as scrolling up.
 */
export function useSelectionScrollGuard(ref: RefObject<HTMLElement | null>): () => boolean {
  ensurePointerTracking();
  return useCallback(
    () => pointerSelectingWithin(ref.current) || selectionIntersects(ref.current),
    [ref],
  );
}

/**
 * Freezes `value` while a selection gesture or active selection is inside the
 * host element, so innerHTML swaps can't destroy the selection's anchor
 * nodes mid-copy. Unfreezes (and catches up to the latest value) as soon as
 * the selection clears or leaves the host.
 *
 * Attach `hostRef` to the element rendering the value.
 *
 * What actually preserves the selection: the component still re-renders on
 * every delta (props change), but React diffs `dangerouslySetInnerHTML` by
 * `__html` STRING EQUALITY — same frozen string ⇒ React skips the innerHTML
 * write ⇒ the selection's anchor text nodes are never touched. Any refactor
 * that makes the rendered html differ per render (timestamps, changing keys)
 * silently breaks this fix.
 *
 * Render-time reads of module pointer state / live DOM selection (and the
 * frozenRef write) are deliberate rule-bends: all idempotent, and a torn or
 * discarded concurrent render costs at most one frame of stale freeze, which
 * the lagging-effect listeners below self-heal. Do NOT "fix" this with
 * state/useSyncExternalStore — subscribing to selectionchange would re-render
 * every chat surface on every drag tick.
 */
export function useSelectionFrozen<T>(value: T): { value: T; hostRef: RefObject<HTMLDivElement | null> } {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frozenValue = useSelectionFrozenWith(hostRef, value);
  return { value: frozenValue, hostRef };
}

/**
 * Ref-supplied variant of useSelectionFrozen — freezes `value` while a
 * selection gesture or active selection is inside `hostRef`'s element. Used
 * where the host element already has a ref (e.g. the chat scroll container
 * freezing which streaming blocks are hidden, so an absorption can't unmount
 * the DOM the user's selection lives in).
 */
export function useSelectionFrozenWith<T>(hostRef: RefObject<HTMLElement | null>, value: T): T {
  const frozenRef = useRef(value);
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const frozen = pointerSelectingWithin(hostRef.current) || selectionIntersects(hostRef.current);
  if (!frozen) frozenRef.current = value;
  const lagging = frozenRef.current !== value;

  // While lagging behind the live value, watch for the selection to clear so
  // the block can catch up. No polling — selectionchange covers keyboard +
  // programmatic clears; pointerup covers the click-that-collapses case where
  // selectionchange can fire before our render reads the new state. (Ordering
  // note: the module-level `clear` registered first also runs first on
  // pointerup, so unfreeze reads an already-cleared pointerDownTarget.)
  useEffect(() => {
    if (!lagging) return;
    const unfreeze = () => {
      if (!pointerSelectingWithin(hostRef.current) && !selectionIntersects(hostRef.current)) bump();
    };
    document.addEventListener('selectionchange', unfreeze);
    document.addEventListener('pointerup', unfreeze, true);
    // The selection may have cleared in the window between the lagging render
    // and this effect (with no further events coming if the stream ended) —
    // check once now so the block can't freeze forever.
    unfreeze();
    return () => {
      document.removeEventListener('selectionchange', unfreeze);
      document.removeEventListener('pointerup', unfreeze, true);
    };
  }, [lagging, hostRef]);

  return frozenRef.current;
}
