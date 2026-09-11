/**
 * Project tombstone / redirect ledger (task_project_tombstones) — the
 * framework-level guarantee that a project the human removed STAYS removed.
 *
 * Why this exists (2026-09-08 investigation): a project was deleted at 21:15 and
 * a provider full reconcile re-created it at 21:21 from the still-alive remote
 * list of the same NAME, then imported an item into it. Deleting a project only
 * dropped the registry row, so every writer that creates a project BY NAME
 * resurrected it: a provider pull (remote list → project), quick-start with a
 * client-supplied project, task_create with a project string, the cloud outbox,
 * an AI project suggestion. The task ledger (task_remote_links) already solved
 * the same class of bug for task identity; this is its project-level twin.
 *
 * States are implicit in the row's shape:
 *   - redirect_to = NULL — the project is GONE. A writer naming it files into
 *     Inbox instead, with a warning naming the writer.
 *   - redirect_to = '<name>' — the project was renamed or merged away. A writer
 *     naming it is FOLLOWED FORWARD to the survivor.
 *
 * A LIVE registry row always wins over a tombstone: the ledger is consulted only
 * at the moment a writer would MINT a new row. Explicit human creation
 * (POST /projects, the console's new-project gesture) clears the tombstone — that
 * is the only way back, and it is deliberately a human-only door.
 *
 * All writers are the FRAMEWORK (task-manager mutation paths), never plugin
 * hooks — a plugin that forgets a rule must not be able to break the invariant.
 */

import { getDb as getDbOrThrow } from './task-db.js';
import { log } from '../logging/index.js';

/** getDb() rethrows a failed open forever; the ledger must degrade to a no-op
 *  instead (unit-test envs without the native binding, read-only replicas). A
 *  miss reverts to pre-ledger behavior — never to a broken write path. */
function getDb(): ReturnType<typeof getDbOrThrow> {
  try {
    return getDbOrThrow();
  } catch {
    return null;
  }
}

export interface ProjectTombstone {
  /** Canonical spelling the project had when it was removed. */
  name: string;
  /** Claim the project carried ('local' or a plugin id). */
  source: string;
  /** Provider container ids that backed it (ms-todo list ids, …). */
  remote_list_ids: string[];
  /** Survivor project for a rename/merge; null for a plain delete. */
  redirect_to: string | null;
  reason: string | null;
  deleted_at: string;
}

function rowToTombstone(row: Record<string, unknown>): ProjectTombstone {
  let ids: string[] = [];
  const raw = row.remote_list_ids as string | null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // A corrupt blob must not break the lookup — the NAME half still protects.
      log.task.warn('project-tombstones: remote_list_ids JSON parse failed', { name: row.name });
    }
  }
  return {
    name: row.name as string,
    source: (row.source as string | null) ?? 'local',
    remote_list_ids: ids,
    redirect_to: (row.redirect_to as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    deleted_at: row.deleted_at as string,
  };
}

