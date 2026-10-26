/**
 * page-find — Cmd/Ctrl+F over what the page has already rendered (a session's
 * chat, or the whole page), plus the VS Code style "select a word, every exact
 * copy tints".
 *
 * Two rules shape everything here:
 *
 *  1. The page never moves on its own. Typing a query paints matches (CSS Custom
 *     Highlight API, no DOM writes, no layout change) and counts them; nothing
 *     scrolls, nothing expands. Only an explicit next/previous scrolls, and only
 *     as far as needed to bring that one match into view.
 *  2. Only text the reader could see counts. A match inside a folded card or a
 *     hidden tab (display:none, visibility:hidden, closed <details>) is not
 *     counted and never revealed; it joins the count the moment its fold opens.
 *     Rows the session has not loaded ("Load earlier") are not in the DOM at all.
 *
 * Cost model: walking every text node is the expensive part, so the walk is
 * cached and only redone after a DOM mutation (the owner's MutationObserver calls
 * `markDirty`). Re-typing the query re-scans the cached string, which is a plain
 * indexOf loop.
 */

import { liveRange, rangeViewPosition, revealRange, type OverflowCache } from './page-find-geometry';

export { liveRange } from './page-find-geometry';

export const HL_FIND = 'walnut-find';
export const HL_FIND_ACTIVE = 'walnut-find-active';
export const HL_PAGE_SELMATCH = 'walnut-page-selmatch';

/** Most matches counted for one query; past it the count reads "10000+". */
export const FIND_CAP = 10000;
const SELMATCH_CAP = 2000;
/** Up to this many matches every one is painted; past it, a window of
 *  2 x PAINT_HALF around the reader (see PageFindController.paint). */
const PAINT_ALL = 1500;
const PAINT_HALF = 600;

/** Never searched: the find bar itself, form fields, anything opted out. */
export const FIND_SKIP_SELECTOR = '.page-find, [data-find-skip]';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE']);
/** Tags that end a run of text. Text in two different blocks is joined with a
 *  newline, so "foo" at the end of one message and "bar" at the start of the
 *  next never match "foobar" (queries come from a one-line input, so a match
 *  can never contain that newline). */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'BUTTON', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
  'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT',
  'TH', 'THEAD', 'TR', 'UL', 'IMG', 'LABEL',
]);

export interface FindIndex {
  nodes: Text[];
  /** Offset of each node's text in `text` (separators included). */
  starts: number[];
  text: string;
  /** Lowercased `text`, built on first case-insensitive use. */
  folded?: string;
}

interface ElInfo { skip: boolean; block: Element; pre: boolean }

/** Walk `root`'s rendered text once. */
export function buildFindIndex(root: Element, skipSelector = FIND_SKIP_SELECTOR): FindIndex {
  const info = new Map<Element, ElInfo>();
  const rootParent = root.parentElement;
  // Per ELEMENT, not per text node: one parent chain step per element, cached,
  // instead of a closest() walk for each of tens of thousands of text nodes.
  const resolve = (el: Element): ElInfo => {
    const hit = info.get(el);
    if (hit) return hit;
    const parent = el === root ? null : el.parentElement;
    const up = parent && parent !== rootParent ? resolve(parent) : null;
    const editableRoot = el.getAttribute('contenteditable') !== null && (el as HTMLElement).isContentEditable;
    const skip = !!up?.skip || SKIP_TAGS.has(el.tagName) || editableRoot
      || (skipSelector ? el.matches(skipSelector) : false);
    const block = BLOCK_TAGS.has(el.tagName) || !up ? el : up.block;
    const out = { skip, block, pre: !!up?.pre || el.tagName === 'PRE' };
    info.set(el, out);
    return out;
  };
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  let len = 0;
  let prevBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.data) continue;
    const parent = t.parentElement;
    if (!parent) continue;
    const i = resolve(parent);
    if (i.skip) continue;
    if (prevBlock && i.block !== prevBlock) { parts.push('\n'); len += 1; }
    prevBlock = i.block;
    nodes.push(t);
    starts.push(len);
    // Outside <pre>, a newline in the source renders as a space (marked keeps
    // soft line breaks), so "one two" must match across one. Same length, so
    // offsets still map 1:1 onto the node.
    parts.push(i.pre ? t.data : t.data.replace(/[\n\r\t]/g, ' '));
    len += t.data.length;
  }
  return { nodes, starts, text: parts.join('') };
}

function locate(index: FindIndex, offset: number): { node: Text; off: number } {
  const { starts, nodes } = index;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { node: nodes[lo]!, off: offset - starts[lo]! };
}

