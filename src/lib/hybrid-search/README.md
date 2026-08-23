# hybrid-search

Self-contained hybrid search core: SQLite FTS5 keyword retrieval with an identifier-aware tokenizer, interpretable additive scoring, and an optional semantic rescore lane. Built for personal-tool corpora (tasks, notes, chat transcripts, markdown knowledge bases) in the 10³-10⁵ document range, where queries mix natural language, code identifiers, and CJK text.

This directory is written as a standalone library. It imports nothing outside `node:*`, `better-sqlite3`, `@huggingface/transformers`, and sibling files (a boundary test enforces this). Publishing it later is: copy the directory, add a package.json with `better-sqlite3` as a peer dependency.

## Why it exists

Off-the-shelf engines do not match `operator` against `AcmeEventOperator`, or `自动重试` against a longer CJK run, without server sidecars or dead bindings. The fix is owning tokenization in application code, symmetrically at index and query time. Once you accept that, the engine choice collapses to "cheapest thing that stores your tokens and gives you BM25": SQLite FTS5.

## Design

- **One tokenizer, both sides** (`tokenizer.ts`). Emits two ordered streams: `orig` (whole lowercased tokens, internal `-_.'` preserved, CJK runs whole) and `sub` (camelCase/snake/kebab/digit-boundary splits; ordered CJK bigrams). No stemming. `TOKENIZER_VERSION` is stamped into the index; a mismatch at open wipes it and reports `needsRebuild`.
- **Contentless FTS5** (`db.ts`). `doc` holds raw text (snippets, rescoring, rebuilds); `doc_fts` (`content=''`, `contentless_delete=1`) indexes the token streams with `tokenchars '-_.'` so joined identifiers survive as single FTS tokens. Eight columns: one orig stream per field (title 10, summary 3, note 1, meta 2) and one sub stream per field at ~60% of the orig weight (6 / 1.8 / 0.6 / 1.2) — a subword hit in a title outranks a whole-word hit in a body, and phrases can never chain across fields. A tokenizer or FTS-layout version bump re-tokenizes from the stored doc rows (seconds); only a doc-schema bump forces a full source re-feed.
- **Write protocol** (`writer.ts`). Single transaction per doc: delete FTS postings, update the row preserving its rowid, reinsert streams, rewrite identifiers, drop stale vectors. A content hash makes unchanged upserts free.
- **Two query lanes + additive scoring** (`query.ts`). A strict AND lane for precision (CJK via ordered-bigram phrases), a relaxed OR lane for recall with a document-frequency threshold so corpus-wide terms cannot melt latency. Scores are a weighted sum of normalized BM25 (both lanes), term coverage, exact-identifier hits, recency, and (when enabled) cosine similarity, with every component exposed on the hit.
- **Vectors rescore, never retrieve.** Embeddings (int8 blobs in `doc_vec`) are only compared against the keyword candidate set — full-corpus KNN is out of scope by design. Omit the `embedder` option and you have a pure keyword engine; that degraded mode is a supported deployment shape, not an error.
- **Embedding off the main thread** (`embedder.ts` + `embed-worker.ts`). The ONNX model runs in a `worker_thread`; `searchSemantic()` races the query embed against a deadline and falls back to keyword order with a `semantic: 'timeout'` marker. Three consecutive worker crashes disable the semantic lane for the process. Passages come from `chunk.ts`: kinds marked `chunkVectors` are split at paragraph boundaries (~1400 chars, capped per doc), everything else embeds one head passage; a doc's score uses the max cosine over its chunks. `backfillVectors()` embeds docs missing vectors in small batches so an indexer loop can pace itself.

## Usage

```ts
import { createSearchIndex } from './index.js';

const index = createSearchIndex({
  dbPath: '/data/search.sqlite',
  kinds: { task: { weight: 1.0 }, session: { weight: 0.9, chunkVectors: true } },
  // embedder: { modelId: 'intfloat/multilingual-e5-small', dims: 384,
  //             queryPrefix: 'query: ', passagePrefix: 'passage: ' },
});

index.upsert({
  kind: 'task',
  ref: 't-42',
  title: 'Reconciler duplicate kind across GVRs check',
  note: 'The AcmeEventOperator watch cache keys by kind alone…',
  updatedAt: Date.now(),
  identifiers: ['t-42', 'CR-291543784'],
});

const hits = index.search('kind event operator', { limit: 10 });
// hits[0].components → { bm25Strict, bm25Relaxed, coverage, exactIdent, recency, cosine? }

index.remove('task', 't-42');
index.stats();
index.close();
```

`kind` is an arbitrary caller string, never an enum. Paths, weights, and logging all come in through options; the library reads no environment variables.

## Files

| File | Role |
|---|---|
| `index.ts` | public API (`createSearchIndex`) |
| `tokenizer.ts` | orig/sub token streams, `TOKENIZER_VERSION` |
| `db.ts` | schema, version gates, stats, optimize |
| `writer.ts` | upsert / remove / rebuildAll |
| `query.ts` | lanes, df threshold, gated-pair phrase recall, scoring |
| `embedder.ts` | worker lifecycle, deadlines, crash containment, `cosineInt8` |
| `embed-worker.ts` | worker-thread query/passage embedding (ONNX, int8) |
| `chunk.ts` | passage extraction (head passage / paragraph chunks) |
