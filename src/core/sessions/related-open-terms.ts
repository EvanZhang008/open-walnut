/**
 * Term extraction for the related-open-tasks ranking (related-open-rank.ts).
 *
 * It reuses the search code's term rules (`QUERY_STOPWORDS` and `lightStem` from
 * cjk.ts, `foldWidth` from the index tokenizer) and the index's CJK rule: a CJK run is
 * read as its ordered character pairs. Three additions the search code does not need:
 *   - word families: a word and its inflections ("remind", "reminder"; "expires",
 *     "expiry") are one term, found once over the whole board, so a reworded title
 *     still meets the word it names. Only a root written somewhere on the board plus
 *     a suffix from a short list joins: a longer word that merely begins with another
 *     ("check", "checkout"; "state", "statement"; "direct", "director") stays apart,
 *     and a joined name ("LedgerService", "SkyWatch") never joins a family;
 *   - boilerplate: a sentence that recurs in the descriptions of 3+ tasks (a lead's
 *     standard paragraph about where to run tests) is dropped before reading terms,
 *     because it says how the work is done, not which work it is;
 *   - glue words of a task brief on top of QUERY_STOPWORDS. Domain words ("fix",
 *     "test", "ios") stay: IDF weighs those by how busy the board is with them.
 */

import { QUERY_STOPWORDS, lightStem, CJK_RUN_RE, CJK_CHAR_RE } from '../cjk.js';
import { foldWidth } from '../../lib/hybrid-search/tokenizer.js';

/** One normalized term and how the text wrote it. */
export type Terms = Map<string, string>;

/** A description is read up to here (after boilerplate): the head names the subject. */
export const DESC_CHARS = 1500;
/** Sentence analysis reads this much of each description, so a pasted log costs nothing. */
const SENTENCE_SCAN_CHARS = 6000;
const MIN_LATIN = 3;
/** A family root has at least this many letters; a longer word than FAMILY_MAX is a joined name. */
const FAMILY_MIN = 5;
const FAMILY_MAX = 12;
const BOILERPLATE_MIN_CHARS = 12;
export const BOILERPLATE_MIN_TASKS = 3;

const EXTRA_STOPWORDS = new Set([
  'and', 'the', 'but', 'all', 'any', 'can', 'its', 'our', 'your', 'their', 'them', 'then', 'than',
  'there', 'here', 'have', 'has', 'had', 'been', 'being', 'will', 'would', 'could', 'should', 'must',
  'also', 'only', 'just', 'still', 'now', 'new', 'more', 'most', 'some', 'such', 'each', 'other',
  'after', 'before', 'over', 'under', 'again', 'out', 'off', 'per', 'get', 'got', 'make',
  'made', 'need', 'needs', 'want', 'please', 'task', 'tasks', 'work', 'thing', 'things', 'one',
  'two', 'see', 'look', 'sure', 'like', 'way', 'when', 'where', 'who', 'whom', 'whose', 'while',
  'into', 'onto', 'upon', 'between', 'without', 'within', 'these', 'those', 'what', 'which',
  'add', 'adds', 'create', 'creates', 'let', 'lets', 'via', 'user', 'users', 'once',
]);

export const isCjkTerm = (term: string): boolean => CJK_CHAR_RE.test(term);

