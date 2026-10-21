/**
 * Cloud → primary task-op dispatch (Phase 4).
 *
 * BEFORE: a phone task edit hit the cloud REST route, which emitted a bus event,
 * whose cloud-only subscriber wrote tasks/outbox/<opId>.json into the DATA GIT
 * REPO. That file needed a cloud commit → a hub push → a Mac pull before
 * applyOutboxOnPrimary() could run it: three git hops, 1-3 minutes, with
 * every external sync-plugin push and every phase hook waiting behind it.
 *
 * NOW: the op is applied SYNCHRONOUSLY over the existing cloud→Mac RPC lane —
 *   dispatchTaskOp() → `session.control` action `server.tasks.apply`
 *   (sessionId '__server__') → v1-control-relay callPrimaryControl() → the
 *   primary's daemon (which forwards the action string opaquely — zero daemon
 *   changes) → handleSessionControlRelay → applyTaskOp().
 * ~100ms, and the RPC reply is authoritative for the op itself. The phone's
 * HTTP response is unaffected either way: this whole module runs off a bus
 * subscriber, i.e. AFTER the route already answered 200 optimistically.
 *
 * FALLBACK LADDER when the RPC does not land (this is the whole point of the
 * module — the old lane's one virtue was that git buffered offline):
 *
 *   bridge_offline / timeout  → queue the op under cache/task-queue/<opId>.json
 *     (NON-git; cache/ is gitignored on both boxes). Drained on the primary's
 *     bridge reconnect, on the next successful dispatch, and by a 60s sweep.
 *     Nothing is written into git — the dual-write is dead.
 *
 *   needs_upgrade (400)       → queue file AND the LEGACY git outbox file.
 *     An OLD primary answers `Unknown control action: server.tasks.apply`; it
 *     will NEVER answer this action, so a queue-only fallback would strand the
 *     op until the Mac is upgraded. The legacy file keeps the pre-Phase-4
 *     consumption path (applyOutboxOnPrimary after git pull) delivering, and
 *     the queued copy converges the instant the Mac upgrades. Double delivery
 *     is harmless: applyTaskOp is idempotent (absolute snapshot + LWW + the
 *     recently-applied opId set).
 *
 *   domain error (4xx/5xx)    → dropped, logged. The primary RAN the op and
 *     rejected it; retrying forever would wedge the queue behind a poison op.
 *
 * Ordering is deliberately NOT preserved: each op is a full absolute snapshot
 * and LWW discards anything older than the primary row, so an out-of-order
 * flush converges to the same state. Oldest-first sweep is just politeness
 * (opIds sort chronologically).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, TASK_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';
import type { Task } from './types.js';
import type { TaskOp } from './task-outbox.js';
import { QUEUEABLE_TASK_FIELDS } from '../providers/offline-host-core.js';
import { _clearCompanionBasesForTesting, companionBaseOf, forgetCompanionBases, putCompanionBases } from './companion-bases.js';

/** Placeholder sessionId for box-level `server.*` relay actions (routines-v1 uses the same). */
const SERVER_RELAY_SID = '__server__';

/** A task op is small; the primary re-validates with its own cap. 20s is well
 *  under the daemon's 45s control-relay budget, and a task write never needs
 *  the 30s the history/terminate actions do. */
const TASK_RPC_TIMEOUT_MS = 20_000;

/** Sweep cadence for the offline queue. Unref'd — never holds the process open. */
const FLUSH_INTERVAL_MS = 60_000;

/** Max ops per sweep. A long outage can bank hundreds; firing them all at once
 *  would burst the shared bridge socket (and every op triggers a primary store
 *  write + plugin push). The next sweep picks up the rest. */
const FLUSH_BATCH_MAX = 100;

let opSeq = 0;

/** Mint the opId. Lexicographic sort == chronological sort (zero-padded ms). */
function mintOpId(): string {
  return `${Date.now().toString().padStart(15, '0')}-${(opSeq++).toString().padStart(4, '0')}`;
}

