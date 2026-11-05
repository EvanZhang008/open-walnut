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

import { nearestToOthers } from './find-near-words';
import { liveRange, rangeViewPosition, revealRange, type OverflowCache } from './page-find-geometry';

export { liveRange } from './page-find-geometry';

export const HL_FIND = 'walnut-find';
export const HL_FIND_ACTIVE = 'walnut-find-active';
export const HL_PAGE_SELMATCH = 'walnut-page-selmatch';
/** Box mode (BoxPaint): the matches it cannot box, painted the usual way. */
const HL_FIND_SOLID = 'walnut-find-solid';
const HL_FIND_ACTIVE_SOLID = 'walnut-find-solid-active';
/** Find matches paint above every question mark state (useThreadMarks, 2 to 7). */
const FIND_PRIORITY = 10;

/** Most matches counted for one query; past it the count reads "10000+". */
export const FIND_CAP = 10000;
/** Most copies the selected-word echo paints (utils/selection-echo.ts). */
export const SELMATCH_CAP = 2000;
/** Up to this many matches every one is painted; past it, a window of
 *  2 x PAINT_HALF around the reader (see PageFindController.paint). */
const PAINT_ALL = 1500;
const PAINT_HALF = 600;

/** Never searched: the find bar itself, form fields, anything opted out. */
export const FIND_SKIP_SELECTOR = '.page-find, [data-find-skip]';
/** A document the reader writes in (a note's editor): searched although it is
 *  editable. Every other editable (a composer, a title being renamed) is not. */
export const FIND_DOC_ATTR = 'data-find-doc';

/**
 * In a session chat, also never searched: the chat's own labels and controls
 * around the messages (times, copy buttons, fold toggles, a card's sender line,
 * dividers). The whole-session count (utils/session-find.ts) counts the words
 * of the transcript; a label counted on screen but not in the turns it has not
 * rendered would make the total mean two things, and move as turns render.
 * The rule: what a turn shows without the reader opening anything is exactly
 * what the server counts (src/core/sessions/session-find.ts findableText); what
 * the reader opens (a tool's output, a thinking block) is searched on top.
 * tests/e2e/browser/session-find-whole-cases.ts checks that every word left to
 * search on the page is a word of the transcript.
 */
export const SESSION_FIND_SKIP_SELECTOR = [
  FIND_SKIP_SELECTOR,
  '.session-msg-actions', '.session-show-earlier-btn', '.session-gap-divider', '.session-streaming-indicator',
  '.scroll-to-bottom-btn', '.tool-run-toggle', '.provenance-fold-from', '.provenance-details',
  '.provenance-chips', '.provenance-label', '.provenance-asked-label', '.provenance-quote-label',
  '.provenance-reply-request', '.session-msg-received-badge',
  // A tool call's header line is searched (its name and summary: the server
  // reads the same words, src/lib/tool-header-text.ts); its glyphs and buttons are not.
  '.chat-tool-block-icon', '.chat-tool-block-arrow', '.chat-tool-block-calling-dot',
  '.bash-tool-expand-btn', '.edit-diff-view-file', '.edit-diff-prefix', '.edit-diff-expand',
  // A plan card's own header ("Plan", its buttons); the plan below it is searched.
  '.session-plan-card-header',
  // A message this session sent is a tool call: its card's closed lines (the target,
  // the title Walnut's record may give, an error) are not the transcript's words; its
  // body, once the reader opens the card, is searched.
  '[data-envelope-kind="outbound"] > .op-card-to', '[data-envelope-kind="outbound"] > .op-card-main',
  '[data-envelope-kind="outbound"] > .provenance-status',
  '.session-msg-queued-actions',
  // A background task's chip: the tool call's own label, not words of the transcript.
  '.bg-tasks-chip',
].join(', ');

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

interface ElInfo { skip: boolean; block: Element; pre: boolean; doc: boolean }

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
    // A document's editor is the text the reader came to search (2026-11-04: a
    // note's own words were never found, because its editor is contenteditable).
    // The root may sit inside one too (the find searches that note alone).
    const doc = (up ? up.doc : !!el.closest(`[${FIND_DOC_ATTR}]`)) || el.hasAttribute(FIND_DOC_ATTR);
    const editableRoot = !doc && el.getAttribute('contenteditable') !== null && (el as HTMLElement).isContentEditable;
    const skip = !!up?.skip || SKIP_TAGS.has(el.tagName) || editableRoot
      || (skipSelector ? el.matches(skipSelector) : false);
    const block = BLOCK_TAGS.has(el.tagName) || !up ? el : up.block;
    const out = { skip, block, pre: !!up?.pre || el.tagName === 'PRE', doc };
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

