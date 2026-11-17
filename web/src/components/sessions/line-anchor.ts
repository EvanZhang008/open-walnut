/**
 * The first line a scroll box shows, held across a change of the box's size
 * (2026-11-15, the user, of the chat's reading split jumping between fullscreen
 * and normal: take the first line as the anchor, and let no zoom in or out move it).
 *
 * A timeline scrolls with overflow-anchor:none, so a box that changes width
 * (fullscreen on or off, the window, the panel's width, the split's divider, side
 * by side and back) kept its scrollTop in px while every row above rewrapped:
 * the text at the top was another passage after the change. reading-place.ts
 * keeps a place by ROW, which is a whole reply here, often a screen or more of
 * text; a row's share does not land on the same line once it rewraps.
 *
 * So the anchor is a character: the first character of the first line drawn
 * below the box's visible top edge, and how far that line's top sat from the
 * edge. After a resize, the box scrolls so the line holding that character sits
 * at the same distance from the edge again. A picture (or another replaced
 * element) at the top is its own anchor. The visible top edge is under the
 * session panel's glass header when the header floats over the box.
 */

export interface LineAnchor {
  /** The character's text node, or the replaced element at the top. */
  node: Node;
  /** Offset of the character in the text node (0 for an element). */
  offset: number;
  /** The line's top minus the box's visible top edge, px (<= 0 for a line cut by the edge). */
  dy: number;
  /** The timeline row holding a text anchor, and the character's offset in the row's
   *  text: a re-render that replaces the text node finds the same character again. */
  row?: string;
  rowOffset?: number;
}

/** The timeline's top-level row holding `node` (reading-place.ts topRows). */
function rowOf(node: Node, el: HTMLElement): HTMLElement | null {
  let row: HTMLElement | null = null;
  for (let p = node.parentElement; p && p !== el; p = p.parentElement) if (p.dataset.messageId) row = p;
  return row;
}

/** The text nodes of `root`, in order. */
function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

/** Name the character by its row and its offset in the row's text. */
function withRow(a: LineAnchor, el: HTMLElement): LineAnchor {
  if (a.node.nodeType !== Node.TEXT_NODE) return a;
  const row = rowOf(a.node, el);
  if (!row?.dataset.messageId) return a;
  let at = 0;
  for (const t of textNodes(row)) {
    if (t === a.node) return { ...a, row: row.dataset.messageId, rowOffset: at + a.offset };
    at += t.data.length;
  }
  return a;
}

/** A text anchor whose node a re-render replaced: the same character in its row, now. */
function relink(a: LineAnchor, el: HTMLElement): boolean {
  if (a.row === undefined || a.rowOffset === undefined) return false;
  const row = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(a.row)}"]`);
  if (!row) return false;
  let at = 0;
  for (const t of textNodes(row)) {
    if (a.rowOffset < at + t.data.length) { a.node = t; a.offset = a.rowOffset - at; return true; }
    at += t.data.length;
  }
  return false;
}

/** Replaced elements: no text inside, so they anchor themselves. */
const REPLACED = new Set(['IMG', 'svg', 'VIDEO', 'CANVAS', 'IFRAME']);

/**
 * The box's visible top on screen: its own top, or the bottom of the panel's
 * header where that header floats over it (the glass overlay, globals.css
 * "Session panel: header overlay").
 */
export function visibleTop(el: HTMLElement, box: DOMRect = el.getBoundingClientRect()): number {
  const header = el.closest('.session-panel')?.querySelector<HTMLElement>(':scope > .session-panel-header');
  if (!header) return box.top;
  const h = header.getBoundingClientRect();
  const overlaps = h.bottom > box.top && h.top < box.bottom && h.right > box.left && h.left < box.right;
  return overlaps ? Math.min(h.bottom, box.bottom) : box.top;
}

/** The top of one character's line box, or null when it is not drawn. */
function charTop(node: Text, offset: number): number | null {
  const len = node.data.length;
  if (len === 0) return null;
  const at = Math.min(Math.max(offset, 0), len - 1);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + 1);
  const rects = range.getClientRects();
  for (const r of Array.from(rects)) if (r.height > 0) return r.top;
  const b = range.getBoundingClientRect();
  return b.height > 0 ? b.top : null;
}

/** The anchor's top on screen now, or null when it is gone or not drawn. */
function anchorTop(a: LineAnchor, el: HTMLElement): number | null {
  if ((!a.node.isConnected || !el.contains(a.node)) && !relink(a, el)) return null;
  if (a.node.nodeType === Node.TEXT_NODE) return charTop(a.node as Text, a.offset);
  const r = (a.node as Element).getBoundingClientRect();
  return r.height > 0 ? r.top : null;
}