/** Can the reader see this element at all (not inside a fold or a hidden tab)? */
function makeVisibilityCheck(): (el: Element) => boolean {
  const cache = new Map<Element, boolean>();
  return (el) => {
    let v = cache.get(el);
    if (v !== undefined) return v;
    const e = el as Element & { checkVisibility?: (o?: object) => boolean };
    v = typeof e.checkVisibility === 'function'
      ? e.checkVisibility({ visibilityProperty: true })
      : el.getClientRects().length > 0;
    cache.set(el, v);
    return v;
  };
}

/**
 * Every visible match of `query` in a built index, in document order, as
 * StaticRanges: a live Range is tracked by the document and adjusted on every
 * DOM mutation, and two thousand of them under a streaming reply turn each
 * markdown re-render into that many updates. The owner re-derives these after a
 * mutation anyway; `liveRange` makes a live one when geometry is needed.
 * `capped` = more visible matches exist past `cap`.
 */
export function rangesForQuery(
  index: FindIndex, query: string, caseSensitive: boolean, cap = FIND_CAP,
): { ranges: StaticRange[]; capped: boolean } {
  if (!query || !index.nodes.length) return { ranges: [], capped: false };
  let hay: string;
  let needle: string;
  if (caseSensitive) { hay = index.text; needle = query; }
  else {
    // Fold the haystack once per index, not once per keystroke.
    index.folded ??= foldOnce(index.text);
    hay = index.folded;
    needle = foldOnce(query);
  }
  const visible = makeVisibilityCheck();
  const out: StaticRange[] = [];
  // The cap counts VISIBLE matches: hidden ones are skipped before they count.
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    const from = locate(index, at);
    const parent = from.node.parentElement;
    if (!parent || !visible(parent)) continue;
    if (out.length >= cap) return { ranges: out, capped: true };
    const to = locate(index, at + needle.length - 1);
    out.push(new StaticRange({
      startContainer: from.node, startOffset: from.off, endContainer: to.node, endOffset: to.off + 1,
    }));
  }
  return { ranges: out, capped: false };
}

/** Length-preserving lowercase (see dom-text-search's foldPreservingLength). */
function foldOnce(s: string): string {
  if (!/[^\x00-\x7F]/.test(s)) return s.toLowerCase();
  // Lowercasing only ever GROWS a string ('\u0130' -> two units), so an equal
  // length means every unit mapped 1:1: the common case for CJK text.
  const whole = s.toLowerCase();
  if (whole.length === s.length) return whole;
  let out = '';
  for (const ch of s) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
}

type HighlightCtor = new (...ranges: AbstractRange[]) => { priority: number };

/** Paint `ranges` under `name`; returns an undo that only removes this paint. */
export function paintRanges(name: string, ranges: AbstractRange[], priority = 0): () => void {
  const w = window as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: HighlightCtor };
  const registry = w.CSS?.highlights;
  if (!registry || typeof w.Highlight !== 'function') return () => {};
  if (!ranges.length) { registry.delete(name); return () => {}; }
  const h = new w.Highlight(...ranges);
  h.priority = priority;
  registry.set(name, h);
  return () => { if (registry.get(name) === h) registry.delete(name); };
}