/** What a replica-side mutation hands to dispatchTaskOp. `touched`/`append`
 *  scope an update (see TaskOp in task-outbox.ts); the two reorder kinds carry
 *  whole-list ordering (no per-row LWW clock). */
export type TaskOpInput =
  | { type: 'create'; task: Task }
  | { type: 'update'; task: Task; touched?: string[]; append?: { note?: string }; fields?: TaskFieldWrites }
  | { type: 'delete'; id: string }
  | { type: 'reorder'; project: string; taskIds: string[] }
  | { type: 'reorder-pins'; taskIds: string[] };

export function buildTaskOp(op: TaskOpInput): TaskOp {
  const opId = mintOpId();
  const at = new Date().toISOString();
  switch (op.type) {
    case 'delete':
      return { opId, type: 'delete', at, id: op.id };
    case 'reorder':
      return { opId, type: 'reorder', at, project: op.project, taskIds: op.taskIds };
    case 'reorder-pins':
      return { opId, type: 'reorder-pins', at, taskIds: op.taskIds };
    case 'create':
      return { opId, type: 'create', at, task: op.task };
    case 'update':
      return {
        opId, type: 'update', at, task: op.task,
        ...(op.touched?.length ? { touched: op.touched } : {}),
        ...(op.append?.note ? { append: { note: op.append.note } } : {}),
        ...(op.fields && Object.keys(op.fields).length ? { fields: op.fields } : {}),
      };
  }
}

// ── Per-field bases (WP13): the companion's queue merged by the section 7 rules ──

/** One field of an update: what the row held before, what was written, when (this box's clock, ms). */
export type TaskFieldWrites = Record<string, { base: unknown; value: unknown; at: number }>;

/** Fields the Mac merges (offline-host-core.ts QUEUEABLE_TASK_FIELDS). */
const MERGEABLE = new Set<string>(QUEUEABLE_TASK_FIELDS);
/** Derived by the write that sets the phase, never written on their own. */
const DERIVED = new Set(['completed_at', 'updated_at']);
/** A field this box has no value for: the Mac takes the newer write (task-fields.ts UNKNOWN_BASE). */
const UNKNOWN_BASE = 'unknown';

/**
 * The last value of each field of a task this box knows: the Mac's row as the task
 * copy took it, then every write made here. The base of the next write here.
 * On disk (companion-bases.ts), so a restart or a task not copied since boot keeps it.
 */
function baseRowOf(task: Task): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of MERGEABLE) row[f] = (task as unknown as Record<string, unknown>)[f] ?? null;
  return row;
}

/**
 * Tasks with a live op on its way to the Mac: sent, neither applied there nor queued
 * here yet. Such a task's base is held the way a queued op holds it (task-replica-store.ts
 * heldIds, and the two functions below): a copy round that lands meanwhile carries the
 * Mac's row from before this write, and taking that as the base would make this box's
 * next write to the field read as a second writer on the Mac (a false conflict letter).
 * A count per task: two writes to one task may be on their way at once.
 */
const liveInFlight = new Map<string, number>();
/** Every live op on its way, the order ops (no task) included. */
let liveOps = 0;

/** Whether a live op for this task is on its way to the Mac (dispatchTaskOp). */
export function taskOpInFlight(id: string): boolean {
  return liveInFlight.has(id);
}

/** How many live ops are on their way, any kind (a forwarded task write waits behind them, v1-forward/proxy.ts). */
export function liveTaskOpsInFlight(): number {
  return liveOps;
}

function holdLive(id: string): void {
  liveInFlight.set(id, (liveInFlight.get(id) ?? 0) + 1);
}

function releaseLive(id: string): void {
  const n = (liveInFlight.get(id) ?? 0) - 1;
  if (n > 0) liveInFlight.set(id, n);
  else liveInFlight.delete(id);
}

/**
 * The task copy took these rows from the Mac (replication/task-replica-store.ts). A row
 * the copy did not store (`skipped`) or whose live op is still on its way keeps its base.
 */
