# Index Maintenance

This document is the canonical design record for QMD cleanup and indexing
process boundaries. It replaces the former cleanup-worker decision skill.

## Decision

Task, session, and note hot paths only upsert or deactivate documents. Physical
deletion of inactive documents, orphaned content, and sqlite-vec rows runs in a
dedicated low-priority QMD child process.

Both full rebuilds and incremental worker passes compact the stores they
actually touched. Ordinary search remains available against committed SQLite
WAL snapshots while non-reset indexing runs.

## Why Cleanup Cannot Run in the Web Process

QMD uses `better-sqlite3` and `sqlite-vec`. Their mutations are synchronous.
Putting them behind a Promise queue serializes calls, but it does not move the
native work off the Node.js event loop.

A large `vectors_vec` deletion previously blocked the Web process for minutes,
delaying startup requests and task hydration. The blocked native stack ended in:

```text
better_sqlite3 -> sqlite3_step -> vec0Update_Delete_ClearVectors
```

WAL mode allows concurrent snapshots, but it does not make synchronous writer
lock waits asynchronous. Physical cleanup therefore belongs outside the Web
process.

## Immediate Consistency: Deactivate First

Deactivation is the immediate search-consistency boundary. Lexical and vector
result hydration both join against:

```sql
documents.active = 1
```

An inactive document stops appearing in hydrated results before physical rows
are deleted.

Physical cleanup is still required. QMD's sqlite-vec query probes more vectors
than the final limit before joining active documents. A sufficiently large
inactive-vector backlog can fill that probe and crowd active semantic results
out even though stale rows are filtered later.

The lifecycle is:

```text
entity deleted or changed
  -> deactivate old QMD path immediately
  -> search no longer hydrates it
  -> low-priority worker removes physical rows
  -> reset-only maintenance may reclaim file pages
```

## Worker Boundary

Physical cleanup is guarded by `WALNUT_QMD_WORKER=1`.

Startup backfill and admin Download/Re-index execute through:

```text
src/workers/qmd-index-worker.ts
```

The parent Web process reserves the in-process QMD mutation queue before
spawning the worker:

1. already-submitted jobs drain;
2. new Web-process mutations park;
3. the worker owns database writes;
4. every worker exit or startup failure releases the reservation; and
5. parked work resumes.

Without the reservation, a synchronous Web-process write could wait on the
worker's SQLite lock and recreate the event-loop stall.

## Model Pinning

One runtime embedding model is resolved before any QMD store is created:

```text
explicit QMD_EMBED_MODEL
  -> saved config.search.qmd_model
  -> Walnut built-in default
```

The resolved model is pinned and passed explicitly to every store and worker.
This prevents the Web process and child worker from instantiating
different-dimensional models.

A saved model selection is pending until Download/Re-index applies it. That
operation:

1. reserves the queue with reads blocked;
2. drains active readers;
3. closes Web-process stores;
4. pins the selected model;
5. starts the rebuild worker; and
6. reopens compatible stores before releasing reads.

Incremental workers always use the applied runtime model, never an unapplied
setting.

## Worker-Owned Resources

Session-history indexing can open daemon connections. Those connections and all
QMD stores are worker-owned resources.

Before reporting completion, the worker must:

- close every QMD store;
- disconnect every daemon connection; and
- exit if its parent IPC channel disappears.

Leaving a daemon pool alive leaves heartbeat timers alive, which prevents the
child from exiting and keeps the parent's queue reservation held indefinitely.

## Status API

QMD status statistics are built inside the indexing context and sent to the Web
process as an IPC snapshot.

`GET /api/qmd/status` reads only that snapshot. It must not lazily create a QMD
store or execute SQLite in the request path. A status request that opens a store
can run synchronous schema work or wait on a worker lock.

Status reports active document counts. Inactive historical rows are not part of
the searchable corpus.

## Incremental Cleanup

After an incremental worker pass, physical cleanup runs only for stores touched
by that pass. This bounds stale-vector accumulation without opening unrelated
stores or expanding the maintenance window.

Development-mode startup indexing remains in-process for deterministic tests,
but physical cleanup is disabled there.

## File Compaction

Deleting rows does not return SQLite pages to the filesystem. Production
metadata previously showed:

| Store | Freelist pages | File size | Live pages |
|---|---:|---:|---:|
| Tasks | 92.6% | about 0.9 GB | less than 100 MB |
| Sessions | 95.0% | about 1.8 GB | less than 100 MB |

After a read-blocking store reset, the worker compacts a database only when both
conditions hold:

- freelist is at least 25% of all pages; and
- freelist occupies at least 64 MiB.

Compaction uses QMD's VACUUM maintenance API while the parent already has
readers blocked. Ordinary startup and incremental workers do not VACUUM because
exclusive access would interrupt interactive search.

## Invariants

1. Do not call `cleanupOrphanedVectors`, `deleteInactiveDocuments`, or
   `cleanupOrphanedContent` from the Web process or entity sync helpers.
2. Do not treat a Promise queue as event-loop isolation for synchronous native
   SQLite or model work.
3. Do not remove the parent queue reservation around the child worker.
4. Do not leave daemon pools or stores alive after worker completion.
5. Do not query or initialize QMD stores from the status route.
6. Do not make stale documents searchable while waiting for maintenance.
7. Do not VACUUM during ordinary background sync.
8. Do not let workers use an embedding model different from the applied
   process model.

## References

Implementation:

- [`src/core/qmd-background-indexer.ts`](../../../src/core/qmd-background-indexer.ts)
- [`src/core/qmd-maintenance.ts`](../../../src/core/qmd-maintenance.ts)
- [`src/core/qmd-stats.ts`](../../../src/core/qmd-stats.ts)
- [`src/core/qmd-sync-utils.ts`](../../../src/core/qmd-sync-utils.ts)
- [`src/core/qmd-work-queue.ts`](../../../src/core/qmd-work-queue.ts)
- [`src/workers/qmd-index-worker.ts`](../../../src/workers/qmd-index-worker.ts)
- [`src/web/server.ts`](../../../src/web/server.ts)

Tests:

- [`tests/core/qmd-sync-reconciliation.test.ts`](../../../tests/core/qmd-sync-reconciliation.test.ts)
- [`tests/core/qmd-incremental-cleanup.test.ts`](../../../tests/core/qmd-incremental-cleanup.test.ts)
- [`tests/core/qmd-work-queue.test.ts`](../../../tests/core/qmd-work-queue.test.ts)
