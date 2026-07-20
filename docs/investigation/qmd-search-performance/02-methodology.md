# Benchmark Methodology

## Questions

The study was designed to answer:

1. Is the latency mainly embedding, retrieval, or reranking?
2. Does removing reranking destroy semantic quality?
3. Which embedding model works best for English, Chinese, and mixed input?
4. Do short phrases behave differently from natural-language queries?
5. Should UI and agent search use the same latency-quality tradeoff?

## Environment

| Component | Value |
|---|---|
| CPU/GPU | Apple M4 Pro |
| Memory | 48 GiB unified memory |
| Architecture | arm64 |
| OS | macOS 15.7.4 |
| Node.js | 25.9.0 |
| QMD | 2.1.0 |
| node-llama-cpp | 3.18.1 |

The absolute latency numbers are hardware-specific. Relative comparisons used
the same machine, corpus, QMD version, and evaluation harness.

## Corpus

The benchmark used an isolated copy of the task semantic store:

| Property | Count |
|---|---:|
| Active task paths | 3,549 |
| Unique task bodies | 3,266 |
| Qwen3 chunks | 7,299 |
| EmbeddingGemma chunks | 7,256 |

Task paths can outnumber unique bodies because QMD can retain multiple active
paths that point to identical content.

No production store was modified by the benchmark.

## Query Sets

### Observed Set

Ten historical UI query strings were manually judged against the isolated
corpus. Each query could have multiple relevant tasks.

This set is closer to product behavior, but it is small and there is no click
telemetry. The judgments are manual qrels, not implicit user feedback.

### Controlled Set

Twelve known target tasks produced four paraphrases each:

- short English;
- natural English;
- natural Chinese; and
- natural mixed Chinese/English.

That produced 48 controlled queries. Each query has one target, so
`Success@K` and `Recall@K` are numerically equal for this set.

The controlled set measures whether a model can recover known targets under
language and phrasing changes. Because the query is derived from the target, it
must not be presented as production recall.

### Combined Slices

The complete 58-query set contained:

| Slice | Count |
|---|---:|
| English | 33 |
| Chinese | 12 |
| Mixed Chinese/English | 13 |
| Short phrase | 20 |
| Natural language | 38 |

## Models

| Label | Model | Dimensions |
|---|---|---:|
| BGE-M3 | `hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf` | 1,024 |
| EmbeddingGemma | `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf` | 768 |
| Qwen3 | `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf` | 1,024 |

Every embedding model was evaluated against an index built with that same
model. Vectors from different models were never mixed.

The reranking study used QMD 2.1.0's built-in default:

```text
hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/
qwen3-reranker-0.6b-q8_0.gguf
```

## Retrieval Modes

Each query was evaluated in three modes:

| Mode | QMD lanes |
|---|---|
| BM25 | `lex` |
| Vector | `vec` |
| Hybrid | `lex` + `vec` |

The candidate and result limits were both 40. The product decision uses the
hybrid result because it preserves exact lexical signals while adding semantic
recall.

For reranking runs, QMD's `llm_cache` was cleared before each run so cached
ranking output could not make the model look faster.

## Metrics

For query set \(Q\):

- `Success@K`: percentage of queries with at least one relevant document in
  the first K results.
- `Recall@K`: mean percentage of each query's judged-relevant documents found
  in the first K results.
- `Precision@10`: mean relevant fraction of the first 10 results.
- `MRR`: mean reciprocal rank of the first relevant result.
- `nDCG@10`: position-sensitive ranking quality with binary relevance.

Success answers "did the user get at least one useful hit?" Recall answers
"how much of the known relevant set was recovered?" MRR and nDCG describe
ordering.

## Timing Procedure

The harness recorded:

- total wall time;
- query embedding time;
- reranking time when enabled;
- cold first-query warmup; and
- warm per-query distribution.

Index builds recorded wall time, processed documents, embedded chunks, and
errors.

The browser/API check was separate from the in-process engine benchmark. It
confirmed that routing, serialization, HTTP handling, and result parsing did
not add seconds of hidden latency.

## Privacy and Reproducibility Boundary

This repository includes aggregate results but not the raw local evaluation
files. Raw files contain query text, task text, task identifiers, session
identifiers, and result lists.

A safe reproduction should:

1. export an isolated semantic store;
2. create locally appropriate qrels;
3. rebuild the store separately for every embedding model;
4. run BM25, vector, and hybrid retrieval for every query;
5. clear the reranker cache between reranking cases;
6. aggregate metrics before publication; and
7. inspect the aggregate for sensitive labels before committing it.

## Limitations

- Ten observed queries are not enough to estimate broad production relevance.
- Controlled paraphrases are target-derived.
- There is no click-through or successful-navigation telemetry.
- The measurements are from one Apple Silicon machine.
- Model load state, thermal state, and concurrent system load affect latency.
- BGE-M3 results describe this QMD configuration and corpus, not the model in
  every retrieval system.
- A repeated full GPU-backed test run later exhausted Metal memory; details are
  in [verification](05-verification.md).
