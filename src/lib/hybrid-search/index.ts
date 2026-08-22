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
import { searchKeyword, DEFAULT_DF_THRESHOLD } from './query.js';

export type { Doc, UpsertResult, IndexStats, TokenStreams };
export { tokenize, TOKENIZER_VERSION, DEFAULT_DF_THRESHOLD };

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
  /** Budget for the semantic rescore; on expiry keyword results return as-is. */
  semanticDeadlineMs?: number;
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
  for (const [kind, config] of Object.entries(options.kinds ?? {})) {
    if (typeof config.weight === 'number') kindWeights[kind] = config.weight;
  }

  return {
    upsert: (doc) => writer.upsert(doc),
    remove: (kind, ref) => writer.remove(kind, ref),
    search: (query, searchOptions = {}) => {
      // Keyword lanes only for now; the semantic rescore joins in a later
      // phase behind searchOptions.semanticDeadlineMs.
      const hits = searchKeyword(db, query, {
        kinds: searchOptions.kinds,
        limit: searchOptions.limit,
        dfThreshold: options.dfThreshold ?? DEFAULT_DF_THRESHOLD,
        kindWeights,
      });
      return hits.map((hit) => ({
        kind: hit.kind,
        ref: hit.ref,
        title: hit.title,
        score: hit.score,
        components: hit.components,
        updatedAt: hit.updatedAt,
        semantic: options.embedder ? 'timeout' : 'disabled',
      }));
    },
    rebuildAll: async (docs) => {
      const result = await writer.rebuildAll(docs);
      optimizeIndex(db);
      return result;
    },
    stats: () => collectStats(db),
    optimize: () => optimizeIndex(db),
    close: () => db.close(),
    db,
    needsRebuild,
  };
}
