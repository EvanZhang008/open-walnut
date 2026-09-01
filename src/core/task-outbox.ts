/**
 * Task op apply core + the LEGACY git outbox lane.
 *
 * Problem: on the cloud box the Personal AI's task tools write to the LOCAL
 * tasks.sqlite, which is gitignored — tasks created from the phone were
 * stranded on EC2 forever (and invisible to the iOS list, which reads the
 * Mac-exported tasks/projection.json).
 *
 * SINCE PHASE 4 the primary path is a synchronous bridge RPC:
 *   cloud bus subscriber → core/task-queue.ts dispatchTaskOp() →
 *   `session.control` action `server.tasks.apply` → the primary's
 *   handleSessionControlRelay → applyTaskOp() below. ~100ms instead of the
 *   1-3 minutes three git round trips used to cost. The cloud's offline
 *   fallback is a NON-git queue under cache/task-queue/ (task-queue.ts).
 *
 * What is left here:
 *   applyTaskOp()          — apply ONE op (LWW + whitelist + create/update/
 *                            delete), no file I/O. The single implementation
 *                            shared by the RPC handler and the file loop.
 *   applyOutboxOnPrimary() — LEGACY: consume tasks/outbox/<opId>.json files
 *                            after each git pull. Stays alive until the cloud
 *                            box is deployed with the RPC code (an old cloud
 *                            box still writes those files), and it is also the
 *                            delivery path for the needs_upgrade fallback (an
 *                            OLD primary that predates server.tasks.apply).
 *   recordTaskOp()         — LEGACY writer half (mints an op file). Retained
 *                            for the transition + tests; production dispatch
 *                            goes through task-queue.ts.
 *   importProjectionOnCloud() — upserts the Mac-exported projection into the
 *                            cloud sqlite so the Personal AI sees Mac-side tasks.
 *                            Upsert-only — it never deletes local rows. Since
 *                            Phase 3 the projection arrives as a bridge push
 *                            into the projection cache (events-v1 invokes the
 *                            import right after the cache write); the git-pull
 *                            trigger remains for the legacy transition file.
 *
 * Corruption defenses (each op is a FULL post-write snapshot):
 *   1. One op per message/file — git never has to merge two writers in one file.
 *   2. Idempotent absolute snapshots — re-applying after a crash, a lost RPC
 *      response, or a double delivery (RPC + legacy git file) is safe. A
 *      bounded recently-applied opId set short-circuits the common replay.
 *   3. LWW guard — a snapshot older than the local row's updated_at is skipped
 *      (a stale phone op can't clobber a newer Mac edit). This is what makes
 *      op ORDER non-load-bearing, so the queue may flush out of order.
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

/**
 * LEGACY git outbox directory. RETIREMENT PATH (deliberately NOT done in Phase
 * 4): once the cloud box runs Phase-4 code and the Mac is confirmed answering
 * `server.tasks.apply`, this directory goes permanently quiet — then
 * `git rm -r --cached tasks/outbox` + a gitignore entry, and the consumption
 * loop below can go with it. Until that deploy it must keep working: an old
 * cloud box still writes here, and a NEW cloud box writes here when the primary
 * answers needs_upgrade.
 */
export const OUTBOX_DIR = path.join(TASKS_DIR, 'outbox');

export type TaskOp =
  | { opId: string; type: 'create'; at: string; task: Task }
  | {
      opId: string; type: 'update'; at: string; task: Task;
      /** Fields the ORIGINATING mutation actually set (additive; new senders
       *  only). Scopes the patch: an untouched description/note/summary in the
       *  snapshot is replica IGNORANCE (those blobs don't ride the projection,
       *  so the replica row holds ''), not a user edit — blindly applying the
       *  full snapshot wiped primary content. A touched field that is ABSENT
       *  from the snapshot is an explicit clear (the sender set it and the
       *  post-write row no longer has it). Legacy ops (no touched) keep the
       *  full-snapshot behavior, minus empty text blobs (see applyTaskOp). */
      touched?: string[];
      /** Append-style note op (additive): the primary CONCATENATES this entry
       *  onto its own note instead of taking the snapshot's note, because the
       *  replica's prior note copy is blind (note isn't in the projection). */
      append?: { note?: string };
    }
  | { opId: string; type: 'delete'; at: string; id: string }
  /** Whole-project row reorder (additive). No per-row LWW clock — arrival
   *  order wins; flushTaskQueue's oldest-first sweep keeps it chronological. */
  | { opId: string; type: 'reorder'; at: string; project: string; taskIds: string[] }
  /** Focus-bar pin order (additive): pin_order = index for each pinned id.
   *  Same arrival-order semantics as 'reorder'. */
  | { opId: string; type: 'reorder-pins'; at: string; taskIds: string[] };

