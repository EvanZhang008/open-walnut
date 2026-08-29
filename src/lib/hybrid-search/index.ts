/**
 * hybrid-search — self-contained hybrid (keyword + optional semantic) search
 * over SQLite FTS5 with an identifier-aware tokenizer.
 *
 * This directory is written as a standalone library: no imports outside
 * `node:*`, `better-sqlite3`, `@huggingface/transformers` and sibling files
 * (enforced by tests/lib/hybrid-search-boundary.test.ts). Publishing it later
 * is: copy the directory, add a package.json.
 *
 * Usage:
 *   const index = createSearchIndex({ dbPath: '/path/search.sqlite' });
 *   index.upsert({ kind: 'task', ref: 't1', title: '…', updatedAt: Date.now() });
 *   const hits = index.search('kind event operator');   // phase 2
 */

import {
  openSearchDb,
  collectStats,
  optimizeIndex,
  type SearchDb,
  type IndexStats,
} from './db.js';
import { createWriter, type Doc, type MissingVecCursor, type UpsertResult, type Writer } from './writer.js';
import { TOKENIZER_VERSION, tokenize, type TokenStreams } from './tokenizer.js';
import {
  searchKeyword,
  DEFAULT_DF_THRESHOLD,
  RECENCY_HALF_LIFE_DAYS,
  W_RECENCY,
  type KeywordHit,
} from './query.js';
import { cosineInt8, createEmbedder, type Embedder } from './embedder.js';
import { passagesForDoc } from './chunk.js';

export type { Doc, MissingVecCursor, UpsertResult, IndexStats, TokenStreams };
export { tokenize, TOKENIZER_VERSION, DEFAULT_DF_THRESHOLD };
export { cosineInt8, createEmbedder } from './embedder.js';
export { passagesForDoc } from './chunk.js';