export function noteKnownTaskRows(rows: readonly Task[], skipped: readonly string[] = []): void {
  const held = new Set(skipped);
  putCompanionBases(rows.filter((t) => t && typeof t.id === 'string' && !held.has(t.id) && !liveInFlight.has(t.id)).map((t) => ({ id: t.id, row: baseRowOf(t) })));
}

/** These tasks are gone here: their bases go with them (not one whose live op is on its way). */
export function forgetKnownTaskRows(ids: readonly string[]): void {
  forgetCompanionBases(ids.filter((id) => !liveInFlight.has(id)));
}

/**
 * The per-field writes of one update made here, with their bases, or undefined
 * when a field it set is one the Mac does not merge (the op then goes as before).
 * Remembers the row as written: the base of the next write.
 */
export function companionFieldWrites(task: Task, touched: readonly string[] | undefined): TaskFieldWrites | undefined {
  const known = companionBaseOf(task.id);
  try {
    const fields = (touched ?? []).filter((f) => !DERIVED.has(f));
    if (fields.length === 0 || fields.some((f) => !MERGEABLE.has(f))) return undefined;
    const row = task as unknown as Record<string, unknown>;
    const fallback = Date.parse(task.updated_at) || Date.now();
    const out: TaskFieldWrites = {};
    for (const f of fields) {
      const at = Date.parse(task.field_at?.[f] ?? '') || fallback;
      out[f] = { base: known && f in known ? known[f] : UNKNOWN_BASE, value: row[f] ?? null, at };
    }
    return out;
  } finally {
    putCompanionBases([{ id: task.id, row: baseRowOf(task) }]);
  }
}

/** Tests only. */
export function _resetKnownTaskRowsForTesting(): void {
  liveInFlight.clear();
  _clearCompanionBasesForTesting();
}

function queueFile(opId: string): string {
  return path.join(TASK_QUEUE_DIR, `${opId}.json`);
}

/** Only ids we minted land in filenames — reject anything else outright. */
const SAFE_OP_ID_RE = /^[A-Za-z0-9_-]+$/;

async function enqueue(op: TaskOp): Promise<void> {
  if (!SAFE_OP_ID_RE.test(op.opId)) return;
  try {
    await writeJsonFile(queueFile(op.opId), op);
    log.task.info('task-queue: op queued for retry', { opId: op.opId, type: op.type });
  } catch (err) {
    log.task.error('task-queue: FAILED to queue op — cloud task change will not reach primary', {
      opId: op.opId, type: op.type, err: String(err),
    });
  }
}

/**
 * needs_upgrade only: ALSO drop the op into the legacy git outbox so an OLD
 * primary (which can never answer server.tasks.apply) still receives it over
 * git-sync. Retires itself — once the Mac runs Phase 4 code this branch is
 * never taken again.
 *
 * WRITE-ONCE: the queued copy of a needs_upgrade op survives every sweep (it is
 * what converges the instant the Mac upgrades), so a blind write here would
 * re-touch a GIT-TRACKED file every 60s forever — the exact churn Phase 3/4
 * exist to kill. Skip when the file is already there; if the primary consumed
 * and deleted it, the queued copy's RPC is what delivers next.
 */
async function writeLegacyOutboxFallback(op: TaskOp): Promise<void> {
  // An old primary's consumption loop predates the order ops — a legacy file
  // it can't parse would be retried on every git pull forever. Ordering is
  // cosmetic; the queued copy converges the moment the primary upgrades.
  if (op.type === 'reorder' || op.type === 'reorder-pins') return;
  try {
    const { OUTBOX_DIR } = await import('./task-outbox.js');
    const file = path.join(OUTBOX_DIR, `${op.opId}.json`);
    if (await fsp.stat(file).then(() => true).catch(() => false)) return;
    await writeJsonFile(file, op);
    log.task.warn('task-queue: primary predates server.tasks.apply — wrote LEGACY git outbox file', {
      opId: op.opId, type: op.type,
    });
  } catch (err) {
    log.task.error('task-queue: legacy outbox fallback write failed', {
      opId: op.opId, err: String(err),
    });
  }
}

