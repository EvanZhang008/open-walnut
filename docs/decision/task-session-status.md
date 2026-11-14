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
| Task `COMPLETE` | The human confirmed completion; a new message from a human or a peer task reopens it | A late Running hint or an automated send may reopen it |
| `unread` | Output has not been read | The task needs a different phase after reading |
| Session Running | Foreground or background execution, an active team, or a valid future wakeup | The current foreground reply is unfinished |
| Session Waiting | Permission, question, or plan approval is pending | A new API process-status enum |
| Session Idle | Foreground and related background work have ended | The CLI process died |

`AGENT_COMPLETE` is the previous name of `NEED_ACTION`, with the same handback meaning. Waiting is derived from API `running` plus pending permission. A historical `cronActive` flag alone does not prove current work. Process death takes precedence over background hints.

## Failures and rejected shortcuts

### A new message reopens a completed task; a late hint does not

A completed task whose session received another message stayed `COMPLETE` while its agent ran the new turn, and its output was never announced: no red row, no unread dot (2026-09-23 report). The terminal guard treated every session trigger as background noise, but a message is not noise. Completing a task kills its CLI, so a message that reaches the session afterwards is a human typing in the still-visible column or a peer task sending work, and the agent is now running.

The rule since 2026-09-23: `session:input` is the one session trigger allowed past the terminal guard, and only when the send's provenance (the `SESSION_SEND` bus source) names a human or a peer task: the console, the iOS app, the `walnut` CLI, a peer send, the Execute-continue button, a delivered letter. It then moves `COMPLETE` to `IN_PROGRESS`, clears the read marker and `completed_at`, re-points the task's session slot at the session that got the message, and lets the turn hand the task back the normal way. A late result, a turn start, an error, a permission prompt and the reconciler still lose to `COMPLETE`, because each may describe work that predates the human's decision. So does every automated send: the auto-continue nudge fires about three minutes after the human may have clicked done, and a routine bound to a finished task would reopen it on every trigger, so the task could never be closed. The allowed sources are an allowlist on purpose: a deliberate path missing from it keeps the old behavior, while a missed automated path on a denylist would reopen finished tasks forever. Sync pulls stay blocked. The raw single-row write takes an explicit `reopenTerminal` flag for this one caller, so no other path can leave the terminal phase by accident.

Known trade-off, shared with every input transition: the phase moves at send time, before delivery is confirmed. A human's send that is later parked or fails leaves the task `IN_PROGRESS`; the error path or the reconciler then hands it back as a red row, and completing it again stamps a fresh `completed_at`.

Code: [`sessionInputPhase`, `sendSourceReopensTerminal`, `applySessionPhase`](../../src/core/phase.ts), [`prepareRawUpdate`](../../src/core/task-manager.ts), the `SESSION_SEND` handler and `syncPhaseAfterSend` in [`claude-code-session.ts`](../../src/providers/claude-code-session.ts). Regression: [`tests/core/phase-triage-gate.test.ts`](../../tests/core/phase-triage-gate.test.ts) (reopen, background echoes, repeat cycle), [`tests/core/terminal-phase-guard.test.ts`](../../tests/core/terminal-phase-guard.test.ts) (raw opt-in), [`tests/e2e/phase-rollback.test.ts`](../../tests/e2e/phase-rollback.test.ts), browser flow [`tests/e2e/browser/task-reopen-on-message.spec.ts`](../../tests/e2e/browser/task-reopen-on-message.spec.ts).

### Unknown phases are data, not TODO

An older schema-10 writer read schema-11 data, treated the unfamiliar `NEED_ACTION` as `TODO`, and persisted that guess during a whole-store write. One write changed 131 task phases; it was not 131 intentional task edits. Later history did not show a second persistent bulk rewrite, but snapshot gaps prevent proving that none occurred.

Reject a newer database before changing journal settings or schema. Map only known legacy phases; preserve an unknown stored value instead of inventing a fallback. SQLite's explicit `phase`, `status`, and `updated_at` columns override payload fields when reading a row, and payload may omit those keys entirely.

Code: [`getDb`, `rowToTask`](../../src/core/task-db.ts), [`migratePhase`](../../src/core/phase.ts). Regression: [`tests/core/task-db.test.ts`](../../tests/core/task-db.test.ts), cases for newer-schema refusal and an unknown phase surviving another task's edit; [`tests/core/phase.test.ts`](../../tests/core/phase.test.ts).

