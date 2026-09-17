# Task and session status

## Summary

Task phase, unread state, and session process state answer different questions. Reading an answer does not complete a task. Finishing a foreground reply does not finish detached work. A session event's phase hint is not a committed task update.

These are the maintenance decisions from the September 2026 status regression. The storage and browser protections are committed; the full background, FIFO, and snapshot changes still have uncommitted dependencies as of 2026-09-11. This record is not evidence that a particular build contains the entire repair.

## What each state means

| State | Meaning | Must not imply |
|---|---|---|
| Task `TODO` | Not started | An unfamiliar stored phase |
| Task `IN_PROGRESS` | Work continues, including background work | The foreground reply must remain open |
| Task `NEED_ACTION` | Human action is needed | Unread content or completed work |
| Task `COMPLETE` | The human confirmed completion | A late Running hint may reopen it |
| `unread` | Output has not been read | The task needs a different phase after reading |
| Session Running | Foreground or background execution, an active team, or a valid future wakeup | The current foreground reply is unfinished |
| Session Waiting | Permission, question, or plan approval is pending | A new API process-status enum |
| Session Idle | Foreground and related background work have ended | The CLI process died |

`AGENT_COMPLETE` is the previous name of `NEED_ACTION`, with the same handback meaning. Waiting is derived from API `running` plus pending permission. A historical `cronActive` flag alone does not prove current work. Process death takes precedence over background hints.

## Failures and rejected shortcuts

### Unknown phases are data, not TODO

An older schema-10 writer read schema-11 data, treated the unfamiliar `NEED_ACTION` as `TODO`, and persisted that guess during a whole-store write. One write changed 131 task phases; it was not 131 intentional task edits. Later history did not show a second persistent bulk rewrite, but snapshot gaps prevent proving that none occurred.

Reject a newer database before changing journal settings or schema. Map only known legacy phases; preserve an unknown stored value instead of inventing a fallback. SQLite's explicit `phase`, `status`, and `updated_at` columns override payload fields when reading a row, and payload may omit those keys entirely.

Code: [`getDb`, `rowToTask`](../../src/core/task-db.ts), [`migratePhase`](../../src/core/phase.ts). Regression: [`tests/core/task-db.test.ts`](../../tests/core/task-db.test.ts), cases for newer-schema refusal and an unknown phase surviving another task's edit; [`tests/core/phase.test.ts`](../../tests/core/phase.test.ts).

### A phase rename must survive the installed sync adapter

A later recurrence had a different sequence: the result handler correctly wrote `NEED_ACTION`, then an external sync adapter mapped the remote implementation step back to `IN_PROGRESS`. Its preservation group still listed `AGENT_COMPLETE` but omitted the new name, and its push mapping omitted the new name too. Correct session settlement and a current server build did not prevent this reversal.

Test both directions through the installed adapter: `NEED_ACTION` must map to the intended remote step, and an echo of that coarse step must preserve the finer local phase. Keep genuine remote closes and moves to a different workflow group effective. Exercise the delayed note/summary push and at least one subsequent pull, not just the instant the reply finishes. External adapters are built and loaded independently; a source edit is not proof the running adapter changed. Confirm a loader event and the actual round trip after reload.

Raw single-row and bulk updates must preserve an existing fine-grained phase when an incoming coarse status agrees with its derived status. Both `IN_PROGRESS` and `NEED_ACTION` derive to `in_progress`; reversing that value loses the handback. Include a changed title or summary in the regression: an otherwise identical patch exits at the dirty check and never exercises the faulty derivation. Explicit phase changes and genuine coarse status changes remain effective.

Code boundary: [`prepareRawUpdate`](../../src/core/task-manager.ts), [`IntegrationSync` and `SyncPollContext`](../../src/core/integration-types.ts), the sync poll callback in [`server.ts`](../../src/web/server.ts), and the installed adapter's phase mapping and delta-pull tests. Core regression: [`tests/core/task-db.test.ts`](../../tests/core/task-db.test.ts). Keep provider-specific fixtures in that adapter's own repository.

### SQL commit must invalidate cache before yielding

The failing order was SQL commit to `IN_PROGRESS`, then asynchronous lock cleanup, then cache invalidation. A result handler ran during cleanup, read cached `NEED_ACTION`, and skipped its phase write as already satisfied. The database stayed `IN_PROGRESS` while the session was Idle.

Invalidate both row shadow and task cache immediately after the SQL transaction, before asynchronous cleanup. `PRAGMA data_version` changes for another connection's commit, not this connection's own writes, so it cannot replace this invalidation.

Code: [`invalidateRowShadow`](../../src/core/task-manager.ts). Regression: [`tests/core/task-db.test.ts`](../../tests/core/task-db.test.ts), `exposes committed %s data before asynchronous lock cleanup finishes`, covers raw, bulk update/add/delete, and whole-store writes by holding cleanup open.

### A read can race with a real task update

A generic `update:<id>` echo guard cannot identify which write produced the next event. A read-marker request can be pending while a real phase commit arrives first; consuming that event as the read's echo loses the phase update. Read-marker-only writes must not install that guard.

