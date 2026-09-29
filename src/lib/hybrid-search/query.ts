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
 * Coverage counts distinct query tokens present in ANY field (computing it on
 * title alone let long transcripts score high with zero real coverage).
 * BODY coverage counts them in the summary/note streams only, and exists
 * because bm25 cannot distinguish "this document discusses the query" from
 * "this document is titled almost exactly the query and says nothing": FTS5
 * normalizes by WHOLE-ROW length with b=0.75 hardcoded, so an empty task
 * titled "Test <topic>" outscored a 22KB note mentioning the topic 23 times.
 * Every query term is escaped as `"…""…"` — raw interpolation broke on 11 of
 * 17 adversarial tokens (`acme-gateway-dev` parses as column-filter-minus-NOT).
 * Ranking uses the explicit bm25() function, ~3.7x faster than ORDER BY rank.
 */

import { tokenize } from './tokenizer.js';
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
  /** Coverage/df expression (matches the term anywhere, sub included). */
  anyExpr: string;
  /** Same match, restricted to the body streams (see BODY_COLUMNS). */
  bodyExpr: string;
  /** Compound spellings of the term (see compoundForms), unguarded: coverage
   *  asks only "is it here in any form", and a bare OR is cheaper to probe. */
  formsExpr?: string;
  bodyFormsExpr?: string;
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
    if (parts.length < 2 || !parts.every(plain)) continue;
    if (parts.every(exists) && exists(parts.join(' '))) add(token, ftsQuote(parts.join(' ')));
    if (exists(parts.join(''))) add(token, ftsQuote(parts.join('')));
  }

  // split: a one-word term written as two adjacent words in the doc. The most
  // balanced splits first ("dock|hub" before "do|ckhub"; "work|flow" beats
  // "wo|rkflow"), since a real compound rarely hangs on a two-letter fragment.
  for (const token of uniqueOrig) {
    if (!plain(token) || token.length < COMPOUND_MIN_HALF * 2) continue;
    const splits: Array<[string, string]> = [];
    for (let k = COMPOUND_MIN_HALF; k <= token.length - COMPOUND_MIN_HALF; k++) {
      splits.push([token.slice(0, k), token.slice(k)]);
    }
    splits.sort((x, y) => Math.min(y[0].length, y[1].length) - Math.min(x[0].length, x[1].length));
    let kept = 0;
    let probes = 0;
    for (const [head, tail] of splits) {
      if (kept >= COMPOUND_MAX_SPLITS_PER_TERM || probes >= COMPOUND_MAX_SPLIT_PROBES || budget <= 0) break;
      if (!exists(head) || !exists(tail)) continue;
      probes++;
      if (!exists(`${head} ${tail}`)) continue;
      add(token, ftsQuote(`${head} ${tail}`));
      kept++;
    }
  }
  return forms;
}

function compileTerm(token: string, forms: readonly string[] = []): Term {
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
  const formsExpr = forms.length > 0 ? `(${forms.join(' OR ')})` : undefined;
  return {
    token,
    strictExpr: guarded.length > 0 ? `(${[quoted, ...guarded].join(' OR ')})` : quoted,
    anyExpr: quoted,
    bodyExpr: `${BODY_COLUMNS}:${quoted}`,
    ...(formsExpr ? { formsExpr, bodyFormsExpr: `${BODY_COLUMNS}:${formsExpr}` } : {}),
    relaxedExprs: [quoted, ...subParts.map((p) => ftsQuote(p)), ...guarded],
  };
}

interface LaneRow {
  rowid: number;
  s: number;
}