/**
 * Fields an 'update' op may write onto an existing primary row.
 *
 * VERSION SKEW: a cloud box running older code keeps emitting ops that carry
 * retired fields (`category`, `starred`). Dropping the key from this list is the
 * whole tolerance mechanism — an unknown field is simply never copied into the
 * patch, so an old op degrades to "project + the other fields" instead of
 * failing or resurrecting the retired column. No op-format version number needed.
 */
const UPDATE_WHITELIST: (keyof Task)[] = [
  'title', 'status', 'phase', 'priority', 'project',
  'due_date', 'start_date', 'end_date', 'completed_at', 'pinned', 'tags', 'summary',
  'description', 'note', 'sprint', 'unread', 'updated_at',
  // Focus-bar + dependency parity (2026-08): these ride ONLY on ops that name
  // them in `touched` — a legacy full snapshot never carries them (the replica
  // row lacks them unless the phone set them), so old senders can't clobber.
  'focus_tier', 'pin_order', 'depends_on',
];

/**
 * Text blobs the projection does NOT ship (in full) to the replica, applied
 * only on a LEGACY full-snapshot op (no `touched` list):
 *   - description/note: an EMPTY value means the replica never KNEW the
 *     content (those blobs aren't in the projection) — not a user clear — so
 *     it must never blank the primary's copy.
 *   - summary: NEVER authoritative — the projection ships a 500-char
 *     TRUNCATED preview, so echoing it back would truncate the primary's
 *     full summary on every unrelated edit.
 * New senders scope every write via `touched`, which bypasses this guard.
 */
const LEGACY_SKIP_WHEN_EMPTY: (keyof Task)[] = ['description', 'note'];
const LEGACY_NEVER_APPLY: (keyof Task)[] = ['summary'];

/**
 * True when the primary's projected pin state disagrees with the replica's row.
 * Used by importProjectionOnCloud for the one primary write that deliberately
 * does NOT move `updated_at` (pin retirement); see the branch that calls it.
 *
 * Normalized both sides because the projection omits rather than falsifies:
 * `pinned` is absent when false, and `pin_order` / `focus_tier` are omitted
 * entirely on an unpinned row.
 */
function pinStateDiffers(
  projected: { pinned?: boolean; pin_order?: number; focus_tier?: string },
  row: Task,
): boolean {
  if (!!projected.pinned !== !!row.pinned) return true;
  const projectedOrder = typeof projected.pin_order === 'number' ? projected.pin_order : null;
  const rowOrder = typeof row.pin_order === 'number' ? row.pin_order : null;
  if (projectedOrder !== rowOrder) return true;
  return (projected.focus_tier ?? '') !== (row.focus_tier ?? '');
}

let opSeq = 0;

/**
 * @deprecated LEGACY git lane. Drops one op FILE into tasks/outbox/ on the
 * CLOUD box; no-op on the primary. Since Phase 4 nothing in production calls
 * this — task dispatch goes through core/task-queue.ts (bridge RPC, with the
 * non-git queue as fallback), and only the needs_upgrade branch there still
 * writes a git outbox file. Kept as the reference implementation of the file
 * format the primary's consumption path still reads, and exercised by
 * tests/core/task-outbox.test.ts. Remove together with tasks/outbox/ once the
 * git directory is untracked (see the retirement note on OUTBOX_DIR).
 *
 * Never throws — the local write already succeeded; a failed drop is logged and
 * the op is lost (surfaced in logs, not silently swallowed as corrupted data).
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
 * Recently-applied opIds — the cheap idempotency short-circuit for a REPLAY
 * (the RPC response was lost so the cloud re-sent it, or the same op arrived
 * both over RPC and as a legacy git file during the transition). Correctness
 * does not depend on this: absolute snapshots + LWW already converge. It just
 * avoids a redundant store write and a duplicate bus event / plugin push.
 *
 * Bounded FIFO — an unbounded set would grow with every phone edit forever.
 */
