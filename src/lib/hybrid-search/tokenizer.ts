/**
 * hybrid-search tokenizer — the single source of truth for index-side AND
 * query-side token streams. Never call a different tokenizer on one side:
 * silent index/query mismatch is the #1 failure mode of owning a tokenizer.
 *
 * Output is two ORDERED streams (duplicates kept — the doc streams feed FTS5
 * columns, where order carries phrase positions and repetition carries term
 * frequency; deduplication is the query compiler's job):
 *
 *   orig — whole lowercased tokens, internal `- _ . '` preserved
 *          (`acme-gateway-dev` stays one token); a contiguous CJK run is one
 *          orig token.
 *   sub  — split parts of tokens that actually split (camelCase, snake_case,
 *          kebab-case, letter↔digit boundaries); for CJK runs, the ordered
 *          bigram stream (a 1-char run contributes the char itself). Latin
 *          tokens that don't split contribute nothing to `sub`.
 *
 * Splitting boundaries: lower→Upper, letter↔digit, UPPER→Upperlower (so
 * `AcmeEventOperator` splits after `Acme`, not after `AcmeEvent`), and every
 * separator character. No stemming, ever.
 *
 * Bump TOKENIZER_VERSION on ANY behavior change — the db layer stores it and
 * forces a full rebuild on mismatch, which is the only safety valve against
 * an index tokenized by an older algorithm silently disagreeing with queries.
 */

export const TOKENIZER_VERSION = 1;

export interface TokenStreams {
  orig: string[];
  sub: string[];
}

const MAX_TOKEN_CHARS = 64;

// Character classes for the scan. ASCII fast paths first; non-ASCII letters
// (é, ü, я …) are classified via RegExp once per char — rare in this corpus.
const enum Cls {
  Sep = 0,
  Lower = 1,
  Upper = 2,
  Digit = 3,
  Cjk = 4,
  Join = 5, // - _ . '  → kept inside orig tokens, boundary for sub parts
}

const NON_ASCII_LETTER = /\p{L}/u;
const NON_ASCII_DIGIT = /\p{N}/u;

function classify(code: number): Cls {
  if (code < 128) {
    if (code >= 97 && code <= 122) return Cls.Lower; // a-z
    if (code >= 65 && code <= 90) return Cls.Upper; // A-Z
    if (code >= 48 && code <= 57) return Cls.Digit; // 0-9
    if (code === 45 || code === 95 || code === 46 || code === 39) return Cls.Join; // - _ . '
    return Cls.Sep;
  }
  // CJK: Han (incl. Ext A), Hiragana/Katakana, Hangul syllables.
  if (
    (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0x20000 && code <= 0x2ebef)
  ) return Cls.Cjk;
  const ch = String.fromCodePoint(code);
  if (NON_ASCII_LETTER.test(ch)) return Cls.Lower; // no case boundaries outside ASCII
  if (NON_ASCII_DIGIT.test(ch)) return Cls.Digit;
  return Cls.Sep;
}

/** Push `token` (already bounded by the scan) respecting the length cap. */
function pushCapped(list: string[], token: string): void {
  if (token.length > 0 && token.length <= MAX_TOKEN_CHARS) list.push(token);
}

/**
 * Emit the sub-parts of a non-CJK orig token slice [start, end).
 * `text` here is the ALREADY LOWERCASED source; `caseRef` is the original-case
 * source used to find camel boundaries. Parts are pushed only when the token
 * splits into 2+ parts (a token identical to its single part would just
 * double-count itself in the recall lane).
 */
function emitLatinSubParts(
  lower: string,
  caseRef: string,
  start: number,
  end: number,
  sub: string[],
): void {
  const parts: Array<[number, number]> = [];
  let partStart = -1;
  let prev = Cls.Sep;
  for (let i = start; i <= end; i++) {
    const cls = i < end ? classify(caseRef.charCodeAt(i)) : Cls.Sep;
    const isPart = cls === Cls.Lower || cls === Cls.Upper || cls === Cls.Digit;
    if (!isPart) {
      if (partStart >= 0) { parts.push([partStart, i]); partStart = -1; }
      prev = Cls.Sep;
      continue;
    }
    if (partStart < 0) {
      partStart = i;
    } else if (
      // lower→Upper or digit↔letter boundary
      (cls === Cls.Upper && prev === Cls.Lower)
      || (cls === Cls.Digit) !== (prev === Cls.Digit)
    ) {
      parts.push([partStart, i]);
      partStart = i;
    } else if (cls === Cls.Lower && prev === Cls.Upper && partStart < i - 1) {
      // UPPER→Upperlower: "HTTPResponse" — the last upper starts the next word
      parts.push([partStart, i - 1]);
      partStart = i - 1;
    }
    prev = cls;
  }
  if (partStart >= 0) parts.push([partStart, end]);
  if (parts.length < 2) return;
  for (const [s, e] of parts) pushCapped(sub, lower.slice(s, e));
}

/** Emit a CJK run: whole run → orig; ordered bigrams (or the lone char) → sub. */
function emitCjkRun(lower: string, start: number, end: number, orig: string[], sub: string[]): void {
  pushCapped(orig, lower.slice(start, end));
  if (end - start === 1) {
    sub.push(lower.slice(start, end));
    return;
  }
  for (let i = start; i < end - 1; i++) {
    sub.push(lower.slice(i, i + 2));
  }
}

/**
 * Tokenize `text` into ordered orig/sub streams. Used verbatim on both the
 * write path (docs) and the read path (queries).
 */
export function tokenize(text: string): TokenStreams {
  const orig: string[] = [];
  const sub: string[] = [];
  if (!text) return { orig, sub };
  const lower = text.toLowerCase();
  const n = text.length;

  let i = 0;
  while (i < n) {
    const cls = classify(text.charCodeAt(i));
    if (cls === Cls.Sep) { i++; continue; }

    if (cls === Cls.Cjk) {
      let j = i + 1;
      while (j < n && classify(text.charCodeAt(j)) === Cls.Cjk) j++;
      emitCjkRun(lower, i, j, orig, sub);
      i = j;
      continue;
    }

    // Latin/digit token: runs of letters/digits/joiners, but a token never
    // starts or ends with a joiner (trailing dot is sentence punctuation).
    if (cls === Cls.Join) { i++; continue; }
    let j = i + 1;
    let lastAlnum = i;
    while (j < n) {
      const c = classify(text.charCodeAt(j));
      if (c === Cls.Lower || c === Cls.Upper || c === Cls.Digit) {
        lastAlnum = j;
        j++;
      } else if (c === Cls.Join) {
        j++;
      } else {
        break;
      }
    }
    const end = lastAlnum + 1; // strip trailing joiners
    pushCapped(orig, lower.slice(i, end));
    emitLatinSubParts(lower, text, i, end, sub);
    i = j;
  }

  return { orig, sub };
}
