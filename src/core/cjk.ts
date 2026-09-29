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

import { COMPOUND_MIN_HALF } from '../lib/hybrid-search/query.js';

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

/** How the two words of a compound are written apart: "Dock Hub", "dock-hub", "dock_hub", "dock.hub". */
const COMPOUND_SEPARATOR = '[\\s_.\\-]{1,3}';

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
/**
 * The matcher `termInText` and `termMatchesInText` share.
 *
 * One builder, two callers: snippet selection and coverage counting must agree
 * on what "this term appears here" means. When they disagreed, a hit could be
 * ranked for a term the snippet then failed to find, and the snippet silently
 * fell back to the head of the document — which is the title.
 */
function termMatcher(term: string, splitCompound = true): { cjk: true } | { cjk: false; re: RegExp } {
  if (CJK_CHAR_RE.test(term)) return { cjk: true };
  const stem = lightStem(term);
  const escaped = stem.replace(REGEX_ESCAPE_RE, '\\$&');
  // Flex must cover the LONGEST strippable suffix (6, "ations"): the text may
  // carry the suffix the query lacks ("conversation" query → "conversations"
  // in text = stem + 6). Unstemmed long terms get a smaller allowance (plural
  // /verb endings); short terms stay exact.
  const flex = stem === term ? (term.length >= STEM_MIN_TERM ? 4 : 0) : 6;
  // A one-word term also matches as two words ("dockhub" in "Dock Hub", "dock-hub"):
  // the compound rule the index lane applies (compoundForms in
  // src/lib/hybrid-search/query.ts). Without it the index lane found the task
  // and every ranking step here scored it as missing that term.
  const splits: string[] = [];
  if (splitCompound && /^[a-z0-9]+$/.test(stem)) {
    for (let k = COMPOUND_MIN_HALF; k <= stem.length - COMPOUND_MIN_HALF; k++) {
      splits.push(`${stem.slice(0, k)}${COMPOUND_SEPARATOR}${stem.slice(k)}`);
    }
  }
  const word = splits.length > 0 ? `(?:${[escaped, ...splits].join('|')})` : escaped;
  // Boundary = "not glued to more LATIN word characters". \p{L} would be
  // wrong here: CJK chars are letters too, and mixed-script titles embed
  // Latin words directly against them ("云端Walnut迁移…") — an adjacent
  // ideograph IS a word boundary, not a continuation. The flex quantifier
  // stays Latin-only for the same reason.
  return {
    cjk: false,
    re: new RegExp(
      `(?<![a-zA-Z0-9])${word}[a-zA-Z]{0,${flex}}(?![a-zA-Z0-9])`,
      'gu',
    ),
  };
}

/** Two adjacent Latin query terms as the one word a text may write them as ("dock hub" → "dockhub"). */
function joinedTerm(a: string, b: string): string | null {
  return /^[a-z0-9]+$/.test(a) && /^[a-z0-9]+$/.test(b) && a !== b ? a + b : null;
}

/**
 * Which of `terms` (in query order) occur in `text`. A term counts when it
 * matches on its own or when it and its neighbour appear joined as one word:
 * "dock hub" covers both terms in a title that says "DockHub". The index lane
 * credits the join to both terms the same way, so coverage computed here
 * agrees with the coverage that retrieved the row.
 */
export function termsFoundInText(text: string, terms: readonly string[]): boolean[] {
  const found = terms.map((term) => termInText(text, term));
  for (let i = 0; i < terms.length - 1; i++) {
    if (found[i] && found[i + 1]) continue;
    const joined = joinedTerm(terms[i], terms[i + 1]);
    if (joined && termInText(text, joined)) {
      found[i] = true;
      found[i + 1] = true;
    }
  }
  return found;
}

/** Count of `terms` present in `text`, compound spellings included (see termsFoundInText). */
export function countTermsInText(text: string, terms: readonly string[]): number {
  return termsFoundInText(text, terms).filter(Boolean).length;
}

/**
 * Query terms as this text reads them, for a score that compares how much of
 * the query a SHORT text covers against how much of the text the query covers
 * (the title lane's F1). Two adjacent terms the text writes as ONE word
 * ("dock hub" vs a title saying "DockHub") are one unit there, matched or not:
 * crediting them as two let a two-word title like "[Dock] - DockHub" cover
 * "2 of 3" terms of "dock hub sync" with no "sync" in it, and a wall of such
 * titles pushed the task actually titled "... Dock Hub KB sync" out of the lane.
 */
export function termUnitsInText(text: string, terms: readonly string[]): { units: number; matched: number } {
  let units = 0;
  let matched = 0;
  for (let i = 0; i < terms.length; i++) {
    units++;
    const joined = i + 1 < terms.length ? joinedTerm(terms[i], terms[i + 1]) : null;
    if (joined && wordInText(text, joined)) {
      matched++;
      i++;
      continue;
    }
    if (termInText(text, terms[i])) matched++;
  }
  return { units, matched };
}

/** `termInText` without the two-word spelling: is `term` written as one word? */
function wordInText(text: string, term: string): boolean {
  const m = termMatcher(term, false);
  if (m.cjk) return text.includes(term);
  m.re.lastIndex = 0;
  return m.re.test(text);
}

/**
 * Every occurrence of every term in `text`, with the matched length (a
 * compound form is longer than the term: "dock hub" for "dockhub"). A joined
 * occurrence of two adjacent terms is reported once for EACH of them, so a
 * snippet window around "DockHub" counts both "dock" and "hub". Stops adding a
 * term's occurrences once `cap` hits are collected.
 */
export function termHitsInText(
  text: string,
  terms: readonly string[],
  cap = Infinity,
): Array<{ at: number; len: number; term: string }> {
  const hits: Array<{ at: number; len: number; term: string }> = [];
  const push = (term: string, source: string) => {
    for (const hit of termMatchesInText(text, source)) hits.push({ ...hit, term });
  };
  for (const term of terms) {
    if (hits.length > cap) break;
    push(term, term);
  }
  for (let i = 0; i < terms.length - 1 && hits.length <= cap; i++) {
    const joined = joinedTerm(terms[i], terms[i + 1]);
    if (!joined) continue;
    push(terms[i], joined);
    push(terms[i + 1], joined);
  }
  return hits;
}

/**
 * Every place in `text` where `term` matches, using the SAME rules as
 * `termInText`. Snippet selection needs positions, not a boolean: picking the
 * window by the earliest single occurrence meant any term in a long title beat
 * the real match 20KB into the body.
 */
function termMatchesInText(text: string, term: string): Array<{ at: number; len: number }> {
  const out: Array<{ at: number; len: number }> = [];
  const m = termMatcher(term);
  if (m.cjk) {
    let at = text.indexOf(term);
    while (at !== -1) {
      out.push({ at, len: term.length });
      at = text.indexOf(term, at + Math.max(1, term.length));
    }
    return out;
  }
  m.re.lastIndex = 0;
  for (const match of text.matchAll(m.re)) {
    if (match.index !== undefined) out.push({ at: match.index, len: match[0].length });
  }
  return out;
}

export function termInText(text: string, term: string): boolean {
  const m = termMatcher(term);
  if (m.cjk) return text.includes(term);
  m.re.lastIndex = 0;
  return m.re.test(text);
}