type SendOutcome = 'applied' | 'retry' | 'needs_upgrade' | 'rejected' | 'primary_error';

/**
 * One `server.tasks.apply` RPC. Never throws. An update goes with this box's clock
 * (`sentAt`, the Mac measures the offset of its field times from it) and the flush
 * it is part of (`flush`: one drain on the Mac, one letter); neither is stored.
 */
async function sendOp(op: TaskOp, flush?: string): Promise<SendOutcome> {
  const { callPrimaryControl } = await import('../web/routes/v1-control-relay.js');
  const sent: TaskOp = op.type === 'update' ? { ...op, sentAt: Date.now(), ...(flush ? { flush } : {}) } : op;
  const reply = await callPrimaryControl('server.tasks.apply', SERVER_RELAY_SID, { op: sent }, TASK_RPC_TIMEOUT_MS);
  if (reply.ok) {
    log.task.info('task-queue: op applied on primary via bridge RPC', {
      opId: op.opId, type: op.type,
      applied: reply.result.applied, reason: reply.result.reason,
    });
    return 'applied';
  }
  if (reply.failure.kind === 'needs_upgrade') return 'needs_upgrade';
  if (reply.failure.kind === 'bridge_offline') {
    log.task.info('task-queue: bridge unavailable — falling back to the offline queue', {
      opId: op.opId, type: op.type, reason: reply.failure.message,
    });
    return 'retry';
  }
  // A 5xx is the primary FAILING, not refusing: applyTaskOp threw on a write
  // lock timeout / EIO, and the relay reports that as errorKind 'internal'.
  // Dropping it here would re-open the same silent loss the primary's own
  // narrowed catch just closed — the whole point of letting it throw is that
  // SOMEBODY still holds the op. Bank it and retry.
  if (reply.failure.status >= 500) {
    log.task.warn('task-queue: primary FAILED to apply op (not a refusal) — queueing for retry', {
      opId: op.opId, type: op.type, status: reply.failure.status, err: reply.failure.message,
    });
    return 'primary_error';
  }
  // The primary RAN it and refused (bad shape, oversized, domain error). A
  // retry would produce the identical refusal forever — drop it loudly.
  log.task.error('task-queue: primary rejected op — dropping (would never succeed on retry)', {
    opId: op.opId, type: op.type, code: reply.failure.code, err: reply.failure.message,
  });
  return 'rejected';
}

/**
 * CLOUD box: send one task mutation to the primary. Never throws — the local
 * sqlite write already succeeded and the phone already has its 200; a failure
 * here degrades to the offline queue.
 */
export async function dispatchTaskOp(input: TaskOpInput): Promise<void> {
  if (!CLOUD_MODE) return;
  // Tombstone BEFORE the RPC: the projection import must never resurrect a
  // locally-deleted row, and the race window opens the moment the local
  // delete committed (the caller emits the bus event after its own write).
  if (input.type === 'delete') { recordDeleteTombstone(input.id); forgetCompanionBases([input.id]); }
  if (input.type === 'reorder' || input.type === 'reorder-pins') noteLocalOrderOp();
  const op = buildTaskOp(input);
  // From here until the Mac applied it, refused it, or it is queued, the task's base is
  // held (liveInFlight above). Taken at once: the local write already happened.
  const heldId = taskIdOf(op);
  if (heldId) holdLive(heldId);
  liveOps++;
  try {
    // An older op for the same task still queued goes first: the Mac applies them in
    // the order they were made (a newer edit ahead of an older one of the same field
    // would read as two writers), so this one joins the queue behind it.
    if (await queuedForSameTask(op)) {
      await enqueue(op);
      void flushTaskQueue();
      return;
    }
    // Records of this task still in the journal go first too: this one joins them, or
    // waits in the queue until the Mac took them (flushTaskQueue holds it).
    if (heldId && (await journaledTaskIds()).has(heldId)) {
      if (!(await journalOp(op))) await enqueue(op);
      return;
    }
    const outcome = await sendOp(op);
    if (outcome === 'applied') {
      // A successful RPC means the bridge is up — good moment to drain anything
      // that piled up during an earlier outage.
      void flushTaskQueue();
      return;
    }
    if (outcome === 'rejected') return;
    // The Mac did not answer: a field write it merges goes into the journal it drains.
    if (outcome === 'retry' && (await journalOp(op))) return;
    await enqueue(op);
    if (outcome === 'needs_upgrade') await writeLegacyOutboxFallback(op);
  } catch (err) {
    // Unexpected (module load, serialization) — never lose the op over it.
    log.task.error('task-queue: dispatch failed unexpectedly — queueing', {
      opId: op.opId, err: String(err),
    });
    await enqueue(op).catch(() => {});
  } finally {
    // Applied, refused, or queued (a queued op holds the task from its file).
    if (heldId) releaseLive(heldId);
    liveOps--;
  }
}

