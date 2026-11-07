/**
 * find-doc — the page find (components/common/PageFind.tsx) over a DOCUMENT: a
 * note's editor, rendered or raw, wherever it is hosted.
 *
 * 2026-11-04, the user in the Mac app: "the search should search in the notes
 * not the whole page here it doesn't even find it". The find walked the whole
 * page and skipped every contenteditable, so a note's own words were never
 * found, and a Notes search hit opened with the bar counting the sidebar's
 * copies of the word ("?/5") while the note showed nothing.
 *
 * A surface marks its document with `data-find-doc` (FIND_DOC_ATTR); the value
 * "primary" makes it the page's document, searched even when the reader last
 * pressed outside it (the Notes sidebar, its tabs). `data-find-label` names it
 * in the bar. A `data-find-region` (the Notes chat column) is searched on its own
 * and keeps a press there away from the primary document.
 *
 * Two engines answer the same bar: the DOM walk of utils/page-find.ts for a
 * rendered document, and CodeMirror's own search (utils/cm-search.ts) for a raw
 * source view, whose off-screen lines are not in the DOM at all.
 */
import { EditorView } from '@codemirror/view';
import { cmActiveFrom, cmSelectSearchIndex, cmCloseSearch, cmNavSearch, cmSearchStatus, cmSelectSearchAt, cmUpdateSearch } from './cm-search';
import { nearestToOthers } from './find-near-words';
import { FIND_DOC_ATTR, PageFindController, type FindStatus } from './page-find';

export { FIND_DOC_ATTR } from './page-find';

/** What the bar drives, whichever engine searches. */
export interface FindEngine {
  readonly root: Element;
  /** Which engine: a doc's rendered and raw views swap it (engineKindFor). */
  readonly kind: 'dom' | 'cm';
  setQuery(query: string, caseSensitive: boolean): FindStatus;
  /** Search, then choose the match a hit came from: the one at `context`
   *  (the hit's own text) inside `near` (the block it was found in), or the
   *  one next to `others` (more words the reader typed). */
  setQueryNear(query: string, caseSensitive: boolean, near: Node | null, context?: string, others?: string[]): FindStatus;
  refresh(): FindStatus;
  nav(dir: 1 | -1): FindStatus;
  /** Choose the n-th match (1-based), scrolled into view. */
  selectIndex(n: number): FindStatus;
  /** Bring the chosen match back into view when it is not (no-op without one). */
  revealActive(): void;
  markDirty(): void;
  onScroll(): void;
  close(): void;
}

function visible(el: Element): boolean {
  const e = el as Element & { checkVisibility?: () => boolean };
  return typeof e.checkVisibility === 'function' ? e.checkVisibility() : el.getClientRects().length > 0;
}

/**
 * The outermost visible document around `from`: a note's panel rather than the
 * rendered editor inside it, so the bar lives on across a raw/rendered toggle
 * and a switch to another note (only the engine changes, engineKindFor).
 */
export function docAround(from: Element | null): Element | null {
  let found: Element | null = null;
  for (let el = from?.closest(`[${FIND_DOC_ATTR}]`) ?? null; el; el = el.parentElement?.closest(`[${FIND_DOC_ATTR}]`) ?? null) {
    if (visible(el)) found = el;
  }
  return found;
}

/** Is `el` a document the bar can search now (in the page and showing)? */
export function docShows(el: Element | null | undefined): el is Element {
  return !!el && el.isConnected && visible(el);
}

/** The page's own document (the note open on the Notes page), when it shows. */
export function primaryDoc(): Element | null {
  for (const el of Array.from(document.querySelectorAll(`[${FIND_DOC_ATTR}="primary"]`))) {
    if (visible(el)) return el;
  }
  return null;
}

/** A searched-on-its-own region around `from` (a chat column beside a note). */
export function regionAround(from: Element | null): Element | null {
  const el = from?.closest('[data-find-region]') ?? null;
  return el && visible(el) ? el : null;
}

/** What the bar calls the document. */
export function docLabel(doc: Element): string {
  return doc.closest('[data-find-label]')?.getAttribute('data-find-label') || 'Find in document';
}

/** The box the reader sees `el` through: its nearest scroller, itself included. */
export function scrollerOf(el: Element): Element {
  for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
    const o = getComputedStyle(a).overflowY;
    if ((o === 'auto' || o === 'scroll' || o === 'overlay') && a.clientHeight > 0) return a;
  }
  return el;
}

/** A visible CodeMirror view in `doc` (raw mode), when the rendered one hides. */
function cmViewIn(doc: Element): EditorView | null {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('.cm-editor'))) {
    if (!visible(el)) continue;
    const view = EditorView.findFromDOM(el);
    if (view) return view;
  }
  return null;
}

/** Lowercased, markdown marks dropped, whitespace collapsed, with a map from
 *  each kept character back to its offset in `s` (a hit's snippet is cleaned
 *  text; the raw view holds the markdown it came from). */
function plainWithMap(s: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    // A link's target is not in the text the snippet shows: `](url)` goes.
    if (ch === ']' && s[i + 1] === '(') {
      const close = s.indexOf(')', i + 2);
      if (close > 0) { i = close; continue; }
    }
    if ('*_#`>|[]'.includes(ch)) continue;
    if (/\s/.test(ch)) { space = text.length > 0; continue; }
    if (space) { text += ' '; at.push(i); space = false; }
    text += ch.toLowerCase();
    at.push(i);
  }
  return { text, at };
}

