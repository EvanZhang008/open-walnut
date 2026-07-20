# Results

## Embedding Model Comparison

The following table uses hybrid BM25 + vector retrieval without reranking over
all 58 queries.

| Model | Success@1 | Success@5 | Success@10 | Recall@10 | MRR | nDCG@10 | p50 | p90 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| BGE-M3 | 25.9% | 36.2% | 36.2% | 34.8% | 0.292 | 0.292 | 149 ms | 440 ms |
| EmbeddingGemma | 37.9% | 63.8% | 75.9% | 75.3% | 0.496 | 0.547 | 55 ms | 98 ms |
| Qwen3 | **56.9%** | **79.3%** | **87.9%** | **86.5%** | **0.658** | **0.694** | 56 ms | **74 ms** |

Qwen3 materially improved both first-result quality and top-10 coverage. Warm
p50 was effectively tied with EmbeddingGemma, while Qwen3 had a better p90.

## Controlled Paraphrases

The controlled set contains 48 target-derived queries with one known relevant
task each.

| Model | Success@1 | Success@5 | Success@10 | Success@20 | MRR | nDCG@10 |
|---|---:|---:|---:|---:|---:|---:|
| BGE-M3 | 16.7% | 25.0% | 25.0% | 29.2% | 0.194 | 0.205 |
| EmbeddingGemma | 35.4% | 58.3% | 72.9% | 75.0% | 0.457 | 0.519 |
| Qwen3 | **52.1%** | **77.1%** | **87.5%** | **91.7%** | **0.622** | **0.679** |

These values compare model behavior. They are not production recall.

## Language and Query Length

This table reports Success@10 across the corresponding combined slice.

| Model | English, n=33 | Chinese, n=12 | Mixed, n=13 | Short, n=20 | Natural, n=38 |
|---|---:|---:|---:|---:|---:|
| BGE-M3 | 57.6% | 0.0% | 15.4% | 75.0% | 15.8% |
| EmbeddingGemma | 81.8% | 66.7% | 69.2% | **90.0%** | 68.4% |
| Qwen3 | **90.9%** | **75.0%** | **92.3%** | **90.0%** | **86.8%** |

The short-query result is important for interactive search: removing reranking
did not make short phrases stop working. Qwen3 recovered a relevant result in
the first 10 for 18 of 20 short-query cases.

## Cold and Warm Latency

| Model | Cold first query | Warmup query | Aggregate warm p50 | Aggregate warm p90 |
|---|---:|---:|---:|---:|
| BGE-M3 | 3.35 s | 194 ms | 149 ms | 440 ms |
| EmbeddingGemma | 1.18 s | 76 ms | 55 ms | 98 ms |
| Qwen3 | 2.00 s | 79 ms | 56 ms | 74 ms |

Model loading dominates the first query. Warm Qwen3 retrieval is not slower
than EmbeddingGemma in a way visible to a user.

## Index Construction

| Model | Documents | Chunks | Errors | Build time |
|---|---:|---:|---:|---:|
| EmbeddingGemma | 3,266 | 7,256 | 0 | 232.5 s |
| Qwen3 | 3,266 | 7,299 | 0 | 1,089.0 s |

Clean build artifacts measured during the study were approximately 313 MB for
EmbeddingGemma and 610 MB for Qwen3. SQLite copies used later in the study can
retain free pages, so the final copied file size is not a valid clean-size
comparison.

The quality gain justified Qwen3 as the default. EmbeddingGemma remains a
reasonable compact preset when disk use and rebuild time matter more than
multilingual retrieval.

## Reranker: Complete 58-Query Set

| Mode | Success@10 | Recall@10 | MRR | nDCG@10 | Total p50 |
|---|---:|---:|---:|---:|---:|
| No rerank | **87.9%** | **86.5%** | 0.658 | 0.694 | **56 ms** |
| Rerank top 10 | 86.2% | 84.8% | **0.661** | **0.698** | 3.06 s |

At depth 10 the reranker made ordering metrics slightly better, but did not
improve retrieval success and truncated candidates that were relevant below
rank 10. Paying about three seconds for that tradeoff is not appropriate for
interactive UI search.

## Reranker: Observed 10-Query Set

| Candidate depth | Success@10 | Recall@10 | MRR | nDCG@10 | Total p50 |
|---:|---:|---:|---:|---:|---:|
| 0 | 90.0% | 81.7% | 0.832 | 0.767 | 71 ms |
| 10 | 90.0% | 81.7% | 0.833 | 0.779 | 2.80 s |
| 20 | 100.0% | 81.7% | **0.848** | 0.780 | 4.40 s |
| 40 | 100.0% | **91.7%** | **0.848** | **0.821** | 9.29 s |

Depth 40 produced a real quality gain on the manually judged observed set. This
is the reason agent tools retain reranking: an agent can tolerate seconds for a
deeper candidate inspection, while a user typing into a filter cannot.

## Historical Production Latency

Four days of historical UI search logs contained:

| Measurement | Value |
|---|---:|
| Requests | 38 |
| Completed | 23 |
| Timed out | 15 |
| Completed p50 | 3.105 s |
| Completed p90 | 9.286 s |
| Completed maximum | 12.069 s |
| Maximum overlapping requests from one typed query | 8 |

The distribution aligns with local reranker measurements. It also shows why
browser abort alone was insufficient: obsolete inference continued to consume
compute after the browser stopped waiting.

## Isolated API Check

After the split implementation, three representative real API requests on an
isolated server completed in:

| Query class | API latency |
|---|---:|
| English | 73 ms |
| Chinese | 25 ms |
| Mixed Chinese/English | 23 ms |

These are examples, not a latency distribution. The engine benchmark above is
the statistically useful comparison.

The UI intentionally adds a 500 ms debounce before semantic HTTP search. Exact
structured references still produce an immediate local result, and the
authoritative server response confirms ownership without invoking QMD.
