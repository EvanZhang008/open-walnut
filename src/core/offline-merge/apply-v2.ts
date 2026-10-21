/**
 * Applying the journal v2 kinds on the Mac (docs/plan/walnut-replica-servers-impl.md
 * sections 5 and 7): task-fields, task-create, task-move, board. offline-handover.ts
 * owns the batch (order, ledger, failure policy, ack); this file owns one record.
 *
 * Every kind but a Board post is idempotent on its own, so a crash between an apply and
 * its ledger row is harmless:
 *   task-fields  a field whose Mac value already equals the record's value is a no-op, and
 *                the record's op key rides in the same row write (task.applied_ops)
 *   task-create  the task stores created_by_op; the same id with the same op only lands
 *                the fields a crash kept from landing; a re-minted id is in the ledger
 *   task-move    an anchor placement already in place is a no-op; the last move wins
 *   board        replayed through the op, whose own version checks decide; a board_post
 *                has none, so a crash between its apply and its ledger row posts it once
 *                more (rare; nothing is lost)
 *
 * A refusal the Mac makes (the answer the same call online gets) throws RefusedWrite:
 * the batch acks it into the conflict log. Anything else thrown is retried.
 */

import { log } from '../../logging/index.js';
import { WALNUT_HOME } from '../../constants.js';
import type { ConflictEntry, ConflictLog } from './conflict-log.js';
import { unqueueableFields, type FieldWrite } from './task-fields.js';
import { RefusedWrite } from './patch-check.js';
import { frozenFieldTimes } from '../task-field-times.js';
import { recordRemap } from './ledger.js';
import { applyFields, entryBase, exactTask, opKeyOf, pairValidator, resolveTaskId } from './apply-fields.js';

export { RefusedWrite };

/**
 * The v2 kinds this Mac applies (`offline.drain {kinds}`); `note` since WP11 (offline-merge/notes.ts);
 * `session-meta` and `inbox-state` only the cloud companion writes (apply-session-meta.ts,
 * apply-inbox-state.ts).
 */
export const APPLIED_V2_KINDS = ['task-fields', 'task-create', 'task-move', 'board', 'device-revoke', 'note', 'session', 'session-meta', 'inbox-state'] as const;
/** What `leader.configure {drains}` names: the kinds, plus device actors this Mac checks. */
export const MAC_DRAINS = [...APPLIED_V2_KINDS, 'device-actor'];

export type JournalActorLike = { kind: 'session'; sid: string } | { kind: 'device'; deviceId: string; name?: string } | { kind: 'trigger'; id: string };

export interface V2Record {
  seq: number;
  at: number;
  kind: string;
  opId?: string;
  rev?: number;
  actor?: JournalActorLike;
  [k: string]: unknown;
}

export interface V2Context {
  hostKey: string;
  /** The record's time on this server's clock (host time plus the measured offset). */
  at: number;
  /** Host clock offset (ms to add to a host time), for a folded field's own time. */
  offset: number;
  conflicts: ConflictLog;
  /** This batch's cache of re-minted create ids (old id -> the id minted here); the ledger keeps them. */
  remap: Map<string, string>;
  result: { replayed: number; skipped: number };
  /** The host's link, for a note record's bodies (`offline.blob`). */
  conn?: { send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> };
}

export { resolveTaskId };

/** The task a record is about (after a re-mint), for "give up later records of that task". */
export function v2TaskIdOf(record: V2Record, remap?: Map<string, string>, hostKey?: string): string | undefined {
  const id = record.kind === 'board'
    ? (typeof (record.args as Record<string, unknown> | undefined)?.task === 'string' ? String((record.args as Record<string, unknown>).task) : undefined)
    : typeof record.taskId === 'string' ? record.taskId : undefined;
  if (!id) return undefined;
  return hostKey !== undefined ? resolveTaskId(hostKey, id, remap) : remap?.get(id) ?? id;
}

/**
 * A session's away write takes exactly what its op takes online (executor.ts parses the
 * op's input strictly, after dropping its retired fields): task_update its own fields,
 * task_complete the phase alone, task_create its own fields. Anything else (status,
 * summary, note, unread, pin_order, depends_on, ...) refuses the whole record, the answer
 * the same call online gets, and the session is told. A device or a trigger writes the
 * whole queueable set, as the routes it stands for do.
 */