/**
 * Stage 3a (docs/plan/walnut-companion-unified-replica.md): an update whose fields the
 * Mac merges, made while it does not answer, is kept in the companion's journal
 * (companion-journal.ts) rather than this queue; the Mac drains it. False when the
 * queue keeps it: not such an update, a Mac that does not drain the kind yet, or a
 * journal that refused it. The op id is the record's, so a live send that did land
 * (a timeout, not a dead link) is applied once (the task's applied_ops key).
 */
async function journalOp(op: TaskOp): Promise<boolean> {
  if (op.type === 'create') return journalCreate(op);
  if (op.type !== 'update' || op.append || !op.fields || Object.keys(op.fields).length === 0) return false;
  try {
    const { journalTaskFields } = await import('./companion-journal.js');
    return journalTaskFields({ opId: op.opId, taskId: op.task.id, fields: op.fields })?.ok === true;
  } catch (err) {
    log.task.warn('task-queue: the journal did not take a task write, queueing it', { opId: op.opId, err: String(err) });
    return false;
  }
}

/** Where a create places its task (offline-host-core.ts task-create `placement`); the rest are its fields. */
const CREATE_PLACEMENT = new Set(['project', 'group_id', 'parent_task_id', 'focus_tier']);
/** Never sent with a create: the phase decides the status, the Mac keeps its own order and unread mark. */
const CREATE_SKIPPED = new Set(['status', 'pin_order', 'unread']);

/**
 * A task born here, as a host's `task-create` names it: the fields set on the row (a
 * born default, an empty value, the born TODO phase are left to the Mac's create), and
 * where it goes. Exported for the tests.
 */
export function createRecordOf(task: Task): { fields: Record<string, unknown>; placement: { parentTaskId?: string; project?: string; groupId?: string; tier?: string } } {
  const row = task as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = { title: task.title };
  for (const f of MERGEABLE) {
    if (f === 'title' || CREATE_PLACEMENT.has(f) || CREATE_SKIPPED.has(f)) continue;
    const v = row[f];
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) continue;
    if (f === 'phase' && v === 'TODO') continue;
    fields[f] = v;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  return {
    fields,
    placement: {
      project: typeof task.project === 'string' ? task.project : '',
      ...(str(task.group_id) ? { groupId: task.group_id } : {}),
      ...(str(task.parent_task_id) ? { parentTaskId: task.parent_task_id } : {}),
      ...(str(task.focus_tier) ? { tier: task.focus_tier } : {}),
    },
  };
}

/** Slice 3d: a task born here while the Mac does not answer goes into the journal as `task-create`. */
async function journalCreate(op: Extract<TaskOp, { type: 'create' }>): Promise<boolean> {
  try {
    const { journalTaskCreate } = await import('./companion-journal.js');
    return journalTaskCreate({ opId: op.opId, taskId: op.task.id, ...createRecordOf(op.task) })?.ok === true;
  } catch (err) {
    log.task.warn('task-queue: the journal did not take a new task, queueing it', { opId: op.opId, err: String(err) });
    return false;
  }
}

