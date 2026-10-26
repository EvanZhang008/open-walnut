/**
 * page-find-geometry — where a find match sits relative to what the reader can
 * see, and the one scroll that brings it into view (utils/page-find.ts).
 */

/** A live Range over a StaticRange (geometry, scrolling). Null when stale. */
export function liveRange(r: AbstractRange): Range | null {
  if (!r.startContainer.isConnected || !r.endContainer.isConnected) return null;
  try {
    const live = r.startContainer.ownerDocument!.createRange();
    live.setStart(r.startContainer, r.startOffset);
    live.setEnd(r.endContainer, r.endOffset);
    return live;
  } catch { return null; }
}

/** How an element treats overflow, per axis: whether it clips, and whether
 *  that axis scrolls (a hidden axis clips but must never be scrolled). */
interface Overflow { clips: boolean; x: boolean; y: boolean }
const NO_OVERFLOW: Overflow = { clips: false, x: false, y: false };

/** Per-operation cache: computed styles are read once per element per pass. */
export type OverflowCache = Map<Element, Overflow>;

function overflowOf(el: Element, cache: OverflowCache): Overflow {
  let v = cache.get(el);
  if (v === undefined) {
    const cs = getComputedStyle(el);
    const scrolls = (o: string) => o === 'auto' || o === 'scroll' || o === 'overlay';
    const x = scrolls(cs.overflowX);
    const y = scrolls(cs.overflowY);
    const clips = x || y || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    v = clips ? { clips, x, y } : NO_OVERFLOW;
    cache.set(el, v);
  }
  return v;
}

/** Clipping ancestors of a node, innermost first. */
function clipAncestors(node: Node, cache: OverflowCache): Element[] {
  const out: Element[] = [];
  for (let el = node.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (overflowOf(el, cache).clips) out.push(el);
  }
  return out;
}

interface Box { top: number; bottom: number; left: number; right: number }

function viewBox(node: Node, cache: OverflowCache): Box {
  const box: Box = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  for (const a of clipAncestors(node, cache)) {
    const r = a.getBoundingClientRect();
    box.top = Math.max(box.top, r.top);
    box.left = Math.max(box.left, r.left);
    box.bottom = Math.min(box.bottom, r.top + a.clientHeight);
    box.right = Math.min(box.right, r.left + a.clientWidth);
  }
  return box;
}

/** One element's visible box (its padding box, clipped to the window). */
function ownBox(el: Element): Box {
  const r = el.getBoundingClientRect();
  return {
    top: Math.max(0, r.top), left: Math.max(0, r.left),
    bottom: Math.min(window.innerHeight, r.top + el.clientHeight),
    right: Math.min(window.innerWidth, r.left + el.clientWidth),
  };
}

/**
 * -1 above the visible area (or cut by its top edge), 0 fully in it, 1 below it
 * (or cut by its bottom edge). A cut match needs a scroll to be read.
 * `within` = judge against that one scroller only, ignoring the clips inside it
 * (a scrolled bash output box): vertical order then follows document order,
 * which the controller's binary search relies on.
 */
export function rangeViewPosition(
  r: AbstractRange, cache: OverflowCache = new Map(), within?: Element,
): -1 | 0 | 1 {
  const live = liveRange(r);
  if (!live) return 1;
  const rect = live.getBoundingClientRect();
  const box = within ? ownBox(within) : viewBox(r.startContainer, cache);
  if (rect.top < box.top - 0.5) return -1;
  if (rect.bottom > box.bottom + 0.5) return 1;
  if (within) return 0;
  // Horizontally clipped (a wide code block scrolled sideways) counts as below:
  // it needs a scroll either way, and "below" keeps next-match moving forward.
  if (rect.right <= box.left || rect.left >= box.right) return 1;
  return 0;
}

/**
 * Bring one match into view, moving each scroller (innermost first) only when
 * the match is not fully inside it, and then to center it.
 * `beforeScroll` lets the owner announce the move to a scroller that tells
 * reader moves from its own (the session chat's follow-bottom logic).
 */
export function revealRange(sr: AbstractRange, beforeScroll?: (el: Element) => void): void {
  const r = liveRange(sr);
  if (!r) return;
  const cache: OverflowCache = new Map();
  // Only real scrollers move; an overflow:hidden box clips but is never scrolled
  // by the reader, and scrolling it from code would break its layout.
  for (const a of clipAncestors(r.startContainer, cache)) {
    const o = overflowOf(a, cache);
    if (!o.x && !o.y) continue;
    const rect = r.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const top = ar.top;
    const bottom = ar.top + a.clientHeight;
    const left = ar.left;
    const right = ar.left + a.clientWidth;
    let dy = 0;
    let dx = 0;
    if (rect.top < top || rect.bottom > bottom) {
      dy = (rect.top + rect.height / 2) - (top + a.clientHeight / 2);
    }
    if (rect.left < left || rect.right > right) {
      dx = (rect.left + rect.width / 2) - (left + a.clientWidth / 2);
    }
    if (!dx && !dy) continue;
    const canY = o.y && a.scrollHeight > a.clientHeight;
    const canX = o.x && a.scrollWidth > a.clientWidth;
    if (!(canY && dy) && !(canX && dx)) continue;
    beforeScroll?.(a);
    if (canY && dy) a.scrollTop += dy;
    if (canX && dx) a.scrollLeft += dx;
  }
  const rect = r.getBoundingClientRect();
  if (rect.top < 0 || rect.bottom > window.innerHeight) {
    window.scrollBy(0, rect.top + rect.height / 2 - window.innerHeight / 2);
  }
}