export async function sessionWriteFields<T>(record: V2Record, fields: Record<string, T>): Promise<Record<string, T>> {
  if (record.actor?.kind !== 'session') return fields;
  const name = record.kind === 'task-create' ? 'task_create' : record.op === 'task_complete' ? 'task_complete' : 'task_update';
  const { getOp } = await import('../../ops/index.js');
  const op = getOp(name);
  const allowed = name === 'task_complete' ? new Set(['phase']) : new Set(Object.keys(op?.input ?? {}).filter((k) => k !== 'id'));
  const retired = new Set(op?.retiredInput ?? []);
  const out: Record<string, T> = {};
  const bad: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (retired.has(k)) continue;
    if (allowed.has(k)) out[k] = v; else bad.push(k);
  }
  if (bad.length) throw new RefusedWrite(`${name} does not take ${bad.join(', ')}; nothing of this write was applied`);
  return out;
}

async function applyTaskFields(ctx: V2Context, record: V2Record): Promise<void> {
  const raw = (record.fields ?? {}) as Record<string, FieldWrite>;
  const taskId = v2TaskIdOf(record, ctx.remap, ctx.hostKey) ?? '';
  const bad = unqueueableFields(raw);
  // All or nothing (section 7): the daemon refuses such a write, so this is a record from elsewhere.
  if (bad.length) throw new RefusedWrite(`${bad.join(', ')} can only be changed while the Mac answers; nothing of this write was applied`);
  const fields = await sessionWriteFields(record, raw);
  const outcome = await applyFields(ctx, record, taskId, fields, opKeyOf(ctx, record));
  if (outcome === 'gone') {
    // Delete wins: listed when the write carried a value.
    const entries = Object.entries(fields).filter(([, w]) => w && w.value !== undefined)
      .map(([field, w]) => ({ ...entryBase(record), kind: 'task-deleted' as const, taskId, field, base: w.base, replica: w.value, replicaAt: ctx.at }));
    ctx.conflicts.addDurable(entries);
    log.session.info('offline handover: queued fields dropped, the task was deleted', { host: ctx.hostKey, taskId, seq: record.seq, opId: record.opId });
  }
  if (outcome === 'applied') ctx.result.replayed++; else ctx.result.skipped++;
}

/** A new id for a create whose id was taken: the writer's shape (time, then 8 random bytes). */
async function remintId(): Promise<string> {
  const crypto = await import('node:crypto');
  return `${Date.now().toString(36)}${crypto.randomBytes(8).toString('hex')}`;
}

/** The value a field has on a task addTask just made (the base of the fields set after it). */
function bornValue(field: string): unknown {
  return field === 'phase' ? 'TODO' : field === 'status' ? 'todo' : '';
}

/** The fields addTask takes itself; the rest land through applyFields after the row exists. */
const CREATE_FIELDS = new Set(['title', 'description', 'priority', 'due_date', 'start_date', 'end_date', 'tags', 'sprint', 'project', 'group_id', 'parent_task_id', 'focus_tier', 'pinned']);

async function applyTaskCreate(ctx: V2Context, record: V2Record): Promise<void> {
  const minted = String(record.taskId ?? '');
  const fields = (record.fields ?? {}) as Record<string, unknown>;
  const placement = (record.placement ?? {}) as { parentTaskId?: string; project?: string; groupId?: string; tier?: string };
  const bad = unqueueableFields(fields);
  if (bad.length) throw new RefusedWrite(`${bad.join(', ')} can only be set while the Mac answers; the task was not created`);
  if (!minted) throw new RefusedWrite('task-create without the id the writer minted');
  await sessionWriteFields(record, fields);
  // A re-mint an earlier drain made (this batch or one before a stop or a restart) is durable.
  let id = resolveTaskId(ctx.hostKey, minted, ctx.remap);
  let existing = await exactTask(id);
  if (existing && !(record.opId && existing.created_by_op === record.opId)) {
    // A collision: another task holds the id. The new id is in the ledger and the entry on
    // disk BEFORE the task exists, so a retry after any failure finds this same id.
    const fresh = await remintId();
    const entry = { ...entryBase(record), kind: 'create-collision' as const, taskId: fresh, reason: `the id ${minted} was taken here; the task is ${fresh}` };
    ctx.conflicts.addDurable([entry]);
    try {
      recordRemap(ctx.hostKey, WALNUT_HOME, minted, fresh);
    } catch (err) {
      ctx.conflicts.retract([entry]);
      throw err;
    }
    ctx.remap.set(minted, fresh);
    id = fresh;
    existing = null;
  }
  if (!existing) await createTask(ctx, record, id, fields, placement);
  // The fields addTask does not take (note, summary, phase, unread, ...), merged like a
  // task-fields write over the born row and idempotent by the op key: a replay after this
  // write failed (or a crash before it) still lands them, once.
  const rest: Record<string, FieldWrite> = {};
  for (const [k, v] of Object.entries(fields)) if (!CREATE_FIELDS.has(k) && v !== undefined) rest[k] = { base: bornValue(k), value: v };
  const restOutcome = Object.keys(rest).length ? await applyFields(ctx, record, id, rest, opKeyOf(ctx, record)) : 'skipped';
  if (!existing || restOutcome === 'applied') ctx.result.replayed++; else ctx.result.skipped++;
  if (!existing) log.session.info('offline handover: task created while away is here', { host: ctx.hostKey, taskId: id, mintedId: minted, seq: record.seq, opId: record.opId });
}

