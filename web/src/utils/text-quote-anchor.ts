/**
 * text-quote-anchor — address a PASSAGE inside a rendered message, the way the
 * W3C Web Annotation spec addresses one: by the text itself (`exact`) plus a
 * little context either side (`prefix`/`suffix`) to pick the right occurrence.
 *
 * Why not offsets or DOM paths: a session message is re-rendered constantly
 * (streaming deltas, the markdown⇄rich toggle, the windowed tail remounting older
 * rows), so every node path and every character offset is stale by the next
 * frame. The passage's own text is the only anchor that survives, which is
 * exactly the problem TextQuoteSelector was designed for.
 *
 * The interesting half — `locateQuote` — is PURE (string in, offsets out) so the
 * matching rules are unit-testable in node with no DOM: see
 * tests/web/text-quote-anchor.test.ts. The DOM half is a thin shell over the
 * shared text walker in `dom-text-search.ts` (one walker for the whole app; a
 * second one would drift from its skip rules).
 */
import { buildDomTextIndex } from './dom-text-search';

/** Chrome that lives INSIDE `.session-msg-content` but is not message text: the
 *  hover strip (copy/pin/rewind/time) and any control label. Skipping them keeps
 *  the index identical whether or not the row happens to be hovered. */
const SKIP_INSIDE_MESSAGE = '.session-msg-actions, button, select, textarea, input';

/** Context captured either side of the passage. 32 chars is enough to separate
 *  repeated phrases in a paragraph without bloating the session record. */
export const QUOTE_CONTEXT_CHARS = 32;
/** Server cap for `quote.exact` (session-lifecycle.ts). Enforced here too, so a
 *  huge selection degrades to its head instead of a 400. */
export const QUOTE_MAX_CHARS = 2000;

export interface TextQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** The line rows of a body that draws a file line by line (a code view, a diff):
 *  the index puts the file's line breaks between them, so a passage over several
 *  lines is quoted as the file has it (2026-11-06: a split diff quoted
 *  `package marina// registerResources ...`, joined, which is not in the file). */
export interface QuoteLines {
  /** The row (one file line) a text node is drawn in, or null outside any row. */
  rowOf: (t: Text) => Element | null;
  /** How many line breaks the file has from row `prev` to the later row `next`
   *  (two for a blank line between them); 0 when it cannot tell. */
  breaks: (prev: Element, next: Element) => number;
}

/** Chrome of a body's own that is not its text: a selector, optionally a test for
 *  single text nodes no selector can name (a diff's blank-line filler), and the
 *  body's line rows when it draws a file's lines (`lines`). */
export type QuoteSkip = string | { selector?: string; text?: (t: Text) => boolean; lines?: QuoteLines };

/** The message body's plain text plus the map back to its text nodes. */
export interface QuoteTextIndex {
  text: string;
  nodes: Array<{ node: Text; start: number }>;
}

/**
 * Index one message body. No separator is inserted between block elements: the
 * index is the raw concatenation of text nodes, which is all the anchor needs —
 * it is built the same way at pin time and at locate time. `skip` adds chrome of
 * the body's own that is not its text (a code view's line numbers, a diff's
 * gutters and removed lines); pass the same one at both times. A body that draws
 * a file line by line passes its rows (`skip.lines`): between two rows the index
 * holds the file's line breaks, so its text reads like the file.
 */
/** The most line breaks the index puts between two rows. */
const LINE_BREAKS_MAX = 50;

