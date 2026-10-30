/**
 * One queued field write applied to one task on the Mac (docs/plan/walnut-replica-servers-impl.md
 * section 7), shared by `task-fields` and the fields a `task-create` sets after the row exists.
 *
 * The merge is resolved INSIDE the task store's write lock, against the row as it is at
 * that moment (`updateTaskRaw`'s function form), never against a row read earlier: two
 * hosts drain at once (every daemon reconnects when the Mac wakes) and the user keeps
 * editing during a drain, and a whole-field value computed from a stale row would undo
 * the other write without a word.
 *
 * Order inside the lock: resolve, check like the online PATCH (patch-check.ts), make the
 * conflict entries durable, then write ONE row with the op key merged in. The entries are
 * on disk before the row that makes a redrain skip the record, so a failed log write
 * leaves nothing applied, and a failed row write takes its entries back (both retry).
 */

import { log } from '../../logging/index.js';
import { WALNUT_HOME } from '../../constants.js';
import { READ_MARKER_KEYS, type Task, type TaskPhase, type TaskStatus } from '../types.js';
import { deriveStatusFromPhase, phaseDerivedFields, phaseFromStatus } from '../phase.js';
import type { ConflictEntry } from './conflict-log.js';
import { applyPinFields, hasPinFields } from './pin-fields.js';
import { premergeTexts, resolveTaskFields, type FieldWrite } from './task-fields.js';
import { RefusedWrite, checkResolvedPatch, normalizeQueuedFields } from './patch-check.js';
import { lookupRemap } from './ledger.js';
import { frozenFieldTimes } from '../task-field-times.js';
import type { JournalActorLike, V2Context, V2Record } from './apply-v2.js';

/** The id a host's record names, after a re-mint this Mac made for that host's create. */
export function resolveTaskId(hostKey: string, id: string, remap?: Map<string, string>): string {
  const cached = remap?.get(id);
  if (cached) return cached;
  const durable = lookupRemap(hostKey, WALNUT_HOME, id);
  if (durable) remap?.set(id, durable);
  return durable ?? id;
}

/**
 * A write's task ids, the ones its VALUES name (parent_task_id, depends_on), through the
 * same remap as the record's own task: a later record linking to an away create whose id
 * was re-minted (a collision) or taken over (createdAs) links to the task that create made.
 */
export function remapIdFields(ctx: Pick<V2Context, 'hostKey' | 'remap'>, fields: Record<string, FieldWrite>): Record<string, FieldWrite> {
  const one = (v: unknown): unknown => (typeof v === 'string' && v && v !== 'unknown' ? resolveTaskId(ctx.hostKey, v, ctx.remap) : v);
  const list = (v: unknown): unknown => (Array.isArray(v) ? v.map(one) : v);
  const out = { ...fields };
  const p = out.parent_task_id;
  if (p) out.parent_task_id = { ...p, base: one(p.base), value: one(p.value) };
  const d = out.depends_on;
  if (d) out.depends_on = { ...d, base: list(d.base), value: list(d.value) };
  return out;
}

/** The task with exactly this id, or null (getTask also matches prefixes). */
export async function exactTask(id: string): Promise<Task | null> {
  const { getTask } = await import('../task-manager.js');
  const t = await getTask(id).catch(() => null);
  return t && t.id === id ? t : null;
}

export async function pairValidator(): Promise<(project: string, groupId: string) => boolean> {
  const { listGroups } = await import('../task-manager.js');
  const folders = await listGroups().catch(() => []);
  const byId = new Map(folders.map((f) => [f.group_id, f.project]));
  return (project, groupId) => {
    if (!groupId) return true;
    const owner = byId.get(groupId);
    return owner !== undefined && owner.toLowerCase() === project.toLowerCase();
  };
}

/**
 * Why a parent link cannot be applied, or null: the parent exists, is not the task or
 * one of its descendants, and (for a session actor) the depth brake holds.
 */
