/**
 * useHeldPassage — the quote pill's passage after the document selection is gone.
 *
 * Dictated text landing in the composer takes focus, which collapses the page's
 * selection, and used to take the pill with it. The composer now asks the pill to
 * HOLD first (`requestSelectionHold`): the pill keeps the passage it captured, this
 * hook keeps WHERE it is — a cloned Range, painted through the same CSS highlight
 * registry as quote pins — and keeps that answer true while the timeline changes
 * under it.
 *
 * Three things move a held passage, and each is covered here:
 *  · a body re-render (a streaming delta, the output-mode toggle) replaces the text
 *    nodes the Range was built over and leaves it collapsed on an element (see
 *    `rangeIsLive`). A MutationObserver on the timeline notices and the passage is
 *    re-located from the captured quote — the same repair `useQuotePinPaint` runs
 *    for pins, and for the same reason: without it the highlight goes dark and the
 *    pill floats where the words used to be, with no event to wake it;
 *  · a scroll, which the pill forwards here so the pill follows the words and lets
 *    go once they have left the scroller;
 *  · the composer growing or the window resizing, which arrive as the pill's own
 *    keyup/selectionchange evaluation calling `repair`.
 *
 * The held Range is also published (`heldQuoteRange`) so the timeline's scroll
 * guards treat it like a live selection: follow-bottom pauses and content growth
 * above the passage is compensated, exactly as they do for a selected passage.
 * Without that the app's own auto-scroll would carry the held words out of view and
 * the visibility rule below would then dismiss the pill for being out of view.
 * The streaming FREEZE is deliberately not extended to a held passage: the reply
 * should catch up while the user writes their question, and the repair above is
 * what keeps the pill on the passage through that.
 */
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { setHeldQuoteRange } from '@/utils/pin-highlights';
import { bodyForMsgId, rangeVisibleIn } from '@/utils/selection-quote';
import { rangeForQuote, rangeIsLive, type TextQuote } from '@/utils/text-quote-anchor';

/** Floor between two mutation-driven repairs — the pins' paint uses the same figure. */
const REPAIR_MIN_GAP_MS = 250;

export interface HeldPassage {
  /** Where the words are. Re-derived from the captured quote when stale. */
  range: Range;
  /** The gesture ran backwards (pill at the passage's START), so a re-anchor lands
   *  on the same end the hand let go at. */
  backward: boolean;
}

export interface HeldPoint { x: number; y: number }

/** The end of a Range the gesture finished at. */
export function rangePoint(range: Range, backward: boolean): HeldPoint | null {
  const rects = range.getClientRects();
  if (!rects.length) {
    const r = range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    return { x: Math.round(backward ? r.left : r.right), y: Math.round(r.top) };
  }
  const r = rects[backward ? 0 : rects.length - 1]!;
  return { x: Math.round(backward ? r.left : r.right), y: Math.round(r.top) };
}

/** Same four boundary points — the same selection, not a new one. */
export function sameBoundaries(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset
    && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

export interface HeldPassageApi {
  heldRef: RefObject<HeldPassage | null>;
  /** Start holding: a clone of the live range (the live one follows the selection
   *  into the textarea when focus moves), painted, observed. */
  hold: (live: Range, backward: boolean) => void;
  /** Stop holding: paint off, observer off. Does not touch the pill. */
  clearHold: () => void;
  /** Bring the pill back onto its words after anything moved them. Calls `onLost`
   *  when the passage cannot be found or has left the scroller. */
  repair: () => void;
}

export function useHeldPassage(opts: {
  containerRef: RefObject<HTMLElement | null>;
  /** The capture behind the pill, for re-locating a stale Range. */
  captureRef: RefObject<{ msgId?: string; quote: TextQuote } | null>;
  /** Move the pill to where the passage ends now. */
  reanchor: (point: HeldPoint) => void;
  /** The passage is gone: the pill is the caller's to take down. */
  onLost: () => void;
}): HeldPassageApi {
  const { containerRef, captureRef, reanchor, onLost } = opts;
  const heldRef = useRef<HeldPassage | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const pending = useRef<{ raf: number; timer: ReturnType<typeof setTimeout> | undefined; lastAt: number }>({
    raf: 0, timer: undefined, lastAt: 0,
  });

  const clearHold = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    cancelAnimationFrame(pending.current.raf);
    clearTimeout(pending.current.timer);
    pending.current = { raf: 0, timer: undefined, lastAt: 0 };
    if (!heldRef.current) return;
    heldRef.current = null;
    setHeldQuoteRange(null);
  }, []);

  const repair = useCallback(() => {
    const held = heldRef.current;
    const container = containerRef.current;
    if (!held || !container) return;
    let range = held.range;
    if (!rangeIsLive(range)) {
      const captured = captureRef.current;
      const body = captured?.msgId ? bodyForMsgId(container, captured.msgId) : null;
      const next = body && captured ? rangeForQuote(body, captured.quote) : null;
      if (!next) { clearHold(); onLost(); return; }
      held.range = range = next;
      setHeldQuoteRange(range);
    }
    if (!rangeVisibleIn(container, range)) { clearHold(); onLost(); return; }
    const point = rangePoint(range, held.backward);
    if (point) reanchor(point);
  }, [containerRef, captureRef, reanchor, onLost, clearHold]);

  const hold = useCallback((live: Range, backward: boolean) => {
    clearHold();
    const range = live.cloneRange();
    heldRef.current = { range, backward };
    setHeldQuoteRange(range);
    const container = containerRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    // Coalesced to a frame, and floored like the pins' paint (REPAIR_MIN_GAP_MS in
    // useQuotePinPaint): a body that re-renders continuously must not buy a body
    // re-index every frame, so past ~4 repairs a second the next one waits for the
    // gap to pass. A stale frame costs a blink of the paint, not the passage.
    const mo = new MutationObserver(() => {
      const p = pending.current;
      if (p.raf || p.timer) return;
      const wait = REPAIR_MIN_GAP_MS - (Date.now() - p.lastAt);
      const run = () => {
        p.raf = requestAnimationFrame(() => {
          p.raf = 0;
          p.lastAt = Date.now();
          repair();
        });
      };
      if (wait <= 0) run();
      else p.timer = setTimeout(() => { p.timer = undefined; run(); }, wait);
    });
    mo.observe(container, { childList: true, subtree: true, characterData: true });
    observer.current = mo;
  }, [containerRef, clearHold, repair]);

  // Unmount (session switch, timeline remount): a held paint must not outlive the
  // pill that owns it.
  useEffect(() => clearHold, [clearHold]);

  // One stable object: the pill's listener set depends on it and must not be torn
  // down and rebuilt per render.
  return useMemo(() => ({ heldRef, hold, clearHold, repair }), [hold, clearHold, repair]);
}
