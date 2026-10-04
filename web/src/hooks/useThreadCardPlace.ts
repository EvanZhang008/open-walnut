/**
 * Where the comment card sits: measured from the passage it is about, in the
 * coordinates of the card layer (a zero-height positioned box at the top of
 * the scroll content, so the card scrolls with the text). Re-measured when the
 * passage moves: the box resizes, rows above it change (an answer streaming
 * in), the window resizes. Never on scroll: content coordinates do not move.
 *
 * A passage that cannot be found (its row not rendered yet) anchors the card
 * to the reply row it belongs to; with no row either, to the top of what is on
 * screen. Nothing is drawn until the first measurement lands.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  CARD_GROWN_HEADROOM, CARD_GROWN_WIDTH, placeCard, type CardAnchorRect, type CardGrown, type CardPlacement,
} from '@/utils/thread-card';

export interface UseThreadCardPlaceArgs {
  /** The card is open on this key (null: closed). */
  key: string | null;
  containerRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  /** The passage (a Range), else the row it is in (an Element), else null. */
  locate: () => Range | Element | null;
}

export interface ThreadCardPlace extends CardPlacement {
  maxHeight: number;
  /** Expanded (⤢): wider, taller, the same top. */
  grown: CardGrown;
}

/** The last line of a passage: a multi-line quote hangs its card off its end. */
function anchorRectOf(target: Range | Element): DOMRect | null {
  if (target instanceof Element) {
    const r = target.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }
  const rects = target.getClientRects();
  const last = rects.length ? rects[rects.length - 1] : null;
  const whole = target.getBoundingClientRect();
  if (!whole.width && !whole.height) return null;
  if (!last) return whole;
  // The union's horizontal reach, the last line's bottom.
  return new DOMRect(whole.left, whole.top, whole.width, last.bottom - whole.top);
}

export function useThreadCardPlace(args: UseThreadCardPlaceArgs): ThreadCardPlace | null {
  const { key, containerRef, layerRef } = args;
  const [place, setPlace] = useState<ThreadCardPlace | null>(null);
  // Always the newest locator: a measurement fired by a mutation must look the
  // passage up with the tree and rows of THIS render, not of the render that
  // opened the card (a promoted pending question had no node back then).
  const argsRef = useRef(args);
  argsRef.current = args;

  useLayoutEffect(() => {
    const el = containerRef.current;
    const layer = layerRef.current;
    if (!key || !el || !layer) { setPlace(null); return; }
    const measure = () => {
      const layerRect = layer.getBoundingClientRect();
      const boxRect = el.getBoundingClientRect();
      const target = argsRef.current.locate();
      const r = target ? anchorRectOf(target) : null;
      let anchor: CardAnchorRect;
      if (r) {
        anchor = { top: r.top - layerRect.top, bottom: r.bottom - layerRect.top, left: r.left - layerRect.left, right: r.right - layerRect.left };
      } else {
        // The top of what is on screen, right-aligned.
        const top = boxRect.top - layerRect.top + 12;
        anchor = { top, bottom: top, left: 0, right: layerRect.width };
      }
      const maxHeight = Math.max(200, Math.round(el.clientHeight * 0.6));
      const wide = placeCard(anchor, layerRect.width, CARD_GROWN_WIDTH);
      const next: ThreadCardPlace = {
        ...placeCard(anchor, layerRect.width),
        maxHeight,
        grown: { left: wide.left, width: wide.width, maxHeight: Math.max(maxHeight, el.clientHeight - CARD_GROWN_HEADROOM) },
      };
      setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width
        && prev.maxHeight === next.maxHeight && prev.grown.left === next.grown.left && prev.grown.width === next.grown.width
        && prev.grown.maxHeight === next.grown.maxHeight ? prev : next));
    };
    measure();
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    const mo = new MutationObserver(later);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    ro?.observe(el);
    window.addEventListener('resize', later);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', later);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, containerRef, layerRef]);

  return key ? place : null;
}