export type LogFn = (
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

export interface KindConfig {
  /** Final score multiplier for this kind (default 1.0). */
  weight?: number;
  /** Chunk long docs into per-segment vectors (sessions). Default false. */
  chunkVectors?: boolean;
}

export interface EmbedderConfig {
  /** Model id resolvable by @huggingface/transformers. */
  modelId: string;
  dims: number;
  /** Some models (e5 family) require asymmetric prefixes. */
  queryPrefix?: string;
  passagePrefix?: string;
  /** transformers.js dtype (default 'q8'). */
  dtype?: string;
  cacheDir?: string;
  /** Pooling: 'mean' (default; e5 family) or 'last' (Qwen3-Embedding). */
  pooling?: 'mean' | 'last';
  /** Compiled embed-worker.js location. Required when the caller bundles this
   *  library; defaults to the sibling file (correct un-bundled). */
  workerPath?: string | URL;
}

export interface SearchIndexOptions {
  /** Absolute path, or ':memory:' for tests. */
  dbPath: string;
  /** Per-kind scoring/behavior config. Kinds are arbitrary caller strings;
   *  unknown kinds get defaults. */
  kinds?: Record<string, KindConfig>;
  /** Omit for a pure keyword engine (also the degraded/replica mode). */
  embedder?: EmbedderConfig;
  /** Tokens with document frequency above this fraction of the corpus are
   *  excluded from the OR recall lane (kept in the AND lane). Default 0.15. */
  dfThreshold?: number;
  logger?: LogFn;
}

export interface SearchOptions {
  kinds?: string[];
  limit?: number;
  /** Budget for the semantic rescore; on expiry keyword results return as-is.
   *  Default 150ms when an embedder is configured; 0 disables the rescore. */
  semanticDeadlineMs?: number;
}

export interface BackfillVectorsResult {
  embedded: number;
  /** True when this walk reached the end of the missing-vectors list. */
  drained: boolean;
  /** Pass back into the next call to resume the walk without re-scanning
   *  already-visited docs. Start a fresh pass with null/undefined. */
  cursor: MissingVecCursor | null;
}

export interface StoredDoc {
  kind: string;
  ref: string;
  title: string;
  summary: string;
  note: string;
  meta: string;
  updatedAt: number;
}

/** One scored hit with every component exposed — scores must stay explainable. */
export interface ScoredHit {
  kind: string;
  ref: string;
  title: string;
  score: number;
  components: {
    bm25Strict: number;
    bm25Relaxed: number;
    coverage: number;
    exactIdent: number;
    /** Matched by the doc's OWN ref (exact 1.0 / prefix-discounted). */
    selfIdent: number;
    recency: number;
    cosine?: number;
  };
  updatedAt: number;
  /** State of the semantic blend: 'ok' (rescored), 'cold' (no candidate had
   *  vectors yet — backfill pending), 'timeout', 'skipped', 'disabled'. */
  semantic?: string;
}

export interface SearchIndex {
  upsert(doc: Doc): UpsertResult;
  remove(kind: string, ref: string): boolean;
  search(query: string, options?: SearchOptions): ScoredHit[];
  /** Async variant: keyword lanes + semantic rescore over the candidates when
   *  an embedder is configured. Degrades to the keyword order on deadline /
   *  worker failure. The deadline bounds only the EMBEDDING step — the
   *  keyword lanes before it run at their own (fast but unbounded) cost, and
   *  database-level errors (closed handle, corruption) still reject: callers
   *  on a request path should catch. */
  searchSemantic(query: string, options?: SearchOptions): Promise<ScoredHit[]>;
  /** Embed one batch of vector-less docs (chunked kinds get per-passage
   *  vectors). Call repeatedly until drained, passing each result's `cursor`
   *  back in; safe to interleave with writes. A doc whose embed fails twice
   *  is quarantined with a zero vector (upsert clears it, so the next content
   *  change retries). */
  backfillVectors(options?: { batchDocs?: number; cursor?: MissingVecCursor | null; excludeKinds?: string[] }): Promise<BackfillVectorsResult>;
  /** Stored raw text of a doc (snippet extraction, rescoring). */
  getDoc(kind: string, ref: string): StoredDoc | null;
  rebuildAll(docs: Iterable<Doc> | AsyncIterable<Doc>): Promise<{ inserted: number }>;
  stats(): IndexStats;
  optimize(): void;
  close(): void;
  /** Escape hatch for the embedding worker and tests; not part of the
   *  stable surface. */
  readonly db: SearchDb;
  /** True when a version gate wiped the index at open — re-feed all docs. */
  readonly needsRebuild: boolean;
}

const noopLog: LogFn = () => {};

export function createSearchIndex(options: SearchIndexOptions): SearchIndex {
  const log = options.logger ?? noopLog;
  const { db, needsRebuild, needsReindex } = openSearchDb({
    dbPath: options.dbPath,
    tokenizerVersion: TOKENIZER_VERSION,
    embedModel: options.embedder?.modelId,
  });
  if (needsRebuild) {
    log('warn', 'hybrid-search: version gate wiped the index — re-feed all docs', {
      dbPath: options.dbPath,
      tokenizerVersion: TOKENIZER_VERSION,
    });
  }
  const writer: Writer = createWriter(db);
  if (needsReindex) {
    // Tokenizer/FTS layout bump: doc rows survived, re-tokenize them locally.
    // Synchronous by design — an open index must be queryable-consistent.
    // (~0.5ms/doc; on a huge corpus open the index off the hot path.)
    const { reindexed } = writer.reindexFtsFromDocs();
    log('info', 'hybrid-search: re-tokenized FTS from stored docs', { reindexed });
  }

  const kindWeights: Record<string, number> = {};
  const chunkedKinds = new Set<string>();
  for (const [kind, config] of Object.entries(options.kinds ?? {})) {
    if (typeof config.weight === 'number') kindWeights[kind] = config.weight;
    if (config.chunkVectors) chunkedKinds.add(kind);
  }

  const embedder: Embedder | null = options.embedder
    ? createEmbedder({
      ...options.embedder,
      // The recall lane's worker opens its own readonly connection — only
      // possible for a real file (a :memory: db is invisible across threads).
      dbPath: options.dbPath !== ':memory:' ? options.dbPath : undefined,
    }, log)
    : null;
  let closed = false;
  /** Per-process embed-failure counts; at 2 the doc is quarantined with a
   *  zero vector so ONE poison doc can never wedge the whole backfill. */
  const vecFailures = new Map<number, number>();
  /** Last time searchSemantic reached for the worker. The backfill yields the
   *  (single) worker whenever a query ran in the last quiet window — the human
   *  is searching NOW, passages can wait. */
  let lastQueryAt = 0;
  const BACKFILL_QUERY_QUIET_MS = 2_500;

  function runKeyword(query: string, searchOptions: SearchOptions, limit?: number): KeywordHit[] {
    return searchKeyword(db, query, {
      kinds: searchOptions.kinds,
      limit,
      dfThreshold: options.dfThreshold ?? DEFAULT_DF_THRESHOLD,
      kindWeights,
    });
  }

  function toScored(hit: KeywordHit, semantic: string): ScoredHit {
    return {
      kind: hit.kind,
      ref: hit.ref,
      title: hit.title,
      score: hit.score,
      components: hit.components,
      updatedAt: hit.updatedAt,
      semantic,
    };
  }

  /** Cosine blend weight — same additive stack as the keyword components. */
  const W_COSINE = 0.20;
  /** Doc-level KNN neighbours requested from the worker per query. */
  const RECALL_K = 30;
  /** Neighbours requested when the caller restricts kinds. The worker's KNN
   *  scans ALL kinds and the kind filter runs here AFTER the top-K cut, so a
   *  minority kind (notes in a session-heavy corpus) can lose every slot to
   *  neighbours the filter then discards. Overfetch so enough of the wanted
   *  kind survives; the scan itself is full-matrix either way. */
  const RECALL_K_KIND_FILTERED = 150;
  /** Score weight for a recall doc's KNN RANK. A keyword-less doc's only
   *  evidence is that it out-cosined ~12k others — rank is model-agnostic
   *  where raw cosine units are not. Linear decay to 0 at rank K keeps the
   *  tail harmless; the top neighbour (0.6 + cosine blend) beats weak keyword
   *  stacks but never a strong one (≥1.0), and the demotion cap already
   *  shields the keyword top-5. */
  const W_RECALL_RANK = 0.35;
  /** Share of the returned page that keyword-less recall docs may occupy
   *  while keyword-evidenced docs still compete (⌈limit/N⌉ slots). KNN rank
   *  is uncorroborated model opinion; bound its breadth the way the demotion
   *  cap bounds cosine demotion (2026-08-24: on typo/vague queries recall
   *  neighbours took every slot of the page and buried docs with real term
   *  coverage). When the keyword pool runs out the cap lifts — a
   *  cross-lingual query with zero term overlap still fills its page. */
  const RECALL_SLOT_SHARE = 4;
  /** Pool cosine span at which the rescore earns its full weight. Below this
   *  the candidates are semantically indistinguishable and the min-max
   *  stretch would amplify noise (measured: Qwen3 spans run 0.15-0.4 on
   *  mixed pools, well under 0.1 on same-topic near-duplicate pools). */
  const SPAN_REF = 0.15;

  const selectVecs = (ids: number[]) => db.prepare(
    `SELECT doc_id, vec FROM doc_vec WHERE doc_id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<{ doc_id: number; vec: Buffer }>;

  return {
    upsert: (doc) => writer.upsert(doc),
    remove: (kind, ref) => writer.remove(kind, ref),
    search: (query, searchOptions = {}) => {
      const hits = runKeyword(query, searchOptions, searchOptions.limit);
      return hits.map((h) => toScored(h, embedder ? 'skipped' : 'disabled'));
    },
    searchSemantic: async (query, searchOptions = {}) => {
      const limit = searchOptions.limit ?? 20;
      const deadline = searchOptions.semanticDeadlineMs ?? 150;
      if (!embedder || deadline <= 0) {
        return runKeyword(query, searchOptions, limit)
          .map((h) => toScored(h, embedder ? 'skipped' : 'disabled'));
      }
      // Overfetch: the rescore can only reorder what the keyword lanes hand
      // it, so give it headroom beyond the page the caller asked for. Floor
      // of 60: a doc reachable ONLY through the gated-pair phrase lane ranks
      // in the 40s of the keyword pool (coverage ~0.5, no rare-term bm25) —
      // a 30-deep pool never let the rescore see it. Never below the caller's
      // limit, so a large page is at worst unrescored, never truncated.
      const pool = runKeyword(
        query,
        searchOptions,
        Math.max(limit, Math.min(100, Math.max(60, limit * 3))),
      );
      const recallK = searchOptions.kinds?.length ? RECALL_K_KIND_FILTERED : RECALL_K;
      lastQueryAt = Date.now();
      const reply = await embedder.embedQuery(query, deadline, recallK);
      lastQueryAt = Date.now();
      if (!reply || closed) {
        return pool.slice(0, limit).map((h) => toScored(h, 'timeout'));
      }
      const queryVec = reply.vec;
      // Semantic recall union: docs the keyword lanes could not reach (zero
      // term overlap — cross-lingual queries, full paraphrases). They join the
      // pool as keyword-less candidates (recency only) and earn their place
      // through the cosine blend below; appended AFTER the keyword pool, the
      // demotion cap never forces them anywhere. This is deliberately NOT the
      // banned full-KNN: only level-0 doc vectors, scanned in the worker.
      const recallDocIds = new Set<number>();
      if (reply.recall.length > 0) {
        const inPool = new Set(pool.map((h) => h.docId));
        const recallRank = new Map<number, number>();
        reply.recall.forEach((r, i) => {
          if (!inPool.has(r.docId)) recallRank.set(r.docId, i);
        });
        if (recallRank.size > 0) {
          const addIds = [...recallRank.keys()];
          const rows = db.prepare(
            `SELECT id, kind, ref, title, updated_at FROM doc
             WHERE id IN (${addIds.map(() => '?').join(',')})`,
          ).all(...addIds) as Array<{ id: number; kind: string; ref: string; title: string; updated_at: number }>;
          const allowedKinds = searchOptions.kinds?.length ? new Set(searchOptions.kinds) : null;
          const now = Date.now();
          for (const row of rows) {
            if (allowedKinds && !allowedKinds.has(row.kind)) continue;
            const recency = Math.exp(
              -Math.max(0, now - row.updated_at) / (RECENCY_HALF_LIFE_DAYS * 86_400_000),
            );
            const rankStrength = 1 - (recallRank.get(row.id) ?? recallK) / recallK;
            recallDocIds.add(row.id);
            pool.push({
              docId: row.id,
              kind: row.kind,
              ref: row.ref,
              title: row.title,
              updatedAt: row.updated_at,
              score: (kindWeights[row.kind] ?? 1)
                * (W_RECALL_RANK * rankStrength + W_RECENCY * recency),
              components: {
                bm25Strict: 0, bm25Relaxed: 0, coverage: 0,
                exactIdent: 0, selfIdent: 0, recency,
              },
            });
          }
        }
      }
      if (pool.length === 0) return [];
      // Max cosine over a doc's chunk vectors: the best-matching passage
      // speaks for the doc.
      const bestCos = new Map<number, number>();
      for (const row of selectVecs(pool.map((h) => h.docId))) {
        const vec = new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength);
        if (vec.length !== queryVec.length) continue; // model changed mid-flight
        const cos = cosineInt8(queryVec, vec);
        const prev = bestCos.get(row.doc_id);
        if (prev === undefined || cos > prev) bestCos.set(row.doc_id, cos);
      }
      if (bestCos.size === 0) {
        // No candidate has vectors yet (fresh index mid-backfill): keyword
        // order, honestly labelled — 'ok' here would make a cold rollout
        // indistinguishable from a working rescore.
        return pool.slice(0, limit).map((h) => toScored(h, 'cold'));
      }
      // e5-family cosines live in a compressed band (~0.7-0.95), so the raw
      // value barely discriminates. Normalize within the candidate set, like
      // the bm25 components — relative order among THESE candidates is the
      // only thing a rescore needs.
      let min = Infinity;
      let max = -Infinity;
      for (const cos of bestCos.values()) {
        if (cos < min) min = cos;
        if (cos > max) max = cos;
      }
      const span = max - min;
      // Min-max normalization amplifies WHATEVER span the pool has to the
      // full blend weight — on a pool of near-duplicates (an exact-identifier
      // query where every candidate is about the same component) that
      // stretches semantic noise into ±W_COSINE and overrides recency, the
      // only signal that actually ranks such a pool. Scale the blend by how
      // much cosine information the pool really contains.
      const confidence = Math.min(1, span / SPAN_REF);
      const scored = pool.map((h, kwRank) => {
        const cos = bestCos.get(h.docId);
        // A missing vector means UNKNOWN similarity, not zero: a doc whose
        // vectors were just dropped by an upsert (i.e. the freshest doc in
        // the pool) must not be scored as maximally irrelevant. Neutral 0.5,
        // also used when every cosine ties (span 0 carries no information).
        const cosNorm = cos === undefined || span <= 0 ? 0.5 : (cos - min) / span;
        const out = toScored(h, 'ok');
        out.components = { ...h.components, cosine: cos };
        out.score = h.score + (kindWeights[h.kind] ?? 1) * W_COSINE * confidence * cosNorm;
        // A recall entry has NO keyword rank — its pool position is just the
        // append/SELECT order. Infinity keeps the demotion cap from ever
        // "protecting" one into the page ahead of scored keyword evidence.
        return {
          out,
          kwRank: recallDocIds.has(h.docId) ? Number.POSITIVE_INFINITY : kwRank,
          docId: h.docId,
        };
      });
      scored.sort((a, b) => b.out.score - a.out.score);
      // Demotion cap: the rescore is a tiebreaker, not a veto. It may promote
      // a doc any distance, but may not sink one more than limit/2 places
      // below its keyword rank (2026-08-24: a keyword-rank-5 doc fell out of
      // top-10 to a cosine opinion; the golden set says the keyword evidence
      // should have kept it visible). Earliest overdue keyword rank wins a slot.
      const cap = Math.max(3, Math.floor(limit / 2));
      const recallCap = Math.max(2, Math.ceil(limit / RECALL_SLOT_SHARE));
      let recallUsed = 0;
      const final: ScoredHit[] = [];
      const pending = [...scored];
      while (final.length < Math.min(limit, pending.length + final.length)) {
        let pick = -1;
        let bestDeadline = Infinity;
        for (let j = 0; j < pending.length; j++) {
          const deadline = pending[j].kwRank + cap;
          if (deadline <= final.length && deadline < bestDeadline) {
            pick = j;
            bestDeadline = deadline;
          }
        }
        if (pick === -1) {
          // No overdue keyword doc: highest score wins the slot — unless it
          // is a recall doc past the slot cap and a keyword doc still waits.
          pick = 0;
          if (recallUsed >= recallCap && recallDocIds.has(pending[0].docId)) {
            const kw = pending.findIndex((p) => !recallDocIds.has(p.docId));
            if (kw !== -1) pick = kw;
          }
        }
        if (recallDocIds.has(pending[pick].docId)) recallUsed++;
        final.push(pending.splice(pick, 1)[0].out);
      }
      return final;
    },
    backfillVectors: async (backfillOptions = {}) => {
      if (!embedder || closed) return { embedded: 0, drained: true, cursor: null };
      const batchDocs = backfillOptions.batchDocs ?? 16;
      const { docs, cursor } = writer.listDocsMissingVectors(
        batchDocs, backfillOptions.cursor, backfillOptions.excludeKinds,
      );
      if (docs.length === 0) return { embedded: 0, drained: true, cursor };
      let embedded = 0;
      for (const doc of docs) {
        if (closed) return { embedded, drained: true, cursor };
        const passages = passagesForDoc(doc, chunkedKinds.has(doc.kind));
        if (passages.length === 0) {
          // Mark empty docs done with one zero vector (cosine 0 = no boost);
          // otherwise they reappear in every missing-vectors scan forever.
          writer.writeVectors(doc.id, [new Int8Array(options.embedder!.dims)]);
          continue;
        }
        try {
          const vectors: Int8Array[] = [];
          // ONE passage per inference call. CPU inference is linear in total
          // tokens (measured: 1×2KB ≈ 540ms, 32×2KB ≈ 22s), so batching buys
          // no throughput — it only builds a 22s head-of-line block in the
          // single worker, behind which every interactive query embed blew its
          // deadline and silently degraded to keyword order. Between calls,
          // yield the worker to live queries: partial vectors are discarded
          // (the doc stays missing and re-lists), which is the right trade —
          // backfill wastes a little work only while a human is searching.
          for (const passage of passages) {
            if (Date.now() - lastQueryAt < BACKFILL_QUERY_QUIET_MS) {
              return { embedded, drained: false, cursor: backfillOptions.cursor ?? null };
            }
            vectors.push(...await embedder.embedPassages([passage]));
          }
          if (closed) return { embedded, drained: true, cursor };
          writer.writeVectors(doc.id, vectors);
          vecFailures.delete(doc.id);
          embedded++;
        } catch (err) {
          // One poison doc (worker OOM/crash on its passages) must not stall
          // the walk: the cursor moves past it either way, and a second
          // failure quarantines it (zero vector = done, no boost; the next
          // content change clears it and retries).
          const fails = (vecFailures.get(doc.id) ?? 0) + 1;
          vecFailures.set(doc.id, fails);
          if (fails >= 2) {
            writer.writeVectors(doc.id, [new Int8Array(options.embedder!.dims)]);
            vecFailures.delete(doc.id);
            log('warn', 'hybrid-search: doc quarantined after repeated embed failures', {
              kind: doc.kind, ref: doc.ref,
              error: err instanceof Error ? err.message : String(err),
            });
          } else {
            log('warn', 'hybrid-search: embed failed for doc — will retry next pass', {
              kind: doc.kind, ref: doc.ref,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      return { embedded, drained: docs.length < batchDocs, cursor };
    },
    getDoc: (kind, ref) => {
      const row = db.prepare(
        `SELECT kind, ref, title, summary, note, meta, updated_at FROM doc
         WHERE kind = ? AND ref = ?`,
      ).get(kind, ref) as
        | { kind: string; ref: string; title: string; summary: string; note: string; meta: string; updated_at: number }
        | undefined;
      if (!row) return null;
      return {
        kind: row.kind,
        ref: row.ref,
        title: row.title,
        summary: row.summary,
        note: row.note,
        meta: row.meta,
        updatedAt: row.updated_at,
      };
    },
    rebuildAll: async (docs) => {
      const result = await writer.rebuildAll(docs);
      optimizeIndex(db);
      return result;
    },
    stats: () => collectStats(db),
    optimize: () => optimizeIndex(db),
    close: () => {
      closed = true; // in-flight backfill/searches bail instead of touching a closed handle
      void embedder?.dispose();
      db.close();
    },
    db,
    needsRebuild,
  };
}
