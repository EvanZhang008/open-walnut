/**
 * Holds a timeline's top line across a change of its box's size (line-anchor.ts
 * has the why). Runs for every SessionChatHistory: the panel's own timeline, the
 * reading pane of the split, a Tree Mode page.
 *
 * Reads the anchor while nothing changes the box's size: after each scroll and
 * each change of the rows (once a frame at most), never in a frame whose layout
 * already has the new size (the box's size is checked against the last one seen).
 * When the box's size changes, the ResizeObserver callback (after layout, before
 * paint) puts the anchored line back, so no frame shows the moved text. A box that
 * follows the end goes to its end instead when its width changed (a rewrap); a
 * change of height alone stays with the follow paths that own it (SessionChatHistory
 * Path B-2). While it follows, no anchor is read at all (nothing would use it).
 *
 * The same character stays the anchor while its line has not moved: a fresh read
 * after a resize would take the first character of the line in the NEW width, which
 * in the old width sits a line higher, so each fullscreen round crept one line up
 * (2026-11-16, WebKit run).
 *
 * WebKit can revert a scrollTop written in the ResizeObserver phase at the frame's
 * commit (SessionChatHistory's shrink pin has the measurement), so the same anchor
 * is applied again for a few frames, unless another writer moved the box meanwhile
 * (the load's bottom pin, a jump): that writer's place stands.
 *
 * WebKit also dispatches the scroll event of the clamp a shrink of the rows causes
 * BEFORE the ResizeObserver callback, and the follow paths take that clamp to the
 * end as the reader arriving there (2026-11-16, side by side back to stacked: the
 * chat jumped to its end). So whether the box followed is the state before the
 * change, and a line put back off the end announces the reader's place
 * (READER_SCROLL_EVENT: the scroll handler records the leave, the load pin stops).
 *
 * A line the box cannot bring back to its place (a wider box made the rows below it
 * shorter than the box: the scroll stops at the end) stays the anchor: the next
 * resize (fullscreen off again) puts that line back, not the end the clamp left.
 * The reader's own input, or a new row, lets go of it.
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { applyLineAnchor, lineAnchorDrift, readLineAnchor, type LineAnchor } from './line-anchor';
import { READER_SCROLL_EVENT } from './phone-session-layer';

/** Frames the anchor is applied again after a resize (WebKit's revert). */
const CHASE_FRAMES = 4;
const INPUTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** A timeline row (or a block holding rows): not the arrow pill or a hover strip. */
function isRow(n: Node): boolean {
  return n instanceof HTMLElement && (n.matches('[data-message-id]') || !!n.querySelector('[data-message-id]'));
}

export interface UseLineAnchorArgs {
  containerRef: RefObject<HTMLDivElement | null>;
  /** The box follows the end of the conversation (never for the reading pane). */
  isAtBottom: MutableRefObject<boolean>;
  /** The box is shown: a hidden route reads nothing, and keeps its anchor for when it shows again. */
  shown: boolean;
  /** A text selection is open: no jump to the end under it. */
  selectionActive: () => boolean;
  /** The box's size changed and its line was put back here (reading-place lets go of its hold). */
  onResized?: () => void;
}