export function buildTextIndex(root: Element, skip?: QuoteSkip): QuoteTextIndex {
  const selector = typeof skip === 'string' ? skip : skip?.selector;
  const raw = buildDomTextIndex(
    root, selector ? `${SKIP_INSIDE_MESSAGE}, ${selector}` : SKIP_INSIDE_MESSAGE, typeof skip === 'object' ? skip.text : undefined,
  );
  const lines = typeof skip === 'object' ? skip.lines : undefined;
  if (!lines) {
    return {
      text: raw.text,
      nodes: raw.nodes.map((node, i) => ({ node, start: raw.starts[i] })),
    };
  }
  // The file's line breaks between rows: text the index adds, mapped to no node
  // (a passage's ends are never a break: quoteFromText trims whitespace).
  const parts: string[] = [];
  const nodes: QuoteTextIndex['nodes'] = [];
  let len = 0;
  let prevRow: Element | null = null;
  for (const node of raw.nodes) {
    const row = lines.rowOf(node);
    if (row && prevRow && row !== prevRow) {
      // Capped: rows far apart (a diff's unfold bar) are not one passage anyway,
      // and thousands of breaks would eat QUOTE_MAX_CHARS.
      const n = Math.min(LINE_BREAKS_MAX, Math.max(0, lines.breaks(prevRow, row)));
      if (n) { parts.push('\n'.repeat(n)); len += n; }
    }
    if (row) prevRow = row;
    nodes.push({ node, start: len });
    parts.push(node.data);
    len += node.data.length;
  }
  return { text: parts.join(''), nodes };
}

/** Global offset of a range boundary inside `index`. */
function boundaryOffset(index: QuoteTextIndex, container: Node, offset: number): number {
  for (const entry of index.nodes) {
    if (entry.node === container) return entry.start + Math.min(offset, entry.node.data.length);
  }
  // An ELEMENT boundary (triple-click, a selection that starts between two block
  // children) sits between child nodes, not inside a text node. The first indexed
  // text node at or after that point starts exactly there.
  const doc = container.ownerDocument;
  if (!doc) return 0;
  let probe: Range;
  try {
    probe = doc.createRange();
    probe.setStart(container, offset);
    probe.collapse(true);
  } catch {
    return 0;
  }
  for (const entry of index.nodes) {
    try {
      if (probe.comparePoint(entry.node, 0) >= 0) return entry.start;
    } catch { /* different root — keep looking */ }
  }
  return index.text.length;
}

/**
 * Build a quote selector from a live selection Range.
 *
 * Both ends are read through the INDEX, never from `selection.toString()`:
 * `toString` serializes layout (it inserts newlines for block boundaries and
 * collapses runs), so the string it returns does not exist in the index and the
 * pin would never locate itself again.
 */
export function quoteFromRange(index: QuoteTextIndex, range: Range): TextQuote | null {
  if (!index.nodes.length) return null;
  return quoteFromText(
    index.text,
    boundaryOffset(index, range.startContainer, range.startOffset),
    boundaryOffset(index, range.endContainer, range.endOffset),
  );
}

/** A quote selector over [start, end) of a plain text (a code editor's document). PURE. */
export function quoteFromText(text: string, start: number, end: number): TextQuote | null {
  if (end < start) [start, end] = [end, start];
  const index = { text };
  // A drag routinely over-selects the whitespace at either edge; trimming it here
  // keeps both the paint and the outline label tight.
  while (start < end && /\s/.test(index.text[start]!)) start++;
  while (end > start && /\s/.test(index.text[end - 1]!)) end--;
  if (end <= start) return null;
  if (end - start > QUOTE_MAX_CHARS) end = start + QUOTE_MAX_CHARS;
  const exact = index.text.slice(start, end);
  if (!exact.trim()) return null;
  const prefix = index.text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start);
  const suffix = index.text.slice(end, end + QUOTE_CONTEXT_CHARS);
  return {
    exact,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

function allOccurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    out.push(i);
    if (out.length > 500) break; // pathological repetition: the first 500 decide it
  }
  return out;
}

/** Length of the longest common ENDING of two strings. */
function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest common BEGINNING of two strings. */
function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Every whitespace character dropped, keeping the map back to the original
 *  string (map[j] = original index of kept char j). */