/** Where `context` starts in `doc` (raw markdown), shrinking it from the right
 *  a word at a time (a link's URL or a block's end can cut it), or -1. */
export function contextOffset(doc: string, context: string, minLen = 2): number {
  const hay = plainWithMap(doc);
  let words = plainWithMap(context).text.split(' ').filter(Boolean);
  while (words.length) {
    const needle = words.join(' ');
    if (needle.length < minLen) break;
    const i = hay.text.indexOf(needle);
    if (i >= 0) return hay.at[i]!;
    words = words.slice(0, -1);
  }
  return -1;
}

/** CodeMirror's search behind the page find's bar. */
class CmFindEngine implements FindEngine {
  readonly kind = 'cm' as const;
  private query = '';
  private caseSensitive = false;
  /** A match asked for before the view held its text (it mounts empty, then
   *  loads the note): chosen once the text is there. */
  private want = 0;
  constructor(readonly root: Element, private readonly view: EditorView) {}
  private get status(): FindStatus {
    try { return { ...cmSearchStatus(this.view), capped: false }; } catch { return { count: 0, index: 0, capped: false }; }
  }
  setQuery(query: string, caseSensitive: boolean): FindStatus {
    if (query === this.query && caseSensitive === this.caseSensitive) return this.status;
    // Only Aa flipped: keep the chosen match (or the next one after it).
    let keepAt = -1;
    try { if (query === this.query && cmSearchStatus(this.view).index > 0) keepAt = cmActiveFrom(this.view); } catch { /* gone */ }
    this.query = query;
    this.caseSensitive = caseSensitive;
    this.want = 0;
    // The page find's rule: typing paints and counts, nothing moves.
    try {
      cmUpdateSearch(this.view, query, caseSensitive, { pick: false });
      if (keepAt >= 0) cmSelectSearchAt(this.view, keepAt);
    } catch { /* the view is gone */ }
    return this.status;
  }
  setQueryNear(query: string, caseSensitive: boolean, _near: Node | null, context?: string, others?: string[]): FindStatus {
    this.setQuery(query, caseSensitive);
    const text = this.view.state.doc.toString();
    let at = context ? contextOffset(text, context, query.length) : -1;
    if (others?.length && query) {
      const hay = caseSensitive ? text : text.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      const hits: number[] = [];
      for (let i = hay.indexOf(needle); i !== -1 && hits.length < 2000; i = hay.indexOf(needle, i + needle.length)) hits.push(i);
      const best = nearestToOthers(text, hits, others, caseSensitive);
      if (best >= 0) at = hits[best]!;
    }
    try { cmSelectSearchAt(this.view, Math.max(0, at)); } catch { /* the view is gone */ }
    return this.status;
  }
  // The search field recounts on every edit itself; the bar re-reads it.
  refresh(): FindStatus {
    const s = this.status;
    if (this.want > 0 && s.count > 0 && s.index === 0) return this.selectIndex(this.want);
    return s;
  }
  nav(dir: 1 | -1): FindStatus {
    this.want = 0;
    try { cmNavSearch(this.view, dir); } catch { /* the view is gone */ }
    return this.status;
  }
  selectIndex(n: number): FindStatus {
    const count = this.status.count;
    this.want = count ? 0 : n;
    if (!count) return this.status;
    try { cmSelectSearchIndex(this.view, Math.min(n, count) - 1); } catch { /* the view is gone */ }
    return this.status;
  }
  revealActive(): void {
    try {
      const s = cmSearchStatus(this.view);
      if (s.index > 0) cmSelectSearchAt(this.view, cmActiveFrom(this.view));
    } catch { /* the view is gone */ }
  }
  markDirty(): void { /* CodeMirror keeps its own matches current */ }
  onScroll(): void { /* decorations paint whatever CodeMirror draws */ }
  close(): void {
    try { cmCloseSearch(this.view); } catch { /* the view is gone */ }
    this.query = '';
    this.want = 0;
  }
}

/** The engine a document needs now: CodeMirror while its raw view shows. */
export function engineKindFor(root: Element, kind: 'doc' | 'session' | 'region' | 'page'): 'dom' | 'cm' {
  return kind === 'doc' && cmViewIn(root) ? 'cm' : 'dom';
}

/** The engine for one scope: CodeMirror for a raw view, else the DOM walk. */
export function engineFor(
  root: Element, kind: 'doc' | 'session' | 'region' | 'page', beforeScroll: (el: Element) => void,
): FindEngine {
  if (kind === 'doc') {
    const cm = cmViewIn(root);
    if (cm) return new CmFindEngine(root, cm);
    return new PageFindController(root, beforeScroll, scrollerOf(root));
  }
  return new PageFindController(root, beforeScroll);
}

// ── Open the bar from elsewhere (a Notes search hit) ────────────────────────

export const PAGE_FIND_REQUEST = 'walnut:page-find-request';

export interface PageFindRequest {
  /** Tried in order: the first that occurs in the document is searched.
   *  None: close a bar that is open (the hit has nothing in the note). */
  queries: string[];
  /** The element the hit came from: the match at or after it is chosen. */
  near?: Element | null;
  /** The hit's own text (it starts at the matched word): picks the match
   *  inside `near`, or in a raw view the one at that text. */
  context?: string;
  /** The document to search (default: the one around `near`, else the primary). */
  doc?: Element | null;
}

/** Open the page find over a document with a query, a match chosen. */
export function requestPageFind(req: PageFindRequest): void {
  window.dispatchEvent(new CustomEvent<PageFindRequest>(PAGE_FIND_REQUEST, { detail: req }));
}