function unpaint(name: string): void {
  (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights?.delete(name);
}

// ── Controller ──────────────────────────────────────────────────────────────

export interface FindStatus {
  count: number;
  /** 1-based active match; 0 = none chosen yet (the bar shows "?/N"). */
  index: number;
  capped: boolean;
}

export class PageFindController {
  private index: FindIndex | null = null;
  private ranges: StaticRange[] = [];
  private capped = false;
  private active = -1;
  private query = '';
  private caseSensitive = false;
  private paintedLo = 0;
  private paintedHi = 0;
  /** What HL_FIND holds now, so an unchanged recount repaints nothing. */
  private painted: StaticRange[] = [];

  constructor(
    readonly root: Element,
    private beforeScroll?: (el: Element) => void,
  ) {}

  /** The DOM changed: the next run re-walks it. */
  markDirty(): void { this.index = null; }

  /** New query: paint and count, never scroll, no match chosen. */
  setQuery(query: string, caseSensitive: boolean): FindStatus {
    if (query === this.query && caseSensitive === this.caseSensitive && this.index) return this.status();
    this.query = query;
    this.caseSensitive = caseSensitive;
    this.active = -1;
    this.recompute();
    this.paint();
    return this.status();
  }

  /**
   * The content changed under an open search (streaming, a fold opened). Same
   * query, so it keeps the chosen match by IDENTITY when its text node survived
   * (a row rendering above it shifts the number, not the match), else by number.
   */
  refresh(): FindStatus {
    if (!this.query) return this.status();
    const prev = this.active >= 0 ? this.ranges[this.active] : undefined;
    const prevNum = this.active;
    const prevCount = this.ranges.length;
    this.recompute();
    if (prev && this.ranges.length) {
      let found = -1;
      if (prev.startContainer.isConnected) {
        found = this.ranges.findIndex((r) => r.startContainer === prev.startContainer && r.startOffset === prev.startOffset);
      }
      if (found < 0 && prevCount) found = Math.min(prevNum, this.ranges.length - 1);
      this.active = found;
    } else {
      this.active = -1;
    }
    this.paint();
    return this.status();
  }

  /** Next/previous. The first press picks from where the reader is looking. */
  nav(dir: 1 | -1): FindStatus {
    if (!this.index) this.refresh();
    const n = this.ranges.length;
    if (!n) return this.status();
    if (this.active < 0) this.active = this.pickFromView(dir);
    else this.active = (this.active + dir + n) % n;
    this.paint();
    const r = this.ranges[this.active];
    if (r) revealRange(r, this.beforeScroll);
    return this.status();
  }

  close(): void {
    unpaint(HL_FIND);
    unpaint(HL_FIND_ACTIVE);
    this.painted = [];
    this.ranges = [];
    this.capped = false;
    this.active = -1;
    this.query = '';
    this.index = null;
  }

  status(): FindStatus {
    return { count: this.ranges.length, index: this.active + 1, capped: this.capped };
  }

  /** Re-derive the ranges; the caller fixes `active` and paints. */
  private recompute(): void {
    if (!this.query) { this.ranges = []; this.capped = false; return; }
    this.index ??= buildFindIndex(this.root);
    ({ ranges: this.ranges, capped: this.capped } = rangesForQuery(this.index, this.query, this.caseSensitive));
  }

  /**
   * A session chat keeps document order = vertical order, so "where is the
   * reader looking" is a binary search there (a dozen rect reads, not ten
   * thousand). The page as a whole has side-by-side columns, so it scans.
   */
  private get ordered(): boolean { return this.root !== this.root.ownerDocument.body; }

  /** First index for which `test` holds, assuming it is false then true. */
  private search(test: (i: number) => boolean): number {
    let lo = 0;
    let hi = this.ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (test(mid)) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Position against the scope's own viewport (ordered scopes only). */
  private rootPos(i: number, cache: OverflowCache): -1 | 0 | 1 {
    return rangeViewPosition(this.ranges[i]!, cache, this.root);
  }

  private pickFromView(dir: 1 | -1): number {
    const n = this.ranges.length;
    const cache: OverflowCache = new Map();
    const fullPos = (i: number) => rangeViewPosition(this.ranges[i]!, cache);
    if (this.ordered) {
      // Binary search against the chat's own viewport, then step over matches
      // in view of the chat but clipped by a box inside it (a scrolled tool
      // output), preferring one the reader can read without any scroll.
      if (dir === 1) {
        const i = this.search((k) => this.rootPos(k, cache) !== -1);
        for (let j = i; j < n && j < i + 50 && this.rootPos(j, cache) === 0; j++) if (fullPos(j) === 0) return j;
        return i < n ? i : 0;
      }
      const i = this.search((k) => this.rootPos(k, cache) === 1) - 1;
      for (let j = i; j >= 0 && j > i - 50 && this.rootPos(j, cache) === 0; j--) if (fullPos(j) === 0) return j;
      return i >= 0 ? i : n - 1;
    }
    // In view first (no scroll at all), else the nearest one past the view in
    // the pressed direction, else wrap.
    let fallback = -1;
    for (let k = 0; k < n; k++) {
      const i = dir === 1 ? k : n - 1 - k;
      const p = fullPos(i);
      if (p === 0) return i;
      if (fallback < 0 && p === dir) fallback = i;
    }
    return fallback >= 0 ? fallback : (dir === 1 ? 0 : n - 1);
  }

  /**
   * Paint. Past PAINT_ALL matches only the ones around the reader are painted
   * (Chromium re-derives every highlight's markers whenever any highlight
   * changes, so ten thousand painted ranges made each next/previous cost
   * 100ms+); `onScroll` moves that window. The count still covers all of them.
   */
  private paint(around?: { lo: number; hi: number }): void {
    const n = this.ranges.length;
    let slice: StaticRange[] = this.ranges;
    if (n > PAINT_ALL) {
      if (this.ordered) {
        let lo: number;
        let hi: number;
        if (around) ({ lo, hi } = around);
        else if (this.active >= 0) { lo = this.active; hi = this.active + 1; }
        else {
          const cache: OverflowCache = new Map();
          lo = this.search((k) => this.rootPos(k, cache) !== -1);
          hi = this.search((k) => this.rootPos(k, cache) === 1);
        }
        const half = Math.max(PAINT_HALF, hi - lo);
        const mid = (lo + hi) >> 1;
        this.paintedLo = Math.max(0, Math.min(mid - half, n - 2 * half));
        this.paintedHi = Math.min(n, this.paintedLo + 2 * half);
        slice = this.ranges.slice(this.paintedLo, this.paintedHi);
      } else {
        // Side-by-side columns have no order to search: keep what is within a
        // screen of the window (one rect read per match, on a debounce).
        const h = window.innerHeight;
        const near = this.ranges.filter((r) => {
          const live = liveRange(r);
          if (!live) return false;
          const b = live.getBoundingClientRect();
          return b.bottom > -h && b.top < 2 * h;
        });
        slice = near.length > 2 * PAINT_ALL ? near.slice(0, 2 * PAINT_ALL) : near;
      }
    } else {
      this.paintedLo = 0;
      this.paintedHi = n;
    }
    if (!sameRanges(slice, this.painted)) {
      paintRanges(HL_FIND, slice, 1);
      this.painted = slice;
    }
    const a = this.active >= 0 ? this.ranges[this.active] : undefined;
    paintRanges(HL_FIND_ACTIVE, a ? [a] : [], 2);
  }

  /** The reader scrolled (debounced by the owner): move the painted window. */
  onScroll(): void {
    const n = this.ranges.length;
    if (n <= PAINT_ALL) return;
    if (!this.ordered) { this.paint(); return; }
    const cache: OverflowCache = new Map();
    const lo = this.search((k) => this.rootPos(k, cache) !== -1);
    const hi = this.search((k) => this.rootPos(k, cache) === 1);
    const margin = PAINT_HALF / 3;
    const nearLo = lo - margin < this.paintedLo && this.paintedLo > 0;
    const nearHi = hi + margin > this.paintedHi && this.paintedHi < n;
    if (nearLo || nearHi) this.paint({ lo, hi });
  }
}

function sameRanges(a: readonly AbstractRange[], b: readonly AbstractRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y && (x.startContainer !== y.startContainer || x.startOffset !== y.startOffset
      || x.endContainer !== y.endContainer || x.endOffset !== y.endOffset)) return false;
  }
  return true;
}

