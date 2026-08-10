/**
 * Task outbox — two-way task sync between the cloud companion (REPLICA) and
 * the primary box, riding the existing 30s git-sync. No new network channel.
 *
 * Problem: on the cloud box the butler's task tools write to the LOCAL
 * tasks.sqlite, which is gitignored — tasks created from the phone were
 * stranded on EC2 forever (and invisible to the iOS list, which reads the
 * Mac-exported tasks/projection.json).
 *
 * Cloud box (writer):  every task mutation ALSO drops one op file into
 *   tasks/outbox/<opId>.json. Plain JSON files in tasks/ are committed by the
 *   git auto-commit loop and reach the primary via the hub.
 * Primary box (applier): after each git pull, applyOutboxOnPrimary() applies
 *   pending ops through the normal task-manager APIs (so plugin push +
 *   projection re-export + bus events all fire), then DELETES the op file.
 *   The deletion syncs back and clears the op on the cloud side too.
 * Cloud box (reader):  importProjectionOnCloud() upserts the Mac-exported
 *   projection into the local sqlite, so the butler can see Mac-created
 *   tasks. Upsert-only — it never deletes local rows. Since Phase 3 the
 *   projection arrives primarily as a bridge push into the projection cache
 *   (events-v1 invokes the import right after the cache write); the git-pull
 *   trigger remains for the legacy transition file.
 *
 * Corruption defenses (each op is a FULL post-write snapshot):
 *   1. One file per op — git never has to merge two writers in one file.
 *   2. Idempotent absolute snapshots — re-applying after a crash is safe.
 *   3. LWW guard — a snapshot older than the local row's updated_at is skipped
 *      (a stale phone op can't clobber a newer Mac edit).
 *   4. Field whitelist on update — cloud rows are built from the slim
 *      projection, so fields the cloud can't know (source, ext, external_url,
 *      session ids, group_id) are NEVER written back onto the primary row.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, TASKS_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';
import type { Task } from './types.js';

export const OUTBOX_DIR = path.join(TASKS_DIR, 'outbox');

export type TaskOp =
  | { opId: string; type: 'create'; at: string; task: Task }
  | { opId: string; type: 'update'; at: string; task: Task }
  | { opId: string; type: 'delete'; at: string; id: string };

/**
 * Fields an 'update' op may write onto an existing primary row.
 *
 * VERSION SKEW: a cloud box running pre-category-removal code keeps emitting ops
 * that carry `category`. Dropping the key from this list is the whole tolerance
 * mechanism — an unknown field is simply never copied into the patch, so an old
 * op degrades to "project + the other fields" instead of failing or resurrecting
 * the retired column. No op-format version number needed.
 */
const UPDATE_WHITELIST: (keyof Task)[] = [
  'title', 'status', 'phase', 'priority', 'project',
  'due_date', 'start_date', 'end_date', 'completed_at', 'starred', 'pinned', 'tags', 'summary',
  'description', 'note', 'sprint', 'needs_attention', 'updated_at',
];

let opSeq = 0;

/**
 * Record a task mutation on the CLOUD box. No-op on the primary.
 * Never throws — the local write already succeeded; a failed outbox drop is
 * logged and the op is lost (surfaced in logs, not silently swallowed as
 * corrupted data).
 */
export async function recordTaskOp(
  op: { type: 'create' | 'update'; task: Task } | { type: 'delete'; id: string },
): Promise<void> {
  if (!CLOUD_MODE) return;
  try {
    const at = new Date().toISOString();
    // Lexicographic sort == chronological sort: zero-padded ms timestamp first.
    const opId = `${Date.now().toString().padStart(15, '0')}-${(opSeq++).toString().padStart(4, '0')}`;
    const file = path.join(OUTBOX_DIR, `${opId}.json`);
    const payload: TaskOp = op.type === 'delete'
      ? { opId, type: 'delete', at, id: op.id }
      : { opId, type: op.type, at, task: op.task };
    await writeJsonFile(file, payload);
    log.task.info('task-outbox: op recorded', { opId, type: op.type });
  } catch (err) {
    log.task.error('task-outbox: FAILED to record op — cloud task change will not reach primary', {
      type: op.type, err: String(err),
    });
  }
}