export function useLineAnchor({ containerRef, isAtBottom, shown, selectionActive, onResized }: UseLineAnchorArgs): void {
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let anchor: LineAnchor | null = null;
    /** An anchor the last resize could not bring back to its place (see the header). */
    let held: LineAnchor | null = null;
    /** The box followed the end at the last read (before any resize since). */
    let following = isAtBottom.current;
    /** scrollTop at the last read: another writer since (a jump to the end made in the
     *  same commit that resized the box) makes the anchor stale. */
    let topAtRead = el.scrollTop;
    let w = el.clientWidth;
    let h = el.clientHeight;
    let readRaf = 0;
    let chaseRaf = 0;
    let chasing = false;

    const offEnd = () => el.scrollHeight - el.clientHeight - el.scrollTop > 2;
    /** The anchor to keep: the same character while its line has not moved (see the header). */
    const fresh = (a: LineAnchor | null): LineAnchor | null => {
      if (a) {
        const drift = lineAnchorDrift(el, a);
        if (drift !== null && Math.abs(drift) <= 1) return a;
      }
      return readLineAnchor(el);
    };
    const read = () => {
      readRaf = 0;
      if (held || chasing || !shownRef.current || el.clientHeight === 0) return;
      if (el.clientWidth !== w || el.clientHeight !== h) return;
      topAtRead = el.scrollTop;
      following = isAtBottom.current;
      anchor = following ? null : fresh(anchor);
    };
    const readSoon = () => { if (!readRaf && !chasing && !held) readRaf = requestAnimationFrame(read); };

    const stopChase = () => {
      if (chaseRaf) cancelAnimationFrame(chaseRaf);
      chaseRaf = 0;
      chasing = false;
    };
    /**
     * Apply `step` now and on the next CHASE_FRAMES frames, unless another writer moves
     * the box meanwhile (a value that is neither what the last step left nor what was
     * there before it: WebKit's revert goes back to that). Then the anchor stays `a`
     * (held when its line could not be brought back), or is read afresh.
     */
    const chase = (step: () => void, a?: LineAnchor) => {
      stopChase();
      chasing = true;
      const before = el.scrollTop;
      step();
      let left = el.scrollTop;
      let frames = 0;
      const done = () => {
        chasing = false;
        const drift = a ? lineAnchorDrift(el, a) : null;
        held = a && drift !== null && Math.abs(drift) > 1 ? a : null;
        anchor = a && drift !== null ? a : (isAtBottom.current ? null : readLineAnchor(el));
        // A held line is a place mid-history, whatever the clamp's echo made of isAtBottom.
        following = held ? false : isAtBottom.current;
        topAtRead = el.scrollTop;
      };
      const tick = () => {
        chaseRaf = 0;
        if (el.clientWidth !== w || el.clientHeight !== h) { chasing = false; return; } // the next resize takes over
        const now = el.scrollTop;
        if (Math.abs(now - left) > 1 && Math.abs(now - before) > 1) { chasing = false; held = null; readSoon(); return; }
        step();
        left = el.scrollTop;
        if (++frames < CHASE_FRAMES) { chaseRaf = requestAnimationFrame(tick); return; }
        done();
      };
      chaseRaf = requestAnimationFrame(tick);
    };
    /** Put `a`'s line back. Left off the end while the follow paths think it follows
     *  (the clamp's echo): the reader's place is announced, so they let go properly. */
    const putBack = (a: LineAnchor) => {
      applyLineAnchor(el, a);
      if (isAtBottom.current && offEnd()) el.dispatchEvent(new Event(READER_SCROLL_EVENT));
    };
    // The reader's input is his: stop putting the old line back.
    const onInput = () => {
      const was = chasing || held;
      held = null;
      if (chasing) stopChase();
      if (was) readSoon();
    };

    const ro = new ResizeObserver(() => {
      const nw = el.clientWidth;
      const nh = el.clientHeight;
      if (nw === 0 || nh === 0) return; // hidden: keep the anchor for when it shows again
      if (nw === w && nh === h) return;
      const widthChanged = nw !== w;
      w = nw;
      h = nh;
      if (readRaf) { cancelAnimationFrame(readRaf); readRaf = 0; }
      const top = el.scrollTop;
      // The resize's own clamp to the end only lowers scrollTop to its new maximum.
      const clamped = top < topAtRead && top >= el.scrollHeight - el.clientHeight - 1;
      // Following: before the change, or since by a path that set it with no scroll (a
      // wheel down at the end, End), unless that is the clamp's echo.
      // A held line goes first: only the reader's input or a new row lets go of it.
      if (held) {
        const a = held;
        onResized?.();
        chase(() => putBack(a), a);
        return;
      }
      const follows = following || (isAtBottom.current && !clamped);
      if (follows) {
        if (widthChanged && !selectionActive()) chase(() => { el.scrollTop = el.scrollHeight; isAtBottom.current = true; });
        else readSoon(); // a height change alone: Path B-2 owns it
        return;
      }
      // Scrolled since the anchor was read, and not by the clamp: that writer's place stands.
      if (Math.abs(top - topAtRead) > 1 && !clamped && !chasing) { stopChase(); readSoon(); return; }
      const a = anchor;
      if (!a || lineAnchorDrift(el, a) === null) { stopChase(); readSoon(); return; }
      onResized?.();
      chase(() => putBack(a), a);
    });
    ro.observe(el);
    // Rows change (a stream, a row opening, older rows above): the anchor is read again.
    // A new row lets go of a kept line: the box shows what came since.
    const mo = new MutationObserver((records) => {
      if (held && records.some((r) => r.type === 'childList' && Array.from(r.addedNodes).some(isRow))) held = null;
      readSoon();
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'open', 'hidden'] });
    el.addEventListener('scroll', readSoon, { passive: true });
    // A picture loading moves the rows under it with no mutation (load does not bubble: capture).
    el.addEventListener('load', readSoon, true);
    for (const t of INPUTS) el.addEventListener(t, onInput, { passive: true });
    readSoon();
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', readSoon);
      el.removeEventListener('load', readSoon, true);
      for (const t of INPUTS) el.removeEventListener(t, onInput);
      if (readRaf) cancelAnimationFrame(readRaf);
      stopChase();
    };
  }, [containerRef, isAtBottom, selectionActive, onResized]);
}
