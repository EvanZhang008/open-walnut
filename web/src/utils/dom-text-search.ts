/**
 * dom-text-search — find/highlight plain-text matches inside ANY rendered DOM
 * (markdown preview, WYSIWYG editor, read-only <pre>, same-origin HTML iframe).
 *
 * Highlighting uses the CSS Custom Highlight API (CSS.highlights + ::highlight),
 * which paints ranges WITHOUT touching the DOM — critical here because the
 * search roots are syntax-colored HTML (refractor spans) and a live TipTap
 * editor; wrapping matches in <mark> would corrupt both. Where the API is
 * unavailable the search still works (count + jump), just without paint.
 *
 * Matching is CROSS-NODE: the walker concatenates every text node under the
 * root and maps match offsets back to (node, offset) pairs, so a query that
 * spans token spans (e.g. `factory.HasSynced` split across refractor tokens)
 * still matches.
 */

/** Highlight registry names. Static because ::highlight(<name>) CSS rules
 *  cannot be parameterized — one search surface owns them at a time, which
 *  `claimSearchOwner` below enforces. */
export const HL_SEARCH = 'walnut-search';
export const HL_SEARCH_ACTIVE = 'walnut-search-active';
export const HL_SELMATCH = 'walnut-selmatch';

/**
 * Single-owner arbitration for those static names.
 *
 * `CSS.highlights` is a per-document GLOBAL registry, so two mounted viewers
 * (a session column plus the fullscreen overlay, or the "@" mention preview)
 * would overwrite and then delete each other's paint: search in B wipes A's
 * highlights while A's bar still claims "3/7". Opening a search claims
 * ownership and the previous owner is told to close its own bar.
 */
const SEARCH_OWNER_EVENT = 'walnut:file-search-claim';

export function claimSearchOwner(token: string): void {
  window.dispatchEvent(new CustomEvent(SEARCH_OWNER_EVENT, { detail: token }));
}

/** Call `onLost` when another surface claims the highlight registry. */
export function onSearchOwnerLost(token: string, onLost: () => void): () => void {
  const handler = (e: Event) => {
    if ((e as CustomEvent<string>).detail !== token) onLost();
  };
  window.addEventListener(SEARCH_OWNER_EVENT, handler);
  return () => window.removeEventListener(SEARCH_OWNER_EVENT, handler);
}

interface TextIndex {
  nodes: Text[];
  /** Cumulative start offset of each node's text in the concatenated string. */
  starts: number[];
  text: string;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA']);

function buildTextIndex(root: HTMLElement, skipSelector?: string): TextIndex {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const parent = n.parentElement;
      const tag = (parent?.tagName ?? '');
      if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
      // Chrome-content opt-out: a diff table's line-number gutters, unfold bars
      // and comment widgets are text nodes too — without this, searching "42"
      // matches every 42nd line number. (With SHOW_TEXT only text nodes reach
      // this filter, so REJECT behaves exactly like SKIP — no subtree pruning;
      // closest() runs per text node.)
      if (skipSelector && parent?.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  let len = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push(t);
    starts.push(len);
    parts.push(t.data);
    len += t.data.length;
  }
  return { nodes, starts, text: parts.join('') };
}

/**
 * Length-PRESERVING lowercase. Plain `toLowerCase()` is not: 'İ' becomes two
 * code units, which shifts every offset after it — and those offsets are mapped
 * back onto the ORIGINAL string, so highlights drift off the words (and the last
 * match's range can fall out of bounds). Fold per code unit and keep any
 * character whose lowercase isn't a single unit as-is.
 */
function foldPreservingLength(s: string): string {
  // Fast path: pure ASCII can't expand, and this is the overwhelming case.
  if (!/[^\x00-\x7F]/.test(s)) return s.toLowerCase();
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

/** Pure offset scan — exported for unit tests (no DOM needed). */
export function findMatchOffsets(
  hay: string, query: string, caseSensitive: boolean, cap = 5000,
): number[] {
  if (!query) return [];
  const h = caseSensitive ? hay : foldPreservingLength(hay);
  const q = caseSensitive ? query : foldPreservingLength(query);
  const out: number[] = [];
  let idx = 0;
  while (out.length < cap && (idx = h.indexOf(q, idx)) !== -1) {
    out.push(idx);
    idx += Math.max(1, q.length);
  }
  return out;
}

/** Map a global offset to (nodeIndex, localOffset) via binary search. */
function locate(index: TextIndex, offset: number): { node: Text; off: number } {
  const { starts, nodes } = index;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { node: nodes[lo], off: offset - starts[lo] };
}

/** Find every match of `query` under `root` as live DOM Ranges (cross-node). */
export function collectTextMatches(
  root: HTMLElement, query: string, caseSensitive: boolean, cap = 5000, skipSelector?: string,
): Range[] {
  const index = buildTextIndex(root, skipSelector);
  if (!index.nodes.length) return [];
  const offsets = findMatchOffsets(index.text, query, caseSensitive, cap);
  const doc = root.ownerDocument;
  const ranges: Range[] = [];
  for (const start of offsets) {
    const end = start + query.length;
    const from = locate(index, start);
    // end is exclusive; locate the char BEFORE it so a match ending exactly at
    // a node boundary anchors in that node, not the next one's offset 0.
    const to = locate(index, end - 1);
    const r = doc.createRange();
    try {
      r.setStart(from.node, from.off);
      r.setEnd(to.node, to.off + 1);
      ranges.push(r);
    } catch { /* node mutated under us — skip this match */ }
  }
  return ranges;
}

/** Register ranges under a highlight name in the given window's registry. */
export function applyHighlights(win: Window, name: string, ranges: Range[]): void {
  const cssAny = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  const HighlightCtor = (win as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!cssAny?.highlights || !HighlightCtor) return; // API unavailable — count/jump still work
  if (!ranges.length) { cssAny.highlights.delete(name); return; }
  cssAny.highlights.set(name, new HighlightCtor(...ranges));
}

export function clearHighlights(win: Window, name: string): void {
  const cssAny = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  cssAny?.highlights?.delete(name);
}

/** Inject the ::highlight paint rules into a foreign document (the HTML
 *  preview iframe). The main document gets the same rules from globals.css. */
export function ensureHighlightStyles(doc: Document): void {
  if (doc.querySelector('style[data-walnut-search-style]')) return;
  const style = doc.createElement('style');
  style.setAttribute('data-walnut-search-style', '1');
  style.textContent = [
    `::highlight(${HL_SEARCH}) { background-color: rgba(255, 200, 0, 0.35); }`,
    `::highlight(${HL_SEARCH_ACTIVE}) { background-color: rgba(255, 145, 0, 0.85); color: #1a1a1a; }`,
    `::highlight(${HL_SELMATCH}) { background-color: rgba(80, 160, 255, 0.30); }`,
  ].join('\n');
  (doc.head ?? doc.documentElement)?.appendChild(style);
}

/** The identifier charset for cmd+click symbol lookup. */
const WORD_CHAR = /[A-Za-z0-9_$]/;
export const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

/**
 * Resolve the identifier under a viewport point (cmd+click in read-only
 * views). Uses caretPositionFromPoint with the WebKit caretRangeFromPoint
 * fallback; expands to word boundaries inside the hit text node.
 */
export function wordAtPoint(
  doc: Document, x: number, y: number,
): { word: string; node: Text } | null {
  let node: Node | null = null;
  let offset = 0;
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof d.caretPositionFromPoint === 'function') {
    const pos = d.caretPositionFromPoint(x, y);
    if (pos) { node = pos.offsetNode; offset = pos.offset; }
  } else if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = (node as Text).data;
  if (!text) return null;
  let start = Math.min(offset, text.length - 1);
  if (!WORD_CHAR.test(text[start] ?? '')) {
    // The caret may land just AFTER the word (click near a glyph's right edge).
    if (start > 0 && WORD_CHAR.test(text[start - 1]!)) start -= 1;
    else return null;
  }
  let end = start + 1;
  while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start -= 1;
  while (end < text.length && WORD_CHAR.test(text[end]!)) end += 1;
  const word = text.slice(start, end);
  if (!SYMBOL_RE.test(word)) return null;
  return { word, node: node as Text };
}

/**
 * Imperative controller for one DOM search surface. Holds the match ranges and
 * the active index; `update`/`nav` return {count, index} for the search bar.
 * `scrollWindow` = the surface scrolls its own window (the HTML iframe), where
 * element.scrollIntoView would also yank every outer scroller.
 */
export class DomSearchController {
  private ranges: Range[] = [];
  private active = -1;
  /** Last query/case this controller painted — lets an unrelated re-`update`
   *  (a save re-sets `data`, remounting nothing) keep the reader's position
   *  instead of snapping back to match 1. */
  private lastQuery = '';
  private lastCase = false;

