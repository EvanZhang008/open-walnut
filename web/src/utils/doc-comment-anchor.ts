/**
 * Locate a doc comment's words in the OTHER view of the doc (2026-11-01, the
 * user's lead: "Every comment must show in both views, anchored to the same
 * words"). A comment picked in the rendered view quotes `bold text`; the source
 * holds `**bold** text`. A comment picked in the source quotes
 * `see [the guide](./guide.md) for`; the rendered view reads `see the guide for`.
 * No exact or whitespace-loose match finds either, so after `locateQuote` fails
 * the passage is compared by its LETTERS AND DIGITS alone: punctuation, spaces
 * and line breaks dropped, case folded, and in Markdown the syntax that only one
 * view shows (a link's target, an image, an HTML tag, an entity, a list marker, a
 * code fence's info line; in HTML its tags and entities) masked out first. The match maps back to real offsets,
 * so the paint covers the same words in either view.
 *
 * PURE (strings in, offsets out): tests/web/doc-comment-anchor.test.ts.
 */
import { locateQuote, type TextQuote } from './text-quote-anchor';

/** Letters and digits of a string, case folded, with the map back to it. */
interface Loose { chars: string; at: number[] }

// Marks too (a combining accent, a vowel sign): both views hold the same ones.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** Loose context compared either side (the stored context is 32 raw chars). */
const CONTEXT = 48;
/** A passage this short (in letters) needs its context to agree before it counts. */
const SHORT = 8;
const MIN_CONTEXT_SCORE = 6;
const MAX_HITS = 500;
const LINE_START = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/**
 * Markdown that one view shows and the other does not, as [start, end) spans.
 * Exported for tests.
 */
export function markdownOnlySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const add = (re: RegExp, group?: number) => {
    for (const m of text.matchAll(re)) {
      if (m.index === undefined) continue;
      if (group === undefined) { spans.push([m.index, m.index + m[0].length]); continue; }
      const g = m[group];
      if (!g) continue;
      const at = m.index + m[0].indexOf(g);
      spans.push([at, at + g.length]);
    }
  };
  add(/!\[[^\]\n]*\]\([^)\n]*\)/g); // an image: the rendered view draws it, no text
  add(/\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/g); // a link's target, one level of parens in it
  add(/\]\([^)\s]*$/g); // a link's target cut by the end of the passage
  add(/\]\[[^\]\n]*\]/g); // a reference link's label
  add(/^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*$/gm); // a reference definition
  add(/<!--[\s\S]*?-->/g);
  add(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?\/?>/g); // an HTML tag (not an autolink)
  add(/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);/g);
  add(/^[ \t]*(?:```|~~~)[^\n]*$/gm); // a fence and its info string
  add(/^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/gm, 1); // a list marker, a task box
  return spans;
}

/** `midLine`: the text starts inside a line (a quote whose prefix does not end one),
 *  so what looks like a list marker at its very start is not one. */
function looseOf(text: string, markup: boolean, midLine = false): Loose {
  const skip = new Uint8Array(text.length);
  if (markup) {
    for (const [a, b] of markdownOnlySpans(text)) {
      if (midLine && a === 0 && LINE_START.test(text)) continue;
      skip.fill(1, a, b);
    }
  }
  let chars = '';
  const at: number[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (!skip[i] && WORD_CHAR.test(ch)) {
      const low = ch.toLowerCase();
      const out = low.length === ch.length ? low : ch;
      chars += out;
      for (let k = 0; k < out.length; k++) at.push(i + k);
    }
    i += ch.length;
  }
  return { chars, at };
}

/** First index of `arr` (ascending) whose value is >= `v`. */
function lowerBound(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid]! < v) lo = mid + 1; else hi = mid; }
  return lo;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

export interface DocTextLocator {
  /** The passage's [start, end) in the text, or null: its words are not in it. */
  locate: (quote: TextQuote) => { start: number; end: number } | null;
}

/**
 * A locator over one view's text. `markup` (hasMarkup): syntax one view hides is
 * masked on both sides. The loose form of the text is built once, on the first
 * quote that needs it.
 */
export function docTextLocator(text: string, markup: boolean): DocTextLocator {
  let hay: Loose | null = null;
  return {
    locate: (quote) => {
      const exact = quote.exact ?? '';
      if (!markup) return locateQuote(text, quote);
      // In marked-up text the raw context of a repeated phrase may hold the other
      // view's markup (`the **` for `the `): pick among the exact hits by their
      // letters' context instead.
      const direct: number[] = [];
      for (let i = exact ? text.indexOf(exact) : -1; i !== -1 && direct.length < MAX_HITS; i = text.indexOf(exact, i + 1)) direct.push(i);
      if (direct.length === 1) return { start: direct[0]!, end: direct[0]! + exact.length };
      hay ??= looseOf(text, markup);
      const midLine = !!quote.prefix && !/\n[ \t]*$/.test(quote.prefix);
      const prefix = looseOf(quote.prefix ?? '', markup, true).chars;
      const suffix = looseOf(quote.suffix ?? '', markup, true).chars;
      const h = hay;
      const scoreAt = (loStart: number, loEnd: number) => commonSuffix(h.chars.slice(Math.max(0, loStart - CONTEXT), loStart), prefix)
        + commonPrefix(h.chars.slice(loEnd, loEnd + CONTEXT), suffix);
      if (direct.length > 1) {
        let best = direct[0]!;
        let bestScore = -1;
        for (const d of direct) {
          const lo = lowerBound(h.at, d);
          const hi = lowerBound(h.at, d + exact.length);
          const score = scoreAt(lo, hi);
          if (score > bestScore) { best = d; bestScore = score; }
        }
        return { start: best, end: best + exact.length };
      }
      const spaced = locateQuote(text, quote);
      if (spaced) return spaced;
      const needle = looseOf(exact, markup, midLine).chars;
      if (needle.length < 3) return null;
      const hits: number[] = [];
      for (let i = h.chars.indexOf(needle); i !== -1 && hits.length < MAX_HITS; i = h.chars.indexOf(needle, i + 1)) hits.push(i);
      if (!hits.length) return null;
      let best = -1;
      let bestScore = -1;
      for (const at of hits) {
        const score = scoreAt(at, at + needle.length);
        if (score > bestScore) { best = at; bestScore = score; }
      }
      // A few letters are found inside any longer word: only with their context.
      if (needle.length < SHORT && bestScore < MIN_CONTEXT_SCORE) return null;
      const startAt = h.at[best]!;
      return { start: startAt, end: h.at[best + needle.length - 1]! + 1 };
    },
  };
}

/** A Markdown or HTML doc: its source shows syntax its rendered view hides, which
 *  is masked when its words are matched across the views. */
export function hasMarkup(path: string): boolean {
  return /\.(md|markdown|mdx|mdown|mkd|html?|xhtml)$/i.test(path);
}
