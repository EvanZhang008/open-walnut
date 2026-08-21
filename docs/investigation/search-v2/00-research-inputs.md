# Search v2: research inputs

Digest of three deep-research passes (2026-08-18): a dependency/requirements inventory of the current QMD integration, a market scan of embedded hybrid-search options (with live benchmarks on this Mac), and an architecture design with a prototype validated on the real corpus. This file is the input for the design/plan session. Benchmark scratch scripts referenced at the bottom.

## The failure that started this

Query `kind event operator reconciler` could not find task "Reconciler duplicate kind across GVRs check" (its note is full of `XYZEventOperator`, a camelCase component name). Three confirmed root causes, all in the QMD layer:

1. Tokenizer: FTS5 `tokenize='porter unicode61'` (node_modules/@tobilu/qmd/dist/store.js:659). `XYZEventOperator` indexes as the single porter-stemmed token `xyzeventoper`; a contiguous CJK run indexes as one token. Query token `operator` compiles to prefix match `"operator"*` and can never hit either.
2. AND annihilation: query terms are AND-joined prefix matches (store.js:2201-2216). One missing term returns 0 rows for the whole keyword lane, and ranking silently degrades to vector-only.
3. Meaningless scores: every interactive caller passes `rerank:false`, so QMD returns score = 1/rank (store.js:3501-3520), multiplied by source weight in src/core/memory-search.ts:387. Scores carry no term coverage, no field info, and are not comparable across stores.

## Current state (measured 2026-08-18)

- Corpus: 3,551 tasks, 2,310 sessions, 863 notes, 247 memory docs = 6,970 indexed docs, 38,233 chunks. 31% of task titles are mixed CJK+English (1,091 of 3,551).
- QMD index files: 663 MB across 4 sqlite stores (sessions alone 388 MB). Full session reindex p50 9.3 min; a no-op full pass still costs 455 s. Incremental task sync p50 2.8 s end to end.
- Live latency: /api/search avg 4,034 ms; search.global max 7.5 s. Skill prefetch has a hard 300 ms cap (src/agent/loop.ts:224) and routinely loses.
- Embeddings: Qwen3-Embedding-0.6B-Q8 GGUF, 1024 dims, via node-llama-cpp in-process. Cold load ~10 s, warm query embed 30-85 ms. Model cache 3.8 GB, more than half of it a reranker and a query-expansion model that are never used (rerank is off everywhere).
- Integration surface: ~3,700 LOC across 18 qmd-* files, 33 identified in-tree workarounds for QMD weaknesses, plus 15 mandatory monkey-patches to QMD's dist/store.js at postinstall (scripts/patch-qmd.mjs, version-pinned to 2.1.0). Heavy use of `store.internal.*` private APIs for 3 of 4 stores.
- Callers: web UI search box (interactive), notes command palette (interactive, string leg must stay double-digit ms), MCP search (30 s budget), agent tools task_search/memory_notes_search (run inside the web process, so blocking calls freeze interactive routes), skill prefetch (300 ms), boot warmup.
- Query shapes from live logs: 1-7 words, p50 2. Code identifiers appear as bare tokens. Doc sizes: task note max 256 KB, session docs capped at 50 KB by session-content-indexer.

Full inventory (every call site, all 33 workarounds, all 15 patches) is in the research transcript; key files: src/core/memory-search.ts, src/core/search.ts, src/core/qmd-store.ts, src/core/qmd-task-sync.ts, src/core/cjk.ts, scripts/patch-qmd.mjs.

## Market scan conclusion

