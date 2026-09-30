/**
 * hybrid-search read path — two FTS5 lanes + additive, explainable scoring.
 *
 *   Lane A (precision): all query orig tokens AND-ed, any column — precision
 *     comes from requiring EVERY term, not from excluding the sub columns
 *     (excluding them locked out the canonical doc whose title says
 *     `AcmeEventOperator` when the query says `event operator`; per-field
 *     column weights already rank title/sub/body hits apart). CJK runs
 *     compile to ORDERED bigram phrases on the sub columns ("自动重试" →
 *     {tsub…}:"自动 动重 重试"), so distant co-occurrence can't fake a hit.
 *   Lane B (recall): orig + sub tokens OR-ed over all columns including sub.
 *     Tokens whose document frequency exceeds `dfThreshold` of the corpus are
 *     EXCLUDED here (kept in lane A): at 50k docs a corpus-wide term measured
 *     619ms-1.9s in an OR lane. If everything is filtered, the longest token
 *     is re-admitted so lane B never goes empty by construction.
 *
 * Scoring is a WEIGHTED SUM of [0,1] components — never multiplicative tiers
 * (a cov=0 long transcript once outranked the correct short doc that way):
 *
 *   0.30·bm25_strict + 0.20·bm25_relaxed + 0.20·coverage
 *   + 0.20·body_coverage + 0.07·exact_ident + 0.03·recency
 *   (+ 0.20·cosine, added by the caller) … all × per-kind weight.
 *
 * Coverage is the share of the query present in ANY field (computing it on
 * title alone let long transcripts score high with zero real coverage), each
 * term weighted by how rare it is (see termWeight): matching "cook rice" is
 * most of "where is the cook rice task", matching "where is the task" is not.
 * BODY coverage counts terms in the summary/note streams only, and exists
 * because bm25 cannot distinguish "this document discusses the query" from
 * "this document is titled almost exactly the query and says nothing": FTS5
 * normalizes by WHOLE-ROW length with b=0.75 hardcoded, so an empty task
 * titled "Test <topic>" outscored a 22KB note mentioning the topic 23 times.
 * Every query term is escaped as `"…""…"` — raw interpolation broke on 11 of
 * 17 adversarial tokens (`acme-gateway-dev` parses as column-filter-minus-NOT).
 * Ranking uses the explicit bm25() function, ~3.7x faster than ORDER BY rank.
 */

import { foldWidth, tokenize } from './tokenizer.js';
import type { SearchDb } from './db.js';

/**
 * FTS5 column weights per field. Sub-stream weights are DERIVED at 60% of the
 * orig weight, so "a subword hit in the title must outrank a whole-word hit in a
 * body" cannot drift as the numbers change.
 *
 * These numbers are deliberately UNCHANGED by the 2026-09-21 ranking work, and
 * that is a measured decision, not inertia. Lowering title 10 -> 6 and raising
 * note 1 -> 2 was tried, to stop an empty task titled "Test <topic>" outranking a
 * 22KB note that mentions the topic 23 times. On the golden set (75 queries, real
 * 12,188-doc index, keyword only) it cost more than it bought:
 *
 *   field weights   components                    pass  recall@10   MRR     camel
 *   10 / 1          .45 .25 .20  (before)          52      69%     0.5657   10/10
 *    6 / 2          .35 .20 .20 .15                51      67%     0.5394    9/10
 *   10 / 1          .30 .20 .20 .20  (shipped)     54      69%     0.5657   10/10
 *
 * The camel loss is the instructive one. On the single-token query
 * "<Component>Name", raising note to 2 promoted documents that merely MENTION the
 * component over documents TITLED after it, which is the opposite of what someone
 * typing a bare component name wants. A field weight applies the same
 * body-vs-title trade to a one-word handle lookup and to a three-word descriptive
 * query, and those two want opposite things — so the trade belongs in a component
 * that knows the query's shape. `bodyCoverage` below is gated on term count and
 * therefore cannot touch the handle lookup at all. It fixed the reported bug with
 * no family regressing.
 *
 * Keep src/lib/hybrid-search/README.md in step — tests/lib/hybrid-search-weights-doc.test.ts
 * fails if it drifts.
 */
export const BM25_FIELD_WEIGHTS = {
  title: 10.0,
  summary: 3.0,
  note: 1.0,
  meta: 2.0,
} as const;
export const BM25_SUB_RATIO = 0.6;
const BM25_WEIGHTS = [
  ...Object.values(BM25_FIELD_WEIGHTS),
  ...Object.values(BM25_FIELD_WEIGHTS).map((w) => w * BM25_SUB_RATIO),
].map((w) => w.toFixed(1)).join(', ');
const SUB_COLUMNS = '{tsub ssub nsub msub}';
/** Body streams: the fields whose content is authored prose rather than a
 *  handle. Title and meta are deliberately absent — the whole point of
 *  `bodyCoverage` is to be blind to them. */
const BODY_COLUMNS = '{summary note ssub nsub}';
const BODY_SUB_COLUMNS = '{ssub nsub}';

export const DEFAULT_DF_THRESHOLD = 0.15;
const DEFAULT_CANDIDATES = 250;
const DEFAULT_LIMIT = 20;
export const RECENCY_HALF_LIFE_DAYS = 180;
/** Lane over-fetch factor when a kind filter applies: filtering happens in JS
 *  AFTER the lane query (see the JOIN note below), so fetch extra headroom. */
const KIND_FILTER_OVERFETCH = 4;

/**
 * The four match components sum to RELEVANCE_MASS (0.90); identifier and recency
 * add the last 0.10, and cosine is added by the caller. That sum is load-bearing:
 * the demotion cap, span confidence and recall slot cap in index.ts were all
 * tuned against it. Moving mass BETWEEN these four is safe; changing the sum is
 * not, and hybrid-search-weights-doc.test.ts fails if it moves.
 *
 * 0.20 moved out of bm25 into `bodyCoverage` on 2026-09-21. bm25 here is a
 * reliable "did it match, in an important column" signal and an unreliable
 * graded-relevance signal: `f` saturates at k1+1, so a one-token title reaches
 * ~97% of the per-phrase ceiling on a single hit, while whole-row `D` penalizes
 * the documents where substantive work lives by 6-28x. An empty task titled
 * "Test <topic>" is therefore the bm25 BEST whatever the column weights are,
 * which is why no weight vector fixed the reported bug and why score mass had to
 * move to a component that row length cannot reach.
 */
export const RELEVANCE_MASS = 0.9;
export const W_STRICT = 0.3;
export const W_RELAXED = 0.2;
export const W_COVERAGE = 0.2;
/**
 * Query terms present in the BODY streams (summary/note), as a fraction of the
 * DISCRIMINATIVE terms. Length-independent by construction: presence, not count,
 * so no row-length normalization can bury it.
 *
 * Only terms that passed the df gate count. Without that filter this component
 * would degrade into "is this document long", because a long body contains every
 * glue word in the language and would collect the full 0.15 on any verbose
 * query. Reusing the df gate rather than a stopword list keeps it corpus-adaptive
 * and language-agnostic — a hardcoded English list would do nothing for CJK.
 */
