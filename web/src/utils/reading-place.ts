/**
 * The reader's place in a file view survives every change of its width (2026-11-10 WebKit
 * review: widening the window from 1280 to 1600 with an Ask card open moved the document from
 * Section 62 to Section 74, and the card, its passage gone, docked over the file header).
 *
 * A wider or narrower text column rewraps every line above the reader, so the same scrollTop
 * shows another part of the file; WebKit has no CSS scroll anchoring to make up for it. The
 * keeper notes a point of the text the reader is looking at, and where it sits in the scroller,
 * on every scroll; when a width it watches changes (the window, a panel divider, a sheet, the
 * question gutter) it scrolls that point back to where it was, then notes it again.
 *
 * The point is the passage an open card is about while that passage is on screen (a layer
 * hands it over with setReadingAnchor), else the first line at the top of the scroller.
 * Only a width change moves the scroller: a change of height alone (text typed, an image
 * loaded) is the document changing, not its wrapping, and the reader is left where they are.
 */

/** A point of the text: its top in the viewport, null once it is gone from the page. */
export type ReadingPoint = () => number | null;

/** What a view scrolls and where its text column is. */
export interface ReadingSurface { scroller: HTMLElement; body: Element }

const anchors = new WeakMap<Element, ReadingPoint>();
const recapture = new WeakMap<Element, () => void>();

/** The passage the reader works on in this view (an open card's), or null to go back to the top line. */
export function setReadingAnchor(view: Element, point: ReadingPoint | null): void {
  if (point) anchors.set(view, point);
  else anchors.delete(view);
  recapture.get(view)?.();
}

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as CaretDoc;
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

/** What is at the top of the scroller: a character of the first line when one is there, else its block. */
export type TopCaret = { node: Text; offset: number } | { el: Element };

/** The first line at the top of the scroller (read by the width keeper and by utils/reading-line-dom.ts). */
export function topCaret(surface: ReadingSurface): TopCaret | null {
  const { scroller, body } = surface;
  const doc = body.ownerDocument;
  const box = scroller.getBoundingClientRect();
  const col = body.getBoundingClientRect();
  const top = Math.max(box.top, col.top);
  if (!(box.bottom > top)) return null;
  const left = Math.max(box.left, col.left);
  const right = Math.min(box.right, col.right);
  for (const dy of [6, 18, 36]) {
    const y = top + dy;
    if (y >= box.bottom) break;
    for (const x of [left + 48, left + 16, (left + right) / 2]) {
      if (x >= right) continue;
      const at = caretAt(doc, x, y);
      if (at && at.node.nodeType === 3 && body.contains(at.node)) return { node: at.node as Text, offset: at.offset };
      const el = doc.elementFromPoint(x, y);
      if (el && el !== body && body.contains(el)) return { el };
    }
  }
  return null;
}

/** The first line at the top of the scroller as a point: a character of it when one is there, else its block. */
export function topLinePoint(surface: ReadingSurface): ReadingPoint | null {
  const at = topCaret(surface);
  if (!at) return null;
  if ('el' in at) {
    const { el } = at;
    return () => (el.isConnected ? el.getBoundingClientRect().top : null);
  }
  const { node } = at;
  const range = surface.body.ownerDocument.createRange();
  const from = Math.min(at.offset, Math.max(0, node.length - 1));
  range.setStart(node, from);
  range.setEnd(node, Math.min(from + 1, node.length));
  return () => {
    if (!node.isConnected) return null;
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return r && (r.width || r.height) ? r.top : null;
  };
}