No engine solves `operator` matching `XYZEventOperator` out of the box. Verified by live test or source reading on: Meilisearch (has latin-camelcase in charabia, deliberately compiled out, PR 3921), Typesense (GPL, infix search linear-scans and only uses first query word), LanceDB (Rust core has WordDelimiterFilter with split_identifiers, Node binding silently drops the parameter), Orama (creator left, project effectively dead, hybrid p50 4.4 s at 50k), FlexSearch (no usable scores at all), every prebuilt FTS5 tokenizer extension (wangfenjin/simple does CJK+pinyin but not camelCase; Signal's is AGPL; ICU does not exist for FTS5), tantivy Node bindings (real but ~27 downloads/week). Registering a custom FTS5 tokenizer from Node is impossible (needs sqlite3_bind_pointer; better-sqlite3 PR #944 dead since 2023).

Therefore: tokenization must be done in our own app code, symmetrically at index time and query time. Once you accept that, the engine choice collapses to "cheapest thing that stores our tokens and gives BM25", which is SQLite FTS5 already in the stack.

Ranked shortlist from the scan: (1) DIY SQLite FTS5 + our tokenizer + vectors, (2) MiniSearch 7.2 as pure-JS keyword leg (real BM25+, custom tokenizer hooks, but in-RAM with snapshot traps), (3) LanceDB 0.37 (healthy, native hybrid RRF in Node, but 216 MB native binary and the tokenizer gap). Wildcard: @zvec/zvec 0.6 (Alibaba, Apache-2.0, 15.4k stars, in-process vector+BM25+jieba+RRF, hybrid p50 2.85 ms at 10k, measured excellent) but pre-1.0, young Node binding, single-writer lock. Not chosen as foundation; worth a one-day spike someday.

Embedding model recommendation: intfloat/multilingual-e5-small int8 ONNX via @huggingface/transformers, device cpu. Measured on this Mac: 1.88 ms query embed, 1.3 s load, 384 dims, 118 MB. Roughly 4x faster query, 3x smaller index, 12x faster startup than the current GGUF path. Costs: mandatory `query: `/`passage: ` prefixes, mean pooling, 512-token cap, weakest published Chinese retrieval scores of the serious options. Fallback if Chinese recall on the golden set disappoints: Qwen/Qwen3-Embedding-0.6B ONNX (best published Chinese numbers, 14 ms, MRL-truncatable to 256 dims). fastembed is archived; bge-m3 too slow (2.2 docs/s); jina models are CC-BY-NC.

Hybrid is a correctness requirement, not an optimization: measured cosine between `CR-291543784` and `CR-291543785` is 0.92-0.97 in every embedding model tested (digits tokenize to a bag of pieces, mean pooling erases the difference). The dense lane cannot distinguish identifiers; the keyword lane must be strong and exact identifiers must win via exact-match boost.

## Recommended architecture (Option B, prototype-validated)

One search.sqlite replacing all four QMD stores. External-content FTS5 over OUR token stream, two query lanes, our own additive scoring, vectors used only to rescore keyword candidates, query embedding in a worker thread.

Write path: doc table (id, kind, ref, title, summary, note snippet, project, tags, updated_at) + `doc_fts` FTS5 with `content='doc'`, columns title/summary/note/meta/sub, `tokenize='unicode61 remove_diacritics 2'`, NO porter + `doc_vec` (id, int8 embedding BLOB) + `ident` exact-identifier table.

Read path: (a) tokenize query (0.01 ms); (b) exact/ident lane short-circuit for task ids, CR-*, SHAs, URLs (keep existing searchTaskReferences family, src/core/search.ts:265-449, it is correct); (c) Lane A precision: original tokens AND over title/summary/note; (d) Lane B recall: original+sub tokens OR over all columns including sub; (e) merge to ~250 candidates, score in our code; keyword result ready at ~3 ms; (f) async semantic rescore: embed query in worker (2-14 ms with ONNX), fetch candidate vectors by rowid, cosine over ~250 (0.1 ms), blend and push updated order.

Critical: never full-corpus KNN. The corpus is ~275k chunk vectors at 50k-doc scale (QMD embeds chunks, 2.3-11.4 per doc). Pure-JS brute force over that is ~7 s; sqlite-vec KNN over the live session store alone is p50 132 ms. Candidate-rescore is 5000x cheaper and loses little because a doc matching zero tokens after subtoken expansion is rarely the answer.

### Tokenizer spec (implemented and tested, /tmp/walnut-search-bench/fast.mjs, 3.1 Mchar/s)

Single char-code scan. Emit two sets: `orig` (whole lowercased tokens, including compounds with internal `- _ . '`) and `sub` (split parts). Rules: camel/acronym/digit boundaries split on lower-to-Upper, letter-digit, and UPPER-to-Upperlower (so `XYZEventOperator` splits after XYZ, not XYZEvent); CJK runs emit whole run to orig plus all bigrams to sub; no stemmer; skip tokens over 64 chars; dedupe.

| input | orig | sub |
|---|---|---|
| XYZEventOperator | xyzeventoperator | xyz, event, operator |
| acme-gateway-dev | acme-gateway-dev | acme, gateway, dev |
| 修复EventOperator的bug | 修复, eventoperator, 的, bug | 修复, event, operator, 的 |
| CR-291543784 | cr-291543784 | cr, 291543784 |
| getHTTPResponseCode | gethttpresponsecode | get, http, response, code |
| 要重试3次 timeout | 要重试, 3, 次, timeout | 要重, 重试, 次 |

Same function on write and query paths. Stamp TOKENIZER_VERSION in the DB; mismatch forces rebuild. Golden-fixture unit test over the hard cases (silent index/query mismatch is the #1 failure mode of owning a tokenizer).

### Scoring spec (additive, all terms bounded [0,1])

score = 0.45 x bm25_strict_norm + 0.25 x bm25_relaxed_norm + 0.20 x coverage + 0.07 x exact_ident + 0.03 x recency, plus 0.20 x cosine when the semantic lane arrives. Field weights via FTS5 bm25(): title 10, summary 3, note 1, meta 2, sub 0.6 (sub adds recall but never outranks a real term match). Multiplicative tiers were tried and broke (long session doc with cov=0 beat the correct short task); additive stays interpretable. Cross-store comparability becomes structural: one index, one scorer. Kind weights (task 1.0, memory 1.1, session 0.9) as a final multiplier if still wanted.

Known tuning item: a few long transcripts still scored high with cov=0 in the prototype; fix by computing coverage over all fields (prototype used title only) and verify per-column length normalization (columnsize) on the external-content table. Budget half a day against the golden set.

### SQLite implementation traps (all verified on this machine)

- `content=''` without `contentless_delete=1` silently refuses DELETE; stale postings accumulate forever. Use `content='doc'` (external content, rebuildable) or `contentless_delete=1` (SQLite >= 3.43; better-sqlite3 13.x ships 3.53). Note contentless cannot `rebuild`, so keep raw text in doc regardless.
- ORDER BY bm25(fts) is 3.7x faster than ORDER BY rank. Use the explicit function.
- detail=none / detail=column look like size wins but are 4-5x slower on multi-term OR and reject NEAR. Keep default detail.
- Escape every query term as `"..."` with internal `""` doubling: raw interpolation crashed on 11 of 17 adversarial tokens (`acme-gateway-dev` reads as column filter minus NOT, `v1.2.3` is a syntax error).
- Run `INSERT INTO fts(fts) VALUES('optimize')` after bulk builds: 5x query win for ~150 ms.
- sqlite-vec (if chosen over a plain BLOB column): bind integer PKs as BigInt (JS numbers bind as FLOAT and vec0 rejects them), int8 UPDATE is broken in 0.1.9 (model as DELETE+INSERT), `IN (...)` filters are silently ignored. Maintenance health is shaky (single maintainer, quiet since 2026-05). A plain Float32Array/int8 BLOB + JS cosine over candidates measured faster (12 ms full 50k scan, 0.1 ms over 250 candidates) with zero deps; full-scan JS is NOT viable (bandwidth-bound, no SIMD), candidates-only is the design.

### Measured results (prototype on the real 6,990-doc corpus)

- Build: ~15 s full, 52 MB total (vs QMD 663 MB). Single-doc upsert 0.05-0.27 ms (vs seconds + forked child today).
- Query: 0.9-3.3 ms keyword; hybrid total 34-101 ms including worker embed with the current GGUF model, drops to ~5-20 ms with e5-small ONNX.
- The original failure query ranks the right task #1. `XYZEventOperator` top-4 all real docs, cov=1.0. Mixed CJK queries hit.
- Deletable once shipped: buildLexQueries/buildLatinLexQueries + stopwords, CJK coverage tiebreak, per-type floors, SOURCE_WEIGHTS x decay on 1/rank, MIN_RERANKED_BLEND_SCORE, sanitizeForVec, overfetch plumbing, 4 stores to 1, all 15 dist/store.js patches, roughly 450 lines of workarounds plus the patch script.

## What we lose vs QMD (honest)

1. Cross-encoder rerank ceiling: already disabled everywhere for latency (11-20 s, event-loop stall); can be reintroduced later over our top-20 in a worker for non-interactive callers.
2. Chunk-level semantic granularity: doc-level vectors are weaker on 50 KB session transcripts where the relevant passage is 2% of the doc. Mitigations: keyword lane is strong exactly there; optionally keep chunk vectors for sessions only (26k vectors, still candidate-rescored). Quality delta unmeasured; the golden set should include transcript-paraphrase queries to decide.
3. We own the tokenizer and scorer forever. The eval harness is what makes that safe.

## Eval harness (build FIRST, week 1)

tests/search-golden.yaml, ~30 real queries with assertions: must_include (recall), top1_any/top1_kind (precision), must_rank_above (relative order), must_exclude (junk regression), min_coverage, max_latency_ms. Seed from real history: this GVR case, the star-system case (search.ts:349-357 comments), timeout 自动重试 case (memory-search.ts:98-123), identifier/CJK/mixed/paraphrase families. Runner `npm run search:eval`: build index from live DBs into temp (~15 s), run queries, report recall@10 / MRR / top1 / latency, write baseline JSON, fail CI on regression, `--explain <query>` prints term expansion and every score component.

## Open design questions for the plan session

1. Chunk vectors for sessions only vs doc-level everywhere (quality vs simplicity).
2. Embedding model: e5-small int8 (fast, weaker zh) vs Qwen3-0.6B ONNX (stronger zh, 7x slower). Decide on golden-set Chinese recall.
3. Vector storage: plain BLOB + JS cosine (zero deps, candidates-only) vs sqlite-vec (SQL-native, health risks). Default plain BLOB.
4. Migration/rollout: feature-flag parallel run old vs new? What replaces the bm25ScoreTasks fallback universe (CLOUD_MODE, glibc hosts, WALNUT_DISABLE_SEARCH)? The new keyword lane has no native deps beyond better-sqlite3, so it may BE the fallback.
5. Notes search (notes-v2.ts tiered ranking) and skill prefetch: migrate onto the same index or keep separate?
6. Process model: current forked-child indexer exists because QMD writes were seconds-long and synchronous; new upserts are sub-ms, so indexing may move inline with the embed step remaining in a worker thread. Decide.
7. UI: progressive render (keyword result instantly, semantic blend updates order) vs single response. Client-side rankOpenTasksFirst and metadata-match rerank in TodoPanel: keep, simplify, or remove?
8. What to do with the /api/qmd routes, SearchSection settings UI, and the 3.8 GB model cache after cutover.
9. Rollback story: keep QMD code behind a flag for one release or delete outright.

## Pointers

- Benchmark scripts (may be cleaned by OS): /tmp/walnut-search-bench/{fast,final,real,delck}.mjs (tokenizer, two-lane scoring, real-corpus build, contentless-delete trap), /tmp/fts5-eval/, /tmp/vec-eval/, /tmp/kwsearch-eval/, /tmp/vecprobe/.
- Key current-code files: src/core/search.ts, src/core/memory-search.ts, src/core/cjk.ts, src/core/qmd-store.ts, src/core/qmd-task-sync.ts, src/core/qmd-session-sync.ts, src/core/qmd-background-indexer.ts, scripts/patch-qmd.mjs, web/src/hooks/useTaskSearch.ts, web/src/components/tasks/search-results.ts.
- Unrelated but flagged during research: the cached EmbeddingGemma GGUF (~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf, 328,576,992 bytes) is the pre-fix upload missing dense layers; it loads silently and returns wrong vectors. Only matters if that model is ever selected; the active model is Qwen3. Re-download if kept.