/** In `node`, the first character whose line ends below `edge` (its lines run top to bottom). */
function firstCharBelow(node: Text, edge: number): { offset: number; top: number } | null {
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  if (rects.length === 0 || rects[rects.length - 1].bottom <= edge) return null;
  if (rects[0].bottom > edge) {
    const top = charTop(node, 0);
    return top === null ? null : { offset: 0, top };
  }
  // The edge cuts this text node: binary search the first character on a line below it.
  let lo = 0;
  let hi = node.data.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    range.setStart(node, mid);
    range.setEnd(node, mid + 1);
    const r = Array.from(range.getClientRects()).find((x) => x.height > 0) ?? range.getBoundingClientRect();
    if (r.height > 0 && r.bottom > edge) hi = mid; else lo = mid + 1;
  }
  const top = charTop(node, lo);
  return top === null ? null : { offset: lo, top };
}

/** Read the box's top line, or null when the box is not laid out or shows no text. */
export function readLineAnchor(el: HTMLElement): LineAnchor | null {
  if (!el.isConnected || el.clientHeight === 0) return null;
  const box = el.getBoundingClientRect();
  const edge = visibleTop(el, box);
  let found: LineAnchor | null = null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      const r = (n as Element).getBoundingClientRect();
      // A box drawn wholly above the edge holds no line of the top: skip all of it.
      // (display:contents and inline wrappers measure 0 and are walked into.)
      if (r.height > 0 && r.bottom <= edge) return NodeFilter.FILTER_REJECT;
      if (r.height > 0 && r.top >= box.bottom) return NodeFilter.FILTER_REJECT;
      // A sticky or fixed box does not move with the scroll: no anchor for it.
      const pos = getComputedStyle(n as Element).position;
      if (pos === 'sticky' || pos === 'fixed') return NodeFilter.FILTER_REJECT;
      if (REPLACED.has((n as Element).tagName)) return r.height > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    },
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const hit = firstCharBelow(n as Text, edge);
      if (!hit) continue;
      if (hit.top >= box.bottom) return null;
      found = { node: n, offset: hit.offset, dy: hit.top - edge };
    } else {
      const r = (n as Element).getBoundingClientRect();
      found = { node: n, offset: 0, dy: r.top - edge };
    }
    break;
  }
  return found ? withRow(found, el) : null;
}

/** Scroll `el` so the anchor's line sits where it did; false when the anchor is not drawn any more. */
export function applyLineAnchor(el: HTMLElement, a: LineAnchor): boolean {
  const top = anchorTop(a, el);
  if (top === null) return false;
  const delta = (top - visibleTop(el)) - a.dy;
  if (Math.abs(delta) > 0.5) el.scrollTop += delta;
  return true;
}

/** How far the anchor's line is from where it was, px (null when it is not drawn), for tests and probes. */
export function lineAnchorDrift(el: HTMLElement, a: LineAnchor): number | null {
  const top = anchorTop(a, el);
  return top === null ? null : (top - visibleTop(el)) - a.dy;
}

/**
 * Whether a box that changed size still follows its end (useLineAnchor's resize).
 * `following` is what the last read saw, before the change: WebKit dispatches the
 * scroll of a shrink's clamp to the end before the ResizeObserver, and the follow
 * paths take that clamp for the reader arriving there, so a box that did not follow
 * keeps its line (`clamped`). A follow read before another writer took the box off
 * the end since is stale: that writer's place stands. The follow paths' own state
 * says so (`atBottom` false while the box is off its end and the resize did not
 * clamp it); a rewrap alone changes no scrollTop and fires no scroll, so it never
 * clears that state. Never judged by scrollTop: a kept place restored in a box that
 * just mounted (2026-11-16, WebKit) moves it, but a restore and then the question
 * page's landing put it at 349 and back to 0 before any read, the very scrollTop of
 * the stale read (2026-11-17, a reload in session-reading-place.spec.ts: question 1
 * went to its end when its box narrowed into the right page).
 */
export function followsAtResize(s: {
  /** The box followed its end at the last read. */
  following: boolean;
  /** The follow paths' state now. */
  atBottom: boolean;
  /** The resize only lowered scrollTop to the new maximum. */
  clamped: boolean;
  /** The box is more than 2px from its end now. */
  offEnd: boolean;
}): boolean {
  const leftEnd = s.following && !s.atBottom && !s.clamped && s.offEnd;
  return !leftEnd && (s.following || (s.atBottom && !s.clamped));
}
