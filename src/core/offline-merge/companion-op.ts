/**
 * The companion's queued task writes, merged by field on the Mac
 * (docs/plan/walnut-replica-servers-impl.md section 7 and WP13; the companion's
 * queue is src/core/task-queue.ts, kept by C3).
 *
 * An update op from the companion now carries `fields`: for each field it set,
 * `{base, value, at}` (what the companion's row held before the write, what it
 * wrote, and when, on the companion's clock). The Mac applies it with the same
 * per-field merge a host journal record gets (apply-fields.ts), stamping
 * `field_at` with the write's own time shifted by the companion's measured clock
 * offset, so a field edited through the companion and through a host journal
 * ends the same whichever drains first (R6b).
 *
 * It replaces the whole-row gate of task-outbox.ts applyTaskOp
 * (`snapshot.updated_at <= existing.updated_at` = stale) for these ops: since
 * WP9 a drained host record moves `updated_at` to the drain's clock, so the gate
 * dropped a phone edit queued away for the same task, even on another field.
 * An append-style note (POST /tasks/:id/notes) is concatenated onto the Mac's
 * note under the row lock, once per op (the task's applied_ops key), never gated.
 * Delete wins: a write to a task the Mac deleted is dropped and listed.
 * An op without `fields` (an older companion, an old queue file) takes the old
 * path unchanged.
 *
 * One letter per drain (section 7): the ops of one queue flush share one drain
 * log (the companion names its flush), live ops share one per burst, and the
 * letter goes when no op came for CLOSE_OUT_MS.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { TaskOp } from '../task-outbox.js';
import type { FieldWrite } from './task-fields.js';
import type { ConflictLog } from './conflict-log.js';

/** The host key a companion op is remembered and lettered by. */
export const COMPANION_HOST_KEY = 'companion';

/** At most this many fields in one op (the queueable list is about twenty). */
const MAX_FIELDS = 40;

/**
 * The `fields` of a received op, checked: an object of field names to
 * `{base, value, at}` with a finite `at`. Anything else is dropped whole (the op
 * then takes the old path), never half-applied.
 */
export function parseCompanionFields(raw: unknown): Record<string, FieldWrite> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FIELDS) return undefined;
  const out: Record<string, FieldWrite> = {};
  for (const [field, w] of entries) {
    if (!/^[a-z_]{1,40}$/.test(field) || !w || typeof w !== 'object' || Array.isArray(w)) return undefined;
    const { base, value, at } = w as { base?: unknown; value?: unknown; at?: unknown };
    if (!('value' in (w as object)) || !('base' in (w as object))) return undefined;
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
    out[field] = { base, value, at };
  }
  return out;
}

// ── The companion's clock ──

/** A companion op's own clock reading (`sentAt`) at most this old or new is a measurement. */
const CLOCK_SAMPLE_MAX_MS = 24 * 60 * 60_000;
/** A tighter reading is kept this long (a reading is the offset plus the one-way trip). */
const CLOCK_KEEP_MS = 5 * 60_000;
let clock: { offsetMs: number; at: number } | null = null;

/**
 * One reading of the companion's clock: it stamped `sentAt` when it sent the op,
 * this server received it at `receivedAt`. The trip only adds, so the smallest
 * recent reading is the closest; an older one is replaced.
 */
export function measureCompanionClock(sentAt: unknown, receivedAt = Date.now()): void {
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt) || Math.abs(receivedAt - sentAt) > CLOCK_SAMPLE_MAX_MS) return;
  const offsetMs = Math.round(receivedAt - sentAt);
  if (clock && receivedAt - clock.at < CLOCK_KEEP_MS && clock.offsetMs <= offsetMs) return;
  clock = { offsetMs, at: receivedAt };
}

/** Add to a companion time to get this server's time (0 when never measured). */
export function companionClockOffset(): number {
  return clock?.offsetMs ?? 0;
}

/** Tests only. */
export function _setCompanionClockForTesting(offsetMs: number | null): void {
  clock = offsetMs === null ? null : { offsetMs, at: Date.now() };
}

// ── One drain log per flush ──

/** A drain's letter goes when no op came for this long. */
const CLOSE_OUT_MS = 3_000;
/** A burst that never pauses is still lettered at least this often. */
const DRAIN_MAX_MS = 60_000;
const SAFE_FLUSH_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface OpenDrain {
  log: ConflictLog;
  timer: ReturnType<typeof setTimeout> | null;
  startedAt: number;
  /** Ops applying in it now: it never closes under one. */
  active: number;
  /** Out of the map (too old, or closed): letters when its last op ends. */
  closing: boolean;
}
const drains = new Map<string, OpenDrain>();

async function modules() {
  const [applyFields, conflictLog, letters, patchCheck, taskFields] = await Promise.all([
    import('./apply-fields.js'), import('./conflict-log.js'), import('./letter.js'), import('./patch-check.js'), import('./task-fields.js'),
  ]);
  return { ...applyFields, ...conflictLog, ...letters, ...patchCheck, ...taskFields };
}