export const W_BODY_COVERAGE = 0.2;
/** Below this, a query is a handle lookup ("<project> deploy"), where a bare
 *  task legitimately outranks a transcript that merely mentions the words, so
 *  body presence must not be demanded. Mirrors the ident-query gate below. */
export const BODY_COVERAGE_MIN_TERMS = 3;
export const W_IDENT = 0.07;
export const W_RECENCY = 0.03;
/** A doc matched by its OWN ref is the strongest possible signal: searching an
 *  exact id means the user wants THE doc, and its id usually appears nowhere
 *  in its own text — only prose QUOTING the id gets bm25 + coverage + ident
 *  (a stack topping out ≈1.33), so self-ownership must exceed that BY
 *  CONSTRUCTION, same semantics as the production reference lane. */
const W_SELF_IDENT = 1.5;
/** When the query IS an identifier (≤2 tokens), identifier ownership must
 *  dominate prose that quotes it; on longer queries idents stay a tiebreaker. */
const W_IDENT_ID_QUERY = 0.4;
/** Identifier-prefix matching (humans paste id/SHA prefixes): applied to
 *  tokens that look like identifiers, at a discount vs an exact match. */
const IDENT_PREFIX_MIN = 6;
const IDENT_PREFIX_STRENGTH = 0.7;
const IDENT_PREFIX_ROW_CAP = 64;

/** Identifier-shaped: long-enough and digit-bearing (ids, SHAs, CR numbers),
 *  or very long (pure-hex prefixes). Ordinary words never qualify, so prefix
 *  scans can't flood on prose tokens. */
function looksLikeIdentifier(token: string): boolean {
  if (token.length < IDENT_PREFIX_MIN) return false;
  return /[0-9]/.test(token) || token.length >= 10;
}

export interface KeywordSearchOptions {
  kinds?: string[];
  limit?: number;
  candidateLimit?: number;
  dfThreshold?: number;
  kindWeights?: Record<string, number>;
  /** Injected clock for deterministic tests. */
  now?: number;
}

export interface KeywordHit {
  docId: number;
  kind: string;
  ref: string;
  title: string;
  updatedAt: number;
  score: number;
  components: {
    bm25Strict: number;
    bm25Relaxed: number;
    coverage: number;
    /** Query terms present in summary/note, over the df-surviving terms.
     *  0 when the query is too short to demand body presence. */
    bodyCoverage: number;
    exactIdent: number;
    /** Matched by the doc's OWN ref (exact 1.0 / prefix-discounted). */
    selfIdent: number;
    recency: number;
  };
}

/** FTS5 string literal: double-quote wrapped, internal quotes doubled. */
function ftsQuote(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

function hasCjk(token: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]|[\ud840-\udbbf][\udc00-\udfff]/.test(token);
}

/** A query term: one orig token plus how it compiles in each lane. */
interface Term {
  token: string;
  /** Strict-lane expression (AND member). */
  strictExpr: string;
  /** The strict expression widened by the term's word forms (typo fixes,
   *  completions, inflections), for the widened lane (see wordForms). */
  widenedExpr?: string;
  /** The typed term itself, anywhere, sub included. */
  anyExpr: string;
  /** df-gate expression: the term in any spelling (compound, typo fix,
   *  completion), so a misspelled common word is gated like the word. */
  gateExpr: string;
  /** Coverage expression: the term or any one-token form of it (see
   *  compoundForms, wordForms), unguarded: coverage asks only "is it here in
   *  any form", and a bare OR is cheaper to probe. */
  coverExpr: string;
  /** Same match, restricted to the body streams (see BODY_COLUMNS). */
  bodyExpr: string;
  /** Phrase forms (a split compound), matched once over the whole index. */
  phraseFormsExpr?: string;
  bodyPhraseFormsExpr?: string;
  /** Relaxed-lane OR members (orig + sub parts / bigrams). */
  relaxedExprs: string[];
}

/**
 * Compound spellings: one name written as one word or as two. "dockhub" and
 * "Dock Hub" are the same name, and so are "setup"/"set up" and "timeout"/"time
 * out", but the tokenizer sees `dockhub` in one and `dock`, `hub` in the other, so
 * every lane missed the task titled "... Dock Hub KB sync" when the user typed
 * "dockhub sync" (2026-09-28), and the AI search, which judges only what this
 * engine hands it, never saw that task either. camelCase already bridged the gap
 * (`DockHub` indexes `dockhub` plus the sub parts `dock`, `hub`); a lowercase word
 * and a spaced pair have no shared token at all.
 *
 * The fix lives on the query side, as extra OR forms of a term, so the index is
 * untouched (joining every adjacent word pair at index time would roughly double
 * the sub streams of every transcript for a rare query shape):
 *   split  a single-word term also matches its two halves as an adjacent PHRASE
 *          ("dockhub" → "dock hub"), adjacency being what keeps it a compound and
 *          not two words anywhere in the doc;
 *   join   two adjacent query terms also match their concatenation as one token
 *          ("dock hub" → "dockhub"), credited to BOTH terms, so strict AND and
 *          coverage count the pair as present.
 * A form is kept only when the index holds it: the joined token, or the split
 * PHRASE itself, not merely its two halves (a bounded `LIMIT 1` probe each,
 * halves first as the cheap filter). Halves alone let noise through: this
 * index holds "ial", "uld" and "ion", so "credential" grew "credent ial"
 * and "should" grew "sho uld", phrases no doc contains, and each one still
 * cost a coverage probe. Long pasted queries skip this entirely: they have
 * enough other terms to match on, and each probe is a synchronous seek.
 */
export const COMPOUND_MIN_HALF = 2;
const COMPOUND_MAX_QUERY_TERMS = 8;
const COMPOUND_MAX_SPLITS_PER_TERM = 2;
/** Phrase probes per term: a long word has many splits whose halves exist. */
const COMPOUND_MAX_SPLIT_PROBES = 4;
const COMPOUND_MAX_FORMS = 12;
const PLAIN_WORD_RE = /^[\p{L}\p{N}]+$/u;