### A phase rename must survive the installed sync adapter

A later recurrence had a different sequence: the result handler correctly wrote `NEED_ACTION`, then an external sync adapter mapped the remote implementation step back to `IN_PROGRESS`. Its preservation group still listed `AGENT_COMPLETE` but omitted the new name, and its push mapping omitted the new name too. Correct session settlement and a current server build did not prevent this reversal.

Test both directions through the installed adapter: `NEED_ACTION` must map to the intended remote step, and an echo of that coarse step must preserve the finer local phase. Keep genuine remote closes and moves to a different workflow group effective. Exercise the delayed note/summary push and at least one subsequent pull, not just the instant the reply finishes. External adapters are built and loaded independently; a source edit is not proof the running adapter changed. Confirm a loader event and the actual round trip after reload.

Raw single-row and bulk updates must preserve an existing fine-grained phase when an incoming coarse status agrees with its derived status. Both `IN_PROGRESS` and `NEED_ACTION` derive to `in_progress`; reversing that value loses the handback. Include a changed title or summary in the regression: an otherwise identical patch exits at the dirty check and never exercises the faulty derivation. Explicit phase changes and genuine coarse status changes remain effective.

Code boundary: [`prepareRawUpdate`](../../src/core/task-manager.ts), [`IntegrationSync` and `SyncPollContext`](../../src/core/integration-types.ts), the sync poll callback in [`server.ts`](../../src/web/server.ts), and the installed adapter's phase mapping and delta-pull tests. Core regression: [`tests/core/task-db.test.ts`](../../tests/core/task-db.test.ts). Keep provider-specific fixtures in that adapter's own repository.

### ACP reconnect must distinguish worker liveness from turn completion

A live ACP worker can have `turnActive: false`. Reusing the disconnected record's Running state ignores the worker's answer and can leave the task In Progress indefinitely. Use `turnActive` and pending permissions from the worker snapshot. A control-only self-report must not create a Running state that its completion never clears. Restore subscriptions even when a status write is unnecessary or superseded. An explicit `no_worker` is evidence of absence; an RPC error or missing snapshot is not.

Condition the session write on its status revision, runtime identity, and accepted command ID. Recheck those after the asynchronous handback reaches the task write lock. Handback is edge-triggered: repeated idle probes must not undo a human's later phase choice. Preserve the durable identity needed for lazy session loading.

Code: [`recoverDisconnectedSessions`](../../src/providers/daemon-connection.ts), [`opGetState`](../../src/providers/acp-worker/worker.ts), and [`handBackTaskOnSessionEnd`](../../src/core/phase.ts). Regression: [`tests/core/session-end-hands-task-back.test.ts`](../../tests/core/session-end-hands-task-back.test.ts), including a live worker with an ended turn and probes overtaken by new work.

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

### A continued background agent is a new invocation

The CLI reuses a background agent's `task_id` when the agent is continued, but emits a new `tool_use_id`. A terminal flag keyed only by task ID hides the second invocation from both live and rebuilt state, producing Idle while the agent is still working. Scope terminal stickiness to the invocation: a new identified start resets it, while late progress or completion from the previous invocation cannot end the current one. Identity-free patches retain stream ordering. Preserve the identity through level reconciliation and daemon task-state recovery.

Code: [`foldLine`](../../src/providers/daemon-fold.ts), [`foldSessionTail`](../../src/core/session-reconcile.ts), and the background handlers in [`ClaudeCodeSession`](../../src/providers/claude-code-session.ts). Regression: [`daemon-fold.test.ts`](../../tests/providers/daemon-fold.test.ts), [`session-hold-turn-subagents.test.ts`](../../tests/providers/session-hold-turn-subagents.test.ts), [`daemon-task-rebuild-memory.test.ts`](../../tests/providers/daemon-task-rebuild-memory.test.ts), and the resumed-agent browser scenario.

### A valid snapshot disproves a stale reconnect activity

A recovered host can return the same stream version and the same Running projection while a background process waits. An early duplicate return must not preserve an old reconnect activity forever. Clear only that activity under a revision and epoch guard, publish the committed status, and preserve the last-active timestamp. Do not erase real tool activity, pending permission, or a newer reconnect attempt.

