/**
 * Remote-identity ledger (task_remote_links) — the framework-level guarantee
 * that ONE remote item maps to at most ONE local task, forever.
 *
 * Why this exists (2026-08-20 investigation): sync could fork a task into
 * copies. A source migration cleared `ext` without recording the released
 * remote id, so the next pull re-imported the still-alive remote item as a
 * brand-new local task; the ms-todo tombstone list (`deletedMsIds`) was capped
 * at 500 and silently evicted old entries. 141 tasks were re-created under new
 * local ids and 35 of them lost their session links when cleanups deleted the
 * "duplicate" that held them.
 *
 * States:
 *   - 'owned'    — a local task currently holds this remote id in its ext.
 *   - 'released' — a local task once held it and gave it up (source migration
 *                  cleared ext). Pull must NOT create a new task for it; if the
 *                  recorded task still exists, pull may re-point it instead.
 *   - 'deleted'  — the local task was deleted; the remote twin must go too.
 *                  `remote_delete_confirmed` flips to 1 once the provider
 *                  confirms (success or 404); the sync tick retries until then.
 *
 * All writers are the FRAMEWORK (task-manager mutation paths), never plugin
 * hooks — a plugin that forgets a hook must not be able to break the invariant.
 */

import { getDb as getDbOrThrow } from './task-db.js';
import { log } from '../logging/index.js';

/** getDb() rethrows a failed open forever; the ledger must degrade to a no-op
 *  instead (unit-test envs without the native binding, read-only replicas). A
 *  miss here reverts to pre-ledger behavior — never to a broken pull. */
function getDb(): ReturnType<typeof getDbOrThrow> {
  try {
    return getDbOrThrow();
  } catch {
    return null;
  }
}

export type RemoteLinkState = 'owned' | 'released' | 'deleted';

export interface RemoteLink {
  remote_source: string;
  remote_id: string;
  task_id: string | null;
  remote_list: string | null;
  state: RemoteLinkState;
  reason: string | null;
  remote_delete_confirmed: boolean;
  updated_at: string;
}

function rowToLink(row: Record<string, unknown>): RemoteLink {
  return {
    remote_source: row.remote_source as string,
    remote_id: row.remote_id as string,
    task_id: (row.task_id as string | null) ?? null,
    remote_list: (row.remote_list as string | null) ?? null,
    state: row.state as RemoteLinkState,
    reason: (row.reason as string | null) ?? null,
    remote_delete_confirmed: row.remote_delete_confirmed === 1,
    updated_at: row.updated_at as string,
  };
}

/**
 * Record a state for (source, remoteId). Last write wins — the mutation paths
 * call this at the moment the ownership fact changes, always inside or right
 * after the task write lock, so ordering follows task-store ordering.
 */
export function recordRemoteLink(args: {
  source: string;
  remoteId: string;
  taskId?: string | null;
  remoteList?: string | null;
  state: RemoteLinkState;
  reason?: string;
  /** Only meaningful for state='deleted'. Defaults to false (unconfirmed). */
  remoteDeleteConfirmed?: boolean;
}): boolean {
  const db = getDb();
  // A LOST CLAIM WRITE IS HOW THE FORK HAPPENS: if the ownership fact never
  // reaches the ledger, the next pull sees an unclaimed remote id and mints a
  // duplicate task. Returning false lets the framework call sites log that
  // loudly instead of degrading in silence.
  if (!db) return false;
  db.prepare(
    `INSERT INTO task_remote_links
       (remote_source, remote_id, task_id, remote_list, state, reason, remote_delete_confirmed, updated_at)
     VALUES (@remote_source, @remote_id, @task_id, @remote_list, @state, @reason, @confirmed, @updated_at)
     ON CONFLICT(remote_source, remote_id) DO UPDATE SET
       task_id = @task_id, remote_list = @remote_list, state = @state,
       reason = @reason, remote_delete_confirmed = @confirmed, updated_at = @updated_at`,
  ).run({
    remote_source: args.source,
    remote_id: args.remoteId,
    task_id: args.taskId ?? null,
    remote_list: args.remoteList ?? null,
    state: args.state,
    reason: args.reason ?? null,
    confirmed: args.remoteDeleteConfirmed ? 1 : 0,
    updated_at: new Date().toISOString(),
  });
  return true;
}

/** Look up the ledger row for one remote id. */
export function getRemoteLink(source: string, remoteId: string): RemoteLink | undefined {
  const db = getDb();
  if (!db) return undefined;
  const row = db.prepare(
    'SELECT * FROM task_remote_links WHERE remote_source = ? AND remote_id = ?',
  ).get(source, remoteId) as Record<string, unknown> | undefined;
  return row ? rowToLink(row) : undefined;
}