/** Tasks with records the Mac has not taken from the journal yet (their ops wait behind them). */
async function journaledTaskIds(): Promise<Set<string>> {
  try {
    return (await import('./companion-journal.js')).companionJournalTaskIds();
  } catch {
    return new Set();
  }
}

let flushing = false;
/** A flush was asked for while one ran: it runs again after (an op queued behind it). */
let flushAgain = false;
let flushSeq = 0;

/** The task an op writes (none for the order ops). */
function taskIdOf(op: TaskOp): string | undefined {
  if (op.type === 'create' || op.type === 'update') return op.task?.id;
  if (op.type === 'delete') return op.id;
  return undefined;
}

/** True when an op for the same task is still queued (the common empty queue costs one readdir). */
async function queuedForSameTask(op: TaskOp): Promise<boolean> {
  const id = taskIdOf(op);
  if (!id) return false;
  if ((await queuedTaskOpCount()) === 0) return false;
  return (await listQueuedOps()).some((q) => taskIdOf(q) === id);
}

/**
 * Sweep cache/task-queue/ oldest-first: RPC each op, delete on success, keep on
 * transport failure. Single-flight (the 60s timer and a fresh op can both call
 * it). Stops early on the first bridge-offline outcome — if the link is down,
 * the remaining 99 ops will fail identically.
 */