Code: [`applySnapshot`](../../src/core/session-snapshot-apply.ts). Regression: the reconnect activity cases in [`session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), including equal versions, stale snapshots, and an activity that changes away and back during the conditional write.

### Recovered transport can leave the stream watermark unchanged

A disconnected session can keep the same `consumedOffset` and daemon `v` after its host returns. The equal-version rule that protects true process death must not permanently preserve a `remote_unreachable` error. Capture record revision, stream epoch, runner identity, and turn generation before requesting the snapshot, then recheck them under the write lock before replacing that connection diagnosis. Keep unsolicited snapshots and genuinely terminal records under the existing ordering rules. A live CLI can project Idle or Running depending on its remaining work; do not use process liveness alone to choose Running.

Tests must seed the durable watermark at the returned snapshot version. A fixture with no `consumedOffset` skips the exact branch that stranded the real records. A covered session's legacy recovery writer must not announce success for a patch the snapshot gate rejects; retain the separate PID update, but leave status to the guarded snapshot path.

Code: [`captureSnapshotReadGuard` and `applySnapshot`](../../src/core/session-snapshot-apply.ts), [`checkSnapshotPull` and `recoverInfraFailedSessions`](../../src/core/session-health-monitor.ts), and [`recoverDisconnectedSessions`](../../src/providers/daemon-connection.ts). Regressions: [`session-snapshot-pull-reexam.test.ts`](../../tests/core/session-snapshot-pull-reexam.test.ts), [`session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), and [`session-health-monitor-autorecover-arming.test.ts`](../../tests/core/session-health-monitor-autorecover-arming.test.ts).

### A confirmed spawn must release its reservation

A seeded session starts with `awaiting_spawn`, which excludes it from snapshot intake. Persisting the real PID without clearing that reason leaves an executing first turn outside both push and pull projection. Release the reservation in the same locked upsert that records the confirmed PID, including an idempotent retry with an already-stored PID. An init-only spawn remains Idle; pending permission stays visible. Do not release archived, stopped, failed, or stop-requested reservations, and do not overwrite a newer reason from another lifecycle event.

Code: [`createSessionRecord`](../../src/core/session-tracker.ts). Regressions: reservation cases in [`session-tracker.test.ts`](../../tests/core/session-tracker.test.ts), the first-turn pull case in [`session-snapshot-pull-reexam.test.ts`](../../tests/core/session-snapshot-pull-reexam.test.ts), and the reservation browser flow in [`session-hold-turn-subagents.spec.ts`](../../tests/e2e/browser/session-hold-turn-subagents.spec.ts). Seed the actual reservation before providing the PID; a test starting with an ordinary Running record cannot exercise this failure.

### Snapshot-only turn completion must hand back the task

A recovered snapshot changed a running session to Idle after the normal result notification was lost, but only Stopped/Error projections invoked task handback. The session was correct while its task remained In Progress. Checking the regular result path did not test recovery. A repeated equal-version Idle snapshot also needs to repair that mismatch without waiting for another process-status edge.

Require a clean result, trailing Idle, no active turn, no gating or detached work, no team, and no armed wakeup. Reuse the sibling-session handback guard. Recheck the session revision, epoch, runner identity, turn generation, and task phase/change-time identity inside the task write lock. Record phase changes separately from note updates; otherwise a delayed summary hides a missing handback. Hold the queue file lock across an asynchronous fresh read and the task decision so another process's pending input cannot be hidden by the server's queue cache. A phase chosen after the existing Idle transition must not be overwritten by repeated old snapshots; legacy records without a phase timestamp use the conservative task-update time, and missing evidence or explicit TODO/COMPLETE choices remain unchanged.

