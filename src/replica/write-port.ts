/**
 * The write port of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * sections 5 and 7; WP10): what a route's write becomes while the Mac is away.
 *
 * The replica never writes its copies. A route that the dispatcher marked as an
 * away write (req.replicaWrite, dispatch.ts) hands its write here, and the port
 * turns it into ONE follower command on the link to this host's daemon, which
 * journals it for the Mac:
 *
 *   follower.op {op, args, opId, base, actor}
 *     actor   the paired device that made the write (its stable record id from the
 *             device copy, host-server/device-copy.ts), never a session
 *     opId    the request's x-walnut-op-id, minted by the dispatcher when the client
 *             sent none (the iOS app); a lost answer is asked again under the SAME id
 *             (dispatch.ts run), and the daemon answers a pending id with its first
 *             record, so a retry appends once
 *     base    per field, the value this replica showed when the write was made: the
 *             copy plus the overlay (pending records, overlay.ts), `'unknown'` when the
 *             copy has no such field; the Mac's drain merges by it (section 7)
 *     ids     minted here: a new task's id (timestamp plus 8 random bytes, so two
 *             writers never collide) and a Board post's id (the id this replica and
 *             the daemon show; the Mac's drain posts under an id of its own, and its
 *             applied-ops ledger is what keeps a replayed post from landing twice)
 *   all or nothing: a write naming ANY field outside the queueable set answers
 *     `needs_leader {why:'fields', fields}` and nothing of it is sent
 *   checked as the Mac checks it: the field rules the Mac's drain runs on the patch
 *     (core/offline-merge/patch-check.ts, the twin of the Mac's task routes) run here
 *     first, so a write the Mac would refuse answers 400 now and is never kept
 *   one op id, one change: the daemon answers a retry with its first record; an op
 *     id it holds for another kind of change answers `409 op_id_reused` (the Mac's
 *     op-id middleware answers the same), and a retry is shown and correlated as the
 *     first attempt (a create names the task the first attempt made)
 *
 *   follower.send {sid, text, messageId}     a message to a session that runs here
 *   follower.permission {sid, requestId, ...} an answer to that session's prompt
 *
 * Every answer the port gives is the route's: `{status, body}` (the away routes
 * send it as JSON), or `answered` when the dispatcher already answered the
 * request itself (forwarded to the Mac that came back, or a 503 it chose).
 */

import crypto from 'node:crypto'
import { escapeHintTags, splitHinted } from '../core/hints/hint-format.js'
import { voiceReplyBlock } from '../core/sessions/voice-reply.js'
import type { ReplicaWrite, ReplicaWriteResult } from './dispatch.js'
import { deriveStatusFromPhase, phaseDerivedFields, phaseFromStatus } from '../core/phase.js'
import { PIN_TIER_POLICY, type Task, type TaskPhase, type TaskStatus } from '../core/types.js'
import { RefusedWrite, checkResolvedPatch } from '../core/offline-merge/patch-check.js'

/**
 * The fields a task write may queue (the task-outbox whitelist plus phase, parent,
 * pinned and focus tier), the same list the daemon checks (offline-host-core.ts
 * QUEUEABLE) and the Mac's drain applies (core/offline-merge/task-fields.ts).
 */
export const QUEUEABLE_TASK_FIELDS: readonly string[] = [
  'title', 'status', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'tags',
  'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id',
]
/** A create's placement keys: they place the new task and are no field write of their own. */
export const CREATE_PLACEMENT_KEYS: readonly string[] = ['parent_task_id', 'project', 'group_id', 'focus_tier', 'order', 'id']
/** Inputs a route accepts and drops (an older client's), never a reason to refuse. */
const DROPPED_INPUTS = new Set(['id', 'messageId', 'clientRequestId', 'wait_report'])

/** Who made an away write: the paired device, by its stable id. */
export interface WriteActor { kind: 'device'; deviceId: string; name?: string }

/** What a route answers. */
export type PortAnswer =
  | { answered: false; status: number; body: Record<string, unknown> }
  | { answered: true }