function stripWhitespace(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

/** Runs of whitespace → one space. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/**
 * How well the text around `at` agrees with the recorded context.
 *
 * Compared with whitespace COLLAPSED on both sides, and only over a window as
 * wide as the stored context can be. Byte-exact comparison looked right and was
 * useless in practice: a re-render that turns one space into two makes the very
 * first compared character differ, so every candidate scores ~1 and an ambiguous
 * passage silently resolves to the first occurrence instead of the pinned one.
 */
function contextScore(text: string, at: number, len: number, quote: TextQuote): number {
  // Named `span`, not `window`: shadowing the global in a browser module is a trap.
  const span = QUOTE_CONTEXT_CHARS * 4;
  const before = collapseWhitespace(text.slice(Math.max(0, at - span), at));
  const after = collapseWhitespace(text.slice(at + len, at + len + span));
  return commonSuffixLength(before, collapseWhitespace(quote.prefix ?? ''))
    + commonPrefixLength(after, collapseWhitespace(quote.suffix ?? ''));
}

function bestOccurrence(text: string, needle: string, quote: TextQuote): number | null {
  const hits = allOccurrences(text, needle);
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0]!;
  let best = hits[0]!;
  let bestScore = contextScore(text, best, needle.length, quote);
  for (let i = 1; i < hits.length; i++) {
    const score = contextScore(text, hits[i]!, needle.length, quote);
    if (score > bestScore) { best = hits[i]!; bestScore = score; }
  }
  return best;
}

/** Collapse runs of whitespace to one space, keeping the map back to the
 *  original string (map[j] = original index of normalized char j). */
function normalizeWhitespace(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let inRun = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (inRun) continue;
      inRun = true;
      out += ' ';
      map.push(i);
      continue;
    }
    inRun = false;
    out += ch;
    map.push(i);
  }
  return { text: out, map };
}

/**
 * Find the passage in `text`. PURE.
 *
 * Three passes, cheapest first:
 *  1. exact substring — the normal case;
 *  2. ambiguity resolved by the recorded prefix/suffix (the W3C selector's whole
 *     point: "the third `done` in this reply", not "some `done`");
 *  3. whitespace-normalised retry, mapped back to real offsets. This is what
 *     survives an MD⇄Rich re-render: the same sentence comes back with different
 *     line breaks and indentation, so byte-exact matching fails while the words
 *     are unchanged.
 *
 * `null` = the passage is not on screen any more (the message was edited, or
 * /compact rewrote it). The pin then simply has no paint; its outline row still
 * jumps to the message.
 */
export interface LocateOptions {
  /** A fourth pass, whitespace ignored altogether: a file's passage is quoted by
   *  views that index line and block breaks differently (a code view's line
   *  breaks, a rendered view's blocks joined, questions asked before 2026-11-06
   *  with lines joined), and it must be found in each of them. Off for messages:
   *  there `ab` should not find `a b`. */
  ignoreWhitespace?: boolean;
}

export function locateQuote(text: string, quote: TextQuote, opts?: LocateOptions): { start: number; end: number } | null {
  const exact = quote.exact ?? '';
  if (!exact.trim() || !text) return null;

  const direct = bestOccurrence(text, exact, quote);
  if (direct !== null) return { start: direct, end: direct + exact.length };

  const norm = normalizeWhitespace(text);
  const needle = collapseWhitespace(exact).trim();
  if (!needle) return null;
  // contextScore collapses whitespace itself, so the stored context goes in raw.
  const loose = bestOccurrence(norm.text, needle, { ...quote, exact: needle });
  if (loose === null) return opts?.ignoreWhitespace ? locateIgnoringWhitespace(text, quote) : null;
  const start = norm.map[loose];
  const lastChar = norm.map[loose + needle.length - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start, end: lastChar + 1 };
}

/** The shortest passage (whitespace dropped) the whitespace-blind pass looks for. */
const LOOSE_MIN_CHARS = 8;

