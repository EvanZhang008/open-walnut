/**
 * Block-stable streaming for assistant text that carries RAW HTML.
 *
 * Models may now write HTML in a reply and we render it natively, so a reply can
 * hold real interactive DOM: a CSS-only radio stepper, a `<details>`, a table
 * with checkboxes. Streaming used to destroy that state. Every delta re-set the
 * WHOLE message's innerHTML, so the radio the user just clicked reset ~20 times
 * a second and the widget was unusable while the model kept talking.
 *
 * The fix is to stop re-rendering what is already finished: split the text into
 * COMPLETED top-level chunks plus ONE growing tail. Finished chunks are handed to
 * React with the same html string every render, so React skips the innerHTML
 * write entirely and their DOM (and its state) is never touched again. Only the
 * tail churns.
 *
 * Three constraints shape this file:
 *
 * 1. THE PREFIX INVARIANT is the whole contract: for any text T and any prefix P
 *    of T, `splitRichChunks(P).stable` must be a prefix of `splitRichChunks(T).stable`.
 *    A frozen chunk that later changes is worse than no freezing at all — it
 *    resets the widget AND leaves React reconciling a moved boundary. So every
 *    boundary decision uses only COMPLETE lines, and anything a later delta could
 *    still flip resolves the conservative way: don't cut. Not cutting is always
 *    safe (the tail is allowed to grow and split later); cutting too early is not.
 * 2. Text is preserved exactly: `stable.map(c => c.text).join('') + tail.text === text`.
 *    Boundary blank lines belong to the PRECEDING chunk. A renderer that drops or
 *    duplicates a byte here shows the user a different answer than the model sent.
 * 3. It is deliberately dependency-free — same wall suggest-parse.ts describes:
 *    importing code-region helpers from '@/utils/markdown' would drag `marked` +
 *    `dompurify` into every consumer and into a test tier that cannot resolve
 *    them. The three helpers below (tagEnd / codeRanges / digest) are therefore
 *    duplicated from suggest-parse.ts rather than shared.
 *
 * Why chunking is SAFE for markdown: a boundary is only ever a blank line at HTML
 * depth 0 outside any code fence, which is exactly a top-level block boundary, so
 * each chunk parses to the same blocks it would have as part of the whole. The one
 * markdown construct that spans a blank line and would notice is a loose list, and
 * the list-continuity heuristic keeps those together.
 */

export type RichChunkKind = 'md' | 'html' | 'app';

export interface RichChunk {
  /**
   * How the chunk must be rendered:
   *  · `md`   — markdown only, no raw tags.
   *  · `html` — carries raw HTML, so it needs CSS containment around it.
   *  · `app`  — carries a `<script>` (or is a ```html-app fence): the sanitizer
   *             strips scripts, so this can only run inside a sandboxed island.
   */
  kind: RichChunkKind;
  text: string;
}

// ── Tag scanning ─────────────────────────────────────────────────────────────

/** HTML elements that never open a depth level. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text, not markup: a `</div>` in CSS/JS is a STRING. */
const RAWTEXT_TAGS = new Set(['style', 'script', 'textarea']);

/**
 * Rawtext elements whose body is a language where a blank line is only whitespace.
 * `<textarea>` is deliberately absent: a blank line there is CONTENT the user sees.
 */
const COLLAPSIBLE_RAWTEXT = new Set(['style', 'script']);

/**
 * Walnut's own inline pill syntax, NOT model HTML. renderMarkdownWithRefs
 * rewrites these into `<a>` before marked ever runs, so they never reach the
 * rendered output as tags. Counting them would be actively wrong: the
 * non-self-closing form (`<task-ref id="x">`) would pin depth above 0 and
 * disable chunking for the rest of the message, and a paragraph whose only
 * "HTML" is a task pill would be classified `html` and get CSS containment.
 * (They are absent from KNOWN_ELEMENTS too, so this check is belt-and-braces —
 * it is here to say WHY, not because the allowlist would let them through.)
 */
const REF_TAGS = new Set(['task-ref', 'session-ref']);