  constructor(
    private root: HTMLElement,
    private win: Window,
    private scrollWindow = false,
    /** Chrome-content opt-out (diff gutters, unfold bars…) — see buildTextIndex. */
    private skipSelector?: string,
  ) {}

  update(query: string, caseSensitive: boolean): { count: number; index: number } {
    const sameQuery = query === this.lastQuery && caseSensitive === this.lastCase;
    const prevActive = this.active;
    this.clearPaint();
    this.ranges = query ? collectTextMatches(this.root, query, caseSensitive, 5000, this.skipSelector) : [];
    this.lastQuery = query;
    this.lastCase = caseSensitive;
    if (!this.ranges.length) this.active = -1;
    // Same-query refresh keeps the NUMERIC index: if a mutation revealed
    // matches before the active one, "3/7" now names a different occurrence —
    // inherent to index-based tracking, and preferable to yanking the view.
    else if (sameQuery && prevActive >= 0) this.active = Math.min(prevActive, this.ranges.length - 1);
    else this.active = 0;
    this.paint();
    // A recompute of the SAME query is a content refresh, not a navigation —
    // scrolling then would yank the reader away from where they were.
    if (this.active >= 0 && !sameQuery) this.scrollToActive();
    return { count: this.ranges.length, index: this.active + 1 };
  }

  nav(dir: 1 | -1): { count: number; index: number } {
    const n = this.ranges.length;
    if (!n) return { count: 0, index: 0 };
    this.active = (this.active + dir + n) % n;
    this.paint();
    this.scrollToActive();
    return { count: n, index: this.active + 1 };
  }

  close(): void {
    this.clearPaint();
    this.ranges = [];
    this.active = -1;
    this.lastQuery = '';
  }

  private paint(): void {
    applyHighlights(this.win, HL_SEARCH, this.ranges);
    applyHighlights(
      this.win, HL_SEARCH_ACTIVE,
      this.active >= 0 ? [this.ranges[this.active]!] : [],
    );
  }

  private clearPaint(): void {
    clearHighlights(this.win, HL_SEARCH);
    clearHighlights(this.win, HL_SEARCH_ACTIVE);
  }

  private scrollToActive(): void {
    const r = this.ranges[this.active];
    if (!r) return;
    if (this.scrollWindow) {
      const rect = r.getBoundingClientRect();
      this.win.scrollTo({ top: rect.top + this.win.scrollY - this.win.innerHeight / 2 });
      return;
    }
    (r.startContainer.parentElement ?? null)?.scrollIntoView({ block: 'center' });
  }
}
