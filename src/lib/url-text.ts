/**
 * Plain-text http(s) URL runs: where one starts, where it ends, and which
 * trailing characters belong to the prose instead.
 *
 * Moved from web/src/utils/url-display.ts (which re-exports these) so the
 * server's letter body linker (src/lib/agent-text-refs.ts) and every browser
 * autolink surface read ONE rule. Pure, no imports.
 */

/**
 * URL run. Deliberately permissive about `)`/`]` (kept IN the match) — a
 * trailing unmatched closer is stripped afterwards by
 * `trimTrailingPunctuation`, which is the only way to get both
 * `(see https://x.dev/a)` and `https://w.dev/wiki/Foo_(bar)` right.
 */
export const URL_RUN_SRC = 'https?:\\/\\/[^\\s<>"\'`]+';
const URL_RE = new RegExp(URL_RUN_SRC, 'g');

// ── CJK-aware URL tail cutting (shared by every autolink surface) ──
//
// Autolink regexes (marked's GFM url rule, URL_RE above) stop only at
// whitespace — but Chinese/Japanese prose puts NO space around punctuation, so
// "打开 https://a.com/x,个人账户,enroll" swallows half the sentence into the
// link (recurring report, 2026-08-12). Two cut signals, checked over the whole
// run (not just the tail — the prose continues with more non-space chars):
//  - any fullwidth/CJK punctuation char (,。、「」【】…): never legal in a real
//    URL, so the first one marks where the link ends and the prose resumes;
//  - a halfwidth , ; ! immediately followed by a CJK letter: IME users mix
//    halfwidth commas into CJK prose ("https://a.com/x,继续").
// Deliberately KEPT in the URL: CJK letters (wiki/机器学习 is a real URL), en
// dash and middots (wiki/Mexican–American_War, wiki/ウォルター・ホワイト),
// halfwidth `?` before CJK (?词=天气 is a legit query start). Known trade-off:
// an unencoded CJK query VALUE containing prose punctuation ("?q=天气,明天")
// gets cut early; pasted URLs are percent-encoded in practice.

/** CJK/fullwidth punctuation that never belongs in a URL: enumerated CJK marks
 * (、。「」【】〜… — NOT the whole U+3001–303F block: 々〇〆 are word chars that
 * appear in real slugs like wiki/人々), curly quotes, em dash, ellipses, the
 * fullwidth ASCII punct blocks (！-／ ：-＠ ［-｀ ｛-～) and halfwidth CJK punct
 * ｡｢｣､. Katakana middle dot ・ and en dash – stay legal (wiki slugs). */
const CJK_PUNCT_RE =
  /[、。〃〈〉《》「」『』【】〔〕〖〗〜〰〽‘’“”—…‥！-／：-＠［-｀｛-､]/;
/** Halfwidth sentence punctuation directly followed by a CJK letter (Han, kana, Hangul). */
const HALFWIDTH_PUNCT_BEFORE_CJK_RE =
  /[,;!](?=[぀-ヿ㐀-䶿一-鿿가-힣豈-﫿])/;

/** Cut a URL run at the first char that belongs to CJK prose rather than the URL. */
export function trimUrlCjkTail(url: string): string {
  let end = url.length;
  const p = CJK_PUNCT_RE.exec(url);
  if (p && p.index < end) end = p.index;
  const h = HALFWIDTH_PUNCT_BEFORE_CJK_RE.exec(url);
  if (h && h.index < end) end = h.index;
  return end === url.length ? url : url.slice(0, end);
}

export type TextToken =
  | { kind: 'text'; text: string }
  | { kind: 'url'; text: string; href: string };

/**
 * Trailing sentence punctuation belongs to the PROSE, not the URL. A closing
 * bracket only counts as punctuation when it is unmatched inside the URL, so
 * `…/Foo_(bar)` keeps its paren while `(see …/a)` gives the `)` back to the text.
 */
export function trimTrailingPunctuation(url: string): string {
  const balance: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
  for (const ch of url) {
    const close = ch === '(' ? ')' : ch === '[' ? ']' : ch === '{' ? '}' : null;
    if (close) balance[close] = balance[close]! - 1;
    else if (Object.hasOwn(balance, ch)) balance[ch] = balance[ch]! + 1;
  }
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if ('.,;:!?'.includes(ch)) { end--; continue; }
    if (Object.hasOwn(balance, ch) && balance[ch]! > 0) { balance[ch] = balance[ch]! - 1; end--; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Split plain text into literal-text and http(s)-URL tokens, in order. */
export function tokenizeUrls(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  let cursor = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!;
    const href = trimTrailingPunctuation(trimUrlCjkTail(m[0]));
    if (!href) continue;
    if (start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, start) });
    tokens.push({ kind: 'url', text: href, href });
    cursor = start + href.length;
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) });
  return tokens;
}