Code: [`applySnapshot`](../../src/core/session-snapshot-apply.ts). Regression: the snapshot-only completion and duplicate-idle cases in [`session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), with the normal result notification absent, plus task-edit and new-turn races.

### Terminal session age must not erase pending task handback

A task can remain In Progress after its session stopped, including when an older sync writer erased a successful handback. The active health scan expires terminal records after 24 hours, while duplicate terminal snapshots used to return before checking the task. Fixing the writer alone does not repair those records.

Query terminal sessions through the task index for In Progress tasks separately from the active scan. Keep live pulls first, isolate task-query failures, and share the bounded, rotating re-examination budget. Historical checks require `snapshot-memory-v1` and `getState { memoryOnly: true }`: an absent in-memory fold means unavailable evidence, not a reason to synchronously rebuild a large transcript on every tick. Older daemons skip this optional lane without a forced redeploy.

A repeated terminal snapshot may repair a missed handback only with result evidence, no active work, unchanged session and task identities, and no queued input or pending recovery. The cutoff is the earliest continuously settled status after the last Running edge, not the later process-reaping time. Later human phase choices stay intact. Legacy timestamps cannot establish who changed a phase; use retained history and an explicit, conditional single-row repair for proven historical damage rather than weakening the automatic guard.

Code: [`listSessionsForTaskHandback`](../../src/core/session-tracker.ts), [`checkSnapshotPull`](../../src/core/session-health-monitor.ts), and [`settledPhaseCutoff` / `applySnapshot`](../../src/core/session-snapshot-apply.ts). Regressions: [`health-scan-active-set.test.ts`](../../tests/core/health-scan-active-set.test.ts), [`session-snapshot-pull-reexam.test.ts`](../../tests/core/session-snapshot-pull-reexam.test.ts), [`session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), [`detached-bg-phase.test.ts`](../../tests/e2e/detached-bg-phase.test.ts), and the memory-only command tests in [`daemon-standalone-vs-source-parity.test.ts`](../../tests/providers/daemon-standalone-vs-source-parity.test.ts).

### FIFO markers must precede consumption, not merely acknowledgment

Appending the user marker after a successful send lets a fast CLI answer before the turn-start marker exists. Appending first and truncating on failure is also unsafe: concurrent CLI output may already follow the marker, so truncation would delete real history.

For `send-markers-v1`, serialize each session's writes and hold the final newline: write the payload body, append ordered markers to the daemon-owned stream, then release the newline so the CLI can consume the line. Use the same descriptor and deadline. A zero-byte failure creates no marker; a partial write or marker failure is not a successful delivery. Never alter the canonical CLI transcript.

Code: [`handleSendCommand`, `chainFifoWrite`, `appendUserMarkerLine`](../../src/providers/daemon-core.ts). Regression: [`tests/providers/daemon-cmd-send-strict-ack.test.ts`](../../tests/providers/daemon-cmd-send-strict-ack.test.ts).

### Same stream offset does not mean same status

`v` orders complete lines within one stream file. Permission, process death, and time-driven wakeup expiry can change status without adding a line. `streamEpoch` identifies the file, `statusRevision` orders accepted status, and runner identity plus `turnGen` identify the live turn. These are not interchangeable clocks.

Check the relevant identity and revision again inside the task write lock, after asynchronous work. Otherwise a delayed Running write can overwrite a newer Waiting or Idle state at the same `v`. Do not advance the durable turn-end `consumedOffset` to a mid-turn snapshot. Expiring a wakeup may settle a live session; old wakeup metadata must not resurrect a terminal one. Terminal handback must recheck source and sibling activity and pending recovery under the lock.

Permission participates in snapshot equality even when `process_status` is unchanged. An explicit `null` clears Waiting; an omitted field in a partial event does not. A full legacy task snapshot without permission does clear the old value.

Code: [`applySnapshot`](../../src/core/session-snapshot-apply.ts), [`applySessionPhase` and `handBackTaskOnSessionEnd`](../../src/core/phase.ts), [`SessionStatusStore`](../../web/src/stores/session-status-store.ts). Regressions: [`tests/core/session-snapshot-apply.test.ts`](../../tests/core/session-snapshot-apply.test.ts), [`tests/web/session-status-store.test.ts`](../../tests/web/session-status-store.test.ts).

### Walnut's own retry of a turn is one record, read in one place

A turn that Walnut continues by itself is not the end of the work: its askers and its lead are not told, its error card waits, and its task keeps its phase. Six kinds of retry do that: the endpoint wait, the usage-limit wait, restart and start recovery, the auto-continue retry, the safeguard model switch, and the context-full recovery. Between 2026-11-03 and 11-11 each one added its own branch to the turn-end hook and its own reads in the phase, the health monitor, the user status, the runner and the result handler. They disagreed: the context recovery held the card and the phase but not the notices, the runner cleared the task's session for a switch the result handler kept, and the health monitor counted a restart as work in flight but not an endpoint wait. A seventh kind meant finding all of them.

