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
 *
 * Enlarged from a fullscreen review card (`over`), the card lies OVER that
 * review card instead: the same top, the same right edge, wider to the left and
 * as tall as the box allows, so it grows where the reader was looking
 * (2026-10-27, the user: "enlarge instead of open which jump to another place").
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  CARD_GROWN_HEADROOM, CARD_GROWN_WIDTH, placeCard, placeCardOver, type CardAnchorRect, type CardGrown, type CardPlacement,
} from '@/utils/thread-card';

export interface UseThreadCardPlaceArgs {
  /** The card is open on this key (null: closed). */
  key: string | null;
  containerRef: RefObject<HTMLElement | null>;
  layerRef: RefObject<HTMLElement | null>;
  /** The passage (a Range), else the row it is in (an Element), else null. */
  locate: () => Range | Element | null;
  /** The element the card is enlarged over (a review card), or null: below its passage. */
  over?: () => Element | null;
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
  const overOn = !!args.over;
  const [place, setPlace] = useState<ThreadCardPlace | null>(null);
  // Always the newest locator: a measurement fired by a mutation must look the
  // passage up with the tree and rows of THIS render, not of the render that
  // opened the card (a promoted pending question had no node back then).
  const argsRef = useRef(args);
  argsRef.current = args;
  const overLock = useRef<{ key: string; dy: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    const layer = layerRef.current;
    if (!key || !el || !layer) { setPlace(null); return; }
    const measure = () => {
      const layerRect = layer.getBoundingClientRect();
      const boxRect = el.getBoundingClientRect();
      const covered0 = parseFloat(getComputedStyle(el).paddingTop) || 0;
      const overEl = argsRef.current.over?.() ?? null;
      const overRect = overEl ? overEl.getBoundingClientRect() : null;
      if (overRect && (overRect.width || overRect.height)) {
        const room0 = el.clientHeight - covered0;
        const anchor = { top: overRect.top - layerRect.top, bottom: overRect.bottom - layerRect.top, left: overRect.left - layerRect.left, right: overRect.right - layerRect.left };
        let next = placeCardOver(
          anchor,
          { top: boxRect.top + covered0 - layerRect.top, bottom: boxRect.bottom - layerRect.top },
          Math.max(240, Math.round(room0 - CARD_GROWN_HEADROOM)),
        );
        // The shift up and the height depend on where the box was scrolled when
        // the card opened: kept from then, so later measures (an answer
        // streaming in while the reader scrolls) only follow the review card.
        const lock = overLock.current;
        if (lock && lock.key === key) next = { ...next, top: Math.max(0, Math.round(anchor.top + lock.dy)), maxHeight: lock.maxHeight, grown: { ...next.grown, maxHeight: lock.maxHeight } };
        else overLock.current = { key, dy: next.top - Math.round(anchor.top), maxHeight: next.maxHeight };
        setPlace((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        return;
      }
      overLock.current = null;
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
      // The box's top padding is what the panel's glass header covers (the
      // history pads its top by the header's height): a card as tall as the box
      // would have its head under the header once scrolled whole into view.
      const covered = parseFloat(getComputedStyle(el).paddingTop) || 0;
      const room = el.clientHeight - covered;
      const maxHeight = Math.max(200, Math.round(Math.min(el.clientHeight * 0.6, room - CARD_GROWN_HEADROOM)));
      const wide = placeCard(anchor, layerRect.width, CARD_GROWN_WIDTH);
      const next: ThreadCardPlace = {
        ...placeCard(anchor, layerRect.width),
        maxHeight,
        grown: { left: wide.left, width: wide.width, maxHeight: Math.max(maxHeight, room - CARD_GROWN_HEADROOM) },
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
    // Over a review card: it moves by its own style.top (the sidebar writes it)
    // and grows by itself; neither is a child-list change.
    const overEl = overOn ? argsRef.current.over?.() ?? null : null;
    if (overEl) {
      ro?.observe(overEl);
      mo.observe(overEl, { attributes: true, attributeFilter: ['style'] });
    }
    window.addEventListener('resize', later);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      window.removeEventListener('resize', later);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, containerRef, layerRef, overOn]);

  return key ? place : null;
}