/**
 * Every element name that may affect structure — DOMPurify's default html + svg
 * + mathml sets, plus the few it strips but that still nest in the SOURCE
 * (`script`, `iframe`, document tags).
 *
 * The allowlist exists because `<` in prose is overwhelmingly NOT a tag.
 * `Array<T>`, `Vec<u8>`, `<string>` and a bare `<https://example.com/x>` autolink
 * all match "looks like a tag name", and the old counter treated each as an
 * element that opens a depth level and never closes — which pinned depth above 0
 * and silently disabled chunking for the whole rest of the message, so a widget
 * mentioned after an autolink never froze at all.
 */
const KNOWN_ELEMENTS = new Set([
  // html
  'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b',
  'base', 'bdi', 'bdo', 'big', 'blink', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'content',
  'data', 'datalist', 'dd', 'decorator', 'del', 'details', 'dfn', 'dialog',
  'dir', 'div', 'dl', 'dt', 'element', 'em', 'embed', 'fieldset', 'figcaption',
  'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input',
  'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark',
  'marquee', 'menu', 'menuitem', 'meta', 'meter', 'nav', 'nobr', 'noscript',
  'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre',
  'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section',
  'select', 'shadow', 'small', 'source', 'spacer', 'span', 'strike', 'strong',
  'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'tt',
  'u', 'ul', 'var', 'video', 'wbr',
  // svg (camelCase names lowercased — tag matching is case-insensitive)
  'svg', 'altglyph', 'altglyphdef', 'altglyphitem', 'animate', 'animatecolor',
  'animatemotion', 'animatetransform', 'circle', 'clippath', 'defs', 'desc',
  'ellipse', 'feblend', 'fecolormatrix', 'fegaussianblur', 'femerge',
  'femergenode', 'feoffset', 'filter', 'foreignobject', 'g', 'glyph',
  'glyphref', 'hkern', 'image', 'line', 'lineargradient', 'marker', 'mask',
  'metadata', 'mpath', 'path', 'pattern', 'polygon', 'polyline',
  'radialgradient', 'rect', 'set', 'stop', 'switch', 'symbol', 'text',
  'textpath', 'tref', 'tspan', 'use', 'view', 'vkern',
  // mathml
  'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mmultiscripts',
  'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace',
  'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext',
  'mtr', 'munder', 'munderover', 'semantics', 'annotation',
]);

/**
 * Block-level elements whose start tag implicitly ends an open `<p>`, per HTML5.
 * A model writing `<p>a` … `<p>b` inside a `<div>` is legal HTML that leaves the
 * div balanced; a scanner that nested the paragraphs would report depth 2 at the
 * `</div>` and then never come back to 0.
 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'ul', 'ol', 'li', 'table', 'section', 'article', 'blockquote',
  'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'details', 'figure', 'hr',
]);

const TAG_NAME_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/;

/** `<https://x>`, `<mailto:a@b>` — a markdown autolink, not an element. */
const AUTOLINK_SCHEME_RE = /^<\/?[a-z][a-z0-9+.-]*:/i;

/**
 * Is the `<…>` spanning `raw` real markup, or prose that only looks like a tag?
 *
 * Three prose shapes, each of which used to open a depth level that never closed:
 * a scheme autolink (`<https://example.com/x>`), an email in angle brackets
 * (`<user@host>` — no whitespace, so it cannot be a tag with attributes), and a
 * generic parameter (`Array<T>`, `<string>`), which the element allowlist rejects.
 */
function isMarkupTag(raw: string, name: string): boolean {
  if (REF_TAGS.has(name)) return false;
  if (AUTOLINK_SCHEME_RE.test(raw)) return false;
  if (!/\s/.test(raw) && raw.includes('@')) return false;
  return KNOWN_ELEMENTS.has(name);
}

/**
 * End index (exclusive) of the tag opened at `start`, quote-aware so a `>` inside
 * an attribute value (`<div data-x="a>b">`) cannot end the tag early. Returns -1
 * when the tag is still arriving.
 */
function tagEnd(text: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i + 1;
  }
  return -1;
}

/**
 * The `</name>` that ends the rawtext body starting at `from`, or null when the
 * closer has not arrived. Case-insensitive and tolerant of `</style >`, and it
 * cannot be fooled by markup-looking text in the body — inside rawtext the ONLY
 * thing that ends the element is its own closer, so a `</div>` in CSS is a string.
 */