export async function parentRefusal(taskId: string, parentId: string, actor: JournalActorLike | undefined): Promise<string | null> {
  if (!parentId) return null;
  if (parentId === taskId) return 'a task cannot be its own parent';
  const parent = await exactTask(parentId);
  if (!parent) return `the parent task ${parentId} no longer exists`;
  let cur: Task | null = parent;
  for (let i = 0; cur && i < 64; i++) {
    if (cur.parent_task_id === taskId) return 'the parent is one of the task\'s own subtasks';
    cur = cur.parent_task_id ? await exactTask(cur.parent_task_id) : null;
  }
  if (actor?.kind === 'session') {
    // The online PATCH's brake (api-v1.ts assertAdoptionDepth): the parent's depth, one
    // level for the task, and every level of subtasks the task already carries.
    const { assertAdoptionDepth, SubtaskLimitError } = await import('../sessions/subtask-limits.js');
    try {
      await assertAdoptionDepth(parentId, taskId, { parentTitle: parent.title });
    } catch (err) {
      if (err instanceof SubtaskLimitError) return err.message;
      throw err;
    }
  }
  return null;
}

/** Stored-value form of a patch: '' clears a payload field (null is the explicit-clear marker). */
export function storedPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v === '' && (k === 'group_id' || k === 'parent_task_id' || k.endsWith('_date') || k === 'wait_until' || k === 'sprint') ? null : v;
  }
  return out;
}

/** How many merged op keys a task keeps (a replay comes within one drain of its apply). */
const APPLIED_OPS_KEEP = 32;

/** The key a record's merge is remembered by on its task. */
export function opKeyOf(ctx: Pick<V2Context, 'hostKey'>, record: V2Record): string | undefined {
  return record.opId ? `${ctx.hostKey}|${record.opId}|${record.rev ?? 1}` : undefined;
}

export function withOp(task: Readonly<Task>, key: string): string[] {
  return [...(task.applied_ops ?? []).filter((k) => k !== key), key].slice(-APPLIED_OPS_KEEP);
}

export function entryBase(record: V2Record): { seq: number; opId?: string; recordKind: string; actor?: unknown } {
  return { seq: record.seq, ...(record.opId ? { opId: record.opId } : {}), recordKind: record.kind, ...(record.actor ? { actor: record.actor } : {}) };
}

/**
 * The project a write moves the task to, settled the way updateTask settles it, before
 * the lock (the registry write is its own): a new name gets its registry row, a renamed
 * one follows the rename, and a move the Mac would not make here (a deleted project; a
 * synced task into a project of another source, which online migrates the task) drops
 * the pair from the write and lists it. Returns the fields to merge and the entries.
 */
