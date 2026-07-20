# Root Cause Analysis

## Reported Behavior

The investigation began with four user-visible problems:

1. A copied session ID produced the correct task for about one second.
2. A later semantic response replaced that correct result with unrelated tasks.
3. Semantic search often took 15 to 25 seconds.
4. Some natural-language queries appeared to return no semantic result.

These symptoms had different causes and needed separate fixes.

## Request Timeline

Before the fix, the UI could follow this sequence:

```text
T+0 ms      User types a copied session ID
T+5 ms      In-memory task filtering finds the linked task
T+500 ms    Debounced HTTP semantic request starts
T+seconds   QMD finishes embedding, fusion, and local reranking
T+seconds   Server response replaces the local result set
```

The local result was not wrong. It was a provisional result based on the task
records already loaded by the browser. The later result became wrong because:

- the semantic index did not embed opaque IDs;
- the server did not treat an exact ID as a navigation reference;
- the browser accepted an older response even if the input had changed; and
- the server result replaced, rather than authoritatively resolving, the local
  task ownership.

## Root Cause 1: Stale Response Race

Browser request abort is not model-inference cancellation. Aborting `fetch()`
stops the browser from waiting, but an already-running local QMD inference can
still complete on the server.

One historical typing sequence generated eight overlapping server searches.
The oldest expensive search could finish after the newest query and overwrite
the visible result.

The correctness fix is a monotonically increasing request generation:

```text
input changes -> generation increments
request starts -> captures generation
response arrives -> accepted only if captured generation is still current
```

Abort remains useful for network cleanup, but the generation comparison is the
actual correctness boundary.

## Root Cause 2: Reranker Cost

The reranker is not a cosine-similarity calculation. QMD's default
Qwen3-Reranker reads the query and candidate text through a local cross-encoder
ranking context. Work grows with candidate count and candidate text length.

Measured p50 latency:

| Candidate depth | Dataset | Total p50 |
|---:|---|---:|
| 0, fusion only | 58 queries | 56 ms |
| 10 | 58 queries | 3.06 s |
| 20 | 10 observed queries | 4.40 s |
| 40 | 10 observed queries | 9.29 s |

The old interactive path paid the depth-40 cost for a keystroke-driven search.
That accounts for most of the observed latency.

## Root Cause 3: IDs Were Sent to the Wrong Retrieval System

Task and session IDs are opaque references. Embeddings are designed for
human-language similarity, not exact UUID-like navigation.

Adding IDs to embedded content would have created three problems:

- vector noise with no semantic value;
- a forced re-embed whenever a session link changed; and
- no guarantee that an exact ID would outrank semantically similar prose.

The correct fix is structured lookup before semantic retrieval. Exact
references bypass QMD. Meaningful partial references remain pinned before
semantic results.

QMD still retains identity in virtual document paths:

```text
task-<task-id>
sess-<session-id>
```

This allows result extraction without putting opaque identifiers into the text
sent to the embedding model.

## Root Cause 4: Embedding Model Fit

The previous BGE-M3 configuration performed poorly in this exact QMD pipeline
and corpus, especially for Chinese and mixed-language queries. This is not a
claim that BGE-M3 is universally poor.

The controlled Success@10 comparison was:

```text
BGE-M3          25.0%
EmbeddingGemma  72.9%
Qwen3           87.5%
```

Qwen3 was also materially stronger for mixed Chinese and English input while
matching EmbeddingGemma's warm search latency.

## Root Cause 5: Resource Contention

Historical production observations also included:

- 38 UI searches, of which 15 timed out;
- completed latency of 3.1 seconds p50 and 9.3 seconds p90;
- one input sequence with eight overlapping requests; and
- a server process observed at positive nice values between 5 and 15.

The nice value can cause scheduler starvation under machine load. It is an
operational amplifier, not the relevance or stale-response root cause.

## Why Normal Searches Are Not Serialized

Serializing every search would make a new query wait behind obsolete expensive
queries. That increases tail latency and does not solve stale-result
correctness.

Walnut instead:

- keeps ordinary SQLite WAL reads concurrent;
- serializes index mutations and embedding passes to avoid loading multiple
  model copies;
- blocks new reads only while a model switch closes and reopens stores; and
- rejects stale browser responses by generation.

This controls model memory without turning the search path into a global FIFO.