function rawtextClose(text: string, from: number, name: string): { at: number; end: number } | null {
  const m = new RegExp(`</${name}\\s*>`, 'i').exec(text.slice(from));
  if (!m) return null;
  return { at: from + m.index, end: from + m.index + m[0].length };
}

// ── Code regions (a tag inside code is a SAMPLE, not markup) ─────────────────

/** Is `at` inside one of `sorted` (disjoint, ascending)? Binary, not linear. */
function inSortedRanges(sorted: [number, number][], count: number, at: number): boolean {
  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at < sorted[mid][0]) hi = mid - 1;
    else if (at >= sorted[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Ranges markdown renders as code. Fences are 3+ backticks/tildes closed only by
 * the same char at >= the same length, so a ````-wrapped ``` sample stays
 * protected end to end; an unclosed fence runs to EOF.
 *
 * Only COMPLETE lines matter for the prefix invariant, and this is where that
 * holds: an inline span cannot cross a newline, so once a line is newline-
 * terminated its code ranges are final. The only mutable region is the last,
 * still-growing line — which is always after every boundary we evaluate.
 */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let fence: { char: string; len: number; start: number } | null = null;
  let prevBlank = true;
  let pos = 0;
  for (const line of text.split('\n')) {
    const start = pos;
    const end = start + line.length;
    pos = end + 1; // consumed '\n'
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence.char && f[1].length >= fence.len) {
        ranges.push([fence.start, end]);
        fence = null;
      }
      continue;
    }
    if (f) { fence = { char: f[1][0], len: f[1].length, start }; prevBlank = false; continue; }
    if (prevBlank && /^ {4,}\S/.test(line)) ranges.push([start, end]);
    prevBlank = line.trim() === '';
  }
  if (fence) ranges.push([fence.start, text.length]);

  // Block ranges are pushed in ascending order and never overlap, so an inline
  // candidate is tested against them by BINARY search. The linear `.some()` this
  // replaced was O(inline spans × block ranges) and measured 53 ms per split on a
  // 50 KB inline-code-heavy reply — paid again on every streaming delta.
  const blocks = ranges.length;
  const inline = /`[^`\n]+`/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(text)) !== null) {
    const at = m.index;
    if (!inSortedRanges(ranges, blocks, at)) ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

/**
 * `index => is this offset inside a code region?`, answered in O(log n).
 *
 * Built once per split and then queried once per `<` — with a linear scan that
 * product is what dominated the split cost on a long reply.
 */
function makeSkip(text: string): (index: number) => boolean {
  const ranges = codeRanges(text).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return (index: number) => inSortedRanges(merged, merged.length, index);
}

/** djb2 — the same cheap digest suggest-parse uses; no new dependency. */
function digest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── Per-line HTML state ──────────────────────────────────────────────────────

interface LineSpan { start: number; end: number }

function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    spans.push({ start: pos, end: pos + line.length });
    pos += line.length + 1;
  }
  return spans;
}

/**
 * Element depth and "blocked" flag at the START of every line.
 *
 * Depth comes from a STACK of open element NAMES, not a counter. A counter
 * cannot tell `</div>` from `</p>`, so one stray closer (or one implicitly-ended
 * `<p>`) shifted every later depth by one and either froze a chunk mid-widget or
 * stopped freezing altogether. With names: a closer unwinds to its own element or
 * is ignored, and HTML5's implicit end tags are applied for the shapes a reply
 * actually writes.
 *
 * `blocked` means "a construct spans this line start" — inside a multi-line tag,
 * a comment, or a rawtext body — or the text ends inside an unfinished one. Those
 * lines can never be a chunk boundary, and marking them is what keeps the prefix
 * invariant across an arriving `<div class="…` : while the tag is incomplete no
 * boundary forms after it, and once its `>` lands the line is inside a tag, so
 * still no boundary. Same answer before and after — nothing to unfreeze.
 */