async function settleProject(
  task: Task, fields: Record<string, FieldWrite>, project: string, record: V2Record,
): Promise<{ fields: Record<string, FieldWrite>; entries: ConflictEntry[]; name?: string }> {
  const tm = await import('../task-manager.js');
  let ensured: Awaited<ReturnType<typeof tm.ensureProject>>;
  try {
    ensured = await tm.ensureProject(project, task.source, { writer: 'offline-handover' });
  } catch (err) {
    throw new RefusedWrite(`project ${project}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const drop = (reason: string): { fields: Record<string, FieldWrite>; entries: ConflictEntry[] } => {
    const { project: _p, group_id: _g, ...rest } = fields;
    return { fields: rest, entries: [{ ...entryBase(record), kind: 'refused', taskId: task.id, field: 'project', mac: task.project ?? '', replica: project, reason }] };
  };
  if (ensured.blocked) return drop(`the project ${project} was deleted on the Mac; the task stays in ${task.project || 'Inbox'}`);
  // A session moving a worker out of its lead's project, as online (caller-placement.ts);
  // a queued write never carries the user's words, so only the lead's own projects pass.
  if (record.actor?.kind === 'session') {
    const { workerMoveRefusal, resolveCallerPlacement } = await import('../sessions/caller-placement.js');
    const parent = fields.parent_task_id && typeof fields.parent_task_id.value === 'string' ? fields.parent_task_id.value : undefined;
    const caller = await resolveCallerPlacement(record.actor.sid).catch(() => ({ kind: 'unknown' as const }));
    const why = await workerMoveRefusal({
      task, project: ensured.name, caller, ...(parent !== undefined ? { parentTaskId: parent } : {}),
    });
    if (why) return drop(`${why} This move was made while the Walnut server was away; the task stays in ${task.project || 'Inbox'}.`);
  }
  if (ensured.source !== task.source && task.source !== 'local') {
    return drop(`moving this task into ${ensured.name} changes where it syncs, which needs the Mac to answer; the task stays in ${task.project || 'Inbox'}`);
  }
  if (ensured.name !== project && fields.project) return { fields: { ...fields, project: { ...fields.project, value: ensured.name } }, entries: [], name: ensured.name };
  return { fields, entries: [], name: ensured.name };
}

export type FieldsOutcome = 'applied' | 'skipped' | 'gone';

/** How often a write whose project or merged text moved between the read and the lock is settled again. */
const SETTLE_TRIES = 3;

/**
 * Merge `fields` (one record's write) into task `taskId`, idempotent by `opKey`.
 * 'gone': the task does not exist (the caller lists the delete). Throws RefusedWrite
 * for the Mac's refusals; anything else thrown is retried by the batch.
 */
export async function applyFields(
  ctx: V2Context, record: V2Record, taskId: string, rawFields: Record<string, FieldWrite>, opKey: string | undefined,
): Promise<FieldsOutcome> {
  for (let i = 1; ; i++) {
    const outcome = await applyFieldsOnce(ctx, record, taskId, rawFields, opKey);
    if (outcome !== 'resettle') return outcome;
    // A Mac edit between the read and the lock changed where the write moves the task
    // (the project written must be the one settleProject checked: its registry row, a
    // tombstone, the sync source), or a text the write merges: settled again against the new row.
    if (i >= SETTLE_TRIES) throw new Error(`task ${taskId} kept changing while its queued write was applied`);
  }
}

async function applyFieldsOnce(
  ctx: V2Context, record: V2Record, taskId: string, rawFields: Record<string, FieldWrite>, opKey: string | undefined,
): Promise<FieldsOutcome | 'resettle'> {
  const pre = await exactTask(taskId);
  if (!pre) return 'gone';
  if (opKey && pre.applied_ops?.includes(opKey)) return 'skipped';
  const fieldAt = (w: FieldWrite): number => (typeof w.at === 'number' && Number.isFinite(w.at) ? w.at + ctx.offset : ctx.at);
  let fields = await normalizeQueuedFields(remapIdFields(ctx, rawFields), fieldAt);
  const pairValid = await pairValidator();
  const extra: ConflictEntry[] = [];
  // The text merges, made once and off the event loop against the row read here; the
  // lock reuses them while the Mac's text is unchanged (else the write is resolved again).
  const textMerges = await premergeTexts(pre as never, fields);
  // The project, settled before the lock when this write would move the task.
  const guess = resolveTaskFields({ mac: pre as never, fields, at: ctx.at, offset: ctx.offset, pairValid, textMerges });
  let settledName: string | undefined;
  if (typeof guess.patch.project === 'string' && guess.patch.project) {
    const settled = await settleProject(pre, fields, guess.patch.project, record);
    fields = settled.fields;
    extra.push(...settled.entries);
    settledName = settled.entries.length ? undefined : settled.name;
  }
  const parentValue = fields.parent_task_id && typeof fields.parent_task_id.value === 'string' ? fields.parent_task_id.value : '';
  const parentWhy = parentValue ? await parentRefusal(taskId, parentValue, record.actor) : null;
  const tm = await import('../task-manager.js');
  const customTiers = fields.focus_tier ? (await tm.getCustomTiers()).map((t) => t.id) : [];
  // A new pin goes after every pinned task, as setPinTierBulk places it.
  const nextPinOrder = hasPinFields(fields)
    ? (await tm.getPinnedTasks()).reduce((max, t) => Math.max(max, t.pin_order ?? 0), -1) + 1
    : 0;
  const brake = record.actor?.kind === 'session' ? await import('../sessions/task-title-brake.js') : null;

  // Set inside the lock callback (an object: a closure write does not narrow a local).
  // titleCut: a session's long title this write cut to its head, refined after the write as online.
  const st: { outcome: FieldsOutcome | 'resettle'; titleCut?: { cut: string; from: string } } = { outcome: 'gone' };
  let pinChanged = false;
  let committed: ConflictEntry[] = [];
  let written: string[] = [];
  let conflictCount = 0;
  const fieldIso: Record<string, string> = {};
  try {
    await tm.updateTaskRaw(taskId, (cur) => {
      if (opKey && cur.applied_ops?.includes(opKey)) { st.outcome = 'skipped'; return null; }
      const res = resolveTaskFields({ mac: cur as never, fields, at: ctx.at, offset: ctx.offset, pairValid, textMerges });
      // A Mac edit since the read moved a text this write merges: never a diff in the lock.
      if (res.staleText?.length) { st.outcome = 'resettle'; return null; }
      const moving = typeof res.patch.project === 'string' && res.patch.project ? res.patch.project : undefined;
      if (moving !== undefined && moving !== settledName) { st.outcome = 'resettle'; return null; }
      const entries: ConflictEntry[] = [...extra, ...res.conflicts.map((c): ConflictEntry => ({
        ...entryBase(record), kind: 'task-field', taskId, field: c.field, base: c.base, mac: c.mac, replica: c.replica,
        kept: c.kept, why: c.why, macAt: c.macAt, replicaAt: c.replicaAt,
      }))];
      if (typeof res.patch.parent_task_id === 'string' && res.patch.parent_task_id && parentWhy) {
        entries.push({ ...entryBase(record), kind: 'parent-refused', taskId, field: 'parent_task_id', mac: cur.parent_task_id ?? '', replica: res.patch.parent_task_id, reason: parentWhy });
        delete res.patch.parent_task_id;
        delete res.fieldTimes.parent_task_id;
      }
      const stored = storedPatch(res.patch);
      st.titleCut = undefined;
      if (brake && typeof stored.title === 'string' && brake.needsShortening(stored.title)) {
        const from = stored.title;
        stored.title = brake.heuristicShortTitle(from);
        st.titleCut = { cut: stored.title as string, from };
      }
      // The main agent's task never parks (org/main-stays-active.ts), also from a replayed write.
      if (stored.phase === 'WAITING' && cur.org_role === 'main') { delete stored.phase; delete stored.wait_until; }
      const asked = Object.keys(stored);
      const toPhase = phaseWritten(cur as Task, stored);
      // The pin fields become the online pin write's row fields (pin-fields.ts), refused before anything lands.
      pinChanged = applyPinFields(cur as Task, stored, { customTiers, nextPinOrder, completing: toPhase === 'COMPLETE' });
      checkResolvedPatch(cur as Task, stored, { customTiers, validateContent: tm.runPluginContentValidation });
      if (Array.isArray(stored.depends_on) && stored.depends_on.length) {
        stored.depends_on = [...new Set(stored.depends_on as string[])];
        try {
          // The online checks (no self, every target exists, no cycle) against the rows read
          // here, in the lock: an online write made since the record was read is seen.
          tm.checkDependencyWrite(tm.readDependencyStoreSync(), taskId, stored.depends_on as string[]);
        } catch (err) {
          throw new RefusedWrite(`${err instanceof Error ? err.message : String(err)}; nothing of this write was applied`);
        }
      }
      // A field the check dropped (a stray wait clock) is not written, and its time does not move.
      for (const f of asked) if (!(f in stored)) delete res.fieldTimes[f];
      // Only a field the write changes is stamped; the pair's halves share their time.
      for (const f of Object.keys(res.fieldTimes)) fieldIso[f] = new Date(res.fieldTimes[f]).toISOString();
      conflictCount = entries.length;
      if (Object.keys(stored).length === 0) {
        // Nothing to change; a later equal write still moves the field's time (task-fields.ts).
        const later = Object.entries(res.fieldTimes).filter(([f, t]) => t > (Date.parse(cur.field_at?.[f] ?? '') || 0));
        st.outcome = 'skipped';
        if (!later.length && !entries.length) return null;
        const field_at = { ...(cur.field_at ?? {}) };
        for (const [f, t] of later) field_at[f] = new Date(t).toISOString();
        ctx.conflicts.addDurable(entries);
        committed = entries;
        return { field_at, ...(opKey ? { applied_ops: withOp(cur, opKey) } : {}) } as Partial<Task>;
      }
      // A field this write left equal but wrote later than the Mac moves its time too, in
      // the same row write (the stamp below only times fields whose value changes).
      const bumped = Object.entries(res.fieldTimes).filter(([f, t]) => !(f in stored) && t > (Date.parse(cur.field_at?.[f] ?? '') || 0));
      if (bumped.length) {
        const field_at = { ...(cur.field_at ?? {}) };
        for (const [f, t] of bumped) field_at[f] = new Date(t).toISOString();
        stored.field_at = field_at;
      }
      if (toPhase) {
        // What applyPhase derives online (phase.ts phaseDerivedFields): the read marker
        // (unless the record sets it), completed_at at the record's time, the session slots.
        const derived = phaseDerivedFields(cur, toPhase, new Date(ctx.at).toISOString());
        for (const [f, v] of Object.entries(derived.set)) if (!(f in stored)) stored[f] = v;
        for (const f of derived.clear) if (!(f in stored) && cur[f] !== undefined) stored[f] = null;
      }
      // The drain's own clock, as the online write moves it (updateTask): every reader that
      // judges a row by updated_at (the companion's projection import, recency lists) sees
      // the away edit. A write of the read marker alone leaves it, as online.
      if (Object.keys(stored).some((f) => f !== 'field_at' && !READ_MARKER_KEYS.includes(f))) {
        stored.updated_at = new Date().toISOString();
        // In the same row write, every field without a time of its own is frozen at the
        // old fallback: a later base-unknown write on it must never lose to this clock.
        const frozen = frozenFieldTimes(cur as Task);
        if (frozen) stored.field_at = { ...frozen, ...((stored.field_at as Record<string, string> | undefined) ?? {}) };
      }
      if (opKey) stored.applied_ops = withOp(cur, opKey);
      ctx.conflicts.addDurable(entries);
      committed = entries;
      written = Object.keys(res.patch).filter((f) => f in stored);
      st.outcome = 'applied';
      return stored as Partial<Task>;
    }, {
      // Read after the write (getters): a write that only moved field times tells no one.
      get emitEvent() { return st.outcome === 'applied'; },
      get push() { return st.outcome === 'applied'; },
      source: 'offline-handover', reopenTerminal: true, leaveHeld: true,
      // A replayed task_complete ends the task's sessions as completeTask does.
      completeSessions: true,
      // Only this row is stamped at the record's time; what its events write stamps now.
      fieldTimes: { at: new Date(ctx.at).toISOString(), fields: fieldIso },
      ...(record.actor?.kind === 'session' ? { actorSid: record.actor.sid } : {}),
    });
  } catch (err) {
    ctx.conflicts.retract(committed);
    throw err;
  }
  if (st.outcome === 'applied') {
    // The board moved: the same notice applyPinPatch gives the focus bar online.
    if (pinChanged) {
      const { bus, EventNames } = await import('../event-bus.js');
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui']);
    }
    // The PATCH route's background refine of a cut session title (best effort, never throws).
    const cut = st.titleCut;
    if (brake && cut && written.includes('title')) void brake.refineShortTitle(taskId, cut.cut, cut.from);
    log.session.info('offline handover: queued fields applied', { host: ctx.hostKey, taskId, seq: record.seq, opId: record.opId, fields: written, conflicts: conflictCount });
  }
  return st.outcome;
}

/**
 * The phase the raw row write will store (task-manager.ts prepareRawUpdate's rule): the
 * patch's phase, else the one its status names when that status moves the task's.
 */
function phaseWritten(cur: Readonly<Task>, stored: Record<string, unknown>): TaskPhase | undefined {
  if (typeof stored.phase === 'string' && stored.phase) return stored.phase as TaskPhase;
  if (typeof stored.status === 'string' && stored.status && stored.status !== deriveStatusFromPhase(cur.phase)) {
    return phaseFromStatus(stored.status as TaskStatus);
  }
  return undefined;
}