const recentOpIds = new Set<string>();
const RECENT_OP_IDS_MAX = 500;

function rememberOpId(opId: string): void {
  if (recentOpIds.size >= RECENT_OP_IDS_MAX) {
    const oldest = recentOpIds.values().next().value;
    if (oldest !== undefined) recentOpIds.delete(oldest);
  }
  recentOpIds.add(opId);
}

/** Tests only — drop the replay guard. */
export function _resetAppliedOpIdsForTesting(): void {
  recentOpIds.clear();
}

export interface ApplyTaskOpResult {
  applied: boolean;
  /** Why an op did NOT change the store (or how it was consumed). */
  reason?: 'replay' | 'stale' | 'missing' | 'blocked' | 'unchanged' | 'created' | 'updated' | 'deleted' | 'reordered';
}

/**
 * PRIMARY box: apply ONE task op through the normal task-manager APIs, so
 * plugin push + projection re-export + bus events all fire exactly as they do
 * for a local edit. Pure logic — NO file I/O, no queue bookkeeping: the caller
 * owns the transport (the `server.tasks.apply` RPC handler, or the legacy
 * outbox file loop below).
 *
 * Throws only on an UNEXPECTED store failure — the caller decides whether to
 * retry (keep the queue file) or drop. Every EXPECTED non-application (replay,
 * stale snapshot, missing row, delete blocked by a live session) comes back as
 * `{ applied: false, reason }` and means "consume the op, do not retry".
 */