/**
 * addTask with the id (minted or re-minted), placement and the create rules re-run with
 * the actor's rules (create-rules.ts, the same helper the online create route calls): a
 * device or a trigger gets the human defaults (pinned by default), a session the caller
 * rule (its depth cap, an ask's project, the caller's tier, the title brake, the folder
 * beside the caller).
 */
async function createTask(
  ctx: V2Context, record: V2Record, id: string, fields: Record<string, unknown>,
  placement: { parentTaskId?: string; project?: string; groupId?: string; tier?: string },
): Promise<void> {
  const { resolveCallerPlacement, decidePlacement } = await import('../sessions/caller-placement.js');
  const { applyCreateRules, placeBesideCaller, ProjectElsewhereError } = await import('../sessions/create-rules.js');
  const req = {
    ...(typeof placement.project === 'string' ? { project: placement.project } : {}),
    ...(placement.groupId ? { group_id: placement.groupId } : {}),
  };
  const caller = record.actor?.kind === 'session'
    ? await resolveCallerPlacement(record.actor.sid).catch(() => ({ kind: 'unknown' as const }))
    : { kind: 'human' as const };
  const decision = decidePlacement(req, caller);
  // A parent the record names wins over the caller's own task.
  if (placement.parentTaskId) decision.parentTaskId = resolveTaskId(ctx.hostKey, placement.parentTaskId, ctx.remap);
  // On disk before the task exists (its created_by_op makes a redrain skip the create),
  // and taken back when addTask fails: each retry would list it again.
  let parentEntry: ConflictEntry | undefined;
  if (decision.parentTaskId && !(await exactTask(decision.parentTaskId))) {
    parentEntry = { ...entryBase(record), kind: 'parent-refused', taskId: id, field: 'parent_task_id', replica: decision.parentTaskId, reason: `the parent task ${decision.parentTaskId} no longer exists; the task is top level` };
    ctx.conflicts.addDurable([parentEntry]);
    delete decision.parentTaskId;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  let rules: Awaited<ReturnType<typeof applyCreateRules>>;
  try {
    // A create queued away never carries project_reason (the host does not queue it), so a
    // worker's create naming another project is refused here as online without a reason.
    rules = await applyCreateRules({
      title: String(fields.title ?? 'Untitled'), description: str(fields.description), pinned: fields.pinned, focus_tier: placement.tier,
      ...(typeof placement.project === 'string' ? { project: placement.project } : {}),
    }, caller, decision);
  } catch (err) {
    if (parentEntry) ctx.conflicts.retract([parentEntry]);
    if (err instanceof ProjectElsewhereError) {
      throw new RefusedWrite(`${err.message} A task created while the Walnut server was away cannot carry project_reason, so it was not created; create it again now.`);
    }
    const { SubtaskLimitError } = await import('../sessions/subtask-limits.js');
    if (err instanceof SubtaskLimitError) throw new RefusedWrite(err.message);
    throw err;
  }
  let groupId = decision.group_id;
  if (groupId && !(await pairValidator())(decision.project ?? '', groupId)) groupId = undefined;
  const { addTask, InvalidFocusTierError } = await import('../task-manager.js');
  // The born row has no field times to stamp (a new row is not a change of one); the
  // fields merged over it below are stamped at the record's time by applyFields.
  const input = {
    title: rules.title,
    ...(str(rules.description) ? { description: String(rules.description) } : {}),
    ...(str(fields.priority) ? { priority: fields.priority as never } : {}),
    ...(decision.project !== undefined ? { project: decision.project } : {}),
    ...(groupId ? { group_id: groupId } : {}),
    ...(decision.parentTaskId ? { parent_task_id: decision.parentTaskId } : {}),
    ...(str(fields.due_date) ? { due_date: String(fields.due_date) } : {}),
    ...(str(fields.start_date) ? { start_date: String(fields.start_date) } : {}),
    ...(str(fields.end_date) ? { end_date: String(fields.end_date) } : {}),
    ...(Array.isArray(fields.tags) ? { tags: fields.tags.map(String) } : {}),
    ...(str(fields.sprint) ? { sprint: String(fields.sprint) } : {}),
    explicitId: id,
    ...(record.opId ? { createdByOp: record.opId } : {}),
  };
  let created: Awaited<ReturnType<typeof addTask>>['task'];
  try {
    try {
      created = (await addTask({ ...input, ...rules.tier })).task;
    } catch (err) {
      // An INHERITED custom tier deleted since: Satellite instead, as the route does.
      if (!(rules.tierInherited && rules.tier.focus_tier && err instanceof InvalidFocusTierError)) throw err;
      created = (await addTask({ ...input, pinned: true })).task;
    }
  } catch (err) {
    if (parentEntry) ctx.conflicts.retract([parentEntry]);
    const { TaskIdTakenError } = await import('../task-manager.js');
    if (err instanceof TaskIdTakenError) throw err;
    // addTask's own validation (unknown tier, a folder of another project): the Mac's answer.
    throw new RefusedWrite(err instanceof Error ? err.message : String(err));
  }
  // Best-effort, as online: a failure leaves the task standalone in its project.
  await placeBesideCaller(decision, caller, created, 'offline-handover');
  // A cut session title is refined in the background as the online create does (only
  // while the task still wears the cut; never throws, never holds the drain).
  if (rules.titleShortenedFrom) {
    const { refineShortTitle } = await import('../sessions/task-title-brake.js');
    void refineShortTitle(created.id, rules.title, rules.titleShortenedFrom, str(fields.description));
  }
}

/** Anchor placement in the pinned order; a missing anchor appends at the end. Never in the letter. */
async function applyTaskMove(ctx: V2Context, record: V2Record): Promise<void> {
  const id = v2TaskIdOf(record, ctx.remap, ctx.hostKey) ?? '';
  const task = await exactTask(id);
  if (!task) { ctx.result.skipped++; return; }
  const tm = await import('../task-manager.js');
  let moved = false;
  // A move's writes stamp updated_at on the drain's clock: freeze the moved row's field-time
  // fallback first (task-field-times.ts frozenFieldTimes), as a drained field write does.
  const freeze = () => tm.updateTaskRaw(id, (cur) => {
    const frozen = frozenFieldTimes(cur);
    return frozen ? { field_at: frozen } : null;
  });
  const tier = typeof record.tier === 'string' ? record.tier : undefined;
  if (tier && (task.focus_tier ?? '') !== tier) {
    try { await freeze(); await tm.setFocusTier(id, tier); moved = true; } catch (err) {
      log.session.info('offline handover: a queued move to a tier was not applied', { host: ctx.hostKey, taskId: id, tier, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const anchor = (record.anchor ?? null) as { after?: string; before?: string } | null;
  const fresh = await exactTask(id);
  if (anchor && fresh?.pinned) {
    const pinned = (await tm.listTasks({})).filter((t) => t.pinned).sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0)).map((t) => t.id);
    const order = pinned.filter((x) => x !== id);
    const ref = anchor.after ?? anchor.before;
    const refId = ref ? resolveTaskId(ctx.hostKey, ref, ctx.remap) : undefined;
    const at = refId ? order.indexOf(refId) : -1;
    if (at === -1) order.push(id); else order.splice(anchor.after ? at + 1 : at, 0, id);
    if (order.join(',') !== pinned.join(',')) { await freeze(); await tm.reorderPins(order); moved = true; }
  }
  if (moved) ctx.result.replayed++; else ctx.result.skipped++;
}

/** The op caller a record's actor replays as: a device with paired-device rights, a session as today. */
async function actorOptions(hostKey: string, actor: JournalActorLike | undefined): Promise<{ callerSid?: string; callerHost?: string; origin: string }> {
  const { hostOrigin, REMOTE_HTTP_ORIGIN } = await import('../../lib/caller-origin.js');
  if (actor?.kind === 'device') return { origin: REMOTE_HTTP_ORIGIN };
  if (actor?.kind === 'session') return { callerSid: actor.sid, callerHost: hostKey, origin: hostOrigin(hostKey) };
  return { callerHost: hostKey, origin: hostOrigin(hostKey) };
}

/** A Board write made away: replayed through the op, whose version checks decide. */
async function applyBoard(ctx: V2Context, record: V2Record): Promise<void> {
  const op = String(record.op ?? '');
  if (!op.startsWith('board_')) throw new RefusedWrite(`not a Board op: ${op || '(none)'}`);
  const { executeOp } = await import('../../ops/index.js');
  // The board's task by the id the Mac holds: an away create re-minted here, or answered
  // under the Mac's own id, is named by the id the host minted (as task-fields records are).
  const args = { ...((record.args ?? {}) as Record<string, unknown>) };
  if (typeof args.task === 'string' && args.task) args.task = resolveTaskId(ctx.hostKey, args.task, ctx.remap);
  const r = await executeOp(op, args, await actorOptions(ctx.hostKey, record.actor));
  if (!r.ok) throw r.unreachable ? new Error(r.message) : new RefusedWrite(r.message);
  ctx.result.replayed++;
  log.session.info('offline handover: board write applied', { host: ctx.hostKey, op, boardTaskId: args.task, seq: record.seq, opId: record.opId });
}

/**
 * A paired device that removed itself while the Mac was away (WP10): the same revoke the
 * device's own sign-out makes online (its push tokens and its copies go with it). Always
 * safe on drain: a device already gone is a no-op, and only the device itself may name
 * itself (a record for another device is refused, the answer the same call online gets).
 */
async function applyDeviceRevoke(ctx: V2Context, record: V2Record): Promise<void> {
  const deviceId = String(record.deviceId ?? '');
  if (!deviceId) throw new RefusedWrite('device-revoke without a device id');
  if (record.actor?.kind !== 'device' || record.actor.deviceId !== deviceId) {
    throw new RefusedWrite('a device may only remove itself while your Mac is away');
  }
  const { readRegistry } = await import('../device-store.js');
  const row = (await readRegistry()).devices.find((d) => d.id === deviceId);
  if (!row) {
    ctx.result.skipped++;
    log.session.info('offline handover: a device removed while away was already gone', { host: ctx.hostKey, deviceId, seq: record.seq, opId: record.opId });
    return;
  }
  const { revokePairingAs } = await import('../device-auth.js');
  const { LOCAL_ACTOR } = await import('../device-actor.js');
  // The device's own word (checked above), replayed by this Mac on its behalf.
  await revokePairingAs(row.name, { by: LOCAL_ACTOR });
  ctx.result.replayed++;
  log.session.info('offline handover: a device removed itself while away, revoked here', { host: ctx.hostKey, deviceId, name: row.name, seq: record.seq, opId: record.opId });
}

/** Apply one v2 record. Throws RefusedWrite for the Mac's refusals, anything else for a retry. */
export async function applyV2(ctx: V2Context, record: V2Record): Promise<void> {
  switch (record.kind) {
    case 'task-fields': return applyTaskFields(ctx, record);
    case 'task-create': return applyTaskCreate(ctx, record);
    case 'task-move': return applyTaskMove(ctx, record);
    case 'board': return applyBoard(ctx, record);
    case 'device-revoke': return applyDeviceRevoke(ctx, record);
    case 'note': return applyNote(ctx, record);
    // A new ask the host started while this Mac was away (WP12).
    case 'session': return (await import('./apply-session.js')).applySession(ctx, record);
    // A session metadata patch the cloud companion took while away (stage 3b).
    case 'session-meta': return (await import('./apply-session-meta.js')).applySessionMeta(ctx, record);
    // An inbox flag the human set on the cloud companion while away (stage 3c).
    case 'inbox-state': return (await import('./apply-inbox-state.js')).applyInboxState(ctx, record);
    default: throw new Error(`unknown journal kind ${record.kind}`);
  }
}

/** A note written while away (section 6): merged by offline-merge/notes.ts, its conflicts lettered. */
async function applyNote(ctx: V2Context, record: V2Record): Promise<void> {
  if (!ctx.conn) throw new Error('a note record needs its host link for the bodies');
  const notes = await import('./notes.js');
  const deps = await notes.macNoteDeps(ctx.hostKey, ctx.conn);
  const out = await notes.applyNoteRecord(deps, { conflicts: (entries) => ctx.conflicts.addDurable(entries) }, record as unknown as import('./notes.js').NoteRecordLike, ctx.at);
  log.session.info('offline handover: note record applied', { host: ctx.hostKey, seq: record.seq, opId: record.opId, path: out.path, action: out.action, copies: out.copies, conflicts: out.entries.length });
  if (out.action === 'noop') ctx.result.skipped++; else ctx.result.replayed++;
}

/** Is the device that made a record still paired with this Mac? */
export async function devicePaired(deviceId: string): Promise<boolean> {
  const { readRegistry } = await import('../device-store.js');
  const reg = await readRegistry();
  return reg.devices.some((d) => d.id === deviceId && d.kind !== 'machine');
}