/** List pending op files sorted oldest-first. */
async function listPendingOps(): Promise<Array<{ file: string; op: TaskOp }>> {
  let names: string[];
  try {
    names = (await fsp.readdir(OUTBOX_DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return []; // no outbox dir yet
  }
  const out: Array<{ file: string; op: TaskOp }> = [];
  for (const name of names) {
    const file = path.join(OUTBOX_DIR, name);
    try {
      const op = JSON.parse(await fsp.readFile(file, 'utf-8')) as TaskOp;
      if (op && op.opId && op.type) out.push({ file, op });
      else await fsp.rm(file, { force: true }); // malformed — drop, don't wedge the queue
    } catch (err) {
      log.task.warn('task-outbox: unreadable op file — removing', { file, err: String(err) });
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
  return out;
}

/**
 * PRIMARY box: apply pending cloud ops through the normal task-manager APIs,
 * then delete each applied file. Called after every git pull. Serial + best
 * effort: one failing op is skipped (kept on disk for the next cycle) without
 * blocking the rest.
 */
export async function applyOutboxOnPrimary(): Promise<number> {
  if (CLOUD_MODE) return 0;
  const pending = await listPendingOps();
  if (pending.length === 0) return 0;

  const tm = await import('./task-manager.js');
  let applied = 0;

  for (const { file, op } of pending) {
    try {
      if (op.type === 'delete') {
        try {
          const { task } = await tm.deleteTask(op.id);
          const { bus, EventNames } = await import('./event-bus.js');
          // Notify UI + projection exporter (deleteTask itself is emit-silent).
          bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'cloud-outbox' });
        } catch (err) {
          const msg = String(err);
          // Already gone (idempotent) or blocked by active sessions (keep the
          // task, drop the op — a phone delete must not kill a running session).
          if (!/No task found/i.test(msg)) {
            log.task.warn('task-outbox: delete op not applied', { id: op.id, err: msg });
          }
        }
      } else {
        const snapshot = op.task;
        const existing = await tm.getTask(snapshot.id).catch(() => undefined);

        if (!existing) {
          // Born on the cloud box. Insert with the SAME id (prevents dup when
          // the projection round-trips), then recompute source on the primary:
          // the cloud has no sync plugins, so it always stamps 'local' — the
          // primary knows whether this project is claimed by a sync plugin.
          //
          // SKEW RULE: an op from an old cloud box may carry `category` with an
          // empty `project`. The task stays in Inbox ('') — the retired category
          // must NEVER be revived as a project name (that would invent projects
          // on the primary and, for a claimed name, hand the task to a provider).
          let snapshotProject = (snapshot.project ?? '').trim();
          let primarySource = 'local';
          if (snapshotProject) {
            try {
              const ensured = await tm.ensureProject(snapshotProject, 'local');
              primarySource = ensured.source;
            } catch (err) {
              if (!(err instanceof tm.InvalidProjectNameError)) throw err;
              // The name came off a remote JSON file we don't control. Rethrowing
              // would keep the op file and retry it EVERY git-pull cycle forever —
              // fall back to Inbox and consume the op instead.
              log.task.warn('task-outbox: invalid project name from cloud op — filing in Inbox', {
                opId: op.opId, project: snapshotProject, err: String(err),
              });
              snapshotProject = '';
            }
          }
          const { id, ...rest } = snapshot;
          const [created] = await tm.addTasksBulk([
            { ...rest, id, project: snapshotProject, source: primarySource },
          ]);
          if (created) {
            const { bus, EventNames } = await import('./event-bus.js');
            bus.emit(EventNames.TASK_CREATED, { task: created }, ['web-ui'], { source: 'cloud-outbox' });
            if (created.source !== 'local') {
              tm.autoPushIfConfigured(created).catch(() => { /* sync_error stamped inside */ });
            }
            log.task.info('task-outbox: cloud task created on primary', {
              id: created.id, title: created.title, source: created.source,
            });
          }
        } else {
          // LWW: never let an older phone snapshot clobber a newer local edit.
          if (Date.parse(snapshot.updated_at) <= Date.parse(existing.updated_at)
              && op.type === 'update') {
            log.task.info('task-outbox: stale update skipped (local row newer)', {
              id: snapshot.id, snapshotAt: snapshot.updated_at, localAt: existing.updated_at,
            });
          } else {
            const patch: Partial<Task> = {};
            for (const key of UPDATE_WHITELIST) {
              if (snapshot[key] !== undefined) (patch as Record<string, unknown>)[key] = snapshot[key];
            }
            // The snapshot is the FULL task, so an absent date means "cleared on
            // the phone/cloud" — write it through as the explicit-clear marker,
            // otherwise a cleared date silently survives on the primary.
            if (snapshot.due_date === undefined) (patch as Record<string, unknown>).due_date = null;
            if (snapshot.start_date === undefined) (patch as Record<string, unknown>).start_date = null;
            if (snapshot.end_date === undefined) (patch as Record<string, unknown>).end_date = null;
            const { changed, task } = await tm.updateTaskRaw(existing.id, patch, {
              emitEvent: true, push: true, source: 'cloud-outbox',
            });
            if (changed) log.task.info('task-outbox: update applied', { id: existing.id, opId: op.opId });
            void task;
          }
        }
      }
      await fsp.rm(file, { force: true });
      applied++;
    } catch (err) {
      // Keep the file — retried next cycle. Log loudly so a wedged op is visible.
      log.task.error('task-outbox: op failed, will retry next cycle', { opId: op.opId, err: String(err) });
    }
  }
  if (applied > 0) log.task.info('task-outbox: applied cloud ops', { applied, pending: pending.length });
  return applied;
}

/**
 * CLOUD box: upsert the Mac-exported tasks/projection.json into the local
 * sqlite so the butler's task_query/task_search see Mac-side tasks.
 *
 * Upsert-only, and rows with a PENDING outbox op are skipped (the local write
 * is newer than the projection by construction — it hasn't round-tripped yet).
 * Never deletes local rows: the projection excludes done-tasks older than its
 * retention window, so absence there does not mean deleted.
 */
let lastProjectionMtimeMs = 0;

export async function importProjectionOnCloud(): Promise<number> {
  if (!CLOUD_MODE) return 0;
  const { readTaskProjection, PROJECTION_FILE } = await import('./task-projection.js');
  const { projectionCachePath } = await import('./projection-cache.js');
  // Cheap skip: nothing to do until a new projection lands from EITHER source
  // — the bridge-pushed cache file (events-v1 invokes this right after
  // writing it) or the legacy git-synced file (transition fallback). Gate on
  // the NEWER of the two mtimes so a git pull can't be shadowed by an older
  // cache file and vice versa; readTaskProjection() arbitrates content the
  // same way (fresher exportedAt wins).
  const [cacheSt, legacySt] = await Promise.all([
    fsp.stat(projectionCachePath('tasks')).catch(() => null),
    fsp.stat(PROJECTION_FILE).catch(() => null),
  ]);
  const mtimeMs = Math.max(cacheSt?.mtimeMs ?? 0, legacySt?.mtimeMs ?? 0);
  if (mtimeMs === 0) return 0;
  if (mtimeMs === lastProjectionMtimeMs) return 0;
  const projection = await readTaskProjection();
  if (!projection) return 0;

  const pendingIds = new Set<string>();
  for (const { op } of await listPendingOps()) {
    if (op.type !== 'delete') pendingIds.add(op.task.id);
    else pendingIds.add(op.id);
  }

  const tm = await import('./task-manager.js');
  const local = new Map((await tm.listTasks()).map((t) => [t.id, t]));

  const toInsert: Array<Omit<Task, 'id'> & { id: string }> = [];
  const toUpdate: Array<{ id: string; patch: Partial<Task> }> = [];

  for (const p of projection.tasks) {
    if (pendingIds.has(p.id)) continue;
    const row = local.get(p.id);
    if (!row) {
      toInsert.push({
        id: p.id,
        title: p.title,
        status: p.status as Task['status'],
        phase: p.phase as Task['phase'],
        priority: p.priority as Task['priority'],
        project: p.project || '',
        source: 'local', // display-only on cloud; primary owns the real source
        session_ids: [],
        description: '',
        summary: p.summary ?? '',
        note: '',
        created_at: p.created_at,
        updated_at: p.updated_at,
        ...(p.due_date ? { due_date: p.due_date } : {}),
        ...(p.start_date ? { start_date: p.start_date } : {}),
        ...(p.end_date ? { end_date: p.end_date } : {}),
        ...(p.completed_at ? { completed_at: p.completed_at } : {}),
        ...(p.starred ? { starred: true } : {}),
        ...(p.pinned ? { pinned: true } : {}),
        ...(p.tags?.length ? { tags: p.tags } : {}),
      } as Task);
    } else if (Date.parse(p.updated_at) > Date.parse(row.updated_at)) {
      toUpdate.push({
        id: p.id,
        patch: {
          title: p.title,
          status: p.status as Task['status'],
          phase: p.phase as Task['phase'],
          priority: p.priority as Task['priority'],
          project: p.project || '',
          // Projection omits cleared dates entirely; `undefined` in a patch means
          // "don't touch" (taskToRow drops it), which left stale dates on the
          // cloud replica forever. `null` is the explicit-clear marker that
          // taskToRow writes through as SQL NULL.
          due_date: (p.due_date ?? null) as Task['due_date'],
          start_date: (p.start_date ?? null) as Task['start_date'],
          end_date: (p.end_date ?? null) as Task['end_date'],
          completed_at: p.completed_at,
          starred: p.starred,
          pinned: p.pinned,
          tags: p.tags,
          summary: p.summary,
          updated_at: p.updated_at,
        },
      });
    }
  }

  if (toInsert.length) await tm.addTasksBulk(toInsert);
  if (toUpdate.length) await tm.updateTasksBulk(toUpdate);
  lastProjectionMtimeMs = mtimeMs;
  const changed = toInsert.length + toUpdate.length;
  if (changed > 0) {
    log.task.info('task-outbox: projection imported on cloud', {
      inserted: toInsert.length, updated: toUpdate.length, total: projection.tasks.length,
    });
  }
  return changed;
}

/**
 * Post-git-pull reconcile hook, called from git-sync on BOTH boxes.
 * Fire-and-forget from the sync loop; never throws.
 */
export async function reconcileAfterPull(): Promise<void> {
  try {
    if (CLOUD_MODE) await importProjectionOnCloud();
    else await applyOutboxOnPrimary();
  } catch (err) {
    log.task.error('task-outbox: post-pull reconcile failed', { err: String(err) });
  }
}