export async function applyTaskOp(op: TaskOp): Promise<ApplyTaskOpResult> {
  if (recentOpIds.has(op.opId)) return { applied: false, reason: 'replay' };

  const tm = await import('./task-manager.js');

  if (op.type === 'reorder' || op.type === 'reorder-pins') {
    // Order ops carry no per-row LWW clock: last-arrival wins, which is what a
    // human dragging rows expects. Both core functions are self-healing
    // (unknown/stale ids are dropped, missing ids appended), so a list that
    // drifted while the op was queued still applies cleanly.
    if (op.type === 'reorder') await tm.reorderTasks(op.project, op.taskIds);
    else await tm.reorderPins(op.taskIds);
    rememberOpId(op.opId);
    const { bus, EventNames } = await import('./event-bus.js');
    // Bulk signal (task: null is the established "refetch the list" marker) so
    // the web UI and the projection exporter pick up the new order.
    bus.emit(EventNames.TASK_UPDATED, { task: null }, ['web-ui'], { source: 'cloud-outbox' });
    return { applied: true, reason: 'reordered' };
  }

  if (op.type === 'delete') {
    try {
      const { task } = await tm.deleteTask(op.id);
      const { bus, EventNames } = await import('./event-bus.js');
      // Notify UI + projection exporter (deleteTask itself is emit-silent).
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'cloud-outbox' });
      rememberOpId(op.opId);
      return { applied: true, reason: 'deleted' };
    } catch (err) {
      const msg = String(err);
      // Already gone (idempotent) or blocked by active sessions (keep the
      // task, consume the op — a phone delete must not kill a running session).
      const missing = /No task found/i.test(msg);
      if (!missing) {
        log.task.warn('task-op: delete not applied', { id: op.id, err: msg });
      }
      rememberOpId(op.opId);
      return { applied: false, reason: missing ? 'missing' : 'blocked' };
    }
  }

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
        // The name came off remote JSON we don't control. Rethrowing would keep
        // the op queued and retry it forever — fall back to Inbox and consume it.
        log.task.warn('task-op: invalid project name from cloud op — filing in Inbox', {
          opId: op.opId, project: snapshotProject, err: String(err),
        });
        snapshotProject = '';
      }
    }
    const { id, ...rest } = snapshot;
    const [created] = await tm.addTasksBulk([
      { ...rest, id, project: snapshotProject, source: primarySource },
    ]);
    rememberOpId(op.opId);
    if (created) {
      const { bus, EventNames } = await import('./event-bus.js');
      bus.emit(EventNames.TASK_CREATED, { task: created }, ['web-ui'], { source: 'cloud-outbox' });
      if (created.source !== 'local') {
        tm.autoPushIfConfigured(created).catch(() => { /* sync_error stamped inside */ });
      }
      log.task.info('task-op: cloud task created on primary', {
        id: created.id, title: created.title, source: created.source,
      });
    }
    return { applied: true, reason: 'created' };
  }

  // LWW: never let an older phone snapshot clobber a newer local edit.
  if (Date.parse(snapshot.updated_at) <= Date.parse(existing.updated_at)
      && op.type === 'update') {
    log.task.info('task-op: stale update skipped (local row newer)', {
      id: snapshot.id, snapshotAt: snapshot.updated_at, localAt: existing.updated_at,
    });
    rememberOpId(op.opId);
    return { applied: false, reason: 'stale' };
  }

  const touched = op.type === 'update' && Array.isArray(op.touched) && op.touched.length > 0
    ? new Set(op.touched)
    : null;
  const patch: Partial<Task> = {};
  if (touched) {
    // A status/phase transition manages completed_at as a side effect
    // (applyPhase on the sender), so it is implicitly touched — without this a
    // scoped complete-op would land without its completion timestamp.
    if (touched.has('status') || touched.has('phase')) touched.add('completed_at');
    // NEW sender: the op names exactly what the originating mutation set.
    // A touched field ABSENT from the snapshot is an explicit clear (unpin
    // deletes pin_order/focus_tier, '' clears a date) — null is the marker
    // taskToRow writes through as SQL NULL.
    for (const key of UPDATE_WHITELIST) {
      if (key === 'updated_at' || !touched.has(key)) continue;
      const val = snapshot[key];
      (patch as Record<string, unknown>)[key] = val === undefined ? null : val;
    }
  } else {
    // LEGACY full snapshot (old cloud box): apply present whitelisted fields…
    for (const key of UPDATE_WHITELIST) {
      if (snapshot[key] === undefined) continue;
      // …minus the projection-blind text blobs (see the constants above):
      // an empty description/note is replica ignorance, and the snapshot's
      // summary is a truncated preview, never the real document.
      if ((LEGACY_NEVER_APPLY as string[]).includes(key)) continue;
      if ((LEGACY_SKIP_WHEN_EMPTY as string[]).includes(key) && snapshot[key] === '') continue;
      (patch as Record<string, unknown>)[key] = snapshot[key];
    }
    // The snapshot is the FULL task, so an absent date means "cleared on
    // the phone/cloud" — write it through as the explicit-clear marker,
    // otherwise a cleared date silently survives on the primary.
    if (snapshot.due_date === undefined) (patch as Record<string, unknown>).due_date = null;
    if (snapshot.start_date === undefined) (patch as Record<string, unknown>).start_date = null;
    if (snapshot.end_date === undefined) (patch as Record<string, unknown>).end_date = null;
  }
  // LWW clock always rides along so the primary row's updated_at reflects the edit.
  (patch as Record<string, unknown>).updated_at = snapshot.updated_at;

  // Project move: mint the registry row exactly like the create branch does —
  // the raw update below writes the column only, and a phone-side move to a
  // brand-new project name must not leave a rowless project on the primary.
  if (typeof patch.project === 'string' && patch.project.trim()
      && patch.project.trim().toLowerCase() !== (existing.project || '').trim().toLowerCase()) {
    try {
      const ensured = await tm.ensureProject(patch.project.trim(), 'local');
      patch.project = ensured.name; // canonical spelling wins
    } catch (err) {
      if (!(err instanceof tm.InvalidProjectNameError)) throw err;
      log.task.warn('task-op: invalid project name on update — keeping current project', {
        opId: op.opId, project: patch.project, err: String(err),
      });
      delete patch.project;
    }
  }

  // depends_on: never write the raw column — route through updateTask's
  // set_depends_on so existence + cycle validation run. Only a VALIDATION
  // failure may be swallowed (a cycle or a target that doesn't exist would be
  // refused identically on every retry, so consuming the op is the right call
  // and the other fields still apply). Everything else — a 10s write-lock
  // timeout, EIO, a plugin push blowing up — MUST propagate, exactly like the
  // project branch above: applyTaskOp then never returns, so rememberOpId
  // below doesn't run and the caller keeps its queue file for a retry. An
  // unconditional catch here lost the edit twice over, because the fall-through
  // updateTaskRaw still succeeded and reported `applied: true`: the primary
  // burned the opId in its replay guard AND the replica skipped enqueue on the
  // truthy result, so nobody held a copy of the user's dependency edit.
  if (patch.depends_on !== undefined) {
    const deps = Array.isArray(patch.depends_on) ? patch.depends_on : [];
    delete patch.depends_on;
    try {
      await tm.updateTask(existing.id, { set_depends_on: deps }, { source: 'api', asyncPush: true });
    } catch (err) {
      if (!(err instanceof tm.CircularDependencyError)
          && !(err instanceof tm.DependencyValidationError)) throw err;
      log.task.warn('task-op: depends_on rejected (validation) — dropping that field', {
        opId: op.opId, id: existing.id, err: String(err),
      });
    }
  }

  // Append-style note (POST /tasks/:id/notes): concatenate onto the PRIMARY's
  // note — the replica's own note copy is blind, so its snapshot value is just
  // the appended entry, not the merged document.
  if (op.type === 'update' && typeof op.append?.note === 'string' && op.append.note) {
    (patch as Record<string, unknown>).note = existing.note
      ? existing.note + '\n\n' + op.append.note
      : op.append.note;
  }

  // Human reopen: a deliberate (touched) non-terminal phase over a terminal
  // primary row is a person un-completing the task from the phone — the
  // replica's own human-source gate already vetted it (an agent's attempt is
  // skipped there, so its snapshot still carries the terminal phase). Route it
  // through updateTask's human path; the raw path below would block it as if
  // it were a sync echo.
  const { phaseFromStatus, TERMINAL_PHASES } = await import('./phase.js');
  const phasePatch = (patch.phase ?? (patch.status ? phaseFromStatus(patch.status) : undefined));
  if (touched && phasePatch && !TERMINAL_PHASES.has(phasePatch) && TERMINAL_PHASES.has(existing.phase)) {
    await tm.updateTask(existing.id, { phase: phasePatch }, { source: 'api', asyncPush: true });
    delete patch.phase;
    delete patch.status;
    delete (patch as Record<string, unknown>).completed_at;
  }

  const { changed } = await tm.updateTaskRaw(existing.id, patch, {
    emitEvent: true, push: true, source: 'cloud-outbox',
  });
  rememberOpId(op.opId);
  if (changed) log.task.info('task-op: update applied', { id: existing.id, opId: op.opId, scoped: !!touched });
  return changed ? { applied: true, reason: 'updated' } : { applied: false, reason: 'unchanged' };
}