// ── Repaint after a DOM change ──────────────────────────────────────────────

/** Below this cost a repaint runs inside the MutationObserver callback itself. */
const SYNC_REPAINT_MS = 8;

/**
 * Run `fn` after a DOM change. A streaming reply re-renders its markdown on every
 * delta, which replaces the text nodes the paint pointed at, so a repaint that
 * waits shows that message unpainted between deltas (it read as "no highlights
 * while it streams"). So while `fn` is cheap it runs at once, in the observer's
 * microtask, before the next frame paints; once it costs more (a huge chat) it
 * runs at most every eight times its own cost, so it can never take over the
 * main thread.
 */
export function makeRepaintScheduler(fn: () => void): { kick(): void; cancel(): void } {
  let cost = 0;
  let last = 0;
  let timer = 0;
  const run = () => {
    timer = 0;
    const t = performance.now();
    fn();
    last = performance.now();
    cost = last - t;
  };
  return {
    kick() {
      if (timer) return;
      if (cost <= SYNC_REPAINT_MS) { run(); return; }
      const gap = Math.min(1000, cost * 8);
      timer = window.setTimeout(run, Math.max(0, last + gap - performance.now()));
    },
    cancel() { window.clearTimeout(timer); timer = 0; },
  };
}

// ── Selection matches ───────────────────────────────────────────────────────

/** The selected text worth echoing, or '' (too short, multi-line, in a field). */
export function selectionNeedle(sel: Selection | null): string {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const anchor = sel.anchorNode;
  const el = anchor instanceof Element ? anchor : anchor?.parentElement;
  // Fields and editors handle their own selection; a file view and the Changed
  // tab paint their own matches, so echoing them here would double the tint.
  if (!el || el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], .file-content-view, .session-diff-view, .page-find')) return '';
  const raw = sel.toString();
  const t = raw.trim();
  if (t.length < 2 || t.length > 200 || /[\r\n]/.test(t)) return '';
  return t;
}

/** Tint every exact (case-sensitive) visible copy of `needle` under `root`. */
export function paintSelectionMatches(index: FindIndex, needle: string): () => void {
  return paintRanges(HL_PAGE_SELMATCH, rangesForQuery(index, needle, true, SELMATCH_CAP).ranges, 0);
}
