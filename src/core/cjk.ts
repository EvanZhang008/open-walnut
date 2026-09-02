/**
 * CJK-aware query term splitting for the RANKING side of search (search.ts:
 * coverage tiebreak, title lane, snippet term highlighting).
 *
 * Not the tokenizer. The index has its own (src/lib/hybrid-search/tokenizer.ts,
 * which indexes CJK as ordered character pairs); this module answers a
 * different question: "which terms of the query should a result be judged on
 * containing", which is a scoring concern and stays on the query side.
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

/**
 * English glue words that carry no signal for containment/coverage checks.
 * An agent-phrased query ("which task removed the star rating system from
 * tasks") is half glue; counting those words dilutes term-coverage fractions
 * for every candidate equally EXCEPT the right one (whose content words are
 * the ones that matter). Kept deliberately small — mirror of the lex-side
 * LATIN_STOPWORDS in memory-search.ts, shared here for query-shape helpers.
 */
export const QUERY_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'was', 'were', 'be', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from',
  'use', 'using', 'used', 'how', 'what', 'which', 'why', 'when', 'do', 'does',
  'did', 'not', 'no', 'we', 'i', 'you', 'they', 'instead', 'via', 'into',
]);

/** splitQueryTerms minus English glue words — the term set that coverage
 *  ranking and title matching should count. CJK runs are never stopwords. */
export function contentQueryTerms(query: string): string[] {
  return splitQueryTerms(query).filter((t) => !QUERY_STOPWORDS.has(t));
}

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/**
 * Porter-lite stem for containment checks: strip ONE common English suffix.
 * Only applied to terms long enough (>= 6 chars) that the stem stays
 * distinctive; short words match exactly, which is what keeps "star" from
 * matching "starve" (the false hit that motivated word-boundary matching).
 */
const STEM_SUFFIX_RE = /(ations|ation|ions|ing|ies|ion|es|ed|s)$/;
const STEM_MIN_TERM = 6;
const STEM_MIN_STEM = 4;

export function lightStem(term: string): string {
  if (term.length < STEM_MIN_TERM) return term;
  const stemmed = term.replace(STEM_SUFFIX_RE, '');
  return stemmed.length >= STEM_MIN_STEM ? stemmed : term;
}

/**
 * Does `term` occur in `text` as a whole word? Latin/digit terms demand a
 * word boundary on both sides — plain .includes() let "star" match "Quick
 * START 分类错误" and "Don't STARve", which handed coverage credit to garbage
 * rows on the 2026-08-20 eval ("star system removed" ranked two false
 * substring hits above the real session). CJK terms keep substring semantics:
 * CJK text has no word delimiters, so a boundary requirement would be wrong
 * by construction. `text` must already be lowercased (terms come lowercased
 * from splitQueryTerms).
 *
 * Long terms match morphological variants via lightStem + a bounded trailing
 * flex: "conversation" ↔ "conversations", "investigation" ↔ "investigate",
 * "removed" ↔ "removal". People remember the concept, not the inflection,
 * and the FTS index already stems (porter) — coverage counting must not be
 * stricter than the match lanes it re-ranks.
 */
export function termInText(text: string, term: string): boolean {
  if (CJK_CHAR_RE.test(term)) return text.includes(term);
  const stem = lightStem(term);
  const escaped = stem.replace(REGEX_ESCAPE_RE, '\\$&');
  // Flex must cover the LONGEST strippable suffix (6, "ations"): the text may
  // carry the suffix the query lacks ("conversation" query → "conversations"
  // in text = stem + 6). Unstemmed long terms get a smaller allowance (plural
  // /verb endings); short terms stay exact.
  const flex = stem === term ? (term.length >= STEM_MIN_TERM ? 4 : 0) : 6;
  // Boundary = "not glued to more LATIN word characters". \p{L} would be
  // wrong here: CJK chars are letters too, and mixed-script titles embed
  // Latin words directly against them ("云端Walnut迁移…") — an adjacent
  // ideograph IS a word boundary, not a continuation. The flex quantifier
  // stays Latin-only for the same reason.
  return new RegExp(
    `(?<![a-zA-Z0-9])${escaped}[a-zA-Z]{0,${flex}}(?![a-zA-Z0-9])`,
    'u',
  ).test(text);
}