Task events and task fetches carry committed task phase. `session:status-changed.phase` is only a hint and must not overwrite it, including in a panel's fallback task copy. Initial HTTP load can also finish before WebSocket connects; both first connection and reconnection need a debounced task refetch.

Code: [`useTasks`](../../web/src/hooks/useTasks.ts), [`SessionPanel`](../../web/src/components/sessions/SessionPanel.tsx), [`App`](../../web/src/App.tsx). Regression: [`tests/e2e/browser/session-hold-turn-subagents.spec.ts`](../../tests/e2e/browser/session-hold-turn-subagents.spec.ts), red-row cases for late hints, reading races, and reconnection.

### Foreground settlement and session liveness are separate

Holding every result until all background work ends blocks reply settlement and the next message. Treating every result as session completion instead paints Idle over real work. Keep gating background work separate from detached background work: detached work keeps Running and `IN_PROGRESS` but permits foreground settlement and its consumed watermark to advance.

A new message after foreground settlement needs a fresh turn even when the session is still Running for detached work. Establish that turn before transport dispatch, not after the send acknowledgment: a fast CLI may return its result first. A true mid-turn injection must preserve stream deduplication. Failed-send rollback must not overwrite state advanced by a result or a newer turn.

Code: [`ClaudeCodeSession._completeTurnOnIdle` and `writeMessage`](../../src/providers/claude-code-session.ts), [`RemoteSessionManager.writeMessage`](../../src/providers/remote-session-manager.ts), [`projectProcessStatus`](../../src/core/session-snapshot-apply.ts). Regressions: [`tests/providers/session-hold-turn-subagents.test.ts`](../../tests/providers/session-hold-turn-subagents.test.ts), [`tests/providers/mid-turn-inject-no-dedup-reset.test.ts`](../../tests/providers/mid-turn-inject-no-dedup-reset.test.ts), [`tests/e2e/detached-bg-phase.test.ts`](../../tests/e2e/detached-bg-phase.test.ts), and the browser spec above.

### FIFO markers must precede consumption, not merely acknowledgment

Appending the user marker after a successful send lets a fast CLI answer before the turn-start marker exists. Appending first and truncating on failure is also unsafe: concurrent CLI output may already follow the marker, so truncation would delete real history.

For `send-markers-v1`, serialize each session's writes and hold the final newline: write the payload body, append ordered markers to the daemon-owned stream, then release the newline so the CLI can consume the line. Use the same descriptor and deadline. A zero-byte failure creates no marker; a partial write or marker failure is not a successful delivery. Never alter the canonical CLI transcript.

Code: [`handleSendCommand`, `chainFifoWrite`, `appendUserMarkerLine`](../../src/providers/daemon-core.ts). Regression: [`tests/providers/daemon-cmd-send-strict-ack.test.ts`](../../tests/providers/daemon-cmd-send-strict-ack.test.ts).

### Same stream offset does not mean same status

`v` orders complete lines within one stream file. Permission, process death, and time-driven wakeup expiry can change status without adding a line. `streamEpoch` identifies the file, `statusRevision` orders accepted status, and runner identity plus `turnGen` identify the live turn. These are not interchangeable clocks.

Check the relevant identity and revision again inside the task write lock, after asynchronous work. Otherwise a delayed Running write can overwrite a newer Waiting or Idle state at the same `v`. Do not advance the durable turn-end `consumedOffset` to a mid-turn snapshot. Expiring a wakeup may settle a live session; old wakeup metadata must not resurrect a terminal one. Terminal handback must recheck source and sibling activity and pending recovery under the lock.

Permission participates in snapshot equality even when `process_status` is unchanged. An explicit `null` clears Waiting; an omitted field in a partial event does not. A full legacy task snapshot without permission does clear the old value.

Code: [`applySnapshot`](../../src/core/session-snapshot-apply.ts), [`applySessionPhase` and `handBackTaskOnSessionEnd`](../../src/core/phase.ts), [`SessionStatusStore`](../../web/src/stores/session-status-store.ts). Regressions: [`tests/core/session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), [`tests/web/session-status-store.test.ts`](../../tests/web/session-status-store.test.ts).

## When investigating a recurrence

1. Compare the affected task's persisted phase, API phase, and rendered row before changing anything. Check unread and process state separately. A missing red row is not proof of another database rewrite.
2. Match historical transitions by task ID and time. Restore only proven damage with backup and per-row compare-and-swap; preserve later edits, content, ordering, dates, and read markers. A repair must advance the sync timestamp if peers reject equal-timestamp changes. Exporting a projection does not prove a replica imported it, and a direct database write does not broadcast a browser event.
3. Inspect the actual running entry and its source map, not every map left in a `clean:false` build. Old chunks can otherwise overwrite newer evidence during a source-map scan. Check schema compatibility separately from whether a commit builds.
4. Exercise the built SPA in WebKit and Chromium with realistic task density across Focus, Satellite, Wait, and Backlog. Include read-marker requests held open, late session hints, first-connect delay, reconnect, detached work across turns, permission allow/deny, questions, and plan approval. Check both the API state and visible controls.
5. Report the exact tested artifact and remaining failures. A partial independent commit is not the fully tested working tree, and neither alone proves the running build matches.

For the distinction between turn-end and actual process death, see [No session-end gist](no-session-end-gist.md).
