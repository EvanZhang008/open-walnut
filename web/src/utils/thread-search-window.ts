/**
 * Drawer search (spec 6.6, N23): a row line that holds the match far to the
 * right would be cut by its ellipsis before the match, so nothing in the row
 * showed why it matched. Such a line is shown as a window that starts a few
 * words before the match instead (`…reads the lantern before…`). A line whose
 * match sits near its start is left whole. Also home to the match helpers the
 * rows use (ranges, segments, snippets). Pure; `q` is already normalized.
 */
import { normalizeForSearch } from './thread-meta';

/** Characters a narrow drawer row shows before its ellipsis, about. */
export const VISIBLE_HEAD = 24;

export function windowOnMatch(text: string, q: string, max: number): string {
  if (!q) return text;
  const at = normalizeForSearch(text).indexOf(q);
  if (at < 0 || at + q.length <= VISIBLE_HEAD) return text;
  return hitSnippet(text, q, max) ?? text;
}

// ── Match text helpers the drawer rows use (thread-tree-rows re-exports them) ──

/** [start, end) offsets into the displayed string, for the bold match. */
export type MatchRange = readonly [number, number];

/** Every occurrence of `q` (already normalized) in `text`, when normalizing
 *  kept the length (offsets map 1:1); none otherwise (no bold, still a match). */
export function matchRanges(text: string | undefined, q: string): MatchRange[] {
  if (!text || !q) return [];
  // Normalized one character at a time with a map back to the source: NFKC
  // turns `…` into `...`, and a whole-string compare then gave up on every
  // title that ends in an ellipsis (N23: the match was never bold).
  let hay = '';
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const ch of text) {
    const n = normalizeForSearch(ch);
    for (let k = 0; k < n.length; k++) { start.push(at); end.push(at + ch.length); }
    hay += n;
    at += ch.length;
  }
  const out: MatchRange[] = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(q, from);
    if (i < 0) break;
    out.push([start[i], end[i + q.length - 1]]);
    from = i + q.length;
  }
  return out;
}

/** Split a string into plain and matched segments for rendering. */
export function segmentsOf(text: string, ranges: readonly MatchRange[] | undefined): Array<{ text: string; hit: boolean }> {
  if (!ranges || ranges.length === 0) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** A short window of `text` around the first hit of `q`, cut on words. */
export function hitSnippet(text: string, q: string, max = 64): string | undefined {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = normalizeForSearch(flat).indexOf(q);
  if (at < 0) return undefined;
  let start = Math.max(0, at - Math.floor((max - q.length) / 3));
  if (start > 0) { const sp = flat.lastIndexOf(' ', start); start = sp >= 0 && sp < at ? sp + 1 : start; }
  let end = Math.min(flat.length, start + max);
  if (end < flat.length) { const sp = flat.indexOf(' ', end); end = sp >= 0 && sp - start <= max + 12 ? sp : end; }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