/** A task row as a reader shows it (copy plus overlay). */
export type TaskRow = Record<string, unknown> & { id: string }

/** The Board document a write is checked against (copy plus overlay). */
export interface BoardBase {
  html: string
  version: number
  threads?: Record<string, unknown>
  marks?: Record<string, unknown>
  projects?: Record<string, unknown>
  choices?: Record<string, unknown>
}

export interface WritePortDeps {
  /** The task as this replica shows it now (the copy plus pending records), or null. */
  task(id: string): Promise<TaskRow | null>
  /** The Board of a task as this replica shows it now, or null when it has none. */
  board(taskId: string): Promise<BoardBase | null>
  /** A write the daemon took: the overlay holds it from now on (and asks the daemon again soon). */
  noteWritten(entry: WrittenEntry): void
  randomHex?(bytes: number): string
  now?(): number
  log?(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

/** What the overlay learns at once from a write the daemon took (before its next follower.pending). */
export interface WrittenEntry {
  opId: string
  seq: number
  rev: number
  kind: string
  at: number
  actor: WriteActor
  record: Record<string, unknown>
  /**
   * A create's `client_request_id` (POST /api/tasks): never stored, echoed on the
   * `task:created` event as the Mac does, so the creating page swaps its optimistic row.
   */
  clientRequestId?: string
}

/** A refusal code's HTTP status. `internal` (a failed delivery, a host exception) is transient: 503, never a 409 conflict. */
const STATUS_OF: Readonly<Record<string, number>> = {
  needs_leader: 503, queue_full: 503, journal_unwritable: 503, leader_unsure: 503, internal: 503,
  throttled: 429, not_found: 404, no_board: 404, bad_request: 400, bad_id: 400, message_too_long: 400,
  board_too_large: 413, board_version_conflict: 409, status_set_by_user: 409, not_running: 409, edit_not_found: 409,
  op_id_reused: 409,
}

/** The built-in Focus tiers; a custom tier is checked by the Focus routes (away-writes.ts), which know the board's. */
const BUILTIN_TIERS: readonly string[] = PIN_TIER_POLICY.map((p) => p.tier as string)
/** A wait clock as a duration ("6h", "3d"): the drain turns it into a time (patch-check.ts normalizeQueuedFields). */
const DURATION_RE = /^\d+(?:\.\d+)?\s*(ms|s|m|h|d)$/i

/**
 * The Mac's field rules on a write, before anything is sent (patch-check.ts, which the
 * drain runs on the same patch): null when the Mac would take it, else its sentence.
 * `row` is the task as this replica shows it (the rules that read the row, a wait clock
 * on a task that is not waiting or an end date with no start, read it too). A custom
 * Focus tier and a wait duration are left to the routes and the drain that know them.
 */
export function macRefusalOf(row: Record<string, unknown>, values: Record<string, unknown>): string | null {
  const patch = { ...values }
  if (typeof patch.focus_tier === 'string' && !BUILTIN_TIERS.includes(patch.focus_tier)) delete patch.focus_tier
  if (typeof patch.wait_until === 'string' && DURATION_RE.test(patch.wait_until.trim())) delete patch.wait_until
  try {
    checkResolvedPatch(row as unknown as Task, patch)
    return null
  } catch (err) {
    if (err instanceof RefusedWrite) return err.message
    throw err
  }
}

/** The fields of `values` a task write may not queue (empty: all of them may). */
export function unqueueableFields(values: Record<string, unknown>): string[] {
  return Object.keys(values).filter((k) => !QUEUEABLE_TASK_FIELDS.includes(k))
}

/** A field write's base: what this replica shows for it now, `'unknown'` when the row has no such field. */
export function fieldBases(row: Record<string, unknown> | null, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(values)) {
    const v = row && Object.prototype.hasOwnProperty.call(row, k) ? row[k] : undefined
    out[k] = v === undefined ? 'unknown' : v
  }
  return out
}

/** A new task's id: its time, then 8 random bytes (two writers never collide; today's generateId has 16 random bits). */
export function mintTaskId(now: number, randomHex: (bytes: number) => string): string {
  return `${now.toString(36)}-${randomHex(8)}`
}

/** A Board post's id, minted by the writer: the one shown here until the Mac's copy of the post comes back. */
export function mintPostId(randomHex: (bytes: number) => string): string {
  return `bm-host-${randomHex(8)}`
}

/** A refusal in the route's shape: `needs_leader` the dispatcher's (`{code, why, retryAfter, message}`), the rest `{code, message}`. */
export function refusalAnswer(code: string, message: string, detail?: unknown, retryAfterMs?: number): PortAnswer {
  const d = (detail && typeof detail === 'object' ? detail : {}) as { why?: unknown; fields?: unknown }
  const status = STATUS_OF[code] ?? 409
  const retryAfter = retryAfterMs !== undefined ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : status === 503 ? 5 : undefined
  return {
    answered: false, status,
    body: {
      error: {
        code, message,
        ...(typeof d.why === 'string' ? { why: d.why } : {}),
        ...(Array.isArray(d.fields) ? { fields: d.fields } : {}),
        ...(retryAfter !== undefined ? { retryAfter } : {}),
      },
    },
  }
}

/** The write needs the Mac, nothing of it was sent. */
export function needsLeaderAnswer(why: string, message: string, extra: Record<string, unknown> = {}): PortAnswer {
  return { answered: false, status: 503, body: { error: { code: 'needs_leader', why, retryAfter: 5, message, ...extra } } }
}

function inputs(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (!DROPPED_INPUTS.has(k) && v !== undefined) out[k] = v
  return out
}

export interface WritePort {
  /** An edit (a reopen is a phase): `task_update`. */
  taskUpdate(w: ReplicaWrite, actor: WriteActor, taskId: string, patch: Record<string, unknown>): Promise<PortAnswer>
  /** A complete: `task_complete` (the phase field, base the phase shown). */
  taskComplete(w: ReplicaWrite, actor: WriteActor, taskId: string): Promise<PortAnswer>
  /** A new task under an id minted here: `task_create`. */
  taskCreate(w: ReplicaWrite, actor: WriteActor, input: Record<string, unknown>): Promise<PortAnswer>
  /** A move next to `anchor` (null: the end of its tier): `task_move`. */
  taskMove(w: ReplicaWrite, actor: WriteActor, taskId: string, anchor: { after?: string; before?: string } | null, tier?: string): Promise<PortAnswer>
  /** A Board write (`board_set`, `board_edit`, `board_post`, `board_project_set`), checked against the Board shown here. */
  board(w: ReplicaWrite, actor: WriteActor, op: string, taskId: string, args: Record<string, unknown>): Promise<PortAnswer>
  /** A person's message to a session that runs on this host: `follower.send`. */
  send(w: ReplicaWrite, sid: string, text: string, messageId?: string): Promise<PortAnswer>
  /** A person's answer to that session's prompt: `follower.permission`. */
  permission(w: ReplicaWrite, sid: string, answer: Record<string, unknown>): Promise<PortAnswer>
  /** A paired device revoked while away: `device_revoke` (applied to this replica's device copy by the caller). */
  deviceRevoke(w: ReplicaWrite, actor: WriteActor, deviceId: string, name: string): Promise<PortAnswer>
}

export function createWritePort(deps: WritePortDeps): WritePort {
  const hex = deps.randomHex ?? ((n: number) => crypto.randomBytes(n).toString('hex'))
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})

  /** The daemon's answer as the route's: the overlay learns a write it took at once. */
  function settle(r: ReplicaWriteResult, actor: WriteActor, record: Record<string, unknown>, ok: (reply: Record<string, unknown>) => PortAnswer, clientRequestId?: string): PortAnswer {
    if (r.kind === 'answered') return { answered: true }
    if (r.kind === 'refused') {
      log('info', 'replica: an away write was refused', { code: r.code, op: record.op ?? record.kind, error: r.message })
      return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
    }
    const reply = r.reply
    const seq = typeof reply.seq === 'number' ? reply.seq : 0
    const opId = typeof reply.opId === 'string' ? reply.opId : ''
    const duplicate = reply.duplicate === true
    // The daemon holds this op id for another kind of change (a client that reused it):
    // the Mac's op-id middleware refuses the same, and nothing of this write was kept.
    if (duplicate && typeof reply.kind === 'string' && typeof record.kind === 'string' && reply.kind !== record.kind) {
      log('warn', 'replica: an away write reused the op id of another change', { opId, kind: record.kind, heldKind: reply.kind, deviceId: actor.deviceId })
      return refusalAnswer('op_id_reused', 'This op id was already used for another change; nothing of this one was saved.')
    }
    // A retry's answer names the first attempt's record (a create, the task it made). The
    // overlay is told either way: its first answer may be the one that was lost, so neither
    // the row nor the page's correlation id (task:created) reached anyone yet.
    if (opId && seq > 0 && typeof reply.kind === 'string') {
      const firstTask = typeof reply.taskId === 'string' && reply.taskId ? reply.taskId : undefined
      const noted = reply.kind === 'task-create' && firstTask ? { ...record, taskId: firstTask } : record
      deps.noteWritten({ opId, seq, rev: typeof reply.rev === 'number' ? reply.rev : 1, kind: reply.kind, at: now(), actor, record: { ...noted, kind: reply.kind }, ...(clientRequestId ? { clientRequestId } : {}) })
    }
    log('info', 'replica: an away write was journaled', { opId, seq, kind: reply.kind, duplicate, deviceId: actor.deviceId })
    return ok(reply)
  }

  async function fieldsWrite(w: ReplicaWrite, actor: WriteActor, taskId: string, op: 'task_update' | 'task_complete', values: Record<string, unknown>): Promise<PortAnswer> {
    const row = await deps.task(taskId)
    if (!row) return refusalAnswer('not_found', `Task ${taskId} not found`)
    const refused = macRefusalOf(row, values)
    if (refused) return refusalAnswer('bad_request', refused)
    const base = fieldBases(row, values)
    const args = op === 'task_complete' ? { id: taskId } : { id: taskId, ...values }
    const r = await w.submit(op, args, base, actor)
    const fields: Record<string, { base: unknown; value: unknown }> = {}
    for (const [k, v] of Object.entries(values)) fields[k] = { base: base[k], value: v }
    return settle(r, actor, { kind: 'task-fields', op, taskId, fields }, (reply) => ({
      answered: false, status: 200,
      body: { task: { ...withValues(row, values, new Date(now()).toISOString()), replica_sync: 'pending' }, queued: true, offline: true, opId: reply.opId },
    }))
  }

  return {
    async taskUpdate(w, actor, taskId, patch) {
      const values = inputs(patch)
      if (!Object.keys(values).length) return refusalAnswer('bad_request', 'The write names no field to change.')
      const bad = unqueueableFields(values)
      if (bad.length) {
        return needsLeaderAnswer('fields', `${bad.join(', ')} can only be changed while your Mac answers; nothing of this change was saved.`, { fields: bad })
      }
      return fieldsWrite(w, actor, taskId, 'task_update', values)
    },
    taskComplete(w, actor, taskId) {
      return fieldsWrite(w, actor, taskId, 'task_complete', { phase: 'COMPLETE' })
    },
    async taskCreate(w, actor, input) {
      // The console's correlation id for this create (tasks.ts POST /api/tasks): checked
      // as the Mac checks it, never a field, never stored.
      const crid = input.client_request_id
      if (crid !== undefined && (typeof crid !== 'string' || crid.length > 64)) {
        return refusalAnswer('bad_request', 'client_request_id must be a string of at most 64 characters')
      }
      const rest = { ...input }
      delete rest.client_request_id
      const all = inputs(rest)
      const fields: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(all)) if (!CREATE_PLACEMENT_KEYS.includes(k)) fields[k] = v
      if (typeof fields.title !== 'string' || !fields.title.trim()) return refusalAnswer('bad_request', 'title must be a non-empty string')
      const bad = unqueueableFields(fields)
      if (bad.length) {
        return needsLeaderAnswer('fields', `${bad.join(', ')} can only be set while your Mac answers; the task was not made.`, { fields: bad })
      }
      const at = now()
      const id = mintTaskId(at, hex)
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
      const placement = {
        ...(str(all.parent_task_id) ? { parentTaskId: str(all.parent_task_id) } : {}),
        ...(typeof all.project === 'string' ? { project: all.project } : {}),
        ...(str(all.group_id) ? { groupId: str(all.group_id) } : {}),
        ...(str(all.focus_tier) ? { tier: str(all.focus_tier) } : {}),
      }
      // The new task's fields by the same rules, on the row the Mac's create starts from.
      const refused = macRefusalOf(createdRow(id, {}, placement, at, madeByHuman(actor)), fields)
      if (refused) return refusalAnswer('bad_request', refused)
      const args: Record<string, unknown> = { id, ...fields }
      for (const k of ['parent_task_id', 'project', 'group_id', 'focus_tier', 'order']) if (all[k] !== undefined) args[k] = all[k]
      const r = await w.submit('task_create', args, undefined, actor)
      return settle(r, actor, { kind: 'task-create', taskId: id, fields, placement, ...(all.order !== undefined ? { order: all.order } : {}) }, (reply) => ({
        answered: false, status: 201,
        body: { task: { ...createdRow(typeof reply.taskId === 'string' ? reply.taskId : id, fields, placement, at, madeByHuman(actor)), replica_sync: 'pending' }, queued: true, offline: true, opId: reply.opId },
      }), typeof crid === 'string' && crid ? crid : undefined)
    },
    async taskMove(w, actor, taskId, anchor, tier) {
      const row = await deps.task(taskId)
      if (!row) return refusalAnswer('not_found', `Task ${taskId} not found`)
      const base = tier !== undefined ? { focus_tier: row.focus_tier ?? 'unknown' } : undefined
      const r = await w.submit('task_move', { id: taskId, anchor, ...(tier !== undefined ? { tier } : {}) }, base, actor)
      return settle(r, actor, { kind: 'task-move', taskId, anchor, ...(tier !== undefined ? { tier } : {}) }, (reply) => ({
        answered: false, status: 200, body: { ok: true, queued: true, offline: true, opId: reply.opId },
      }))
    },
    async board(w, actor, op, taskId, args) {
      // The daemon decides whether the Board exists (its copy, or this base when it keeps none).
      const base = await deps.board(taskId)
      const postId = op === 'board_post' ? mintPostId(hex) : undefined
      const full = { ...args, task: taskId, ...(postId ? { postId } : {}) }
      const r = await w.submit(op, full, base ?? undefined, actor)
      const { postId: _p, ...recordArgs } = full
      return settle(r, actor, { kind: 'board', op, args: recordArgs, ...(postId ? { postId } : {}) }, (reply) => ({
        answered: false, status: op === 'board_post' ? 201 : 200,
        body: { queued: true, offline: true, opId: reply.opId, ...(postId ? { message: { id: postId, author: 'user', text: args.text, ts: new Date(now()).toISOString() } } : {}) },
      }))
    },
    async send(w, sid, text, messageId) {
      const typed = text.trim()
      if (!typed) return refusalAnswer('bad_request', 'text must be a non-empty string')
      // The host delivers it as it is, so it is escaped here as the Mac's queue would
      // (core/hints/hint-format.ts); only the voice block a voice send composed stays.
      const body = typed.startsWith('/') || splitHinted(typed, [voiceReplyBlock()]) ? typed : escapeHintTags(typed)
      const r = await w.call('follower.send', { sid, text: body, messageId: sendMessageId(messageId, w.opId) })
      if (r.kind === 'answered') return { answered: true }
      if (r.kind === 'refused') return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
      log('info', 'replica: a message went to a session on this host while the Mac is away', { sessionId: sid, messageId: r.reply.messageId, opId: w.opId })
      return { answered: false, status: 202, body: { delivered: true, messageId: r.reply.messageId ?? sendMessageId(messageId, w.opId), offline: true } }
    },
    async permission(w, sid, answer) {
      const r = await w.call('follower.permission', { sid, ...answer })
      if (r.kind === 'answered') return { answered: true }
      if (r.kind === 'refused') return refusalAnswer(r.code, r.message, r.detail, r.retryAfterMs)
      log('info', 'replica: a prompt of a session on this host was answered while the Mac is away', { sessionId: sid, requestId: answer.requestId, opId: w.opId })
      return { answered: false, status: 200, body: { status: 'resolved', requestId: r.reply.requestId ?? answer.requestId, allow: r.reply.allow, offline: true } }
    },
    async deviceRevoke(w, actor, deviceId, name) {
      const r = await w.submit('device_revoke', { deviceId, name }, undefined, actor)
      return settle(r, actor, { kind: 'device-revoke', deviceId, name }, (reply) => ({
        answered: false, status: 200, body: { ok: true, queued: true, offline: true, opId: reply.opId },
      }))
    },
  }
}