function scanHtmlState(
  text: string,
  lines: LineSpan[],
  skip: (index: number) => boolean,
): { depth: number[]; blocked: boolean[]; endDepth: number; truncated: boolean } {
  const depth = new Array<number>(lines.length).fill(0);
  const blocked = new Array<boolean>(lines.length).fill(false);
  const stack: string[] = [];
  let cursor = 0;

  /** Record state for every line starting at or before `pos`. */
  const assign = (pos: number, isBlocked: boolean): void => {
    while (cursor < lines.length && lines[cursor].start <= pos) {
      depth[cursor] = stack.length;
      blocked[cursor] = isBlocked;
      cursor++;
    }
  };
  /** An unfinished construct swallows the rest of the text. */
  const blockToEnd = () => {
    assign(text.length, true);
    return { depth, blocked, endDepth: stack.length, truncated: true };
  };
  const top = (): string | undefined => stack[stack.length - 1];
  /** `</name>` unwinds to the nearest matching open element, or is ignored. */
  const popTo = (name: string): void => {
    const at = stack.lastIndexOf(name);
    if (at >= 0) stack.length = at;
  };
  /** HTML5 implicit end tags, restricted to the shapes replies actually write. */
  const closeImplied = (name: string): void => {
    if (name === 'li') {
      if (top() === 'li') stack.pop();
    } else if (name === 'tr' || name === 'td' || name === 'th') {
      if (top() === 'p') stack.pop();
      while (top() === 'td' || top() === 'th' || (name === 'tr' && top() === 'tr')) stack.pop();
    }
    if (BLOCK_TAGS.has(name) && top() === 'p') stack.pop();
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    assign(lt, false); // state at a line that STARTS with this '<' is the pre-tag state
    if (skip(lt)) { i = lt + 1; continue; }

    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) return blockToEnd();
      assign(close + 2, true);
      i = close + 3;
      continue;
    }
    if (text[lt + 1] === '!') { // <!DOCTYPE …>
      const gt = text.indexOf('>', lt);
      if (gt < 0) return blockToEnd();
      assign(gt, true);
      i = gt + 1;
      continue;
    }

    const m = TAG_NAME_RE.exec(text.slice(lt, lt + 64));
    if (!m) { i = lt + 1; continue; } // a '<' that opens nothing is plain text
    const end = tagEnd(text, lt);
    if (end < 0) return blockToEnd();
    const raw = text.slice(lt, end);
    const name = m[2].toLowerCase();
    // Blocked BEFORE the markup question: a multi-line `<task-ref\n\nid=…/>` is
    // not an element, but a boundary inside it would still split the pill in half.
    assign(end - 1, true);
    i = end;
    // Prose that only LOOKS like a tag (autolink, `<user@host>`, `Array<T>`, a
    // walnut ref pill) has no structure: step over it without touching the stack.
    if (!isMarkupTag(raw, name)) continue;

    if (m[1] === '/') { popTo(name); continue; }
    closeImplied(name);
    if (VOID_TAGS.has(name) || /\/\s*>$/.test(raw)) continue;
    stack.push(name);

    if (RAWTEXT_TAGS.has(name)) {
      const close = rawtextClose(text, end, name);
      if (!close) return blockToEnd();
      assign(close.end - 1, true);
      popTo(name);
      i = close.end;
    }
  }
  assign(text.length, false);
  return { depth, blocked, endDepth: stack.length, truncated: false };
}

// ── Rawtext blank lines (CommonMark's raw-HTML block terminator) ─────────────

/**
 * A newline plus one or more blank (or whitespace-only) lines. The captured first
 * newline is kept, so CRLF stays CRLF and the indentation of the next real line is
 * preserved — the collapse must be invisible in the CSS/JS it touches.
 */
const BLANK_LINE_RUN_RE = /(\r?\n)(?:[ \t]*\r?\n)+/g;