function locateIgnoringWhitespace(text: string, quote: TextQuote): { start: number; end: number } | null {
  const bare = stripWhitespace(text);
  const needle = stripWhitespace(quote.exact).text;
  // A short one would find the end of one word and the start of the next.
  if (needle.length < LOOSE_MIN_CHARS) return null;
  const at = bestOccurrence(bare.text, needle, {
    exact: needle,
    ...(quote.prefix ? { prefix: stripWhitespace(quote.prefix).text } : {}),
    ...(quote.suffix ? { suffix: stripWhitespace(quote.suffix).text } : {}),
  });
  if (at === null) return null;
  const start = bare.map[at];
  const lastChar = bare.map[at + needle.length - 1];
  if (start === undefined || lastChar === undefined) return null;
  return { start, end: lastChar + 1 };
}

/** Map a global offset to (text node, local offset) by binary search. */
function nodeAt(index: QuoteTextIndex, offset: number): { node: Text; off: number } | null {
  const { nodes } = index;
  if (!nodes.length) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (nodes[mid]!.start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const entry = nodes[lo]!;
  return { node: entry.node, off: Math.min(offset - entry.start, entry.node.data.length) };
}

/** A live Range over [start, end) of the index's text, or null if the DOM moved
 *  under us (the caller re-locates on the next pass). */
export function rangeFromOffsets(index: QuoteTextIndex, start: number, end: number): Range | null {
  if (!(end > start) || !index.nodes.length) return null;
  const from = nodeAt(index, start);
  // `end` is exclusive: anchor on the character BEFORE it so a passage ending at
  // a node boundary stays in that node instead of jumping to the next node's 0.
  const to = nodeAt(index, end - 1);
  if (!from || !to) return null;
  const doc = from.node.ownerDocument;
  if (!doc) return null;
  try {
    const range = doc.createRange();
    range.setStart(from.node, from.off);
    range.setEnd(to.node, Math.min(to.off + 1, to.node.data.length));
    return range;
  } catch {
    return null;
  }
}

/**
 * Does this Range still address its passage?
 *
 * When React re-renders a message body it REPLACES the text node a Range was built
 * over. A Range is live, so it does not break — the DOM spec moves its boundary
 * points up to the removed node's parent at the child index, which for a passage
 * inside one text node means start === end. The result is a COLLAPSED range whose
 * containers are elements: `startContainer.isConnected` is still true, but
 * `getClientRects()` is empty, so a highlight paints nothing and a hit test never
 * matches. Judge staleness by the boundary SHAPE, never by connectivity.
 * `rangeFromOffsets` always anchors on text nodes, so an element container means
 * the range has been re-pointed by a DOM removal.
 */
export function rangeIsLive(range: Range): boolean {
  return !range.collapsed
    && range.startContainer.isConnected
    && range.endContainer.isConnected
    && range.startContainer.nodeType === Node.TEXT_NODE
    && range.endContainer.nodeType === Node.TEXT_NODE;
}

/** The parts of `range` that are indexed text: a range from one diff line to
 *  another also spans the gutters (and removed lines) between them, which a
 *  paint of the whole range would color. */
export function rangePieces(index: QuoteTextIndex, range: Range): Range[] {
  const out: Range[] = [];
  for (const { node } of index.nodes) {
    if (!range.intersectsNode(node)) continue;
    const doc = node.ownerDocument;
    const r = doc.createRange();
    r.selectNodeContents(node);
    try {
      if (node === range.startContainer) r.setStart(node, range.startOffset);
      if (node === range.endContainer) r.setEnd(node, range.endOffset);
    } catch { continue; }
    if (!r.collapsed) out.push(r);
  }
  return out;
}

/** Locate a quote inside a message body in one call (index → locate → Range). */
export function rangeForQuote(body: Element, quote: TextQuote, skip?: QuoteSkip, opts?: LocateOptions): Range | null {
  const index = buildTextIndex(body, skip);
  const at = locateQuote(index.text, quote, opts);
  if (!at) return null;
  return rangeFromOffsets(index, at.start, at.end);
}
