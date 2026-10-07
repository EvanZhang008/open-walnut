/**
 * The line under a passage whose question is being answered: the mark's
 * underline turns into a light band sweeping along it (the "is working" scan of
 * the session's working indicator), until the answer ends.
 *
 * A CSS Custom Highlight cannot animate a gradient, so while a question is live
 * its highlight drops the underline (`thread-mark-live-*`) and these bars draw
 * it instead: one absolutely positioned element per line of the passage, placed
 * from the passage's TEXT fragments (a range's own rects include the boxes of
 * whole elements inside it, a table cell or a list item, which are not lines).
 * The bars live in a layer that either scrolls with the text (the timeline's
 * content, the HTML preview's own document) or is re-placed on scroll (the
 * Files tab's overlay), always measured against the layer's own box.
 */

export interface BoxLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LiveBar {
  /** Relative to the layer's box. */
  top: number;
  left: number;
  width: number;
}

/** The bar's thickness and how far it rises above the text's bottom edge (it
 *  sits where the mark's underline was: about 3px below the baseline). */
export const LIVE_BAR_HEIGHT = 2;
const LIVE_BAR_RISE = 1;
/** One sweep, the same pace as the working indicator. */
export const LIVE_SCAN_MS = 1600;
export const LIVE_LINE_CLASS = 'thread-live-line';
/** Fragments of one line closer than this are one bar (word runs split across
 *  inline elements); farther apart (two table cells) each gets its own. */
const JOIN_GAP = 6;

const overlap = (a: BoxLike, b: BoxLike) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

/**
 * Per-line bars from the passage's text fragments (viewport coordinates), in
 * the coordinates of a layer whose box starts at `origin`. Empty fragments go;
 * fragments sharing most of their height are one line; `clip` (viewport) drops
 * a bar outside it and trims one that crosses its sides.
 */
export function liveLineBars(rects: readonly BoxLike[], origin: { left: number; top: number }, clip?: BoxLike | null): LiveBar[] {
  const boxes = rects
    .filter((r) => r.right - r.left >= 1 && r.bottom - r.top >= 1)
    .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: BoxLike[][] = [];
  for (const b of boxes) {
    const line = lines.find((l) => l.some((o) => overlap(o, b) >= 0.5 * Math.min(o.bottom - o.top, b.bottom - b.top)));
    if (line) line.push(b); else lines.push([b]);
  }
  const out: LiveBar[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
    const segs: BoxLike[] = [];
    for (const b of line) {
      const last = segs[segs.length - 1];
      if (last && b.left - last.right <= JOIN_GAP) {
        last.right = Math.max(last.right, b.right);
        last.bottom = Math.max(last.bottom, b.bottom);
        last.top = Math.min(last.top, b.top);
      } else segs.push({ ...b });
    }
    for (const s of segs) {
      const y = s.bottom - LIVE_BAR_RISE;
      let left = s.left;
      let right = s.right;
      if (clip) {
        // The line's bottom edge (the bar's middle) must be in sight.
        if (s.bottom < clip.top || s.bottom > clip.bottom) continue;
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (right - left < 2) continue;
      out.push({ top: round(y - origin.top), left: round(left - origin.left), width: round(right - left) });
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The client rects of each text node's part inside `range`: line fragments only. */
export function textRectsOf(range: Range): DOMRect[] {
  const doc = range.startContainer.ownerDocument;
  if (!doc) return [];
  const out: DOMRect[] = [];
  const push = (node: Text, from: number, to: number) => {
    if (to <= from) return;
    const r = doc.createRange();
    r.setStart(node, from);
    r.setEnd(node, to);
    for (const b of Array.from(r.getClientRects())) out.push(b);
  };
  const root = range.commonAncestorContainer;
  if (root.nodeType === 3) {
    push(root as Text, range.startOffset, range.endOffset);
    return out;
  }
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const t = n as Text;
    push(t, n === range.startContainer ? range.startOffset : 0, n === range.endContainer ? range.endOffset : t.length);
  }
  return out;
}

/** Where the passage can be seen inside `within`: its clipping ancestors below it
 *  (anything that does not let overflow show: a table's sideways scroller, a
 *  rounded bubble) intersected. `within` itself is left out: the layer sits in
 *  it, so it clips the lines by itself, and a line it scrolls out of sight must
 *  stay drawn to come back with the text, not a frame later. */
export function overflowClipOf(range: Range, within: Element | null): BoxLike | null {
  const view = range.startContainer.ownerDocument?.defaultView;
  if (!view) return null;
  let clip: BoxLike | null = null;
  const start = range.commonAncestorContainer;
  for (let el: Element | null = start.nodeType === 1 ? start as Element : start.parentElement; el && el !== within; el = el.parentElement) {
    const cs = view.getComputedStyle(el);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
      const r = el.getBoundingClientRect();
      clip = clip
        ? { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) }
        : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
  }
  return clip;
}

/**
 * Draw `bars` into `layer` (which holds nothing else), reusing the bar elements
 * already there so a bar that only moved keeps its place in the sweep. A new bar
 * starts in phase with the document's clock, so every line sweeps together.
 */
export function paintLiveBars(layer: HTMLElement, bars: ReadonlyArray<LiveBar & { hue?: number }>): void {
  const doc = layer.ownerDocument;
  const kids = Array.from(layer.children) as HTMLElement[];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    let el = kids[i];
    if (!el) {
      el = doc.createElement('div');
      el.className = LIVE_LINE_CLASS;
      el.setAttribute('aria-hidden', 'true');
      const now = doc.defaultView?.performance.now() ?? 0;
      el.style.animationDelay = `${-Math.round(now % LIVE_SCAN_MS)}ms`;
      layer.appendChild(el);
    }
    setPx(el, 'top', b.top);
    setPx(el, 'left', b.left);
    setPx(el, 'width', b.width);
    const hue = b.hue === undefined ? '' : String(b.hue);
    if ((el.dataset.hue ?? '') !== hue) {
      if (hue) { el.dataset.hue = hue; el.style.setProperty('--live-hue', hue); }
      else { delete el.dataset.hue; el.style.removeProperty('--live-hue'); }
    }
  }
  for (let i = bars.length; i < kids.length; i++) kids[i].remove();
}

function setPx(el: HTMLElement, prop: 'top' | 'left' | 'width', v: number) {
  const s = `${v}px`;
  if (el.style[prop] !== s) el.style[prop] = s;
}
