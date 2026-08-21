# Duplicate task rows for one remote item

One remote item can end up owning two or more Walnut task rows. When one of the twins is later deleted, every session attached to it is stranded: `sessions.task_id` still names the dead row, and the session becomes invisible on every task surface. Measured on one install on 2026-08-20: **69 remote ids owning 141 task rows**, and **254 orphaned sessions**, one of which held 1032 messages.

This is the upstream cause. The downstream symptom (a session pointing at a deleted task) has its own fix, `unlinkSessionsFromTasks()` in `src/core/session-tracker.ts`, and a one-shot data repair, `scripts/repair-orphan-session-links.mjs`. Neither stops new duplicates from appearing.

## Mechanism

`src/core/sync-reconciler.ts:134` builds the local side of the three-way diff from a source-filtered list:

```ts
const localTasks = ctx.getTasks().filter(t => t.source === plugin.id);
const diff = this.computeDiff(localTasks, remoteItems, plugin);
```

`computeDiff` then builds its join map from that filtered list only (`localByRemoteId`, line 217). So the join key is effectively `(source, remoteId)`, not `remoteId`. Two consequences follow from the same filter:

1. **Create path** (line 259-261): a task whose `source` no longer equals `plugin.id` is absent from `localByRemoteId`, so its remote item looks new and `toCreate.push(remote)` inserts a **second row with a fresh local id**.
2. **Remove path** (line 265-269): the original row, once it does match the filter again, is the one whose remote id is "not in remote" and it becomes a removal candidate.

The remote item never changed. Verified directly: for 21 of the repaired pairs the dead row's and the surviving row's `ext` remote id are byte-for-byte identical.

`addTasksBulk` performs no remote-id existence check, and `sync-reconciler.ts:287` documents that the bulk path deliberately skips the create-time validation chain. There is no dedup anywhere on that path.

## Evidence

Task ids are `base36(Date.now())-<4 hex>` (`generateId` in `src/utils/format.ts`), so the timestamp prefix dates each row. Rows sharing a prefix were inserted in the same millisecond, which only a bulk insert does. Grouping prefixes with 5 or more rows:

| Day | Task rows bulk-created |
|---|---|
| 2026-05-31 | 112 |
| 2026-06-17 | 11 |
| 2026-07-03 | 5 |
| 2026-07-19 | 161 |
| 2026-08-08 | 30 |
| 2026-08-18 | 46 |
| 2026-08-19 | 21 |

Content confirms these are re-imports rather than new work: the 2026-07-19 batch created tasks whose titles match March and April originals verbatim, in three bursts minutes apart (20:11, 20:21, 20:30). Rows from the two most recent batches carry empty `created_at` and empty `_synced_at`, consistent with the bulk path that bypasses the create-time chain.

Twelve of the repaired pairs did have differing remote ids, and they are a separate, smaller effect: six are the same daily report written six times on 2026-08-04 (six dead ids collapsing onto one live id), and two changed sync provider entirely, so a different plugin re-imported the same work under its own id space.

## Not established

The specific script or commit behind the 2026-07-19 burst is unknown: `/tmp/open-walnut/open-walnut-2026-07-19.log` no longer exists. The mechanism above is confirmed from code and from the data, but that one day's trigger is not attributed. Snapshot filenames in `~/.open-walnut/tasks/` (`tasks.pre-cleanup.sqlite` at 07-19 12:04, then `pre-v5`, `pre-source-repair`, `pre-repair-0805`, `pre-cleanup-0806` all on 08-05) show that repair and migration passes rewrote the table wholesale around those dates, which is a plausible second entry point into the same create path.

## Suggested fix

Join on the remote id across **all** tasks, not the source-filtered subset. Concretely, in `computeDiff`:

- Build `localByRemoteId` from every task carrying a remote id for this plugin's provider key, regardless of `source`.
- Keep the source filter for the **removal** decision only, so a task claimed by another provider is never deleted by this plugin.
- Treat a remote-id hit on a row whose `source` differs as an update-plus-source-correction, not a create.

An insert-time guard in `addTasksBulk` (refuse a row whose remote id already exists) would make the invariant enforceable rather than merely intended, and is worth pairing with the diff change.

Both edits sit in files that other work touches frequently (`sync-reconciler.ts`, `task-manager.ts`), and changing them alters live sync behavior, so they need their own verification against real provider pulls rather than riding along with a data repair.

## Detection

`src/core/session-integrity.ts` counts both corruptions at startup and logs a warning naming each count with a sample. It never repairs: deduping requires deciding which twin is canonical and merging `note`/`summary`/sessions, which is not a boot-time decision. `scripts/repair-orphan-session-links.mjs --verify` prints the same two counts on demand.

The repair script also refuses to point a session at a task row that is itself part of a duplicate group, since that target may be cleaned up later and would re-orphan the session. That count was 0 at repair time and the guard keeps it 0.