function compoundForms(
  origSeq: readonly string[],
  uniqueOrig: readonly string[],
  exists: (token: string) => boolean,
): Map<string, string[]> {
  const forms = new Map<string, string[]>();
  if (uniqueOrig.length > COMPOUND_MAX_QUERY_TERMS) return forms;
  let budget = COMPOUND_MAX_FORMS;
  const add = (token: string, expr: string): void => {
    const list = forms.get(token) ?? [];
    if (budget <= 0 || list.includes(expr)) return;
    list.push(expr);
    forms.set(token, list);
    budget--;
  };
  const plain = (token: string): boolean =>
    PLAIN_WORD_RE.test(token) && !hasCjk(token) && !/^\p{N}+$/u.test(token);

  // join: adjacent terms written as one word in the doc.
  for (let i = 0; i < origSeq.length - 1; i++) {
    const a = origSeq[i];
    const b = origSeq[i + 1];
    if (a === b || !plain(a) || !plain(b)) continue;
    const joined = a + b;
    if (!exists(joined)) continue;
    add(a, ftsQuote(joined));
    add(b, ftsQuote(joined));
  }

  // A joined token ("dock-hub", "dock_hub") names the same thing as its parts
  // written apart or run together; the FTS token is the joined form only.
  for (const token of uniqueOrig) {
    if (plain(token) || hasCjk(token)) continue;
    const parts = tokenize(token).sub;
    if (parts.length < 2) continue;
    if (parts.every(plain)) {
      if (parts.every(exists) && exists(parts.join(' '))) add(token, ftsQuote(parts.join(' ')));
      if (exists(parts.join(''))) add(token, ftsQuote(parts.join('')));
      continue;
    }
    // A version or date is written with any separator: "opus-4-8", "Opus 4.8"
    // and "claude-opus-4-8" all index the digit groups as adjacent parts, and
    // "2026-07-01" matches "2026/07/01". Never run together: "4.8" is not "48".
    // Only words and numbers between the separators: "mrik05mv-73ca" is an id.
    if (!token.split(/[-_.']+/).every((seg) => /^\p{L}+$/u.test(seg) || /^\p{N}+$/u.test(seg))) continue;
    const dotted: string[] = [];
    for (const part of parts) {
      const prev = dotted.length - 1;
      if (/^\p{N}+$/u.test(part) && prev >= 0 && /^[\p{N}.]+$/u.test(dotted[prev])) dotted[prev] += `.${part}`;
      else dotted.push(part);
    }
    for (const form of new Set([parts.join(' '), dotted.join(' ')])) {
      if (form !== token && exists(form)) add(token, ftsQuote(form));
    }
  }

  // split: a one-word term written as two adjacent words in the doc.
  for (const token of uniqueOrig) {
    if (!plain(token) || budget <= 0) continue;
    for (const phrase of splitPhrases(token, exists)) add(token, phrase);
  }
  return forms;
}

/** The two-word phrases a one-word token is written as in the index, most
 *  balanced split first ("dock|hub" before "do|ckhub"; "work|flow" beats
 *  "wo|rkflow"), since a real compound rarely hangs on a two-letter fragment. */
function splitPhrases(token: string, exists: (token: string) => boolean): string[] {
  if (token.length < COMPOUND_MIN_HALF * 2) return [];
  const splits: Array<[string, string]> = [];
  for (let k = COMPOUND_MIN_HALF; k <= token.length - COMPOUND_MIN_HALF; k++) {
    splits.push([token.slice(0, k), token.slice(k)]);
  }
  splits.sort((x, y) => Math.min(y[0].length, y[1].length) - Math.min(x[0].length, x[1].length));
  const kept: string[] = [];
  let probes = 0;
  for (const [head, tail] of splits) {
    if (kept.length >= COMPOUND_MAX_SPLITS_PER_TERM || probes >= COMPOUND_MAX_SPLIT_PROBES) break;
    if (!exists(head) || !exists(tail)) continue;
    probes++;
    if (exists(`${head} ${tail}`)) kept.push(ftsQuote(`${head} ${tail}`));
  }
  return kept;
}

/**
 * Word forms: the same word reaching the index in a shape no tokenizer rule
 * joins, found by perturbing real titles (scripts/search-robustness-eval.mjs,
 * 2026-09-28). Keyword-only, a doc whose control query ranked it top-3 dropped
 * out of the top 8 for 13-21% of these rewrites:
 *   inflection  "doctors" for "doctor", "failed" for "fail", "syncing" for "sync"
 *   typo        "failled", "notifcation": a word the index has (almost) never
 *               seen, one edit away from a word it holds hundreds of times
 *   unfinished  "sync fai": the last word cut off where the typing paused
 * Each becomes an extra OR form of the term, kept only when the index holds
 * it and guarded so a doc that has the typed word earns nothing extra. Unlike a
 * compound spelling it never competes with the typed word in lane A: a doc
 * reached only through a word form scores in lane A' at a discount. Candidates
 * come from the index's own vocabulary (a TEMP
 * fts5vocab view, so the file's schema is untouched): one IN lookup for every
 * term's inflections, one more per rare term for its edit-distance-1 spellings
 * (~600 candidates for an 11-letter word, ~13ms), one bounded range scan for an
 * unknown last word. The semantic lane was meant to rescue these, but its
 * 150ms deadline loses to the embed model on most interactive queries.
 */
const WORD_RE = /^[a-z]+$/;
const INFLECTION_MIN_WORD = 4;
const INFLECTION_MAX = 3;
/** An inflection over the df gate is kept only while it is less than this many
 *  times as common as the typed word (see wordForms). */
const INFLECTION_COMMON_RATIO = 2;
const TYPO_MIN_WORD = 5;
/** At or under this doc count a word is a typo candidate: the index has
 *  (almost) never seen it. Not zero: a typo the user made before is in the
 *  index too ("fialed" sits in two transcripts). */
const TYPO_MAX_DF = 2;
/** A correction must be this many times more common than the typed word, and
 *  in at least TYPO_MIN_FIX_DF docs. */
const TYPO_MIN_GAIN = 10;
const TYPO_MIN_FIX_DF = 5;
const TYPO_MAX_FIXES = 2;
/** One-edit neighbours checked against the query's other words. */
const TYPO_CANDIDATES = 12;
const COMPLETION_MIN_PREFIX = 3;
/** Ceiling of the strict score a doc earns only through a word form (another
 *  spelling or inflection of a query word) or without a query's common words:
 *  below any doc matching as typed. */
const WIDENED_STRICT_SHARE = 0.8;
/** Queries this long may pass the strict lane without their common words
 *  (lane A''); shorter ones are handle lookups, like BODY_COVERAGE_MIN_TERMS. */
const CORE_MIN_TERMS = 4;
/** Coverage weight of a term as common as the df gate allows (see termWeight). */
const TERM_WEIGHT_FLOOR = 0.1;
/** Vocabulary rows a completion scan may read (a 3-letter range can span
 *  thousands of terms; the scan is ~3µs per term). */
const COMPLETION_SCAN = 3000;
const COMPLETION_CANDIDATES = 16;
/** When none of the commonest endings occurs with the rest of the query, the
 *  next ones are checked: "teeth floss wee" means "weeds" (1 doc), which sits
 *  far below "week" and "weekly" by doc count. */
const COMPLETION_CANDIDATES_WIDE = 48;
const COMPLETION_MAX = 5;
/** A last word in at most this many docs may still be unfinished (see wordForms). */
const COMPLETION_MAX_DF = 20;
/** Co-occurrence counts saturate here: ordering, not an exact count. */
const COMPLETION_CONTEXT_CAP = 50;
const VOCAB_TABLE = 'temp.hybrid_search_vocab';
const VOCAB_CHUNK = 500;
const vocabReady = new WeakSet<SearchDb>();

function ensureVocab(db: SearchDb): boolean {
  if (vocabReady.has(db)) return true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VOCAB_TABLE} USING fts5vocab(main, 'doc_fts', 'row')`);
    vocabReady.add(db);
    return true;
  } catch {
    return false;
  }
}

/** Doc counts for the given terms (absent terms are absent from the map). */
function vocabCounts(db: SearchDb, terms: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const unique = [...new Set(terms)];
  for (let i = 0; i < unique.length; i += VOCAB_CHUNK) {
    const chunk = unique.slice(i, i + VOCAB_CHUNK);
    const rows = db.prepare(
      `SELECT term, doc FROM ${VOCAB_TABLE} WHERE term IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as Array<{ term: string; doc: number }>;
    for (const row of rows) out.set(row.term, row.doc);
  }
  return out;
}

/** Regular English inflections of a lowercase word, both directions. */
export function inflections(word: string): string[] {
  const out = new Set<string>();
  const stems = new Set<string>([word]);
  if (word.endsWith('ies') && word.length > 4) stems.add(`${word.slice(0, -3)}y`);
  else if (/(?:s|x|z|ch|sh)es$/.test(word)) stems.add(word.slice(0, -2));
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) stems.add(word.slice(0, -1));
  if (word.endsWith('ing') && word.length >= 6) {
    const s = word.slice(0, -3);
    stems.add(s);
    stems.add(`${s}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) stems.add(s.slice(0, -1));
  }
  if (word.endsWith('ed') && word.length >= 5) {
    const s = word.slice(0, -2);
    stems.add(s);
    stems.add(word.slice(0, -1));
    if (/([b-df-hj-np-tv-z])\1$/.test(s)) stems.add(s.slice(0, -1));
    if (s.endsWith('i')) stems.add(`${s.slice(0, -1)}y`);
  }
  for (const stem of stems) {
    // A stem under 4 letters is where suffix stripping invents words
    // ("string" → "str", "thing" → "th").
    if (stem.length < INFLECTION_MIN_WORD) continue;
    out.add(stem);
    const bare = stem.endsWith('e') ? stem.slice(0, -1) : stem;
    out.add(`${bare}ing`);
    out.add(stem.endsWith('e') ? `${stem}d` : `${stem}ed`);
    if (/(?:s|x|z|ch|sh)$/.test(stem)) out.add(`${stem}es`);
    else if (/[^aeiou]y$/.test(stem)) out.add(`${stem.slice(0, -1)}ies`);
    else out.add(`${stem}s`);
  }
  out.delete(word);
  return [...out].filter((w) => w.length >= INFLECTION_MIN_WORD);
}

/** Every string one edit (delete, swap, replace, insert) from `word`. */
function editsOne(word: string): string[] {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const out = new Set<string>();
  for (let i = 0; i <= word.length; i++) {
    const head = word.slice(0, i);
    const tail = word.slice(i);
    if (tail) out.add(head + tail.slice(1));
    if (tail.length > 1) out.add(head + tail[1] + tail[0] + tail.slice(2));
    for (const c of letters) {
      if (tail) out.add(head + c + tail.slice(1));
      out.add(head + c + tail);
    }
  }
  out.delete(word);
  return [...out];
}

interface WordForms {
  /** Readings of a word the index barely holds: its inflections, typo fixes
   *  and completions, and the split phrases of the first two. They widen the
   *  strict lane (see lane A' in searchKeyword), count for coverage and the df
   *  gate, and join the relaxed lane, where a query whose only rare word is
   *  misspelled would otherwise match nothing. */
  spelling: Map<string, string[]>;
  /** Other inflections of a word the index does hold: lane A' and coverage
   *  only, so "failed" keeps its own place in the relaxed lane. */
  inflected: Map<string, string[]>;
}

function wordForms(
  db: SearchDb,
  origSeq: readonly string[],
  uniqueOrig: readonly string[],
  dfCap: number,
  exists: (token: string) => boolean,
): WordForms {
  const out: WordForms = { spelling: new Map(), inflected: new Map() };
  if (uniqueOrig.length > COMPOUND_MAX_QUERY_TERMS || !ensureVocab(db)) return out;
  const words = uniqueOrig.filter((t) => WORD_RE.test(t) && t.length >= COMPLETION_MIN_PREFIX);
  if (words.length === 0) return out;
  const candidates = new Map(words.map((w) => [w, w.length >= INFLECTION_MIN_WORD ? inflections(w) : []]));
  let counts: Map<string, number>;
  try {
    counts = vocabCounts(db, [...words, ...[...candidates.values()].flat()]);
  } catch {
    return out;
  }
  const df = (t: string): number => counts.get(t) ?? 0;
  const byDf = (a: [string, number], b: [string, number]) => b[1] - a[1];
  const last = origSeq[origSeq.length - 1];
  for (const word of words) {
    const own = df(word);
    // A word the index barely holds is read through its forms, which then carry
    // the term the way a typo fix does. For a word it does hold, a form that is
    // both as common as the df gate rejects and far commoner than the word is
    // another word in practice: "filing" → "file" (27x) and "times" → "time"
    // (3x) matched thousands of docs, so any long transcript passed lane A' and
    // the term's coverage weight fell to the floor (a tax filing query lost to
    // docs about files). "alarms" → "alarm" (1.9x) is the same word; and
    // "failuring" has no reading but "failure", however common.
    const rare = own <= TYPO_MAX_DF;
    const inflected = (candidates.get(word) ?? []).map((f) => [f, df(f)] as [string, number])
      .filter(([, n]) => n > 0 && (rare || n <= dfCap || n < INFLECTION_COMMON_RATIO * own))
      .sort(byDf).slice(0, INFLECTION_MAX).map(([f]) => f);
    if (!rare) {
      if (inflected.length > 0) out.inflected.set(word, inflected.map(ftsQuote));
      // A last word a few docs hold is also read as cut off where the typing
      // paused, when far commoner words begin with it: "todo sync fai" meant
      // "failed", and the 9 docs holding a stray "fai" took the top of the
      // list on the rarity weight alone.
      if (word === last && own <= COMPLETION_MAX_DF) {
        try {
          const context = words.filter((w) => w !== word && df(w) > 0);
          const ends = completions(db, word, own, context).filter((f) => !inflected.includes(f));
          if (ends.length > 0) out.spelling.set(word, ends.map(ftsQuote));
        } catch {
          // The term keeps its inflections.
        }
      }
      continue;
    }
    const spelling: string[] = [...inflected];
    const split: string[] = [];
    const context = words.filter((w) => w !== word && df(w) > 0);
    try {
      if (word.length >= TYPO_MIN_WORD) spelling.push(...spellingFixes(db, word, own, context));
      // A form is written apart in the index too, as the typed word would be:
      // "dockhuub" → "dockhub" → "dock hub" (camelCase sub parts).
      for (const form of spelling) split.push(...splitPhrases(form, exists));
      if (word === last) spelling.push(...completions(db, word, own, context));
    } catch {
      // A vocabulary hiccup costs this term the rest of its forms, never the query.
    }
    const spelled = [...new Set(spelling)].filter((f) => f !== word);
    if (spelled.length > 0) out.spelling.set(word, [...spelled.map(ftsQuote), ...new Set(split)]);
  }
  return out;
}

/** Words one edit from a word the index barely holds. With other query words
 *  to go on, the ones that occur alongside them win, however rare ("ddb looes
 *  alarm" → "loose", not the commoner "looks"; a misspelled rare name still
 *  finds its one task). With nothing else to go on, only a much commoner word
 *  counts as the fix. */
function spellingFixes(db: SearchDb, word: string, own: number, context: readonly string[]): string[] {
  const near = [...vocabCounts(db, editsOne(word))]
    .filter(([, n]) => n > own)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TYPO_CANDIDATES);
  if (context.length > 0) {
    const together = alongside(db, near, context, true);
    if (together.length > 0) return together.slice(0, TYPO_MAX_FIXES);
  }
  const minFix = Math.max(TYPO_MIN_FIX_DF, TYPO_MIN_GAIN * (own + 1));
  return near.filter(([, n]) => n >= minFix).slice(0, TYPO_MAX_FIXES).map(([w]) => w);
}

/** `candidates` (term, doc count) that occur in some doc with the `context`
 *  words, most often first; `byShare` orders them by the share of the
 *  candidate's own docs that hold the context instead. A spelling fix wants
 *  the share: the raw count favoured whatever is common everywhere, and for
 *  "ddb looes alarm" "looks" sat beside ddb and alarm in 50 docs (of 725),
 *  "loose" in 7 (of 60), with only two fixes kept. A completion wants the
 *  count: the commonest ending is usually the word, and the share ordering
 *  cost the prefix class 4 of its top-8 hits. */
function alongside(
  db: SearchDb,
  candidates: ReadonlyArray<readonly [string, number]>,
  context: readonly string[],
  byShare = false,
): string[] {
  const rest = context.slice(0, 2).map(ftsQuote).join(' AND ');
  const together = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM doc_fts WHERE doc_fts MATCH ? LIMIT ${COMPLETION_CONTEXT_CAP})`,
  );
  return candidates
    .map(([term, docs], order) => {
      const n = (together.get(`${ftsQuote(term)} AND ${rest}`) as { n: number }).n;
      return { term, order, n, share: n / Math.max(1, docs) };
    })
    .filter((c) => c.n > 0)
    .sort((a, b) => (byShare ? b.share - a.share || b.n - a.n : b.n - a.n) || a.order - b.order)
    .map((c) => c.term);
}

/** Likely endings of an unfinished last word ("sync fai" → "failed"): the
 *  commonest vocabulary terms it begins, ordered by how often they occur
 *  alongside the query's other words, and only when the commonest is at least
 *  TYPO_MIN_GAIN times as common as the word: a finished word like "sync" or
 *  "doc" stays as typed. They score in lane A', below the docs holding the
 *  word itself: in lane A, "quest" (in 3 docs) completed to "question" and
 *  buried the task about the quest. */
function completions(db: SearchDb, prefix: string, own: number, others: readonly string[]): string[] {
  const rows = (db.prepare(
    `SELECT term, doc FROM (SELECT term, doc FROM ${VOCAB_TABLE} WHERE term > ? AND term < ? LIMIT ${COMPLETION_SCAN})
     ORDER BY doc DESC LIMIT ${COMPLETION_CANDIDATES_WIDE}`,
  ).all(prefix, `${prefix}\uffff`) as Array<{ term: string; doc: number }>)
    .filter((r) => WORD_RE.test(r.term));
  if (rows.length === 0 || rows[0].doc < TYPO_MIN_GAIN * (own + 1)) return [];
  const counted = rows.map((r) => [r.term, r.doc] as const);
  const head = counted.slice(0, COMPLETION_CANDIDATES);
  if (others.length === 0) return head.slice(0, COMPLETION_MAX).map(([w]) => w);
  let together = alongside(db, head, others);
  if (together.length === 0) together = alongside(db, counted.slice(COMPLETION_CANDIDATES), others);
  return (together.length > 0 ? together : head.map(([w]) => w)).slice(0, COMPLETION_MAX);
}

function compileTerm(
  token: string,
  forms: readonly string[] = [],
  variants: readonly string[] = [],
  spelling: ReadonlySet<string> = new Set(),
): Term {
  if (hasCjk(token)) {
    // The whole-run token lives in orig columns, but matching happens through
    // the ordered bigram stream: phrase for precision, OR bag for recall.
    const bigrams = tokenize(token).sub;
    const phrase = `${SUB_COLUMNS}:"${bigrams.map((b) => b.replaceAll('"', '""')).join(' ')}"`;
    const bigramPhrase = bigrams.map((b) => b.replaceAll('"', '""')).join(' ');
    return {
      token,
      strictExpr: phrase,
      anyExpr: phrase,
      gateExpr: phrase,
      coverExpr: phrase,
      bodyExpr: `${BODY_SUB_COLUMNS}:"${bigramPhrase}"`,
      relaxedExprs: bigrams.map((b) => `${SUB_COLUMNS}:${ftsQuote(b)}`),
    };
  }
  const quoted = ftsQuote(token);
  const subParts = tokenize(token).sub;
  // Each form counts only where the term itself is absent. Unguarded, a
  // camelCase doc matched twice for one occurrence (`EventOperator` indexes the
  // joined token AND its sub parts), bm25 summed both, and on
  // "kind event operator reconciler" two notes that merely mention the
  // component rose above the task named for it. Guarded, a doc earns one form's
  // credit per term, so the forms find new docs without reranking the old ones.
  const guarded = forms.map((form) => `(${form} NOT ${quoted})`);
  // One-token forms ride the bounded per-candidate probe with the term itself;
  // phrase forms are matched once over the whole index (see probeSet).
  const tokenForms = [...forms, ...variants].filter((form) => !form.includes(' '));
  const phraseForms = [...forms, ...variants].filter((form) => form.includes(' '));
  const coverExpr = tokenForms.length > 0 ? `(${[quoted, ...tokenForms].join(' OR ')})` : quoted;
  const phraseFormsExpr = phraseForms.length > 0 ? `(${phraseForms.join(' OR ')})` : undefined;
  const strictExpr = guarded.length > 0 ? `(${[quoted, ...guarded].join(' OR ')})` : quoted;
  const widened = variants.map((form) => `(${form} NOT ${quoted})`);
  const spellings = [...forms, ...variants.filter((form) => spelling.has(form))];
  return {
    token,
    strictExpr,
    ...(widened.length > 0 ? { widenedExpr: `(${[strictExpr, ...widened].join(' OR ')})` } : {}),
    anyExpr: quoted,
    gateExpr: spellings.length > 0 ? `(${[quoted, ...spellings].join(' OR ')})` : quoted,
    coverExpr,
    bodyExpr: `${BODY_COLUMNS}:${coverExpr}`,
    ...(phraseFormsExpr
      ? { phraseFormsExpr, bodyPhraseFormsExpr: `${BODY_COLUMNS}:${phraseFormsExpr}` }
      : {}),
    relaxedExprs: [
      quoted,
      ...subParts.map((p) => ftsQuote(p)),
      ...guarded,
      ...variants.filter((form) => spelling.has(form)).map((form) => `(${form} NOT ${quoted})`),
    ],
  };
}

interface LaneRow {
  rowid: number;
  s: number;
}

export function searchKeyword(
  db: SearchDb,
  typed: string,
  options: KeywordSearchOptions = {},
): KeywordHit[] {
  const query = foldWidth(typed);
  const origSeq = tokenize(query).orig; // ordered — adjacency feeds the pair lane
  const uniqueOrig = [...new Set(origSeq)];
  if (uniqueOrig.length === 0) return [];
  const existsStmt = db.prepare(`SELECT 1 FROM doc_fts WHERE doc_fts MATCH ? LIMIT 1`);
  const known = new Map<string, boolean>();
  const exists = (token: string): boolean => {
    let hit = known.get(token);
    if (hit === undefined) {
      try {
        hit = existsStmt.get(ftsQuote(token)) !== undefined;
      } catch {
        hit = false;
      }
      known.set(token, hit);
    }
    return hit;
  };
  const limit = options.limit ?? DEFAULT_LIMIT;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATES;
  const dfThreshold = options.dfThreshold ?? DEFAULT_DF_THRESHOLD;
  const now = options.now ?? Date.now();

  // ── document frequency gate (R1): the cap, needed by the word forms too ──
  const corpusSize = (db.prepare(`SELECT COUNT(*) AS n FROM doc`).get() as { n: number }).n;
  if (corpusSize === 0) return [];
  const dfCap = Math.max(1, Math.ceil(corpusSize * dfThreshold));

  const forms = compoundForms(origSeq, uniqueOrig, exists);
  const words = wordForms(db, origSeq, uniqueOrig, dfCap, exists);
  const terms = uniqueOrig.map((token) => compileTerm(
    token,
    forms.get(token),
    [...(words.spelling.get(token) ?? []), ...(words.inflected.get(token) ?? [])],
    new Set(words.spelling.get(token)),
  ));

  // Kind filtering happens in JS AFTER the lane query. Joining doc inside the
  // lane forced bm25() across the whole OR match set before the LIMIT:
  // measured 371ms joined vs 1.8ms bare on a 12k corpus (rowid IN (subquery)
  // was 184ms). Loading the allowed-id Set costs ~0.3ms.
  const allowedIds: Set<number> | null = options.kinds?.length
    ? new Set((db.prepare(
        `SELECT id FROM doc WHERE kind IN (${options.kinds.map(() => '?').join(',')})`,
      ).all(...options.kinds) as Array<{ id: number }>).map((r) => r.id))
    : null;

  const laneFetch = allowedIds
    ? candidateLimit * KIND_FILTER_OVERFETCH
    : candidateLimit;
  const laneStmt = db.prepare(
    `SELECT rowid, bm25(doc_fts, ${BM25_WEIGHTS}) AS s
     FROM doc_fts WHERE doc_fts MATCH ? ORDER BY s LIMIT ?`,
  );
  const runLane = (expr: string): LaneRow[] => {
    let rows: LaneRow[];
    try {
      rows = laneStmt.all(expr, laneFetch) as LaneRow[];
    } catch {
      // A term the FTS parser still rejects must degrade to "no results from
      // this lane", never to a thrown 500.
      return [];
    }
    if (allowedIds) rows = rows.filter((r) => allowedIds.has(r.rowid));
    return rows.slice(0, candidateLimit);
  };

  // ── document frequency gate (R1): bounded count per term ──
  const dfStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM doc_fts WHERE doc_fts MATCH ? LIMIT ${dfCap + 1})`,
  );
  /** Doc count of an expression, capped at dfCap + 1 (a bounded scan). */
  const dfCounts = new Map<string, number>();
  const cappedDf = (expr: string): number => {
    let n = dfCounts.get(expr);
    if (n === undefined) {
      try {
        n = (dfStmt.get(expr) as { n: number }).n;
      } catch {
        n = dfCap + 1;
      }
      dfCounts.set(expr, n);
    }
    return n;
  };
  const overDf = (term: Term): boolean => cappedDf(term.gateExpr) > dfCap;
  /**
   * How much a term counts toward coverage: its rarity in any of its forms,
   * as log(dfCap / df), so a term as common as the df gate allows counts
   * TERM_WEIGHT_FLOOR and a term in one doc counts ~7. Unweighted, a daily log
   * that mentions "where", "is", "the", "task" and "cook" covered 5 of the 6
   * terms of "where is the cook rice task" and outranked the task titled
   * "Cook Rice" (2 of 6). A query of equally common terms stays uniform.
   * Undefined for a term no doc holds in any form (see termWeights).
   */
  const coverDf = (term: Term): number =>
    cappedDf(term.phraseFormsExpr ? `(${term.coverExpr} OR ${term.phraseFormsExpr})` : term.coverExpr);
  const termWeight = (term: Term): number | undefined => {
    const n = Math.min(coverDf(term), dfCap);
    return n === 0 ? undefined : Math.log((dfCap + 1) / (n + 1)) + TERM_WEIGHT_FLOOR;
  };
  /** A term no doc holds says nothing about rarity, and weighing it as the
   *  rarest term there is sank every other term: in a query of a Chinese
   *  phrase plus "filing", the whole CJK run matched no doc, and "filing" fell
   *  to 1% coverage. It counts
   *  as an average term of the query instead, as it did before weighting. */
  const termWeights = (): number[] => {
    const raw = terms.map(termWeight);
    const known = raw.filter((w): w is number => w !== undefined);
    const mean = known.length > 0 ? known.reduce((sum, w) => sum + w, 0) / known.length : 1;
    return raw.map((w) => w ?? mean);
  };

  // ── lane A: strict AND ──
  const strictRows = runLane(terms.map((t) => t.strictExpr).join(' AND '));

  // ── lane A': strict AND over each term's word forms too ──
  // Reaches the doc that says "book doctor" for "book doctors", or "failed" for
  // "failled", without letting it outscore the docs that say what was typed:
  // bm25 scores a form on its own idf, so a rarer form ("fail" beside the
  // typed "failed") or a busier one ("question" for "quest") outranked the
  // exact matches when both sat in lane A. Its rows earn a discounted strict
  // score, and only where lane A did not already score them.
  const widenedRows = terms.some((t) => t.widenedExpr)
    ? runLane(terms.map((t) => t.widenedExpr ?? t.strictExpr).join(' AND '))
    : [];
  // ── lane A'': strict AND over the words of a long query that discriminate ──
  // "where is the upload download task" made lane A demand "where", "is" and
  // "the", so only long transcripts could pass it and the task that says
  // "upload/download" ranked below them. A short query keeps every word: in
  // "walnut deploy" the common word is the name.
  const coreTerms = terms.length >= CORE_MIN_TERMS ? terms.filter((t) => !overDf(t)) : [];
  const coreRows = coreTerms.length > 0 && coreTerms.length < terms.length
    ? runLane(coreTerms.map((t) => t.widenedExpr ?? t.strictExpr).join(' AND '))
    : [];

  // ── lane B: relaxed OR, high-df terms excluded ──
  let relaxedTerms = terms.filter((t) => !overDf(t));

  // Gated-pair phrases: the df gate keeps common tokens out of the OR lane,
  // but a doc whose ONLY overlap with the query is those common tokens (title
  // "…on load-test cluster" vs "…load test cluster") becomes unreachable
  // through every lane — semantics can't rescue a doc that never enters the
  // candidate pool. An ADJACENT PAIR of gated terms is selective again
  // (df("load test") ≪ df(load)), matches the sub streams of joined
  // identifiers ("load test" hits load-test's subwords), and each phrase is
  // df-gated itself so a genuinely common collocation stays out.
  // Each candidate pair costs one bounded df probe on this synchronous path,
  // so cap the lane: a pasted paragraph must not turn into dozens of probes
  // (measured +48% on a 30-common-token query with no cap).
  const MAX_PAIR_PHRASES = 8;
  const termByToken = new Map(terms.map((t) => [t.token, t]));
  const pairPhrases: string[] = [];
  const seenPhrases = new Set<string>();
  for (let i = 0; i < origSeq.length - 1 && pairPhrases.length < MAX_PAIR_PHRASES; i++) {
    const a = termByToken.get(origSeq[i]);
    const b = termByToken.get(origSeq[i + 1]);
    if (!a || !b || a === b) continue;
    if (hasCjk(a.token) || hasCjk(b.token)) continue; // CJK is phrase-matched already
    if (!overDf(a) || !overDf(b)) continue; // a rare member already carries the pair
    const phrase = ftsQuote(`${a.token} ${b.token}`);
    if (seenPhrases.has(phrase)) continue;
    seenPhrases.add(phrase);
    try {
      if ((dfStmt.get(phrase) as { n: number }).n > dfCap) continue;
    } catch {
      continue;
    }
    pairPhrases.push(phrase);
  }

  if (relaxedTerms.length === 0 && pairPhrases.length === 0) {
    const longest = [...terms].sort((a, b) => b.token.length - a.token.length)[0];
    relaxedTerms = [longest];
  }
  const relaxedRows = runLane(
    [...relaxedTerms.flatMap((t) => t.relaxedExprs), ...pairPhrases].join(' OR '),
  );

  // ── identifier hits: each token, plus the whole trimmed query.
  // These SEED the candidate set — an id pasted into the search box matches
  // nothing in the FTS lanes (ids live in the ident table, not the token
  // streams), so boost-only ident scoring could never surface such a doc. ──
  const identTokens = [...new Set([
    ...uniqueOrig,
    query.trim().toLowerCase(),
  ])].filter(Boolean);
  /** docId → match strength: 1.0 exact, IDENT_PREFIX_STRENGTH prefix. */
  const identMatch = new Map<number, number>();
  for (const r of db.prepare(
    `SELECT doc_id FROM ident WHERE token IN (${identTokens.map(() => '?').join(',')})`,
  ).all(...identTokens) as Array<{ doc_id: number }>) {
    identMatch.set(r.doc_id, 1);
  }
  const prefixTokens = identTokens.filter(looksLikeIdentifier);
  for (const tok of prefixTokens) {
    // Range scan rides the ident PK index; the row cap keeps a short common
    // prefix from flooding the candidate set.
    for (const r of db.prepare(
      `SELECT doc_id FROM ident WHERE token > ? AND token < ? LIMIT ${IDENT_PREFIX_ROW_CAP}`,
    ).all(tok, `${tok}￿`) as Array<{ doc_id: number }>) {
      if (!identMatch.has(r.doc_id)) identMatch.set(r.doc_id, IDENT_PREFIX_STRENGTH);
    }
  }
  // Self-ownership seeding: a doc found by its OWN ref (exact or prefix) must
  // enter the candidate set even when its id appears in no ident row and no
  // text field. 12k-row ref scans measure <1ms; only identifier-shaped tokens
  // run one.
  const selfMatch = new Map<number, number>();
  for (const tok of prefixTokens) {
    for (const r of db.prepare(
      `SELECT id, ref FROM doc WHERE ref >= ? AND ref < ? LIMIT 16`,
    ).all(tok, `${tok}￿`) as Array<{ id: number; ref: string }>) {
      const refLc = r.ref.toLowerCase();
      if (refLc === tok) selfMatch.set(r.id, 1);
      else if (refLc.startsWith(tok)) {
        selfMatch.set(r.id, Math.max(selfMatch.get(r.id) ?? 0, IDENT_PREFIX_STRENGTH));
      }
    }
  }
  const identDocIds = new Set<number>([...identMatch.keys(), ...selfMatch.keys()]);

  // ── merge candidates + normalize bm25 (fts5 bm25 is negative-better) ──
  const candidates = new Map<number, { strict?: number; widened?: number; core?: number; relaxed?: number }>();
  for (const row of strictRows) {
    candidates.set(row.rowid, { strict: row.s });
  }
  for (const row of widenedRows) {
    if (!candidates.has(row.rowid)) candidates.set(row.rowid, { widened: row.s });
  }
  for (const row of coreRows) {
    if (!candidates.has(row.rowid)) candidates.set(row.rowid, { core: row.s });
  }
  for (const row of relaxedRows) {
    const entry = candidates.get(row.rowid);
    if (entry) entry.relaxed = row.s;
    else candidates.set(row.rowid, { relaxed: row.s });
  }
  for (const docId of identDocIds) {
    if (allowedIds && !allowedIds.has(docId)) continue;
    if (!candidates.has(docId)) candidates.set(docId, {});
  }
  if (candidates.size === 0) return [];
  const bestStrict = Math.min(...strictRows.map((r) => r.s), 0);
  const bestRelaxed = Math.min(...relaxedRows.map((r) => r.s), 0);
  const bestWidened = Math.min(...widenedRows.map((r) => r.s), 0);
  const bestCore = Math.min(...coreRows.map((r) => r.s), 0);
  const norm = (s: number | undefined, best: number): number =>
    s === undefined || best === 0 ? 0 : Math.max(0, Math.min(1, s / best));

  // ── doc rows ──
  const ids = [...candidates.keys()];
  const docRows = db.prepare(
    `SELECT id, kind, ref, title, updated_at FROM doc WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<{ id: number; kind: string; ref: string; title: string; updated_at: number }>;

  // ── coverage sets, bounded to the candidates ──
  const idList = ids.join(',');
  const coverStmt = db.prepare(
    `SELECT rowid FROM doc_fts WHERE doc_fts MATCH ? AND rowid IN (${idList})`,
  );
  // A term's compound forms are matched ONCE against the whole index and
  // intersected here, never through `rowid IN`: that path re-evaluates the
  // expression per id, and a phrase pays a position-list seek each time (a
  // "dock hub"-shaped phrase over two common halves: 26ms over 250 ids, vs 2ms
  // for every match in a 12k-doc index). Probed per id, the forms had tripled
  // the latency of descriptive queries.
  const formRows = new Map<string, Set<number>>();
  const formStmt = db.prepare(`SELECT rowid FROM doc_fts WHERE doc_fts MATCH ?`);
  const rowsOfForms = (expr: string): Set<number> => {
    let rows = formRows.get(expr);
    if (!rows) {
      try {
        rows = new Set((formStmt.all(expr) as Array<{ rowid: number }>).map((r) => r.rowid));
      } catch {
        rows = new Set();
      }
      formRows.set(expr, rows);
    }
    return rows;
  };
  // `rowid IN` evaluates the expression once per id: ~5-10ms over 250 ids for
  // one token whatever its df, 20-70ms for a common word OR-ed with its
  // inflections. Reading every doc an expression matches costs ~0.05ms (1 doc)
  // to ~2ms (1,800 docs), ~8ms for a word in half the index. So only a bare
  // token as common as the df gate rejects keeps the per-id path, whose cost
  // stays flat as the index grows.
  const probeSet = (expr: string, phraseFormsExpr: string | undefined, perId: boolean): Set<number> => {
    let found: Set<number>;
    if (!perId) {
      const all = rowsOfForms(expr);
      found = new Set(ids.filter((id) => all.has(id)));
    } else {
      try {
        found = new Set((coverStmt.all(expr) as Array<{ rowid: number }>).map((r) => r.rowid));
      } catch {
        found = new Set();
      }
    }
    if (phraseFormsExpr) {
      const viaForms = rowsOfForms(phraseFormsExpr);
      for (const id of ids) if (viaForms.has(id)) found.add(id);
    }
    return found;
  };
  const termSets = new Map<string, Set<number>>();
  const perId = (term: Term): boolean => term.coverExpr === ftsQuote(term.token) && coverDf(term) > dfCap;
  for (const term of terms) termSets.set(term.token, probeSet(term.coverExpr, term.phraseFormsExpr, perId(term)));

  // ── body coverage sets, same bounded probe, restricted to summary/note ──
  // Only the DISCRIMINATIVE terms participate: a term the df gate rejected is
  // present in every long body, so counting it would turn this component into a
  // document-length bonus, which is the exact bias it exists to cancel.
  const bodyTerms = terms.length >= BODY_COVERAGE_MIN_TERMS
    ? terms.filter((t) => !overDf(t))
    : [];
  const bodyTermSets = new Map<string, Set<number>>();
  for (const term of bodyTerms) {
    bodyTermSets.set(term.token, probeSet(term.bodyExpr, term.bodyPhraseFormsExpr, perId(term)));
  }

  // ── score ──
  // Identifier-query detection: on a 1-2 token query the identifier IS the
  // intent, so ownership outweighs prose quoting it.
  const wIdent = terms.length <= 2 && prefixTokens.length > 0 ? W_IDENT_ID_QUERY : W_IDENT;
  const weights = termWeights();
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  // A doc whose title is the query's words, or begins with them (the last one
  // perhaps unfinished), is what the query names, so body presence is not
  // asked of it, as for a handle lookup. A task's note rarely repeats its own
  // title: "Open Knowledge base" typed in full lost to 600 docs that discuss
  // knowledge bases, and the first three words of a task's name found it first
  // 45% of the time. The empty stub body coverage exists for, "Test <topic>",
  // neither is nor begins with "<topic>".
  const queryWords = [...uniqueOrig].sort().join(' ');
  const lastAt = origSeq.length - 1;
  const namedByQuery = (title: string): boolean => {
    const words = tokenize(foldWidth(title)).orig;
    return origSeq.every((token, i) => (i === lastAt ? words[i]?.startsWith(token) : words[i] === token))
      || [...new Set(words)].sort().join(' ') === queryWords;
  };
  const hits: KeywordHit[] = [];
  for (const row of docRows) {
    const lanes = candidates.get(row.id)!;
    let covered = 0;
    terms.forEach((term, i) => {
      if (termSets.get(term.token)?.has(row.id)) covered += weights[i];
    });
    let bodyCovered = 0;
    for (const term of bodyTerms) {
      if (bodyTermSets.get(term.token)?.has(row.id)) bodyCovered++;
    }
    const components = {
      bm25Strict: lanes.strict !== undefined
        ? norm(lanes.strict, bestStrict)
        : lanes.widened !== undefined
          ? WIDENED_STRICT_SHARE * norm(lanes.widened, bestWidened)
          : WIDENED_STRICT_SHARE * norm(lanes.core, bestCore),
      bm25Relaxed: norm(lanes.relaxed, bestRelaxed),
      coverage: totalWeight > 0 ? covered / totalWeight : 0,
      // No discriminative term (every one over the df cap, or the query is a
      // handle lookup) → 0 for EVERY candidate, so the component is neutral
      // rather than arbitrary.
      bodyCoverage: bodyTerms.length === 0 ? 0
        : namedByQuery(row.title) ? 1
        : bodyCovered / bodyTerms.length,
      exactIdent: identMatch.get(row.id) ?? 0,
      selfIdent: selfMatch.get(row.id) ?? 0,
      recency: Math.exp(-Math.max(0, now - row.updated_at) / (RECENCY_HALF_LIFE_DAYS * 86_400_000)),
    };
    const kindWeight = options.kindWeights?.[row.kind] ?? 1;
    const score = kindWeight * (
      W_STRICT * components.bm25Strict
      + W_RELAXED * components.bm25Relaxed
      + W_COVERAGE * components.coverage
      + W_BODY_COVERAGE * components.bodyCoverage
      + wIdent * components.exactIdent
      + W_SELF_IDENT * components.selfIdent
      + W_RECENCY * components.recency
    );
    hits.push({
      docId: row.id,
      kind: row.kind,
      ref: row.ref,
      title: row.title,
      updatedAt: row.updated_at,
      score,
      components,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