/**
 * Delete blank lines INSIDE every `<style>` / `<script>` body.
 *
 * WHY this exists: CommonMark ends a raw-HTML block at the first blank line. A
 * model writing readable CSS puts one between its layout rules and its animation
 * section, and at that point marked stops passing the text through verbatim and
 * markdown-parses the REST of the stylesheet — the remaining rules come back
 * wrapped in `<p>`/`<br>` that land inside the element's RAWTEXT content, so the
 * `<style>` ends up holding markup instead of CSS and every rule after the blank
 * line is lost (measured: a four-rule block kept two). A blank line is pure
 * whitespace in both CSS and JS, so removing it there costs nothing and keeps the
 * HTML block whole.
 *
 * Three things it must get right, none of which a `<style>[\s\S]*?</style>` regex
 * does: a `<style>` shown inside a fenced code block is a code SAMPLE and keeps
 * its blank lines (a doc explaining CSS would otherwise be rewritten); an
 * UNCLOSED `<style>` still collapses, because the browser closes it on insert and
 * runs the CSS anyway; and `<textarea>` is left alone, where a blank line is
 * content. It therefore walks tags with the same scanner the depth pass uses
 * (comments, `<!DOCTYPE>`, quote-aware tag ends, the prose-that-looks-like-a-tag
 * allowlist, code regions).
 *
 * Render-time only: never call this from the chunker. Boundary decisions have to
 * keep seeing the text exactly as it arrived, or the prefix invariant moves.
 */