export async function flushTaskQueue(): Promise<number> {
  if (!CLOUD_MODE) return 0;
  if (flushing) { flushAgain = true; return 0; }
  flushing = true;
  flushAgain = false;
  let sent = 0;
  let stopped = false;
  // One name for the ops this sweep sends: the Mac merges them as one drain, one letter.
  const flush = `f${Date.now().toString(36)}-${(flushSeq++).toString(36)}`;
  try {
    let names: string[];
    try {
      names = (await fsp.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return 0; // no queue dir yet — nothing has ever failed
    }
    const journaled = names.length ? await journaledTaskIds() : new Set<string>();
    for (const name of names.slice(0, FLUSH_BATCH_MAX)) {
      const file = path.join(TASK_QUEUE_DIR, name);
      let op: TaskOp;
      try {
        op = JSON.parse(await fsp.readFile(file, 'utf-8')) as TaskOp;
        if (!op || !op.opId || !op.type) throw new Error('malformed op');
      } catch (err) {
        // Unreadable/garbage — drop it, never wedge the queue behind it.
        log.task.warn('task-queue: unreadable queued op — removing', { file, err: String(err) });
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      // Its task's journal records are older: the Mac takes those first (the ack flushes again).
      const opTask = taskIdOf(op);
      if (opTask && journaled.has(opTask)) continue;
      const outcome = await sendOp(op, flush);
      if (outcome !== 'applied' && outcome !== 'rejected') stopped = true;
      if (outcome === 'retry') break; // bridge down — the rest would fail too
      // The primary's store is struggling (lock timeout / EIO). Keep the file
      // and stop the sweep: the remaining ops would contend for the same lock
      // and make it worse. The next sweep retries from here.
      if (outcome === 'primary_error') break;
      if (outcome === 'needs_upgrade') {
        // Keep the queue copy for the post-upgrade convergence, but make sure
        // the legacy lane carries it now.
        await writeLegacyOutboxFallback(op);
        break; // an old primary rejects every op — no point continuing
      }
      await fsp.rm(file, { force: true }).catch(() => {});
      sent++;
    }
    if (sent > 0) log.task.info('task-queue: flushed queued ops', { sent, queued: names.length });
    return sent;
  } finally {
    flushing = false;
    // An op queued behind this sweep (dispatchTaskOp's same-task rule) goes now, not in 60s.
    if (flushAgain && !stopped) { flushAgain = false; void flushTaskQueue(); }
  }
}

/** Pending queued ops (diagnostics/tests). */
export async function queuedTaskOpCount(): Promise<number> {
  try {
    return (await fsp.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

/** Read the queued ops (oldest-first). Used by the projection import to skip
 *  rows with an undelivered local write — same role listPendingOps plays for
 *  the legacy git outbox. Unreadable files are left alone here (the flush
 *  sweep owns removal). */
export async function listQueuedOps(): Promise<TaskOp[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(TASK_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: TaskOp[] = [];
  for (const name of names) {
    try {
      const op = JSON.parse(await fsp.readFile(path.join(TASK_QUEUE_DIR, name), 'utf-8')) as TaskOp;
      if (op && op.opId && op.type) out.push(op);
    } catch { /* flush sweep drops it */ }
  }
  return out;
}

// ── Delete tombstones ────────────────────────────────────────────────────────
// The projection import is upsert-only, so a projection frame BUILT before the
// primary applied a replica-side delete but ARRIVING after the queue drained
// would resurrect the deleted row (the pending-op guard no longer covers it).
// A short-lived tombstone bridges that window; the next projection the primary
// exports post-delete no longer contains the row, so a TTL is enough.

const TOMBSTONE_TTL_MS = 15 * 60_000;
const deleteTombstones = new Map<string, number>();

/** When the replica last dispatched an order op ('reorder'/'reorder-pins').
 *  The projection import's order-alignment must stand down for a while after
 *  one: a projection frame built BEFORE the primary applied the reorder would
 *  otherwise re-impose the old order (the projection-lag echo family). */
let lastOrderOpAt = 0;

export function noteLocalOrderOp(): void {
  lastOrderOpAt = Date.now();
}

export function hasRecentOrderOp(ttlMs = TOMBSTONE_TTL_MS): boolean {
  return Date.now() - lastOrderOpAt < ttlMs;
}

export function recordDeleteTombstone(id: string): void {
  const now = Date.now();
  deleteTombstones.set(id, now);
  // Opportunistic sweep — the map only grows while deletes happen.
  for (const [k, at] of deleteTombstones) {
    if (now - at > TOMBSTONE_TTL_MS) deleteTombstones.delete(k);
  }
}

export function hasDeleteTombstone(id: string): boolean {
  const at = deleteTombstones.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > TOMBSTONE_TTL_MS) {
    deleteTombstones.delete(id);
    return false;
  }
  return true;
}

/** Tests only. */
export function _resetDeleteTombstonesForTesting(): void {
  deleteTombstones.clear();
}

/**
 * CLOUD box: start the three drain triggers, fastest first.
 *   1. The primary's bridge (re)connects — the whole banked outage drains within
 *      a round trip. bridge-registry fires this from registerBridge() through
 *      the setPrimaryBridgeConnectedHandler callback seam (the same shape as its
 *      mobile-event sink, so transport never imports core/).
 *   2. Any successful dispatch (inside dispatchTaskOp) — covers the case where
 *      the socket was already up while individual RPCs were failing.
 *   3. This 60s interval — the floor for a quiet box. Unref'd: never holds the
 *      process open.
 */
export function startTaskQueueFlush(): { stop: () => void } {
  const timer = setInterval(() => { void flushTaskQueue(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  let unhook: (() => void) | null = null;
  void (async () => {
    try {
      const { setPrimaryBridgeConnectedHandler } = await import('../web/ws/bridge-registry.js');
      setPrimaryBridgeConnectedHandler(() => {
        log.task.info('task-queue: primary bridge connected — draining queued ops');
        void flushTaskQueue();
      });
      unhook = () => setPrimaryBridgeConnectedHandler(null);
    } catch (err) {
      // Non-fatal: triggers 2 and 3 still drain the queue.
      log.task.warn('task-queue: could not hook the bridge-connected trigger', { err: String(err) });
    }
  })();
  return {
    stop: () => {
      clearInterval(timer);
      unhook?.();
    },
  };
}