/**
 * The message id of a send (the daemon takes `qm-...` ids and delivers a repeated one
 * once): the client's own when it is one, else one made from the op id, so a lost
 * answer asked again names the same message.
 */
export function sendMessageId(given: string | undefined, opId: string): string {
  if (given && /^qm-[A-Za-z0-9-]{1,64}$/.test(given)) return given
  return `qm-${opId.replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 67)
}

/**
 * A row with an away write's values on it, and what a phase write derives with them
 * (status, completed_at, the read marker: core/phase.ts, the rule the Mac's drain
 * applies), so a task completed here shows as done, with its completion time, as on
 * the Mac (the console keeps a just-completed row in view by that time). A status
 * written without a phase is the phase it names when it moves the task's, as the Mac
 * stores it (task-manager.ts updateTask, offline-merge/apply-fields.ts phaseWritten);
 * a status the phase already shows changes nothing.
 */
export function withValues(row: Record<string, unknown>, values: Record<string, unknown>, atIso: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row, ...values }
  let phase = values.phase
  if ((typeof phase !== 'string' || !phase) && typeof values.status === 'string' && values.status) {
    const shown = typeof row.phase === 'string' && row.phase ? deriveStatusFromPhase(row.phase as TaskPhase) : row.status
    if (values.status === shown) { out.status = shown; return out }
    phase = phaseFromStatus(values.status as TaskStatus)
  }
  if (typeof phase !== 'string' || !phase) return out
  out.phase = phase
  out.status = deriveStatusFromPhase(phase as TaskPhase)
  const derived = phaseDerivedFields(out as Partial<Task>, phase as TaskPhase, atIso)
  Object.assign(out, derived.set)
  for (const f of derived.clear) delete out[f]
  return out
}

/**
 * A task made here as readers show it until the Mac's row comes back in a copy. `human`:
 * a device or a trigger made it, so the Mac's create rules give it the human default
 * (pinned, on the board in Satellite, unless it said otherwise: task-manager.ts
 * newTaskPinDefault, offline-merge/apply-v2.ts createTask); a tier always means pinned.
 */
export function createdRow(id: string, fields: Record<string, unknown>, placement: { parentTaskId?: string; project?: string; groupId?: string; tier?: string }, at: number, human = false): TaskRow {
  const iso = new Date(at).toISOString()
  const pinned = placement.tier ? true : typeof fields.pinned === 'boolean' ? fields.pinned : human ? true : undefined
  return {
    id, phase: 'TODO', status: 'todo', priority: 'none', project: placement.project ?? '', created_at: iso, updated_at: iso,
    ...(placement.groupId ? { group_id: placement.groupId } : {}),
    ...(placement.parentTaskId ? { parent_task_id: placement.parentTaskId } : {}),
    ...(placement.tier ? { focus_tier: placement.tier } : {}),
    ...fields,
    ...(pinned !== undefined ? { pinned } : {}),
  }
}

/** Whether a journal record's maker gets the human create defaults (a device or a trigger, not a session). */
export function madeByHuman(actor: unknown): boolean {
  return !(actor && typeof actor === 'object' && (actor as { kind?: unknown }).kind === 'session')
}
