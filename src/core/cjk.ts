/**
 * CJK-aware query term splitting, shared by the lex-query builder
 * (memory-search.ts) and the cross-store coverage ranking (search.ts).
 *
 * QMD's FTS index uses SQLite FTS5 with tokenize='porter unicode61', which
 * keeps a contiguous CJK run as ONE token. That tokenizer string is hardcoded
 * inside @tobilu/qmd (dist/store.js), so Walnut cannot swap in a CJK
 * segmenter without forking QMD AND re-indexing every store — which is why
 * the workaround lives on the QUERY side (splitting terms here) instead of
 * the index side.
 *
 * Script_Extensions (not Script) is required: Katakana's prolonged sound mark
 * ー (U+30FC) and the middle dot ・ (U+30FB) are Script=Common, so a plain
 * Script=Katakana class splits コンピューター into garbage mid-word runs.
 */

export const MIN_TERM_CHARS = 2;

/** Matches one contiguous CJK run. Global flag: for .match()/.replace() ONLY —
 * .test() on a /g regex is lastIndex-stateful and alternates true/false; use
 * CJK_CHAR_RE for predicates. */
export const CJK_RUN_RE = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;

/** Non-global twin of CJK_RUN_RE, safe for .test(). */
export const CJK_CHAR_RE = new RegExp(CJK_RUN_RE.source, 'u');

/**
 * Split a query into coverage terms: Latin/digit words plus each CJK run,
 * both at least MIN_TERM_CHARS long (single-char fragments are noise for
 * containment checks). Latin tokens are split on any non-alphanumeric, not
 * just whitespace — CJK punctuation (，。、) is Script=Common, so "timeout，重试"
 * would otherwise yield the unmatchable term "timeout，".
 */
/**
 * True only when the query mixes CJK and non-CJK (Latin/digit) content —
 * the shape that FTS5's AND-join annihilates (see buildLexQueries in
 * memory-search.ts). Pure-CJK and pure-Latin queries return false.
 */
export function isMixedScriptQuery(query: string): boolean {
  if (!CJK_CHAR_RE.test(query)) return false;
  const residue = query.replace(CJK_RUN_RE, ' ');
  return /[\p{L}\p{N}]/u.test(residue);
}

export function splitQueryTerms(query: string): string[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const cjkRuns = (q.match(CJK_RUN_RE) ?? []).filter((r) => r.length >= MIN_TERM_CHARS);
  const latin = q
    .replace(CJK_RUN_RE, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TERM_CHARS);
  return [...latin, ...cjkRuns];
}
