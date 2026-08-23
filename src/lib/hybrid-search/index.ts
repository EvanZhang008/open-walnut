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
import { createWriter, type Doc, type UpsertResult, type Writer } from './writer.js';
import { TOKENIZER_VERSION, tokenize, type TokenStreams } from './tokenizer.js';
import { searchKeyword, DEFAULT_DF_THRESHOLD, type KeywordHit } from './query.js';
import { cosineInt8, createEmbedder, type Embedder } from './embedder.js';
import { passagesForDoc } from './chunk.js';

export type { Doc, UpsertResult, IndexStats, TokenStreams };
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
  /** True when no doc is missing vectors anymore. */
  drained: boolean;
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
    recency: number;
    cosine?: number;
  };
  updatedAt: number;
  /** 'ok' | 'timeout' | 'disabled' — state of the semantic blend. */
  semantic?: string;
}

export interface SearchIndex {
  upsert(doc: Doc): UpsertResult;
  remove(kind: string, ref: string): boolean;
  search(query: string, options?: SearchOptions): ScoredHit[];
  /** Async variant: keyword lanes + semantic rescore over the candidates when
   *  an embedder is configured. Degrades to the keyword order on deadline /
   *  worker failure — never slower than semanticDeadlineMs, never throws. */
  searchSemantic(query: string, options?: SearchOptions): Promise<ScoredHit[]>;
  /** Embed one batch of vector-less docs (chunked kinds get per-passage
   *  vectors). Call repeatedly until drained; safe to interleave with writes. */
  backfillVectors(options?: { batchDocs?: number }): Promise<BackfillVectorsResult>;
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
    ? createEmbedder(options.embedder, log)
    : null;

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
      // a 30-deep pool never let the rescore see it. Cosine over ≤100
      // candidates is ~1ms, so depth here is cheap.
      const pool = runKeyword(query, searchOptions, Math.min(100, Math.max(60, limit * 3)));
      if (pool.length === 0) return [];
      const queryVec = await embedder.embedQuery(query, deadline);
      if (!queryVec) {
        return pool.slice(0, limit).map((h) => toScored(h, 'timeout'));
      }
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
      const scored = pool.map((h) => {
        const cos = bestCos.get(h.docId);
        const cosNorm = cos === undefined || span <= 0 ? 0 : (cos - min) / span;
        const out = toScored(h, 'ok');
        out.components = { ...h.components, cosine: cos };
        out.score = h.score + (kindWeights[h.kind] ?? 1) * W_COSINE * cosNorm;
        return out;
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },
    backfillVectors: async (backfillOptions = {}) => {
      if (!embedder) return { embedded: 0, drained: true };
      const batchDocs = backfillOptions.batchDocs ?? 16;
      const docs = writer.listDocsMissingVectors(batchDocs);
      if (docs.length === 0) return { embedded: 0, drained: true };
      let embedded = 0;
      for (const doc of docs) {
        const passages = passagesForDoc(doc, chunkedKinds.has(doc.kind));
        if (passages.length === 0) {
          // Mark empty docs done with one zero vector (cosine 0 = no boost);
          // otherwise they reappear in every missing-vectors scan forever.
          writer.writeVectors(doc.id, [new Int8Array(options.embedder!.dims)]);
          continue;
        }
        const vectors: Int8Array[] = [];
        // Sub-batch so one whale doc cannot balloon a single inference call.
        for (let i = 0; i < passages.length; i += 32) {
          vectors.push(...await embedder.embedPassages(passages.slice(i, i + 32)));
        }
        writer.writeVectors(doc.id, vectors);
        embedded++;
      }
      return { embedded, drained: docs.length < batchDocs };
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
      void embedder?.dispose();
      db.close();
    },
    db,
    needsRebuild,
  };
}