/** The drain an op belongs to (its flush's, else the live burst's), opened on first use; release it after. */
async function enterDrain(flush: string | undefined): Promise<{ key: string; drain: OpenDrain }> {
  const m = await modules();
  const key = flush && SAFE_FLUSH_RE.test(flush) ? `flush:${flush}` : 'live';
  let drain = drains.get(key);
  if (drain && Date.now() - drain.startedAt > DRAIN_MAX_MS) {
    drains.delete(key);
    retire(drain);
    drain = undefined;
  }
  if (!drain) {
    drain = { log: new m.ConflictLog(COMPANION_HOST_KEY, WALNUT_HOME), timer: null, startedAt: Date.now(), active: 0, closing: false };
    m.openDrainLog(drain.log.drainId);
    drains.set(key, drain);
  }
  if (drain.timer) { clearTimeout(drain.timer); drain.timer = null; }
  drain.active++;
  return { key, drain };
}

/** The op is done: the drain letters when no other op comes for CLOSE_OUT_MS. */
function releaseDrain(key: string, drain: OpenDrain): void {
  drain.active = Math.max(0, drain.active - 1);
  if (drain.active > 0) return;
  if (drain.closing) { void finish(drain); return; }
  if (drain.timer) clearTimeout(drain.timer);
  drain.timer = setTimeout(() => {
    if (drains.get(key) !== drain || drain.active > 0) return;
    drains.delete(key);
    retire(drain);
  }, CLOSE_OUT_MS);
  drain.timer.unref?.();
}

function retire(drain: OpenDrain): void {
  drain.closing = true;
  if (drain.timer) { clearTimeout(drain.timer); drain.timer = null; }
  if (drain.active === 0) void finish(drain);
}

/** The drain's letter (none for a clean one), then it is no longer open. Never throws. */
async function finish(drain: OpenDrain): Promise<void> {
  const m = await modules();
  try {
    if (drain.log.entries.length > 0) await m.sendConflictLetter(drain.log).catch(() => false);
  } finally {
    m.closeDrainLog(drain.log.drainId);
  }
}

/** Close every open drain now (tests; a shutdown): each letters at once, or when its op ends. */
export async function closeCompanionDrains(): Promise<void> {
  const open = [...drains.values()];
  drains.clear();
  for (const d of open) {
    d.closing = true;
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    if (d.active === 0) await finish(d);
  }
}

/** Tests only: how many drains are open. */
export function _openCompanionDrainsForTesting(): number {
  return drains.size;
}

// ── Applying one op ──

/** No real write is older (field times before this are refused, never stamped). */
const EARLIEST_MS = Date.UTC(2000, 0, 1);
/** A time further than this past its own op (or past now, shifted) is no clock's: refused. */
const AHEAD_MAX_MS = 24 * 60 * 60_000;

export type CompanionApplyResult = { applied: boolean; reason: 'updated' | 'unchanged' | 'missing' | 'refused'; conflicts: number };

type UpdateOp = Extract<TaskOp, { type: 'update' }>;

/**
 * The op's times on this server's clock, or a refusal. Each time is shifted by the
 * companion's measured offset. One no clock could hold (before 2000, or a day past
 * its own op or past now) is refused: it would throw in toISOString and wedge the op
 * in a retry loop. One a little ahead of now (a skew the offset missed, a Mac time the
 * copy carried) is held at now, so no field written here is unbeatable.
 */
function opTimes(
  op: UpdateOp, fields: Record<string, FieldWrite>, offset: number, now: number,
): { at: number; fields: Record<string, FieldWrite> } | { refused: string } {
  const own = Date.parse(op.at);
  if (!Number.isFinite(own)) return { refused: `the op's time ${JSON.stringify(op.at)} is not a time` };
  if (own + offset < EARLIEST_MS || own + offset > now + AHEAD_MAX_MS) return { refused: `the op's time ${op.at} is outside what this Mac accepts` };
  const out: Record<string, FieldWrite> = {};
  for (const [f, w] of Object.entries(fields)) {
    const t = typeof w.at === 'number' ? w.at : NaN;
    if (!Number.isFinite(t) || t + offset < EARLIEST_MS || t > own + AHEAD_MAX_MS) return { refused: `the time of ${f} is outside what this Mac accepts` };
    out[f] = { ...w, at: Math.min(t, now - offset) };
  }
  return { at: Math.min(own + offset, now), fields: out };
}

/**
 * Apply one companion update op by field. Throws only what the batch would retry
 * (a store failure); a refusal of the Mac (RefusedWrite) is consumed and lettered.
 */