/**
 * LEGACY (git lane) — PRIMARY box: apply pending op FILES from
 * tasks/outbox/, then delete each consumed file. Called after every git pull.
 * A thin loop around applyTaskOp(): serial + best effort, one throwing op is
 * kept on disk for the next cycle without blocking the rest.
 *
 * Still load-bearing for two cases and NOT to be removed yet:
 *   1. A cloud box on pre-Phase-4 code that still writes these files.
 *   2. The needs_upgrade fallback — a NEW cloud box talking to an OLD primary
 *      writes the legacy file so the op still lands (see core/task-queue.ts).
 *
 * The return value counts CONSUMED files (an op that was correctly skipped as
 * stale/replay is consumed too — retrying it would never change the outcome).
 */
export async function applyOutboxOnPrimary(): Promise<number> {
  if (CLOUD_MODE) return 0;
  const pending = await listPendingOps();
  if (pending.length === 0) return 0;

  let applied = 0;
  for (const { file, op } of pending) {
    try {
      await applyTaskOp(op);
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
 * sqlite so the Personal AI's task_query/task_search see Mac-side tasks.
 *
 * Upserts skip rows with a PENDING outbox/queue op (the local write is newer
 * than the projection by construction — it hasn't round-tripped yet).
 *
 * DELETION reconcile (2026-08, guarded): the projection carries EVERY
 * non-done primary task, so a non-done local row absent from it means the
 * primary deleted it — and since GET /v1/tasks now serves the replica's own
 * store, a never-deleted zombie would haunt the phone list forever. Guards
 * (each one keeps a legitimate local-only row alive): pending-op rows,
 * tombstoned ids, done rows (projection retention legitimately omits old
 * ones), and rows updated within a safety window of the projection's build
 * time (a fresh replica create whose round trip hasn't reached a projection
 * yet).
 */
let lastProjectionMtimeMs = 0;

/** A local row absent from the projection is deleted only when the projection
 *  was built comfortably after the row's last write. */
const IMPORT_DELETE_SAFETY_MS = 10 * 60_000;

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

  // Rows with an UNDELIVERED local write are skipped — the local row is newer
  // than the projection by construction. Two pending sources: the legacy git
  // outbox (transition) and the Phase-4 offline queue (cache/task-queue/) —
  // missing the latter let a stale projection echo clobber a queued edit and,
  // worse, RESURRECT a locally-deleted task (import is upsert-only, so the
  // zombie then never left). Tombstones extend the delete guard past the
  // queue drain: a projection built before the primary applied the delete can
  // still arrive after the op was consumed.
  const pendingIds = new Set<string>();
  for (const { op } of await listPendingOps()) {
    if (op.type === 'delete') pendingIds.add(op.id);
    else if (op.type === 'create' || op.type === 'update') pendingIds.add(op.task.id);
  }
  const tq = await import('./task-queue.js');
  for (const op of await tq.listQueuedOps()) {
    if (op.type === 'delete') pendingIds.add(op.id);
    else if (op.type === 'create' || op.type === 'update') pendingIds.add(op.task.id);
  }

  const tm = await import('./task-manager.js');
  const local = new Map((await tm.listTasks()).map((t) => [t.id, t]));

  const toInsert: Array<Omit<Task, 'id'> & { id: string }> = [];
  const toUpdate: Array<{ id: string; patch: Partial<Task> }> = [];

  // Mac-side deletes (see the header comment for the guard rationale). Requires
  // a COMPLETE list: this pass reads "local row absent from the projection" as
  // "the primary deleted it". A projection whose export budget dropped rows sets
  // `truncated`, and then absence proves nothing — running this pass against one
  // would delete perfectly live tasks from the replica.
  const projectionIds = new Set(projection.tasks.map((t) => t.id));
  const projectionAt = Date.parse(projection.exportedAt);
  if (projection.truncated) {
    log.task.warn('task-outbox: projection is truncated — skipping delete reconcile', {
      rows: projection.tasks.length, exportedAt: projection.exportedAt,
    });
  } else if (Number.isFinite(projectionAt)) {
    for (const row of local.values()) {
      if (projectionIds.has(row.id)) continue;
      if (row.status === 'done') continue; // retention window omits old done rows
      if (pendingIds.has(row.id) || tq.hasDeleteTombstone(row.id)) continue;
      const rowAt = Date.parse(row.updated_at);
      if (!Number.isFinite(rowAt) || projectionAt - rowAt < IMPORT_DELETE_SAFETY_MS) continue;
      try {
        const { task } = await tm.deleteTask(row.id);
        const { bus, EventNames } = await import('./event-bus.js');
        bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'cloud-outbox' });
        log.task.info('task-outbox: projection reconcile removed a primary-deleted row', { id: row.id });
      } catch (err) {
        log.task.warn('task-outbox: projection reconcile delete failed', { id: row.id, err: String(err) });
      }
    }
  }

  for (const p of projection.tasks) {
    if (pendingIds.has(p.id)) continue;
    // Deleted here, projection built before the primary caught up — skip
    // (upsert-only import would otherwise resurrect the row forever).
    if (tq.hasDeleteTombstone(p.id)) continue;
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
        ...(p.pinned ? { pinned: true } : {}),
        ...(p.pin_order !== undefined ? { pin_order: p.pin_order } : {}),
        ...(p.focus_tier ? { focus_tier: p.focus_tier } : {}),
        ...(p.unread ? { unread: true } : {}),
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
          // Booleans are written EXPLICITLY (never undefined): the projection
          // omits them when false, and an undefined patch value means "don't
          // touch" — which left a Mac-side unpin/read invisible on the replica
          // forever. Same explicit-clear rule as the dates for the pin fields.
          pinned: !!p.pinned,
          pin_order: (p.pin_order ?? null) as Task['pin_order'],
          focus_tier: (p.focus_tier ?? null) as Task['focus_tier'],
          unread: !!p.unread,
          tags: p.tags,
          summary: p.summary,
          updated_at: p.updated_at,
        },
      });
    } else if (
      Date.parse(p.updated_at) === Date.parse(row.updated_at) &&
      pinStateDiffers(p, row)
    ) {
      // SAME clock, DIFFERENT pin state. The `updated_at` LWW gate above assumes
      // every primary write moves the row's clock, and one deliberately does not:
      // pin retirement (core/task-pin-retirement.ts) unpins old completed rows
      // WITHOUT touching updated_at, because bumping 1,100 finished tasks would
      // sort them all to the top of every recency surface (the 40-entry recent-task
      // ledger, search decay) — the exact junk it just retired. Without this branch
      // the replica keeps every retired pin forever and the phone board never
      // shrinks, since a finished task never gets another edit to carry the change.
      //
      // Only the pin trio is patched, and `updated_at` is deliberately left alone,
      // so the pass is idempotent (the next import sees matching pin state).
      // Equality is the whole safety argument: any replica-side pin write bumps its
      // own row's clock (togglePin / reorderPins), so equal clocks mean neither box
      // has an unsynced pin edit — and rows with a queued op are already excluded
      // by `pendingIds` above.
      toUpdate.push({
        id: p.id,
        patch: {
          pinned: !!p.pinned,
          pin_order: (p.pin_order ?? null) as Task['pin_order'],
          focus_tier: (p.focus_tier ?? null) as Task['focus_tier'],
        },
      });
    }
  }

  if (toInsert.length) await tm.addTasksBulk(toInsert);
  if (toUpdate.length) await tm.updateTasksBulk(toUpdate);
  // Reopen pass: updateTasksBulk rides the raw path, whose terminal-phase
  // guard silently drops a COMPLETE→non-terminal transition (built to stop
  // sync-plugin echoes reopening tasks). On the REPLICA the projection is the
  // PRIMARY's authoritative state — a human reopened the task on the Mac — so
  // route just the phase through the human-source path. Everything else in
  // the patch already landed above.
  // COMPLETE is the only terminal phase (mirrors TERMINAL_PHASES in phase.ts),
  // so it is the only phase whose guard the raw path can silently drop.
  for (const { id, patch } of toUpdate) {
    const phase = patch.phase as Task['phase'] | undefined;
    if (!phase || phase === 'COMPLETE') continue;
    const row = local.get(id);
    if (!row || row.phase !== 'COMPLETE') continue;
    await tm.updateTask(id, { phase }, { source: 'api' }).catch((err) => {
      log.task.warn('task-outbox: projection reopen failed', { id, err: String(err) });
    });
  }
  // Adopt the primary's custom-tier registry (additive envelope field) so the
  // replica's tier endpoints validate/bucket exactly like the primary.
  if (Array.isArray(projection.custom_tiers)) {
    await tm.replaceCustomTiersFromSync(projection.custom_tiers).catch((err) => {
      log.task.warn('task-outbox: custom-tier registry sync failed', { err: String(err) });
    });
  }
  // Adopt the primary's row ORDER (the projection array is store order) so a
  // Mac-side drag shows up on the phone. Stands down after a replica-side
  // reorder: a projection built before the primary applied it would re-impose
  // the old order (the projection-lag echo family).
  if (!tq.hasRecentOrderOp()) {
    await tm.alignTaskOrderFromSync(projection.tasks.map((t) => t.id)).catch((err) => {
      log.task.warn('task-outbox: order alignment failed', { err: String(err) });
    });
  }
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