/** An element's content width: a padding change (the question gutter) rewraps it too. */
function columnWidth(el: Element): number {
  const cs = getComputedStyle(el);
  return Math.round(el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
}

/** The widths a rewrap follows: the view's, the scroller's and the text column's. */
function widthsOf(view: Element, s: ReadingSurface): string {
  return `${view.clientWidth}:${columnWidth(s.scroller)}:${columnWidth(s.body)}`;
}

/** How far the scroller must move for a point that was `was` px under its top to be there again. */
export function placeShift(was: number, now: number): number {
  const dy = now - was;
  return Math.abs(dy) > 1 ? dy : 0;
}

/**
 * Keep the reader's place in `view` across width changes. `find` names the surface on show
 * (null: none to keep, such as a frame or an editor that keeps its own place).
 */
export function keepReadingPlace(view: HTMLElement, find: () => ReadingSurface | null): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let saved: { scroller: HTMLElement; point: ReadingPoint | null; offset: number; widths: string } | null = null;
  // What the observer watches: the view and the current surface's scroller and column, nothing
  // older (a surface the view swapped out is let go).
  const observed = new Set<Element>([view]);
  let inObserver = false;
  let watchFrame = 0;
  let wanted: ReadingSurface | null = null;
  const ro = new ResizeObserver(() => {
    inObserver = true;
    try { restore(); } finally { inObserver = false; }
  });
  const keepOf = (s: ReadingSurface) => new Set<Element>([view, s.scroller, s.body]);
  const applyWatch = () => {
    watchFrame = 0;
    const s = wanted;
    if (!s) return;
    const keep = keepOf(s);
    for (const el of observed) if (!keep.has(el)) { observed.delete(el); ro.unobserve(el); }
    for (const el of keep) if (!observed.has(el)) { observed.add(el); ro.observe(el); }
  };
  const watch = (s: ReadingSurface) => {
    const keep = keepOf(s);
    if (keep.size === observed.size && [...keep].every((el) => observed.has(el))) return;
    wanted = s;
    // Never (un)observe inside the observer's own callback: a new observation there that is not
    // deeper than what it just delivered is left undelivered, and the browser reports a
    // "ResizeObserver loop completed with undelivered notifications" error.
    if (inObserver) { if (!watchFrame) watchFrame = requestAnimationFrame(applyWatch); return; }
    applyWatch();
  };
  const capture = () => {
    const s = find();
    if (!s) { saved = null; return; }
    watch(s);
    const scrollTop = s.scroller.getBoundingClientRect().top;
    const bottom = s.scroller.getBoundingClientRect().bottom;
    // The open card's passage while it is on screen; else the top line.
    const passage = anchors.get(view);
    const at = passage?.();
    let point: ReadingPoint | null = null;
    let top: number | null = null;
    if (passage && at != null && at >= scrollTop && at < bottom) { point = passage; top = at; } else {
      point = topLinePoint(s);
      top = point?.() ?? null;
    }
    saved = { scroller: s.scroller, point: top == null ? null : point, offset: top == null ? 0 : top - scrollTop, widths: widthsOf(view, s) };
  };
  const restore = () => {
    const s = find();
    if (!s || !saved || saved.scroller !== s.scroller || !saved.point) { capture(); return; }
    if (widthsOf(view, s) === saved.widths) { capture(); return; }
    const top = saved.point();
    if (top != null) {
      const dy = placeShift(saved.offset, top - s.scroller.getBoundingClientRect().top);
      if (dy) s.scroller.scrollTop += dy;
    }
    capture();
  };
  let raf = 0;
  const onScroll = (e: Event) => {
    const t = e.target;
    const ours = (!!saved && t === saved.scroller)
      || (typeof Node !== 'undefined' && t instanceof Node && (view.contains(t) || (t instanceof Element && t.contains(view))));
    if (!ours) return;
    // restore(), not capture(): in a frame that also changed the width (a divider drag), this
    // runs before the ResizeObserver, and a capture here would note the rewrapped place as the
    // reader's and leave the observer nothing to put back. At the same width it only notes.
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; restore(); });
  };
  ro.observe(view);
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  recapture.set(view, capture);
  capture();
  return () => {
    ro.disconnect();
    if (raf) cancelAnimationFrame(raf);
    if (watchFrame) cancelAnimationFrame(watchFrame);
    document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
    if (recapture.get(view) === capture) recapture.delete(view);
  };
}