export function searchKeyword(
  db: SearchDb,
  query: string,
  options: KeywordSearchOptions = {},
): KeywordHit[] {
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
  const forms = compoundForms(origSeq, uniqueOrig, exists);
  const terms = uniqueOrig.map((token) => compileTerm(token, forms.get(token)));

  const limit = options.limit ?? DEFAULT_LIMIT;
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATES;
  const dfThreshold = options.dfThreshold ?? DEFAULT_DF_THRESHOLD;
  const now = options.now ?? Date.now();

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
  const corpusSize = (db.prepare(`SELECT COUNT(*) AS n FROM doc`).get() as { n: number }).n;
  if (corpusSize === 0) return [];
  const dfCap = Math.max(1, Math.ceil(corpusSize * dfThreshold));
  const dfStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM doc_fts WHERE doc_fts MATCH ? LIMIT ${dfCap + 1})`,
  );
  const dfOver = new Map<string, boolean>();
  const overDf = (term: Term): boolean => {
    let over = dfOver.get(term.token);
    if (over === undefined) {
      try {
        over = (dfStmt.get(term.anyExpr) as { n: number }).n > dfCap;
      } catch {
        over = true;
      }
      dfOver.set(term.token, over);
    }
    return over;
  };

  // ── lane A: strict AND ──
  const strictRows = runLane(terms.map((t) => t.strictExpr).join(' AND '));

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
  const candidates = new Map<number, { strict?: number; relaxed?: number }>();
  for (const row of strictRows) {
    candidates.set(row.rowid, { strict: row.s });
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
  const norm = (s: number | undefined, best: number): number =>
    s === undefined || best === 0 ? 0 : Math.max(0, Math.min(1, s / best));

  // ── doc rows ──
  const ids = [...candidates.keys()];
  const docRows = db.prepare(
    `SELECT id, kind, ref, title, updated_at FROM doc WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<{ id: number; kind: string; ref: string; title: string; updated_at: number }>;

  // ── coverage sets, bounded to the candidates (MATCH + rowid IN is ~1ms) ──
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
  const probeSet = (expr: string, formsExpr: string | undefined): Set<number> => {
    let found: Set<number>;
    try {
      found = new Set((coverStmt.all(expr) as Array<{ rowid: number }>).map((r) => r.rowid));
    } catch {
      found = new Set();
    }
    if (formsExpr) {
      const viaForms = rowsOfForms(formsExpr);
      for (const id of ids) if (viaForms.has(id)) found.add(id);
    }
    return found;
  };
  const termSets = new Map<string, Set<number>>();
  for (const term of terms) termSets.set(term.token, probeSet(term.anyExpr, term.formsExpr));

  // ── body coverage sets, same bounded probe, restricted to summary/note ──
  // Only the DISCRIMINATIVE terms participate: a term the df gate rejected is
  // present in every long body, so counting it would turn this component into a
  // document-length bonus, which is the exact bias it exists to cancel.
  const bodyTerms = terms.length >= BODY_COVERAGE_MIN_TERMS
    ? terms.filter((t) => !overDf(t))
    : [];
  const bodyTermSets = new Map<string, Set<number>>();
  for (const term of bodyTerms) bodyTermSets.set(term.token, probeSet(term.bodyExpr, term.bodyFormsExpr));

  // ── score ──
  // Identifier-query detection: on a 1-2 token query the identifier IS the
  // intent, so ownership outweighs prose quoting it.
  const wIdent = terms.length <= 2 && prefixTokens.length > 0 ? W_IDENT_ID_QUERY : W_IDENT;
  const hits: KeywordHit[] = [];
  for (const row of docRows) {
    const lanes = candidates.get(row.id)!;
    let covered = 0;
    for (const term of terms) {
      if (termSets.get(term.token)?.has(row.id)) covered++;
    }
    let bodyCovered = 0;
    for (const term of bodyTerms) {
      if (bodyTermSets.get(term.token)?.has(row.id)) bodyCovered++;
    }
    const components = {
      bm25Strict: norm(lanes.strict, bestStrict),
      bm25Relaxed: norm(lanes.relaxed, bestRelaxed),
      coverage: covered / terms.length,
      // No discriminative term (every one over the df cap, or the query is a
      // handle lookup) → 0 for EVERY candidate, so the component is neutral
      // rather than arbitrary.
      bodyCoverage: bodyTerms.length > 0 ? bodyCovered / bodyTerms.length : 0,
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
