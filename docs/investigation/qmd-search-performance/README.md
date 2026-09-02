# QMD Search Performance Study

Status: implemented and verified on 2026-07-19. **Historical as of 2026-09-01:** the third-party
engine studied here (`@tobilu/qmd`) has been removed. Its three unfixable limits (a hardcoded
porter/unicode61 tokenizer, keyword lanes that annihilate on a single missing term, and `1/rank`
scores that carry no word coverage) are exactly what this study kept working around, and they are
why Walnut now runs its own index: [`src/lib/hybrid-search/README.md`](../../../src/lib/hybrid-search/README.md).
Everything below still describes real product behavior (the split interactive/agent search, the
structured identifier lane, serialized index mutations), so treat it as the reasoning trail, not as
a map of today's code.

This directory records the investigation that changed Walnut's task and session
search from a slow, race-prone interaction into a split search architecture:

- Interactive UI search uses QMD BM25 + vector fusion without local reranking.
- Agent search keeps QMD's reranker for deeper, latency-tolerant retrieval.
- Exact task IDs, session IDs, and external URLs use structured lookup.
- Qwen3-Embedding-0.6B Q8 is Walnut's default embedding model.
- Index mutations are serialized; ordinary searches remain concurrent.
- Superseded browser responses cannot overwrite a newer query.

## Headline Result

The model study used one isolated corpus with 3,549 active task paths and 3,266
unique task bodies. The query set contained 48 controlled multilingual
paraphrases and 10 manually judged queries derived from historical UI searches.

| Embedding model | Controlled Success@10 | Chinese Success@10 | Mixed Success@10 | Warm hybrid p50 |
|---|---:|---:|---:|---:|
| BGE-M3 | 25.0% | 0.0% | 15.4% | 149 ms |
| EmbeddingGemma | 72.9% | 66.7% | 69.2% | 55 ms |
| Qwen3-Embedding-0.6B | **87.5%** | **75.0%** | **92.3%** | **56 ms** |

Qwen3 improved multilingual retrieval without materially increasing warm query
latency over EmbeddingGemma. Its tradeoff is index construction: 1,089 seconds
for Qwen3 versus 232 seconds for EmbeddingGemma in this study.

## Model Provenance and Footprint

The models come from different research teams:

- BGE-M3 was created by the BGE team at the Beijing Academy of Artificial
  Intelligence (BAAI).
- EmbeddingGemma was created by Google.
- Qwen3-Embedding was created by Alibaba Cloud's Qwen team.

The following are the exact cached GGUF artifacts measured in the study
environment. Model download size and generated SQLite index size are separate
costs and must not be compared as though they were the same file.

| Model artifact | Cached model size | Vector dimensions | Clean task index |
|---|---:|---:|---:|
| BGE-M3 F16 | 1.08 GiB | 1024 | Not recorded |
| EmbeddingGemma 300M Q8 | 313 MiB | 768 | 313 MB |
| Qwen3-Embedding 0.6B Q8 | 610 MiB | 1024 | 610 MB |

A comparable clean BGE-M3 index size was not recorded. Its existing task
database had accumulated roughly 92.6% freelist pages after repeated rebuilds,
so the approximately 0.9 GB file size mostly represented reclaimable SQLite
pages rather than live index data. Rebuilding and compacting BGE-M3 solely to
obtain a size number was not necessary for the model decision.

## Why Qwen3 Won This Study

The experiment establishes an outcome, not a complete causal attribution.
Qwen3 is a newer embedding-focused member of the Qwen family with strong
multilingual and CJK coverage, and its Q8 artifact retained useful quality at a
moderate local footprint. Those characteristics are consistent with the large
Chinese and mixed-language gains measured here.

The result also reflects Walnut's retrieval architecture:

- Every model used the same no-rerank QMD hybrid path, combining a dense vector
  lane with BM25 through reciprocal-rank fusion.
- Qwen3 therefore improved the semantic lane while BM25 continued to cover
  exact lexical matches.
- BGE-M3 supports dense, sparse, and multi-vector retrieval, but this QMD path
  exercised its dense representation alongside QMD's separate BM25 lane. The
  study did not evaluate BGE-M3's full native retrieval stack.

The correct conclusion is that Qwen3 performed best for this Walnut corpus,
query set, GGUF runtime, and QMD integration. It is not evidence that Qwen3
universally outperforms BGE-M3 or EmbeddingGemma on every corpus or retrieval
architecture.

QMD 2.1.0 uses Qwen3-Reranker-0.6B Q8 by default. On this corpus, reranking 40
candidates took 9.29 seconds p50. It improved observed Recall@10 from 81.7% to
91.7%, which is useful for agent retrieval but incompatible with
keystroke-driven UI search.

## Documents

- [Root cause](01-root-cause.md): symptoms, causal analysis, and rejected
  explanations.
- [Methodology](02-methodology.md): corpus, query sets, metrics, environment,
  and study limitations.
- [Results](03-results.md): embedding, reranker, language, query-length, and
  production latency results.
- [Implementation](04-implementation.md): request flow, structured reference
  lookup, model lifecycle, and concurrency design.
- [Verification](05-verification.md): automated coverage, browser scenarios,
  screenshots, and the Metal out-of-memory limitation.
- [Index maintenance](06-index-maintenance.md): worker isolation, deactivation,
  cleanup, status snapshots, and compaction policy.
- [Aggregate data](aggregate-results.json): machine-readable, anonymized
  metrics used by these documents.

## Metric Warning

`Success@10` and `Recall@10` are not interchangeable:

- `Success@10`: fraction of queries with at least one relevant result in the
  first 10 results.
- `Recall@10`: mean fraction of all judged-relevant documents returned in the
  first 10 results.

They are numerically equal only when each query has exactly one relevant
document. The controlled set has one target per query, while the observed set
can have multiple relevant tasks.

The controlled set is target-derived. It is useful for comparing models but
must not be described as production recall or click-derived relevance.

## Upstream QMD Position

[QMD 2.1.0](https://github.com/tobi/qmd) defaults to EmbeddingGemma because it
has a smaller footprint. Its documentation explicitly recommends
Qwen3-Embedding-0.6B for multilingual and CJK corpora. QMD's built-in default
reranker is Qwen3-Reranker-0.6B Q8.

Walnut's Qwen3 embedding default is therefore an upstream-supported
configuration selected using Walnut-specific multilingual measurements, not a
custom or unsupported QMD mode.

## Data Safety

Raw task text, individual historical queries, result lists, task IDs, session
IDs, and local screenshots are intentionally not checked into this public
repository. They can reveal private user data even when the aggregate study is
safe to publish.

The checked-in JSON contains only aggregate counts, metrics, model identifiers,
and runtime information required to audit the decision.