/** `a` starts before `b` in the document. */
function rangeBefore(a: StaticRange, b: StaticRange): boolean {
  if (a.startContainer === b.startContainer) return a.startOffset < b.startOffset;
  return !!(a.startContainer.compareDocumentPosition(b.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export class PageFindController {
  readonly kind = 'dom' as const;
  private index: FindIndex | null = null;
  private ranges: StaticRange[] = [];
  private capped = false;
  private active = -1;
  /** The chosen number while the text is away (a recount found no match). */
  private lostNum = -1;
  private query = '';
  private caseSensitive = false;
  private paintedLo = 0;
  private paintedHi = 0;
  /** What HL_FIND holds now, so an unchanged recount repaints nothing. */
  private painted: StaticRange[] = [];
  /** What HL_FIND_ACTIVE holds now: re-registering the same match on every
   *  recount (a class toggled anywhere in the root) left WebKit painting it
   *  in the plain match colour, the chosen one no longer told apart. */
  private paintedActive: StaticRange | null = null;

  /** The element holding the active match where the engine paints no highlight. */
  private host: HTMLElement | null = null;

  /** WebKit, in a chat: the matches drawn as boxes behind the text (BoxPaint). */
  private boxes: BoxPaint | null = null;

  /** Draw matches as boxes behind the text (see BoxPaint), where the root allows it. */
  useBoxes(): void {
    if (this.boxes || !(this.root instanceof HTMLElement) || !this.ordered) return;
    this.boxes = new BoxPaint(this.root, () => this.drawBoxes());
  }

  /**
   * `view` = the box the reader sees the root through, when the root is not its
   * own scroller (a note's editor scrolls inside its pane).
   */
  constructor(
    readonly root: Element,
    private beforeScroll?: (el: Element) => void,
    private readonly view: Element = root,
    private skipSelector: string = FIND_SKIP_SELECTOR,
    /** What floats over the scope's top and bottom edges: a match under it is
     *  not one "the reader can already see" for the first next/previous. */
    private viewInset?: () => { top: number; bottom: number },
  ) {}

  /**
   * Search `query` and choose the match a Notes search hit came from: inside
   * `near` (the block it was found in), the one where `context` (the hit's own
   * text, which starts at the matched word) begins; else the first at or after
   * `near`. Then bring it into view. Used when another surface opens the bar
   * with a query (utils/find-doc.ts requestPageFind).
   */
  setQueryNear(query: string, caseSensitive: boolean, near: Node | null, context?: string, others?: string[]): FindStatus {
    this.setQuery(query, caseSensitive);
    const n = this.ranges.length;
    if (!n) return this.status();
    let pick = 0;
    if (near?.isConnected) {
      const i = this.ranges.findIndex((r) => near.contains(r.startContainer)
        || !!(near.compareDocumentPosition(r.startContainer) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (i >= 0) pick = i;
      // Several in that block: the k-th, k = the copies before the context.
      const inside = this.ranges.filter((r) => near.contains(r.startContainer)).length;
      if (i >= 0 && inside > 1 && context) pick = i + Math.min(inside - 1, copiesBefore(near, query, context, caseSensitive));
    }
    // The reader typed more words than the bar searches: the copy next to them.
    const beside = others?.length ? this.nearOthers(near, others, caseSensitive) : -1;
    if (beside >= 0) pick = beside;
    this.active = pick;
    this.paint();
    const r = this.ranges[pick];
    if (r) revealRange(r, this.beforeScroll);
    return this.status();
  }

  /** The match next to the other typed words: in the hit's block when they
   *  are there, else anywhere in the document; -1 when they are nowhere. */
  private nearOthers(near: Node | null, others: string[], caseSensitive: boolean): number {
    const has = (el: Node) => {
      const t = caseSensitive ? el.textContent ?? '' : (el.textContent ?? '').toLowerCase();
      return others.some((w) => t.includes(caseSensitive ? w : w.toLowerCase()));
    };
    const scope = near?.isConnected && has(near) && this.ranges.some((r) => near.contains(r.startContainer)) ? near : this.root;
    const cands: number[] = [];
    const offsets: number[] = [];
    const span = document.createRange();
    for (let i = 0; i < this.ranges.length && cands.length < 500; i++) {
      const r = this.ranges[i]!;
      if (!scope.contains(r.startContainer)) continue;
      try {
        span.setStart(scope, 0);
        span.setEnd(r.startContainer, r.startOffset);
      } catch { continue; }
      cands.push(i);
      offsets.push(span.toString().length);
    }
    const best = nearestToOthers(scope.textContent ?? '', offsets, others, caseSensitive);
    return best >= 0 ? cands[best]! : -1;
  }

  /** The DOM changed: the next run re-walks it. */
  markDirty(): void { this.index = null; }

  /**
   * Take off, now, every painted match whose text changed under it (a node gone,
   * or shorter than the match's end): a StaticRange does not follow edits.
   * Called from the owner's MutationObserver, which runs before the next frame
   * is painted; the recount comes later (throttled on a long chat), and until
   * then the engine would paint highlights past the end of their text.
   */
  dropStale(): void {
    const ok = rangeFits;
    const a = this.active >= 0 ? this.ranges[this.active] : undefined;
    if (this.painted.every(ok) && (!a || ok(a))) return;
    this.painted = this.painted.filter(ok);
    this.ranges = this.ranges.filter(ok);
    this.active = a && ok(a) ? this.ranges.indexOf(a) : -1;
    this.index = null;
    if (this.boxes) { this.paintedRanges = null; this.drawBoxes(); return; }
    paintRanges(HL_FIND, this.painted, FIND_PRIORITY);
    paintRanges(HL_FIND_ACTIVE, this.active >= 0 ? [this.ranges[this.active]!] : [], FIND_PRIORITY + 1);
  }

  /** New query: paint and count, never scroll, no match chosen. */
  setQuery(query: string, caseSensitive: boolean): FindStatus {
    if (query === this.query && caseSensitive === this.caseSensitive) {
      // Same query on a changed DOM (an edit not recounted yet): recount, and
      // keep the chosen match, so next/previous moves on from it.
      return this.index ? this.status() : this.refresh();
    }
    // Only Aa flipped: the chosen match stays chosen while it still matches,
    // else the next one after it does (what a browser's find does).
    const keep = query === this.query && this.active >= 0 ? this.ranges[this.active] : undefined;
    this.query = query;
    this.caseSensitive = caseSensitive;
    this.active = -1;
    this.lostNum = -1;
    this.recompute();
    if (keep && this.ranges.length) {
      const after = this.ranges.findIndex((r) => !rangeBefore(r, keep));
      this.active = after >= 0 ? after : this.ranges.length - 1;
    }
    this.paint();
    // Another match took its place (the chosen one stopped matching): show it,
    // as next/previous do (a no-op for a match already in view).
    const shown = keep && this.active >= 0 ? this.ranges[this.active] : undefined;
    if (shown) revealRange(shown, this.beforeScroll);
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
    } else if (this.ranges.length && this.lostNum >= 0) {
      // The text was away for a moment (an editor re-rendering its whole
      // document, a view toggling): the same number comes back chosen.
      this.active = Math.min(this.lostNum, this.ranges.length - 1);
      this.lostNum = -1;
    } else {
      if (prev) this.lostNum = prevNum;
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
    this.lostNum = -1;
    if (this.active < 0) this.active = this.pickFromView(dir);
    else this.active = (this.active + dir + n) % n;
    this.paint();
    const r = this.ranges[this.active];
    if (r) revealRange(r, this.beforeScroll);
    return this.status();
  }

  /** Choose the n-th match (1-based) and bring it into view. */
  selectIndex(n: number): FindStatus {
    if (!this.index) this.refresh();
    if (n < 1 || !this.ranges.length) return this.status();
    this.active = Math.min(n, this.ranges.length) - 1;
    this.paint();
    revealRange(this.ranges[this.active]!, this.beforeScroll);
    return this.status();
  }

  /** Bring the chosen match back into view if something scrolled it away. */
  revealActive(): void {
    const r = this.active >= 0 ? this.ranges[this.active] : undefined;
    if (r && rangeViewPosition(r) !== 0) revealRange(r, this.beforeScroll);
  }

  /** Make match `i` the active one and bring it into view (a row just rendered
   *  for a whole-session find, see utils/session-find.ts). */
  select(i: number): FindStatus {
    if (!this.index) this.refresh();
    if (i < 0 || i >= this.ranges.length) return this.status();
    this.lostNum = -1;
    this.active = i;
    this.paint();
    revealRange(this.ranges[i]!, this.beforeScroll);
    return this.status();
  }

  /** Make match `i` the active one where it is, without scrolling (the bar
   *  reopened on the match it was on). */
  mark(i: number): FindStatus {
    if (!this.index) this.refresh();
    if (i < 0 || i >= this.ranges.length) return this.status();
    this.lostNum = -1;
    this.active = i;
    this.paint();
    return this.status();
  }

  /** The active match lies elsewhere (in a row the page has not rendered). */
  clearActive(): FindStatus {
    if (this.active < 0) return this.status();
    this.lostNum = -1;
    this.active = -1;
    this.paint();
    return this.status();
  }

  /** Every match, in document order (read-only: the owner maps them to rows). */
  matchRanges(): readonly StaticRange[] {
    if (!this.index) this.refresh();
    return this.ranges;
  }

  /** Indices of the matches inside `el`, in order. */
  indicesWithin(el: Element): number[] {
    if (!this.index) this.refresh();
    const out: number[] = [];
    this.ranges.forEach((r, i) => { if (el.contains(r.startContainer)) out.push(i); });
    return out;
  }

  close(): void {
    unpaint(HL_FIND);
    unpaint(HL_FIND_ACTIVE);
    unpaint(HL_FIND_SOLID);
    unpaint(HL_FIND_ACTIVE_SOLID);
    this.boxes?.close();
    this.boxes = null;
    this.markHost(null);
    this.painted = [];
    this.paintedActive = null;
    this.ranges = [];
    this.capped = false;
    this.active = -1;
    this.lostNum = -1;
    this.query = '';
    this.index = null;
  }

  status(): FindStatus {
    return { count: this.ranges.length, index: this.active + 1, capped: this.capped };
  }

  /** Re-derive the ranges; the caller fixes `active` and paints. */
  private recompute(): void {
    if (!this.query) { this.ranges = []; this.capped = false; return; }
    this.index ??= buildFindIndex(this.root, this.skipSelector);
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
    return rangeViewPosition(this.ranges[i]!, cache, this.view, this.inset);
  }

  /** Read once per pick, not per rect test. */
  private inset: { top: number; bottom: number } | undefined;

  private pickFromView(dir: 1 | -1): number {
    if (this.ordered) {
      const i = this.fromView(dir);
      return i >= 0 ? i : (dir === 1 ? 0 : this.ranges.length - 1);
    }
    return this.pickFromPage(dir);
  }

  /**
   * The first match in view or past it in the pressed direction (ordered
   * scopes), -1 when there is none that way: a whole-session find then weighs
   * it against the rows the page does not show (PageFind.tsx).
   */
  fromView(dir: 1 | -1): number {
    if (!this.index) this.refresh();
    this.inset = this.viewInset?.();
    try { return this.fromViewIn(dir); } finally { this.inset = undefined; }
  }

  private fromViewIn(dir: 1 | -1): number {
    const n = this.ranges.length;
    const cache: OverflowCache = new Map();
    const fullPos = (i: number) => rangeViewPosition(this.ranges[i]!, cache);
    // Binary search against the chat's own viewport, then step over matches
    // in view of the chat but clipped by a box inside it (a scrolled tool
    // output), preferring one the reader can read without any scroll.
    if (dir === 1) {
      const i = this.search((k) => this.rootPos(k, cache) !== -1);
      for (let j = i; j < n && j < i + 50 && this.rootPos(j, cache) === 0; j++) if (fullPos(j) === 0) return j;
      return i < n ? i : -1;
    }
    const i = this.search((k) => this.rootPos(k, cache) === 1) - 1;
    for (let j = i; j >= 0 && j > i - 50 && this.rootPos(j, cache) === 0; j--) if (fullPos(j) === 0) return j;
    return i;
  }

  private pickFromPage(dir: 1 | -1): number {
    const n = this.ranges.length;
    const cache: OverflowCache = new Map();
    const fullPos = (i: number) => rangeViewPosition(this.ranges[i]!, cache);
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
    const a = this.active >= 0 ? this.ranges[this.active] : undefined;
    if (this.boxes) {
      this.painted = slice;
      this.drawBoxes();
    } else {
      if (!sameRanges(slice, this.painted)) {
        paintRanges(HL_FIND, slice, FIND_PRIORITY);
        this.painted = slice;
      }
      if (!a || !this.paintedActive || !sameRanges([a], [this.paintedActive])) {
        paintRanges(HL_FIND_ACTIVE, a ? [a] : [], FIND_PRIORITY + 1);
      }
    }
    this.paintedActive = a ?? null;
    this.markHost(a ? unpaintedHost(a.startContainer) : null);
  }

  /**
   * Box mode: boxes for what can be boxed, the solid paint for the rest. Each
   * match is under ONE pair of names, never both: a range painted under the
   * cleared `walnut-find` and the solid one at once made WebKit assert in its
   * text painting and kill the page (std::span<WebCore::MarkedText>::subspan,
   * Playwright's WebKit, 2026-11-05, the long session's first Enter).
   */
  private drawBoxes(): void {
    if (!this.boxes) return;
    const a = this.active >= 0 ? this.ranges[this.active] : undefined;
    const { boxed, solid } = this.boxes.draw(this.painted, a);
    const sig = `${this.painted.length}:${boxed.size}:${solid.length}:${a ? this.active : -1}:${a && boxed.has(a) ? 1 : 0}`;
    if (sig === this.paintSig && this.paintedRanges === this.painted) return;
    this.paintSig = sig;
    this.paintedRanges = this.painted;
    paintRanges(HL_FIND, this.painted.filter((r) => boxed.has(r)), FIND_PRIORITY);
    paintRanges(HL_FIND_ACTIVE, a && boxed.has(a) ? [a] : [], FIND_PRIORITY + 1);
    paintRanges(HL_FIND_SOLID, solid.filter((r) => r !== a), FIND_PRIORITY);
    paintRanges(HL_FIND_ACTIVE_SOLID, a && !boxed.has(a) ? [a] : [], FIND_PRIORITY + 1);
  }

  /** What box mode registered last (drawBoxes), so a redraw with the same split registers nothing. */
  private paintSig = '';
  private paintedRanges: readonly StaticRange[] | null = null;

  /** WebKit paints no highlight on some text (unpaintedHost): the active match's
   *  element gets an outline there instead, so the reader still sees where it is.
   *  A data attribute, not a class: the owner's MutationObserver recounts on a
   *  class change. */
  private markHost(el: HTMLElement | null): void {
    if (el === this.host) return;
    this.host?.removeAttribute('data-find-active-host');
    el?.setAttribute('data-find-active-host', '');
    this.host = el;
  }

  /** The reader scrolled (debounced by the owner): move the painted window. */
  onScroll(): void {
    // Boxes were left out far from the view (BoxPaint.draw): draw them where it is now.
    if (this.boxes?.leftOut) this.drawBoxes();
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

/** Copies of `query` in `block`'s text before where `context` starts there
 *  (both whitespace-collapsed; context shrunk from the right until it fits). */
function copiesBefore(block: Node, query: string, context: string, caseSensitive: boolean): number {
  const norm = (s: string) => {
    const t = s.replace(/\s+/g, ' ');
    return caseSensitive ? t : foldOnce(t);
  };
  const text = norm(block.textContent ?? '');
  const q = norm(query);
  let words = norm(context).trim().split(' ');
  let at = -1;
  while (words.length && at < 0) {
    const needle = words.join(' ');
    if (needle.length < q.length) break;
    at = text.indexOf(needle);
    words = words.slice(0, -1);
  }
  if (at < 0 || !q) return 0;
  let k = 0;
  for (let i = text.indexOf(q); i !== -1 && i < at; i = text.indexOf(q, i + q.length)) k++;
  return k;
}

/**
 * WebKit (the Mac app's engine) paints a ::highlight background on every line
 * of a paragraph after the first from the bottom of the line above (its
 * selection geometry): on wrapped text each match is a tall bar reaching up,
 * and a one-letter query turns into columns of yellow between the lines
 * (measured on Playwright's WebKit, 2026-11-05; Chromium paints the glyph box).
 * In a session chat the matches are drawn instead as boxes from the match's own
 * line rects, in a layer behind the text: the same shape on every line, in
 * every engine's sense of it. The ::highlight stays registered (the active
 * match's dark text, and tests read it) with its background cleared by
 * `[data-find-boxes]`.
 *
 * A box can only sit behind text with nothing painted between: a match inside
 * an element with its own background (the person's bubble, a code block), a
 * clipping scroller or a sticky header is painted the usual way.
 */
const BOX_LAYER_CLASS = 'find-box-layer';

export function prefersBoxPaint(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
}

/** A change BoxPaint made itself, which a find's MutationObserver must not recount on. */
export function isBoxPaintMutation(r: MutationRecord): boolean {
  const inLayer = (n: Node | null) => !!n && (n instanceof Element ? n : n.parentElement)?.closest(`.${BOX_LAYER_CLASS}`) != null;
  if (inLayer(r.target)) return true;
  if (r.type !== 'childList') return false;
  const nodes = [...r.addedNodes, ...r.removedNodes];
  return nodes.length > 0 && nodes.every((n) => n instanceof Element && n.classList.contains(BOX_LAYER_CLASS));
}

class BoxPaint {
  private layer: HTMLDivElement | null = null;
  private solidCache = new Map<Element, boolean>();
  private ro: ResizeObserver | null = null;
  private frame = 0;

  constructor(private root: HTMLElement, private redraw: () => void) {}

  /** Draw boxes for `ranges` (`active` in its own colour); says which were boxed. */
  draw(ranges: readonly StaticRange[], active: StaticRange | undefined): { boxed: Set<StaticRange>; solid: StaticRange[] } {
    const boxed = new Set<StaticRange>();
    const solid: StaticRange[] = [];
    const all = active && !ranges.includes(active) ? [...ranges, active] : ranges;
    if (!all.length) { this.clearBoxes(); return { boxed, solid }; }
    const layer = this.ensureLayer();
    this.solidCache.clear();
    const origin = layer.getBoundingClientRect();
    const view = this.root.getBoundingClientRect();
    const reach = Math.max(view.height, 400) * 2;
    const boxes: string[] = [];
    this.leftOut = false;
    for (const r of all) {
      const el = r.startContainer instanceof Element ? r.startContainer : r.startContainer.parentElement;
      if (!el || this.needsSolid(el)) { solid.push(r); continue; }
      const live = liveRange(r);
      if (!live) continue;
      boxed.add(r);
      for (const c of live.getClientRects()) {
        if (c.width < 0.5 || c.height < 0.5) continue;
        // Far outside the view: nothing to see, and the layer stays small.
        if (c.bottom < view.top - reach || c.top > view.bottom + reach) { this.leftOut = true; continue; }
        boxes.push(`${r === active ? 'a' : 'm'}:${Math.round(c.top - origin.top)}:${Math.round(c.left - origin.left)}:${Math.round(c.width)}:${Math.round(c.height)}`);
      }
    }
    // The same boxes as drawn: touch nothing (the chat watches its own DOM, and
    // a layer rewritten on every recount would feed that watch forever).
    const sig = boxes.join('|');
    if (sig !== this.drawn) {
      this.drawn = sig;
      const frag = document.createDocumentFragment();
      for (const b of boxes) {
        const [kind, top, left, width, height] = b.split(':');
        const d = document.createElement('div');
        d.className = kind === 'a' ? 'find-box find-box-active' : 'find-box';
        d.style.cssText = `top:${top}px;left:${left}px;width:${width}px;height:${height}px`;
        frag.appendChild(d);
      }
      layer.replaceChildren(frag);
    }
    this.watch();
    return { boxed, solid };
  }

  close(): void {
    window.cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.ro = null;
    this.layer?.remove();
    this.layer = null;
    this.root.removeAttribute('data-find-boxes');
  }

  private clearBoxes(): void {
    if (this.drawn) this.layer?.replaceChildren();
    this.drawn = '';
  }

  /** What the layer holds now (its boxes, as `draw` wrote them). */
  private drawn = '';
  /** The last draw left out boxes far from the view: a scroll there draws them. */
  leftOut = false;

  private ensureLayer(): HTMLDivElement {
    if (this.layer?.isConnected && this.layer.parentElement === this.root) return this.layer;
    const layer = document.createElement('div');
    layer.className = BOX_LAYER_CLASS;
    layer.setAttribute('aria-hidden', 'true');
    layer.setAttribute('data-find-skip', '');
    // A zero-height row at the top of the content: it scrolls with the text.
    // In a flex column its gap would push every row down; take it back.
    const cs = getComputedStyle(this.root);
    const gap = cs.display.includes('flex') || cs.display.includes('grid') ? parseFloat(cs.rowGap) || 0 : 0;
    if (gap) layer.style.marginBottom = `${-gap}px`;
    this.root.setAttribute('data-find-boxes', '');
    this.root.prepend(layer);
    this.layer = layer;
    return layer;
  }

  /** Text whose box would be hidden or misplaced behind something. */
  private needsSolid(el: Element): boolean {
    const chain: Element[] = [];
    let answer = false;
    for (let e: Element | null = el; e && e !== this.root; e = e.parentElement) {
      const known = this.solidCache.get(e);
      if (known !== undefined) { answer = known; break; }
      chain.push(e);
      const cs = getComputedStyle(e);
      if (opaque(cs.backgroundColor) || cs.backgroundImage !== 'none'
        || cs.overflowX !== 'visible' || cs.overflowY !== 'visible'
        || cs.position === 'sticky' || cs.position === 'fixed') { answer = true; break; }
    }
    for (const e of chain) this.solidCache.set(e, answer);
    return answer;
  }

  /** Rows that change size (an image loading, a card opening) move the text under the boxes. */
  private watch(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.ro ??= new ResizeObserver((entries) => {
      let moved = false;
      for (const e of entries) {
        const h = e.contentRect.height;
        // observe() reports every new row once: only a real change redraws.
        if (this.heights.get(e.target) !== h) {
          if (this.heights.has(e.target)) moved = true;
          this.heights.set(e.target, h);
        }
      }
      if (!moved) return;
      window.cancelAnimationFrame(this.frame);
      this.frame = window.requestAnimationFrame(() => this.redraw());
    });
    for (const child of this.root.children) {
      if (child === this.layer || this.observed.has(child)) continue;
      this.observed.add(child);
      this.ro.observe(child);
    }
  }

  private observed = new WeakSet<Element>();
  private heights = new WeakMap<Element, number>();
}

/** Both ends of `r` still inside their nodes (a StaticRange does not follow edits). */
export function rangeFits(r: AbstractRange): boolean {
  return fits(r.startContainer, r.startOffset) && fits(r.endContainer, r.endOffset);
}

/** A range boundary still inside its node. */
function fits(node: Node, offset: number): boolean {
  if (!node.isConnected) return false;
  const len = node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE ? (node as CharacterData).length : node.childNodes.length;
  return offset <= len;
}

function opaque(color: string): boolean {
  if (!color || color === 'transparent') return false;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return true;
  const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length < 4 || parseFloat(parts[3]!) > 0;
}

/**
 * The element of a text node WebKit draws no ::highlight on: text directly in a
 * <button> (wrapped in a span it paints) and text directly in a line-clamped
 * `display: -webkit-box` (the same). Measured on Playwright's WebKit, 2026-11-04.
 */
export function unpaintedHost(node: Node): HTMLElement | null {
  const el = node.parentElement;
  if (!el) return null;
  if (el.tagName === 'BUTTON') return el;
  return getComputedStyle(el).display === '-webkit-box' ? el : null;
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
export function selectionNeedle(sel: Selection | null, opts: { inDocs?: boolean } = {}): string {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const anchor = sel.anchorNode;
  const el = anchor instanceof Element ? anchor : anchor?.parentElement;
  // The find's seed: a selection in a note's editor is the reader's word too.
  if (opts.inDocs && el?.closest(`[${FIND_DOC_ATTR}]`) && !el.closest('input, textarea, .page-find')) {
    const t = sel.toString().trim();
    return t.length >= 2 && t.length <= 200 && !/[\r\n]/.test(t) ? t : '';
  }
  // Fields and editors handle their own selection; a file view and the Changed
  // tab paint their own matches, so echoing them here would double the tint.
  if (!el || el.closest('input, textarea, [contenteditable=""], [contenteditable="true"], .file-content-view, .session-diff-view, .page-find')) return '';
  const raw = sel.toString();
  const t = raw.trim();
  if (t.length < 2 || t.length > 200 || /[\r\n]/.test(t)) return '';
  return t;
}

