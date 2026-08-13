/**
 * SelectionAskPill — the floating "Ask about this" pill shared by every
 * quote-to-ask surface (Changed tab diff, Files preview, source editor,
 * HTML preview iframe).
 *
 * Placement rules (each one fixes a shipped complaint):
 *  - HUGS THE POINTER, never covers the selection: the pill appears just
 *    outside the selection edge nearest to where the mouse was RELEASED —
 *    drag down → below the selection's bottom; drag up → above its top;
 *    horizontally at the release x. The old "always above the selection top"
 *    put the pill a whole paragraph away from the cursor after a long
 *    downward drag.
 *  - Portalled to <body>: position:fixed inside a panel breaks the moment any
 *    ancestor gains a transform/filter/backdrop-filter (glass surfaces, the
 *    FileViewer overlay) — that ancestor becomes the containing block and the
 *    pill lands ON the text instead of beside it.
 *  - Positioned from MEASURED size, no CSS transform: left/top are final
 *    viewport coords, so no cascade rule can shift the pill onto the text.
 *  - GLUED to the live selection: on every scroll/resize the pill re-derives
 *    its position from the selection's current bounding rect (keeping its
 *    chosen side), so scrolling can't leave a stale pill covering unrelated
 *    lines. When the selection is gone, the pill dismisses itself.
 *  - Flips to the other side (arrow direction follows) when its own side has
 *    no viewport room, instead of covering the selected line at an edge.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Bounding rect of the current non-collapsed selection in `doc`, or null. */
export function selectionClientRect(doc: Document = document): DOMRect | null {
  const sel = doc.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return (rect.width || rect.height) ? rect : null;
}

interface SelectionAskPillProps {
  /**
   * The POINTER position at mouseup (viewport coords) — where the user let go
   * of the drag. The pill hugs this point: released at the bottom of the
   * selection (dragged downward) → pill sits BELOW the selection; released at
   * the top (dragged upward) → pill sits ABOVE. Identity change re-places.
   */
  anchor: { x: number; y: number };
  onCommit: () => void;
  /** Called when the tracked selection disappears (pill should unmount). */
  onDismiss: () => void;
  /**
   * Where to read the live selection rect from, in TOP-viewport coords.
   * Defaults to the top document's selection; surfaces whose selection lives
   * elsewhere (the HTML preview iframe) pass a resolver that translates.
   */
  resolveRect?: () => DOMRect | null;
  /**
   * Extra scroll source to track. The window-level capture listener sees every
   * scroll in THIS document, but not scrolls inside an iframe's document —
   * the HTML preview passes its contentDocument here.
   */
  listenTo?: EventTarget | null;
}

const GAP = 8;

export function SelectionAskPill({ anchor, onCommit, onDismiss, resolveRect, listenTo }: SelectionAskPillProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  // Preferred side, decided ONCE per selection from where the mouse was
  // released (drag down → below, drag up → above) so the pill hugs the
  // cursor instead of floating at the far end of a long selection. A ref,
  // not derived in place(): re-deriving on scroll compares the STALE anchor
  // against moved rects and made the pill hop sides mid-scroll.
  const preferBelowRef = useRef<boolean | null>(null);

  const place = useCallback(() => {
    const rect = resolveRect ? resolveRect() : selectionClientRect();
    if (!rect) { onDismiss(); return; }
    const h = btnRef.current?.offsetHeight ?? 30;
    const w = btnRef.current?.offsetWidth ?? 110;
    if (preferBelowRef.current === null) {
      preferBelowRef.current = Math.abs(anchor.y - rect.bottom) <= Math.abs(anchor.y - rect.top);
    }
    // Keep the chosen side unless it has no viewport room → flip.
    let below = preferBelowRef.current;
    if (below && rect.bottom + GAP + h > window.innerHeight - 4) below = false;
    if (!below && rect.top - GAP - h < 4) below = true;
    // Horizontally at the release point (clamped to the viewport AND to the
    // selection's span so the arrow still points at selected text).
    const cx = Math.min(Math.max(anchor.x, rect.left), rect.right);
    const left = Math.min(Math.max(cx - w / 2, 4), window.innerWidth - w - 4);
    const top = below ? rect.bottom + GAP : rect.top - GAP - h;
    setPos({ left, top, below });
  }, [resolveRect, onDismiss, anchor.x, anchor.y]);

  useLayoutEffect(() => {
    // A new anchor = a new selection gesture → re-decide which side to hug.
    preferBelowRef.current = null;
    place();
    let raf = 0;
    const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    // Capture phase: the scrolling element is usually a nested pane, and its
    // scroll event does not bubble to window. selectionchange dismisses the
    // pill the moment the selection collapses (a click elsewhere) — place()
    // resolves a null rect then and calls onDismiss. Clicking the pill itself
    // is safe: its mousedown preventDefaults, so the selection survives.
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    document.addEventListener('selectionchange', onMove);
    listenTo?.addEventListener('scroll', onMove, true);
    listenTo?.addEventListener('selectionchange', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
      document.removeEventListener('selectionchange', onMove);
      listenTo?.removeEventListener('scroll', onMove, true);
      listenTo?.removeEventListener('selectionchange', onMove);
    };
    // anchor in deps: a NEW selection reuses the mounted pill — re-place on it.
  }, [place, listenTo, anchor.x, anchor.y]);

  return createPortal(
    <button
      ref={btnRef}
      className={`session-diff-ask-pill${pos?.below ? ' below' : ''}`}
      // First paint is hidden at the raw anchor so offsetWidth/Height are
      // measurable; place() then sets the real coords in the same layout pass.
      style={pos
        ? { left: pos.left, top: pos.top }
        : { left: anchor.x, top: anchor.y, visibility: 'hidden' }}
      // preventDefault keeps the text selection alive; stopPropagation on
      // mouseup is CRITICAL — otherwise the mouseup bubbles (through the React
      // tree, portal or not) to the container's own mouseup handler, which
      // recomputes the now-collapsing selection and unmounts THIS pill before
      // click fires (so onCommit never runs).
      onMouseDown={(e) => { e.preventDefault(); }}
      onMouseUp={(e) => { e.stopPropagation(); }}
      onClick={onCommit}
    >
      Ask about this
    </button>,
    document.body,
  );
}