The rule since 2026-11-14: a session's current turn is one record, [`turn-run.ts`](../../src/core/sessions/turn-run.ts). Each retry kind is a `TurnRetryReason` with a row in the module that owns its state (`turnRetrier`: what end it takes, whether it holds the record, what it stopped on), and two traits every reader obeys the same way: whether the task keeps its phase while Walnut retries, and whether the session is mid-work (a switch or a move waits). Readers ask the turn (`turnEndTakenBy` at the end event, `turnWaitOf` on the record, `holdTurnEndNotices` for the hook), never a retrier. A row's wait is read from that retrier's own durable state on every read, so there is no second copy to drift; the record keeps the attempts (`SessionRecord.turn`), written when a retrier sends its continue and cleared by any other send. A hand-back the phase holds is kept with the session's status at that moment, and goes ahead when the retrier lets go with no new turn taking over (a person stopped the session during a wait, the wait closed on another error, an opening wait was never written): the retrier says so (`turnRetryEnded`), and a recheck on a clock covers one that does not. A retrier's own hand-back when it gives up passes `retryOver`, so the retry it ends does not hold it. Modelled on T3 Code's orchestration v2 runs and attempts, without its restart behavior: the daemon keeps owning the CLIs, and nothing cancels a live process's work.

A new retry kind is a new reason and a row. The reason's traits, its loader and its status words are total over the reason type, so the type check refuses a reason without them. Regression: [`tests/core/sessions/turn-run.test.ts`](../../tests/core/sessions/turn-run.test.ts) fails when a reader asks a retrier directly, when a module that hears a turn end and sends into the session has no reason, or when a row sends without noting its attempt; [`tests/core/sessions/turn-run-handback.test.ts`](../../tests/core/sessions/turn-run-handback.test.ts) lets held hand-backs go; [`tests/core/session-request-notify.test.ts`](../../tests/core/session-request-notify.test.ts) holds the lead's notice for every reason.

### An answer owes its delivery in the settle's own write

A reply to a request (`task_send` with `in_reply_to`) is three writes in three stores: the request settles (`session-requests.json`), the replier's result is noted on its task (`tasks.sqlite`), and the answer goes into the asker's queue (`session-message-queue.json`). A server that died after the settle and before the queue write left the request "replied" with the answer never delivered: the deadline sweep skips a settled request, so the asker was never told, and only the replier sending again could recover it.

The rule since 2026-11-14: the settle writes the delivery it owes into the same row (`SessionRequest.outbox`: the asker, the queue row id, the exact words, and the result to note), and performReply clears it once the delivery returns, delivered or failed in front of the replier. [`reply-outbox.ts`](../../src/core/sessions/reply-outbox.ts) runs at start and with the request sweep every minute, and skips a request a reply on this server is still answering: an outbox whose row is in any queue, or left one as a written line, is cleared; otherwise the result is noted when the task holds none newer, the same row id is queued again where the asker reads now, and the outbox is cleared. A replier that sends its answer again after the death sends it as the owed row, which clears the outbox. The queue stays the commit point of a delivery (its own atomic write, deduped by row id while queued), so the outbox only remembers that an answer is owed. Modelled on T3 Code's effect outbox. One window remains: a death after the queue write and before the clear, for a row that then left the queue with no written line on record (deleted by the person, or held by an engine switch), can deliver that answer twice. Regression: [`tests/core/sessions/reply-outbox.test.ts`](../../tests/core/sessions/reply-outbox.test.ts) replays the disk as it was when the delivery began.

## When investigating a recurrence

1. Compare the affected task's persisted phase, API phase, and rendered row before changing anything. Check unread and process state separately. A missing red row is not proof of another database rewrite.
2. Match historical transitions by task ID and time. Restore only proven damage with backup and per-row compare-and-swap; preserve later edits, content, ordering, dates, and read markers. A repair must advance the sync timestamp if peers reject equal-timestamp changes. Exporting a projection does not prove a replica imported it, and a direct database write does not broadcast a browser event.
3. Inspect the actual running entry and its source map, not every map left in a `clean:false` build. Old chunks can otherwise overwrite newer evidence during a source-map scan. Check schema compatibility separately from whether a commit builds.
4. Exercise the built SPA in WebKit and Chromium with realistic task density across Focus, Satellite, Wait, and Backlog. Include read-marker requests held open, late session hints, first-connect delay, reconnect, detached work across turns, permission allow/deny, questions, and plan approval. Check both the API state and visible controls.
5. Report the exact tested artifact and remaining failures. A partial independent commit is not the fully tested working tree, and neither alone proves the running build matches.

For the distinction between turn-end and actual process death, see [No session-end gist](no-session-end-gist.md).
