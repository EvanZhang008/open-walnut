/**
 * The reader's place in a file as a LINE of its source, the one thing Preview and Source
 * share (2026-11-11 WebKit review: Preview at Section 7, about line 281, switched to Source
 * showed line 1; Source left near line 10, closed and reopened, showed line 237, because a
 * Preview pixel offset was put back into Source, where lines are another height).
 *
 * A pixel offset belongs to the view it was measured in. A line is found again in either:
 * Source and the plain code view draw lines; Preview draws the rendered text, which is the
 * source's words without its markup. So both sides are compared as their letters and digits
 * alone (`foldText`): `## Section **7**` and the heading "Section 7" read the same. The text at
 * the top of Preview is looked up in the source to name its line, and the words of a source
 * line are looked up in Preview's text to scroll to it. A word can repeat; the occurrence
 * nearest where the place should be (the same share of the document) wins.
 *
 * PURE: strings in, numbers out (tests/web/reading-line.test.ts). The DOM half is
 * utils/reading-line-dom.ts.
 */

/** A text with only its letters and digits, lowercased, and the map back (map[i] = index in the original). */
export interface FoldedText { text: string; map: number[] }

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Letters and digits only, lowercased: what Preview and Source have in common. */
export function foldText(s: string): FoldedText {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    // Surrogate pairs (an emoji, a rare CJK character) are not words of the place.
    if (c.charCodeAt(0) < 128 ? /[A-Za-z0-9]/.test(c) : WORD_CHAR.test(c)) {
      text += c.toLowerCase();
      map.push(i);
    }
  }
  return { text, map };
}

let cache: { source: string; folded: FoldedText; lineStarts: number[] } | null = null;
/** The source folded and its line starts, kept for the last source (a scroll reads it every frame). */
function sourceOf(source: string): { folded: FoldedText; lineStarts: number[] } {
  if (cache?.source === source) return cache;
  const lineStarts = [0];
  for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  cache = { source, folded: foldText(source), lineStarts };
  return cache;
}

/** How many lines the source has. */
export function lineCount(source: string): number {
  return sourceOf(source).lineStarts.length;
}

/** The 1-based line holding character `offset`. */
export function lineOfOffset(source: string, offset: number): number {
  const starts = sourceOf(source).lineStarts;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/** The occurrence of `needle` in `hay` nearest `near`, or -1. */
export function nearestOccurrence(hay: string, needle: string, near: number): number {
  if (!needle) return -1;
  let best = -1;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at;
    else if (at > near) break;
  }
  return best;
}

/** The needles a passage is looked for by: its first words, then shorter, then a little later
 *  in it (a link's address or a number the other side does not show breaks a long one). */
function needlesOf(folded: string): Array<{ needle: string; from: number }> {
  const out: Array<{ needle: string; from: number }> = [];
  for (const from of [0, 12, 24]) {
    for (const len of [32, 16, 10]) {
      const needle = folded.slice(from, from + len);
      if (needle.length >= 6 && !out.some((o) => o.needle === needle)) out.push({ needle, from });
    }
  }
  return out;
}

/**
 * The source line the rendered text `snippet` (what is at the top of Preview, onward) starts
 * on, or null when its words are not in the source. `share` (0 to 1) is how far down the view
 * that text is, which picks among repeats.
 */
export function sourceLineOfText(source: string, snippet: string, share: number): number | null {
  const { folded } = sourceOf(source);
  const near = Math.max(0, Math.min(1, share)) * folded.text.length;
  for (const { needle, from } of needlesOf(foldText(snippet).text)) {
    const at = nearestOccurrence(folded.text, needle, near + from);
    if (at >= 0) return lineOfOffset(source, folded.map[at]!);
  }
  return null;
}

/** The words of `line` onward (letters and digits only), what Preview shows of it; empty past the end. */
export function wordsFromLine(source: string, line: number, max = 64): string {
  const { folded, lineStarts } = sourceOf(source);
  const start = lineStarts[Math.max(0, Math.min(line, lineStarts.length) - 1)] ?? 0;
  // The first folded character at or after the line's start.
  let lo = 0;
  let hi = folded.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (folded.map[mid]! < start) lo = mid + 1; else hi = mid;
  }
  return folded.text.slice(lo, lo + max);
}

/**
 * Where `line`'s words are in a rendered text (`rendered`, folded): the folded index, or -1.
 * `share` is the line's share of the source, to pick among repeats.
 */
export function renderedIndexOfLine(source: string, line: number, rendered: string, share: number): number {
  const words = wordsFromLine(source, line);
  const near = Math.max(0, Math.min(1, share)) * rendered.length;
  for (const { needle, from } of needlesOf(words)) {
    const at = nearestOccurrence(rendered, needle, near + from);
    if (at >= 0) return at;
  }
  return -1;
}