/** All tombstones, newest first. Small by construction (one row per removal). */
export function listProjectTombstones(): ProjectTombstone[] {
  const db = getDb();
  if (!db) return [];
  const rows = db
    .prepare('SELECT * FROM task_project_tombstones ORDER BY deleted_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToTombstone);
}

/**
 * Tombstone for one project name.
 *
 * Matching is done in JS with toLowerCase(), NOT by leaning on the column's
 * COLLATE NOCASE — SQLite's NOCASE folds ASCII A-Z only while JS folds Unicode,
 * and project identity everywhere else in Walnut is the JS rule (see
 * ensureProjectRowLocked). "Ärger" and "ärger" are ONE project, so they must be
 * ONE tombstone too.
 */
export function getProjectTombstone(name: string): ProjectTombstone | undefined {
  const wanted = (name ?? '').trim().toLowerCase();
  if (!wanted) return undefined;
  return listProjectTombstones().find((t) => t.name.trim().toLowerCase() === wanted);
}

/**
 * Tombstone that owns a provider container id.
 *
 * The name half of the ledger misses one real case: the remote list is RENAMED
 * after the project was removed, so the next pull sees a name no tombstone knows
 * while the container is the very one that was retired. The id is stable across
 * remote renames, which is exactly why it is recorded.
 *
 * A 'local'-claimed tombstone also answers here: a locally-claimed project whose
 * tasks were once synced still carries that provider's container ids, and that
 * exact shape (local project + surviving remote list) is the 2026-09-08 bug.
 */
export function findProjectTombstoneByRemoteListId(
  source: string,
  remoteListId: string,
): ProjectTombstone | undefined {
  const id = (remoteListId ?? '').trim();
  if (!id) return undefined;
  return listProjectTombstones().find(
    (t) => (t.source === source || t.source === 'local') && t.remote_list_ids.includes(id),
  );
}

/**
 * Record (or refresh) a tombstone. Last write wins, EXCEPT that recorded
 * container ids accumulate: a second delete of the same name must not forget the
 * list id an earlier one learned, or a pull could resurrect through the gap.
 */
export function recordProjectTombstone(args: {
  name: string;
  source?: string;
  remoteListIds?: string[];
  /** Survivor project name (rename/merge). Omit for a plain delete. */
  redirectTo?: string | null;
  reason?: string;
}): boolean {
  const name = (args.name ?? '').trim();
  if (!name) return false;
  const db = getDb();
  // A LOST TOMBSTONE IS HOW THE PROJECT GROWS BACK: report the miss so the
  // caller can log it loudly instead of degrading in silence.
  if (!db) return false;

  const existing = getProjectTombstone(name);
  const ids = new Set<string>([
    ...(existing?.remote_list_ids ?? []),
    ...(args.remoteListIds ?? []).map((v) => (v ?? '').trim()).filter(Boolean),
  ]);
  // A row is keyed by the canonical spelling of the removal that wrote it; keep
  // the newest spelling but delete any case-variant row first, so a Unicode-case
  // difference cannot leave two tombstones for one project.
  if (existing && existing.name !== name) clearProjectTombstone(existing.name);

  const redirectTo = (args.redirectTo ?? '').trim();
  db.prepare(
    `INSERT INTO task_project_tombstones
       (name, source, remote_list_ids, redirect_to, reason, deleted_at)
     VALUES (@name, @source, @remote_list_ids, @redirect_to, @reason, @deleted_at)
     ON CONFLICT(name) DO UPDATE SET
       source = @source, remote_list_ids = @remote_list_ids,
       redirect_to = @redirect_to, reason = @reason, deleted_at = @deleted_at`,
  ).run({
    name,
    source: args.source ?? 'local',
    remote_list_ids: ids.size > 0 ? JSON.stringify([...ids]) : null,
    // A self-redirect would be a permanent no-op loop — drop it.
    redirect_to: redirectTo && redirectTo.toLowerCase() !== name.toLowerCase() ? redirectTo : null,
    reason: args.reason ?? null,
    deleted_at: new Date().toISOString(),
  });
  log.task.info('project tombstoned', {
    project: name,
    source: args.source ?? 'local',
    redirectTo: redirectTo || undefined,
    remoteListIds: ids.size,
    reason: args.reason,
  });
  return true;
}

/**
 * Attach provider container ids to an EXISTING tombstone without touching
 * anything else about it.
 *
 * For the pull side: when a remote list resolves to a tombstoned name, the list
 * id is worth remembering (a later remote rename would otherwise slip past the
 * name half), but the pull must not rewrite the row's redirect, reason, claim or
 * timestamp — those describe what the human did, and a background sync is not
 * the human. recordProjectTombstone is last-write-wins on those fields, so it is
 * the wrong tool here. No tombstone → nothing to attach to → false.
 */
export function learnProjectTombstoneRemoteIds(name: string, remoteListIds: string[]): boolean {
  const ids = remoteListIds.map((v) => (v ?? '').trim()).filter(Boolean);
  if (ids.length === 0) return false;
  const db = getDb();
  if (!db) return false;
  const existing = getProjectTombstone(name);
  if (!existing) return false;
  const merged = new Set<string>([...existing.remote_list_ids, ...ids]);
  if (merged.size === existing.remote_list_ids.length) return false;
  db.prepare('UPDATE task_project_tombstones SET remote_list_ids = ? WHERE name = ?')
    .run(JSON.stringify([...merged]), existing.name);
  log.task.info('project tombstone learned a remote container id', {
    project: existing.name, remoteListIds: merged.size,
  });
  return true;
}

/**
 * Forget a tombstone — the ONE door back. Called only from an explicit human
 * create (POST /projects, the console's new-project gesture) and from a rename
 * that lands ON a tombstoned name (also a human gesture).
 */
export function clearProjectTombstone(name: string): boolean {
  const wanted = (name ?? '').trim();
  if (!wanted) return false;
  const db = getDb();
  if (!db) return false;
  const existing = getProjectTombstone(wanted);
  if (!existing) return false;
  db.prepare('DELETE FROM task_project_tombstones WHERE name = ?').run(existing.name);
  log.task.info('project tombstone cleared (explicit create)', {
    project: existing.name, redirectTo: existing.redirect_to ?? undefined,
  });
  return true;
}

/** What a writer naming a project is allowed to do. */
export type ProjectWriteResolution =
  /** Mint/use this name (no tombstone, or a live row already exists). */
  | { kind: 'ok'; name: string }
  /** The name was renamed/merged away — use `name` (the survivor) instead. */
  | { kind: 'redirect'; name: string; from: string }
  /** The project is gone and has no survivor — the writer gets Inbox. */
  | { kind: 'blocked'; from: string };

/** How many redirect hops to follow before giving up (cycle/depth guard). */
const MAX_REDIRECT_HOPS = 16;

/**
 * THE choke point's brain: decide what a writer naming `name` may create.
 *
 * `findLiveRow` answers "is there a registry row for this name, and what is its
 * canonical spelling?" — passed in rather than read here so this stays a pure
 * function usable from inside an open write transaction (every registry-minting
 * site holds the store write lock and has the snapshot in hand).
 *
 * Rules, in order:
 *   1. A LIVE row wins outright. A tombstone is inert the moment the project
 *      exists again (that is what makes the human re-create door work, and what
 *      keeps an old tombstone from breaking an unrelated project years later).
 *   2. No tombstone → the writer may mint the name.
 *   3. Tombstone with a redirect → follow it, hop by hop, stopping at the first
 *      live row. A chain that dead-ends on a redirect-less tombstone is BLOCKED
 *      (the survivor was itself deleted); a cycle terminates at the hop cap.
 *   4. Tombstone without a redirect → BLOCKED.
 */
export function resolveProjectWrite(
  name: string,
  findLiveRow: (name: string) => string | undefined,
  findTombstone: (name: string) => ProjectTombstone | undefined = getProjectTombstone,
): ProjectWriteResolution {
  const requested = (name ?? '').trim();
  // Inbox is the legal ABSENCE of a project — never a row, never a tombstone.
  if (!requested) return { kind: 'ok', name: '' };

  const live = findLiveRow(requested);
  if (live) return { kind: 'ok', name: live };

  const first = findTombstone(requested);
  if (!first) return { kind: 'ok', name: requested };

  let hop = first;
  const seen = new Set<string>([requested.toLowerCase()]);
  for (let i = 0; i < MAX_REDIRECT_HOPS; i++) {
    const target = (hop.redirect_to ?? '').trim();
    if (!target) return { kind: 'blocked', from: requested };
    const targetLive = findLiveRow(target);
    if (targetLive) return { kind: 'redirect', name: targetLive, from: requested };
    const lower = target.toLowerCase();
    if (seen.has(lower)) {
      // Redirect cycle (A→B→A). Neither name has a live row, so there is nothing
      // to follow to — treat it as gone rather than looping.
      log.task.warn('project-tombstones: redirect cycle — treating as removed', {
        project: requested, at: target,
      });
      return { kind: 'blocked', from: requested };
    }
    seen.add(lower);
    const next = findTombstone(target);
    if (!next) {
      // The survivor has no row AND no tombstone: it is a free name, so the
      // writer may mint it (this is a rename whose target was never used).
      return { kind: 'redirect', name: target, from: requested };
    }
    hop = next;
  }
  log.task.warn('project-tombstones: redirect chain too long — treating as removed', {
    project: requested, hops: MAX_REDIRECT_HOPS,
  });
  return { kind: 'blocked', from: requested };
}