export function collapseRawtextBlankLines(text: string): string {
  if (!/<(?:style|script)\b/i.test(text)) return text;
  const skip = makeSkip(text);
  let out = '';
  let copied = 0; // text before this index is already in `out`
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    if (skip(lt)) { i = lt + 1; continue; }
    if (text.startsWith('<!--', lt)) {
      // A `<style>` written inside a comment is inert; an unterminated comment
      // swallows everything after it, so there is nothing left to collapse.
      const close = text.indexOf('-->', lt + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    if (text[lt + 1] === '!') {
      const gt = text.indexOf('>', lt);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    const m = TAG_NAME_RE.exec(text.slice(lt, lt + 64));
    if (!m) { i = lt + 1; continue; }
    const end = tagEnd(text, lt);
    if (end < 0) break; // tag still arriving — it has no body yet
    const name = m[2].toLowerCase();
    i = end;
    if (m[1] === '/' || !isMarkupTag(text.slice(lt, end), name)) continue;
    if (!RAWTEXT_TAGS.has(name)) continue;
    const close = rawtextClose(text, end, name);
    const bodyEnd = close ? close.at : text.length;
    if (COLLAPSIBLE_RAWTEXT.has(name)) {
      out += text.slice(copied, end) + text.slice(end, bodyEnd).replace(BLANK_LINE_RUN_RE, '$1');
      copied = bodyEnd;
    }
    i = close ? close.end : text.length;
  }
  return copied === 0 ? text : out + text.slice(copied);
}

// ── Boundaries ───────────────────────────────────────────────────────────────

/**
 * Does the line read as list content? Both forms of a loose list's interior: a
 * bullet/ordered marker, or a continuation line indented under one.
 *
 * Monotone under append, which is what makes the boundary rule below safe: a
 * partial line can go from "not list content" (`-`) to "list content" (`- item`)
 * as the delta lands, never the other way.
 */
function listish(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^ {2,}\S/.test(line);
}

/**
 * Cut at this blank line?
 *
 * A loose list keeps its blank lines INSIDE one chunk, otherwise per-chunk
 * markdown renders one list as two (restarting `1.` numbering and breaking the
 * spacing). That needs the NEXT line, which may still be arriving — so when the
 * previous line is list content and the successor line is not yet complete, defer:
 * `-` becoming `- item` would otherwise turn a cut into a non-cut and move a
 * frozen boundary. With a non-list predecessor the successor cannot change the
 * answer, so the cut is final immediately.
 */
function cutHere(prev: string, next: string, nextComplete: boolean): boolean {
  if (!listish(prev)) return true;
  if (listish(next)) return false;
  return nextComplete;
}

/**
 * Split `text` into finished chunks plus the growing tail.
 *
 * The LAST chunk is always the tail even when it looks complete: only the next
 * delta can prove it finished, and freezing a chunk the model is still writing is
 * exactly the bug this file exists to prevent. `tail` is null only for empty text.
 */
export function splitRichChunks(text: string): { stable: RichChunk[]; tail: RichChunk | null } {
  if (!text) return { stable: [], tail: null };

  const lines = lineSpans(text);
  const lineAt = (i: number): string => text.slice(lines[i].start, lines[i].end);
  const skip = makeSkip(text);
  const { depth, blocked } = scanHtmlState(text, lines, skip);

  const cuts: number[] = [];
  let hasContent = false; // no chunk is ever pure whitespace
  for (let i = 0; i < lines.length; i++) {
    if (lineAt(i).trim() !== '') { hasContent = true; continue; }
    let runEnd = i;
    while (runEnd + 1 < lines.length && lineAt(runEnd + 1).trim() === '') runEnd++;
    const next = runEnd + 1;
    // A blank line at end-of-text is NOT a boundary: the successor line that
    // decides it has not arrived, and a cut made now could not be taken back.
    if (next >= lines.length) break;
    if (
      hasContent && depth[i] === 0 && !blocked[i] && !skip(lines[i].start)
      && cutHere(lineAt(i - 1), lineAt(next), next < lines.length - 1)
    ) {
      cuts.push(lines[next].start); // the blank run belongs to the chunk it ends
      hasContent = false;
    }
    i = runEnd;
  }

  const stable: RichChunk[] = [];
  let start = 0;
  for (const cut of cuts) {
    stable.push(makeChunk(text.slice(start, cut)));
    start = cut;
  }
  return { stable, tail: makeChunk(text.slice(start)) };
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Body of a ```html-app fence when the chunk is NOTHING BUT that fence.
 *
 * `html-app` is the explicit opt-in for "run this", so it must be the whole
 * chunk: prose sitting after the closing fence would be swallowed by the island.
 * A plain ```html fence is a code SAMPLE and stays markdown. Returns null when
 * this is not a pure app fence.
 *
 * Both the opener and the closer tolerate a `\r`: a CRLF stream otherwise left
 * the closer unmatched forever, so a finished island stayed a "building…"
 * placeholder for the rest of the session.
 */
function appFence(text: string): { body: string; closed: boolean } | null {
  const open = /^\s*(`{3,}|~{3,})[ \t]*html-app[ \t]*\r?(?:\n|$)/i.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = new RegExp(`(?:^|\\n) {0,3}${open[1][0]}{${open[1].length},}[ \t]*\r?(?:\\n|$)`).exec(rest);
  if (!close) return { body: rest, closed: false }; // still streaming — no closer yet
  const after = rest.slice(close.index + close[0].length);
  if (after.trim() !== '') return null; // fence + trailing prose: render as markdown
  return { body: rest.slice(0, close.index), closed: true };
}

/**
 * Element names this text opens or closes as MARKUP, lowercased.
 *
 * ONE scanner backs both classification (`rawTagNames`, which skips code regions
 * because a tag in a fence is a sample) and the `hasRichContent` precheck (which
 * deliberately does not), so the two can never disagree about what counts as a
 * tag — a disagreement means a message takes the plain path while the splitter
 * thinks it has HTML, or the reverse.
 */
function scanTagNames(text: string, skip: (index: number) => boolean, firstOnly: boolean): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    if (skip(lt)) continue;
    const m = TAG_NAME_RE.exec(text.slice(lt, lt + 64));
    if (!m) continue;
    const end = tagEnd(text, lt);
    // A tag still arriving counts by what it has so far — the classification has
    // to be right from the first delta, not only once the `>` lands.
    const raw = end < 0 ? text.slice(lt) : text.slice(lt, end);
    if (isMarkupTag(raw, m[2].toLowerCase())) {
      names.push(m[2].toLowerCase());
      if (firstOnly) return names;
    }
    if (end > 0) i = end;
  }
  return names;
}

/** Tag names found outside code regions, lowercased (walnut ref tags excluded). */
function rawTagNames(text: string): string[] {
  return scanTagNames(text, makeSkip(text), false);
}

function makeChunk(text: string): RichChunk {
  const names = rawTagNames(text);
  // A `<script>` is stripped by the sanitizer, so the only faithful render is a
  // sandboxed island — that decision belongs to the chunk, not the renderer.
  if (names.includes('script') || appFence(text) !== null) return { kind: 'app', text };
  return { kind: names.length > 0 ? 'html' : 'md', text };
}

/** The HTML an `app` chunk should run: a fence's body, or the chunk as written. */
export function extractAppHtml(chunk: RichChunk): string {
  return appFence(chunk.text)?.body ?? chunk.text;
}

/**
 * Has an `app` chunk finished arriving?
 *
 * Mounting a half-written island would run half a script, so an incomplete one
 * renders a placeholder instead. "Stable chunk" is NOT the right test: a reply
 * whose LAST block is the app block never gets a successor line, so its chunk
 * stays the tail forever and a stable-only rule would leave it building for good.
 * Completeness is a property of the text: the fence closed, or every element the
 * chunk opened is closed and no tag/comment is mid-arrival.
 */
export function isAppComplete(chunk: RichChunk): boolean {
  const fence = appFence(chunk.text);
  if (fence) return fence.closed;
  const lines = lineSpans(chunk.text);
  const state = scanHtmlState(chunk.text, lines, makeSkip(chunk.text));
  return !state.truncated && state.endDepth === 0;
}

/**
 * Does this text end INSIDE a construct that is still arriving (a tag with no
 * `>`, an unterminated comment, an unclosed rawtext body)?
 *
 * The streaming accumulator asks the same question through
 * `splitPendingMarkup` (src/core/stream/pending-markup.ts), which is a separate
 * implementation because the server-side buffer twin needs it too. The two MUST
 * agree: if the reducer carries a fragment this scanner would happily render (or
 * the reverse), a card interrupting the model's text splits it in half again —
 * exactly inc-1788209680147. tests/core/pending-markup.test.ts pins the pair.
 */
export function endsMidConstruct(text: string): boolean {
  if (!text.includes('<')) return false;
  return scanHtmlState(text, lineSpans(text), makeSkip(text)).truncated;
}

/**
 * Cheap precheck: could this text hold raw HTML at all?
 *
 * False keeps the caller on the single-div markdown render it has always used, so
 * an ordinary message is untouched by any of this. Walnut's own `<task-ref/>` /
 * `<session-ref/>` pills do NOT count (see REF_TAGS) — they are pre-markdown
 * syntax, and counting them would route nearly every Personal AI answer through
 * the chunked path for nothing. Neither do the prose shapes isMarkupTag rejects
 * (an autolink, `<user@host>`, `Array<T>`).
 */
export function hasRichContent(text: string): boolean {
  if (!text.includes('<')) return false;
  return scanTagNames(text, () => false, true).length > 0;
}

// ── Identity: one scope per MESSAGE, one key per chunk ────────────────────────

/**
 * The scope id for a whole RichMarkdown instance: what `data-rblk` carries on the
 * wrapper, and therefore what scoped CSS is confined to.
 *
 * Message-level rather than chunk-level on purpose. A `<style>` the model writes
 * first and the markup it styles second land in DIFFERENT chunks (a blank line
 * between them is exactly a chunk boundary), so a per-chunk scope meant the CSS
 * could never match the markup it was written for. The wrapper still bounds it:
 * nothing outside this message can be styled.
 */
export function richScopeId(seed: string): string {
  return `rb${digest(seed)}`;
}

/**
 * React key for chunk `index` of the message identified by `scopeId`.
 *
 * The chunk TEXT is deliberately absent. A chunk promoted from tail to stable
 * gains its boundary blank line (`"Second para."` → `"Second para.\n\n"`), so a
 * text-derived key changed at exactly the moment the chunk was supposed to become
 * permanent: React saw a new key, unmounted the node and mounted a fresh one —
 * reloading any iframe island and resetting any widget state, which is the bug
 * the whole file exists to prevent. Index + scope is enough, because the prefix
 * invariant guarantees a chunk never changes its index.
 */
export function richChunkKey(scopeId: string, index: number): string {
  return `rk${digest(`${scopeId}|${index}`)}`;
}

/**
 * The keys a render of `text` under `scopeSeed` would produce, in order.
 * Exported so the promotion invariant above is testable without React.
 */
export function richChunkKeys(text: string, scopeSeed: string): string[] {
  const { stable, tail } = splitRichChunks(text);
  const scopeId = richScopeId(scopeSeed);
  const count = stable.length + (tail ? 1 : 0);
  return Array.from({ length: count }, (_unused, i) => richChunkKey(scopeId, i));
}

// ── CSS scoping ──────────────────────────────────────────────────────────────

/**
 * Confine every rule in a `<style>` block to `[data-rblk="scopeId"]`.
 * Implementation (and the reasoning behind its paranoia) in rich-css-scope.ts;
 * re-exported here so callers have ONE import for the whole feature.
 */
export { scopeStyleHtml } from './rich-css-scope';