function normLatin(word: string): string {
  if (word.length >= 6) return lightStem(word);
  // Short plurals ("tests", "logs") fold too; "ss" ("class") does not.
  return word.length >= 4 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/** Keys a text wrote as a joined name (an inner capital, a digit, or past FAMILY_MAX letters). */
const JOINED = new WeakMap<Terms, Set<string>>();
const isJoinedName = (word: string): boolean =>
  /\p{Ll}\p{Lu}/u.test(word) || /\p{N}/u.test(word) || word.length > FAMILY_MAX;

/** Content terms of `text`: Latin words of 3+ letters minus glue, and each CJK run's character pairs. */
export function relatedTerms(text: string | undefined, maxChars = Infinity): Terms {
  const out: Terms = new Map();
  if (!text) return out;
  const folded = foldWidth(text.length > maxChars ? text.slice(0, maxChars) : text);
  for (const run of folded.match(CJK_RUN_RE) ?? []) {
    const chars = [...run.toLowerCase()];
    for (let i = 0; i + 1 < chars.length; i++) {
      const pair = chars[i] + chars[i + 1];
      if (!out.has(pair)) out.set(pair, pair);
    }
  }
  const joined = new Set<string>();
  for (const written of folded.replace(CJK_RUN_RE, ' ').split(/[^\p{L}\p{N}]+/u)) {
    const word = written.toLowerCase();
    if (word.length < MIN_LATIN || QUERY_STOPWORDS.has(word) || EXTRA_STOPWORDS.has(word)) continue;
    const key = normLatin(word);
    if (!out.has(key)) out.set(key, word);
    if (isJoinedName(written)) joined.add(key);
  }
  if (joined.size) JOINED.set(out, joined);
  return out;
}

/** The sentences of a description, normalized for counting (newlines and sentence marks split). */
export function descriptionSentences(text: string | undefined): string[] {
  if (!text) return [];
  const head = text.length > SENTENCE_SCAN_CHARS ? text.slice(0, SENTENCE_SCAN_CHARS) : text;
  return head.split(/[\n\r]+|[。！？；]|(?<=[.!?;])\s+/u)
    .map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((s) => s.length >= BOILERPLATE_MIN_CHARS);
}

/** Sentences found in at least BOILERPLATE_MIN_TASKS of the given descriptions. */
export function boilerplateOf(sentenceSets: Iterable<ReadonlySet<string>>): Set<string> {
  const count = new Map<string, number>();
  for (const set of sentenceSets) for (const s of set) count.set(s, (count.get(s) ?? 0) + 1);
  const out = new Set<string>();
  for (const [s, n] of count) if (n >= BOILERPLATE_MIN_TASKS) out.add(s);
  return out;
}

/** A description with its boilerplate sentences taken out (the rest kept in order). */
export function withoutBoilerplate(text: string | undefined, boilerplate: ReadonlySet<string>): string {
  if (!text) return '';
  if (boilerplate.size === 0) return text;
  const head = text.length > SENTENCE_SCAN_CHARS ? text.slice(0, SENTENCE_SCAN_CHARS) : text;
  return head.split(/([\n\r]+|[。！？；]|(?<=[.!?;])\s+)/u)
    .filter((part) => !boilerplate.has(part.replace(/\s+/g, ' ').trim().toLowerCase()))
    .join('');
}

/** Suffixes that inflect a root written in full: "remind" + "er", "report" + "ing". */
const ON_ROOT = ['s', 'es', 'ed', 'd', 'ing', 'ings', 'er', 'ers', 'y', 'ies', 'ly'];
/** Only after a root of 6+ letters ("deploy" + "ment", "direct" + "ion"; never "state" + "ment"). */
const ON_LONG_ROOT = ['ment', 'ments', 'ion', 'ions'];
/** Suffixes that replace a root's final "e": "expire" to "expiry", "expiring", "expiration". */
const AFTER_E = ['ing', 'ings', 'ed', 'y', 'al', 'ation', 'ations'];
/** The roots an inflected word implies: "expires" says "expire" (and "expir"), "replies" says "reply". */
function impliedRoots(word: string): string[] {
  const out: string[] = [];
  for (const suf of ['s', 'es', 'ed', 'ing']) {
    if (!word.endsWith(suf) || (suf === 's' && word.endsWith('ss'))) continue;
    const base = word.slice(0, -suf.length);
    if (base.length >= FAMILY_MIN) out.push(base);
    if (suf !== 's' && base.length + 1 >= FAMILY_MIN) out.push(`${base}e`);
  }
  for (const suf of ['ies', 'ied']) if (word.endsWith(suf)) out.push(`${word.slice(0, -3)}y`);
  return out;
}

/**
 * Word families over every term set at once. A word joins the family of a root when
 * it is that root plus an inflection (ON_ROOT, ON_LONG_ROOT, AFTER_E, or "ies" for a
 * final "y"). The root must be on the board: written as a word ("remind" for
 * "reminder"; the "er" suffixes need exactly that), or implied by an inflected one
 * ("expires" implies "expire", so "expiry" joins it). Every key maps to the shortest
 * key of its family; a key without relatives is left out.
 */
export function familyMap(termSets: Iterable<Terms>): Map<string, string> {
  const written = new Map<string, string>(); // word -> key
  for (const terms of termSets) {
    const joined = JOINED.get(terms);
    for (const [key, word] of terms) {
      if (isCjkTerm(key) || joined?.has(key) || !/^\p{L}+$/u.test(word)) continue;
      if (word.length >= FAMILY_MIN && !written.has(word)) written.set(word, key);
    }
  }
  const implied = new Set<string>();
  for (const word of written.keys()) for (const r of impliedRoots(word)) if (!written.has(r)) implied.add(r);
  const rootKey = (root: string, writtenOnly: boolean): string | undefined =>
    written.get(root) ?? (!writtenOnly && implied.has(root) ? normLatin(root) : undefined);
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a); const rb = find(b);
    if (ra === rb) return;
    const [keep, drop] = ra.length < rb.length || (ra.length === rb.length && ra < rb) ? [ra, rb] : [rb, ra];
    parent.set(drop, keep);
    if (!parent.has(keep)) parent.set(keep, keep);
  };
  for (const [word, key] of written) {
    const tryRoot = (root: string, writtenOnly = false): void => {
      if (root.length < FAMILY_MIN || root === word) return;
      const rk = rootKey(root, writtenOnly);
      if (rk !== undefined) union(key, rk);
    };
    for (const suf of [...ON_ROOT, ...ON_LONG_ROOT]) {
      if (!word.endsWith(suf)) continue;
      const root = word.slice(0, -suf.length);
      if (ON_LONG_ROOT.includes(suf) && root.length < 6) continue;
      tryRoot(root, suf === 'er' || suf === 'ers');
    }
    for (const suf of AFTER_E) if (word.endsWith(suf)) tryRoot(`${word.slice(0, -suf.length)}e`);
    if (word.endsWith('ies')) tryRoot(`${word.slice(0, -3)}y`);
  }
  // A family needs two written words: "testbed" implying "testb" is no family.
  const members = new Map<string, Set<string>>();
  for (const key of written.values()) {
    const r = find(key);
    if (!members.has(r)) members.set(r, new Set());
    members.get(r)!.add(key);
  }
  const out = new Map<string, string>();
  for (const k of parent.keys()) {
    const r = find(k);
    if (r !== k && (members.get(r)?.size ?? 0) >= 2) out.set(k, r);
  }
  return out;
}

/** `terms` with every key replaced by its family root (the first spelling seen is kept). */
export function inFamilies(terms: Terms, families: ReadonlyMap<string, string>): Terms {
  if (families.size === 0) return terms;
  const out: Terms = new Map();
  for (const [k, said] of terms) {
    const root = families.get(k) ?? k;
    if (!out.has(root)) out.set(root, said);
  }
  return out;
}