/**
 * The single question every pull-side create path must ask: has any local task
 * ever owned this remote id and released or deleted it? If yes, creating a new
 * local task for it forks identity — refuse.
 */
export function isRemoteIdBlocked(source: string, remoteId: string): boolean {
  const link = getRemoteLink(source, remoteId);
  return !!link && (link.state === 'released' || link.state === 'deleted');
}

/**
 * Is this remote id CURRENTLY owned by a live local task?
 *
 * The hole isRemoteIdBlocked left open (2026-09-01 regression): it refuses a
 * released or deleted id, but says nothing about an id a living task holds right
 * now — so a pull that raced the owner's own ext write happily inserted a SECOND
 * task for it. Three tasks forked this way in one sync tick.
 *
 * `excludeTaskId` lets a caller ask "does anyone OTHER than me hold this?",
 * which is what deleteTask needs before it tombstones or remote-deletes an id.
 *
 * Checks the ledger row AND that its task still exists: a stale 'owned' row
 * pointing at a deleted task must not block a legitimate re-import forever.
 */
export function isRemoteIdClaimedByLiveTask(
  source: string,
  remoteId: string,
  excludeTaskId?: string,
): { claimed: boolean; byTaskId?: string } {
  const db = getDb();
  if (!db) return { claimed: false };
  const row = db.prepare(
    `SELECT l.task_id AS task_id
       FROM task_remote_links l
       JOIN tasks t ON t.id = l.task_id
      WHERE l.remote_source = ? AND l.remote_id = ? AND l.state = 'owned'
        AND (? IS NULL OR l.task_id != ?)
      LIMIT 1`,
  ).get(source, remoteId, excludeTaskId ?? null, excludeTaskId ?? null) as
    { task_id: string } | undefined;
  return row ? { claimed: true, byTaskId: row.task_id } : { claimed: false };
}

/**
 * Every OTHER live task that holds any of `remoteIds` for `source`. The question
 * deleteTask must ask before writing a 'deleted' tombstone: the ledger PK is
 * (remote_source, remote_id), so tombstoning an id a sibling row still owns
 * overwrites that sibling's 'owned' row and makes every future pull treat the
 * survivor as deleted — and the remote delete would then destroy the survivor's
 * real remote twin.
 */
export function findLiveClaimants(
  source: string,
  remoteIds: string[],
  excludeTaskId: string,
): Array<{ remoteId: string; taskId: string }> {
  const out: Array<{ remoteId: string; taskId: string }> = [];
  for (const remoteId of remoteIds) {
    const hit = isRemoteIdClaimedByLiveTask(source, remoteId, excludeTaskId);
    if (hit.claimed && hit.byTaskId) out.push({ remoteId, taskId: hit.byTaskId });
  }
  return out;
}

/** Deleted-but-unconfirmed rows for one provider — the sync tick's retry list. */
export function listUnconfirmedRemoteDeletes(source: string, limit = 10): RemoteLink[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.prepare(
    `SELECT * FROM task_remote_links
      WHERE remote_source = ? AND state = 'deleted' AND remote_delete_confirmed = 0
      ORDER BY updated_at ASC LIMIT ?`,
  ).all(source, limit) as Record<string, unknown>[];
  return rows.map(rowToLink);
}

/** Mark a pending remote delete as confirmed (provider returned success/404). */
export function confirmRemoteDelete(source: string, remoteId: string): void {
  const db = getDb();
  if (!db) return;
  db.prepare(
    `UPDATE task_remote_links SET remote_delete_confirmed = 1, updated_at = ?
      WHERE remote_source = ? AND remote_id = ? AND state = 'deleted'`,
  ).run(new Date().toISOString(), source, remoteId);
}

/**
 * One-time import of the legacy ms-todo tombstone array (deletedMsIds from
 * ms-todo-delta.json). Idempotent: INSERT OR IGNORE keeps any richer row the
 * ledger already has. Marked confirmed — these ids were deleted long ago and
 * their remote twins are gone; retrying them would spam the provider.
 */
export function importLegacyTombstones(source: string, remoteIds: string[]): number {
  const db = getDb();
  if (!db || remoteIds.length === 0) return 0;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO task_remote_links
       (remote_source, remote_id, task_id, remote_list, state, reason, remote_delete_confirmed, updated_at)
     VALUES (?, ?, NULL, NULL, 'deleted', 'legacy-deletedMsIds', 1, ?)`,
  );
  let imported = 0;
  const run = db.transaction(() => {
    for (const id of remoteIds) {
      if (!id) continue;
      imported += stmt.run(source, id, now).changes;
    }
  });
  run();
  if (imported > 0) {
    log.task.info('task-remote-links: imported legacy tombstones', { source, imported });
  }
  return imported;
}
