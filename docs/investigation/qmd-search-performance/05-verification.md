# Verification and Operations

## Build and Automated Coverage

The implementation was checked with:

| Layer | Result |
|---|---|
| Server build | PASS |
| Frontend Vite build | PASS |
| Focused unit group | 38/38 |
| Focused integration group | 14/14 |
| Browser search scenarios | 2/2 |
| Search quality gate | PASS |
| `git diff --check` | PASS |

A final non-GPU rerun covered 22 key contracts across four files:

```sh
npx vitest run \
  tests/web/routes/search-reference-bypass.test.ts \
  tests/agent/search-rerank-contract.test.ts \
  tests/web/task-search-results.test.ts \
  tests/core/qmd-session-sync-content.test.ts
```

Result: 4 files passed, 22 tests passed.

## Browser Scenarios

The Playwright flow used the homepage task panel, the primary task/session
surface.

### Stale Semantic Response

1. Enter a first semantic query.
2. Allow its server request to start.
3. Enter a second query.
4. Fault-inject an `AbortController` that does not actually abort.
5. Return the first response after the input has changed.
6. Verify the first result never replaces the second query's list.

This proves the generation guard, not just browser abort.

### Authoritative Session Ownership

1. Seed a task with a stale local session link.
2. Seed the session record with a different authoritative task owner.
3. Search the complete session ID.
4. Verify the immediate UI result appears.
5. Wait for the server response.
6. Verify the authoritative task remains.
7. Open the result and verify the expected task detail.

The screenshots were manually inspected and browser errors were checked. They
remain local test artifacts because screenshots can expose user-specific UI
content and should not be committed to a public repository.

Test source:

- [`tests/e2e/browser/todo-search-session-id.spec.ts`](../../../tests/e2e/browser/todo-search-session-id.spec.ts)

## Real QMD Coverage

The GPU-backed QMD E2E suite exercises:

- task and session store status;
- serialized startup indexing phases;
- watcher indexing through the shared mutation queue;
- content-event indexing;
- task and session semantic retrieval;
- result ID extraction;
- semantic-only retrieval;
- English, Chinese, and mixed short queries;
- structured session-ID ownership;
- task and session deletion; and
- session metadata refresh without a lifecycle event.

The original 22-case real QMD suite passed 22/22. The newly added session
metadata refresh case passed 1/1 in isolation.

Test source:

- [`tests/e2e/qmd-task-session-search.test.ts`](../../../tests/e2e/qmd-task-session-search.test.ts)

## Metal Out-of-Memory Limitation

A later attempt to run all 23 GPU-backed cases together, after repeated model
experiments in the same environment, exhausted Metal GPU memory:

```text
kIOGPUCommandBufferCallbackErrorOutOfMemory
QMD search failed for: task/session
```

After the Metal backend entered that state, later tests returned missing stores
or empty search results. Therefore this study does not claim a clean 23/23
single-run result.

Evidence supporting a resource failure rather than a semantic assertion
failure:

- the original 22 cases passed together before the exhausted run;
- the new case passed alone;
- failures began after Metal reported out-of-memory; and
- failures then affected unrelated task and session stores.

This remains a real operational risk to track. The production mitigation is to
serialize index mutations so multiple model-heavy embedding jobs do not load
concurrently. A future test-harness improvement should isolate GPU model
lifetime between suites or run the QMD E2E file in a fresh process.

## Operational Interpretation

Expected warm behavior on comparable hardware:

- exact ID: immediate provisional result, then structured server confirmation;
- natural-language UI query: 500 ms debounce plus tens of milliseconds of warm
  QMD retrieval;
- first query after model load: roughly one to two seconds for Qwen3 warmup;
- agent search with depth-40 reranking: several seconds by design; and
- model change: index rebuild measured in minutes, not an interactive action.

If UI search returns to multi-second warm latency, investigate in this order:

1. Confirm the UI request still sends `rerank: false`.
2. Check whether the model is cold-loading or being repeatedly recreated.
3. Check for overlapping requests and stale generations.
4. Check index/model metadata and vector dimensions.
5. Check whether indexing jobs overlap.
6. Check process nice value and scheduler-latency warnings.
7. Check for Metal memory errors.

## Acceptance Criteria

The implementation is considered correct when:

- exact references do not invoke QMD;
- partial references stay ahead of semantic results;
- natural-language queries still return vector-derived matches;
- Chinese and mixed-language short-query cases pass;
- an old response cannot replace a newer query;
- agent tools still invoke reranking;
- normal reads remain concurrent during ordinary indexing;
- model switches drain readers and rebuild incompatible vectors; and
- failures are surfaced rather than displayed as authoritative empty results.