export async function applyCompanionFields(op: UpdateOp, raw: Record<string, FieldWrite>): Promise<CompanionApplyResult> {
  const m = await modules();
  const { key, drain } = await enterDrain(op.flush);
  const conflicts = drain.log;
  const before = conflicts.entries.length;
  const taskId = op.task.id;
  try {
    const offset = companionClockOffset();
    const times = opTimes(op, raw, offset, Date.now());
    if ('refused' in times) throw new m.RefusedWrite(times.refused);
    const fields = times.fields;
    const bad = m.unqueueableFields(fields);
    if (bad.length) throw new m.RefusedWrite(`the companion wrote fields the Mac does not merge: ${bad.join(', ')}`);
    const record = { seq: 0, at: times.at, kind: 'task-fields', opId: op.opId, rev: 1, op: 'task_update', taskId, fields };
    const ctx = { hostKey: COMPANION_HOST_KEY, at: times.at, offset, conflicts, remap: new Map<string, string>(), result: { replayed: 0, skipped: 0 } };
    const noteAt = typeof fields.note?.at === 'number' ? fields.note.at + offset : times.at;
    const outcome = op.append?.note
      ? await appendNote(op, noteAt, m.opKeyOf(ctx, record)!)
      : await m.applyFields(ctx as never, record as never, taskId, fields, m.opKeyOf(ctx, record));
    // Delete wins: a task the Mac deleted drops the write, listed as a host drain lists it.
    if (outcome === 'gone') conflicts.add({ seq: 0, opId: op.opId, recordKind: 'task-fields', kind: 'task-deleted', taskId, replica: fields });
    conflicts.flush();
    const n = conflicts.entries.length - before;
    log.task.info('task-op: companion fields merged', { id: taskId, opId: op.opId, outcome, fields: Object.keys(fields), conflicts: n, drainId: conflicts.drainId });
    return { applied: outcome === 'applied', reason: outcome === 'applied' ? 'updated' : outcome === 'gone' ? 'missing' : 'unchanged', conflicts: n };
  } catch (err) {
    if (!(err instanceof m.RefusedWrite)) throw err;
    log.task.warn('task-op: companion write refused by the Mac', { id: taskId, opId: op.opId, error: err.message });
    conflicts.add({ seq: 0, opId: op.opId, recordKind: 'task-fields', kind: 'refused', taskId, reason: err.message });
    try { conflicts.flush(); } catch { /* kept for the letter in memory */ }
    return { applied: false, reason: 'refused', conflicts: conflicts.entries.length - before };
  } finally {
    releaseDrain(key, drain);
  }
}

/**
 * An append-style note (POST /tasks/:id/notes on the companion): the entry goes on
 * the end of the Mac's note as it is now, never gated by the row's updated_at (a
 * drained host record moves that to the drain's clock), once per op (the task's
 * applied_ops key, so a replay after the opId set forgot it still applies once).
 * The note's time moves to the later of the Mac's and the append's, as a clean text
 * merge stamps it, so a host write to the note ends the same in either drain order.
 */
async function appendNote(op: UpdateOp, writtenAt: number, opKey: string): Promise<'applied' | 'skipped' | 'gone'> {
  const tm = await import('../task-manager.js');
  const { exactTask, withOp } = await import('./apply-fields.js');
  const { RefusedWrite } = await import('./patch-check.js');
  const { frozenFieldTimes } = await import('../task-field-times.js');
  const entry = op.append!.note!;
  const taskId = op.task.id;
  if (!(await exactTask(taskId))) return 'gone';
  // A row gone by the lock leaves 'gone' (updateTaskRaw writes nothing for it).
  const st: { outcome: 'applied' | 'skipped' | 'gone' } = { outcome: 'gone' };
  const stamp: { at: string; fields: Record<string, string> } = { at: new Date().toISOString(), fields: {} };
  await tm.updateTaskRaw(taskId, (cur) => {
    if (cur.applied_ops?.includes(opKey)) { st.outcome = 'skipped'; return null; }
    try {
      tm.runPluginContentValidation(cur as never, 'note', entry);
    } catch (err) {
      throw new RefusedWrite(`${err instanceof Error ? err.message : String(err)}; the note was not added`);
    }
    const macAt = Date.parse(cur.field_at?.note ?? '') || Date.parse(cur.updated_at ?? '') || 0;
    stamp.fields.note = new Date(Math.max(macAt, writtenAt)).toISOString();
    const frozen = frozenFieldTimes(cur as never);
    st.outcome = 'applied';
    return {
      note: cur.note ? `${cur.note}\n\n${entry}` : entry,
      updated_at: new Date().toISOString(),
      applied_ops: withOp(cur as never, opKey),
      ...(frozen ? { field_at: frozen } : {}),
    } as never;
  }, {
    get emitEvent() { return st.outcome === 'applied'; },
    get push() { return st.outcome === 'applied'; },
    source: 'cloud-outbox',
    // Read after the callback: the note at its own time, what the events write at now.
    fieldTimes: stamp,
  });
  if (st.outcome === 'applied') log.task.info('task-op: companion note appended', { id: taskId, opId: op.opId });
  return st.outcome;
}
